//! Parameter search-space definitions.
//!
//! All `TrialParams` constructed by the sampler are translated 1:1 into
//! `ftmo-sweep` CLI flags by [`crate::trial::build_args`]. The space here is
//! intentionally hard-coded for the MVP — adding new dimensions requires
//! editing this file plus the matching CLI-arg builder.
//!
//! Discretisation rationale:
//! - Continuous knobs (`pt`, `tp_mult`, `vol_mult`) are bucketed at 0.005-0.05
//!   step so two near-identical trials cannot accidentally show up as
//!   "different" in the archive.
//! - Categoricals (`config`, `signals_mode`, `voter_set`) are sampled
//!   uniformly. Voter set is a bitmask over 13 detectors → 2^13 = 8192 combos.

use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};

/// 13 optional voter detectors. Each bit toggles one detector via a
/// dedicated `ftmo-sweep` flag. Order is stable and must not be reshuffled —
/// the archive references voters by index.
pub const VOTERS: &[&str] = &[
    "poc-z",
    "bb-z",
    "ofi",
    "cmf",
    "rsi-hd",
    "ad-line",
    "aroon",
    "double-top",
    "smc-fvg",
    "supertrend",
    "kalman",
    "stop-hunt",
    "hmm",
];

/// All sister configs (engine selector strings) the hunter is permitted to
/// dispatch. Order is stable for reproducibility.
pub const CONFIGS: &[&str] = &[
    "2h-trend-v5-amber-passlock",
    "2h-trend-v5-amber-max-passlock",
    "2h-trend-v5-amber-ext-passlock",
    "2h-trend-v5-topaz-passlock",
    "2h-trend-v5-rubin-passlock",
    "2h-trend-v5-obsidian-passlock",
    "2h-trend-v5-diamond-passlock",
    "2h-trend-v5-sapphir-passlock",
    "2h-trend-v5-titanium-passlock",
    "2h-trend-v5-amber-quartz-passlock",
];

/// Symbols permitted on the `--drop-symbols` axis. The hunter will pick a
/// random subset (0-3 symbols) per trial.
pub const DROPPABLE_SYMBOLS: &[&str] = &[
    "DOGEUSDT",
    "RUNEUSDT",
    "SANDUSDT",
    "STXUSDT",
    "INJUSDT",
];

/// Signals mode (mapped to `--signals` CLI flag).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SignalsMode {
    /// Per-asset default dispatch (no `--signals` flag passed).
    Default,
    /// `--signals regime` confluence voting.
    Regime,
}

impl SignalsMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SignalsMode::Default => "default",
            SignalsMode::Regime => "regime",
        }
    }
}

/// One full trial-spec: maps deterministically to a `ftmo-sweep` invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrialParams {
    pub config: String,
    pub signals_mode: SignalsMode,
    /// Only meaningful when `signals_mode == Regime`. 2..=4.
    pub regime_min_votes: u32,
    /// Bitmask over [`VOTERS`].
    pub voter_set: u32,
    /// Profit target [0.04, 0.10] in 0.005 steps.
    pub pt: f64,
    /// `--override-tp-mult` [0.50, 1.50] in 0.05 steps.
    pub tp_mult: f64,
    /// `--regime-vol-mult` [1.5, 3.0] in 0.1 steps. Only applied when
    /// `vol_confirm` is true.
    pub vol_mult: f64,
    /// `--regime-vol-confirm` toggle. Only valid with Regime mode.
    pub vol_confirm: bool,
    /// Random subset of `DROPPABLE_SYMBOLS`.
    pub drop_symbols: Vec<String>,
    /// Maps to `--use-htf-confirm` (sweep.rs:1178). 2026-05-15 audit briefly
    /// flagged this as wiring drift because the field name suggests
    /// `--use-htf-macd-gate`, but the build_args test asserts the
    /// `--use-htf-confirm` mapping is intentional. Field name kept for
    /// compat with archived hunter results.
    pub use_htf_macd_gate: bool,
    /// Placeholder toggles — currently no CLI mapping (kept to satisfy task
    /// spec; future-work hook).
    pub td_enable: bool,
    pub sharpe_sizing: bool,
}

impl TrialParams {
    /// Returns the on/off list of voters as readable names.
    pub fn voter_names(&self) -> Vec<&'static str> {
        VOTERS
            .iter()
            .enumerate()
            .filter_map(|(i, name)| {
                let bit = 1u32 << i;
                if self.voter_set & bit != 0 {
                    Some(*name)
                } else {
                    None
                }
            })
            .collect()
    }
}

