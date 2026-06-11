// 2026-05-14 Detector #14 — Stop-Hunt Liquidity-Sweep Reversal voter.
//
// Identifies a "stop-hunt" pattern: the SIGNAL bar pierces a recent swing-low
// (or swing-high) by a configurable minimum wick-depth, then closes BACK on
// the right side of that reference level. The pattern is interpreted as a
// liquidity sweep: stops below the recent low got hunted, smart-money
// absorbed the resulting fill flow, and the close-back signals a reversal.
//
// Compared to the existing TS reference (`src/utils/ftmoSmcEngine.ts:138-170`)
// which uses `c[i]` as the SIGNAL bar — this is the known lookahead-bug
// class flagged by the 2026-05-13 Codex audit. We use the closed bar
// `signal_idx = candles.len() - 2` instead, and crucially exclude the signal
// bar itself from the reference range so that the wick we are testing
// against cannot self-fulfill the threshold. This is verified by a dedicated
// `excludes_signal_bar_from_reference_range_no_self_fulfilling` test.
//
// Voting contract (used by RegimeConfluence as a 6th independent voter):
//   - Bullish sweep: signal_bar.low < ref_low and (ref_low - low)/ref_low ≥
//     wick_depth, AND signal_bar.close > ref_low (or > midpoint of open/ref_low
//     when close_back_strict=true).
//   - Bearish sweep: symmetric on highs.
//   - Else: abstain (None).

use crate::candle::Candle;
use crate::position::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct StopHuntParams {
    pub lookback: usize,
    pub required_wick_depth_pct: f64,
    pub close_back_strict: bool,
}

impl StopHuntParams {
    pub fn default_30m_crypto() -> Self {
        Self {
            lookback: 20,
            required_wick_depth_pct: 0.003,
            close_back_strict: false,
        }
    }
}

