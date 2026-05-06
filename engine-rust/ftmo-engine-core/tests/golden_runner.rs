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
}

fn run_fixture(fix: &Fixture) {
    let mut state = EngineState::initial(&fix.cfg.label);
    // Initialise anchors so the very first bar is processed.
    let first_bar_time = fix
        .bars_by_source
        .values()
        .next()
        .and_then(|v| v.first())
        .map(|c| c.open_time)
        .unwrap_or(0);
    state.challenge_start_ts = first_bar_time;
    state.last_bar_open_time = first_bar_time - 1;

    // Build per-source incremental feeds.
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

    let mut last_result: Option<ftmo_engine_core::harness::StepResult> = None;
    for i in 0..n_bars {
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

    if let Some(p) = fix.expected.passed {
        assert_eq!(r.passed, p, "{}: passed mismatch", fix.name);
    }
    if let Some(e) = fix.expected.challenge_ended {
        assert_eq!(r.challenge_ended, e, "{}: challenge_ended mismatch", fix.name);
    }
    if let Some(min) = fix.expected.min_equity_pct {
        assert!(
            equity_pct >= min - 1e-6,
            "{}: equity_pct={} below min={}",
            fix.name,
            equity_pct,
            min
        );
    }
    if let Some(max) = fix.expected.max_equity_pct {
        assert!(
            equity_pct <= max + 1e-6,
            "{}: equity_pct={} above max={}",
            fix.name,
            equity_pct,
            max
        );
    }
    if let Some(n) = fix.expected.trades_count {
        assert_eq!(state.closed_trades.len(), n, "{}: trade count", fix.name);
    }
    if let Some(reason) = fix.expected.fail_reason.as_deref() {
        let actual = format!("{:?}", r.fail_reason);
        assert!(
            actual.to_lowercase().contains(&reason.to_lowercase()),
            "{}: fail_reason {:?} did not contain {:?}",
            fix.name,
            actual,
            reason
        );
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
