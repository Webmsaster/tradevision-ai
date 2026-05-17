//! 2026-05-17 Hurst Exponent regime classifier (R/S analysis).
//! H > 0.55 = trending → vote on direction. H < 0.45 = mean-reverting → abstain.
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct HurstParams { pub window: usize, pub h_min: f64, pub slope_lookback: usize }
impl Default for HurstParams {
    fn default() -> Self { Self { window: 100, h_min: 0.55, slope_lookback: 5 } }
}

fn rs_hurst(returns: &[f64]) -> f64 {
    if returns.len() < 10 { return f64::NAN; }
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let dev: Vec<f64> = returns.iter().map(|r| r - mean).collect();
    let mut cum = vec![0.0; dev.len()];
    let mut s = 0.0;
    for i in 0..dev.len() { s += dev[i]; cum[i] = s; }
    let r_range = cum.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
                - cum.iter().cloned().fold(f64::INFINITY, f64::min);
    let std = (dev.iter().map(|d| d.powi(2)).sum::<f64>() / dev.len() as f64).sqrt();
    if std <= 0.0 || r_range <= 0.0 { return f64::NAN; }
    let n = returns.len() as f64;
    (r_range / std).ln() / n.ln()
}

pub fn compute_hurst_vote(candles: &[Candle], p: &HurstParams) -> Option<PositionSide> {
    if p.window < 20 || candles.len() < p.window + p.slope_lookback + 3 { return None; }
    let i = candles.len() - 2;
    if i < p.window + p.slope_lookback { return None; }
    let lo = i + 1 - p.window;
    let returns: Vec<f64> = (lo+1..=i).filter_map(|j| {
        let a = candles[j-1].close; let b = candles[j].close;
        if a.is_finite() && b.is_finite() && a > 0.0 { Some((b/a).ln()) } else { None }
    }).collect();
    if returns.len() < p.window - 5 { return None; }
    let h = rs_hurst(&returns);
    if !h.is_finite() || h < p.h_min { return None; }
    // Trending — vote in slope direction
    let close_now = candles[i].close;
    let close_back = candles[i - p.slope_lookback].close;
    if close_now > close_back { Some(PositionSide::Long) }
    else if close_now < close_back { Some(PositionSide::Short) }
    else { None }
}
