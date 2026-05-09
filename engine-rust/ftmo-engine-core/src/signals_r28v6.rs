//! R28_V6-style detect_asset subset — composition of:
//!   - SMA(fast)/SMA(slow) trend direction
//!   - Pullback-recovery trigger (low ≤ SMA-fast AND close > SMA-fast for long)
//!   - HTF trend confluence (EMA-9/21 on supplied higher-tf closes)
//!   - RSI confluence (long ≤ long_max, short ≥ short_min)
//!   - ADX minimum (block when sub-threshold = ranging)
//!   - Choppiness max (block when above = sideways)
//!   - News-blackout windows
//!   - Cross-asset filter (e.g. only long alts when BTC trending up)
//!   - ATR-stop widening
//!   - VolAdaptive TP multiplier
//!   - Live-cap respect (unless bypass_live_caps)
//!
//! NOT a 1:1 port of TS `detectAsset` (9.5kLOC) — but combines all primitive
//! filters that the V5_QUARTZ_LITE_R28_V6 config relies on, so a real-asset
//! end-to-end backtest produces structurally equivalent entries.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::detector_filters::{
    adx, choppiness_index, cross_asset_filter_allows, htf_trend_allows, rsi_filter_allows,
};
use crate::indicators::{atr, rsi, sma};
use crate::news::NewsEvent;
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::resolve_sizing_factor;
use crate::state::EngineState;

/// R29-R7: gate entry on perp funding-rate crowdedness.
///
/// Returns `true` if the entry is allowed (filter inactive or rate within
/// thresholds), `false` if the entry must be skipped.
///
/// Mirrors the TS gate in `src/utils/ftmoDaytrade24h.ts:4219-4238`:
///   - Active if `cfg.funding_rate_filter` is Some, OR `asset.max_funding_for_long`
///     is Some, OR `asset.min_funding_for_short` is Some.
///   - Per-asset overrides shadow cfg.
///   - For `long` direction: skip iff `f > maxFL` (some maxFL set AND f > it).
///   - For `short` direction: skip iff `f < minFS`.
///   - If funding_series is missing, or the bar's value is None, or no
///     threshold applies in this direction → gate inactive (allow).
pub fn funding_filter_allows(
    cfg: &EngineConfig,
    asset: &AssetConfig,
    direction: PositionSide,
    funding_series: Option<&[Option<f64>]>,
    bar_index: usize,
) -> bool {
    let cfg_filter = cfg.funding_rate_filter.as_ref();
    // Fast path: no filter active anywhere — allow everything.
    if cfg_filter.is_none()
        && asset.max_funding_for_long.is_none()
        && asset.min_funding_for_short.is_none()
    {
        return true;
    }
    // Need a funding series to evaluate the gate.
    let series = match funding_series {
        Some(s) => s,
        None => return true,
    };
    // Bar value must exist (forward-fill may not have caught up).
    let f = match series.get(bar_index).and_then(|v| *v) {
        Some(v) => v,
        None => return true,
    };
    // Per-asset overrides shadow cfg-level thresholds.
    let max_fl = asset
        .max_funding_for_long
        .or_else(|| cfg_filter.and_then(|f| f.max_funding_for_long));
    let min_fs = asset
        .min_funding_for_short
        .or_else(|| cfg_filter.and_then(|f| f.min_funding_for_short));
    match direction {
        PositionSide::Long => {
            if let Some(max) = max_fl {
                if f > max {
                    return false;
                }
            }
        }
        PositionSide::Short => {
            if let Some(min) = min_fs {
                if f < min {
                    return false;
                }
            }
        }
    }
    true
}

pub struct R28V6Params {
    pub fast_period: usize,
    pub slow_period: usize,
    pub stop_pct: f64,
    pub tp_pct: f64,
    pub base_risk_frac: f64,

    /// Optional ADX(period) threshold — entries blocked if ADX < min.
    pub adx_period: Option<usize>,
    pub adx_min: Option<f64>,

    /// Optional choppiness(period) threshold — entries blocked if CI > max.
    pub choppiness_period: Option<usize>,
    pub choppiness_max: Option<f64>,

    /// Optional RSI gate — long requires `rsi ≤ long_max`, short `rsi ≥ short_min`.
    pub rsi_period: Option<usize>,
    pub rsi_long_max: Option<f64>,
    pub rsi_short_min: Option<f64>,

