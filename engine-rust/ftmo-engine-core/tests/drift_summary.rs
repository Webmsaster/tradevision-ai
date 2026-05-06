//! Drift-Summary — runs all TS-dumped fixtures, computes the equity
//! delta vs the source-of-truth simulator, and prints a quantitative
//! report.
//!
//! This test always passes (it's a measurement, not a gate). The intent
//! is to track parity-drift over time as detectAsset gets ported and
//! engine fixes land. Each new round should reduce the median |drift|.

use std::collections::HashMap;
use std::path::PathBuf;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::EngineConfig;
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::indicators::atr;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::state::EngineState;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    cfg: EngineConfig,
    #[serde(default)]
    warmup: usize,
    bars_by_source: HashMap<String, Vec<Candle>>,
    #[serde(default)]
    signals_by_bar: HashMap<String, Vec<PollSignal>>,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
struct Expected {
    #[serde(default)]
    ts_final_equity_pct: Option<f64>,
    #[serde(default)]
    ts_reason: Option<String>,
    #[serde(default)]
    passed: Option<bool>,
    #[serde(default)]
    trades_count: Option<usize>,
}

#[derive(Debug)]
struct DriftRow {
    name: String,
    ts_eq: f64,
    rust_eq: f64,
    ts_passed: bool,
    rust_passed: bool,
    ts_trades: usize,
    rust_trades: usize,
}

fn run_fixture(fix: &Fixture) -> DriftRow {
    let mut state = EngineState::initial(&fix.cfg.label);
    let n_bars = fix
        .bars_by_source
        .values()
        .map(|v| v.len())
        .max()
        .unwrap_or(0);
    // Don't pre-set anchors — step_bar's first-call branch handles it.

    let mut feeds: HashMap<String, Vec<Candle>> = HashMap::new();
    for k in fix.bars_by_source.keys() {
        feeds.insert(k.clone(), Vec::new());
    }
    let mut atr_full: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    let chand_period = fix
        .cfg
        .chandelier_exit
        .as_ref()
        .map(|c| c.period as usize)
        .unwrap_or(14);
    for (k, arr) in fix.bars_by_source.iter() {
        atr_full.insert(k.clone(), atr(arr, chand_period));
    }
    let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    for k in fix.bars_by_source.keys() {
        atr_feed.insert(k.clone(), Vec::new());
    }

    for i in 0..fix.warmup.min(n_bars) {
        for (k, arr) in fix.bars_by_source.iter() {
            if let Some(c) = arr.get(i) {
                feeds.get_mut(k).unwrap().push(*c);
            }
            if let Some(series) = atr_full.get(k) {
                if let Some(v) = series.get(i).copied() {
                    atr_feed.get_mut(k).unwrap().push(v);
                }
            }
        }
    }

    let mut last_passed = false;
    for i in fix.warmup..n_bars {
        for (k, arr) in fix.bars_by_source.iter() {
            if let Some(c) = arr.get(i) {
                feeds.get_mut(k).unwrap().push(*c);
            }
            if let Some(series) = atr_full.get(k) {
                if let Some(v) = series.get(i).copied() {
                    atr_feed.get_mut(k).unwrap().push(v);
                }
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
                atr_series_by_source: &atr_feed,
                signals,
            },
            &fix.cfg,
        );
        last_passed = r.passed;
        if r.challenge_ended {
            break;
        }
    }

    DriftRow {
        name: fix.name.clone(),
        ts_eq: fix.expected.ts_final_equity_pct.unwrap_or(f64::NAN),
        rust_eq: state.equity - 1.0,
        ts_passed: fix.expected.passed.unwrap_or(false),
        rust_passed: last_passed,
        ts_trades: fix.expected.trades_count.unwrap_or(0),
        rust_trades: state.closed_trades.len(),
    }
}

#[test]
fn ts_drift_summary() {
    let dir: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden");
    let mut rows: Vec<DriftRow> = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Only TS-dumped fixtures carry ts_final_equity_pct.
        let raw = std::fs::read(&path).unwrap();
        let fix: Fixture = match serde_json::from_slice(&raw) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if fix.expected.ts_final_equity_pct.is_none() {
            continue; // hand-crafted, skip
        }
        rows.push(run_fixture(&fix));
    }
    if rows.is_empty() {
        eprintln!("no TS-dumped fixtures found — skipping drift summary");
        return;
    }

    rows.sort_by(|a, b| a.name.cmp(&b.name));

    eprintln!();
    eprintln!("=== TS ↔ Rust drift summary ({} windows) ===", rows.len());
    eprintln!(
        "{:<32} {:>10} {:>10} {:>10} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "name", "ts_eq", "rust_eq", "Δeq", "ts_pass", "rs_pass", "ts_trd", "rs_trd", "Δtrd"
    );
    let mut deltas: Vec<f64> = Vec::new();
    let mut pass_match = 0usize;
    for r in &rows {
        let delta = r.rust_eq - r.ts_eq;
        deltas.push(delta);
        let passed_match = r.rust_passed == r.ts_passed;
        if passed_match {
            pass_match += 1;
        }
        eprintln!(
            "{:<32} {:>+10.4} {:>+10.4} {:>+10.4} {:>8} {:>8} {:>8} {:>8} {:>+8}",
            r.name,
            r.ts_eq,
            r.rust_eq,
            delta,
            r.ts_passed,
            r.rust_passed,
            r.ts_trades,
            r.rust_trades,
            r.rust_trades as i64 - r.ts_trades as i64
        );
    }
    deltas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = deltas[deltas.len() / 2];
    let max_abs = deltas.iter().map(|d| d.abs()).fold(0.0_f64, f64::max);
    let mean: f64 = deltas.iter().sum::<f64>() / deltas.len() as f64;
    eprintln!();
    eprintln!(
        "Δeq stats: mean={mean:+.4}  median={median:+.4}  max|Δ|={max_abs:.4}  pass-match={}/{}",
        pass_match,
        rows.len()
    );
}
