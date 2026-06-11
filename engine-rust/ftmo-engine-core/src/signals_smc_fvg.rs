// 2026-05-14 Detector #21 — SMC Fair-Value-Gap (FVG) voter.
//
// A Fair-Value-Gap is a 3-bar imbalance pattern from Smart-Money Concepts
// (SMC): on a strong directional impulse the middle bar prints a body
// large enough that the wicks of bar `k` and bar `k+2` do not overlap.
// The price range between `high(k)` and `low(k+2)` (bullish) or between
// `low(k)` and `high(k+2)` (bearish) is the FVG — an unfilled liquidity
// pocket that price tends to retest before continuation.
//
// Voting contract (used by RegimeConfluence as the 9th independent voter):
//   - Bullish FVG: scan the lookback range `[signal_idx - lookback ..= signal_idx - 2]`
//     for a bar `k` satisfying `candles[k+2].low > candles[k].high` (3-bar
//     gap-up). FVG-zone is `[candles[k].high, candles[k+2].low]`.
//     Long trigger fires when the SIGNAL bar revisits the zone from above
//     and closes back above it: `signal_bar.low <= fvg_top` AND
//     `signal_bar.close > fvg_bottom`. Width-percent filter:
//     `(fvg_top - fvg_bottom) / fvg_bottom >= fvg_min_width_pct`.
//     Impulse filter: the FVG middle-bar absolute body must clear
//     `fvg_impulse_min_pct`.
//   - Bearish FVG: symmetric on the downside. Anchor `k`:
//     `candles[k+2].high < candles[k].low`. FVG-zone is
//     `[candles[k+2].high, candles[k].low]`. Short trigger fires when
//     `signal_bar.high >= fvg_bottom` AND `signal_bar.close < fvg_top`.
//
// Lookahead-safety rationale (KRITISCH — Codex 2026-05-13):
//   - Signal bar is `candles.len() - 2` (the just-closed bar), so
//     `candles.len() - 1` is the entry-execution bar whose OHLC is
//     unknown at decision time.
//   - The anchor-search range is `[signal_idx - lookback ..= signal_idx - 2]`.
//     The upper bound is `signal_idx - 2` (NOT `signal_idx`) so that
//     `k + 2 <= signal_idx - 0`. We explicitly exclude `k+2 == signal_idx`
//     anchor matches because then the signal bar would BE the right edge
//     of its own FVG → self-fulfilling. The retest-trigger then runs on
//     the signal bar against a zone built strictly from PRIOR bars.
//
// Pattern mirrors `signals_stop_hunt.rs` (319 LOC). Pure helper — no
// state, no engine wiring. RegimeConfluence pipes a vote into the
// consensus tally; the anchor PollSignal still comes from
// R28V6 / Breakout / MR.

use crate::candle::Candle;
use crate::position::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct FvgParams {
    /// Number of bars (back from the signal bar) to scan for a valid
    /// 3-bar imbalance anchor.
    pub fvg_lookback: usize,
    /// Minimum gap-width as fraction of the zone bottom price. Filters
    /// out micro-gaps that fill on noise and would over-fire the voter.
    pub fvg_min_width_pct: f64,
    /// Minimum absolute body of the impulse (middle) bar as a fraction of
    /// its open. Ensures the FVG was created by a real impulse, not by
    /// stale low-volume drift.
    pub fvg_impulse_min_pct: f64,
    /// Reserved for future state-carrying integration — accepted as a
    /// param so callers can wire CLI flags without an API change once a
    /// per-asset cooldown table is introduced. Currently unused inside
    /// this pure helper (RegimeConfluence votes are stateless).
    pub cooldown_bars: usize,
}

impl FvgParams {
    pub fn default_30m_crypto() -> Self {
        Self {
            fvg_lookback: 20,
            fvg_min_width_pct: 0.0015,
            fvg_impulse_min_pct: 0.005,
            cooldown_bars: 12,
        }
    }
}

