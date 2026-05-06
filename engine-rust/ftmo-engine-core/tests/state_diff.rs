//! State-Diff Runner — find the FIRST bar where Rust state diverges from
//! TS V4-Sim state. Reads a debug-state fixture (dumped with
//! `--debug-state`), runs Rust harness, compares state-per-bar.
//!
//! Run with:
//!   STATE_DIFF_FIXTURE=/tmp/w2_debug.json \
//!     cargo test --test state_diff --release -- --nocapture

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
    cfg: EngineConfig,
    #[serde(default)]
    warmup: usize,
    bars_by_source: HashMap<String, Vec<Candle>>,
    #[serde(default)]
    signals_by_bar: HashMap<String, Vec<PollSignal>>,
    #[serde(default)]
    state_per_bar: HashMap<String, TsState>,
}

#[derive(Debug, Deserialize, Clone)]
struct TsState {
    equity: f64,
    #[serde(rename = "mtmEquity")]
    mtm_equity: f64,
    #[serde(rename = "dayPeak")]
    day_peak: f64,
    #[serde(rename = "challengePeak")]
    challenge_peak: f64,
    day: u32,
    #[serde(rename = "dayStart")]
    day_start: f64,
    #[serde(rename = "openCount")]
    open_count: usize,
    #[serde(rename = "tradingDaysCount")]
    trading_days_count: usize,
    #[serde(rename = "firstTargetHitDay")]
    first_target_hit_day: Option<u32>,
    #[serde(rename = "pausedAtTarget")]
    paused_at_target: bool,
}

fn approx_eq(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn find_first_divergence() {
    let path = match std::env::var("STATE_DIFF_FIXTURE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => {
            eprintln!("[state_diff] no STATE_DIFF_FIXTURE env — skipping");
            return;
        }
    };
    if !path.exists() {
        eprintln!("[state_diff] fixture {} not found — skipping", path.display());
        return;
    }
    let raw = std::fs::read(&path).unwrap();
    let fix: Fixture = serde_json::from_slice(&raw).unwrap();
    if fix.state_per_bar.is_empty() {
        eprintln!("[state_diff] fixture has no state_per_bar — re-dump with --debug-state");
        return;
    }

    let n_bars = fix
        .bars_by_source
        .values()
        .map(|v| v.len())
        .max()
        .unwrap_or(0);
    let mut state = EngineState::initial(&fix.cfg.label);
    let mut feeds: HashMap<String, Vec<Candle>> = HashMap::new();
    let mut atr_full: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    let chand_period = fix
        .cfg
        .chandelier_exit
        .as_ref()
        .map(|c| c.period as usize)
        .unwrap_or(14);
    for (k, arr) in fix.bars_by_source.iter() {
        feeds.insert(k.clone(), Vec::new());
        atr_full.insert(k.clone(), atr(arr, chand_period));
    }
    let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    for k in fix.bars_by_source.keys() {
        atr_feed.insert(k.clone(), Vec::new());
    }

    // Phase 1: pre-fill warmup bars without step_bar.
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

    // Phase 2: drive step_bar and compare state at each bar.
    let trace_through = std::env::var("STATE_DIFF_TRACE")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);

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

        // Compare state to TS snapshot for this bar.
        if let Some(ts) = fix.state_per_bar.get(&i.to_string()) {
            if i < fix.warmup + trace_through {
                eprintln!(
                    "  bar {} → TS: eq={:.6} mtm={:.6} dayPeak={:.6} open={} ts_signal={}",
                    i, ts.equity, ts.mtm_equity, ts.day_peak, ts.open_count,
                    fix.signals_by_bar.contains_key(&i.to_string())
                );
                eprintln!(
                    "          Rust: eq={:.6} mtm={:.6} dayPeak={:.6} open={} closed={}",
                    state.equity, state.mtm_equity, state.day_peak, state.open_positions.len(), state.closed_trades.len()
                );
            }
            let mut diffs: Vec<String> = Vec::new();
            if !approx_eq(ts.equity, state.equity) {
                diffs.push(format!(
                    "equity:    ts={:.10} rust={:.10} Δ={:+.10}",
                    ts.equity, state.equity, state.equity - ts.equity
                ));
            }
            if !approx_eq(ts.mtm_equity, state.mtm_equity) {
                diffs.push(format!(
                    "mtm:       ts={:.10} rust={:.10} Δ={:+.10}",
                    ts.mtm_equity, state.mtm_equity, state.mtm_equity - ts.mtm_equity
                ));
            }
            if !approx_eq(ts.day_peak, state.day_peak) {
                diffs.push(format!(
                    "dayPeak:   ts={:.10} rust={:.10} Δ={:+.10}",
                    ts.day_peak, state.day_peak, state.day_peak - ts.day_peak
                ));
            }
            if !approx_eq(ts.challenge_peak, state.challenge_peak) {
                diffs.push(format!(
                    "chPeak:    ts={:.10} rust={:.10} Δ={:+.10}",
                    ts.challenge_peak,
                    state.challenge_peak,
                    state.challenge_peak - ts.challenge_peak
                ));
            }
            if ts.day != state.day {
                diffs.push(format!("day:       ts={} rust={}", ts.day, state.day));
            }
            if !approx_eq(ts.day_start, state.day_start) {
                diffs.push(format!(
                    "dayStart:  ts={:.10} rust={:.10}",
                    ts.day_start, state.day_start
                ));
            }
            if ts.open_count != state.open_positions.len() {
                diffs.push(format!(
                    "openCount: ts={} rust={}",
                    ts.open_count,
                    state.open_positions.len()
                ));
            }
            if ts.trading_days_count != state.trading_days.len() {
                diffs.push(format!(
                    "tradingDays: ts={} rust={}",
                    ts.trading_days_count,
                    state.trading_days.len()
                ));
            }
            if ts.first_target_hit_day != state.first_target_hit_day {
                diffs.push(format!(
                    "firstTargetHitDay: ts={:?} rust={:?}",
                    ts.first_target_hit_day, state.first_target_hit_day
                ));
            }
            if ts.paused_at_target != state.paused_at_target {
                diffs.push(format!(
                    "pausedAtTarget: ts={} rust={}",
                    ts.paused_at_target, state.paused_at_target
                ));
            }
            if !diffs.is_empty() {
                eprintln!();
                eprintln!("=== FIRST DIVERGENCE at bar {} ===", i);
                for d in &diffs {
                    eprintln!("  {d}");
                }
                eprintln!();
                eprintln!(
                    "Context: rust_open_positions = {}",
                    state.open_positions.len()
                );
                if !state.open_positions.is_empty() {
                    eprintln!("First Rust open position:");
                    let p = &state.open_positions[0];
                    eprintln!(
                        "  symbol={} dir={:?} entry_price={} stop={} tp={} eff_risk={} bar_idx={}",
                        p.symbol, p.direction, p.entry_price, p.stop_price, p.tp_price, p.eff_risk, p.entry_bar_idx
                    );
                    eprintln!(
                        "  high_watermark={} ptp_triggered={} ptp_realized_pct={}",
                        p.high_watermark, p.ptp_triggered, p.ptp_realized_pct
                    );
                }
                return; // first divergence found, that's enough
            }
        }

        if r.challenge_ended {
            break;
        }
    }

    eprintln!("[state_diff] no divergence found across all bars — Rust matches TS");
}
