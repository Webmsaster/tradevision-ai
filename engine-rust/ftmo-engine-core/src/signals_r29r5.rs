//! R29 Round 5 — Order-Flow / Volume-Profile entry detectors.
//!
//! Three new entry triggers ported from `src/utils/ftmoDaytrade24h.ts`
//! (lines 3987-4062):
//!   1. CVD divergence  → `detect_cvd_divergence`
//!   2. Volume-Imbalance → `detect_vol_imbalance`
//!   3. Volume-Profile POC mean-reversion → `detect_vol_poc`
//!
//! All three emit at most one signal per call for the LAST candle in the
//! supplied `candles` slice (live-poll convention). Sizing flows through
//! the standard `resolve_sizing_factor` + `live_caps` pipeline so the
//! resulting `PollSignal.eff_risk` is identical in shape to other detectors.

use crate::candle::Candle;
use crate::config::{AssetConfig, CvdEntry, EngineConfig, VolImbalanceEntry, VolPocEntry};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::resolve_sizing_factor;
use crate::state::EngineState;

/// Build the standard PollSignal payload — sizing + stop/tp prices + caps.
/// Returns `None` if `eff_risk <= 0` after live-cap clamp, mirroring the
/// other detectors.
fn finalise_signal(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    last: &Candle,
    direction: PositionSide,
) -> Option<PollSignal> {
    let stop_pct = asset.stop_pct.unwrap_or(cfg.stop_pct);
    let tp_pct = asset.tp_pct.unwrap_or(cfg.tp_pct);

    let factor = resolve_sizing_factor(state, cfg, last.open_time);
    let mut eff_risk = asset.risk_frac * factor;
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            eff_risk = eff_risk.min(caps.max_risk_frac);
            // Skip outright if asset stop is wider than the FTMO cap. Mirrors
            // signals_breakout.rs:71 — backtests with `liveCaps {maxStopPct:
            // 0.05}` reject anything wider so `effRisk` would be 0 anyway.
            if stop_pct > caps.max_stop_pct {
                return None;
            }
        }
    }
    if eff_risk <= 0.0 {
        return None;
    }
    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (last.close * (1.0 - stop_pct), last.close * (1.0 + tp_pct)),
        PositionSide::Short => (last.close * (1.0 + stop_pct), last.close * (1.0 - tp_pct)),
    };
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
        chandelier_atr_at_entry: None,
    })
}

/// CVD divergence — iter window `[i-lb, i]`, accumulate
/// `cvd += 2×takerBuyVolume − volume`, track min/max alongside price min/max.
/// Bullish (long): `close[i] == priceMin` AND `cvd > cvdMin` (price made new
/// low but CVD did NOT — buyer accumulation).
/// Bearish (short): inverse. Tolerances: 1e-9 on price, 1e-6 on CVD.
pub fn detect_cvd_divergence(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &CvdEntry,
) -> Option<PollSignal> {
    // R29-R3.4: CVD lookback is config-quoted in *bars*, but the wall-clock
    // window changes by TF. Scale by `30 / cfg.bar_minutes` so a 30m-tuned
    // 20-bar (=10h) lookback still measures 10h on 5m (120 bars) or 2h
    // (5 bars). Templates may set the param at any TF; this normalises.
    let scale = (30.0 / (cfg.bar_minutes.max(1) as f64)).round().max(1.0) as usize;
    let lb = (params.lookback_bars as usize) * scale;
    if candles.len() < lb + 2 {
        return None;
    }
    let i = candles.len() - 1;

    // Accumulate over window [i-lb, i] inclusive.
    let mut cvd = 0.0_f64;
    let mut cvd_min = f64::INFINITY;
    let mut cvd_max = f64::NEG_INFINITY;
    let mut price_min = f64::INFINITY;
    let mut price_max = f64::NEG_INFINITY;
    for c in candles[(i - lb)..=i].iter().copied() {
        let tbv = c.taker_buy_volume.unwrap_or(c.volume * 0.5);
        cvd += 2.0 * tbv - c.volume;
        if cvd < cvd_min {
            cvd_min = cvd;
        }
        if cvd > cvd_max {
            cvd_max = cvd;
        }
        if c.close < price_min {
            price_min = c.close;
        }
        if c.close > price_max {
            price_max = c.close;
        }
    }

    let last = candles[i];
    // Try long first, then short. Same per-direction logic as TS `for direction
    // of ['long','short']` outer loop.
    for direction in [PositionSide::Long, PositionSide::Short] {
        let ok = match direction {
            PositionSide::Long => {
                let price_at_min = last.close <= price_min + 1e-9;
                let cvd_at_min = cvd <= cvd_min + 1e-6;
                price_at_min && !cvd_at_min
            }
            PositionSide::Short => {
                let price_at_max = last.close >= price_max - 1e-9;
                let cvd_at_max = cvd >= cvd_max - 1e-6;
                price_at_max && !cvd_at_max
            }
        };
        if !ok {
            continue;
        }
        if let Some(s) = finalise_signal(state, cfg, asset, source_symbol, &last, direction) {
            return Some(s);
        }
    }
    None
}

