//! Search-loop orchestration: drives the random / refine / validate
//! phases of the hunter.
//!
//! Phase summary:
//! - `Random`: pure uniform sampling. Builds the initial picture of where
//!   the response surface peaks live.
//! - `Refine`: Gaussian-perturbation around the current top-K leaderboard.
//!   Each iteration picks a parent at random (weighted by pass_rate),
//!   perturbs, runs, archives.
//! - `Validate`: re-run the top-N champions with `--strict-pass` (and
//!   optionally a tighter step). The intent is to filter out lenient-rule
//!   inflation discovered in 2026-05-13 strict-pass audit.

use crate::archive::Archive;
use crate::space::{SearchSpace, TrialParams};
use crate::trial::{execute_trial, Trial, TrialEnv};
use anyhow::Result;
use rand::Rng;

#[derive(Debug, Clone, Copy)]
pub enum Phase {
    Random,
    Refine,
    Validate,
}

impl Phase {
    fn label(&self) -> &'static str {
        match self {
            Phase::Random => "random",
            Phase::Refine => "refine",
            Phase::Validate => "validate",
        }
    }
}

/// Pick one parent from the leaderboard with probability proportional to
/// `(pass_rate / 100)^2`. Squaring biases toward the higher-ranked trials
/// without going winner-take-all.
fn pick_weighted_parent<'a, R: Rng>(rng: &mut R, leaderboard: &'a [Trial]) -> Option<&'a Trial> {
    if leaderboard.is_empty() {
        return None;
    }
    let weights: Vec<f64> = leaderboard
        .iter()
        .map(|t| ((t.pass_rate / 100.0).max(1e-3)).powi(2))
        .collect();
    let total: f64 = weights.iter().sum();
    if total <= 0.0 {
        return leaderboard.first();
    }
    let mut r = rng.gen_range(0.0..total);
    for (i, w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 {
            return Some(&leaderboard[i]);
        }
    }
    leaderboard.last()
}

/// Run `n` trials in `phase`. Reports each trial via the provided callback
/// (used by the CLI to print progress). On per-trial error the function
/// logs to stderr and continues — one failing trial must not kill the run.
#[allow(clippy::too_many_arguments)]
pub fn run_phase<R: Rng, F: FnMut(&Trial)>(
    rng: &mut R,
    phase: Phase,
    n: u32,
    env: &TrialEnv,
    archive: &mut Archive,
    next_trial_id: &mut u64,
    mutation_rate: f64,
    mut on_trial: F,
) -> Result<()> {
    for _ in 0..n {
        let params: TrialParams = match phase {
            Phase::Random => SearchSpace::sample_random(rng),
            Phase::Refine => {
                let lb = archive.leaderboard();
                if let Some(parent) = pick_weighted_parent(rng, lb) {
                    SearchSpace::perturb(rng, &parent.params, mutation_rate)
                } else {
                    // Empty leaderboard fallback (shouldn't happen if random ran first).
                    SearchSpace::sample_random(rng)
                }
            }
            Phase::Validate => {
                // Should be driven by `run_validation` (which picks from
                // leaderboard explicitly). Falling through to random as a
                // safety net.
                SearchSpace::sample_random(rng)
            }
        };

        let id = *next_trial_id;
        *next_trial_id = next_trial_id.saturating_add(1);
        match execute_trial(id, phase.label(), &params, env) {
            Ok(trial) => {
                on_trial(&trial);
                archive.record(trial)?;
            }
            Err(e) => {
                eprintln!("[hunter] trial {id} ({}) failed: {e:#}", phase.label());
            }
        }
    }
    Ok(())
}

/// Re-run the current top-N leaderboard entries with `--strict-pass=true`
/// and (optionally) a tighter `step_days` override. Records each as
/// `phase="validate"`.
pub fn run_validation<F: FnMut(&Trial)>(
    top_n: usize,
    env_strict: &TrialEnv,
    archive: &mut Archive,
    next_trial_id: &mut u64,
    mut on_trial: F,
) -> Result<()> {
    // Snapshot the top-N so we don't mutate while iterating.
    let candidates: Vec<TrialParams> = archive
        .leaderboard()
        .iter()
        .take(top_n)
        .map(|t| t.params.clone())
        .collect();

    for params in candidates {
        let id = *next_trial_id;
        *next_trial_id = next_trial_id.saturating_add(1);
        match execute_trial(id, Phase::Validate.label(), &params, env_strict) {
            Ok(trial) => {
                on_trial(&trial);
                archive.record(trial)?;
            }
            Err(e) => {
                eprintln!("[hunter] validation trial {id} failed: {e:#}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Archive;
    use crate::space::SearchSpace;
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use tempfile::NamedTempFile;

    #[test]
    fn weighted_parent_picks_higher_pass_rate_more_often() {
        // 3 trials: 10% / 40% / 80%. Sample 1000 times, the 80% one should
        // win the majority. We just assert ordering of frequencies.
        let mut rng = StdRng::seed_from_u64(123);
        let trials: Vec<Trial> = [10.0, 40.0, 80.0]
            .iter()
            .enumerate()
            .map(|(i, pr)| {
                let mut rng2 = StdRng::seed_from_u64(i as u64);
                Trial {
                    trial_id: i as u64,
                    params: SearchSpace::sample_random(&mut rng2),
                    passed: 0,
                    windows: 0,
                    pass_rate: *pr,
                    elapsed_ms: 0,
                    phase: "random".into(),
                    strict_pass: false,
                }
            })
            .collect();

        let mut counts = [0u32; 3];
        for _ in 0..1000 {
            let chosen = pick_weighted_parent(&mut rng, &trials).unwrap();
            counts[chosen.trial_id as usize] = counts[chosen.trial_id as usize].saturating_add(1);
        }
        assert!(counts[2] > counts[1], "80% should out-pick 40%");
        assert!(counts[1] > counts[0], "40% should out-pick 10%");
    }

    #[test]
    fn weighted_parent_handles_empty_leaderboard() {
        let mut rng = StdRng::seed_from_u64(0);
        let trials: Vec<Trial> = vec![];
        assert!(pick_weighted_parent(&mut rng, &trials).is_none());
    }

    #[test]
    fn run_validation_uses_strict_env() {
        // Smoke-test that the validation phase reads from leaderboard and
        // does nothing when leaderboard is empty.
        let f = NamedTempFile::new().unwrap();
        let mut a = Archive::new(f.path().to_path_buf(), 5);
        let env = TrialEnv {
            sweep_binary: "/nowhere".into(),
            candles_dir: "/nowhere".into(),
            funding_dir: None,
            symbols: "BTCUSDT".into(),
            windows: 5,
            step_days: Some(14),
            threads: Some(1),
            strict_pass: true,
        };
        let mut id = 1000u64;
        run_validation(3, &env, &mut a, &mut id, |_| {}).unwrap();
        assert_eq!(id, 1000); // no candidates → no increments
    }
}
