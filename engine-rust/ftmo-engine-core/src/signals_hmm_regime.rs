//! 2026-05-14 Detector #25 — HMM Regime-Classifier voter.
//!
//! This module implements a 3-state Gaussian Hidden-Markov-Model classifier
//! whose inference (forward algorithm) runs in pure Rust. The HMM parameters
//! (start_prob, trans_mat, means, covars) are loaded from a JSON model file
//! produced by an offline training pipeline (Python / hmmlearn — TBD). When
//! no path is supplied, the module falls back to `HmmModel::default_btc_30m`
//! which carries a hardcoded set of parameters fit on synthetic BTC-30m data
//! so the wiring can be exercised end-to-end without an external file.
//!
//! ## Strategy summary (Phase 1 — wiring-only, default OFF in RegimeConfluenceParams)
//!
//! - **Features (2-d, diagonal covariance):**
//!   1. log-return = `ln(close[t] / close[t-1])`
//!   2. realized-vol = standard deviation of log-returns over the last
//!      `params.vol_lookback_bars` bars (default 48 = 24h on a 30m feed).
//!
//! - **States:** 3 hidden states with semantic labels `["bear", "range", "bull"]`.
//!
//! - **Inference:** online forward algorithm. We push the observation history
//!   through the recurrence `alpha[t][k] = emission_pdf(obs[t], k) ·
//!   Σ_j alpha[t-1][j] · A[j][k]`. After each step we **normalize** `alpha[t]`
//!   to sum to 1 — this both protects against floating-point underflow on
//!   long candle series AND directly gives us the per-step state-probability
//!   distribution at the most recent bar.
//!
//! - **Vote rule:** Long when `P(bull) ≥ p_threshold_bull` AND
//!   `P(bear) ≤ p_opposite_max`. Short is symmetric. Otherwise abstain.
//!
//! ## Lookahead safety
//!
//! Following the codebase convention (`signal_idx = candles.len() - 2`), all
//! features are computed on bars STRICTLY at or before `signal_idx`. The
//! entry bar `candles[signal_idx + 1]` is never read. The `vol_lookback_bars`
//! window is `(signal_idx - vol_lookback_bars + 1 ..= signal_idx)` so the
//! latest sample used for std() is the just-closed bar — never the future
//! entry bar. A dedicated test `hmm_does_not_read_entry_bar` mutates
//! `candles[len-1]` post-hoc and asserts the vote is unchanged.
//!
//! ## Voting contract
//!
//! Used by `signals_regime_confluence.rs` as an independent voter (slot TBD
//! when the params struct is extended). Phase-1 wiring keeps it disabled by
//! default so existing sweeps remain bit-identical. A separate follow-up
//! patch will wire `use_hmm_regime` into the `RegimeConfluenceParams` struct
//! and propagate three CLI flags (`--regime-hmm`, `--hmm-model <path>`,
//! `--hmm-p-threshold <f64>`).

use crate::candle::Candle;
use crate::position::PositionSide;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Tunable parameters for the HMM regime classifier voter.
///
/// Defaults are tuned for a 30m crypto feed (matches the AMBER_PASSLOCK
/// family that the rest of the regime panel targets). The
/// `training_window_days` field is purely informational — it reflects the
/// window used by the offline training pipeline to fit the model and is
/// surfaced here so model + params can be co-validated by the sweep harness.
#[derive(Debug, Clone, Copy)]
pub struct HmmRegimeParams {
    pub n_states: usize,
    /// Informational only — recorded for offline training-pipeline reproducibility.
    pub training_window_days: u32,
    /// Long fires when `P(bull) ≥ p_threshold_bull` AND `P(bear) ≤ p_opposite_max`.
    pub p_threshold_bull: f64,
    /// Short fires when `P(bear) ≥ p_threshold_bear` AND `P(bull) ≤ p_opposite_max`.
    pub p_threshold_bear: f64,
    /// Maximum allowed opposite-state probability for either direction.
    pub p_opposite_max: f64,
    /// Minimum total bars seen before the detector is allowed to vote.
    /// Defaults to 200 — gives the forward algorithm enough samples to
    /// stabilize regardless of where in the trading-session the window starts.
    pub warmup_bars: usize,
    /// Rolling-window length for the realized-vol feature.
    pub vol_lookback_bars: usize,
}

