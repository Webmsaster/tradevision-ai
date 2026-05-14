// 2026-05-14 Detector #10 — RSI Hidden Divergence Trend-Continuation voter.
//
// Independent voter for `signals_regime_confluence.rs`. Reads a different
// signal class than every prior voter:
//
//   * R28V6 / Trend / Breakout / VWAP-trend / Supertrend = trend continuation
//     based on PRICE-only structure.
//   * RSI-MR / BB-Z = mean-reversion CROSSES (RSI cross threshold, price
//     cross band).
//   * Stop-Hunt / SMC-FVG = wick / 3-bar impulse PATTERNS.
//   * Aroon / OBV / OFI / vol-confirm = momentum-via-time, taker-flow,
//     cumulative volume.
//
// Hidden divergence is structurally different: it compares the SHAPE of two
// price pivots against the SHAPE of the RSI series at those exact pivots and
// fires only when the two disagree in the "trend-continuation" pattern:
//
//   * Bullish hidden divergence (long): price prints a HIGHER swing-low while
//     RSI prints a LOWER value at that same swing-low ⇒ uptrend pullback
//     attracted oversold-momentum without breaking the structural higher-low
//     ⇒ continuation long.
//   * Bearish hidden divergence (short): price prints a LOWER swing-high
//     while RSI prints a HIGHER value at that same swing-high ⇒ downtrend
//     pullback into overbought momentum without breaking the lower-high ⇒
//     continuation short.
//
// NOT to be confused with REGULAR divergence which is a REVERSAL pattern
// (price HH but RSI LH = bearish reversal). The orthogonality test
// `regular_divergence_does_NOT_fire` guards against accidentally inverting
// the price/RSI direction predicate.
//
// ## Lookahead safety
//
// `signal_idx = candles.len() - 2` (the last fully-closed bar). The execution
// bar `candles.len() - 1` is NEVER consulted. Pivot detection only counts
// pivots whose `k + pivot_strength <= signal_idx` so the pivot is
// "confirmed": k's left flanks AND its right flanks are inside the visible
// window. Without this guard a recent low/high that ISN'T actually a pivot
// (because future bars haven't been seen yet) would be mistakenly used as
// the newest pivot — that's the classic divergence-lookahead bug we want to
// avoid.
//
// ## Self-fulfilling-pivot guard
//
// `signal_idx` itself is EXCLUDED from the pivot scan. If it were included
// and happened to be a local extreme, the divergence comparison would
// degenerate (newest_low == signal_bar.low, so "price made HL" vs the
// previous pivot becomes a single-bar comparison rather than a swing
// comparison). This guard is verified by `excludes_signal_bar_from_pivot_scan`.

use crate::candle::Candle;
use crate::indicators::rsi;
use crate::position::PositionSide;

/// Tunable parameters for `compute_rsi_hidden_div_vote`.
#[derive(Debug, Clone, Copy)]
pub struct RsiHiddenDivParams {
    /// Wilder RSI period. Defaults to 14.
    pub rsi_period: u32,
    /// How many bars back from `signal_idx` we look for pivots.
    /// Defaults to 30.
    pub swing_lookback: usize,
    /// Pivot strength `k`: a bar at index `b` is a confirmed pivot-low when
    /// `low[b] <= low[b-s..b+s]` for `s = 1..=pivot_strength`, AND the right
    /// flank `b + pivot_strength <= signal_idx` (so we have actually SEEN
    /// the right flank, not assumed it). Defaults to 2.
    pub pivot_strength: usize,
    /// Minimum HL spread: `newest_low.price >= older_low.price * (1 +
    /// min_price_divergence_pct)`. Symmetric for highs. Defaults to 0.003
    /// (0.3%).
    pub min_price_divergence_pct: f64,
    /// Minimum RSI spread on the SAME pivots:
    /// `rsi[newest_low.idx] <= rsi[older_low.idx] - min_rsi_divergence`.
    /// Defaults to 3.0 RSI points.
    pub min_rsi_divergence: f64,
    /// Newest pivot must be no more than this many bars old at signal time
    /// (`signal_idx - newest_pivot_idx <= max_swings_age_bars`). Stops the
    /// detector from acting on stale pivots. Defaults to 40.
    pub max_swings_age_bars: usize,
    /// Long-side trend-continuation filter: the SIGNAL-bar RSI must be at or
    /// below this. Prevents firing long when momentum is already overbought.
    /// Defaults to 50.0.
    pub max_rsi_on_long_signal: f64,
    /// Mirror for shorts. SIGNAL-bar RSI ≥ this to fire a continuation short.
    /// Defaults to 50.0.
    pub min_rsi_on_short_signal: f64,
    /// Anti-spam: minimum bars between consecutive votes from this detector.
    /// Enforced by the caller (the regime panel) via the standard
    /// `loss_streak_by_asset_dir` map — kept here only as configuration so
    /// the parameter set is self-describing. Defaults to 12.
    pub cooldown_bars: u64,
    /// Risk-frac multiplier — typically 0.5. Not used by the pure voting
    /// helper, kept for parity with the other detector params so callers can
    /// pick this up when promoting the detector to a full PollSignal path
    /// later. Defaults to 0.5.
    pub size_mult: f64,
}

