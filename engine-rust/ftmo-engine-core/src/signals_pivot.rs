//! 2026-05-17 Camarilla Pivot Points (daily mean-revert at L3/H3).
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct PivotParams { pub session_bars: usize }
impl Default for PivotParams {
    fn default() -> Self { Self { session_bars: 12 } } // 12 × 2h = 24h
}

pub fn compute_pivot_vote(candles: &[Candle], p: &PivotParams) -> Option<PositionSide> {
    if candles.len() < p.session_bars * 2 + 3 { return None; }
    let i = candles.len() - 2;
    if i < p.session_bars { return None; }
    // Previous session's high/low/close
    let lo = i + 1 - p.session_bars;
    let prev_session: Vec<&Candle> = candles[lo..=i].iter().collect();
    let h_y = prev_session.iter().map(|c| c.high).filter(|h| h.is_finite()).fold(f64::NEG_INFINITY, f64::max);
    let l_y = prev_session.iter().map(|c| c.low).filter(|l| l.is_finite()).fold(f64::INFINITY, f64::min);
    let c_y = candles[i].close;
    if !h_y.is_finite() || !l_y.is_finite() || !c_y.is_finite() { return None; }
    let range = h_y - l_y;
    if range <= 0.0 { return None; }
    let h3 = c_y + range * 1.1 / 4.0;
    let l3 = c_y - range * 1.1 / 4.0;
    let h4 = c_y + range * 1.1 / 2.0;
    let l4 = c_y - range * 1.1 / 2.0;
    // L3 → Long (mean-revert), H3 → Short. Breakout L4/H4 mirror.
    if c_y < l3 { Some(PositionSide::Long) }
    else if c_y > h3 { Some(PositionSide::Short) }
    else if c_y > h4 { Some(PositionSide::Long) } // breakout
    else if c_y < l4 { Some(PositionSide::Short) }
    else { None }
}
