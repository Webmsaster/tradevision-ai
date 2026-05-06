//! Round 66 Daily-Loss-Attack Sweep — Rust replay of all 137 R28_V6_PASSLOCK
//! fixtures with config-overrides on:
//!   dailyPeakTrailingStop.trailDistance ∈ {0.008, 0.010, 0.012, 0.015, 0.018}
//!   peakDrawdownThrottle ∈ {None, 0.03/0.3, 0.04/0.2, 0.04/0.15}
//!
//! 5×4=20 configs × 137 windows = 2740 sims. Should run in <60s.
//! Output: stderr table + per-config aggregate.

use std::collections::HashMap;
use std::path::PathBuf;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::{EngineConfig, PeakDrawdownThrottle, PeakTrailingStop};
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

#[derive(Clone)]
struct ConfigOverride {
    label: &'static str,
    trail: f64,
    pdt: Option<(f64, f64)>,
}

fn run_with_override(fix: &Fixture, ov: &ConfigOverride) -> bool {
    let mut cfg = fix.cfg.clone();
    cfg.daily_peak_trailing_stop = Some(PeakTrailingStop {
        trail_distance: ov.trail,
    });
    cfg.peak_drawdown_throttle = ov.pdt.map(|(from_peak, factor)| PeakDrawdownThrottle {
        from_peak,
        factor,
    });
    let mut state = EngineState::initial(&cfg.label);
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
    let chand_period = cfg
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
            &cfg,
        );
        last_passed = r.passed;
        if r.challenge_ended {
            break;
        }
    }
    last_passed
}

#[test]
fn round66_dl_attack_sweep() {
    let dir: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden");
    let trails = [0.008, 0.010, 0.012, 0.015, 0.018];
    let pdts: Vec<(&str, Option<(f64, f64)>)> = vec![
        ("none", None),
        ("0.03/0.3", Some((0.03, 0.3))),
        ("0.04/0.2", Some((0.04, 0.2))),
        ("0.04/0.15", Some((0.04, 0.15))),
    ];

    // Build the 20-config grid
    let mut configs: Vec<ConfigOverride> = Vec::new();
    for &trail in &trails {
        for (pdt_name, pdt) in &pdts {
            let label: &'static str = Box::leak(format!("trail={trail:.3}_pdt={pdt_name}").into_boxed_str());
            configs.push(ConfigOverride {
                label,
                trail,
                pdt: *pdt,
            });
        }
    }

    // Load all fixtures once
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
    let t0 = std::time::Instant::now();

    // Per-config result tally
    let mut results: Vec<(String, f64, &'static str, usize)> = Vec::new();
    for ov in &configs {
        let mut pass = 0usize;
        for fix in &fixtures {
            if run_with_override(fix, ov) {
                pass += 1;
            }
        }
        results.push((ov.label.to_string(), ov.trail, ov.pdt.map(|_| match (ov.pdt.unwrap().0, ov.pdt.unwrap().1) {
            (0.03, 0.3) => "0.03/0.3",
            (0.04, 0.2) => "0.04/0.2",
            (0.04, 0.15) => "0.04/0.15",
            _ => "?",
        }).unwrap_or("none"), pass));
    }
    let elapsed = t0.elapsed();

    // Sort by pass count
    let mut sorted = results.clone();
    sorted.sort_by(|a, b| b.3.cmp(&a.3));

    eprintln!();
    eprintln!(
        "=== Round 66 DL-Attack Sweep — {} windows × {} configs in {:.2}s ===",
        n_windows,
        configs.len(),
        elapsed.as_secs_f64()
    );
    eprintln!();
    eprintln!(
        "{:<5} {:>8} {:<12} {:>15} {:>10}",
        "rank", "trail", "pdt", "PASS", "rate"
    );
    eprintln!("{}", "-".repeat(55));
    for (i, (_label, trail, pdt, pass)) in sorted.iter().enumerate() {
        let rate = (*pass as f64) / (n_windows as f64) * 100.0;
        eprintln!(
            "{:<5} {:>8.3} {:<12} {:>10}/{} {:>9.2}%",
            i + 1,
            trail,
            pdt,
            pass,
            n_windows,
            rate
        );
    }

    // Compare champion to baseline (trail=0.012, pdt=none)
    let baseline = results
        .iter()
        .find(|(_, t, p, _)| (*t - 0.012).abs() < 1e-9 && *p == "none")
        .map(|(_, _, _, p)| *p);
    let champ = sorted[0].3;
    if let Some(b) = baseline {
        let delta_pp = (champ as f64 - b as f64) / (n_windows as f64) * 100.0;
        eprintln!();
        eprintln!(
            "🏆 Champion: {} pass ({:.2}%) | baseline (0.012/none): {} pass ({:.2}%) | Δ = {:+.2}pp",
            champ,
            (champ as f64) / (n_windows as f64) * 100.0,
            b,
            (b as f64) / (n_windows as f64) * 100.0,
            delta_pp
        );
    }
}