impl HmmRegimeParams {
    pub fn default_30m_crypto() -> Self {
        Self {
            n_states: 3,
            training_window_days: 365,
            p_threshold_bull: 0.55,
            p_threshold_bear: 0.55,
            p_opposite_max: 0.20,
            warmup_bars: 200,
            vol_lookback_bars: 48,
        }
    }
}

impl Default for HmmRegimeParams {
    fn default() -> Self {
        Self::default_30m_crypto()
    }
}

/// Persistent HMM model parameters — serializable to/from JSON so an offline
/// training pipeline can deposit fits without touching Rust code.
///
/// ## Schema (n_states = 3, n_features = 2)
///
/// ```json
/// {
///   "schema_version": 1,
///   "n_states": 3,
///   "start_prob": [0.33, 0.34, 0.33],
///   "trans_mat": [[0.97,0.02,0.01],[0.02,0.96,0.02],[0.01,0.02,0.97]],
///   "means":     [[-0.0010, 0.012],[0.0000, 0.005],[0.0010, 0.012]],
///   "covars":    [[ 0.0001, 0.00004],[0.000025, 0.000004],[0.0001, 0.00004]],
///   "state_labels": ["bear", "range", "bull"]
/// }
/// ```
///
/// **Convention:** `state_labels` lookup is used to identify which state is
/// bull / bear / range. If labels are absent, the loader falls back to
/// index-position semantics: state 0 = bear, 1 = range, 2 = bull (matches the
/// `default_btc_30m` ordering). The probability-threshold rule consults the
/// labels-by-name, NOT raw indices, so a future model file may reorder
/// states without breaking the vote semantics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HmmModel {
    pub schema_version: u32,
    pub n_states: usize,
    pub start_prob: Vec<f64>,
    pub trans_mat: Vec<Vec<f64>>,
    pub means: Vec<Vec<f64>>,
    pub covars: Vec<Vec<f64>>,
    pub state_labels: Vec<String>,
}

