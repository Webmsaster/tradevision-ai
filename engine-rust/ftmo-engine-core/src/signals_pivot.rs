//! 2026-05-17 Camarilla Pivot Points (daily mean-revert at L3/H3).
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct PivotParams {
    pub session_bars: usize,
}
impl Default for PivotParams {
    fn default() -> Self {
        Self { session_bars: 12 }
    } // 12 × 2h = 24h
}

pub fn compute_pivot_vote(candles: &[Candle], p: &PivotParams) -> Option<PositionSide> {
    // Need at least 2× session_bars + 2 lookback (yesterday + today bars
    // before the signal bar) + the signal bar itself + the entry bar.
    if candles.len() < p.session_bars * 2 + 3 {
        return None;
    }
    // 2026-05-24 Codex audit HIGH FIX: my Wave1 fix (changing comparison
    // from `c_y` to `candles[len-1].close`) introduced LOOKAHEAD — it read
    // the entry-bar close (the bar the engine would trade on, not yet
    // tradeable). Codex re-flagged it.
    //
    // Correct Camarilla without lookahead:
    //   signal_idx       = candles.len() - 2          (the just-closed bar)
    //   yesterday range  = [signal_idx - 2*N + 1, signal_idx - N]
    //   yesterday H/L/C  = max/min/last over that range (NOT including today)
    //   current price    = candles[signal_idx].close (signal bar — already closed)
    //
    // That guarantees: pivot levels derived from a DIFFERENT bar than the
    // comparison price, no entry-bar read.
    let signal_idx = candles.len() - 2;
    let n = p.session_bars;
    if signal_idx < 2 * n {
        return None;
    }
    let y_lo = signal_idx + 1 - 2 * n;
    let y_hi = signal_idx - n; // inclusive
    let prev_session = &candles[y_lo..=y_hi];
    let h_y = prev_session
        .iter()
        .map(|c| c.high)
        .filter(|h| h.is_finite())
        .fold(f64::NEG_INFINITY, f64::max);
    let l_y = prev_session
        .iter()
        .map(|c| c.low)
        .filter(|l| l.is_finite())
        .fold(f64::INFINITY, f64::min);
    let c_y = candles[y_hi].close;
    let current_close = candles[signal_idx].close;
    if !h_y.is_finite() || !l_y.is_finite() || !c_y.is_finite() || !current_close.is_finite() {
        return None;
    }
    let range = h_y - l_y;
    if range <= 0.0 {
        return None;
    }
    let h3 = c_y + range * 1.1 / 4.0;
    let l3 = c_y - range * 1.1 / 4.0;
    let h4 = c_y + range * 1.1 / 2.0;
    let l4 = c_y - range * 1.1 / 2.0;
    // Breakout zones (extreme) MUST be checked before mean-revert zones,
    // since H4 > H3 — otherwise `current > h3` short-circuits the breakout
    // branch and the breakout signal is unreachable.
    if current_close > h4 {
        Some(PositionSide::Long)
    }
    // breakout up
    else if current_close < l4 {
        Some(PositionSide::Short)
    }
    // breakout down
    else if current_close < l3 {
        Some(PositionSide::Long)
    }
    // mean-revert from below L3
    else if current_close > h3 {
        Some(PositionSide::Short)
    }
    // mean-revert from above H3
    else {
        None
    }
}
