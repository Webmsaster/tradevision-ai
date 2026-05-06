//! Donchian-style breakout signal generator — a minimal, self-contained
//! signal source so the harness can drive end-to-end backtests before the
//! full `detectAsset` port lands.
//!
//! Rule:
//!   - long when `close[i] > max(high[i-N..i])`
//!   - short when `close[i] < min(low[i-N..i])`
//! The signal is emitted at the END of bar `i` (live convention) — actual
//! execution happens at bar `i+1` open. Caller is responsible for
//! interpreting `entry_time` / `entry_price` accordingly.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::resolve_sizing_factor;
use crate::state::EngineState;

pub struct BreakoutParams {
    pub lookback: usize,
    pub stop_pct: f64,
    pub tp_pct: f64,
    pub base_risk_frac: f64,
}

impl BreakoutParams {
    pub fn from_cfg(cfg: &EngineConfig, asset: &AssetConfig) -> Self {
        Self {
            lookback: cfg.trigger_bars.max(1) as usize,
            stop_pct: asset.stop_pct.unwrap_or(cfg.stop_pct),
            tp_pct: asset.tp_pct.unwrap_or(cfg.tp_pct),
            base_risk_frac: asset.risk_frac,
        }
    }
}

/// Emit at most one signal for the LAST candle in `candles` (live-poll
/// convention). Returns `None` if the breakout filter doesn't fire or there
/// aren't enough bars yet.
pub fn detect_breakout(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &BreakoutParams,
) -> Option<PollSignal> {
    if candles.len() <= params.lookback {
        return None;
    }
    let i = candles.len() - 1;
    let last = candles[i];
    let lo = i - params.lookback;
    let max_high = candles[lo..i].iter().map(|c| c.high).fold(f64::MIN, f64::max);
    let min_low = candles[lo..i].iter().map(|c| c.low).fold(f64::MAX, f64::min);

    let direction = if last.close > max_high {
        PositionSide::Long
    } else if last.close < min_low {
        PositionSide::Short
    } else {
        return None;
    };

    let factor = resolve_sizing_factor(state, cfg, last.open_time);
    let mut eff_risk = params.base_risk_frac * factor;
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            eff_risk = eff_risk.min(caps.max_risk_frac);
            // R51 — also skip outright if effective stop is wider than max_stop_pct.
            if params.stop_pct > caps.max_stop_pct {
                return None;
            }
        }
    }
    if eff_risk <= 0.0 {
        return None;
    }

    let (stop_price, tp_price) = match direction {
        PositionSide::Long => (
            last.close * (1.0 - params.stop_pct),
            last.close * (1.0 + params.tp_pct),
        ),
        PositionSide::Short => (
            last.close * (1.0 + params.stop_pct),
            last.close * (1.0 - params.tp_pct),
        ),
    };

    Some(PollSignal {
        symbol: asset.symbol.clone(),
        source_symbol: source_symbol.to_string(),
        direction,
        entry_time: last.open_time,
        entry_price: last.close,
        stop_price,
        tp_price,
        stop_pct: params.stop_pct,
        tp_pct: params.tp_pct,
        eff_risk,
        chandelier_atr_at_entry: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AssetConfig;

    fn cfg() -> EngineConfig {
        let mut c = EngineConfig::r28_v6_passlock_template();
        c.trigger_bars = 5;
        c.stop_pct = 0.02;
        c.tp_pct = 0.04;
        c
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
                Candle::new(i as i64 * 1800_000, p, p + 0.1, p - 0.1, p, 0.0)
            })
            .collect()
    }

    #[test]
    fn no_breakout_when_close_inside_range() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = BreakoutParams::from_cfg(&cfg, &a);
        let candles = ramp(20, 100.0, 0.0); // flat
        assert!(detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).is_none());
    }

    #[test]
    fn long_breakout_on_uptrend() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = BreakoutParams::from_cfg(&cfg, &a);
        let mut candles = ramp(10, 100.0, 0.5); // rising
        // Force last close strictly above max(high[..-1])
        let last = candles.last_mut().unwrap();
        last.close = last.high + 5.0;
        let sig = detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).unwrap();
        assert_eq!(sig.direction, PositionSide::Long);
        assert!(sig.stop_price < sig.entry_price);
        assert!(sig.tp_price > sig.entry_price);
        assert!((sig.eff_risk - 0.4).abs() < 1e-9);
    }

    #[test]
    fn short_breakout_on_downtrend() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = BreakoutParams::from_cfg(&cfg, &a);
        let mut candles = ramp(10, 100.0, -0.5);
        let last = candles.last_mut().unwrap();
        last.close = last.low - 5.0;
        let sig = detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).unwrap();
        assert_eq!(sig.direction, PositionSide::Short);
        assert!(sig.stop_price > sig.entry_price);
        assert!(sig.tp_price < sig.entry_price);
    }

    #[test]
    fn skips_when_stop_pct_exceeds_live_cap() {
        let mut s = EngineState::initial("x");
        let mut cfg = cfg();
        cfg.live_caps = Some(crate::config::LiveCaps { max_stop_pct: 0.01, max_risk_frac: 0.4 });
        let a = asset();
        let mut p = BreakoutParams::from_cfg(&cfg, &a);
        p.stop_pct = 0.05; // above cap
        let mut candles = ramp(10, 100.0, 0.5);
        let last = candles.last_mut().unwrap();
        last.close = last.high + 5.0;
        assert!(detect_breakout(&mut s, &cfg, &a, "BTCUSDT", &candles, &p).is_none());
    }
}