/// Top-level search-space definition. Acts as both the sampler factory and
/// the validation surface (clamps perturbed params to legal ranges).
pub struct SearchSpace;

impl SearchSpace {
    /// Discretise `pt` to the nearest 0.005 step.
    fn quantize_pt(pt: f64) -> f64 {
        let clamped = pt.clamp(0.04, 0.10);
        (clamped / 0.005).round() * 0.005
    }
    /// Discretise `tp_mult` to the nearest 0.05.
    fn quantize_tp(tp: f64) -> f64 {
        let clamped = tp.clamp(0.50, 1.50);
        (clamped / 0.05).round() * 0.05
    }
    /// Discretise `vol_mult` to the nearest 0.1.
    fn quantize_vol(v: f64) -> f64 {
        let clamped = v.clamp(1.5, 3.0);
        (clamped / 0.1).round() * 0.1
    }

    /// Draw one trial uniformly at random over the entire space.
    pub fn sample_random<R: Rng>(rng: &mut R) -> TrialParams {
        let config = (*CONFIGS.choose(rng).expect("CONFIGS non-empty")).to_string();
        let signals_mode = if rng.gen_bool(0.6) {
            SignalsMode::Regime
        } else {
            SignalsMode::Default
        };
        let regime_min_votes = rng.gen_range(2u32..=4u32);
        // voter_set: random bitmask; allow 0 (= use only base signal).
        let voter_set: u32 = rng.gen_range(0..(1u32 << VOTERS.len()));
        let pt = Self::quantize_pt(rng.gen_range(0.04..=0.10));
        let tp_mult = Self::quantize_tp(rng.gen_range(0.50..=1.50));
        let vol_mult = Self::quantize_vol(rng.gen_range(1.5..=3.0));
        let vol_confirm = matches!(signals_mode, SignalsMode::Regime) && rng.gen_bool(0.5);

        // Random subset of DROPPABLE_SYMBOLS, size 0..=3.
        let n_drop = rng.gen_range(0..=3);
        let mut pool: Vec<&str> = DROPPABLE_SYMBOLS.to_vec();
        pool.shuffle(rng);
        let drop_symbols = pool
            .into_iter()
            .take(n_drop)
            .map(|s| s.to_string())
            .collect();

        TrialParams {
            config,
            signals_mode,
            regime_min_votes,
            voter_set,
            pt,
            tp_mult,
            vol_mult,
            vol_confirm,
            drop_symbols,
            use_htf_macd_gate: rng.gen_bool(0.3),
            td_enable: rng.gen_bool(0.5),
            sharpe_sizing: rng.gen_bool(0.5),
        }
    }

