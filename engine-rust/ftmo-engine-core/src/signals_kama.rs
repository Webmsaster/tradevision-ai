// 2026-05-17 Custom Rust Signal-Detector: KAMA (Kaufman Adaptive Moving Average).
// New orthogonal trend voter that auto-filters chop via Efficiency-Ratio.
//
// KAMA mathematics:
//   ER = |close[t] - close[t-n]| / Σ|close[i] - close[i-1]|   (Efficiency Ratio)
//   SC = (ER × (fast_sc - slow_sc) + slow_sc)²                (Smoothing Constant)
//   KAMA[t] = KAMA[t-1] + SC × (close[t] - KAMA[t-1])
//
// Voter rule (lookahead-safe, signal_idx = candles.len() - 2):
//   ER > er_threshold AND KAMA[signal_idx] > KAMA[signal_idx - 3] → Long
//   ER > er_threshold AND KAMA[signal_idx] < KAMA[signal_idx - 3] → Short
//   else None (insufficient trend → abstain)
//
// Source: 50-agent Voter Brainstorm Hunt 2.

use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct KamaParams {
    pub er_period: usize,
    pub fast_period: usize,
    pub slow_period: usize,
    pub er_threshold: f64,
    pub slope_lookback: usize,
}

impl Default for KamaParams {
    fn default() -> Self {
        Self {
            er_period: 10,
            fast_period: 2,
            slow_period: 30,
            er_threshold: 0.35,
            slope_lookback: 3,
        }
    }
}

pub fn compute_kama_vote(candles: &[Candle], params: &KamaParams) -> Option<PositionSide> {
    if params.er_period < 2 || params.slow_period < params.fast_period {
        return None;
    }
    if candles.len() < params.er_period + params.slope_lookback + 3 {
        return None;
    }
    let signal_idx = candles.len() - 2;
    if signal_idx < params.er_period + params.slope_lookback {
        return None;
    }
    let fast_sc = 2.0 / (params.fast_period as f64 + 1.0);
    let slow_sc = 2.0 / (params.slow_period as f64 + 1.0);

    let mut kama: f64 = candles[params.er_period - 1].close;
    let mut kama_at_slope_back: f64 = f64::NAN;
    let mut kama_at_signal: f64 = f64::NAN;
    let mut er_at_signal: f64 = 0.0;

    for i in params.er_period..=signal_idx {
        let c = candles[i].close;
        let c_prev_n = candles[i - params.er_period].close;
        if !c.is_finite() || !c_prev_n.is_finite() {
            continue;
        }
        let change = (c - c_prev_n).abs();
        let mut volatility = 0.0;
        for j in (i - params.er_period + 1)..=i {
            let a = candles[j].close;
            let b = candles[j - 1].close;
            if !a.is_finite() || !b.is_finite() {
                volatility = 0.0;
                break;
            }
            volatility += (a - b).abs();
        }
        if volatility <= 0.0 {
            continue;
        }
        let er = (change / volatility).clamp(0.0, 1.0);
        let sc = (er * (fast_sc - slow_sc) + slow_sc).powi(2);
        kama = kama + sc * (c - kama);
        if i == signal_idx - params.slope_lookback {
            kama_at_slope_back = kama;
        }
        if i == signal_idx {
            kama_at_signal = kama;
            er_at_signal = er;
        }
    }

    if !kama_at_signal.is_finite() || !kama_at_slope_back.is_finite() {
        return None;
    }
    if er_at_signal < params.er_threshold {
        return None;
    }
    if kama_at_signal > kama_at_slope_back {
        Some(PositionSide::Long)
    } else if kama_at_signal < kama_at_slope_back {
        Some(PositionSide::Short)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candle::Candle;

    fn mk(c: f64) -> Candle {
        Candle {
            open_time: 0,
            close_time: 0,
            open: c,
            high: c + 0.5,
            low: c - 0.5,
            close: c,
            volume: 1.0,
            taker_buy_volume: Some(0.5),
            is_final: true,
        }
    }

    #[test]
    fn kama_returns_none_on_insufficient_input() {
        let cs: Vec<Candle> = (0..5).map(|i| mk(100.0 + i as f64)).collect();
        assert_eq!(compute_kama_vote(&cs, &KamaParams::default()), None);
    }

    #[test]
    fn kama_does_not_index_entry_bar() {
        let mut cs: Vec<Candle> = (0..40).map(|i| mk(100.0 + (i as f64).sin())).collect();
        let baseline = compute_kama_vote(&cs, &KamaParams::default());
        let last = cs.len() - 1;
        cs[last] = Candle {
            close: f64::NAN,
            high: f64::NAN,
            low: f64::NAN,
            ..cs[last]
        };
        let poisoned = compute_kama_vote(&cs, &KamaParams::default());
        assert_eq!(baseline, poisoned, "KAMA voter must not read entry bar");
    }
}
