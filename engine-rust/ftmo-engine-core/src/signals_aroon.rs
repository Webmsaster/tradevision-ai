// 2026-05-14 Detector #17 — Aroon Oscillator voter.
//
// The Aroon indicator (Tushar Chande, 1995) measures the *time since* the
// last N-period swing-high vs swing-low — orthogonal to price-distance
// signals (Breakout, BB Z-score) and to volume signals (vol_confirm, OFI).
//
//   Aroon-Up(n)   = (n - bars_since_highest_high(n)) / n * 100
//   Aroon-Down(n) = (n - bars_since_lowest_low (n)) / n * 100
//
// 100 means "the extreme happened on the most recent bar"; 0 means "it
// happened exactly n bars ago".
//
// Two voting modes:
//   * `Threshold`  — Long when `aroon_up >= up_threshold` AND `aroon_down <= down_threshold`.
//   * `Crossover`  — Long when Aroon-Up crosses ABOVE Aroon-Down on the
//                    signal bar (previous bar had up <= down, signal bar has
//                    up > down + min_separation). Symmetric for Short.
//
// LOOKAHEAD safety: the helper consults only `candles[..= signal_idx]` where
// `signal_idx = candles.len() - 2`. The bar at `len() - 1` is the execution
// bar whose close is future data — never read.
//
// LAST-OCCURRENCE tie-breaking: when multiple bars in the window share the
// same high (or low) value, the *most recent* index wins.

use crate::candle::Candle;
use crate::position::PositionSide;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AroonMode {
    Threshold,
    Crossover,
}

#[derive(Debug, Clone, Copy)]
pub struct AroonParams {
    pub period: usize,
    pub mode: AroonMode,
    pub up_threshold: f64,
    pub down_threshold: f64,
    /// Only used in `Crossover` mode. Minimum (up - down) separation on the
    /// signal bar for a Long crossover (or (down - up) for Short). Filters
    /// noise-flips where up and down hover within a few percent of each other.
    pub min_separation: f64,
}

impl Default for AroonParams {
    fn default() -> Self {
        Self {
            period: 14,
            mode: AroonMode::Threshold,
            up_threshold: 70.0,
            down_threshold: 30.0,
            min_separation: 30.0,
        }
    }
}

impl AroonParams {
    pub fn default_30m_crypto() -> Self {
        Self::default()
    }
}

/// Compute Aroon-Up and Aroon-Down on the inclusive window
/// `[signal_idx + 1 - period ..= signal_idx]`. Uses LAST-occurrence
/// tie-breaking so flat-data ties produce the higher (more recent) reading.
///
/// Returns None if the window contains a non-finite high or low.
fn compute_aroon_values(
    candles: &[Candle],
    signal_idx: usize,
    period: usize,
) -> Option<(f64, f64)> {
    if period == 0 {
        return None;
    }
    if signal_idx + 1 < period {
        return None;
    }
    let start_idx = signal_idx + 1 - period;
    let mut highest_h = f64::MIN;
    let mut highest_off: usize = 0;
    let mut lowest_l = f64::MAX;
    let mut lowest_off: usize = 0;
    for off in 0..period {
        let c = &candles[start_idx + off];
        if !c.high.is_finite() || !c.low.is_finite() {
            return None;
        }
        if c.high >= highest_h {
            highest_h = c.high;
            highest_off = off;
        }
        if c.low <= lowest_l {
            lowest_l = c.low;
            lowest_off = off;
        }
    }
    let last_off = period - 1;
    let bars_since_h = (last_off - highest_off) as f64;
    let bars_since_l = (last_off - lowest_off) as f64;
    let n = period as f64;
    let aroon_up = (n - bars_since_h) / n * 100.0;
    let aroon_down = (n - bars_since_l) / n * 100.0;
    Some((aroon_up, aroon_down))
}