/// Single-bar aggressor ratio test.
pub fn detect_vol_imbalance(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &VolImbalanceEntry,
) -> Option<PollSignal> {
    let i = candles.len().checked_sub(1)?;
    let last = candles[i];
    let tbv = last.taker_buy_volume?;
    if last.volume <= 0.0 {
        return None;
    }
    let ratio = tbv / last.volume;
    let direction = if ratio >= params.long_min {
        PositionSide::Long
    } else if ratio <= 1.0 - params.long_min {
        PositionSide::Short
    } else {
        return None;
    };
    finalise_signal(state, cfg, asset, source_symbol, &last, direction)
}

/// Volume-Profile POC mean-reversion. POC = close-of-bar with the highest
/// volume in the last `windowBars` (inclusive of `i`). Long if current close
/// ≥ `minDistFromPocPct` below POC; short if ≥ that fraction above.
pub fn detect_vol_poc(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &VolPocEntry,
) -> Option<PollSignal> {
    // R29-R3.4: same TF-scaling as CVD lookback above.
    let scale = (30.0 / (cfg.bar_minutes.max(1) as f64)).round().max(1.0) as usize;
    let wb = (params.window_bars as usize) * scale;
    if candles.len() < wb + 2 {
        return None;
    }
    let i = candles.len() - 1;
    let mut poc_vol = -1.0_f64;
    let mut poc_close = candles[i].close;
    for c in candles[(i - wb)..=i].iter().copied() {
        if c.volume > poc_vol {
            poc_vol = c.volume;
            poc_close = c.close;
        }
    }
    if poc_close <= 0.0 {
        return None;
    }
    let last = candles[i];
    let dist_pct = (poc_close - last.close) / poc_close;
    let direction = if dist_pct >= params.min_dist_from_poc_pct {
        // price BELOW poc → expect revert UP → long
        PositionSide::Long
    } else if dist_pct <= -params.min_dist_from_poc_pct {
        // price ABOVE poc → expect revert DOWN → short
        PositionSide::Short
    } else {
        return None;
    };
    finalise_signal(state, cfg, asset, source_symbol, &last, direction)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AssetConfig;

    fn cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }

    fn asset() -> AssetConfig {
        AssetConfig {
            symbol: "BTC-TREND".into(),
            source_symbol: Some("BTCUSDT".into()),
            risk_frac: 0.4,
            ..Default::default()
        }
    }

    fn candle_with(open_time: i64, close: f64, volume: f64, tbv: f64) -> Candle {
        Candle {
            open_time,
            open: close,
            high: close,
            low: close,
            close,
            volume,
            close_time: open_time + 1_799_999,
            is_final: true,
            taker_buy_volume: Some(tbv),
        }
    }

    #[test]
    fn cvd_no_divergence_when_price_and_cvd_both_at_low() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        // Falling price + falling CVD (sellers heavy) = no divergence.
        let mut candles = vec![];
        for k in 0..50 {
            // price drops, taker-buy is < 50% so cvd drops
            candles.push(candle_with(k * 1_800_000, 100.0 - k as f64, 100.0, 30.0));
        }
        assert!(detect_cvd_divergence(
            &mut s,
            &cfg,
            &a,
            "BTCUSDT",
            &candles,
            &CvdEntry { lookback_bars: 24 }
        )
        .is_none());
    }

    #[test]
    fn cvd_long_divergence_fires() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        // Price falls to a new low at the last bar BUT taker-buy stays high
        // (>50%) so CVD has been rising — bullish divergence.
        let mut candles = vec![];
        for k in 0..50 {
            // taker_buy 70 of 100 → cvd += 40 each bar — strictly increasing
            candles.push(candle_with(k * 1_800_000, 100.0 - k as f64, 100.0, 70.0));
        }
        // Final close is the lowest price
        let lo = candles.last().unwrap().close;
        for c in candles.iter() {
            assert!(c.close >= lo - 1e-9);
        }
        let sig = detect_cvd_divergence(
            &mut s,
            &cfg,
            &a,
            "BTCUSDT",
            &candles,
            &CvdEntry { lookback_bars: 24 },
        );
        let sig = sig.expect("divergence should fire");
        assert_eq!(sig.direction, PositionSide::Long);
    }

    #[test]
    fn vol_imbalance_long_when_ratio_above_threshold() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let candles = vec![candle_with(0, 100.0, 100.0, 70.0)];
        let sig = detect_vol_imbalance(
            &mut s,
            &cfg,
            &a,
            "BTCUSDT",
            &candles,
            &VolImbalanceEntry { long_min: 0.62 },
        )
        .unwrap();
        assert_eq!(sig.direction, PositionSide::Long);
    }

    #[test]
    fn vol_imbalance_short_when_ratio_below_complement() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let candles = vec![candle_with(0, 100.0, 100.0, 30.0)];
        let sig = detect_vol_imbalance(
            &mut s,
            &cfg,
            &a,
            "BTCUSDT",
            &candles,
            &VolImbalanceEntry { long_min: 0.62 },
        )
        .unwrap();
        assert_eq!(sig.direction, PositionSide::Short);
    }

    #[test]
    fn vol_imbalance_no_signal_when_neutral() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let candles = vec![candle_with(0, 100.0, 100.0, 50.0)];
        assert!(detect_vol_imbalance(
            &mut s,
            &cfg,
            &a,
            "BTCUSDT",
            &candles,
            &VolImbalanceEntry { long_min: 0.62 }
        )
        .is_none());
    }

    #[test]
    fn vol_poc_long_when_price_below_poc() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        // 100 bars: highest volume is bar 50 with close=100. Last close is 95
        // (5% below POC). distPct = (100-95)/100 = 0.05 ≥ 0.015 → long.
        let mut candles = vec![];
        for k in 0..100 {
            let close = if k == 50 { 100.0 } else { 99.0 };
            let vol = if k == 50 { 5_000.0 } else { 100.0 };
            candles.push(candle_with(k * 1_800_000, close, vol, vol * 0.5));
        }
        // last bar at 95
        let last_idx = candles.len() - 1;
        candles[last_idx].close = 95.0;
        let sig = detect_vol_poc(
            &mut s,
            &cfg,
            &a,
            "BTCUSDT",
            &candles,
            &VolPocEntry {
                window_bars: 96,
                min_dist_from_poc_pct: 0.015,
            },
        )
        .unwrap();
        assert_eq!(sig.direction, PositionSide::Long);
    }

    #[test]
    fn vol_poc_short_when_price_above_poc() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let mut candles = vec![];
        for k in 0..100 {
            let close = if k == 50 { 100.0 } else { 101.0 };
            let vol = if k == 50 { 5_000.0 } else { 100.0 };
            candles.push(candle_with(k * 1_800_000, close, vol, vol * 0.5));
        }
        let last_idx = candles.len() - 1;
        candles[last_idx].close = 105.0;
        let sig = detect_vol_poc(
            &mut s,
            &cfg,
            &a,
            "BTCUSDT",
            &candles,
            &VolPocEntry {
                window_bars: 96,
                min_dist_from_poc_pct: 0.015,
            },
        )
        .unwrap();
        assert_eq!(sig.direction, PositionSide::Short);
    }
}
