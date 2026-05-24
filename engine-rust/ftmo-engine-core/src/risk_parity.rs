//! 2026-05-17 Risk-Parity Portfolio per-asset weighting.
//! Weight_i = (1/ATR_i) / Σ(1/ATR_j), clamped [0.5, 1.5], mean-preserving.
use crate::candle::Candle;

pub fn inverse_atr_weight(atr_value: f64, median_atr: f64, clamp_lo: f64, clamp_hi: f64) -> f64 {
    if atr_value <= 0.0 || median_atr <= 0.0 { return 1.0; }
    (median_atr / atr_value).clamp(clamp_lo, clamp_hi)
}

pub fn median(xs: &[f64]) -> f64 {
    let mut v: Vec<f64> = xs.iter().filter(|x| x.is_finite()).copied().collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if v.is_empty() { return 1.0; }
    // 2026-05-24 Wave5 HIGH FIX (Agent 6): prior code `v[v.len() / 2]`
    // returned the upper-middle element on even-length arrays, biasing the
    // inverse-ATR portfolio weight upward when N is even. For [1.0, 2.0]
    // this returned 2.0 instead of 1.5 (true median). Per-asset risk
    // weights then under-allocated to low-ATR assets and over-allocated
    // to high-ATR assets — opposite of risk-parity intent.
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn weight_clamps() {
        assert!((inverse_atr_weight(1.0, 1.0, 0.5, 1.5) - 1.0).abs() < 1e-9);
        assert_eq!(inverse_atr_weight(0.1, 1.0, 0.5, 1.5), 1.5);
        assert_eq!(inverse_atr_weight(10.0, 1.0, 0.5, 1.5), 0.5);
    }
    #[test] fn median_works() {
        assert_eq!(median(&[1.0, 3.0, 2.0]), 2.0);
        assert_eq!(median(&[]), 1.0);
    }
}
