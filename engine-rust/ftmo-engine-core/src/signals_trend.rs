//! Trend-pullback signal source — a minimal port of the R28-style trend
//! detector that drives FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6.
//!
//! Rules (matching the V5_QUARTZ-Lite description in `ftmoDaytrade24h.ts`):
//!   1. Trend direction is set by the SMA(slow) slope at bar `i`:
//!        - up   ⇒ long-only candidate
//!        - down ⇒ short-only candidate
//!   2. Trigger fires on a pull-back to the SMA(fast) line and a recovery
//!      close in the trend direction. We translate "pullback then recover"
//!      into: candle.low ≤ sma_fast (long) or candle.high ≥ sma_fast (short)
//!      AND candle.close has recovered past sma_fast.
//!   3. Optional ATR-stop widens the stop in volatile regimes via
//!      `cfg.atr_stop = { period, stop_mult }`. Final stop_pct =
//!      max(cfg.stop_pct, stop_mult × ATR / entry_price).
//!   4. Sizing through the full `resolve_sizing_factor` pipeline; live caps
//!      enforced unless `cfg.bypass_live_caps`.
//!   5. Optional RSI confluence gate (`detector_filters::rsi_filter_allows`).

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::detector_filters::rsi_filter_allows;
use crate::indicators::{atr, rsi, sma};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::resolve_sizing_factor;
use crate::state::EngineState;

pub struct TrendParams {
    pub fast_period: usize,
    pub slow_period: usize,
    pub stop_pct: f64,
    pub tp_pct: f64,
    pub base_risk_frac: f64,
    /// Optional RSI confluence (period, long_max, short_min).
    pub rsi_filter: Option<(usize, Option<f64>, Option<f64>)>,
}

impl TrendParams {
    pub fn from_cfg(cfg: &EngineConfig, asset: &AssetConfig) -> Self {
        Self {
            fast_period: 20,
            slow_period: 50,
            stop_pct: asset.stop_pct.unwrap_or(cfg.stop_pct),
            tp_pct: asset.tp_pct.unwrap_or(cfg.tp_pct),
            base_risk_frac: asset.risk_frac,
            rsi_filter: None,
        }
    }
}

/// Returns at most one signal for the LAST candle of `candles`, or `None`.
pub fn detect_trend_pullback(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &TrendParams,
) -> Option<PollSignal> {
    if candles.len() < params.slow_period + 2 {
        return None;
    }
    let i = candles.len() - 1;
    let last = candles[i];
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let sma_fast = sma(&closes, params.fast_period);
    let sma_slow = sma(&closes, params.slow_period);

    let cur_slow = sma_slow[i]?;
    let prev_slow = sma_slow[i - 1]?;
    let cur_fast = sma_fast[i]?;

    let direction = if cur_slow > prev_slow {
        PositionSide::Long
    } else if cur_slow < prev_slow {
        PositionSide::Short
    } else {
        return None;
    };

    // Pull-back-then-recover trigger.
    let triggered = match direction {
        PositionSide::Long => last.low <= cur_fast && last.close > cur_fast,
        PositionSide::Short => last.high >= cur_fast && last.close < cur_fast,
    };
    if !triggered {
        return None;
    }

    // Optional RSI confluence.
    if let Some((period, long_max, short_min)) = params.rsi_filter {
        let series = rsi(&closes, period);
        if !rsi_filter_allows(series[i], direction, long_max, short_min) {
            return None;
        }
    }

    // Compose final stop_pct via optional ATR-stop.
    let mut stop_pct = params.stop_pct;
    if let Some(at) = cfg.atr_stop {
        let series = atr(candles, at.period as usize);
        if let Some(a) = series[i] {
            let atr_stop = (at.stop_mult * a) / last.close.max(1e-9);
            stop_pct = stop_pct.max(atr_stop);
        }
    }
    // Optional R60 vol-adaptive TP multiplier.
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
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            if stop_pct > caps.max_stop_pct {
                return None;
            }
        }
    }

    // Sizing.
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
        PositionSide::Long => (
            last.close * (1.0 - stop_pct),
            last.close * (1.0 + tp_pct),
        ),
        PositionSide::Short => (
            last.close * (1.0 + stop_pct),
            last.close * (1.0 - tp_pct),
        ),
    };

    // ChandelierATR-at-entry passes through if cfg.chandelier_exit is on.
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
    use crate::config::AssetConfig;

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
                Candle::new(i as i64 * 1800_000, p, p + 0.2, p - 0.2, p, 0.0)
            })
            .collect()
    }

    #[test]
    fn no_signal_on_flat_market() {
        let mut s = EngineState::initial("x");
        let candles = ramp(60, 100.0, 0.0);
        let p = TrendParams::from_cfg(&cfg(), &asset());
        assert!(detect_trend_pullback(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &p).is_none());
    }

    #[test]
    fn long_signal_on_uptrend_with_pullback() {
        let mut s = EngineState::initial("x");
        let mut candles = ramp(60, 100.0, 0.5);
        // Force last bar to dip down to/below SMA-fast then close above.
        let last = candles.last_mut().unwrap();
        // SMA-fast(20) at end of a 0.5/bar ramp at i=59 is around the middle
        // of the last 20 → close-ish to 124.5. Make last bar's low touch
        // that level and close above.
        last.low = 124.0;
        last.high = 130.5;
        last.close = 130.0;
        let p = TrendParams::from_cfg(&cfg(), &asset());
        let sig = detect_trend_pullback(&mut s, &cfg(), &asset(), "BTCUSDT", &candles, &p);
        assert!(sig.is_some(), "expected long signal on uptrend pullback");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);
    }
}
