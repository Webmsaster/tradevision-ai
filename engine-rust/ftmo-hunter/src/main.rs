//! `ftmo-hunter` CLI entry-point.
//!
//! Usage:
//! ```bash
//! ftmo-hunter \
//!   --sweep-binary ./target/release/ftmo-sweep \
//!   --candles-dir ../scripts/cache_bakeoff \
//!   --funding-dir ../scripts/cache_bakeoff \
//!   --symbols AAVEUSDT,ADAUSDT,...,XRPUSDT \
//!   --trials 150 \
//!   --top-k 10 \
//!   --output hunter_results.jsonl
//! ```
//!
//! ⚠️ 2026-05-25 Wave5 KRIT WARNING (audit):
//! Hunter "validation" runs on the SAME `--candles-dir` and `--windows`
//! as the search phase. This is NOT walk-forward — overfit-trials simply
//! re-confirm themselves. Champions surfaced by hunter must be
//! **independently re-validated** on a holdout window range BEFORE deploy.
//!
//! Suggested holdout workflow:
//!   1. Run hunter on `--windows 0:660` (train 2/3).
//!   2. Manually re-sweep top-K configs on `--windows 660:991` (test 1/3).
//!   3. Drop any config whose test-rate is >5pp below train-rate.
//!
//! Also: validation `--validate-step-days` differing from search step
//! changes the window grid → cannot directly compare train vs test rates.
//! Use same step for both phases (overfit check), then a separate holdout
//! pass with a different step (regime-robustness check).
//!
//! Related findings (audit `engine-rust/ftmo-hunter/src/`):
//!   - archive.rs: no file-lock on JSONL output (concurrent hunters corrupt)
//!   - archive.rs: no replay on restart (lost leaderboard on crash)
//!   - search.rs: no stuck-in-local-min protection (refine collapses on
//!     first high-scoring trial)
//!   - trial.rs: `parse_pass_line` matches FIRST `passed=` (fragile if
//!     sweep emits per-asset lines before aggregate)
//!   - main.rs: single-seed only; champions should be multi-seed averaged

use anyhow::{anyhow, Context, Result};
use ftmo_hunter::archive::Archive;
use ftmo_hunter::search::{run_phase, run_validation, Phase};
use ftmo_hunter::trial::{Trial, TrialEnv};
use rand::SeedableRng;
use std::path::PathBuf;

#[derive(Debug)]
struct CliArgs {
    sweep_binary: PathBuf,
    candles_dir: PathBuf,
    funding_dir: Option<PathBuf>,
    symbols: String,
    /// Total trials = random + refine. Validation reruns top-N on top of this.
    trials: u32,
    /// Fraction of `trials` spent in the random phase (rest = refine).
    random_frac: f64,
    top_k: usize,
    /// How many champions to revalidate with `--strict-pass`.
    validate_top_n: usize,
    output: PathBuf,
    windows: u32,
    step_days: Option<u32>,
    threads: Option<u32>,
    mutation_rate: f64,
    seed: u64,
    /// Optional fixed step_days override for the validation phase.
    validate_step_days: Option<u32>,
}

