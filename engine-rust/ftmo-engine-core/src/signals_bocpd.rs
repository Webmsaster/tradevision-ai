//! 2026-05-17 BOCPD — Bayesian Online Changepoint Detection.
//! Veto entry within N bars of detected regime-change.
use crate::candle::Candle;

#[derive(Debug, Clone, Copy)]
pub struct BocpdParams {
    pub hazard: f64,
    pub block_bars: usize,
    pub window: usize,
}
impl Default for BocpdParams {
    fn default() -> Self {
        Self {
            hazard: 1.0 / 250.0,
            block_bars: 5,
            window: 50,
        }
    }
}

pub fn allow_entry(candles: &[Candle], p: &BocpdParams) -> bool {
    if candles.len() < p.window + 3 {
        return true;
    }
    let i = candles.len() - 2;
    if i < p.window + p.block_bars {
        return true;
    }
    // Simplified BOCPD via change-of-mean detection
    // Compare last `block_bars` mean vs prior `window` mean
    let recent: Vec<f64> = (i.saturating_sub(p.block_bars) + 1..=i)
        .map(|j| candles[j].close)
        .filter(|c| c.is_finite())
        .collect();
    let prior: Vec<f64> = (i.saturating_sub(p.window + p.block_bars) + 1..=i - p.block_bars)
        .map(|j| candles[j].close)
        .filter(|c| c.is_finite())
        .collect();
    if recent.is_empty() || prior.len() < 20 {
        return true;
    }
    let mean_r = recent.iter().sum::<f64>() / recent.len() as f64;
    let mean_p = prior.iter().sum::<f64>() / prior.len() as f64;
    let std_p =
        (prior.iter().map(|x| (x - mean_p).powi(2)).sum::<f64>() / prior.len() as f64).sqrt();
    if std_p <= 0.0 {
        return true;
    }
    let z = (mean_r - mean_p).abs() / std_p;
    // If recent mean has drifted > 2σ, regime-change detected → veto
    z < 2.0
}