    /// Optional HTF EMA-fast/slow trend confirmation.
    pub htf_fast: usize,
    pub htf_slow: usize,
}

impl R28V6Params {
    pub fn default_for(asset: &AssetConfig, cfg: &EngineConfig) -> Self {
        Self {
            fast_period: 20,
            slow_period: 50,
            stop_pct: asset.stop_pct.unwrap_or(cfg.stop_pct),
            tp_pct: asset.tp_pct.unwrap_or(cfg.tp_pct),
            base_risk_frac: asset.risk_frac,
            adx_period: Some(14),
            adx_min: Some(20.0),
            choppiness_period: Some(14),
            choppiness_max: Some(61.8), // golden-ratio cutoff often used
            rsi_period: Some(14),
            rsi_long_max: Some(70.0),
            rsi_short_min: Some(30.0),
            htf_fast: 9,
            htf_slow: 21,
        }
    }
}

/// Optional inputs the R28_V6 detector consults beyond the primary candles.
pub struct R28V6Inputs<'a> {
    /// Higher-timeframe closes (e.g. 4h closes when primary is 30m).
    pub htf_closes: Option<&'a [f64]>,
    /// Cross-asset closes for `cfg.cross_asset_filter`.
    pub cross_asset_closes: Option<&'a [f64]>,
    /// Active news-blackout list.
    pub news_events: Option<&'a [NewsEvent]>,
    /// R29-R7: per-bar funding-rate series (forward-filled from 8h funding
    /// events to candle openTimes). `None` element = no funding data yet for
    /// that bar (skip the gate, don't reject the entry). Length must match
    /// `candles.len()`.
    pub funding_series: Option<&'a [Option<f64>]>,
}

