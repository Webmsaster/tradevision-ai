//! Round 67 Asset-Importance Sweep — for each of the 9 R28_V6_PASSLOCK
//! basket assets, simulate "what if asset X removed" by filtering its
//! signals from `signals_by_bar`. Compare resulting pass-rate vs baseline.
//!
//! High-impact assets: removal causes big drop → essential, keep.
//! Low-impact assets: removal causes <0.5pp change → swap candidate.
//!
//! Output: per-asset Δpass-rate. Run-time: ~30s for 137 windows × 10 configs.

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
}

fn run_with_filter(fix: &Fixture, exclude_source: Option<&str>) -> bool {
    let mut state = EngineState::initial(&fix.cfg.label);
    let n_bars = fix
        .bars_by_source
        .values()
        .map(|v| v.len())
        .max()
        .unwrap_or(0);
    let mut feeds: HashMap<String, Vec<Candle>> = HashMap::new();
    for k in fix.bars_by_source.keys() {
        feeds.insert(k.clone(), Vec::new());
    }
    let chand_period = fix
        .cfg
        .chandelier_exit
        .as_ref()
        .map(|c| c.period as usize)
        .unwrap_or(14);
    let mut atr_full: HashMap<String, Vec<Option<f64>>> = HashMap::new();
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
        let raw_signals = fix
            .signals_by_bar
            .get(&i.to_string())
            .cloned()
            .unwrap_or_default();
        let signals: Vec<PollSignal> = if let Some(excl) = exclude_source {
            raw_signals
                .into_iter()
                .filter(|s| s.source_symbol != excl)
                .collect()
        } else {
            raw_signals
        };
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
    last_passed
}

#[test]
fn round67_asset_importance_sweep() {
    let dir: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden");
    let mut fixtures: Vec<Fixture> = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw = std::fs::read(&path).unwrap();
        let fix: Fixture = match serde_json::from_slice(&raw) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if fix.expected.ts_final_equity_pct.is_none() {
            continue;
        }
        fixtures.push(fix);
    }
    fixtures.sort_by(|a, b| a.name.cmp(&b.name));
    if fixtures.is_empty() {
        eprintln!("no TS-dumped fixtures found — skipping");
        return;
    }
    let n_windows = fixtures.len();

    // Discover all source-symbols actually used in signals.
    let mut sources: std::collections::BTreeSet<String> = Default::default();
    for fix in &fixtures {
        for sigs in fix.signals_by_bar.values() {
            for s in sigs {
                sources.insert(s.source_symbol.clone());
            }
        }
    }
    let sources: Vec<String> = sources.into_iter().collect();

    let t0 = std::time::Instant::now();

    // Baseline (no exclusion)
    let mut baseline_pass = 0usize;
    for fix in &fixtures {
        if run_with_filter(fix, None) {
            baseline_pass += 1;
        }
    }
    let baseline_rate = (baseline_pass as f64) / (n_windows as f64) * 100.0;

    // Per-source exclusion sweep
    let mut rows: Vec<(String, usize, f64)> = Vec::new();
    for src in &sources {
        let mut pass = 0usize;
        for fix in &fixtures {
            if run_with_filter(fix, Some(src)) {
                pass += 1;
            }
        }
        let rate = (pass as f64) / (n_windows as f64) * 100.0;
        rows.push((src.clone(), pass, rate - baseline_rate));
    }

    let elapsed = t0.elapsed();

    rows.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));

    eprintln!();
    eprintln!(
        "=== Round 67 Asset-Importance Sweep — {} windows × {} excl-configs in {:.2}s ===",
        n_windows,
        sources.len() + 1,
        elapsed.as_secs_f64()
    );
    eprintln!();
    eprintln!("Baseline (all assets): {}/{} = {:.2}%", baseline_pass, n_windows, baseline_rate);
    eprintln!();
    eprintln!(
        "{:<5} {:<14} {:>15} {:>10}",
        "rank", "removed", "pass", "Δpp"
    );
    eprintln!("{}", "-".repeat(50));
    for (i, (src, pass, delta)) in rows.iter().enumerate() {
        let rate = (*pass as f64) / (n_windows as f64) * 100.0;
        eprintln!(
            "{:<5} {:<14} {:>10}/{} {:>+9.2}pp",
            i + 1,
            src,
            pass,
            n_windows,
            delta
        );
    }
    eprintln!();
    eprintln!("Interpretation:");
    eprintln!("  Δpp ≤ -3pp: ESSENTIAL — removal hurts a lot, asset is load-bearing");
    eprintln!("  Δpp around 0: NEUTRAL — asset is replaceable");
    eprintln!("  Δpp ≥ +1pp: REDUNDANT — removal HELPS, asset is net-negative");
}
