//! Drift-Diagnose — instrumentiert eine einzelne golden fixture und zählt
//! pro skip-reason die geblockten Signale. Identifiziert welcher Entry-Gate
//! die TS-vs-Rust Trade-Lücke verursacht.
//!
//! NICHT als Unit-Test gedacht — wird mit `cargo test --test drift_diagnose --
//! --nocapture` manuell aufgerufen wenn Drift-Diagnose nötig.

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
    trades_count: Option<usize>,
}

fn diagnose(fix: &Fixture) {
    let mut state = EngineState::initial(&fix.cfg.label);
    let n_bars = fix
        .bars_by_source
        .values()
        .map(|v| v.len())
        .max()
        .unwrap_or(0);
    // Don't pre-set anchors — let step_bar's first-call branch do it,
    // exactly mirroring TS pollLive's anchor logic.
    let _ = fix.warmup;

    let mut feeds: HashMap<String, Vec<Candle>> = HashMap::new();
    for k in fix.bars_by_source.keys() {
        feeds.insert(k.clone(), Vec::new());
    }
    // Pre-compute the full ATR series per source symbol so the chandelier
    // exit can fire (mirror TS pollLive line ~1287 which computes ATR live).
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

    let mut signals_offered = 0usize;
    let mut signals_opened = 0usize;
    let mut skip_counts: HashMap<String, usize> = HashMap::new();
    let mut note_counts: HashMap<String, usize> = HashMap::new();
    let mut last_open_bar = 0usize;
    let mut first_skip_bar: Option<usize> = None;

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
        signals_offered += signals.len();
        let r = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feeds,
                atr_series_by_source: &atr_feed,
                signals,
            },
            &fix.cfg,
        );
        if !r.decision.opens.is_empty() {
            signals_opened += r.decision.opens.len();
            last_open_bar = i;
        }
        for skip in &r.skipped {
            let category = skip
                .reason
                .split_whitespace()
                .next()
                .unwrap_or("unknown")
                .to_string();
            *skip_counts.entry(category).or_insert(0) += 1;
            if first_skip_bar.is_none() {
                first_skip_bar = Some(i);
            }
        }
        for note in &r.notes {
            let category = note
                .split(|c: char| c == ':' || c.is_whitespace())
                .next()
                .unwrap_or("unknown")
                .to_string();
            *note_counts.entry(category).or_insert(0) += 1;
        }
        if r.challenge_ended {
            break;
        }
    }

    let ts_eq = fix.expected.ts_final_equity_pct.unwrap_or(f64::NAN);
    let ts_trd = fix.expected.trades_count.unwrap_or(0);
    let rust_eq = state.equity - 1.0;
    eprintln!();
    eprintln!("=== Drift diagnose: {} ===", fix.name);
    eprintln!("  TS:   eq={ts_eq:+.4}  trades={ts_trd}");
    eprintln!(
        "  Rust: eq={:+.4}  trades={}  bars_seen={}  day={}  stopped={:?}",
        rust_eq, state.closed_trades.len(), state.bars_seen, state.day, state.stopped_reason
    );
    eprintln!("  Signals offered: {signals_offered}");
    eprintln!("  Signals opened:  {signals_opened}");
    if let Some(b) = first_skip_bar {
        eprintln!("  First skip at bar: {b} (last open at {last_open_bar})");
    }
    if !skip_counts.is_empty() {
        eprintln!("  Skip reasons:");
        let mut items: Vec<_> = skip_counts.iter().collect();
        items.sort_by(|a, b| b.1.cmp(a.1));
        for (k, v) in items {
            eprintln!("    {v:>5}× {k}");
        }
    }
    if !note_counts.is_empty() {
        let bar_gates: Vec<_> = note_counts
            .iter()
            .filter(|(k, _)| {
                k.starts_with("daily")
                    || k.starts_with("challenge")
                    || k.starts_with("intraday")
                    || k.starts_with("hour")
                    || k.starts_with("dow")
                    || k.contains("Guardian")
            })
            .collect();
        if !bar_gates.is_empty() {
            eprintln!("  Bar-level gate notes:");
            let mut items = bar_gates;
            items.sort_by(|a, b| b.1.cmp(a.1));
            for (k, v) in items {
                eprintln!("    {v:>5}× {k}");
            }
        }
    }
}

#[test]
fn diagnose_all_drifting_fixtures() {
    let dir: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden");
    if !dir.exists() {
        eprintln!("no golden dir — skipping");
        return;
    }
    let mut found = 0usize;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let fix: Fixture = match serde_json::from_slice(&raw) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if fix.expected.ts_final_equity_pct.is_none() {
            continue;
        }
        diagnose(&fix);
        found += 1;
    }
    if found == 0 {
        eprintln!("no TS-dumped fixtures — run scripts/dumpRustGoldenFixture.ts first");
    }
}