fn parse_args() -> Result<CliArgs> {
    let mut sweep_binary: Option<PathBuf> = None;
    let mut candles_dir: Option<PathBuf> = None;
    let mut funding_dir: Option<PathBuf> = None;
    let mut symbols: Option<String> = None;
    let mut trials: u32 = 150;
    let mut random_frac: f64 = 0.33;
    let mut top_k: usize = 10;
    let mut validate_top_n: usize = 3;
    let mut output: Option<PathBuf> = None;
    let mut windows: u32 = 100;
    let mut step_days: Option<u32> = Some(14);
    let mut threads: Option<u32> = None;
    let mut mutation_rate: f64 = 0.35;
    let mut seed: u64 = 42;
    let mut validate_step_days: Option<u32> = Some(7);

    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let need = |a: &mut std::iter::Skip<std::env::Args>, name: &str| {
            a.next()
                .ok_or_else(|| anyhow!("missing value for {name}"))
        };
        match flag.as_str() {
            "--sweep-binary" => sweep_binary = Some(PathBuf::from(need(&mut args, &flag)?)),
            "--candles-dir" => candles_dir = Some(PathBuf::from(need(&mut args, &flag)?)),
            "--funding-dir" => funding_dir = Some(PathBuf::from(need(&mut args, &flag)?)),
            "--symbols" => symbols = Some(need(&mut args, &flag)?),
            "--trials" => trials = need(&mut args, &flag)?.parse()?,
            "--random-frac" => random_frac = need(&mut args, &flag)?.parse()?,
            "--top-k" => top_k = need(&mut args, &flag)?.parse()?,
            "--validate-top-n" => validate_top_n = need(&mut args, &flag)?.parse()?,
            "--output" => output = Some(PathBuf::from(need(&mut args, &flag)?)),
            "--windows" => windows = need(&mut args, &flag)?.parse()?,
            "--step-days" => step_days = Some(need(&mut args, &flag)?.parse()?),
            "--threads" => threads = Some(need(&mut args, &flag)?.parse()?),
            "--mutation-rate" => mutation_rate = need(&mut args, &flag)?.parse()?,
            "--seed" => seed = need(&mut args, &flag)?.parse()?,
            "--validate-step-days" => {
                validate_step_days = Some(need(&mut args, &flag)?.parse()?)
            }
            "--help" | "-h" => {
                println!("{}", HELP);
                std::process::exit(0);
            }
            other => return Err(anyhow!("unknown arg: {other}")),
        }
    }

    // 2026-05-16 Codex audit Bug #8 (NIEDRIG): clamp `--random-frac` and
    // `--mutation-rate` to [0.0, 1.0]. They are passed to `rng.gen_bool(...)`
    // downstream, which PANICS if the probability is outside [0.0, 1.0]. A
    // user passing `--mutation-rate 1.5` previously crashed mid-run.
    let random_frac = random_frac.clamp(0.0, 1.0);
    let mutation_rate = mutation_rate.clamp(0.0, 1.0);

    Ok(CliArgs {
        sweep_binary: sweep_binary
            .ok_or_else(|| anyhow!("--sweep-binary required"))?,
        candles_dir: candles_dir.ok_or_else(|| anyhow!("--candles-dir required"))?,
        funding_dir,
        symbols: symbols.ok_or_else(|| anyhow!("--symbols required"))?,
        trials,
        random_frac,
        top_k,
        validate_top_n,
        output: output.unwrap_or_else(|| PathBuf::from("hunter_results.jsonl")),
        windows,
        step_days,
        threads,
        mutation_rate,
        seed,
        validate_step_days,
    })
}

const HELP: &str = "\
ftmo-hunter — autonomous parameter tuner for ftmo-sweep

Required:
  --sweep-binary PATH      path to compiled ftmo-sweep binary
  --candles-dir DIR        candles_*.json directory
  --symbols CSV            symbol list, e.g. BTCUSDT,ETHUSDT,...

Optional:
  --funding-dir DIR        funding-rate cache (passed to ftmo-sweep)
  --trials N               total trials (random + refine), default 150
  --random-frac F          fraction in random phase, default 0.33
  --top-k K                leaderboard size, default 10
  --validate-top-n N       how many to re-run with --strict-pass, default 3
  --output PATH            JSONL archive path, default hunter_results.jsonl
  --windows N              sweep --windows, default 100
  --step-days N            sweep --step-days, default 14
  --threads N              sweep --threads (CPU cap per trial)
  --mutation-rate F        per-axis mutation prob, default 0.35
  --seed N                 RNG seed, default 42
  --validate-step-days N   step-days for validation phase, default 7
";

fn print_trial(t: &Trial) {
    let voters = t.params.voter_names().join(",");
    let voters_disp = if voters.is_empty() {
        "-".to_string()
    } else {
        voters
    };
    let drop_disp = if t.params.drop_symbols.is_empty() {
        "-".to_string()
    } else {
        t.params.drop_symbols.join(",")
    };
    println!(
        "[hunter] #{:04} {:>8} cfg={:<40} mode={:<7} mv={} pt={:.3} tp={:.2} drop={} voters=[{}] -> {:>6.2}% ({} ms){}",
        t.trial_id,
        t.phase,
        t.params.config,
        t.params.signals_mode.as_str(),
        t.params.regime_min_votes,
        t.params.pt,
        t.params.tp_mult,
        drop_disp,
        voters_disp,
        t.pass_rate,
        t.elapsed_ms,
        if t.strict_pass { " [strict]" } else { "" },
    );
}

