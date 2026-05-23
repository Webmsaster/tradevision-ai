//! 2026-05-17 ARIMA(1,1,1) short-term price forecast filter.
//! Skeleton — Yule-Walker fit + 4-bar forecast. Vote-veto if forecast against trade.
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct ArimaParams { pub window: usize, pub horizon: usize }
impl Default for ArimaParams {
    fn default() -> Self { Self { window: 100, horizon: 4 } }
}

pub fn compute_arima_vote(candles: &[Candle], p: &ArimaParams) -> Option<PositionSide> {
    if p.window < 30 || candles.len() < p.window + 3 { return None; }
    let i = candles.len() - 2;
    if i < p.window { return None; }
    let lo = i + 1 - p.window;
    let closes: Vec<f64> = (lo..=i).map(|j| candles[j].close).filter(|c| c.is_finite()).collect();
    if closes.len() != p.window { return None; }
    // First-diff
    let diff: Vec<f64> = closes.windows(2).map(|w| w[1] - w[0]).collect();
    // Simple AR(1) fit via Yule-Walker
    let mean_d = diff.iter().sum::<f64>() / diff.len() as f64;
    let c: Vec<f64> = diff.iter().map(|d| d - mean_d).collect();
    let r0: f64 = c.iter().map(|x| x*x).sum::<f64>() / c.len() as f64;
    if r0 <= 0.0 { return None; }
    let r1: f64 = c.windows(2).map(|w| w[0]*w[1]).sum::<f64>() / (c.len() as f64 - 1.0);
    let phi = r1 / r0;
    // 2026-05-24 Wave2 MED FIX (Agent 5): r0 > 0 was guarded above, but with
    // r0 near-machine-epsilon and r1 large (degenerate diff series), `phi`
    // could be +/-Inf. The forecast loop then propagates Inf through
    // `forecast_price += d + mean_d`, and the final `> close_now * 1.001`
    // returns true on +Inf → silent Long vote on garbage input. Similar
    // last_diff NaN concern from agent — guard both.
    if !phi.is_finite() { return None; }
    // Forecast h bars ahead
    let last_diff = diff[diff.len() - 1];
    if !last_diff.is_finite() { return None; }
    let mut forecast_price = closes[closes.len() - 1];
    let mut d = last_diff;
    for _ in 0..p.horizon {
        d = phi * d;
        forecast_price += d + mean_d;
    }
    if !forecast_price.is_finite() { return None; }
    let close_now = closes[closes.len() - 1];
    if forecast_price > close_now * 1.001 { Some(PositionSide::Long) }
    else if forecast_price < close_now * 0.999 { Some(PositionSide::Short) }
    else { None }
}