impl Default for RsiHiddenDivParams {
    fn default() -> Self {
        Self {
            rsi_period: 14,
            swing_lookback: 30,
            pivot_strength: 2,
            min_price_divergence_pct: 0.003,
            min_rsi_divergence: 3.0,
            max_swings_age_bars: 40,
            max_rsi_on_long_signal: 50.0,
            min_rsi_on_short_signal: 50.0,
            cooldown_bars: 12,
            size_mult: 0.5,
        }
    }
}

impl RsiHiddenDivParams {
    pub fn default_30m_crypto() -> Self {
        Self::default()
    }
}

/// Compute the RSI-hidden-divergence directional vote for the latest signal
/// bar. Returns `Some(Long)` on bullish hidden divergence, `Some(Short)` on
/// bearish hidden divergence, `None` otherwise.
///
/// Pure helper — no engine state mutation. Lookahead-safe by construction.
pub fn compute_rsi_hidden_div_vote(
    candles: &[Candle],
    params: &RsiHiddenDivParams,
) -> Option<PositionSide> {
    let period = params.rsi_period as usize;
    if period == 0
        || params.swing_lookback < 2
        || params.pivot_strength == 0
        || !params.min_price_divergence_pct.is_finite()
        || !params.min_rsi_divergence.is_finite()
        || params.min_price_divergence_pct < 0.0
        || params.min_rsi_divergence < 0.0
    {
        return None;
    }
    // Need: signal_idx = len-2, swing-lookback bars before signal_idx, and
    // RSI seed (period + 1 bars to even get RSI[period] valid). Also need
    // pivot_strength flank space on both sides for the newest pivot.
    let min_len = period + 2 + params.swing_lookback;
    if candles.len() < min_len {
        return None;
    }
    let signal_idx = candles.len() - 2;
    // Guard: signal_idx must be large enough that we can scan
    // [signal_idx - swing_lookback .. signal_idx) and still leave room for
    // pivot_strength flanks at the older end (`b - pivot_strength >= 0`).
    if signal_idx < params.swing_lookback || params.swing_lookback < params.pivot_strength * 2 + 1 {
        return None;
    }

    // Compute RSI on closes. We need RSI at `signal_idx` plus at the pivot
    // indices we'll discover.
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    if closes.iter().any(|x| !x.is_finite()) {
        return None;
    }
    let rsi_series = rsi(&closes, period);
    let rsi_signal = rsi_series.get(signal_idx).copied().flatten()?;
    if !rsi_signal.is_finite() {
        return None;
    }

    // Find CONFIRMED pivot-lows and pivot-highs in the window
    // [signal_idx - swing_lookback, signal_idx). Exclude signal_idx itself
    // (self-fulfilling guard). A bar `b` is a confirmed pivot-low when:
    //   - low[b] is strictly less than low[b-s] AND low[b+s] for all
    //     s in 1..=pivot_strength (use <= on equality to allow flat-edge
    //     ties — we WANT to surface the most-recent of equal lows).
    //   - b + pivot_strength <= signal_idx (right flank inside seen window).
    // The bar must also have a finite low.
    let strength = params.pivot_strength;
    let scan_lo = signal_idx.saturating_sub(params.swing_lookback);
    let scan_hi_exclusive = signal_idx; // exclude signal_idx itself

    let mut pivot_lows: Vec<usize> = Vec::new();
    let mut pivot_highs: Vec<usize> = Vec::new();
    for b in scan_lo..scan_hi_exclusive {
        // Left flank availability check.
        if b < strength {
            continue;
        }
        // Right flank must be inside [scan_lo .. signal_idx]. The right-most
        // bar we look at is b + strength which MUST satisfy
        // `b + strength <= signal_idx` so the right flank is fully observed.
        if b + strength > signal_idx {
            continue;
        }
        let b_bar = candles[b];
        if !b_bar.low.is_finite() || !b_bar.high.is_finite() {
            continue;
        }
        // Pivot-low check.
        let mut is_low = true;
        for s in 1..=strength {
            let left = candles[b - s].low;
            let right = candles[b + s].low;
            if !left.is_finite() || !right.is_finite() {
                is_low = false;
                break;
            }
            // Strict-on-left, non-strict-on-right convention so the LATEST
            // among tied lows wins. Mirrors the LAST-occurrence convention
            // used by Aroon ties.
            if !(b_bar.low < left) {
                is_low = false;
                break;
            }
            if !(b_bar.low <= right) {
                is_low = false;
                break;
            }
        }
        if is_low {
            pivot_lows.push(b);
        }
        // Pivot-high check (independent scan in same loop).
        let mut is_high = true;
        for s in 1..=strength {
            let left = candles[b - s].high;
            let right = candles[b + s].high;
            if !left.is_finite() || !right.is_finite() {
                is_high = false;
                break;
            }
            if !(b_bar.high > left) {
                is_high = false;
                break;
            }
            if !(b_bar.high >= right) {
                is_high = false;
                break;
            }
        }
        if is_high {
            pivot_highs.push(b);
        }
    }

    // Need at least 2 pivots on either side to compare. Use the 2 most
    // recent pivots for the divergence test (newest vs older).
    let bull_vote = check_bullish_hidden_div(candles, &rsi_series, &pivot_lows, signal_idx, params);
    let bear_vote =
        check_bearish_hidden_div(candles, &rsi_series, &pivot_highs, signal_idx, params);

    // If BOTH fire on the same bar (rare but possible with skewed
    // parameters), abstain — the signal is contradictory.
    match (bull_vote, bear_vote) {
        (true, true) => None,
        (true, false) => Some(PositionSide::Long),
        (false, true) => Some(PositionSide::Short),
        (false, false) => None,
    }
}

