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
    // 2026-05-24 Wave2 KRIT FIX: prior code compared `c_y` (prev session
    // close) against pivot levels also derived from `c_y` — so e.g. `c_y < l3`
    // becomes `c_y < c_y - range × 0.275`, mathematically impossible when
    // `range > 0` (already guarded). The voter NEVER fired, silently dropping
    // a configured signal source from `signals_regime_confluence`.
    // Correct Camarilla math: levels from PREVIOUS session H/L/C, comparison
    // against CURRENT price (most recent close on the just-finished bar).
    let i = candles.len() - 2;
    if i < p.session_bars { return None; }
    // Previous session's high/low/close
    let lo = i + 1 - p.session_bars;
    let prev_session: Vec<&Candle> = candles[lo..=i].iter().collect();
    let h_y = prev_session.iter().map(|c| c.high).filter(|h| h.is_finite()).fold(f64::NEG_INFINITY, f64::max);
    let l_y = prev_session.iter().map(|c| c.low).filter(|l| l.is_finite()).fold(f64::INFINITY, f64::min);
    let c_y = candles[i].close;
    if !h_y.is_finite() || !l_y.is_finite() || !c_y.is_finite() { return None; }
    let current_close = candles[candles.len() - 1].close;
    if !current_close.is_finite() { return None; }
    let range = h_y - l_y;
    if range <= 0.0 { return None; }
    let h3 = c_y + range * 1.1 / 4.0;
    let l3 = c_y - range * 1.1 / 4.0;
    let h4 = c_y + range * 1.1 / 2.0;
    let l4 = c_y - range * 1.1 / 2.0;
    // Breakout zones (extreme) MUST be checked before mean-revert zones,
    // since H4 > H3 — otherwise `current > h3` short-circuits the breakout
    // branch and the breakout signal is unreachable.
    if current_close > h4 { Some(PositionSide::Long) }       // breakout up
    else if current_close < l4 { Some(PositionSide::Short) } // breakout down
    else if current_close < l3 { Some(PositionSide::Long) }  // mean-revert from below L3
    else if current_close > h3 { Some(PositionSide::Short) } // mean-revert from above H3
    else { None }
}