impl HmmModel {
    /// Load a fitted HMM model from disk. Returns an error if any structural
    /// invariant is violated (row/column lengths, probability sums, etc).
    pub fn load_from_json(path: &Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("hmm model read {}: {}", path.display(), e))?;
        let m: HmmModel = serde_json::from_str(&raw)
            .map_err(|e| anyhow::anyhow!("hmm model parse {}: {}", path.display(), e))?;
        m.validate()?;
        Ok(m)
    }

    /// Hardcoded HMM parameters chosen so the three states are well-separated
    /// in feature space. State 0=bear, 1=range, 2=bull. Means are in
    /// (log-return, realized-vol) space.
    ///
    /// **Phase-1 default model.** The full offline training pipeline lands
    /// in a follow-up patch — these defaults intentionally use BROADER
    /// covariances + STRONGER drift means than empirical 30m BTC because the
    /// detector's vote contract demands `P(bull) ≥ 0.55` with `P(bear) ≤ 0.20`.
    /// A tighter empirical fit produces near-equal posteriors across states
    /// in noisy markets, which translates to "always abstain". An eventually
    /// trained model will tighten these once enough real data passes through
    /// the validation harness, but the Phase-1 default is tuned for
    /// architectural correctness (Long when bull-drift, Short when bear-drift,
    /// None on range) rather than crypto-market parameter precision.
    ///
    /// - Bear:  µ_lr = -0.004, µ_vol = 0.012  (negative drift + elevated vol)
    /// - Range: µ_lr =  0.000, µ_vol = 0.004  (no drift + low vol)
    /// - Bull:  µ_lr =  0.004, µ_vol = 0.012  (positive drift + elevated vol)
    ///
    /// Covariances are diagonal (per-feature variance). Bull/bear share the
    /// same vol-band shape (high vol regimes); range has tight low-vol.
    /// Transition matrix has high self-stickiness (P_stay = 0.96) consistent
    /// with regime-persistence priors from crypto-vol regime literature.
    pub fn default_btc_30m() -> Self {
        Self {
            schema_version: 1,
            n_states: 3,
            start_prob: vec![1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
            trans_mat: vec![
                vec![0.96, 0.03, 0.01],
                vec![0.02, 0.96, 0.02],
                vec![0.01, 0.03, 0.96],
            ],
            means: vec![
                vec![-0.004, 0.012],
                vec![0.0, 0.004],
                vec![0.004, 0.012],
            ],
            // Diagonal-covariance — stored as per-feature variance.
            // log-return variance = 4e-6 ⇒ σ = 0.002 (narrow band around µ)
            // realized-vol variance = 4e-6 ⇒ σ = 0.002 (narrow band around µ)
            covars: vec![
                vec![4.0e-6, 4.0e-6],
                vec![4.0e-6, 4.0e-6],
                vec![4.0e-6, 4.0e-6],
            ],
            state_labels: vec!["bear".into(), "range".into(), "bull".into()],
        }
    }

    /// Structural-invariant check. Run after `load_from_json` to catch
    /// hand-written model files with row/column mismatches.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.n_states == 0 {
            anyhow::bail!("hmm: n_states must be > 0");
        }
        if self.start_prob.len() != self.n_states {
            anyhow::bail!(
                "hmm: start_prob len {} != n_states {}",
                self.start_prob.len(),
                self.n_states
            );
        }
        let sp: f64 = self.start_prob.iter().sum();
        if !sp.is_finite() || (sp - 1.0).abs() > 1.0e-3 {
            anyhow::bail!("hmm: start_prob does not sum to 1 (got {sp})");
        }
        if self.trans_mat.len() != self.n_states {
            anyhow::bail!(
                "hmm: trans_mat rows {} != n_states {}",
                self.trans_mat.len(),
                self.n_states
            );
        }
        for (i, row) in self.trans_mat.iter().enumerate() {
            if row.len() != self.n_states {
                anyhow::bail!(
                    "hmm: trans_mat row {} len {} != n_states {}",
                    i,
                    row.len(),
                    self.n_states
                );
            }
            let rs: f64 = row.iter().sum();
            if !rs.is_finite() || (rs - 1.0).abs() > 1.0e-3 {
                anyhow::bail!("hmm: trans_mat row {i} sums to {rs} != 1");
            }
        }
        if self.means.len() != self.n_states {
            anyhow::bail!(
                "hmm: means rows {} != n_states {}",
                self.means.len(),
                self.n_states
            );
        }
        if self.covars.len() != self.n_states {
            anyhow::bail!(
                "hmm: covars rows {} != n_states {}",
                self.covars.len(),
                self.n_states
            );
        }
        let n_features = self.means[0].len();
        if n_features == 0 {
            anyhow::bail!("hmm: n_features must be > 0");
        }
        for (i, row) in self.means.iter().enumerate() {
            if row.len() != n_features {
                anyhow::bail!(
                    "hmm: means row {} len {} != n_features {}",
                    i,
                    row.len(),
                    n_features
                );
            }
        }
        for (i, row) in self.covars.iter().enumerate() {
            if row.len() != n_features {
                anyhow::bail!(
                    "hmm: covars row {} len {} != n_features {}",
                    i,
                    row.len(),
                    n_features
                );
            }
            for (j, &v) in row.iter().enumerate() {
                if !v.is_finite() || v <= 0.0 {
                    anyhow::bail!("hmm: covars[{i}][{j}] = {v} must be > 0");
                }
            }
        }
        if !self.state_labels.is_empty() && self.state_labels.len() != self.n_states {
            anyhow::bail!(
                "hmm: state_labels len {} != n_states {}",
                self.state_labels.len(),
                self.n_states
            );
        }
        Ok(())
    }

    /// Return the index of the state whose label matches `name`. If no label
    /// matches, falls back to the convention `bear → 0`, `range → 1`,
    /// `bull → 2`.
    fn state_index_by_label(&self, name: &str) -> Option<usize> {
        for (i, lbl) in self.state_labels.iter().enumerate() {
            if lbl.eq_ignore_ascii_case(name) {
                return Some(i);
            }
        }
        if self.state_labels.is_empty() && self.n_states == 3 {
            return match name {
                "bear" => Some(0),
                "range" => Some(1),
                "bull" => Some(2),
                _ => None,
            };
        }
        None
    }
}

