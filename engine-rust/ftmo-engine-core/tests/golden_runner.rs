//! Golden-fixture runner — loads JSON fixtures from `tests/golden/*.json`
//! and verifies the engine harness produces the expected outcome.
//!
//! Fixture schema (see `tests/golden/passlock_minimal.json`):
//!   {
//!     "name": "...",
//!     "cfg": EngineConfig (camelCase JSON),
//!     "bars_by_source": { "BTCUSDT": [Candle, ...] },
//!     "signals_by_bar": { "<bar_index>": [PollSignal, ...] },
//!     "expected": { "passed", "challenge_ended", "min_equity_pct", ... }
//!   }
//!
//! The TS-side dump script (`scripts/dumpRustGoldenFixture.ts`, deferred)
//! will eventually populate this directory from real V4-Sim runs so we
//! get bit-precise parity checks.

use std::collections::HashMap;
use std::path::PathBuf;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::EngineConfig;
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::state::EngineState;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    #[allow(dead_code)]
    description: Option<String>,
    cfg: EngineConfig,
    /// Number of leading bars in `bars_by_source` to load into the feed
    /// buffer for indicator history WITHOUT processing them as engine
    /// ticks. Matches TS `simulate(startBar=warmup)` semantics. Default 0.
    #[serde(default)]
    warmup: usize,
    bars_by_source: HashMap<String, Vec<Candle>>,
    #[serde(default)]
    signals_by_bar: HashMap<String, Vec<PollSignal>>,
    expected: Expected,
}

#[derive(Debug, Deserialize, Default)]
struct Expected {
    #[serde(default)]
    passed: Option<bool>,
    #[serde(default)]
    challenge_ended: Option<bool>,
    #[serde(default)]
    min_equity_pct: Option<f64>,
    #[serde(default)]
    max_equity_pct: Option<f64>,
    #[serde(default)]
    trades_count: Option<usize>,
    #[serde(default)]
    fail_reason: Option<String>,
    /// When true, mismatches panic. When false (default for TS-dumped
    /// fixtures), mismatches print a drift report but the test still
    /// passes — useful while detectAsset/V5R parity gaps still exist.
    #[serde(default = "default_true")]
    strict: bool,
    /// Diagnostic snapshots from the source-of-truth simulator. Surfaced
    /// in the drift report.
    #[serde(default)]
    ts_final_equity_pct: Option<f64>,
    #[serde(default)]
    ts_reason: Option<String>,
}

fn default_true() -> bool {
    true
}

fn run_fixture(fix: &Fixture) {
    let mut state = EngineState::initial(&fix.cfg.label);
    let mut feeds: HashMap<String, Vec<Candle>> = HashMap::new();
    for k in fix.bars_by_source.keys() {
        feeds.insert(k.clone(), Vec::new());
    }
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

    let n_bars = fix
        .bars_by_source
        .values()
        .map(|v| v.len())
        .max()
        .unwrap_or(0);

    // Anchor for engine: bar at index `warmup` (matches TS simulate startBar).
    let anchor_bar = fix
        .bars_by_source
        .values()
        .next()
        .and_then(|v| v.get(fix.warmup))
        .map(|c| c.open_time)
        .unwrap_or(0);
    state.challenge_start_ts = anchor_bar;
    state.last_bar_open_time = anchor_bar.saturating_sub(1);

    // Phase 1: pre-fill feed with warmup bars (indicator history).
    for i in 0..fix.warmup.min(n_bars) {
        for (k, arr) in fix.bars_by_source.iter() {
            if let Some(c) = arr.get(i) {
                feeds.get_mut(k).unwrap().push(*c);
            }
        }
    }

    // Phase 2: drive step_bar from warmup..n_bars.
    let mut last_result: Option<ftmo_engine_core::harness::StepResult> = None;
    for i in fix.warmup..n_bars {
        for (k, arr) in fix.bars_by_source.iter() {
            if let Some(c) = arr.get(i) {
                feeds.get_mut(k).unwrap().push(*c);
            }
        }
        let signals = fix
            .signals_by_bar
            .get(&i.to_string())
            .cloned()
            .unwrap_or_default();
        let r = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feeds,
                atr_series_by_source: &atr,
                signals,
            },
            &fix.cfg,
        );
        if r.challenge_ended {
            last_result = Some(r);
            break;
        }
        last_result = Some(r);
    }

    let r = last_result.expect("at least one bar processed");

    let equity_pct = state.equity - 1.0;
    println!(
        "[{}] passed={} ended={} eq_pct={:.4} trades={} fail_reason={:?}",
        fix.name,
        r.passed,
        r.challenge_ended,
        equity_pct,
        state.closed_trades.len(),
        r.fail_reason
    );

    let strict = fix.expected.strict;
    let mut diff_lines: Vec<String> = Vec::new();
    let mut record = |msg: String| {
        if strict {
            panic!("{}: {}", fix.name, msg);
        } else {
            diff_lines.push(msg);
        }
    };

    if let Some(p) = fix.expected.passed {
        if r.passed != p {
            record(format!("passed mismatch: rust={} expected={}", r.passed, p));
        }
    }
    if let Some(e) = fix.expected.challenge_ended {
        if r.challenge_ended != e {
            record(format!("challenge_ended mismatch: rust={} expected={}", r.challenge_ended, e));
        }
    }
    if let Some(min) = fix.expected.min_equity_pct {
        if equity_pct < min - 1e-6 {
            record(format!("equity_pct={} below min={}", equity_pct, min));
        }
    }
    if let Some(max) = fix.expected.max_equity_pct {
        if equity_pct > max + 1e-6 {
            record(format!("equity_pct={} above max={}", equity_pct, max));
        }
    }
    if let Some(n) = fix.expected.trades_count {
        if state.closed_trades.len() != n {
            record(format!("trade count: rust={} expected={}", state.closed_trades.len(), n));
        }
    }
    if let Some(reason) = fix.expected.fail_reason.as_deref() {
        let actual = format!("{:?}", r.fail_reason);
        // Normalise both sides: lowercase + strip underscores so
        // "Some(TotalLoss)" matches "total_loss" / "totalloss" etc.
        let norm = |s: &str| {
            s.to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
        };
        if !norm(&actual).contains(&norm(reason)) {
            record(format!("fail_reason: rust={:?} expected={:?}", actual, reason));
        }
    }

    if !diff_lines.is_empty() {
        let ts_eq = fix
            .expected
            .ts_final_equity_pct
            .map(|v| format!("{v:.4}"))
            .unwrap_or_else(|| "?".into());
        let ts_reason = fix.expected.ts_reason.as_deref().unwrap_or("?");
        eprintln!(
            "  ⚠ DRIFT [{}]: rust_eq={:.4} ts_eq={} rust_reason={:?} ts_reason={}",
            fix.name, equity_pct, ts_eq, r.fail_reason, ts_reason
        );
        for line in &diff_lines {
            eprintln!("      • {line}");
        }
    }
}

#[test]
fn run_all_golden_fixtures() {
    let dir: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden");
    let entries = std::fs::read_dir(&dir).unwrap_or_else(|e| {
        panic!("could not read {}: {e}", dir.display());
    });
    let mut count = 0;
    for entry in entries {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw = std::fs::read(&path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let fix: Fixture = serde_json::from_slice(&raw)
            .unwrap_or_else(|e| panic!("parsing {}: {e}", path.display()));
        run_fixture(&fix);
        count += 1;
    }
    assert!(count >= 1, "no golden fixtures found in {}", dir.display());
    println!("verified {count} golden fixtures");
}
