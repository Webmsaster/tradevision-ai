// 2026-05-16 Phase 17 — Fisher Transform Voter (Hunt 3 brainstorm).
//
// Fisher Transform (J.F. Ehlers) normalises a rolling price-range to (-1, 1)
// then applies the Fisher transform `y = 0.5 * ln((1+x)/(1-x))` which makes
// the result approximately Gaussian. This Gaussianisation makes "extreme"
// values genuinely calibrated (|fisher| > 2 ≈ 2σ regime). Voting rule fires
// on the cross of the smoothed Fisher series against its 1-bar trigger.
//
// Lookahead-safety: all reads at `signal_idx = candles.len() - 2`. The
// recursion runs ONLY over bars [0..=signal_idx]. The entry bar at
// `candles.len() - 1` is NEVER read.

use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct FisherParams {
    /// Lookback window for high/low normalization. Classic Ehlers default = 9.
    pub period: usize,
    /// Smoothing factor for Fisher EMA. Default α = 0.5 (Ehlers).
    pub alpha: f64,
}

impl Default for FisherParams {
    fn default() -> Self {
        Self {
            period: 9,
            alpha: 0.5,
        }
    }
}

/// Compute Fisher Transform at `signal_idx = candles.len() - 2` and return
/// a vote based on the bar-close-confirmed cross of fisher[t-1] vs trigger
/// (fisher[t-2]). Returns `None` on insufficient warmup or NaN pathology.
pub fn compute_fisher_vote(candles: &[Candle], params: &FisherParams) -> Option<PositionSide> {
    if params.period < 2 || !params.alpha.is_finite() || params.alpha <= 0.0 || params.alpha >= 1.0
    {
        return None;
    }
    // Need: signal_idx = len-2 + 1 lag for cross detection = at least
    // (len - 3) viable signal. Plus `period` bars warmup.
    if candles.len() < params.period + 4 {
        return None;
    }
    let signal_idx = candles.len() - 2;

    // Recursive Fisher series.
    let mut fisher_prev: f64 = 0.0;
    let mut x_prev: f64 = 0.0;
    // Track last 2 fisher values to detect cross at signal_idx and prev.
    let mut fisher_at_signal: Option<f64> = None;
    let mut fisher_at_prev: Option<f64> = None;
    let mut fisher_at_prev_prev: Option<f64> = None;

    for i in 0..=signal_idx {
        if i < params.period - 1 {
            continue;
        }
        // Rolling high/low over period ending at i.
        let lo_start = i + 1 - params.period;
        let mut hi = f64::MIN;
        let mut lo = f64::MAX;
        let mut bad = false;
        for j in lo_start..=i {
            let c = candles[j];
            if !c.high.is_finite() || !c.low.is_finite() {
                bad = true;
                break;
            }
            if c.high > hi {
                hi = c.high;
            }
            if c.low < lo {
                lo = c.low;
            }
        }
        if bad || !(hi.is_finite() && lo.is_finite()) || hi == lo {
            // Hold prior fisher state for poison bars.
            fisher_at_prev_prev = fisher_at_prev;
            fisher_at_prev = fisher_at_signal;
            fisher_at_signal = Some(fisher_prev);
            continue;
        }
        let mid = 0.5 * (candles[i].high + candles[i].low);
        // Normalize to (-1, 1) with hysteresis smoothing on x.
        let raw = 2.0 * (mid - lo) / (hi - lo) - 1.0;
        let raw = raw.clamp(-0.999, 0.999);
        let x = 0.67 * raw + 0.33 * x_prev;
        let x = x.clamp(-0.999, 0.999);
        // Fisher transform + EMA smoothing.
        let fisher_raw = 0.5 * ((1.0 + x) / (1.0 - x)).ln();
        let fisher = params.alpha * fisher_raw + (1.0 - params.alpha) * fisher_prev;
        if !fisher.is_finite() {
            // Hold state on numerical pathology.
            fisher_at_prev_prev = fisher_at_prev;
            fisher_at_prev = fisher_at_signal;
            fisher_at_signal = Some(fisher_prev);
            x_prev = 0.0;
            continue;
        }
        x_prev = x;
        fisher_prev = fisher;
        // Slide tracking window forward.
        fisher_at_prev_prev = fisher_at_prev;
        fisher_at_prev = fisher_at_signal;
        fisher_at_signal = Some(fisher);
    }

    // Vote rule: confirmed cross at signal_idx using strictly past values.
    // Long: fisher[signal_idx] > fisher[signal_idx - 1] AND
    //       fisher[signal_idx - 1] <= fisher[signal_idx - 2]  (cross up turn).
    // Short: mirror.
    let f_s = fisher_at_signal?;
    let f_p = fisher_at_prev?;
    let f_pp = fisher_at_prev_prev?;
    if f_s > f_p && f_p <= f_pp {
        Some(PositionSide::Long)
    } else if f_s < f_p && f_p >= f_pp {
        Some(PositionSide::Short)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::candle::Candle;

    fn mk(h: f64, l: f64, c: f64) -> Candle {
        Candle {
            open_time: 0,
            close_time: 0,
            open: c,
            high: h,
            low: l,
            close: c,
            volume: 1.0,
            taker_buy_volume: Some(0.5),
            is_final: true,
        }
    }

    #[test]
    fn fisher_returns_none_on_short_input() {
        let candles: Vec<Candle> = (0..5)
            .map(|i| mk(i as f64 + 1.0, i as f64, i as f64 + 0.5))
            .collect();
        assert_eq!(
            compute_fisher_vote(&candles, &FisherParams::default()),
            None
        );
    }

    #[test]
    fn fisher_does_not_index_entry_bar() {
        // Build candles, then poison the LAST bar (entry bar) with NaN. If
        // the implementation reads it, fisher should change. We assert
        // result is unchanged.
        let mut candles: Vec<Candle> = (0..30)
            .map(|i| {
                let p = 100.0 + (i as f64).sin();
                mk(p + 0.2, p - 0.2, p)
            })
            .collect();
        let ref_vote = compute_fisher_vote(&candles, &FisherParams::default());
        let last = candles.len() - 1;
        candles[last].high = f64::NAN;
        candles[last].low = f64::NAN;
        candles[last].close = f64::NAN;
        let poisoned_vote = compute_fisher_vote(&candles, &FisherParams::default());
        assert_eq!(
            ref_vote, poisoned_vote,
            "fisher voter must not read entry bar"
        );
    }
}