pub fn compute_stop_hunt_vote(candles: &[Candle], params: &StopHuntParams) -> Option<PositionSide> {
    if params.lookback == 0 || candles.len() < params.lookback + 2 {
        return None;
    }
    if !params.required_wick_depth_pct.is_finite() || params.required_wick_depth_pct < 0.0 {
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
    // KRITISCH: range EXCLUSIVE signal-bar — guards self-fulfilling lookahead.
    // If signal_bar.low were INCLUDED in ref_low, then a deep wick would
    // both lower ref_low AND be tested against ref_low, making the depth
    // check trivially zero. Exclusivity ensures the comparison is against
    // the *prior* swing extreme only.
    let range = &candles[signal_idx - params.lookback..signal_idx];
    let ref_low = range.iter().map(|c| c.low).fold(f64::MAX, f64::min);
    let ref_high = range.iter().map(|c| c.high).fold(f64::MIN, f64::max);
    if !ref_low.is_finite() || ref_low <= 0.0 || !ref_high.is_finite() {
        return None;
    }

    // Bullish sweep: pierce below ref_low then close back above.
    if signal_bar.low < ref_low {
        let depth = (ref_low - signal_bar.low) / ref_low;
        if depth >= params.required_wick_depth_pct {
            let close_back = if params.close_back_strict {
                let mid = 0.5 * (signal_bar.open + ref_low);
                signal_bar.close > mid
            } else {
                signal_bar.close > ref_low
            };
            if close_back {
                return Some(PositionSide::Long);
            }
        }
    }
    // Bearish sweep: pierce above ref_high then close back below.
    if signal_bar.high > ref_high {
        let depth = (signal_bar.high - ref_high) / ref_high;
        if depth >= params.required_wick_depth_pct {
            let close_back = if params.close_back_strict {
                let mid = 0.5 * (signal_bar.open + ref_high);
                signal_bar.close < mid
            } else {
                signal_bar.close < ref_high
            };
            if close_back {
                return Some(PositionSide::Short);
            }
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

    /// Flat range: all bars identical → no sweep possible.
    #[test]
    fn no_vote_on_flat_range() {
        let candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p = StopHuntParams::default_30m_crypto();
        let v = compute_stop_hunt_vote(&candles, &p);
        assert!(v.is_none(), "flat range must not produce a sweep vote");
    }

    /// Bullish sweep: ref_low = 99.5 across 20 prior bars. Signal-bar wicks
    /// deep below to 98.5 (depth ≈ 1.0%) and closes back at 100.0 (> ref_low).
    /// Expect Long vote.
    #[test]
    fn long_sweep_fires_when_wick_below_and_close_back_above() {
        let mut candles: Vec<Candle> = (0..22)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // signal_idx = len-2 = 20
        candles[20] = ohlcv(20 * 1_800_000, 100.0, 100.3, 98.5, 100.0, 100.0);
        // entry-bar (idx 21) — content irrelevant for the vote
        candles[21] = ohlcv(21 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        let p = StopHuntParams {
            lookback: 20,
            required_wick_depth_pct: 0.003,
            close_back_strict: false,
        };
        let v = compute_stop_hunt_vote(&candles, &p);
        assert_eq!(v, Some(PositionSide::Long));
    }

    /// Pierce ref_low but close stays BELOW ref_low → no recovery → abstain.
    #[test]
    fn no_long_sweep_when_close_remains_below_ref_low() {
        let mut candles: Vec<Candle> = (0..22)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // Signal bar opens, dives, closes still under ref_low (99.5).
        candles[20] = ohlcv(20 * 1_800_000, 99.6, 99.7, 98.5, 99.3, 100.0);
        candles[21] = ohlcv(21 * 1_800_000, 99.3, 99.5, 99.0, 99.3, 100.0);
        let p = StopHuntParams::default_30m_crypto();
        let v = compute_stop_hunt_vote(&candles, &p);
        assert!(v.is_none(), "close still below ref_low → no recovery vote");
    }

    /// Wick depth (ref_low - low)/ref_low = 0.001 (0.1%) < threshold 0.3%
    /// → abstain even though close recovered.
    #[test]
    fn wick_depth_below_threshold_skipped() {
        let mut candles: Vec<Candle> = (0..22)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // 0.1% wick below 99.5 = 99.4005
        candles[20] = ohlcv(20 * 1_800_000, 100.0, 100.3, 99.4, 100.0, 100.0);
        candles[21] = ohlcv(21 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        let p = StopHuntParams {
            lookback: 20,
            required_wick_depth_pct: 0.003,
            close_back_strict: false,
        };
        let v = compute_stop_hunt_vote(&candles, &p);
        assert!(v.is_none(), "shallow wick must not qualify as sweep");
    }

    /// Mirror of the bullish case for upside liquidity sweep.
    #[test]
    fn short_sweep_fires_symmetric() {
        let mut candles: Vec<Candle> = (0..22)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // signal bar pierces ref_high (100.5) by ~1% then closes back below.
        candles[20] = ohlcv(20 * 1_800_000, 100.0, 101.6, 99.8, 100.0, 100.0);
        candles[21] = ohlcv(21 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        let p = StopHuntParams {
            lookback: 20,
            required_wick_depth_pct: 0.003,
            close_back_strict: false,
        };
        let v = compute_stop_hunt_vote(&candles, &p);
        assert_eq!(v, Some(PositionSide::Short));
    }

    /// LOOKAHEAD test — self-fulfilling-range bug class. The signal bar's
    /// own low MUST NOT participate in `ref_low`. Build a fixture where the
    /// signal-bar low IS the lowest low in the slice, and verify the vote
    /// is computed against the *prior* swing low.
    ///
    /// Construction: bars [0..20) all have low=99.5. The signal bar (idx 20)
    /// has low=99.0 — but this LOW would NOT participate in ref_low if the
    /// slice is `[0..20)` (exclusive). If our impl is buggy and includes
    /// the signal bar, ref_low would drop to 99.0 and depth would be 0 →
    /// no vote. With the correct impl ref_low=99.5, depth=0.005 (0.5%) →
    /// Long vote (close=100.0 > 99.5). The test asserts the Long vote fires.
    #[test]
    fn excludes_signal_bar_from_reference_range_no_self_fulfilling() {
        let mut candles: Vec<Candle> = (0..22)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        // signal bar low is BELOW the prior-window low (99.5).
        candles[20] = ohlcv(20 * 1_800_000, 100.0, 100.3, 99.0, 100.0, 100.0);
        // entry bar irrelevant
        candles[21] = ohlcv(21 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        let p = StopHuntParams {
            lookback: 20,
            required_wick_depth_pct: 0.003,
            close_back_strict: false,
        };
        let v = compute_stop_hunt_vote(&candles, &p);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "ref_low must EXCLUDE signal bar — if buggy this would return None"
        );
    }

    /// Strict mode: close must be above midpoint(open, ref_low). A weak
    /// recovery that only just crosses ref_low → abstain in strict mode.
    #[test]
    fn close_back_strict_filters_weak_recovery() {
        // ref_low across 20 prior bars = 99.5.
        // Signal bar open=99.0, wick=98.0, close=99.55 → > ref_low (lenient
        // passes) but mid(open=99.0, ref_low=99.5) = 99.25, close 99.55 > 99.25
        // → still passes. Make close = 99.10 to fall under the midpoint while
        // still being above … wait, 99.10 < 99.5 → wouldn't even pass lenient.
        //
        // Better fixture: ref_low=99.5, signal-bar open=100.0, low=98.0,
        // close=99.55. Lenient close > ref_low ✓. mid = (100.0 + 99.5)/2 =
        // 99.75. close 99.55 < 99.75 → STRICT abstains, LENIENT votes.
        let mut candles: Vec<Candle> = (0..22)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        candles[20] = ohlcv(20 * 1_800_000, 100.0, 100.3, 98.0, 99.55, 100.0);
        candles[21] = ohlcv(21 * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0);
        let lenient = StopHuntParams {
            lookback: 20,
            required_wick_depth_pct: 0.003,
            close_back_strict: false,
        };
        let strict = StopHuntParams {
            lookback: 20,
            required_wick_depth_pct: 0.003,
            close_back_strict: true,
        };
        assert_eq!(
            compute_stop_hunt_vote(&candles, &lenient),
            Some(PositionSide::Long),
            "lenient close > ref_low must vote Long"
        );
        assert!(
            compute_stop_hunt_vote(&candles, &strict).is_none(),
            "strict close < mid must abstain"
        );
    }

    /// NaN inputs must never panic. Helper returns None.
    #[test]
    fn handles_nan_inputs_safely() {
        let mut candles: Vec<Candle> = (0..22)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        candles[20] = ohlcv(20 * 1_800_000, f64::NAN, 100.5, 98.5, 100.0, 100.0);
        let p = StopHuntParams::default_30m_crypto();
        let v = compute_stop_hunt_vote(&candles, &p);
        assert!(v.is_none(), "NaN open must safely produce None");

        // Also NaN wick threshold itself.
        let candles2: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p_bad = StopHuntParams {
            lookback: 20,
            required_wick_depth_pct: f64::NAN,
            close_back_strict: false,
        };
        assert!(compute_stop_hunt_vote(&candles2, &p_bad).is_none());
    }

    /// lookback=0 must short-circuit cleanly (no divide-by-zero, no panic).
    #[test]
    fn handles_zero_lookback_safely() {
        let candles: Vec<Candle> = (0..30)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p = StopHuntParams {
            lookback: 0,
            required_wick_depth_pct: 0.003,
            close_back_strict: false,
        };
        let v = compute_stop_hunt_vote(&candles, &p);
        assert!(v.is_none());
    }

    /// Fewer than lookback+2 bars → safe None.
    #[test]
    fn handles_too_few_candles() {
        let candles: Vec<Candle> = (0..5)
            .map(|i| ohlcv(i * 1_800_000, 100.0, 100.5, 99.5, 100.0, 100.0))
            .collect();
        let p = StopHuntParams::default_30m_crypto();
        let v = compute_stop_hunt_vote(&candles, &p);
        assert!(v.is_none(), "too few candles → safe None");
    }
}