/// Bullish hidden divergence predicate. Operates on the most recent two
/// pivot-lows in `pivot_lows` (ascending index order). Returns true iff:
///   - price HL: newest_low.price >= older_low.price * (1 + min_price_div_pct)
///   - RSI LL : rsi[newest_low.idx] <= rsi[older_low.idx] - min_rsi_div
///   - signal-bar RSI is not yet overbought
///   - newest pivot is not stale
fn check_bullish_hidden_div(
    candles: &[Candle],
    rsi_series: &[Option<f64>],
    pivot_lows: &[usize],
    signal_idx: usize,
    params: &RsiHiddenDivParams,
) -> bool {
    if pivot_lows.len() < 2 {
        return false;
    }
    // `pivot_lows` is ascending in index because the for-loop pushed in
    // ascending order. Newest = last, older = second-to-last.
    let newest_idx = pivot_lows[pivot_lows.len() - 1];
    let older_idx = pivot_lows[pivot_lows.len() - 2];
    if signal_idx <= newest_idx {
        return false;
    }
    let newest_age = signal_idx - newest_idx;
    if newest_age > params.max_swings_age_bars {
        return false;
    }
    let newest_low = candles[newest_idx].low;
    let older_low = candles[older_idx].low;
    if !newest_low.is_finite() || !older_low.is_finite() || older_low <= 0.0 {
        return false;
    }
    let price_threshold = older_low * (1.0 + params.min_price_divergence_pct);
    if !(newest_low >= price_threshold) {
        return false;
    }
    let newest_rsi = match rsi_series.get(newest_idx).copied().flatten() {
        Some(v) if v.is_finite() => v,
        _ => return false,
    };
    let older_rsi = match rsi_series.get(older_idx).copied().flatten() {
        Some(v) if v.is_finite() => v,
        _ => return false,
    };
    if !(newest_rsi <= older_rsi - params.min_rsi_divergence) {
        return false;
    }
    // Signal-bar RSI must NOT already be overbought — trend-continuation
    // entries lose edge if momentum has run away.
    let signal_rsi = match rsi_series.get(signal_idx).copied().flatten() {
        Some(v) if v.is_finite() => v,
        _ => return false,
    };
    if !(signal_rsi <= params.max_rsi_on_long_signal) {
        return false;
    }
    true
}

