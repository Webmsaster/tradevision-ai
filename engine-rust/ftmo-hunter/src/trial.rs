//! Single-trial execution: build CLI args from [`TrialParams`], spawn
//! `ftmo-sweep`, parse its stdout, and return a [`Trial`] record.
//!
//! The stdout target we parse is the second-to-last line emitted by
//! `finalise_report()` in `sweep.rs`:
//!
//! ```text
//! passed=76 / 136 (55.88%)
//! ```
//!
//! We extract `passed`, `windows`, and the percentage. Anything else
//! emitted by sweep (timings, debug logs) is ignored. When the binary
//! exits non-zero we return an [`anyhow::Error`].

use crate::space::{SignalsMode, TrialParams};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

/// Configuration shared across all trials in a hunter run.
#[derive(Debug, Clone)]
pub struct TrialEnv {
    pub sweep_binary: PathBuf,
    pub candles_dir: PathBuf,
    pub funding_dir: Option<PathBuf>,
    pub symbols: String,
    pub windows: u32,
    pub step_days: Option<u32>,
    pub threads: Option<u32>,
    /// When `Some`, every trial run with this strict-pass flag (validation
    /// phase). Default `None` (lenient).
    pub strict_pass: bool,
}

/// Result of one `ftmo-sweep` execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trial {
    pub trial_id: u64,
    pub params: TrialParams,
    pub passed: u32,
    pub windows: u32,
    pub pass_rate: f64,
    /// Wall-clock time spent in the subprocess (ms).
    pub elapsed_ms: u64,
    /// Phase tag for archive ("random", "refine", "validate", ...).
    pub phase: String,
    /// Whether the run was launched with `--strict-pass`.
    pub strict_pass: bool,
}

/// Build the `ftmo-sweep` CLI args (everything after the binary path) for
/// a given trial. Pulled out into its own function for unit-testability.
pub fn build_args(params: &TrialParams, env: &TrialEnv) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--config".into(),
        params.config.clone(),
        "--candles-dir".into(),
        env.candles_dir.display().to_string(),
    ];
    if let Some(fd) = &env.funding_dir {
        args.push("--funding-dir".into());
        args.push(fd.display().to_string());
    }
    args.push("--symbols".into());
    args.push(env.symbols.clone());
    args.push("--windows".into());
    args.push(env.windows.to_string());

    if let Some(step) = env.step_days {
        args.push("--step-days".into());
        args.push(step.to_string());
    }
    if let Some(t) = env.threads {
        args.push("--threads".into());
        args.push(t.to_string());
    }

    args.push("--profit-target".into());
    args.push(format!("{:.4}", params.pt));
    args.push("--override-tp-mult".into());
    args.push(format!("{:.4}", params.tp_mult));

    if matches!(params.signals_mode, SignalsMode::Regime) {
        args.push("--signals".into());
        args.push("regime".into());
        args.push("--regime-min-votes".into());
        args.push(params.regime_min_votes.to_string());
        if params.vol_confirm {
            args.push("--regime-vol-confirm".into());
            args.push("--regime-vol-mult".into());
            args.push(format!("{:.2}", params.vol_mult));
        }
    }

    if !params.drop_symbols.is_empty() {
        args.push("--drop-symbols".into());
        args.push(params.drop_symbols.join(","));
    }

    if params.use_htf_macd_gate {
        args.push("--use-htf-confirm".into());
    }

    if env.strict_pass {
        args.push("--strict-pass".into());
    }
    args
}

/// Parse the `passed=X / N (P.PP%)` line from sweep stdout. Returns
/// `(passed, windows, pct)`. Returns Err if no such line is found.
pub fn parse_pass_line(stdout: &str) -> Result<(u32, u32, f64)> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("passed=") {
            // "passed=76 / 136 (55.88%)"
            let mut parts = rest.split_whitespace();
            let passed: u32 = parts
                .next()
                .ok_or_else(|| anyhow!("missing passed number"))?
                .parse()
                .context("parse `passed`")?;
            // expect "/"
            let slash = parts.next().ok_or_else(|| anyhow!("missing /"))?;
            if slash != "/" {
                return Err(anyhow!("expected '/' got {slash:?}"));
            }
            let windows: u32 = parts
                .next()
                .ok_or_else(|| anyhow!("missing windows"))?
                .parse()
                .context("parse `windows`")?;
            let pct_token = parts.next().ok_or_else(|| anyhow!("missing pct"))?;
            // strip "(" and ")" and "%"
            let pct_str = pct_token.trim_matches(|c: char| c == '(' || c == ')' || c == '%');
            let pct: f64 = pct_str.parse().context("parse pct")?;
            return Ok((passed, windows, pct));
        }
    }
    Err(anyhow!("no `passed=` line found in sweep stdout"))
}

/// Execute one trial. Spawns `ftmo-sweep` in blocking mode.
pub fn execute_trial(
    trial_id: u64,
    phase: &str,
    params: &TrialParams,
    env: &TrialEnv,
) -> Result<Trial> {
    let args = build_args(params, env);
    let started = Instant::now();

    let output = Command::new(&env.sweep_binary)
        .args(&args)
        .output()
        .with_context(|| {
            format!(
                "spawn `{} {}` failed",
                env.sweep_binary.display(),
                args.join(" ")
            )
        })?;
    let elapsed = started.elapsed();
    let elapsed_ms = elapsed.as_millis() as u64;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "ftmo-sweep exited with status {:?}: stderr=\n{}",
            output.status.code(),
            stderr
        ));
    }

    let (passed, windows, pct) = parse_pass_line(&stdout).with_context(|| {
        format!(
            "parsing sweep stdout for trial {trial_id}:\n--- begin stdout ---\n{stdout}\n--- end stdout ---"
        )
    })?;

    Ok(Trial {
        trial_id,
        params: params.clone(),
        passed,
        windows,
        pass_rate: pct,
        elapsed_ms,
        phase: phase.to_string(),
        strict_pass: env.strict_pass,
    })
}