/// Diagonal-covariance multivariate Gaussian density. Returns the joint
/// density `Π_d N(obs[d] | mean[d], var[d])`. Caller guarantees `mean`,
/// `var`, and `obs` are same length and `var[d] > 0`.
fn gaussian_pdf_diag(obs: &[f64], mean: &[f64], var: &[f64]) -> f64 {
    let mut p = 1.0_f64;
    let two_pi = 2.0 * std::f64::consts::PI;
    for d in 0..obs.len() {
        let o = obs[d];
        let m = mean[d];
        let v = var[d];
        if !o.is_finite() || !m.is_finite() || !v.is_finite() || v <= 0.0 {
            return 0.0;
        }
        let z = (o - m) / v.sqrt();
        let coef = 1.0 / (two_pi * v).sqrt();
        p *= coef * (-0.5 * z * z).exp();
    }
    p
}

/// Compute the 2-d feature vector `(log_return, realized_vol)` for bar index
/// `idx` in `candles`. Both components are derived from `candles[..=idx]`
/// only — never reads ahead.
///
/// Returns `None` if any input is non-finite, idx is 0 (no log-return), or
/// `idx + 1 < vol_lookback_bars` (not enough history for the rolling std).
fn compute_features(
    candles: &[Candle],
    idx: usize,
    vol_lookback_bars: usize,
) -> Option<[f64; 2]> {
    if idx == 0 {
        return None;
    }
    if vol_lookback_bars == 0 {
        return None;
    }
    if idx + 1 < vol_lookback_bars {
        return None;
    }
    let prev = candles[idx - 1].close;
    let cur = candles[idx].close;
    if !prev.is_finite() || !cur.is_finite() || prev <= 0.0 || cur <= 0.0 {
        return None;
    }
    let lr = (cur / prev).ln();
    if !lr.is_finite() {
        return None;
    }

    // Realized-vol = stdev of log-returns over the last `vol_lookback_bars`
    // bars. Window = (idx - vol_lookback_bars + 1 ..= idx) for log-returns,
    // which means we read closes from (idx - vol_lookback_bars ..= idx).
    let start = idx + 1 - vol_lookback_bars;
    if start == 0 {
        // Need one extra bar before `start` to compute the first log-return.
        // start == 0 ⇒ would need candles[-1]. Bail.
        return None;
    }
    let mut returns: Vec<f64> = Vec::with_capacity(vol_lookback_bars);
    for k in start..=idx {
        let p0 = candles[k - 1].close;
        let p1 = candles[k].close;
        if !p0.is_finite() || !p1.is_finite() || p0 <= 0.0 || p1 <= 0.0 {
            return None;
        }
        let r = (p1 / p0).ln();
        if !r.is_finite() {
            return None;
        }
        returns.push(r);
    }
    if returns.is_empty() {
        return None;
    }
    let n = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let var = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / n;
    if !var.is_finite() || var < 0.0 {
        return None;
    }
    let realized_vol = var.sqrt();
    Some([lr, realized_vol])
}

/// Run the forward algorithm on `obs` (each element a feature vector of
/// length `n_features = model.means[0].len()`). Returns the per-state
/// posterior probability distribution at the LAST step. Normalizes alpha at
/// every step to avoid underflow.
///
/// Returns `None` if the model is malformed (no states / no features) or if
/// every transition step degenerates to a zero-sum alpha (e.g. all emission
/// pdfs are zero because every obs is wildly out-of-distribution).
fn forward_posterior(model: &HmmModel, obs: &[[f64; 2]]) -> Option<Vec<f64>> {
    if obs.is_empty() || model.n_states == 0 {
        return None;
    }
    let n = model.n_states;
    // alpha[k] for current step.
    let mut alpha = vec![0.0_f64; n];

    // Initialization: alpha[0][k] = start_prob[k] * emission_pdf(obs[0], k).
    for k in 0..n {
        let pdf = gaussian_pdf_diag(&obs[0], &model.means[k], &model.covars[k]);
        alpha[k] = model.start_prob[k] * pdf;
    }
    let s0: f64 = alpha.iter().sum();
    if !s0.is_finite() || s0 <= 0.0 {
        // Every emission_pdf returned zero at t=0 — fall back to start_prob
        // alone so we keep iterating. Without this guard, a single
        // out-of-distribution opening bar would freeze alpha at all-zeros
        // for the rest of the sequence.
        alpha = model.start_prob.clone();
    } else {
        for a in alpha.iter_mut() {
            *a /= s0;
        }
    }

    // Recurrence: alpha[t][k] = emission_pdf(obs[t], k) · Σ_j alpha[t-1][j] · A[j][k].
    let mut next = vec![0.0_f64; n];
    for t in 1..obs.len() {
        for k in 0..n {
            let mut acc = 0.0_f64;
            for j in 0..n {
                acc += alpha[j] * model.trans_mat[j][k];
            }
            let pdf = gaussian_pdf_diag(&obs[t], &model.means[k], &model.covars[k]);
            next[k] = acc * pdf;
        }
        let s: f64 = next.iter().sum();
        if !s.is_finite() || s <= 0.0 {
            // Skip degenerate step — carry alpha unchanged.
            // Equivalent to assuming all emissions are equally unlikely on
            // this bar.
        } else {
            for k in 0..n {
                alpha[k] = next[k] / s;
            }
        }
    }
    Some(alpha)
}

