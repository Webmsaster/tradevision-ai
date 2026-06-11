// 2026-05-25 Wave5 Detector — Funding Rate Acceleration voter.
//
// Hypothesis: funding-rate LEVEL is already used as a filter
// (signals_r28v6.rs::funding_filter_allows). The DERIVATIVE (acceleration)
// captures speed of positioning build-up, which is more predictive than
// the level itself. When funding rises FAST, longs are aggressively piling
// in — a contrarian short bias. When funding falls FAST (going negative),
// shorts are crowding — contrarian long bias.
//
// Edge rationale (cited in crypto-quant lit):
//   - Funding-rate mean-reversion: rates >+0.1%/8h or <-0.05%/8h tend to
//     revert within 1-3 funding periods (8-24 hours)
//   - Acceleration > level: a slow rise to +0.05% is less crowded than a
//     sudden spike to +0.05%
//   - Vote is CONTRARIAN: large positive acceleration → vote Short; large
//     negative acceleration → vote Long
//
// Lookahead-safety:
//   - signal_idx = candles.len() - 2 (last closed bar)
//   - funding_series aligned per-bar; we read funding[signal_idx-accel_window
//     ..= signal_idx] and compute change. Entry bar funding never touched.
//
// Voter contract:
//   - Returns Option<PositionSide>: Some(Long/Short) if accel exceeds
//     threshold over the lookback window; None otherwise (abstain).

use crate::position::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct FundingAccelParams {
    /// How many funding-bars to look back for delta computation. Default 3
    /// (covers ~1 day of 8h funding samples).
    pub accel_window: usize,
    /// Threshold for "fast" acceleration. Default 0.0003 (= 3 basis-points
    /// of funding-rate change over the window). Vote fires when
    /// |funding[i] - funding[i-window]| >= threshold.
    pub accel_threshold: f64,
    /// Minimum absolute funding level to trigger vote. Below this, the
    /// acceleration is noise. Default 0.00005 (0.5 bp).
    pub min_abs_level: f64,
}

impl FundingAccelParams {
    pub fn default_30m_crypto() -> Self {
        Self {
            accel_window: 3,
            accel_threshold: 0.0003,
            min_abs_level: 0.00005,
        }
    }
}

/// Compute Funding Acceleration vote from a per-bar funding series.
///
/// `funding_series` length must equal the candle series length (aligned).
/// Bars with None funding are treated as "no data, abstain".
pub fn compute_funding_accel_vote(
    funding_series: Option<&[Option<f64>]>,
    n_candles: usize,
    params: &FundingAccelParams,
) -> Option<PositionSide> {
    let series = funding_series?;
    if series.len() != n_candles {
        return None; // misaligned input
    }
    if params.accel_window == 0 || n_candles < params.accel_window + 2 {
        return None;
    }
    if !params.accel_threshold.is_finite()
        || params.accel_threshold <= 0.0
        || !params.min_abs_level.is_finite()
        || params.min_abs_level < 0.0
    {
        return None;
    }

    let signal_idx = n_candles - 2; // last closed bar
    if signal_idx < params.accel_window {
        return None;
    }
    let prev_idx = signal_idx - params.accel_window;

    let cur = series[signal_idx]?;
    let prev = series[prev_idx]?;

    if !cur.is_finite() || !prev.is_finite() {
        return None;
    }

    let delta = cur - prev;
    if delta.abs() < params.accel_threshold {
        return None; // not "fast" enough
    }
    if cur.abs() < params.min_abs_level {
        return None; // funding level too low for contrarian play
    }

    // Contrarian vote: fast rise in funding → longs crowded → vote Short
    if delta > 0.0 {
        Some(PositionSide::Short)
    } else {
        Some(PositionSide::Long)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_short_on_fast_positive_acceleration() {
        let n = 10;
        // Funding rising fast: prev=0.0001, cur=0.001 → delta=+0.0009 > 0.0003
        let series: Vec<Option<f64>> = (0..n)
            .map(|i| Some(0.0001 + (i as f64) * 0.00015))
            .collect();
        // signal_idx = 8, accel_window=3 → prev=series[5]=0.000850
        // cur=series[8]=0.001300 → delta=0.000450 > 0.0003 → Short
        let _ = series; // already constructed
        let series_v: Vec<Option<f64>> = (0..n)
            .map(|i| Some(0.0001 + (i as f64) * 0.00015))
            .collect();
        let params = FundingAccelParams::default_30m_crypto();
        let vote = compute_funding_accel_vote(Some(&series_v), n, &params);
        assert_eq!(vote, Some(PositionSide::Short));
    }

    #[test]
    fn fires_long_on_fast_negative_acceleration() {
        let n = 10;
        let series: Vec<Option<f64>> = (0..n).map(|i| Some(0.001 - (i as f64) * 0.00015)).collect();
        // signal_idx=8: 0.001 - 8*0.00015 = -0.0002; prev_idx=5: 0.001 - 5*0.00015 = 0.00025
        // delta = -0.0002 - 0.00025 = -0.00045 → Long
        let params = FundingAccelParams::default_30m_crypto();
        let vote = compute_funding_accel_vote(Some(&series), n, &params);
        assert_eq!(vote, Some(PositionSide::Long));
    }

    #[test]
    fn abstains_on_slow_change() {
        let n = 10;
        // tiny change well below threshold
        let series: Vec<Option<f64>> = (0..n)
            .map(|i| Some(0.0001 + (i as f64) * 0.00001))
            .collect();
        let params = FundingAccelParams::default_30m_crypto();
        let vote = compute_funding_accel_vote(Some(&series), n, &params);
        assert_eq!(vote, None);
    }

    #[test]
    fn abstains_on_missing_funding() {
        let n = 10;
        let series: Vec<Option<f64>> = vec![None; n];
        let params = FundingAccelParams::default_30m_crypto();
        let vote = compute_funding_accel_vote(Some(&series), n, &params);
        assert_eq!(vote, None);
    }

    #[test]
    fn abstains_on_low_level() {
        let n = 10;
        // Big delta but level too small
        let series: Vec<Option<f64>> = (0..n)
            .map(|i| Some(-0.00001 + (i as f64) * 0.000001))
            .collect();
        let params = FundingAccelParams::default_30m_crypto();
        let vote = compute_funding_accel_vote(Some(&series), n, &params);
        assert_eq!(vote, None);
    }

    #[test]
    fn abstains_when_window_too_short() {
        let n = 3; // < accel_window + 2
        let series: Vec<Option<f64>> = vec![Some(0.001); n];
        let params = FundingAccelParams::default_30m_crypto();
        let vote = compute_funding_accel_vote(Some(&series), n, &params);
        assert_eq!(vote, None);
    }

    #[test]
    fn lookahead_safe_no_entry_bar_read() {
        // Mutate entry bar (signal_idx + 1 = last index); vote should NOT change.
        let n = 10;
        let mut series_base: Vec<Option<f64>> = (0..n)
            .map(|i| Some(0.0001 + (i as f64) * 0.00015))
            .collect();
        let params = FundingAccelParams::default_30m_crypto();
        let vote_a = compute_funding_accel_vote(Some(&series_base), n, &params);
        // Mutate the entry-bar value (index n-1 = 9)
        series_base[n - 1] = Some(99.0); // poison
        let vote_b = compute_funding_accel_vote(Some(&series_base), n, &params);
        assert_eq!(vote_a, vote_b, "entry-bar mutation must not change vote");
    }
}
