//! V12 EMA-Stack detector — port of the V12 family detector
//! (V12_30M_OPT, V12_TURBO, V261_2H_OPT). Triple EMA stack with
//! multi-timeframe trend confirmation.
//!
//! Rules:
//!   1. EMA(fast=8) > EMA(mid=21) > EMA(slow=55)  → bull stack (long candidate)
//!   2. EMA(fast=8) < EMA(mid=21) < EMA(slow=55)  → bear stack (short)
//!   3. Pullback trigger: long → close pulls back to EMA(mid) and recovers;
//!      short → mirror.
//!   4. HTF EMA-fast/slow on supplied higher-tf closes (optional).
//!   5. ATR-stop widening + vol-adaptive TP.
//!   6. Sizing pipeline + live caps.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::detector_filters::htf_trend_allows;
use crate::indicators::{atr, ema};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::sizing::resolve_sizing_factor;
use crate::state::EngineState;

pub struct V12Params {
    pub fast_period: usize,
    pub mid_period: usize,
    pub slow_period: usize,
    pub stop_pct: f64,
    pub tp_pct: f64,
    pub base_risk_frac: f64,
    pub htf_fast: usize,
    pub htf_slow: usize,
}

impl V12Params {
    pub fn default_for(asset: &AssetConfig, cfg: &EngineConfig) -> Self {
        Self {
            fast_period: 8,
            mid_period: 21,
            slow_period: 55,
            stop_pct: asset.stop_pct.unwrap_or(cfg.stop_pct),
            tp_pct: asset.tp_pct.unwrap_or(cfg.tp_pct),
            base_risk_frac: asset.risk_frac,
            htf_fast: 9,
            htf_slow: 21,
        }
    }
}

pub fn detect_v12(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &V12Params,
    htf_closes: Option<&[f64]>,
) -> Option<PollSignal> {
    if candles.len() < params.slow_period + 4 {
        return None;
    }
    let i = candles.len() - 1;
    let last = candles[i];
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let fast = ema(&closes, params.fast_period);
    let mid = ema(&closes, params.mid_period);
    let slow = ema(&closes, params.slow_period);
    let (f_now, m_now, s_now) = (fast[i]?, mid[i]?, slow[i]?);
    let (f_prev, m_prev, _s_prev) = (fast[i - 1]?, mid[i - 1]?, slow[i - 1]?);

    // Stack direction.
    let mut direction = if f_now > m_now && m_now > s_now {
        PositionSide::Long
    } else if f_now < m_now && m_now < s_now {
        PositionSide::Short
    } else {
        return None;
    };
    if asset.invert_direction {
        direction = direction.opposite();
    }

    // Pullback trigger — close just bounced off mid EMA.
    let pullback = match direction {
        PositionSide::Long => last.low <= m_now && last.close > m_now && f_prev > m_prev,
        PositionSide::Short => last.high >= m_now && last.close < m_now && f_prev < m_prev,
    };
    if !pullback {
        return None;
    }

    // HTF trend confluence.
    if let Some(htf) = htf_closes {
        if !htf_trend_allows(htf, params.htf_fast, params.htf_slow, direction) {
            return None;
        }
    }

    // Stop_pct via ATR.
    let mut stop_pct = params.stop_pct;
    if let Some(at) = cfg.atr_stop {
        let series = atr(candles, at.period as usize);
        if let Some(a) = series[i] {
            let atr_stop = (at.stop_mult * a) / last.close.max(1e-9);
            stop_pct = stop_pct.max(atr_stop);
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AssetConfig;

    fn cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }
    fn asset() -> AssetConfig {
        AssetConfig {
            symbol: "BTC-V12".into(),
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
    fn no_signal_on_flat() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = V12Params::default_for(&a, &cfg);
        let candles = ramp(80, 100.0, 0.0);
        assert!(detect_v12(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, None).is_none());
    }

    #[test]
    fn long_signal_on_uptrend_stack_and_pullback() {
        let mut s = EngineState::initial("x");
        let cfg = cfg();
        let a = asset();
        let p = V12Params::default_for(&a, &cfg);
        let mut candles = ramp(80, 100.0, 0.5);
        // Force pullback-recovery on last bar.
        let last = candles.last_mut().unwrap();
        last.low = 132.0;
        last.high = 145.0;
        last.close = 144.0;
        let sig = detect_v12(&mut s, &cfg, &a, "BTCUSDT", &candles, &p, None);
        // The detector requires EMA(fast)>EMA(mid)>EMA(slow) AND pullback.
        // On a strong uptrend the stack is bullish — pullback to mid then recover.
        assert!(sig.is_some(), "expected long V12 signal on uptrend pullback");
        assert_eq!(sig.unwrap().direction, PositionSide::Long);
    }
}