/// Helper used by the smoke test in `main.rs`: returns a default env
/// suitable for the small-trial smoke run.
pub fn default_env(
    sweep: PathBuf,
    candles: PathBuf,
    funding: Option<PathBuf>,
    symbols: String,
) -> TrialEnv {
    TrialEnv {
        sweep_binary: sweep,
        candles_dir: candles,
        funding_dir: funding,
        symbols,
        windows: 50,
        step_days: Some(14),
        threads: Some(4),
        strict_pass: false,
    }
}

/// Used in tests — accepts arbitrary path stubs (no IO).
pub fn fake_env(symbols: &str) -> TrialEnv {
    TrialEnv {
        sweep_binary: PathBuf::from("/nowhere/ftmo-sweep"),
        candles_dir: Path::new("/cd").to_path_buf(),
        funding_dir: None,
        symbols: symbols.into(),
        windows: 10,
        step_days: Some(14),
        threads: Some(2),
        strict_pass: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::SearchSpace;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    #[test]
    fn parses_canonical_pass_line() {
        let stdout = "ftmo-sweep (multi-asset): 24 symbols × 1234 bars; cfg=R28V6\n\
                      noise\n\
                      passed=76 / 136 (55.88%)\n";
        let (p, w, pct) = parse_pass_line(stdout).unwrap();
        assert_eq!(p, 76);
        assert_eq!(w, 136);
        assert!((pct - 55.88).abs() < 1e-9);
    }

    #[test]
    fn parses_100pct_edge_case() {
        let stdout = "passed=20 / 20 (100.00%)\n";
        let (p, w, pct) = parse_pass_line(stdout).unwrap();
        assert_eq!(p, 20);
        assert_eq!(w, 20);
        assert!((pct - 100.0).abs() < 1e-9);
    }

    #[test]
    fn parses_zero_pct_edge_case() {
        let stdout = "passed=0 / 100 (0.00%)\n";
        let (p, w, pct) = parse_pass_line(stdout).unwrap();
        assert_eq!(p, 0);
        assert_eq!(w, 100);
        assert!((pct - 0.0).abs() < 1e-9);
    }

    #[test]
    fn errors_when_no_pass_line() {
        let stdout = "this is not a pass line\nneither is this\n";
        assert!(parse_pass_line(stdout).is_err());
    }

    #[test]
    fn build_args_includes_required_flags() {
        let mut rng = StdRng::seed_from_u64(0);
        let p = SearchSpace::sample_random(&mut rng);
        let env = fake_env("BTCUSDT,ETHUSDT");
        let args = build_args(&p, &env);
        // Spot-check the key flags exist.
        assert!(args.iter().any(|a| a == "--config"));
        assert!(args.iter().any(|a| a == "--candles-dir"));
        assert!(args.iter().any(|a| a == "--symbols"));
        assert!(args.iter().any(|a| a == "--windows"));
        assert!(args.iter().any(|a| a == "--profit-target"));
        assert!(args.iter().any(|a| a == "--override-tp-mult"));
    }

    #[test]
    fn build_args_omits_regime_flags_when_default_mode() {
        let p = TrialParams {
            config: "2h-trend-v5-amber-passlock".into(),
            signals_mode: SignalsMode::Default,
            regime_min_votes: 3,
            voter_set: 0,
            pt: 0.08,
            tp_mult: 1.0,
            vol_mult: 2.0,
            vol_confirm: false,
            drop_symbols: vec![],
            use_htf_macd_gate: false,
            td_enable: false,
            sharpe_sizing: false,
        };
        let env = fake_env("BTCUSDT");
        let args = build_args(&p, &env);
        assert!(!args.iter().any(|a| a == "--signals"));
        assert!(!args.iter().any(|a| a == "--regime-min-votes"));
        assert!(!args.iter().any(|a| a == "--regime-vol-confirm"));
    }

    #[test]
    fn build_args_includes_regime_flags_when_regime() {
        let p = TrialParams {
            config: "2h-trend-v5-amber-passlock".into(),
            signals_mode: SignalsMode::Regime,
            regime_min_votes: 3,
            voter_set: 0,
            pt: 0.08,
            tp_mult: 1.0,
            vol_mult: 2.0,
            vol_confirm: true,
            drop_symbols: vec!["DOGEUSDT".into()],
            use_htf_macd_gate: true,
            td_enable: false,
            sharpe_sizing: false,
        };
        let env = fake_env("BTCUSDT");
        let args = build_args(&p, &env);
        assert!(args.iter().any(|a| a == "--signals"));
        assert!(args.iter().any(|a| a == "--regime-min-votes"));
        assert!(args.iter().any(|a| a == "--regime-vol-confirm"));
        assert!(args.iter().any(|a| a == "--use-htf-confirm"));
        assert!(args.iter().any(|a| a == "--drop-symbols"));
    }

    #[test]
    fn build_args_emits_strict_pass_only_when_set() {
        let mut rng = StdRng::seed_from_u64(1);
        let p = SearchSpace::sample_random(&mut rng);
        let mut env = fake_env("BTCUSDT");
        let args = build_args(&p, &env);
        assert!(!args.iter().any(|a| a == "--strict-pass"));
        env.strict_pass = true;
        let args = build_args(&p, &env);
        assert!(args.iter().any(|a| a == "--strict-pass"));
    }
}
