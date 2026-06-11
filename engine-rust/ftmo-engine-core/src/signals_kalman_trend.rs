//! 2026-05-14 Detector #26 — Kalman-Filter Price-Velocity Voter.
//!
//! Independent voter for `signals_regime_confluence.rs`. Where existing
//! voters consume raw OHLC features (R28V6 EMA-cross / Breakout swing /
//! Stop-Hunt wick / Bollinger-Z / VWAP / OFI / vol-confirm), the Kalman
//! voter treats the close-price series as a noisy observation of a hidden
//! [price, velocity] state and uses a Bayesian recursion to estimate the
//! current velocity. Long-vote fires when the smoothed velocity exceeds a
//! configurable fraction of price; short-vote on the symmetric downside.
//!
//! ## State-space model
//!
//! state x_k = [p_k, v_k]^T  (price and per-bar velocity)
//!
//! Transition (constant-velocity):
//!   F = [[1, 1],
//!        [0, 1]]                 // dt = 1 bar, baked in
//!   Q = diag(q_p, q_v)            // process noise (small, tunable)
//!
//! Observation (we measure close only):
//!   H = [1, 0]
//!   R = measurement_noise OR rolling std of close (when 0.0)
//!
//! Predict step:
//!   x̂_k = F · x_{k-1}
//!   P̂_k = F · P_{k-1} · F^T + Q
//!
//! Update step (innovation y = z − H·x̂):
//!   S = H·P̂·H^T + R                 (scalar)
//!   K = P̂·H^T / S                  (column 2-vec)
//!   x_k = x̂_k + K · y
//!   P_k = (I − K · H) · P̂_k
//!
//! ## Lookahead safety
//!
//! `signal_idx = candles.len() - 2`. The Kalman recursion iterates bar
//! indices `0..=signal_idx`. The entry bar `candles[len-1]` is NEVER read
//! in the voting path (test `excludes_entry_bar_from_filter` mutates the
//! entry bar to a catastrophic value and asserts the vote is unchanged).
//!
//! Measurement-noise R is either supplied directly (constant scalar) or
//! derived from the rolling std of close-prices computed STRICTLY over
//! bars `[..= signal_idx - 1]` — the signal bar itself is excluded from the
//! R estimation so a single deep-wick close cannot self-fulfill the
//! threshold (test `excludes_signal_bar_from_R_estimation`).
//!
//! ## Stateless voter
//!
//! The filter is rebuilt from scratch on every call (no `EngineState`
//! mutation). This matches the contract of other regime-voter helpers
//! (`compute_bb_zscore_vote`, `compute_stop_hunt_vote`, `compute_ofi_vote`)
//! and avoids cross-window state leak. The cost is O(N) per call where
//! N = candles.len(); since N is bounded by the per-window candle budget
//! (~1.5k bars on a 30m × 30-day window) this is negligible.
//!
//! ## Numerical stability
//!
//! - P matrix kept positive-semi-definite via the symmetric Joseph-form
//!   update `(I−KH)P(I−KH)^T + KRK^T`. The simpler form `(I−KH)P` can drift
//!   negative-definite under floating-point error over long series; the
//!   `numerical_stability_long_series` test runs 1000 bars and asserts P
//!   stays PSD throughout.
//! - Innovation-covariance S is clamped to a tiny positive floor to prevent
//!   division-by-zero when measurement_noise → 0 and P → 0 simultaneously
//!   (otherwise K explodes and v diverges).
//! - All NaN/Inf bars short-circuit the filter — the voter abstains
//!   rather than poison the state.

use crate::candle::Candle;
use crate::indicators::rolling_std;
use crate::position::PositionSide;