/// Compute the HMM-regime vote for the most recent closed bar.
///
/// Returns `Some(Long)` when `P(bull) ≥ p_threshold_bull` AND
/// `P(bear) ≤ p_opposite_max`. Symmetric short. Otherwise `None`.
///
/// Lookahead-safe: features are extracted from `candles[..= signal_idx]`
/// with `signal_idx = candles.len() - 2`. The entry bar `candles[len-1]` is
/// never read.
pub fn compute_hmm_regime_vote(
    candles: &[Candle],
    model: &HmmModel,
    params: &HmmRegimeParams,
) -> Option<PositionSide> {
    if params.warmup_bars == 0 {
        return None;
    }
    if candles.len() < params.warmup_bars.max(params.vol_lookback_bars + 2) + 1 {
        // +1 to keep `candles[len-1]` (entry bar) untouched.
        return None;
    }
    // Quick sanity-check on params semantics.
    if !params.p_threshold_bull.is_finite()
        || !params.p_threshold_bear.is_finite()
        || !params.p_opposite_max.is_finite()
        || params.p_threshold_bull <= 0.0
        || params.p_threshold_bear <= 0.0
    {
        return None;
    }

    let signal_idx = candles.len() - 2;
    // Build observation sequence covering the lookback window. We don't need
    // every bar from genesis — the forward algorithm stabilizes within a few
    // dozen samples thanks to the per-step normalization. Use a window of
    // `warmup_bars` bars ending at signal_idx.
    let obs_start = signal_idx + 1 - params.warmup_bars;
    let mut obs: Vec<[f64; 2]> = Vec::with_capacity(params.warmup_bars);
    for k in obs_start..=signal_idx {
        match compute_features(candles, k, params.vol_lookback_bars) {
            Some(f) => obs.push(f),
            None => return None,
        }
    }
    let posterior = forward_posterior(model, &obs)?;

    let bull_idx = model.state_index_by_label("bull")?;
    let bear_idx = model.state_index_by_label("bear")?;
    if bull_idx >= posterior.len() || bear_idx >= posterior.len() {
        return None;
    }
    let p_bull = posterior[bull_idx];
    let p_bear = posterior[bear_idx];
    if !p_bull.is_finite() || !p_bear.is_finite() {
        return None;
    }

    if p_bull >= params.p_threshold_bull && p_bear <= params.p_opposite_max {
        return Some(PositionSide::Long);
    }
    if p_bear >= params.p_threshold_bear && p_bull <= params.p_opposite_max {
        return Some(PositionSide::Short);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candle(t: i64, c: f64) -> Candle {
        // Tight OHLC + uniform volume; the HMM voter ignores OHLC anyway
        // (consults closes only), so we just need price-series shape.
        Candle::new(t, c, c + 0.5, c - 0.5, c, 100.0)
    }

    /// Build a synthetic price series with controllable drift + vol. `drift`
    /// is the per-bar log-return mean; `vol` the per-bar log-return std.
    /// Deterministic via a tiny linear-congruential RNG so tests are
    /// reproducible without bringing in an extra dependency.
    fn synth_series(n: usize, start: f64, drift: f64, vol: f64, seed: u64) -> Vec<Candle> {
        let mut state = seed.wrapping_mul(2_862_933_555_777_941_757).wrapping_add(3_037_000_493);
        // Box-Muller pair generator using the LCG above. Reuse for two samples
        // at a time.
        let next_normal = |s: &mut u64| -> f64 {
            *s = s.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let u1 = ((*s >> 11) as f64) / ((1u64 << 53) as f64);
            *s = s.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let u2 = ((*s >> 11) as f64) / ((1u64 << 53) as f64);
            let u1c = u1.max(1.0e-12);
            (-2.0 * u1c.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
        };
        let mut price = start;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let z = next_normal(&mut state);
            let lr = drift + vol * z;
            price *= lr.exp();
            out.push(make_candle((i as i64) * 1_800_000, price));
        }
        out
    }

    #[test]
    fn default_btc_30m_loads_without_error() {
        let m = HmmModel::default_btc_30m();
        m.validate().expect("hardcoded default must validate");
        // Bull/bear labels resolvable.
        assert_eq!(m.state_index_by_label("bull"), Some(2));
        assert_eq!(m.state_index_by_label("bear"), Some(0));
        assert_eq!(m.state_index_by_label("range"), Some(1));
    }

    #[test]
    fn no_vote_on_too_few_bars() {
        // warmup_bars=200, vol_lookback=48 → need at least ~201 bars + entry.
        let candles = synth_series(50, 100.0, 0.0, 0.001, 1);
        let model = HmmModel::default_btc_30m();
        let params = HmmRegimeParams::default_30m_crypto();
        let v = compute_hmm_regime_vote(&candles, &model, &params);
        assert!(v.is_none(), "must abstain when < warmup_bars");
    }

    #[test]
    fn votes_bull_on_synthetic_uptrend_low_vol() {
        // Drift + vol target the bull state means exactly (µ_lr = 0.004,
        // µ_vol = 0.012). Per-bar emission pdf for bull-state ≈ 199.5;
        // range-state ≈ 27 (down by factor exp(-2)); bear-state ≈ 0.07
        // (down by factor exp(-8)). Forward-algorithm accumulates to a
        // bull-posterior ≫ 0.55 over the 200-bar warmup window.
        let candles = synth_series(400, 100.0, 0.004, 0.012, 7);
        let model = HmmModel::default_btc_30m();
        let params = HmmRegimeParams::default_30m_crypto();
        let v = compute_hmm_regime_vote(&candles, &model, &params);
        assert_eq!(
            v,
            Some(PositionSide::Long),
            "bull-mean-targeted sequence must vote Long"
        );
    }

    #[test]
    fn votes_bear_on_synthetic_downtrend_high_vol() {
        // Mirror of bull case — drift = bear-state mean (-0.004), vol = bear
        // µ_vol = 0.012. Symmetric likelihood-ratio analysis.
        let candles = synth_series(400, 100.0, -0.004, 0.012, 11);
        let model = HmmModel::default_btc_30m();
        let params = HmmRegimeParams::default_30m_crypto();
        let v = compute_hmm_regime_vote(&candles, &model, &params);
        assert_eq!(
            v,
            Some(PositionSide::Short),
            "bear-mean-targeted sequence must vote Short"
        );
    }

    #[test]
    fn votes_none_on_range_state() {
        // Drift = 0, vol = range µ_vol (0.004). Posterior should concentrate
        // on the range state; neither bull nor bear thresholds met ⇒ no vote.
        let candles = synth_series(400, 100.0, 0.0, 0.004, 13);
        let model = HmmModel::default_btc_30m();
        let params = HmmRegimeParams::default_30m_crypto();
        let v = compute_hmm_regime_vote(&candles, &model, &params);
        assert!(
            v.is_none(),
            "range-state sequence must abstain (got {:?})",
            v
        );
    }

    #[test]
    fn hmm_does_not_read_entry_bar() {
        // Critical lookahead test: mutate candles[len-1] (the entry bar) after
        // computing the vote. The result must be identical because the HMM
        // only reads through signal_idx = len-2.
        let mut candles = synth_series(400, 100.0, 0.004, 0.012, 19);
        let model = HmmModel::default_btc_30m();
        let params = HmmRegimeParams::default_30m_crypto();
        let v_before = compute_hmm_regime_vote(&candles, &model, &params);
        // Slam the entry bar with garbage that would obviously flip the vote
        // if it were read.
        let last = candles.len() - 1;
        candles[last].close = 1.0e-9;
        candles[last].high = 1.0e-9;
        candles[last].low = 1.0e-9;
        candles[last].open = 1.0e-9;
        let v_after = compute_hmm_regime_vote(&candles, &model, &params);
        assert_eq!(
            v_before, v_after,
            "vote must not change when entry bar is mutated"
        );
    }

    #[test]
    fn forward_algo_normalizes_stable() {
        // Run forward on a 1000-bar sequence; the normalized posterior MUST
        // always sum to ~1 and never produce NaN/Inf. Without per-step
        // normalization the alphas would underflow to 0 within ~50 steps.
        let candles = synth_series(1000, 100.0, 0.0005, 0.008, 23);
        let model = HmmModel::default_btc_30m();
        let mut obs: Vec<[f64; 2]> = Vec::new();
        for k in 49..candles.len() {
            if let Some(f) = compute_features(&candles, k, 48) {
                obs.push(f);
            }
        }
        let posterior = forward_posterior(&model, &obs).expect("must return Some");
        let s: f64 = posterior.iter().sum();
        for &p in posterior.iter() {
            assert!(p.is_finite(), "posterior must contain only finite values");
            assert!((0.0..=1.0).contains(&p), "posterior {p} out of [0,1]");
        }
        assert!(
            (s - 1.0).abs() < 1.0e-9,
            "posterior must sum to 1 (got {s})"
        );
    }

    #[test]
    fn handles_nan_returns_safely() {
        // If a single bar has a zero close (causing ln(0) = -inf) the feature
        // extractor must return None, and the voter must abstain rather than
        // poison the forward algorithm.
        let mut candles = synth_series(400, 100.0, 0.004, 0.012, 29);
        // Plant a zero close ~10 bars before signal_idx — feature extractor
        // refuses; voter abstains.
        let bad_idx = candles.len() - 12;
        candles[bad_idx].close = 0.0;
        let model = HmmModel::default_btc_30m();
        let params = HmmRegimeParams::default_30m_crypto();
        let v = compute_hmm_regime_vote(&candles, &model, &params);
        assert!(v.is_none(), "zero-close bar must short-circuit to None");
    }

    #[test]
    fn validate_rejects_malformed_row_lengths() {
        // Sanity check on the model validator — guards future hand-written
        // JSON files where someone forgets a column.
        let mut bad = HmmModel::default_btc_30m();
        bad.trans_mat[1] = vec![0.5, 0.5]; // missing third column
        let err = bad.validate().unwrap_err();
        assert!(
            err.to_string().contains("trans_mat row 1"),
            "expected row-len error, got: {err}"
        );
    }

    /// Verify the trained 4-state HMM model JSON (written by
    /// `scripts/ml/hmm_4state_train.py`) loads cleanly via the same
    /// `HmmModel::load_from_json` used by the 3-state voter, so a future
    /// 4-state voter / regime-conditional sizing layer can reuse the
    /// existing loader infrastructure. Skipped silently if the model file
    /// hasn't been trained yet (CI clean checkout).
    #[test]
    fn hmm_loads_4state_trained_model() {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let p = std::path::PathBuf::from(manifest)
            .join("../../models/hmm_4state_btc_30m.json");
        if !p.exists() {
            eprintln!("[skip] {} not present (run hmm_4state_train.py first)", p.display());
            return;
        }
        let m = HmmModel::load_from_json(&p).expect("load 4-state model");
        assert_eq!(m.n_states, 4, "expected 4-state model");
        assert_eq!(m.state_labels.len(), 4);
        assert_eq!(m.start_prob.len(), 4);
        assert_eq!(m.trans_mat.len(), 4);
        assert_eq!(m.means.len(), 4);
        assert_eq!(m.covars.len(), 4);
        for row in &m.trans_mat {
            assert_eq!(row.len(), 4);
        }
    }
}
