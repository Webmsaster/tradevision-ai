//! 2026-05-17 Ichimoku Kinko Hyo Cloud-Direction Voter.
//! Long if close > max(Senkou_A, Senkou_B) AND Tenkan > Kijun.
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct IchimokuParams {
    pub tenkan: usize,
    pub kijun: usize,
    pub senkou_b: usize,
}
impl Default for IchimokuParams {
    fn default() -> Self {
        Self {
            tenkan: 9,
            kijun: 26,
            senkou_b: 52,
        }
    }
}

fn mid_range(candles: &[Candle], end: usize, period: usize) -> Option<f64> {
    if end + 1 < period {
        return None;
    }
    let lo = end + 1 - period;
    let mut hi = f64::NEG_INFINITY;
    let mut lw = f64::INFINITY;
    for j in lo..=end {
        let c = candles[j];
        if !c.high.is_finite() || !c.low.is_finite() {
            return None;
        }
        if c.high > hi {
            hi = c.high;
        }
        if c.low < lw {
            lw = c.low;
        }
    }
    if !hi.is_finite() || !lw.is_finite() {
        return None;
    }
    Some((hi + lw) / 2.0)
}

pub fn compute_ichimoku_vote(candles: &[Candle], p: &IchimokuParams) -> Option<PositionSide> {
    let needed = p.senkou_b * 2 + 3;
    if candles.len() < needed {
        return None;
    }
    let i = candles.len() - 2;
    if i < p.senkou_b + p.kijun {
        return None;
    }
    let tenkan = mid_range(candles, i, p.tenkan)?;
    let kijun = mid_range(candles, i, p.kijun)?;
    // Senkou A and B at signal_idx (displaced back 26 bars from current)
    let senkou_idx = i.saturating_sub(p.kijun);
    let s_a = (mid_range(candles, senkou_idx, p.tenkan)?
        + mid_range(candles, senkou_idx, p.kijun)?)
        / 2.0;
    let s_b = mid_range(candles, senkou_idx, p.senkou_b)?;
    let close = candles[i].close;
    let cloud_top = s_a.max(s_b);
    let cloud_bot = s_a.min(s_b);
    if close > cloud_top && tenkan > kijun {
        Some(PositionSide::Long)
    } else if close < cloud_bot && tenkan < kijun {
        Some(PositionSide::Short)
    } else {
        None
    }
}
