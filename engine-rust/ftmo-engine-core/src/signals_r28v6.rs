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

    // 2. Pullback-recovery trigger via SMA(fast).
    let sma_fast = sma(&closes, params.fast_period);
    let cur_fast = sma_fast[i]?;
    let triggered = match direction {
        PositionSide::Long => last.low <= cur_fast && last.close > cur_fast,
        PositionSide::Short => last.high >= cur_fast && last.close < cur_fast,
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
        };
        assert!(detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs).is_none());
    }

    #[test]
    fn fires_on_uptrend_with_pullback() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
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
        };
        let sig = detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs);
        assert!(sig.is_some(), "expected long fire");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);
    }

    #[test]
    fn news_blackout_blocks_entry() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
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
        };
        assert!(detect_r28_v6(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, &inputs).is_none());
    }
}