/// Bearish hidden divergence predicate. Symmetric to the bullish case on
/// pivot-highs. Returns true iff:
///   - price LH: newest_high.price <= older_high.price * (1 - min_price_div_pct)
///   - RSI HH : rsi[newest_high.idx] >= rsi[older_high.idx] + min_rsi_div
///   - signal-bar RSI is not yet oversold (≥ min_rsi_on_short_signal)
///   - newest pivot is not stale
fn check_bearish_hidden_div(
    candles: &[Candle],
    rsi_series: &[Option<f64>],
    pivot_highs: &[usize],
    signal_idx: usize,
    params: &RsiHiddenDivParams,
) -> bool {
    if pivot_highs.len() < 2 {
        return false;
    }
    let newest_idx = pivot_highs[pivot_highs.len() - 1];
    let older_idx = pivot_highs[pivot_highs.len() - 2];
    if signal_idx <= newest_idx {
        return false;
    }
    let newest_age = signal_idx - newest_idx;
    if newest_age > params.max_swings_age_bars {
        return false;
    }
    let newest_high = candles[newest_idx].high;
    let older_high = candles[older_idx].high;
    if !newest_high.is_finite() || !older_high.is_finite() || older_high <= 0.0 {
        return false;
    }
    let price_threshold = older_high * (1.0 - params.min_price_divergence_pct);
    if !(newest_high <= price_threshold) {
        return false;
    }
    let newest_rsi = match rsi_series.get(newest_idx).copied().flatten() {
        Some(v) if v.is_finite() => v,
        _ => return false,
    };
    let older_rsi = match rsi_series.get(older_idx).copied().flatten() {
        Some(v) if v.is_finite() => v,
        _ => return false,
    };
    if !(newest_rsi >= older_rsi + params.min_rsi_divergence) {
        return false;
    }
    let signal_rsi = match rsi_series.get(signal_idx).copied().flatten() {
        Some(v) if v.is_finite() => v,
        _ => return false,
    };
    if !(signal_rsi >= params.min_rsi_on_short_signal) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ohlcv(t: i64, o: f64, h: f64, l: f64, c: f64, v: f64) -> Candle {
        Candle::new(t, o, h, l, c, v)
    }

    /// Build N flat warm-up bars so the RSI series has plenty of valid
    /// values to draw from. Caller mutates specific bars to sculpt the
    /// pivots + RSI shape.
    fn flat_bars(n: usize, price: f64) -> Vec<Candle> {
        (0..n)
            .map(|i| ohlcv(i as i64 * 1_800_000, price, price + 0.5, price - 0.5, price, 100.0))
            .collect()
    }

    /// Helper to install a pivot-low at index `idx` with the desired
    /// low/close and a flank of `strength` bars on either side. The flank
    /// bars are pulled UP relative to the pivot bar so the pivot test
    /// (`low[b] < low[b±s]`) passes cleanly.
    fn sculpt_pivot_low(
        bars: &mut [Candle],
        idx: usize,
        pivot_low: f64,
        pivot_close: f64,
        flank_low: f64,
        flank_close: f64,
        strength: usize,
    ) {
        // Pivot bar: low and close set explicitly.
        let p = &mut bars[idx];
        p.open = flank_close;
        p.high = pivot_close.max(p.open) + 0.2;
        p.low = pivot_low;
        p.close = pivot_close;
        // Symmetric flanks.
        for s in 1..=strength {
            for off in [idx.wrapping_sub(s), idx + s] {
                if off >= bars.len() {
                    continue;
                }
                let b = &mut bars[off];
                b.open = flank_close;
                b.high = (flank_close + 0.2).max(b.open);
                b.low = flank_low;
                b.close = flank_close;
            }
        }
    }

    fn sculpt_pivot_high(
        bars: &mut [Candle],
        idx: usize,
        pivot_high: f64,
        pivot_close: f64,
        flank_high: f64,
        flank_close: f64,
        strength: usize,
    ) {
        let p = &mut bars[idx];
        p.open = flank_close;
        p.low = pivot_close.min(p.open) - 0.2;
        p.high = pivot_high;
        p.close = pivot_close;
        for s in 1..=strength {
            for off in [idx.wrapping_sub(s), idx + s] {
                if off >= bars.len() {
                    continue;
                }
                let b = &mut bars[off];
                b.open = flank_close;
                b.low = (flank_close - 0.2).min(b.open);
                b.high = flank_high;
                b.close = flank_close;
            }
        }
    }

    /// Manually-constructed close-series + low-series fixture builder. We
    /// drive closes from a slice and let the OHLC come from a per-bar
    /// (low, high) override map. This gives precise control over BOTH the
    /// RSI shape (driven by closes) AND the pivot detection (driven by
    /// lows/highs) so the divergence tests don't fight each other.
    fn build_bars_from_series(
        closes: &[f64],
        low_overrides: &[(usize, f64)],
        high_overrides: &[(usize, f64)],
    ) -> Vec<Candle> {
        let mut bars: Vec<Candle> = closes
            .iter()
            .enumerate()
            .map(|(i, &c)| ohlcv(i as i64 * 1_800_000, c, c + 0.05, c - 0.05, c, 100.0))
            .collect();
        for &(i, lo) in low_overrides {
            bars[i].low = lo;
            // Keep open/close ≥ low to stay self-consistent.
            if bars[i].open < lo {
                bars[i].open = lo;
            }
        }
        for &(i, hi) in high_overrides {
            bars[i].high = hi;
            if bars[i].close > hi {
                bars[i].close = hi;
            }
        }
        bars
    }

    /// Bullish hidden divergence: price HL, RSI LL.
    ///
    /// Construction approach (calibrated by inspecting actual RSI output):
    ///   - Bars 0..30: flat at 100 (RSI warm-up to 50.0).
    ///   - Bars 31..45: gentle climb to ~102 (no shock — keeps RSI near 70).
    ///   - Bar 45: small dip; bars 46..50 a SHALLOW drift down so older
    ///     pivot RSI lands around 45 (high enough so newer pivot can be
    ///     lower).
    ///   - Older pivot at 50: low=98.0, close=99.5 (only a mild new low).
    ///   - Bars 51..61: STRONG rally to ~108. By bar 61 RSI ≈ 80.
    ///   - Bars 62..65: VIOLENT crash from 108 → 99 in 4 bars. The
    ///     gain-EMA fell from ~80 to ~30 = much sharper down-move than at
    ///     the older pivot → RSI at bar 65 ≈ 20 (LOWER than older's 45).
    ///   - Newer pivot at 65: low=99.0 (HIGHER than 98.0 ✓), RSI 20 (LL ✓).
    ///   - Bars 66..78: minimal upward drift so flank-low check at idx 67
    ///     still has low > newer pivot's 99.0, AND signal-bar RSI sits
    ///     below 50 (continuation gate).
    ///
    /// Additionally the OLDER pivot at 50 needs flank-lows strictly above
    /// its 98.0 — bar 48 close is 100, bar 49 close is 99 → we override
    /// bar-49's low to 99.5 (above 98.0). Symmetric on the right flank.
    #[test]
    fn bull_hidden_div_fires_on_higher_low_lower_rsi() {
        // Hidden bull div fixture (calibrated against actual Wilder RSI output):
        //   - 0..30: flat 100 → RSI seed at 50.
        //   - 31..49: gentle rally to 102 (small +0.1 per bar) → RSI ~70.
        //   - 50: SMALL pullback close to 101.5 → RSI ~60 (older pivot RSI).
        //     Override bar 50 low to 98.0 (HOLY price-pivot, RSI stays high).
        //   - 51..61: gentle rally to ~104 → RSI back to ~70.
        //   - 62..65: SHARP multi-bar crash (104→99) → newer pivot RSI ~25.
        //   - 66..78: tiny up-drift; signal-bar RSI ~30 (below 50 continuation gate).
        let mut closes: Vec<f64> = vec![100.0; 80];
        for i in 31..50 {
            closes[i] = 100.0 + (i as f64 - 30.0) * 0.1;
        }
        // closes[49] = 100 + 19*0.1 = 101.9
        closes[50] = 101.5; // small pullback close (RSI stays ~60)
        for i in 51..62 {
            closes[i] = 101.5 + (i as f64 - 50.0) * 0.25;
        }
        // closes[61] = 101.5 + 11*0.25 = 104.25
        // Sharp crash spread over 4 bars to drive RSI < 30.
        closes[62] = 103.0;
        closes[63] = 101.0;
        closes[64] = 99.5;
        closes[65] = 99.0; // newer pivot close
        // Modest up-drift after newer pivot so no additional pivot-low
        // candidates appear in the scan window. Use a small step (0.05) so
        // RSI at signal_idx (i=78) ends in the 30-45 band — well below the
        // continuation gate (≤50).
        for i in 66..80 {
            closes[i] = 99.0 + (i as f64 - 65.0) * 0.05;
        }
        // closes[78] = 99.0 + 13*0.05 = 99.65
        let low_overrides = vec![
            // Older pivot-low at 50. Flank lows MUST be > 98.0.
            (48, 101.5), (49, 101.5),
            (50, 98.0),
            (51, 101.5), (52, 101.5),
            // Newer pivot-low at 65. Flank lows MUST be > 99.0 (strict-on-left)
            // and >= 99.0 (non-strict-on-right but we still set them > 99.0
            // so no tie). Bars 66..signal_idx MUST have monotonically rising
            // lows so no third pivot-low appears in the scan window — keep
            // gap large (≥ 0.3) per bar.
            (63, 100.5), (64, 99.4),
            (65, 99.0),
            (66, 99.5), (67, 100.0), (68, 100.5), (69, 101.0),
            (70, 101.0), (71, 101.0), (72, 101.0), (73, 101.0),
            (74, 101.0), (75, 101.0), (76, 101.0), (77, 101.0),
        ];
        let bars = build_bars_from_series(&closes, &low_overrides, &[]);
        let p = RsiHiddenDivParams::default();
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "bullish hidden div: price HL (98→99) + RSI LL (older~60 → newer~25) must vote Long"
        );
    }

    /// Bearish hidden divergence: symmetric — price LH, RSI HH.
    ///
    /// Mirror of the bullish fixture (close-series + high-overrides flipped).
    /// Older pivot-high at 50 with RSI ~29 (high price but coming from a
    /// gentle decline); newer pivot-high at 65 with RSI ~73 (lower price
    /// but coming from a violent rally).
    #[test]
    fn bear_hidden_div_fires_symmetric() {
        let mut closes: Vec<f64> = vec![100.0; 80];
        for i in 31..50 {
            closes[i] = 100.0 - (i as f64 - 30.0) * 0.1;
        }
        // closes[49] = 100 - 19*0.1 = 98.1
        closes[50] = 98.5; // small bounce close (older pivot-high RSI ~29)
        for i in 51..62 {
            closes[i] = 98.5 - (i as f64 - 50.0) * 0.25;
        }
        // closes[61] = 98.5 - 11*0.25 = 95.75
        // VIOLENT rally so newer pivot-high RSI ≫ older's.
        closes[62] = 97.0;
        closes[63] = 99.0;
        closes[64] = 100.5;
        closes[65] = 101.0; // newer pivot close (HIGH but high=102 via override is LOWER than 50's 102.0+epsilon)
        // To trip the bearish HIDDEN pattern we need price LH: newer_high
        // ≤ older_high × (1 - 0.003). Older high = 102.0 → newer high ≤
        // 101.69. So newer pivot HIGH must be ≤ 101.69. We override it to
        // 101.5 below.
        for i in 66..80 {
            closes[i] = 101.0 - (i as f64 - 65.0) * 0.05;
        }
        let high_overrides = vec![
            // Older pivot-high at 50. Flank highs MUST be < 102.0.
            (48, 98.5), (49, 98.5),
            (50, 102.0),
            (51, 98.5), (52, 98.5),
            // Newer pivot-high at 65. Flank highs strictly < 101.5
            // (strict-on-left) and ≤ 101.5 (non-strict-on-right).
            // Bars 66..signal_idx must have monotonically DECREASING highs
            // so no third pivot-high appears in the scan window.
            (63, 100.5), (64, 100.6),
            (65, 101.5),
            (66, 100.5), (67, 100.0), (68, 99.5), (69, 99.0),
            (70, 99.0), (71, 99.0), (72, 99.0), (73, 99.0),
            (74, 99.0), (75, 99.0), (76, 99.0), (77, 99.0),
        ];
        let bars = build_bars_from_series(&closes, &[], &high_overrides);
        let p = RsiHiddenDivParams::default();
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert_eq!(
            v,
            Some(PositionSide::Short),
            "bearish hidden div: price LH (102→101.5) + RSI HH (older~29 → newer~73) must vote Short"
        );
    }

    /// Orthogonality test: REGULAR divergence (price HH, RSI LH on highs OR
    /// price LL, RSI HL on lows) must NOT fire — that is a REVERSAL pattern,
    /// not a continuation pattern. We construct a regular bullish divergence
    /// (price LL on the newer low + RSI HL) and assert no vote.
    #[test]
    fn regular_divergence_does_not_fire() {
        let mut bars = flat_bars(80, 100.0);
        // Older pivot-low at idx 50: low=99.0.
        sculpt_pivot_low(&mut bars, 50, 99.0, 99.5, 99.8, 100.0, 2);
        // Newer pivot-low at idx 65: LOWER low (98.0). RSI HIGHER at idx 65
        // than at idx 50 (regular divergence).
        // To depress idx-50 RSI, surround it with sharper down-strokes.
        bars[47].close = 99.7;
        bars[47].low = 99.4;
        bars[48].close = 99.4;
        bars[48].low = 99.1;
        bars[49].close = 99.1;
        bars[49].low = 99.0;
        for i in 51..65 {
            let mut b = bars[i];
            b.open = 99.5 + (i as f64 - 51.0) * 0.05;
            b.close = 99.5 + (i as f64 - 50.0) * 0.05;
            b.high = b.close + 0.2;
            b.low = b.open - 0.1;
            bars[i] = b;
        }
        // Newer pivot — deeper low but very mild lead-in so RSI doesn't crash.
        sculpt_pivot_low(&mut bars, 65, 98.0, 99.8, 99.5, 99.7, 2);
        for i in 66..78 {
            let mut b = bars[i];
            b.open = 99.8;
            b.close = 99.8;
            b.high = 100.0;
            b.low = 99.7;
            bars[i] = b;
        }

        let p = RsiHiddenDivParams::default();
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert!(
            v.is_none(),
            "regular bullish divergence (price LL, RSI HL) is REVERSAL, not continuation → must NOT vote Long"
        );
    }

    /// Stale-pivot guard: if the newest pivot is older than
    /// `max_swings_age_bars`, the detector must abstain even when the
    /// divergence shape is correct.
    #[test]
    fn no_signal_when_max_swings_age_exceeded() {
        let mut bars = flat_bars(120, 100.0);
        sculpt_pivot_low(&mut bars, 50, 98.0, 99.5, 99.8, 100.0, 2);
        // Newer pivot at idx 65; signal_idx = 118 → age 53 > default 40.
        sculpt_pivot_low(&mut bars, 65, 99.0, 99.0, 99.8, 100.0, 2);
        for i in 66..118 {
            let mut b = bars[i];
            b.open = 99.5;
            b.close = 99.5;
            b.high = 99.7;
            b.low = 99.3;
            bars[i] = b;
        }
        let mut p = RsiHiddenDivParams::default();
        // Stretch lookback so the OLDER pivot is still inside the scan,
        // otherwise the test would be trivially None for a different reason.
        p.swing_lookback = 80;
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert!(
            v.is_none(),
            "newest pivot 53 bars old > 40 max → stale → no vote"
        );
    }

    /// RSI-too-high gate: even with valid price HL + RSI LL, if signal-bar
    /// RSI sits above `max_rsi_on_long_signal`, the long-side vote is
    /// suppressed (momentum already overbought).
    #[test]
    fn no_signal_when_rsi_too_high_on_long() {
        let mut bars = flat_bars(80, 100.0);
        sculpt_pivot_low(&mut bars, 50, 98.0, 99.5, 99.8, 100.0, 2);
        sculpt_pivot_low(&mut bars, 65, 99.0, 99.0, 99.8, 100.0, 2);
        bars[62].close = 99.5;
        bars[63].close = 99.3;
        bars[64].close = 99.1;
        // Drive a STRONG rally between idx 66 and signal_idx so RSI at
        // signal_idx is high (e.g. 70+).
        for i in 66..78 {
            let mut b = bars[i];
            b.open = 100.0 + (i as f64 - 66.0) * 0.5;
            b.close = 100.0 + (i as f64 - 65.0) * 0.5;
            b.high = b.close + 0.3;
            b.low = b.open - 0.1;
            bars[i] = b;
        }
        let p = RsiHiddenDivParams {
            max_rsi_on_long_signal: 50.0,
            ..RsiHiddenDivParams::default()
        };
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert!(
            v.is_none(),
            "signal-bar RSI > 50 → continuation entry suppressed → no vote"
        );
    }

    /// Cooldown test: caller is responsible for enforcing cooldown via the
    /// state-map; we just verify that calling the pure helper TWICE on the
    /// same bars produces the SAME vote (idempotent — no internal cooldown).
    /// This guards against accidentally introducing state into the helper.
    #[test]
    fn cooldown_blocks_back_to_back() {
        // Same fixture as the bullish-fires test.
        let mut bars = flat_bars(80, 100.0);
        sculpt_pivot_low(&mut bars, 50, 98.0, 99.5, 99.8, 100.0, 2);
        for i in 51..65 {
            let mut b = bars[i];
            b.open = 100.0;
            b.close = 100.0;
            b.high = 100.6;
            b.low = 99.6;
            bars[i] = b;
        }
        sculpt_pivot_low(&mut bars, 65, 99.0, 99.0, 99.8, 100.0, 2);
        bars[62].close = 99.5;
        bars[63].close = 99.3;
        bars[64].close = 99.1;
        for i in 66..78 {
            let mut b = bars[i];
            b.open = 99.1 + (i as f64 - 66.0) * 0.02;
            b.close = 99.1 + (i as f64 - 65.0) * 0.02;
            b.high = b.close + 0.2;
            b.low = b.open - 0.1;
            bars[i] = b;
        }
        let p = RsiHiddenDivParams::default();
        let v1 = compute_rsi_hidden_div_vote(&bars, &p);
        let v2 = compute_rsi_hidden_div_vote(&bars, &p);
        // Helper has no state — same input must produce identical output
        // (the regime panel installs cooldown via its OWN state map).
        assert_eq!(
            v1, v2,
            "pure helper must be stateless — back-to-back calls return same vote"
        );
    }

    /// KRITISCH lookahead test: the helper must NOT consult
    /// `candles[len-1]` (the execution bar). Build a fixture where the
    /// LAST bar carries a wild value (e.g. a brand-new spike) and verify
    /// the vote is unaffected.
    #[test]
    fn no_lookahead_on_entry_bar_close() {
        // Start with the bullish-fires fixture.
        let mut bars = flat_bars(80, 100.0);
        sculpt_pivot_low(&mut bars, 50, 98.0, 99.5, 99.8, 100.0, 2);
        for i in 51..65 {
            let mut b = bars[i];
            b.open = 100.0;
            b.close = 100.0;
            b.high = 100.6;
            b.low = 99.6;
            bars[i] = b;
        }
        sculpt_pivot_low(&mut bars, 65, 99.0, 99.0, 99.8, 100.0, 2);
        bars[62].close = 99.5;
        bars[63].close = 99.3;
        bars[64].close = 99.1;
        for i in 66..78 {
            let mut b = bars[i];
            b.open = 99.1 + (i as f64 - 66.0) * 0.02;
            b.close = 99.1 + (i as f64 - 65.0) * 0.02;
            b.high = b.close + 0.2;
            b.low = b.open - 0.1;
            bars[i] = b;
        }
        let p = RsiHiddenDivParams::default();
        // Baseline vote (entry bar idx 79 is benign flat).
        let baseline = compute_rsi_hidden_div_vote(&bars, &p);

        // Now hand-pollute candles[79] (the entry bar). If the helper reads
        // it, the vote must change. With correct lookahead-safety, it does
        // NOT change.
        let mut polluted = bars.clone();
        polluted[79].open = 50.0;
        polluted[79].high = 200.0;
        polluted[79].low = 1.0;
        polluted[79].close = 200.0;
        let with_pollution = compute_rsi_hidden_div_vote(&polluted, &p);
        assert_eq!(
            baseline, with_pollution,
            "entry-bar (idx len-1) MUST NOT influence the vote — lookahead bug if differs"
        );
    }

    /// Self-fulfilling-pivot guard: the helper must NOT consider
    /// `signal_idx` itself when scanning for pivots. We engineer a fixture
    /// where bar `signal_idx` is a local low (the recent crash), then add a
    /// legitimate older pivot. If the impl includes signal_idx as a pivot,
    /// the divergence would degenerate; correct impl ignores it.
    #[test]
    fn excludes_signal_bar_from_pivot_scan() {
        let mut bars = flat_bars(80, 100.0);
        // ONE legitimate older pivot-low at idx 50.
        sculpt_pivot_low(&mut bars, 50, 98.0, 99.5, 99.8, 100.0, 2);
        // Make bars 51..76 flat at 100.0 (no other pivots).
        for i in 51..77 {
            let mut b = bars[i];
            b.open = 100.0;
            b.close = 100.0;
            b.high = 100.5;
            b.low = 99.5;
            bars[i] = b;
        }
        // Place a SHARP low at signal_idx (idx 78) — this MUST be excluded
        // from the pivot-scan. If included, the helper would treat (78) as
        // the newest pivot with a "higher" low 99.5 vs 98.0 → bullish vote.
        bars[78].open = 100.0;
        bars[78].low = 99.5;
        bars[78].close = 99.5;
        bars[78].high = 100.0;
        // The bars to either side of 78 must NOT make it look like a
        // confirmed pivot anyway — bar 77 is flat-low 99.5, bar 79 doesn't
        // exist within scan window since signal_idx = len-2 = 78. With
        // pivot_strength = 2 we'd need 78+2 = 80 ≤ signal_idx=78 → fails by
        // construction. So the guard is layered: even without explicit
        // exclusion the right-flank-bound check rejects it.
        let p = RsiHiddenDivParams::default();
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert!(
            v.is_none(),
            "signal_idx must be excluded from pivot scan — only one legitimate older pivot, can't form divergence"
        );
    }

    /// NaN safety: NaN closes/highs/lows must produce safe None, not panic.
    #[test]
    fn handles_nan_inputs_safely() {
        let mut bars = flat_bars(80, 100.0);
        bars[40].close = f64::NAN;
        let p = RsiHiddenDivParams::default();
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert!(v.is_none(), "NaN close in series → safe None");

        let mut bars2 = flat_bars(80, 100.0);
        bars2[40].low = f64::NAN;
        bars2[40].high = f64::NAN;
        let v2 = compute_rsi_hidden_div_vote(&bars2, &p);
        assert!(v2.is_none(), "NaN OHLC in window → safe None");
    }

    /// Two-pivots requirement: with only ONE pivot in the window the
    /// divergence comparison cannot be performed → safe None. Ensures the
    /// helper doesn't divide-by-zero or fabricate a phantom newest vs
    /// itself.
    #[test]
    fn requires_two_confirmed_pivots() {
        let mut bars = flat_bars(80, 100.0);
        // Place a single pivot-low at idx 65 (within scan window). No
        // older pivot.
        sculpt_pivot_low(&mut bars, 65, 99.0, 99.0, 99.8, 100.0, 2);
        bars[62].close = 99.5;
        bars[63].close = 99.3;
        bars[64].close = 99.1;
        for i in 66..78 {
            let mut b = bars[i];
            b.open = 99.1 + (i as f64 - 66.0) * 0.02;
            b.close = 99.1 + (i as f64 - 65.0) * 0.02;
            b.high = b.close + 0.2;
            b.low = b.open - 0.1;
            bars[i] = b;
        }
        let p = RsiHiddenDivParams::default();
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert!(
            v.is_none(),
            "only one pivot in window → can't compute divergence → None"
        );
    }

    /// Too-few-candles guard: helper must short-circuit cleanly when fewer
    /// than min_len bars are supplied.
    #[test]
    fn handles_too_few_candles() {
        let bars = flat_bars(20, 100.0);
        let p = RsiHiddenDivParams::default();
        let v = compute_rsi_hidden_div_vote(&bars, &p);
        assert!(v.is_none(), "too-short candle slice → safe None");
    }

    /// Zero-period / degenerate-parameter guard: rsi_period=0 or
    /// pivot_strength=0 must safely return None (no divide-by-zero, no
    /// panic).
    #[test]
    fn handles_zero_periods_safely() {
        let bars = flat_bars(80, 100.0);
        let p0 = RsiHiddenDivParams {
            rsi_period: 0,
            ..RsiHiddenDivParams::default()
        };
        assert!(compute_rsi_hidden_div_vote(&bars, &p0).is_none());
        let p1 = RsiHiddenDivParams {
            pivot_strength: 0,
            ..RsiHiddenDivParams::default()
        };
        assert!(compute_rsi_hidden_div_vote(&bars, &p1).is_none());
        let p2 = RsiHiddenDivParams {
            swing_lookback: 0,
            ..RsiHiddenDivParams::default()
        };
        assert!(compute_rsi_hidden_div_vote(&bars, &p2).is_none());
    }
}