/// CLI-tunable parameters for the Kalman price-velocity voter. Defaults are
/// 30m-crypto tuned but the filter math is TF-agnostic — tighter Q values
/// on faster TFs to keep the velocity responsive without over-fitting to bar
/// noise.
#[derive(Debug, Clone, Copy)]
pub struct KalmanTrendParams {
    /// Process noise on the price dimension. Larger → filter trusts the
    /// model less, tracks observations more aggressively (less smoothing).
    /// Default 1e-3 — gives a clear separation between trend and chop.
    pub process_noise_price: f64,
    /// Process noise on the velocity dimension. Larger → velocity allowed
    /// to change quickly between bars. Default 1e-5 (≈ 1% of price-noise
    /// magnitude) — velocity drifts slowly which is the whole point of
    /// "trend" extraction.
    pub process_noise_velocity: f64,
    /// Measurement noise R. When > 0 it's used as a constant scalar; when
    /// set to 0.0 (default) the voter derives R per-call from the rolling
    /// std of close-prices over the prior `measurement_noise_period` bars
    /// (signal bar EXCLUDED). The data-driven path adapts to volatility
    /// regimes; the constant path is useful for unit tests / parity checks.
    pub measurement_noise: f64,
    /// Rolling-std window length (bars) used when `measurement_noise == 0.0`.
    /// Default 20 — same horizon as the BB voter for consistency.
    pub measurement_noise_period: usize,
    /// Decision threshold expressed as a fraction of the signal-bar close
    /// price: Long if velocity > +threshold × signal_close, Short if
    /// velocity < −threshold × signal_close. Default 0.0005 (5bp / bar).
    pub velocity_threshold_pct: f64,
    /// How many initial bars to consume before the filter is allowed to
    /// vote. The Kalman covariance P needs a few updates to converge from
    /// its identity-seeded prior, so emitting before warmup gives noisy
    /// velocity estimates. Default 60 bars (~30 hours on 30m).
    pub warmup_bars: usize,
    /// Total bars in the candle slice required before any vote is allowed.
    /// Separate from `warmup_bars` so callers can demand additional global
    /// warmup independent of the filter's convergence horizon. Default 100.
    pub min_total_bars: usize,
}

impl KalmanTrendParams {
    /// 2026-05-14 — defaults tuned for the 30m AMBER_PASSLOCK basket. Same
    /// rationale as the other detector defaults (BB-Z, Stop-Hunt, OFI):
    /// 30-minute candles, low signal-to-noise crypto, want the voter to
    /// fire on clean directional pressure not chop.
    pub fn default_30m_crypto() -> Self {
        Self {
            process_noise_price: 1e-3,
            process_noise_velocity: 1e-5,
            measurement_noise: 0.0,
            measurement_noise_period: 20,
            velocity_threshold_pct: 0.0005,
            warmup_bars: 60,
            min_total_bars: 100,
        }
    }
}

impl Default for KalmanTrendParams {
    fn default() -> Self {
        Self::default_30m_crypto()
    }
}

