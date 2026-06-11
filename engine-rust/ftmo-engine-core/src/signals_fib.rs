//! 2026-05-17 Fibonacci Retracement zone entry filter.
//! Trade only when price is in 38.2-61.8% pullback from recent swing.
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct FibParams {
    pub swing_lookback: usize,
    pub zone_min: f64,
    pub zone_max: f64,
}
impl Default for FibParams {
    fn default() -> Self {
        Self {
            swing_lookback: 50,
            zone_min: 0.382,
            zone_max: 0.618,
        }
    }
}

pub fn compute_fib_vote(candles: &[Candle], p: &FibParams) -> Option<PositionSide> {
    if candles.len() < p.swing_lookback + 3 {
        return None;
    }
    let i = candles.len() - 2;
    if i < p.swing_lookback {
        return None;
    }
    let lo = i + 1 - p.swing_lookback;
    let highs: Vec<f64> = (lo..=i)
        .map(|j| candles[j].high)
        .filter(|h| h.is_finite())
        .collect();
    let lows: Vec<f64> = (lo..=i)
        .map(|j| candles[j].low)
        .filter(|l| l.is_finite())
        .collect();
    let swing_high = highs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let swing_low = lows.iter().cloned().fold(f64::INFINITY, f64::min);
    if !swing_high.is_finite() || !swing_low.is_finite() {
        return None;
    }
    let range = swing_high - swing_low;
    if range <= 0.0 {
        return None;
    }
    let close = candles[i].close;
    let from_low = (close - swing_low) / range;
    // Long-pullback: price retraced down to 38.2-61.8% from swing_low (uptrend pullback)
    // Trend direction: compare swing_high index vs swing_low index
    let high_idx = (lo..=i)
        .max_by(|a, b| {
            candles[*a]
                .high
                .partial_cmp(&candles[*b].high)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(i);
    let low_idx = (lo..=i)
        .min_by(|a, b| {
            candles[*a]
                .low
                .partial_cmp(&candles[*b].low)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(i);
    let uptrend = high_idx > low_idx;
    if uptrend && from_low >= p.zone_min && from_low <= p.zone_max {
        Some(PositionSide::Long) // buying the pullback
    } else if !uptrend && from_low >= (1.0 - p.zone_max) && from_low <= (1.0 - p.zone_min) {
        Some(PositionSide::Short) // selling the bounce
    } else {
        None
    }
}
