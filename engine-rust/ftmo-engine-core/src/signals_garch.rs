//! 2026-05-17 GARCH(1,1) volatility forecast filter.
//! Block entry if predicted vol > 2σ above rolling mean.
use crate::candle::Candle;

#[derive(Debug, Clone, Copy)]
pub struct GarchParams { pub omega: f64, pub alpha: f64, pub beta: f64, pub window: usize, pub z_max: f64 }
impl Default for GarchParams {
    fn default() -> Self { Self { omega: 1e-6, alpha: 0.08, beta: 0.90, window: 100, z_max: 2.0 } }
}

pub fn allow_entry(candles: &[Candle], p: &GarchParams) -> bool {
    if candles.len() < p.window + 3 { return true; }
    let i = candles.len() - 2;
    if i < p.window { return true; }
    let lo = i + 1 - p.window;
    let returns: Vec<f64> = (lo+1..=i).filter_map(|j| {
        let a = candles[j-1].close; let b = candles[j].close;
        if a > 0.0 && b > 0.0 { Some((b/a).ln()) } else { None }
    }).collect();
    if returns.len() < 30 { return true; }
    // Streaming GARCH(1,1)
    let mut sigma2 = returns.iter().map(|r| r*r).sum::<f64>() / returns.len() as f64;
    for r in &returns {
        sigma2 = p.omega + p.alpha * r * r + p.beta * sigma2;
        if !sigma2.is_finite() { return true; }
    }
    let forecast_sigma = sigma2.sqrt();
    // Compare to rolling-mean sigma
    let mean_sigma = (returns.iter().map(|r| r*r).sum::<f64>() / returns.len() as f64).sqrt();
    if mean_sigma <= 0.0 { return true; }
    let z = (forecast_sigma - mean_sigma) / mean_sigma;
    z < p.z_max
}