pub fn detect_r28_v6(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &R28V6Params,
    inputs: &R28V6Inputs<'_>,
) -> Option<PollSignal> {
    if candles.len() < params.slow_period + 4 {
        return None;
    }
    let i = candles.len() - 1;
    let last = candles[i];
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();

    // 1. Trend direction from slow SMA slope.
    let sma_slow = sma(&closes, params.slow_period);
    let cur_slow = sma_slow[i]?;
    let prev_slow = sma_slow[i - 1]?;
    let mut direction = if cur_slow > prev_slow {
        PositionSide::Long
    } else if cur_slow < prev_slow {
        PositionSide::Short
    } else {
        return None;
    };
    if asset.invert_direction {
        direction = direction.opposite();
    }

    // 2. Entry trigger.
    //
    // The TS reference (`ftmoDaytrade24h.ts:4067-4082`) treats
    // N-consecutive close-comparison as the **default** entry rule and
    // falls through to it after the alternative entry families
    // (Donchian / BB-KC / MA-cross / CVD / VolImbalance / VolPOC / …)
    // opt out. Here we mirror that ordering: when `triggerBars > 0`
    // (resolved via per-asset override → cfg fallback), require N
    // consecutive bars of the appropriate colour; otherwise fall back to
    // the SMA-fast pullback-recovery trigger that shipped earlier with
    // the Rust port.
    //
    // Comparison logic (mirrors TS):
    //   long  + invert=false → close[i-k] < close[i-k-1] for ALL k (N reds)
    //   long  + invert=true  → close[i-k] > close[i-k-1] for ALL k (N greens)
    //   short + invert=false → close[i-k] > close[i-k-1] for ALL k (N greens)
    //   short + invert=true  → close[i-k] < close[i-k-1] for ALL k (N reds)
    //
    // The TS branch sets `ok=false` on the *opposite-colour* comparison,
    // so `ok` stays true only if EVERY one of the N bars matches the
    // correct colour — which is exactly what `all_match` captures below.
    let trigger_bars = asset.trigger_bars.unwrap_or(cfg.trigger_bars);
    let triggered = if trigger_bars > 0 {
        let n = trigger_bars as usize;
        if i < n {
            return None;
        }
        let invert = asset.invert_direction;
        let mut all_match = true;
        for k in 0..n {
            let cur = candles[i - k].close;
            let prev = candles[i - k - 1].close;
            let bar_ok = match (direction, invert) {
                (PositionSide::Long, false) => cur < prev, // N reds → MR long
                (PositionSide::Long, true) => cur > prev,  // N greens → momentum long
                (PositionSide::Short, false) => cur > prev, // N greens → MR short
                (PositionSide::Short, true) => cur < prev, // N reds → momentum short
            };
            if !bar_ok {
                all_match = false;
                break;
            }
        }
        all_match
    } else {
        // Fallback: SMA-fast pullback-recovery (legacy Rust default).
        let sma_fast = sma(&closes, params.fast_period);
        let cur_fast = sma_fast[i]?;
        match direction {
            PositionSide::Long => last.low <= cur_fast && last.close > cur_fast,
            PositionSide::Short => last.high >= cur_fast && last.close < cur_fast,
        }
    };
    if !triggered {
        return None;
    }

    // 3. RSI gate.
    if let Some(period) = params.rsi_period {
        let series = rsi(&closes, period);
        if !rsi_filter_allows(series[i], direction, params.rsi_long_max, params.rsi_short_min) {
            return None;
        }
    }

    // 4. ADX gate (require trend strength).
    if let (Some(p), Some(min)) = (params.adx_period, params.adx_min) {
        let series = adx(candles, p);
        if let Some(v) = series[i] {
            if v < min {
                return None;
            }
        } else {
            return None;
        }
    }

    // 5. Choppiness gate.
    if let (Some(p), Some(max)) = (params.choppiness_period, params.choppiness_max) {
        let series = choppiness_index(candles, p);
        if let Some(v) = series[i] {
            if v > max {
                return None;
            }
        }
    }

    // 6. HTF trend confluence.
    if let Some(htf_closes) = inputs.htf_closes {
        if !htf_trend_allows(htf_closes, params.htf_fast, params.htf_slow, direction) {
            return None;
        }
    }

    // 7. Cross-asset filter.
    if let (Some(filter), Some(cross_closes)) =
        (cfg.cross_asset_filter.as_ref(), inputs.cross_asset_closes)
    {
        if !cross_asset_filter_allows(filter, direction, cross_closes) {
            return None;
        }
    }

    // 8. News-blackout.
    if let Some(events) = inputs.news_events {
        if crate::news::in_blackout(last.open_time, events).is_some() {
            return None;
        }
    }

    // 8b. R29-R7: Funding-rate filter (perp futures crowdedness).
    // Mirrors `ftmoDaytrade24h.ts` lines 4219-4238. We consult the gate only
    // if EITHER `cfg.funding_rate_filter` OR a per-asset override is set —
    // otherwise the gate is dormant. Per-asset overrides shadow cfg.
    if !funding_filter_allows(cfg, asset, direction, inputs.funding_series, candles.len() - 1) {
        return None;
    }

    // 9. Stop-pct via optional ATR-stop.
    let mut stop_pct = params.stop_pct;
    if let Some(at) = cfg.atr_stop {
        let series = atr(candles, at.period as usize);
        if let Some(a) = series[i] {
            let atr_stop = (at.stop_mult * a) / last.close.max(1e-9);
            stop_pct = stop_pct.max(atr_stop);
        }
    }
    // 10. R60 vol-adaptive TP.
    let mut tp_pct = params.tp_pct;
    if let Some(va) = cfg.vol_adaptive_tp_mult {
        let series = atr(candles, va.atr_period as usize);
        if let Some(a) = series[i] {
            let atr_pct = a / last.close.max(1e-9);
            if atr_pct >= va.atr_pct_above {
                tp_pct *= va.factor;
            }
        }
    }
    // 11. Live-caps.
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            if stop_pct > caps.max_stop_pct {
                return None;
            }
        }
    }

    // 12. Sizing pipeline.
    let factor = resolve_sizing_factor(state, cfg, last.open_time);
    let mut eff_risk = params.base_risk_frac * factor;
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            eff_risk = eff_risk.min(caps.max_risk_frac);
        }
    }
    if eff_risk <= 0.0 {
        return None;
    }
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (last.close * (1.0 - stop_pct), last.close * (1.0 + tp_pct)),
        PositionSide::Short => (last.close * (1.0 + stop_pct), last.close * (1.0 - tp_pct)),
    };
    let chandelier_atr = cfg.chandelier_exit.and_then(|ce| {
        let series = atr(candles, ce.period as usize);
        series[i]
    });
    Some(PollSignal {
        symbol: asset.symbol.clone(),
        source_symbol: source_symbol.to_string(),
        direction,
        entry_time: last.open_time,
        entry_price: last.close,
        stop_price,
        tp_price,
        stop_pct,
        tp_pct,
        eff_risk,
        chandelier_atr_at_entry: chandelier_atr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }
    fn asset() -> AssetConfig {
        AssetConfig {
            symbol: "BTC-TREND".into(),
            source_symbol: Some("BTCUSDT".into()),
            tp_pct: None,
            stop_pct: None,
            risk_frac: 0.4,
            activate_after_day: None,
            min_equity_gain: None,
            max_equity_gain: None,
            hold_bars: None,
            invert_direction: false,
            ..Default::default()
        }
    }

    fn ramp(n: usize, base: f64, slope: f64) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let p = base + slope * i as f64;
                Candle::new(i as i64 * 1800_000, p, p + 0.5, p - 0.5, p, 0.0)
            })
            .collect()
    }

    #[test]
    fn rejects_choppy_markets() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.choppiness_max = Some(40.0); // tighter

        // Flat noise → high CI → blocked.
        let mut candles: Vec<Candle> = Vec::new();
        for i in 0..70 {
            let alt = if i % 2 == 0 { 100.5 } else { 99.5 };
            candles.push(Candle::new(i * 1800_000, alt, alt + 0.1, alt - 0.1, alt, 0.0));
        }
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        };
        assert!(detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs).is_none());
    }

    #[test]
    fn fires_on_uptrend_with_pullback() {
        let mut s = EngineState::initial("x");
        // This test targets the SMA-fast pullback-recovery FALLBACK path —
        // disable the consecutive-close trigger by zeroing trigger_bars.
        let mut cfg = cfg();
        cfg.trigger_bars = 0;
        let a = asset();
        // Loosen filters for this synthetic test.
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.adx_min = None;
        p.choppiness_max = None;
        p.rsi_long_max = None;

        let mut candles = ramp(80, 100.0, 0.5);
        // Force the last bar to dip to/below SMA-fast then close above.
        let last = candles.last_mut().unwrap();
        last.low = 130.0;
        last.high = 145.0;
        last.close = 144.0;
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        };
        let sig = detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs);
        assert!(sig.is_some(), "expected long fire");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);
    }

    #[test]
    fn news_blackout_blocks_entry() {
        let mut s = EngineState::initial("x");
        // Disable consecutive trigger so we exercise the pullback-recovery
        // path (the trigger would otherwise pre-empt news-blackout because
        // the trigger gate runs before news in the pipeline).
        let mut cfg = cfg();
        cfg.trigger_bars = 0;
        let a = asset();
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.adx_min = None;
        p.choppiness_max = None;
        p.rsi_long_max = None;

        let mut candles = ramp(80, 100.0, 0.5);
        let last_ts = candles.last().unwrap().open_time;
        let last = candles.last_mut().unwrap();
        last.low = 130.0;
        last.high = 145.0;
        last.close = 144.0;
        let events = vec![NewsEvent {
            name: "FOMC".into(),
            ts_ms: last_ts,
            pre_minutes: 30,
            post_minutes: 30,
        }];
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: Some(&events),
            funding_series: None,
        };
        assert!(detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs).is_none());
    }

    /// R29-R7: cfg.funding_rate_filter active + funding > maxFL → long blocked,
    /// short still allowed. Mirrors the TS gate at ftmoDaytrade24h.ts:4219-4238.
    #[test]
    fn signals_r28v6_funding_filter() {
        // ── Long-side test: uptrend + crowded-long funding → blocked ──
        let mut s = EngineState::initial("x");
        let mut cfg = cfg();
        // Funding-filter test exercises the SMA-fast pullback-recovery
        // path — disable the consecutive-close trigger.
        cfg.trigger_bars = 0;
        cfg.funding_rate_filter = Some(crate::config::FundingRateFilter {
            max_funding_for_long: Some(0.0005),
            min_funding_for_short: Some(-0.0003),
        });
        let a = asset();
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.adx_min = None;
        p.choppiness_max = None;
        p.rsi_long_max = None;
        // Down-ramp drives RSI ≈ 0 which trips the default short_min=30 gate
        // and would mask the funding-filter assertion below; clear it.
        p.rsi_short_min = None;

        let mut candles = ramp(80, 100.0, 0.5);
        let last = candles.last_mut().unwrap();
        last.low = 130.0;
        last.high = 145.0;
        last.close = 144.0;

        // Build crowded-long funding series: 0.001 (= 10bp, > maxFL=0.0005).
        let funding: Vec<Option<f64>> = (0..candles.len()).map(|_| Some(0.001)).collect();
        let inputs_long_blocked = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: Some(&funding),
        };
        assert!(
            detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs_long_blocked)
                .is_none(),
            "long must be blocked when funding > maxFL"
        );

        // ── Same trend but funding inside threshold (0.0001 < 0.0005) → fires.
        let funding_ok: Vec<Option<f64>> = (0..candles.len()).map(|_| Some(0.0001)).collect();
        let inputs_long_ok = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: Some(&funding_ok),
        };
        let mut s2 = EngineState::initial("x");
        let sig = detect_r28_v6(&mut s2, &cfg, &a, "BTCUSDT", &candles, &p, &inputs_long_ok);
        assert!(sig.is_some(), "long should fire when funding within threshold");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);

        // ── Short-side test: downtrend + funding < minFS → blocked ──
        let mut s3 = EngineState::initial("x");
        let mut candles_dn = ramp(80, 200.0, -0.5);
        let last = candles_dn.last_mut().unwrap();
        last.high = 170.0;
        last.low = 155.0;
        last.close = 156.0;
        let funding_neg: Vec<Option<f64>> =
            (0..candles_dn.len()).map(|_| Some(-0.001)).collect();
        let inputs_short_blocked = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: Some(&funding_neg),
        };
        assert!(
            detect_r28_v6(&mut s3, &cfg, &a, "BTCUSDT", &candles_dn, &p, &inputs_short_blocked)
                .is_none(),
            "short must be blocked when funding < minFS"
        );

        // ── FRLONG variant (only maxFL set) — short side is dormant. ──
        let mut cfg_frlong = cfg.clone();
        cfg_frlong.funding_rate_filter = Some(crate::config::FundingRateFilter {
            max_funding_for_long: Some(0.0005),
            min_funding_for_short: None,
        });
        let mut s4 = EngineState::initial("x");
        // Even with extremely negative funding, FRLONG must allow shorts.
        let funding_extreme_neg: Vec<Option<f64>> =
            (0..candles_dn.len()).map(|_| Some(-0.05)).collect();
        let inputs_short_frlong = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: Some(&funding_extreme_neg),
        };
        let sig_short = detect_r28_v6(
            &mut s4,
            &cfg_frlong,
            &a,
            "BTCUSDT",
            &candles_dn,
            &p,
            &inputs_short_frlong,
        );
        assert!(sig_short.is_some(), "FRLONG must not gate shorts");
    }

    /// Per-asset overrides shadow cfg-level thresholds.
    #[test]
    fn signals_r28v6_funding_filter_per_asset_override() {
        // cfg threshold tight (0.0001), per-asset override loose (0.001).
        // Funding=0.0008 > cfg.max but < asset.max → entry should fire.
        let mut s = EngineState::initial("x");
        let mut cfg = cfg();
        // Per-asset funding override test uses pullback-recovery path.
        cfg.trigger_bars = 0;
        cfg.funding_rate_filter = Some(crate::config::FundingRateFilter {
            max_funding_for_long: Some(0.0001),
            min_funding_for_short: None,
        });
        let mut a = asset();
        a.max_funding_for_long = Some(0.001);
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.adx_min = None;
        p.choppiness_max = None;
        p.rsi_long_max = None;

        let mut candles = ramp(80, 100.0, 0.5);
        let last = candles.last_mut().unwrap();
        last.low = 130.0;
        last.high = 145.0;
        last.close = 144.0;
        let funding: Vec<Option<f64>> = (0..candles.len()).map(|_| Some(0.0008)).collect();
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: Some(&funding),
        };
        let sig = detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs);
        assert!(sig.is_some(), "per-asset override should permit entry");
    }

    /// `funding_filter_allows` returns true when no filter is configured
    /// (fast-path).
    #[test]
    fn funding_filter_dormant_when_unconfigured() {
        let cfg = cfg();
        let a = asset();
        assert!(funding_filter_allows(&cfg, &a, PositionSide::Long, None, 0));
        let funding: Vec<Option<f64>> = vec![Some(1.0); 5];
        assert!(funding_filter_allows(
            &cfg,
            &a,
            PositionSide::Long,
            Some(&funding),
            2
        ));
    }

    /// Funding-series None / out-of-range / explicit-None bar → gate dormant.
    #[test]
    fn funding_filter_skips_when_series_missing() {
        let mut cfg = cfg();
        cfg.funding_rate_filter = Some(crate::config::FundingRateFilter {
            max_funding_for_long: Some(0.0001),
            min_funding_for_short: None,
        });
        let a = asset();
        // series=None → allow
        assert!(funding_filter_allows(&cfg, &a, PositionSide::Long, None, 5));
        // bar_index out of range → allow
        let funding: Vec<Option<f64>> = vec![Some(0.001); 3];
        assert!(funding_filter_allows(
            &cfg,
            &a,
            PositionSide::Long,
            Some(&funding),
            10
        ));
        // bar value None → allow
        let funding_with_gap: Vec<Option<f64>> = vec![None; 5];
        assert!(funding_filter_allows(
            &cfg,
            &a,
            PositionSide::Long,
            Some(&funding_with_gap),
            2
        ));
    }

    /// Default consecutive-close trigger fires Long when `cfg.trigger_bars=N`
    /// red bars precede the current bar, with `invert_direction=false` and an
    /// upward SMA-slow slope. Mirrors `ftmoDaytrade24h.ts:4067-4082`.
    #[test]
    fn consecutive_red_bars_after_uptrend_fires_long() {
        let mut s = EngineState::initial("x");
        let mut cfg = cfg();
        cfg.trigger_bars = 3; // require 3 consecutive red closes
        let a = asset(); // invert_direction = false → MR-style long on reds
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.adx_min = None;
        p.choppiness_max = None;
        p.rsi_long_max = None;

        // Build a 80-bar uptrend (so SMA-slow slopes UP → direction=Long),
        // then append 3 consecutive red bars at the end (close strictly
        // decreasing). Candles 0..76 ramp up; 77/78/79 step down.
        let mut candles = ramp(80, 100.0, 0.5);
        // Anchor the pre-pullback close so the first red bar starts strictly
        // above its predecessor.
        candles[76].close = 138.0;
        candles[76].high = 138.5;
        candles[76].low = 137.5;
        // 3 consecutive red bars: 138 → 137 → 136 → 135.
        for (k, close) in [137.0_f64, 136.0, 135.0].iter().enumerate() {
            let c = &mut candles[77 + k];
            c.close = *close;
            c.high = close + 0.5;
            c.low = close - 0.5;
        }
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        };
        let sig = detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs);
        assert!(sig.is_some(), "3 consecutive red bars after uptrend should fire long");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);
    }

    /// Same setup but only 2 consecutive reds (last bar bounces back up) →
    /// trigger must NOT fire under `trigger_bars=3`.
    #[test]
    fn insufficient_consecutive_reds_does_not_fire() {
        let mut s = EngineState::initial("x");
        let mut cfg = cfg();
        cfg.trigger_bars = 3;
        let a = asset();
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.adx_min = None;
        p.choppiness_max = None;
        p.rsi_long_max = None;

        let mut candles = ramp(80, 100.0, 0.5);
        candles[76].close = 138.0;
        // 2 reds + 1 green (close at index 79 must be > index 78).
        candles[77].close = 137.0;
        candles[78].close = 136.0;
        candles[79].close = 137.5; // green: violates the consecutive rule
        for c in &mut candles[77..80] {
            c.high = c.close + 0.5;
            c.low = c.close - 0.5;
        }
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        };
        let sig = detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs);
        assert!(
            sig.is_none(),
            "trigger must require ALL N bars to be the right colour"
        );
    }

    /// Per-asset `trigger_bars` override beats `cfg.trigger_bars`.
    #[test]
    fn per_asset_trigger_bars_override_takes_precedence() {
        let mut s = EngineState::initial("x");
        let mut cfg = cfg();
        cfg.trigger_bars = 5; // would be hard to satisfy
        let mut a = asset();
        a.trigger_bars = Some(1); // override: only 1 red bar needed
        let mut p = R28V6Params::default_for(&a, &cfg);
        p.adx_min = None;
        p.choppiness_max = None;
        p.rsi_long_max = None;

        let mut candles = ramp(80, 100.0, 0.5);
        // Single red last bar.
        candles[78].close = 138.0;
        candles[79].close = 137.0;
        for c in &mut candles[78..80] {
            c.high = c.close + 0.5;
            c.low = c.close - 0.5;
        }
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        };
        let sig = detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs);
        assert!(sig.is_some(), "per-asset trigger_bars=1 should permit entry");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);
    }
}