/// Returns a directional vote when the signal bar is retesting a fresh
/// FVG (bullish or bearish) within the lookback window. Returns `None`
/// when no qualifying gap exists, the retest contract isn't met, or any
/// numerical guard fails.
pub fn compute_smc_fvg_vote(candles: &[Candle], params: &FvgParams) -> Option<PositionSide> {
    // Need at least signal_idx (len-2) + impulse triplet (3 bars) starting
    // from signal_idx - lookback. Minimum size is therefore lookback + 3.
    if params.fvg_lookback == 0 || candles.len() < params.fvg_lookback + 3 {
        return None;
    }
    if !params.fvg_min_width_pct.is_finite() || params.fvg_min_width_pct < 0.0 {
        return None;
    }
    if !params.fvg_impulse_min_pct.is_finite() || params.fvg_impulse_min_pct < 0.0 {
        return None;
    }
    let signal_idx = candles.len() - 2;
    let signal_bar = candles[signal_idx];
    if !signal_bar.low.is_finite()
        || !signal_bar.high.is_finite()
        || !signal_bar.close.is_finite()
        || !signal_bar.open.is_finite()
    {
        return None;
    }

    // Anchor-search bounds. We scan `k` such that the FVG triplet
    // (k, k+1, k+2) is fully contained in the bars STRICTLY BEFORE the
    // signal bar — i.e. `k + 2 <= signal_idx - 1` ⇒ `k <= signal_idx - 3`.
    // This excludes the signal bar from participating in the FVG anchor
    // construction so the retest comparison cannot self-fulfill.
    let start = signal_idx.saturating_sub(params.fvg_lookback);
    let end_inclusive = if signal_idx >= 3 {
        signal_idx - 3
    } else {
        return None;
    };
    if start > end_inclusive {
        return None;
    }

    // Walk the lookback range from newest to oldest. Returning on the
    // first qualifying anchor biases toward the freshest gap (most likely
    // unfilled), mirroring trader intent.
    for k in (start..=end_inclusive).rev() {
        let bar_k = candles[k];
        let bar_m = candles[k + 1]; // impulse / middle bar
        let bar_p = candles[k + 2];
        if !bar_k.high.is_finite()
            || !bar_k.low.is_finite()
            || !bar_m.open.is_finite()
            || !bar_m.close.is_finite()
            || !bar_p.high.is_finite()
            || !bar_p.low.is_finite()
        {
            continue;
        }
        if bar_m.open <= 0.0 {
            continue;
        }
        let impulse_body = (bar_m.close - bar_m.open).abs() / bar_m.open;
        if !impulse_body.is_finite() || impulse_body < params.fvg_impulse_min_pct {
            continue;
        }

        // Bullish FVG: bar_p.low > bar_k.high. Zone = [bar_k.high, bar_p.low].
        if bar_p.low > bar_k.high {
            let fvg_bottom = bar_k.high;
            let fvg_top = bar_p.low;
            if fvg_bottom <= 0.0 {
                continue;
            }
            let width_pct = (fvg_top - fvg_bottom) / fvg_bottom;
            if !width_pct.is_finite() || width_pct < params.fvg_min_width_pct {
                continue;
            }
            // Retest contract: signal bar wicks INTO the zone (low ≤ top)
            // AND closes back above the bottom (re-acceptance of imbalance).
            if signal_bar.low <= fvg_top && signal_bar.close > fvg_bottom {
                return Some(PositionSide::Long);
            }
            // No retest on this fresh bullish FVG — newer anchors are
            // unlikely to retest either (anchors are strictly older going
            // backward), so abstain.
            continue;
        }

        // Bearish FVG: bar_p.high < bar_k.low. Zone = [bar_p.high, bar_k.low].
        if bar_p.high < bar_k.low {
            let fvg_bottom = bar_p.high;
            let fvg_top = bar_k.low;
            if fvg_bottom <= 0.0 {
                continue;
            }
            let width_pct = (fvg_top - fvg_bottom) / fvg_bottom;
            if !width_pct.is_finite() || width_pct < params.fvg_min_width_pct {
                continue;
            }
            // Retest contract: signal bar wicks UP into the zone
            // (high ≥ bottom) AND closes back below the top.
            if signal_bar.high >= fvg_bottom && signal_bar.close < fvg_top {
                return Some(PositionSide::Short);
            }
            continue;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ohlcv(t: i64, o: f64, h: f64, l: f64, c: f64, v: f64) -> Candle {
        Candle::new(t, o, h, l, c, v)
    }

    /// Flat range — no impulse, no gap, no vote.
    #[test]
    fn no_vote_on_flat_range() {
        let candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p = FvgParams::default_30m_crypto();
        let v = compute_smc_fvg_vote(&candles, &p);
        assert!(v.is_none(), "flat range must not produce an FVG vote");
    }

    /// Bullish FVG: build a clean 3-bar gap-up at indices (k=10, 11, 12)
    /// then have the signal bar (idx = len-2 = 28) retest the zone from
    /// above and close back inside. Expect Long vote.
    #[test]
    fn fvg_long_fires_on_clean_3bar_gap_and_retest() {
        let mut candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // Anchor at k=10: high=100.5
        candles[10] = ohlcv(10 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        // Impulse bar k+1=11: large bullish body 100.0 → 102.0 (+2%)
        candles[11] = ohlcv(11 * 1_800_000, 100.0, 102.2, 99.9, 102.0, 200.0);
        // Right edge k+2=12: low=101.0 > anchor.high=100.5 → FVG [100.5, 101.0].
        candles[12] = ohlcv(12 * 1_800_000, 102.0, 102.5, 101.0, 102.0, 100.0);
        // Continuation bars to keep the gap unfilled.
        for (i, c) in candles.iter_mut().enumerate().take(28).skip(13) {
            *c = ohlcv(i as i64 * 1_800_000, 102.0, 102.5, 101.5, 102.0, 100.0);
        }
        // Signal bar (idx 28) wicks INTO the zone and closes back above.
        candles[28] = ohlcv(28 * 1_800_000, 101.6, 102.0, 100.6, 101.7, 100.0);
        // Entry bar (idx 29) — content irrelevant.
        candles[29] = ohlcv(29 * 1_800_000, 101.7, 102.0, 101.0, 101.7, 100.0);
        let p = FvgParams {
            fvg_lookback: 20,
            fvg_min_width_pct: 0.0015,
            fvg_impulse_min_pct: 0.005,
            cooldown_bars: 12,
        };
        let v = compute_smc_fvg_vote(&candles, &p);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "fresh bullish FVG with retest must vote Long"
        );
    }

    /// Mirror of the bullish case for the downside.
    #[test]
    fn fvg_short_fires_symmetric() {
        let mut candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // Anchor at k=10: low=99.5
        candles[10] = ohlcv(10 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        // Impulse k+1=11: large bearish body 100.0 → 98.0 (-2%)
        candles[11] = ohlcv(11 * 1_800_000, 100.0, 100.1, 97.8, 98.0, 200.0);
        // Right edge k+2=12: high=99.0 < anchor.low=99.5 → FVG [99.0, 99.5].
        candles[12] = ohlcv(12 * 1_800_000, 98.0, 99.0, 97.5, 98.0, 100.0);
        for (i, c) in candles.iter_mut().enumerate().take(28).skip(13) {
            *c = ohlcv(i as i64 * 1_800_000, 98.0, 98.5, 97.5, 98.0, 100.0);
        }
        // Signal bar (idx 28) wicks UP into [99.0, 99.5] and closes back below.
        candles[28] = ohlcv(28 * 1_800_000, 98.4, 99.4, 98.0, 98.3, 100.0);
        candles[29] = ohlcv(29 * 1_800_000, 98.3, 99.0, 98.0, 98.3, 100.0);
        let p = FvgParams {
            fvg_lookback: 20,
            fvg_min_width_pct: 0.0015,
            fvg_impulse_min_pct: 0.005,
            cooldown_bars: 12,
        };
        let v = compute_smc_fvg_vote(&candles, &p);
        assert_eq!(
            v,
            Some(PositionSide::Short),
            "fresh bearish FVG with retest must vote Short"
        );
    }

    /// Gap exists but width is below `fvg_min_width_pct` → skip.
    #[test]
    fn fvg_skips_below_min_width() {
        let mut candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // Anchor.high = 100.50, p.low = 100.55 → width = 0.05%, below 0.15% floor.
        candles[10] = ohlcv(10 * 1_800_000, 100.0, 100.50, 99.5, 100.0, 100.0);
        // Impulse body 0.7% so the impulse-filter passes; gap-width is the
        // independent failure mode under test.
        candles[11] = ohlcv(11 * 1_800_000, 100.0, 100.8, 100.0, 100.7, 200.0);
        candles[12] = ohlcv(12 * 1_800_000, 100.7, 100.8, 100.55, 100.7, 100.0);
        for (i, c) in candles.iter_mut().enumerate().take(28).skip(13) {
            *c = ohlcv(i as i64 * 1_800_000, 100.7, 100.8, 100.5, 100.7, 100.0);
        }
        // Signal bar revisits — but the gap was too narrow to qualify in
        // the first place.
        candles[28] = ohlcv(28 * 1_800_000, 100.6, 100.7, 100.45, 100.6, 100.0);
        candles[29] = ohlcv(29 * 1_800_000, 100.6, 100.7, 100.5, 100.6, 100.0);
        let p = FvgParams {
            fvg_lookback: 20,
            fvg_min_width_pct: 0.0015,
            fvg_impulse_min_pct: 0.005,
            cooldown_bars: 12,
        };
        let v = compute_smc_fvg_vote(&candles, &p);
        assert!(v.is_none(), "sub-threshold width must abstain");
    }

    /// LOOKAHEAD test — self-fulfilling-anchor bug class. Construct a
    /// fixture where the signal bar (idx 28) ITSELF would form the right
    /// edge of a "gap" if it were allowed to participate in the anchor
    /// triplet. The correct impl excludes the signal bar (k+2 ≤
    /// signal_idx - 1) so this fake-anchor must NOT fire. We additionally
    /// ensure there is no LEGITIMATE fresh FVG in the prior window — so a
    /// correct impl returns None, while a buggy impl that includes
    /// `k+2 == signal_idx` would return a Long.
    #[test]
    fn excludes_signal_bar_from_fvg_anchor_no_self_fulfilling() {
        let mut candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // Pre-signal bars (k=26 and k+1=27) form an impulse and the signal
        // bar (k+2=28) has low > prior bar high. If a buggy impl uses
        // (26,27,28) as anchor triplet, it would compute zone
        // [candles[26].high=100.5, candles[28].low=...]. Build candles[28]
        // so that low > 100.5 AND signal bar wicks back into the zone…
        // exactly the self-fulfilling shape we want to block.
        candles[26] = ohlcv(26 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        // Impulse 27: 100.0 → 102.0 (+2% body).
        candles[27] = ohlcv(27 * 1_800_000, 100.0, 102.2, 99.9, 102.0, 200.0);
        // Signal bar 28: low=101.0 > anchor.high=100.5 (a "gap" if buggy
        // impl allowed), AND close > 100.5 (retest contract satisfied).
        candles[28] = ohlcv(28 * 1_800_000, 102.0, 102.5, 101.0, 101.6, 100.0);
        // Entry bar irrelevant.
        candles[29] = ohlcv(29 * 1_800_000, 101.6, 102.0, 101.0, 101.6, 100.0);
        let p = FvgParams {
            fvg_lookback: 20,
            fvg_min_width_pct: 0.0015,
            fvg_impulse_min_pct: 0.005,
            cooldown_bars: 12,
        };
        let v = compute_smc_fvg_vote(&candles, &p);
        assert!(
            v.is_none(),
            "signal bar must NOT participate in FVG anchor — if buggy this would Long"
        );
    }

    /// NaN inputs at any of the OHLC fields must short-circuit cleanly.
    #[test]
    fn handles_nan_inputs_safely() {
        let mut candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // NaN on the signal bar — explicitly tested as a guarded path.
        candles[28] = ohlcv(28 * 1_800_000, f64::NAN, 100.5, 99.5, 100.0, 100.0);
        let p = FvgParams::default_30m_crypto();
        let v = compute_smc_fvg_vote(&candles, &p);
        assert!(v.is_none(), "NaN signal-bar open must yield safe None");
    }

    /// Too-few-candles short-circuit. Below `fvg_lookback + 3` the helper
    /// cannot search even one anchor triplet → None.
    #[test]
    fn handles_too_few_candles() {
        let candles: Vec<Candle> = (0..5)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p = FvgParams::default_30m_crypto();
        let v = compute_smc_fvg_vote(&candles, &p);
        assert!(v.is_none(), "too few candles → safe None");
    }

    /// NaN width/impulse thresholds themselves must not panic.
    #[test]
    fn nan_inputs_handled_safely() {
        let candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p_bad_width = FvgParams {
            fvg_lookback: 20,
            fvg_min_width_pct: f64::NAN,
            fvg_impulse_min_pct: 0.005,
            cooldown_bars: 12,
        };
        assert!(compute_smc_fvg_vote(&candles, &p_bad_width).is_none());
        let p_bad_impulse = FvgParams {
            fvg_lookback: 20,
            fvg_min_width_pct: 0.0015,
            fvg_impulse_min_pct: f64::NAN,
            cooldown_bars: 12,
        };
        assert!(compute_smc_fvg_vote(&candles, &p_bad_impulse).is_none());
    }

    /// `fvg_lookback == 0` must short-circuit cleanly.
    #[test]
    fn handles_zero_lookback_safely() {
        let candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p = FvgParams {
            fvg_lookback: 0,
            fvg_min_width_pct: 0.0015,
            fvg_impulse_min_pct: 0.005,
            cooldown_bars: 12,
        };
        let v = compute_smc_fvg_vote(&candles, &p);
        assert!(v.is_none());
    }
}