/// Compute an Aroon-based directional vote for the regime-confluence panel.
///
/// signal_idx is `candles.len() - 2`. The execution bar (`candles.len() - 1`)
/// is NEVER consulted.
pub fn compute_aroon_vote(
    candles: &[Candle],
    params: &AroonParams,
) -> Option<PositionSide> {
    let period = params.period;
    if period == 0 {
        return None;
    }
    let min_needed = match params.mode {
        AroonMode::Threshold => period + 1,
        AroonMode::Crossover => period + 2,
    };
    if candles.len() < min_needed {
        return None;
    }
    let signal_idx = candles.len() - 2;
    let (up_now, down_now) = compute_aroon_values(candles, signal_idx, period)?;
    if !up_now.is_finite() || !down_now.is_finite() {
        return None;
    }
    match params.mode {
        AroonMode::Threshold => {
            if up_now >= params.up_threshold && down_now <= params.down_threshold {
                return Some(PositionSide::Long);
            }
            if down_now >= params.up_threshold && up_now <= params.down_threshold {
                return Some(PositionSide::Short);
            }
            None
        }
        AroonMode::Crossover => {
            if signal_idx < 1 {
                return None;
            }
            let (up_prev, down_prev) = compute_aroon_values(candles, signal_idx - 1, period)?;
            if !up_prev.is_finite() || !down_prev.is_finite() {
                return None;
            }
            let min_sep = params.min_separation.max(0.0);
            if up_prev <= down_prev && (up_now - down_now) > min_sep {
                return Some(PositionSide::Long);
            }
            if down_prev <= up_prev && (down_now - up_now) > min_sep {
                return Some(PositionSide::Short);
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ohlcv(t: i64, o: f64, h: f64, l: f64, c: f64, v: f64) -> Candle {
        Candle::new(t, o, h, l, c, v)
    }

    fn uniform_bars(n: usize, hi: f64, lo: f64) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                ohlcv(
                    i as i64 * 1_800_000,
                    (hi + lo) / 2.0,
                    hi,
                    lo,
                    (hi + lo) / 2.0,
                    100.0,
                )
            })
            .collect()
    }

    #[test]
    fn no_vote_on_flat_range() {
        let candles = uniform_bars(20, 100.5, 99.5);
        let p = AroonParams::default();
        let v = compute_aroon_vote(&candles, &p);
        assert!(v.is_none(), "flat market: up==down==100 → no vote");
    }

    #[test]
    fn long_vote_when_recent_high_and_old_low() {
        let mut candles = uniform_bars(15, 100.5, 99.5);
        candles[0].low = 95.0;
        candles[13].high = 110.0;
        let p = AroonParams {
            period: 14,
            mode: AroonMode::Threshold,
            up_threshold: 70.0,
            down_threshold: 30.0,
            min_separation: 30.0,
        };
        let v = compute_aroon_vote(&candles, &p);
        assert_eq!(v, Some(PositionSide::Long));
    }

    #[test]
    fn lookahead_safe_signal_bar_is_i_minus_one() {
        let mut candles = uniform_bars(15, 100.5, 99.5);
        candles[14].high = 999.0;
        candles[14].low = 1.0;
        let p = AroonParams::default();
        let v = compute_aroon_vote(&candles, &p);
        assert!(v.is_none(), "execution bar must NEVER influence the vote");
    }

    #[test]
    fn period_zero_safe_none() {
        let candles = uniform_bars(20, 100.5, 99.5);
        let p = AroonParams {
            period: 0,
            ..AroonParams::default()
        };
        let v = compute_aroon_vote(&candles, &p);
        assert!(v.is_none());
    }

    #[test]
    fn too_few_candles_safe_none() {
        let candles = uniform_bars(5, 100.5, 99.5);
        let p = AroonParams::default();
        let v = compute_aroon_vote(&candles, &p);
        assert!(v.is_none());
    }

    #[test]
    fn nan_high_safe_none() {
        let mut candles = uniform_bars(15, 100.5, 99.5);
        candles[7].high = f64::NAN;
        let p = AroonParams::default();
        let v = compute_aroon_vote(&candles, &p);
        assert!(v.is_none(), "NaN inside window must produce safe None");
    }

    #[test]
    fn crossover_min_separation_filters_tight() {
        let mut candles = uniform_bars(16, 100.5, 99.5);
        // PREV window dominant high anchor (bar 0) is OUT of signal window.
        candles[0].high = 120.0;
        // Mid-window low anchor (bar 6) lives in both windows.
        candles[6].low = 88.0;
        // Signal-window highest high anchor (bar 8) — bar 0 already gone.
        candles[8].high = 110.0;

        let p_strict = AroonParams {
            period: 14,
            mode: AroonMode::Crossover,
            up_threshold: 70.0,
            down_threshold: 30.0,
            min_separation: 30.0,
        };
        let v_strict = compute_aroon_vote(&candles, &p_strict);
        assert!(
            v_strict.is_none(),
            "spread (~14) < min_separation=30 must reject the crossover"
        );

        let p_loose = AroonParams {
            min_separation: 5.0,
            ..p_strict
        };
        let v_loose = compute_aroon_vote(&candles, &p_loose);
        assert_eq!(
            v_loose,
            Some(PositionSide::Long),
            "with min_sep=5, spread ~14 qualifies → Long vote"
        );
    }

    #[test]
    fn threshold_mode_long_needs_both_conditions() {
        let mut candles = uniform_bars(15, 100.5, 99.5);
        candles[13].high = 110.0;
        candles[12].low = 95.0;
        let p = AroonParams {
            period: 14,
            mode: AroonMode::Threshold,
            up_threshold: 70.0,
            down_threshold: 30.0,
            min_separation: 30.0,
        };
        let v = compute_aroon_vote(&candles, &p);
        assert!(v.is_none(), "high up alone must NOT fire Long when down also high");
    }

    #[test]
    fn last_occurrence_tie_breaking_high() {
        let mut candles = uniform_bars(15, 100.5, 99.5);
        candles[3].high = 105.0;
        candles[10].high = 105.0;
        candles[0].low = 80.0;
        let p = AroonParams::default();
        let v = compute_aroon_vote(&candles, &p);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "tied highs must resolve to the LATER index → Aroon-Up ≈ 78.57 ≥ 70"
        );
    }
}
