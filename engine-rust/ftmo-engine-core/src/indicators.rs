//! Indicators — port of `src/utils/indicators.ts` for the helpers the V4
//! engine reads. Output is a per-bar `Vec<Option<f64>>` matching the TS
//! `(number | null)[]` shape so callers can index by bar without bounds
//! arithmetic.
//!
//! All implementations mirror the R56 (`R56-IND-1`) NaN self-healing —
//! a single non-finite sample (broken candle, feed dropout) holds the
//! previous value rather than poisoning every downstream sample forever.

use crate::candle::Candle;

/// Simple moving average. `out[i]` is `Some` once `i + 1 ≥ period`.
pub fn sma(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out: Vec<Option<f64>> = vec![None; values.len()];
    if period == 0 || values.len() < period {
        return out;
    }
    let mut sum: f64 = values[..period].iter().sum();
    if sum.is_finite() {
        out[period - 1] = Some(sum / period as f64);
    }
    for i in period..values.len() {
        sum += values[i] - values[i - period];
        if sum.is_finite() {
            out[i] = Some(sum / period as f64);
        }
    }
    out
}

/// Exponential moving average. Seeds with an SMA over the first `period`
/// samples, then Wilder-style recursion `prev*k + value*(1-k)` (matches the
/// TS implementation; trading-view-style instant-seed is intentionally NOT
/// used).
pub fn ema(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out: Vec<Option<f64>> = vec![None; values.len()];
    if period == 0 || values.len() < period {
        return out;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    let mut prev = seed;
    if prev.is_finite() {
        out[period - 1] = Some(prev);
    }
    for i in period..values.len() {
        let v = values[i];
        if !v.is_finite() {
            out[i] = if prev.is_finite() { Some(prev) } else { None };
            continue;
        }
        if !prev.is_finite() {
            prev = v;
        } else {
            prev = v * k + prev * (1.0 - k);
        }
        out[i] = Some(prev);
    }
    out
}

fn rsi_from_avgs(avg_gain: f64, avg_loss: f64) -> f64 {
    if avg_gain == 0.0 && avg_loss == 0.0 {
        return 50.0;
    }
    if avg_loss == 0.0 {
        return 100.0;
    }
    100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
}

/// Relative Strength Index — Wilder smoothing.
pub fn rsi(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out: Vec<Option<f64>> = vec![None; values.len()];
    if period == 0 || values.len() <= period {
        return out;
    }
    let mut gain_sum = 0.0;
    let mut loss_sum = 0.0;
    let mut seed_valid = true;
    for i in 1..=period {
        let (a, b) = (values[i], values[i - 1]);
        if !a.is_finite() || !b.is_finite() {
            seed_valid = false;
            continue;
        }
        let change = a - b;
        if change >= 0.0 {
            gain_sum += change;
        } else {
            loss_sum -= change;
        }
    }
    let mut avg_gain = gain_sum / period as f64;
    let mut avg_loss = loss_sum / period as f64;
    out[period] = if seed_valid {
        Some(rsi_from_avgs(avg_gain, avg_loss))
    } else {
        None
    };
    for i in (period + 1)..values.len() {
        let (a, b) = (values[i], values[i - 1]);
        if !a.is_finite() || !b.is_finite() {
            out[i] = out[i - 1];
            continue;
        }
        let change = a - b;
        let gain = if change > 0.0 { change } else { 0.0 };
        let loss = if change < 0.0 { -change } else { 0.0 };
        if !seed_valid {
            avg_gain = gain;
            avg_loss = loss;
            seed_valid = true;
        } else {
            avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
            avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
        }
        out[i] = Some(rsi_from_avgs(avg_gain, avg_loss));
    }
    out
}

/// Average True Range — Wilder smoothing matching `indicators.ts:atr()`.
/// `out.len() == candles.len()`. First `period` samples are `None`.
pub fn atr(candles: &[Candle], period: usize) -> Vec<Option<f64>> {
    let mut out: Vec<Option<f64>> = vec![None; candles.len()];
    if period == 0 || candles.len() <= period {
        return out;
    }
    let tr: Vec<f64> = candles
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if i == 0 {
                let r = c.high - c.low;
                if r.is_finite() { r } else { f64::NAN }
            } else {
                let prev_close = candles[i - 1].close;
                if !c.high.is_finite() || !c.low.is_finite() || !prev_close.is_finite() {
                    return f64::NAN;
                }
                (c.high - c.low)
                    .max((c.high - prev_close).abs())
                    .max((c.low - prev_close).abs())
            }
        })
        .collect();

    let mut sum = 0.0;
    let mut seed_valid = true;
    for &t in &tr[1..=period] {
        if !t.is_finite() {
            seed_valid = false;
            continue;
        }
        sum += t;
    }
    let mut prev = sum / period as f64;
    out[period] = if seed_valid && prev.is_finite() {
        Some(prev)
    } else {
        None
    };
    for i in (period + 1)..candles.len() {
        let t = tr[i];
        if !t.is_finite() {
            out[i] = if prev.is_finite() { Some(prev) } else { None };
            continue;
        }
        if !prev.is_finite() {
            prev = t;
        } else {
            prev = (prev * (period as f64 - 1.0) + t) / period as f64;
        }
        out[i] = Some(prev);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(o: f64, h: f64, l: f64, cl: f64) -> Candle {
        Candle::new(0, o, h, l, cl, 0.0)
    }

    #[test]
    fn sma_basic_window() {
        let s = sma(&[1.0, 2.0, 3.0, 4.0, 5.0], 3);
        assert_eq!(s, vec![None, None, Some(2.0), Some(3.0), Some(4.0)]);
    }

    #[test]
    fn sma_too_short_returns_all_none() {
        assert_eq!(sma(&[1.0, 2.0], 3), vec![None, None]);
    }

    #[test]
    fn ema_seeds_with_sma() {
        let values = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let e = ema(&values, 3);
        assert!(e[0].is_none());
        assert!(e[1].is_none());
        // Seed: (1+2+3)/3 = 2.0
        assert_eq!(e[2], Some(2.0));
        // k = 2/(3+1) = 0.5; e[3] = 4*0.5 + 2*0.5 = 3.0
        assert!((e[3].unwrap() - 3.0).abs() < 1e-9);
    }

    #[test]
    fn rsi_window_too_short() {
        let r = rsi(&[1.0; 5], 14);
        assert!(r.iter().all(Option::is_none));
    }

    #[test]
    fn rsi_flat_series_is_fifty() {
        let r = rsi(&vec![100.0; 30], 14);
        assert_eq!(r[14], Some(50.0));
        assert_eq!(r[29], Some(50.0));
    }

    #[test]
    fn atr_too_short_returns_all_none() {
        let candles: Vec<Candle> = (0..5).map(|i| c(i as f64, i as f64 + 1.0, i as f64, i as f64 + 0.5)).collect();
        let a = atr(&candles, 14);
        assert!(a.iter().all(Option::is_none));
    }

    #[test]
    fn atr_constant_range_yields_constant_value() {
        // Every bar has high-low = 1, no gaps.
        let candles: Vec<Candle> = (0..30).map(|_| c(100.0, 100.5, 99.5, 100.0)).collect();
        let a = atr(&candles, 14);
        assert!(a[13].is_none());
        let v = a[14].expect("seed defined at index period");
        assert!((v - 1.0).abs() < 1e-9);
        // Wilder smoothing converges to TR — every later sample must equal 1.0.
        for i in 15..30 {
            assert!((a[i].unwrap() - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn atr_self_heals_after_nan_bar() {
        let mut candles: Vec<Candle> = (0..30).map(|_| c(100.0, 100.5, 99.5, 100.0)).collect();
        // Inject a NaN-bar in the middle: high becomes NaN.
        candles[20].high = f64::NAN;
        let a = atr(&candles, 14);
        assert!(a[14].unwrap().is_finite());
        // Bar 20 holds the previous value rather than poisoning.
        assert!(a[20].unwrap().is_finite());
        // Subsequent bars resume normal smoothing — must remain finite.
        assert!(a[29].unwrap().is_finite());
    }
}