fn final_report(archive: &Archive) {
    println!("\n========== ftmo-hunter final report ==========");
    let lb = archive.leaderboard();
    if lb.is_empty() {
        println!("(no completed trials)");
        return;
    }
    println!("Top-{} leaderboard (by pass_rate):", lb.len());
    for (rank, t) in lb.iter().enumerate() {
        println!(
            "  {}. {:.2}%  cfg={} mode={} mv={} pt={:.3} tp={:.2} vol_confirm={} drop={:?} voters={:?}",
            rank + 1,
            t.pass_rate,
            t.params.config,
            t.params.signals_mode.as_str(),
            t.params.regime_min_votes,
            t.params.pt,
            t.params.tp_mult,
            t.params.vol_confirm,
            t.params.drop_symbols,
            t.params.voter_names(),
        );
    }
    println!("Archive JSONL: {}", archive.path().display());
}

fn main() -> Result<()> {
    let args = parse_args()?;

    if !args.sweep_binary.exists() {
        return Err(anyhow!(
            "sweep binary not found at {}",
            args.sweep_binary.display()
        ));
    }
    if !args.candles_dir.exists() {
        return Err(anyhow!(
            "candles dir not found at {}",
            args.candles_dir.display()
        ));
    }

    let env_main = TrialEnv {
        sweep_binary: args.sweep_binary.clone(),
        candles_dir: args.candles_dir.clone(),
        funding_dir: args.funding_dir.clone(),
        symbols: args.symbols.clone(),
        windows: args.windows,
        step_days: args.step_days,
        threads: args.threads,
        strict_pass: false,
    };
    let env_validate = TrialEnv {
        strict_pass: true,
        step_days: args.validate_step_days.or(args.step_days),
        ..env_main.clone()
    };

    let mut archive = Archive::new(args.output.clone(), args.top_k);
    let mut rng = rand::rngs::StdRng::seed_from_u64(args.seed);
    let mut next_id: u64 = 1;

    let random_n = ((args.trials as f64) * args.random_frac).round() as u32;
    let refine_n = args.trials.saturating_sub(random_n);

    println!(
        "[hunter] starting: trials={} (random={} refine={}), top_k={}, validate_top_n={}, seed={}",
        args.trials, random_n, refine_n, args.top_k, args.validate_top_n, args.seed
    );
    println!("[hunter] sweep binary: {}", env_main.sweep_binary.display());
    println!("[hunter] candles-dir:  {}", env_main.candles_dir.display());
    println!("[hunter] archive:      {}", archive.path().display());

    // Phase 1: random search.
    run_phase(
        &mut rng,
        Phase::Random,
        random_n,
        &env_main,
        &mut archive,
        &mut next_id,
        args.mutation_rate,
        print_trial,
    )
    .context("random phase")?;

    if !archive.is_empty() {
        println!(
            "[hunter] random phase done. Best so far: {:.2}%",
            archive.leaderboard()[0].pass_rate
        );
    }

    // Phase 2: local refinement.
    if refine_n > 0 {
        run_phase(
            &mut rng,
            Phase::Refine,
            refine_n,
            &env_main,
            &mut archive,
            &mut next_id,
            args.mutation_rate,
            print_trial,
        )
        .context("refine phase")?;
    }

    if !archive.is_empty() {
        println!(
            "[hunter] refine phase done. Best after refine: {:.2}%",
            archive.leaderboard()[0].pass_rate
        );
    }

    // Phase 3: validation (strict-pass).
    if args.validate_top_n > 0 && !archive.is_empty() {
        println!(
            "[hunter] starting validation: re-running top-{} with --strict-pass (step={:?})",
            args.validate_top_n.min(archive.len()),
            env_validate.step_days
        );
        run_validation(
            args.validate_top_n,
            &env_validate,
            &mut archive,
            &mut next_id,
            print_trial,
        )
        .context("validate phase")?;
    }

    final_report(&archive);
    Ok(())
}