    /// Perturb a known-good trial. With probability `mutation_rate` per
    /// axis we resample / nudge a value; otherwise the axis is inherited.
    pub fn perturb<R: Rng>(rng: &mut R, base: &TrialParams, mutation_rate: f64) -> TrialParams {
        let mut out = base.clone();

        if rng.gen_bool(mutation_rate) {
            out.config = (*CONFIGS.choose(rng).expect("CONFIGS non-empty")).to_string();
        }
        if rng.gen_bool(mutation_rate) {
            out.signals_mode = if rng.gen_bool(0.5) {
                SignalsMode::Default
            } else {
                SignalsMode::Regime
            };
        }
        if rng.gen_bool(mutation_rate) {
            out.regime_min_votes = rng.gen_range(2u32..=4u32);
        }
        if rng.gen_bool(mutation_rate) {
            // Flip 1-2 voter bits (local search).
            let n_flips = rng.gen_range(1..=2);
            for _ in 0..n_flips {
                let bit = rng.gen_range(0..VOTERS.len());
                out.voter_set ^= 1u32 << bit;
            }
        }
        if rng.gen_bool(mutation_rate) {
            // Gaussian nudge ±0.01 (≈ 2 buckets) around current pt.
            let nudged = base.pt + rng.gen_range(-0.015..=0.015);
            out.pt = Self::quantize_pt(nudged);
        }
        if rng.gen_bool(mutation_rate) {
            let nudged = base.tp_mult + rng.gen_range(-0.15..=0.15);
            out.tp_mult = Self::quantize_tp(nudged);
        }
        if rng.gen_bool(mutation_rate) {
            let nudged = base.vol_mult + rng.gen_range(-0.3..=0.3);
            out.vol_mult = Self::quantize_vol(nudged);
        }
        if rng.gen_bool(mutation_rate) {
            out.vol_confirm =
                matches!(out.signals_mode, SignalsMode::Regime) && rng.gen_bool(0.5);
        }
        if rng.gen_bool(mutation_rate) {
            let n_drop = rng.gen_range(0..=3);
            let mut pool: Vec<&str> = DROPPABLE_SYMBOLS.to_vec();
            pool.shuffle(rng);
            out.drop_symbols = pool
                .into_iter()
                .take(n_drop)
                .map(|s| s.to_string())
                .collect();
        }
        if rng.gen_bool(mutation_rate) {
            out.use_htf_macd_gate = !out.use_htf_macd_gate;
        }
        if rng.gen_bool(mutation_rate) {
            out.td_enable = !out.td_enable;
        }
        if rng.gen_bool(mutation_rate) {
            out.sharpe_sizing = !out.sharpe_sizing;
        }

        // Consistency: vol_confirm requires regime mode.
        if !matches!(out.signals_mode, SignalsMode::Regime) {
            out.vol_confirm = false;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    #[test]
    fn pt_quantized_to_half_percent_grid() {
        assert!((SearchSpace::quantize_pt(0.0723) - 0.07).abs() < 1e-9);
        assert!((SearchSpace::quantize_pt(0.0755) - 0.075).abs() < 1e-9);
        // out-of-range clamps:
        assert!((SearchSpace::quantize_pt(0.02) - 0.04).abs() < 1e-9);
        assert!((SearchSpace::quantize_pt(0.20) - 0.10).abs() < 1e-9);
    }

    #[test]
    fn tp_mult_quantized_to_005_grid() {
        assert!((SearchSpace::quantize_tp(0.83) - 0.85).abs() < 1e-9);
        assert!((SearchSpace::quantize_tp(2.0) - 1.50).abs() < 1e-9);
    }

    #[test]
    fn random_trial_has_legal_ranges() {
        let mut rng = StdRng::seed_from_u64(42);
        for _ in 0..200 {
            let t = SearchSpace::sample_random(&mut rng);
            assert!(t.pt >= 0.04 && t.pt <= 0.10, "pt={}", t.pt);
            assert!(t.tp_mult >= 0.50 && t.tp_mult <= 1.50, "tp={}", t.tp_mult);
            assert!(t.vol_mult >= 1.5 && t.vol_mult <= 3.0, "vol={}", t.vol_mult);
            assert!(t.regime_min_votes >= 2 && t.regime_min_votes <= 4);
            assert!(t.voter_set < (1u32 << VOTERS.len()));
            assert!(t.drop_symbols.len() <= 3);
            if !matches!(t.signals_mode, SignalsMode::Regime) {
                assert!(!t.vol_confirm, "vol_confirm only legal with Regime");
            }
        }
    }

    #[test]
    fn perturb_respects_invariants() {
        let mut rng = StdRng::seed_from_u64(7);
        let base = SearchSpace::sample_random(&mut rng);
        for _ in 0..200 {
            let p = SearchSpace::perturb(&mut rng, &base, 0.5);
            assert!(p.pt >= 0.04 && p.pt <= 0.10);
            assert!(p.tp_mult >= 0.50 && p.tp_mult <= 1.50);
            assert!(p.vol_mult >= 1.5 && p.vol_mult <= 3.0);
            if !matches!(p.signals_mode, SignalsMode::Regime) {
                assert!(!p.vol_confirm);
            }
        }
    }

    #[test]
    fn voter_names_reflect_bitmask() {
        let p = TrialParams {
            config: "x".into(),
            signals_mode: SignalsMode::Default,
            regime_min_votes: 2,
            // Bits 0,2,4 → POC-Z, OFI, RSI-HD
            voter_set: 0b10101,
            pt: 0.08,
            tp_mult: 1.0,
            vol_mult: 2.0,
            vol_confirm: false,
            drop_symbols: vec![],
            use_htf_macd_gate: false,
            td_enable: false,
            sharpe_sizing: false,
        };
        let names = p.voter_names();
        assert_eq!(names, vec!["poc-z", "ofi", "rsi-hd"]);
    }
}
