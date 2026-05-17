//! 2026-05-17 TTM Squeeze Momentum (Bollinger Bands inside Keltner Channels).
//! Lookahead-safe at signal_idx = candles.len() - 2.
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct SqueezeParams { pub period: usize, pub bb_mult: f64, pub kc_mult: f64 }
impl Default for SqueezeParams {
    fn default() -> Self { Self { period: 20, bb_mult: 2.0, kc_mult: 1.5 } }
}

pub fn compute_squeeze_vote(candles: &[Candle], p: &SqueezeParams) -> Option<PositionSide> {
    if p.period < 2 || candles.len() < p.period + 4 { return None; }
    let i = candles.len() - 2;
    if i < p.period + 2 { return None; }
    let lo = i + 1 - p.period;
    let closes: Vec<f64> = (lo..=i).map(|j| candles[j].close).filter(|c| c.is_finite()).collect();
    if closes.len() < p.period { return None; }
    let mean = closes.iter().sum::<f64>() / closes.len() as f64;
    let var = closes.iter().map(|c| (c - mean).powi(2)).sum::<f64>() / closes.len() as f64;
    let std = var.sqrt();
    if !std.is_finite() || std <= 0.0 { return None; }
    let bb_upper = mean + p.bb_mult * std;
    let bb_lower = mean - p.bb_mult * std;
    // ATR-like range
    let trs: Vec<f64> = (lo..=i).filter_map(|j| {
        let c = candles[j];
        if !c.high.is_finite() || !c.low.is_finite() { None } else { Some(c.high - c.low) }
    }).collect();
    if trs.is_empty() { return None; }
    let atr = trs.iter().sum::<f64>() / trs.len() as f64;
    let kc_upper = mean + p.kc_mult * atr;
    let kc_lower = mean - p.kc_mult * atr;
    // In-squeeze if BB inside KC; release = BB breakout
    let in_squeeze = bb_upper < kc_upper && bb_lower > kc_lower;
    if in_squeeze { return None; } // hold, no vote during squeeze
    let close_now = candles[i].close;
    if close_now > kc_upper { Some(PositionSide::Long) }
    else if close_now < kc_lower { Some(PositionSide::Short) }
    else { None }
}