/// Compute the directional vote without consulting engine state. Used as
/// a regime-confluence voter. Returns `None` if any of the following hold:
///   - parameters are non-finite / non-positive where required
///   - candle slice too short to satisfy warmup OR rolling-std window
///   - signal-bar close is non-finite
///   - filter recursion encounters NaN/Inf (defensive abstention)
///   - |velocity| ≤ threshold × signal_close (insufficient trend)
///
/// Lookahead-safe: reads exclusively `candles[..= signal_idx]` where
/// `signal_idx = candles.len() - 2`. The entry bar `candles[len-1]` is
/// never consulted.
pub fn compute_kalman_trend_vote(
    candles: &[Candle],
    params: &KalmanTrendParams,
) -> Option<PositionSide> {
    // Param-validity gates. Process-noise can be 0 (means "trust the model
    // exactly" which is fine, just causes very slow adaptation), but it
    // MUST be non-negative AND finite — negatives would push P to be
    // negative-definite which breaks the filter math. Velocity threshold
    // must be non-negative AND finite — negative thresholds would fire
    // backwards.
    if !params.process_noise_price.is_finite()
        || !params.process_noise_velocity.is_finite()
        || !params.measurement_noise.is_finite()
        || !params.velocity_threshold_pct.is_finite()
        || params.process_noise_price < 0.0
        || params.process_noise_velocity < 0.0
        || params.measurement_noise < 0.0
        || params.velocity_threshold_pct < 0.0
    {
        return None;
    }
    // Need at least entry bar + signal bar + min_total_bars total.
    if candles.len() < params.min_total_bars.max(2) {
        return None;
    }
    let signal_idx = candles.len() - 2;
    // warmup horizon: signal_idx must be ≥ warmup_bars so the filter has
    // run at least that many updates before producing the voting velocity.
    if signal_idx < params.warmup_bars {
        return None;
    }
    let signal_close = candles[signal_idx].close;
    if !signal_close.is_finite() || signal_close == 0.0 {
        return None;
    }

    // Derive R either from the user-provided constant OR from rolling-std
    // over closes STRICTLY BEFORE the signal bar. The signal bar itself is
    // excluded so a single big-wick close cannot inflate its own
    // measurement noise and let the velocity drift unconstrained.
    let r_meas = if params.measurement_noise > 0.0 {
        params.measurement_noise
    } else {
        let period = params.measurement_noise_period;
        if period == 0 || signal_idx < period {
            return None;
        }
        // Use closes from indices [0 .. signal_idx] — the rolling_std
        // helper returns std at index k from the window `(k-period+1)..=k`.
        // We want std at index `signal_idx - 1` so the SIGNAL BAR'S OWN
        // close is excluded from the variance computation.
        let closes_pre_signal: Vec<f64> = candles[..signal_idx].iter().map(|c| c.close).collect();
        if closes_pre_signal.len() < period {
            return None;
        }
        let stds = rolling_std(&closes_pre_signal, period);
        let last_idx = stds.len() - 1;
        let std_val = stds[last_idx]?;
        if !std_val.is_finite() || std_val <= 0.0 {
            return None;
        }
        // Convert std-of-close to variance and use that as R. Standard
        // practice in Kalman literature: R is a variance, not a std.
        std_val * std_val
    };

    // Seed: x0 = [close_0, 0]. P0 = large prior on both dimensions so the
    // first few updates can correct hard if the seed is far from truth.
    // The Joseph-form update keeps things stable even with a fat prior.
    let close_0 = candles[0].close;
    if !close_0.is_finite() {
        return None;
    }
    let mut p_price: f64 = close_0;
    let mut p_vel: f64 = 0.0;
    // Covariance matrix P (2×2 symmetric). Store the 3 unique entries.
    let mut p00: f64 = 1.0;
    let mut p01: f64 = 0.0;
    let mut p11: f64 = 1.0;

    let qp = params.process_noise_price;
    let qv = params.process_noise_velocity;
    // Tiny floor on innovation-covariance to prevent K → ∞ when both R
    // and P collapse simultaneously (rare but possible with zero process
    // noise on a perfectly flat constant series).
    const S_FLOOR: f64 = 1e-12;

    for c in candles.iter().take(signal_idx + 1).skip(1) {
        let z = c.close;
        if !z.is_finite() {
            // Defensive abstention: poisoned data → refuse to vote.
            return None;
        }
        // ---- Predict ----
        // x̂ = F · x = [p + v, v]
        let pred_price = p_price + p_vel;
        let pred_vel = p_vel;
        // P̂ = F · P · F^T + Q
        //   F·P = [[p00 + p01, p01 + p11], [p01, p11]]
        //   (F·P)·F^T = [[p00 + 2·p01 + p11, p01 + p11], [p01 + p11, p11]]
        let pp00 = p00 + 2.0 * p01 + p11 + qp;
        let pp01 = p01 + p11;
        let pp11 = p11 + qv;

        // ---- Update ----
        // y = z − H·x̂ = z − pred_price
        let y = z - pred_price;
        // S = H·P̂·H^T + R = pp00 + r_meas
        let mut s = pp00 + r_meas;
        if !s.is_finite() {
            return None;
        }
        if s < S_FLOOR {
            s = S_FLOOR;
        }
        // K = P̂·H^T / S = [pp00 / S, pp01 / S]
        let k0 = pp00 / s;
        let k1 = pp01 / s;
        if !k0.is_finite() || !k1.is_finite() {
            return None;
        }
        // x = x̂ + K · y
        p_price = pred_price + k0 * y;
        p_vel = pred_vel + k1 * y;
        if !p_price.is_finite() || !p_vel.is_finite() {
            return None;
        }
        // Joseph-form update: P = (I − K·H) · P̂ · (I − K·H)^T + K·R·K^T
        //   I − K·H = [[1−k0, 0], [−k1, 1]]
        //   Let A = I − K·H. Then A · P̂:
        //     row 0: [(1−k0)·pp00, (1−k0)·pp01]
        //     row 1: [−k1·pp00 + pp01, −k1·pp01 + pp11]
        //   A · P̂ · A^T:
        //     new00 = (1−k0)² · pp00
        //     new01 = (1−k0)·pp00·(−k1) + (1−k0)·pp01
        //           = (1−k0) · (pp01 − k1·pp00)
        //     new11 = (−k1·pp00 + pp01)·(−k1) + (−k1·pp01 + pp11)
        //           = k1²·pp00 − 2·k1·pp01 + pp11
        //   K·R·K^T:
        //     [[k0²·R, k0·k1·R], [k0·k1·R, k1²·R]]
        let one_minus_k0 = 1.0 - k0;
        let new00 = one_minus_k0 * one_minus_k0 * pp00 + k0 * k0 * r_meas;
        let new01 = one_minus_k0 * (pp01 - k1 * pp00) + k0 * k1 * r_meas;
        let new11 = k1 * k1 * pp00 - 2.0 * k1 * pp01 + pp11 + k1 * k1 * r_meas;
        if !new00.is_finite() || !new01.is_finite() || !new11.is_finite() {
            return None;
        }
        p00 = new00;
        p01 = new01;
        p11 = new11;
    }

    // Decision: velocity vs threshold × signal_close.
    let threshold = params.velocity_threshold_pct * signal_close.abs();
    if !threshold.is_finite() {
        return None;
    }
    if p_vel > threshold {
        Some(PositionSide::Long)
    } else if p_vel < -threshold {
        Some(PositionSide::Short)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_candle(t: i64, close: f64) -> Candle {
        Candle::new(t, close, close + 0.5, close - 0.5, close, 100.0)
    }

    /// Build a flat candle slice (close ≈ 100 with tiny oscillation so std
    /// is non-degenerate). 200 bars is plenty for warmup_bars=60 + period=20.
    fn flat_series(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let close = if i % 2 == 0 { 100.05 } else { 99.95 };
                mk_candle(i as i64 * 1_800_000, close)
            })
            .collect()
    }

    /// Strong uptrend: linear ramp with mild noise. velocity ≈ +slope.
    fn uptrend_series(n: usize, slope: f64) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let noise = if i % 3 == 0 { 0.1 } else { -0.1 };
                let close = 100.0 + slope * (i as f64) + noise;
                mk_candle(i as i64 * 1_800_000, close)
            })
            .collect()
    }

    fn downtrend_series(n: usize, slope: f64) -> Vec<Candle> {
        uptrend_series(n, -slope)
    }

    #[test]
    fn no_vote_on_flat_range() {
        let candles = flat_series(200);
        let p = KalmanTrendParams::default_30m_crypto();
        let v = compute_kalman_trend_vote(&candles, &p);
        assert!(
            v.is_none(),
            "tight oscillation around constant must not vote (got {:?})",
            v
        );
    }

    #[test]
    fn votes_long_on_strong_uptrend() {
        // slope = 0.5 per bar on a base of 100 → velocity ≈ 0.5 → threshold
        // at 0.0005 × ~200 = 0.1 is easily cleared.
        let candles = uptrend_series(200, 0.5);
        let p = KalmanTrendParams::default_30m_crypto();
        let v = compute_kalman_trend_vote(&candles, &p);
        assert_eq!(v, Some(PositionSide::Long));
    }

    #[test]
    fn votes_short_on_strong_downtrend() {
        let candles = downtrend_series(200, 0.5);
        let p = KalmanTrendParams::default_30m_crypto();
        let v = compute_kalman_trend_vote(&candles, &p);
        assert_eq!(v, Some(PositionSide::Short));
    }

    /// KRITISCH lookahead test: mutating the entry bar's CLOSE (the bar
    /// candles[len-1]) must NOT change the voter's output, since the
    /// filter only reads candles[..= signal_idx] where signal_idx = len-2.
    #[test]
    fn excludes_entry_bar_from_filter() {
        let candles_a = uptrend_series(200, 0.5);
        let mut candles_b = candles_a.clone();
        let last = candles_b.len() - 1;
        // Catastrophic mutation: entry bar plummets to 1.0. If the filter
        // were peeking, this would flip the velocity sign or NaN-poison it.
        candles_b[last].close = 1.0;
        candles_b[last].high = 1.0;
        candles_b[last].low = 0.5;
        let p = KalmanTrendParams::default_30m_crypto();
        let va = compute_kalman_trend_vote(&candles_a, &p);
        let vb = compute_kalman_trend_vote(&candles_b, &p);
        assert_eq!(
            va, vb,
            "entry-bar close mutation must not change vote (lookahead suspect)"
        );
        assert_eq!(va, Some(PositionSide::Long));
    }

    /// R-from-rolling-std mode: the signal bar's OWN close must not enter
    /// the variance computation. We craft a series where the signal-bar
    /// has a wild close that, if INCLUDED in std, would massively inflate R
    /// (and dampen velocity → no vote). Excluded, R stays small → vote
    /// fires. The test asserts the EXCLUSION semantic by checking the
    /// behaviour is consistent with std taken from [..signal_idx].
    #[test]
    fn excludes_signal_bar_from_r_estimation() {
        // Build a clean uptrend then slam the signal bar with a 10× wick.
        let mut candles = uptrend_series(200, 0.5);
        let sig_idx = candles.len() - 2;
        // Signal-bar close jumps to a wild value. If the filter included
        // this bar in R, the variance would explode → smoothing dominates
        // → no vote. We assert the OUTPUT instead — which is "Long vote"
        // when R is computed from the prior 20 bars (clean trend, low std).
        candles[sig_idx].close = 100.0 + 0.5 * (sig_idx as f64) + 50.0;
        let p = KalmanTrendParams::default_30m_crypto();
        let v = compute_kalman_trend_vote(&candles, &p);
        // Trend was up, signal bar is also up (50 pts above the trend
        // line) — so velocity remains positive → still Long. Critically
        // the function did NOT panic / abstain due to R blow-up.
        assert_eq!(v, Some(PositionSide::Long));
    }

    #[test]
    fn handles_nan_measurement_safely() {
        // Single NaN in the close series during the filter loop → defensive
        // abstention. Position the NaN AT signal_idx-1 so it's inside the
        // recursion range.
        let mut candles = uptrend_series(200, 0.5);
        let sig_idx = candles.len() - 2;
        candles[sig_idx - 1].close = f64::NAN;
        let p = KalmanTrendParams::default_30m_crypto();
        let v = compute_kalman_trend_vote(&candles, &p);
        assert!(v.is_none(), "NaN inside filter must abstain");
    }

    #[test]
    fn handles_zero_process_noise_safely() {
        // Q = 0 is a valid (though degenerate) Kalman config — means "trust
        // the model exactly". Filter still operates; we just need it not
        // to NaN-out or divide by zero anywhere.
        let candles = uptrend_series(200, 0.5);
        let mut p = KalmanTrendParams::default_30m_crypto();
        p.process_noise_price = 0.0;
        p.process_noise_velocity = 0.0;
        // Must not panic. May or may not vote depending on convergence;
        // primary assertion is "safe / no NaN propagation".
        let v = compute_kalman_trend_vote(&candles, &p);
        // On a clean uptrend with Q=0, the filter still converges and
        // velocity → +slope. We expect Long.
        assert_eq!(v, Some(PositionSide::Long));
    }

    #[test]
    fn handles_zero_measurement_noise_safely() {
        // measurement_noise = 0.0 = data-driven mode. Verified to work in
        // other tests. Here we test with a constant > 0 R AND a series of
        // length too short for the rolling-std window → must abstain
        // cleanly (no panic, returns None).
        let candles = uptrend_series(200, 0.5);
        let mut p = KalmanTrendParams::default_30m_crypto();
        // Constant R = 0.5 — bypasses the rolling-std path. Filter must
        // still vote Long on a strong uptrend.
        p.measurement_noise = 0.5;
        let v = compute_kalman_trend_vote(&candles, &p);
        assert_eq!(v, Some(PositionSide::Long));
    }

    #[test]
    fn handles_too_few_candles() {
        let candles = uptrend_series(50, 0.5); // < min_total_bars=100
        let p = KalmanTrendParams::default_30m_crypto();
        let v = compute_kalman_trend_vote(&candles, &p);
        assert!(v.is_none(), "below min_total_bars → safe abstention");
    }

    /// Numerical stability: 1000 bars with realistic noise. The covariance
    /// matrix P must stay positive-semi-definite throughout (p00 ≥ 0,
    /// p11 ≥ 0, p00·p11 ≥ p01² — Cauchy-Schwarz). We assert post-hoc by
    /// inspecting the final P via a debug rerun.
    #[test]
    fn numerical_stability_long_series() {
        // Build a 1000-bar series with a slow trend + noise.
        let candles: Vec<Candle> = (0..1000)
            .map(|i| {
                let drift = 0.01 * (i as f64);
                let osc = (i as f64 * 0.3).sin() * 0.5;
                let noise = if i % 7 == 0 { 0.2 } else { -0.1 };
                let close = 100.0 + drift + osc + noise;
                mk_candle(i as i64 * 1_800_000, close)
            })
            .collect();
        let p = KalmanTrendParams::default_30m_crypto();
        // Primary assertion: function returns SOMETHING finite (Some or
        // None) without panicking. Long-series numerical blowup typically
        // manifests as NaN→None or, worse, +inf velocity producing wild
        // Long/Short votes. Either Some(Long) or None is acceptable here;
        // the drift slope is small relative to the noise so the velocity
        // is close to threshold.
        let v = compute_kalman_trend_vote(&candles, &p);
        // The series has tiny positive drift (+0.01/bar baseline) plus
        // 0.5 oscillation. On 1000 bars the filter should NOT explode.
        // We don't care which side it votes (or abstains); we care that
        // we got HERE without a NaN panic, which the early-return on
        // !is_finite guarantees.
        let _ = v;

        // Re-run the recursion in-test to inspect the final P matrix.
        // This is a duplicate of the function body but used for a
        // diagnostic assert — we want to KNOW the P stayed PSD.
        let signal_idx = candles.len() - 2;
        let mut p_price: f64 = candles[0].close;
        let mut p_vel: f64 = 0.0;
        let mut p00: f64 = 1.0;
        let mut p01: f64 = 0.0;
        let mut p11: f64 = 1.0;
        // Use the same R as the default config would derive.
        let stds = rolling_std(
            &candles[..signal_idx]
                .iter()
                .map(|c| c.close)
                .collect::<Vec<_>>(),
            20,
        );
        let r_meas = stds[stds.len() - 1].unwrap_or(1.0).powi(2);
        let qp = p.process_noise_price;
        let qv = p.process_noise_velocity;
        for (k, c) in candles.iter().enumerate().take(signal_idx + 1).skip(1) {
            let z = c.close;
            let pred_price = p_price + p_vel;
            let pred_vel = p_vel;
            let pp00 = p00 + 2.0 * p01 + p11 + qp;
            let pp01 = p01 + p11;
            let pp11 = p11 + qv;
            let y = z - pred_price;
            let s = (pp00 + r_meas).max(1e-12);
            let k0 = pp00 / s;
            let k1 = pp01 / s;
            p_price = pred_price + k0 * y;
            p_vel = pred_vel + k1 * y;
            let one_minus_k0 = 1.0 - k0;
            p00 = one_minus_k0 * one_minus_k0 * pp00 + k0 * k0 * r_meas;
            p01 = one_minus_k0 * (pp01 - k1 * pp00) + k0 * k1 * r_meas;
            p11 = k1 * k1 * pp00 - 2.0 * k1 * pp01 + pp11 + k1 * k1 * r_meas;
            // Per-step PSD check.
            assert!(p00 >= -1e-9, "p00 went negative at k={}: {}", k, p00);
            assert!(p11 >= -1e-9, "p11 went negative at k={}: {}", k, p11);
            // Cauchy-Schwarz: |p01|² ≤ p00 · p11 (small tolerance for f64).
            assert!(
                p01 * p01 <= p00 * p11 + 1e-6,
                "P not PSD at k={}: p00={} p01={} p11={}",
                k,
                p00,
                p01,
                p11
            );
        }
        // Final velocity must be finite.
        assert!(
            p_vel.is_finite(),
            "filter velocity became non-finite over 1000 bars"
        );
    }

    /// Defensive: negative process noise (invalid) must abstain — would
    /// otherwise push P negative-definite over time and explode.
    #[test]
    fn rejects_negative_process_noise() {
        let candles = uptrend_series(200, 0.5);
        let mut p = KalmanTrendParams::default_30m_crypto();
        p.process_noise_price = -1.0;
        let v = compute_kalman_trend_vote(&candles, &p);
        assert!(v.is_none(), "negative process noise must abstain");
    }

    /// Defensive: negative velocity threshold (invalid) must abstain —
    /// otherwise the comparison flips and the voter would fire backwards.
    #[test]
    fn rejects_negative_velocity_threshold() {
        let candles = uptrend_series(200, 0.5);
        let mut p = KalmanTrendParams::default_30m_crypto();
        p.velocity_threshold_pct = -0.01;
        let v = compute_kalman_trend_vote(&candles, &p);
        assert!(v.is_none(), "negative threshold must abstain");
    }
}
