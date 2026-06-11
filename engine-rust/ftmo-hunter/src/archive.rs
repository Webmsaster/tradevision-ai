//! Trial archive: appends one JSONL record per trial and maintains an
//! in-memory top-K leaderboard sorted by `pass_rate` descending.
//!
//! The on-disk JSONL file is append-only. Note: `Archive::new` always
//! starts with an EMPTY in-memory leaderboard — there is currently no
//! restart-replay implementation. If the hunter process is killed mid-run,
//! the on-disk records are preserved but the leaderboard must be rebuilt
//! by hand (the JSONL layout is forward-compatible and `serde_json::from_str`
//! can read it back). 2026-05-16 Codex audit Bug #7: comment clarified to
//! match actual behaviour — earlier docs claimed "can re-read after
//! restart" which was misleading.

use crate::trial::Trial;
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveRecord {
    pub trial: Trial,
    pub timestamp_utc: String,
}

/// Append-only JSONL writer + in-memory leaderboard.
pub struct Archive {
    path: PathBuf,
    top_k: usize,
    leaderboard: Vec<Trial>,
}

impl Archive {
    pub fn new(path: PathBuf, top_k: usize) -> Self {
        Self {
            path,
            top_k: top_k.max(1),
            leaderboard: Vec::with_capacity(top_k + 1),
        }
    }

    /// Append a trial to disk + maintain top-K. Returns true if the trial
    /// entered the leaderboard.
    pub fn record(&mut self, trial: Trial) -> Result<bool> {
        let record = ArchiveRecord {
            trial: trial.clone(),
            timestamp_utc: Utc::now().to_rfc3339(),
        };
        let line = serde_json::to_string(&record).context("serialise trial record")?;

        // Append to file (creates if missing).
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .with_context(|| format!("open archive {} for append", self.path.display()))?;
        writeln!(f, "{line}").context("write trial line")?;
        drop(f);

        // Update leaderboard. Validation re-runs are stored to disk but
        // do not displace anything on the leaderboard — search continues to
        // explore around the random/refine phase trials.
        let trial_id = trial.trial_id;
        let entered = if trial.phase != "validate" {
            self.leaderboard.push(trial);
            self.leaderboard.sort_by(|a, b| {
                b.pass_rate
                    .partial_cmp(&a.pass_rate)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            if self.leaderboard.len() > self.top_k {
                self.leaderboard.truncate(self.top_k);
            }
            self.leaderboard.iter().any(|t| t.trial_id == trial_id)
        } else {
            false
        };

        Ok(entered)
    }

    /// Current leaderboard (top-K), sorted descending by pass_rate.
    pub fn leaderboard(&self) -> &[Trial] {
        &self.leaderboard
    }

    /// Returns the path to the JSONL archive.
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Number of trials currently in the leaderboard.
    pub fn len(&self) -> usize {
        self.leaderboard.len()
    }

    pub fn is_empty(&self) -> bool {
        self.leaderboard.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{SearchSpace, SignalsMode, TrialParams};
    use crate::trial::Trial;
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use tempfile::NamedTempFile;

    fn make_trial(id: u64, pass_rate: f64, phase: &str) -> Trial {
        let mut rng = StdRng::seed_from_u64(id);
        let params = SearchSpace::sample_random(&mut rng);
        Trial {
            trial_id: id,
            params,
            passed: (pass_rate / 100.0 * 50.0).round() as u32,
            windows: 50,
            pass_rate,
            elapsed_ms: 1000,
            phase: phase.into(),
            strict_pass: false,
        }
    }

    #[test]
    fn archive_keeps_top_k_sorted_by_pass_rate() {
        let f = NamedTempFile::new().unwrap();
        let mut a = Archive::new(f.path().to_path_buf(), 3);
        for (i, pr) in [40.0_f64, 55.0, 30.0, 60.0, 70.0, 25.0].iter().enumerate() {
            a.record(make_trial(i as u64, *pr, "random")).unwrap();
        }
        let lb = a.leaderboard();
        assert_eq!(lb.len(), 3);
        assert!(lb[0].pass_rate >= lb[1].pass_rate);
        assert!(lb[1].pass_rate >= lb[2].pass_rate);
        assert!((lb[0].pass_rate - 70.0).abs() < 1e-9);
        assert!((lb[2].pass_rate - 55.0).abs() < 1e-9);
    }

    #[test]
    fn validate_trials_are_written_but_not_in_leaderboard() {
        let f = NamedTempFile::new().unwrap();
        let mut a = Archive::new(f.path().to_path_buf(), 5);
        a.record(make_trial(0, 50.0, "random")).unwrap();
        a.record(make_trial(1, 65.0, "validate")).unwrap();
        a.record(make_trial(2, 60.0, "refine")).unwrap();
        let lb = a.leaderboard();
        assert_eq!(lb.len(), 2);
        assert!(!lb.iter().any(|t| t.phase == "validate"));
    }

    #[test]
    fn jsonl_record_round_trips() {
        let p = TrialParams {
            config: "2h-trend-v5-amber-passlock".into(),
            signals_mode: SignalsMode::Regime,
            regime_min_votes: 3,
            voter_set: 0b101010,
            pt: 0.075,
            tp_mult: 0.95,
            vol_mult: 2.1,
            vol_confirm: true,
            drop_symbols: vec!["DOGEUSDT".into(), "RUNEUSDT".into()],
            use_htf_macd_gate: false,
            td_enable: true,
            sharpe_sizing: false,
        };
        let t = Trial {
            trial_id: 7,
            params: p,
            passed: 30,
            windows: 50,
            pass_rate: 60.0,
            elapsed_ms: 4200,
            phase: "refine".into(),
            strict_pass: false,
        };
        let json = serde_json::to_string(&t).unwrap();
        let back: Trial = serde_json::from_str(&json).unwrap();
        assert_eq!(back.trial_id, 7);
        assert_eq!(back.passed, 30);
        assert!((back.pass_rate - 60.0).abs() < 1e-9);
    }
}
