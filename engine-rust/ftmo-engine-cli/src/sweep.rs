//! ftmo-sweep — rayon-native sharded backtest sweeper. Replaces the
//! `_r28V6Shard.ts × 8 + _r28V6Aggregate.ts` pipeline with a single Rust
//! binary that walks the configured windows in parallel and emits JSONL
//! one-result-per-line.
//!
//! Invocation:
//!     ftmo-sweep --candles <BTCUSDT_30m.json> [--config R28_V6_PASSLOCK]
//!                [--windows N] [--threads T] [--out results.jsonl]
//!                [--signals breakout|trend|meanrev|none]
//!
//! Exit code 0 = run finished, regardless of pass/fail rate.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Result};
use ftmo_engine_core::config::{AssetConfig, EngineConfig};
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::indicators::atr;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::signals_breakout::{detect_breakout, BreakoutParams};
use ftmo_engine_core::signals_meanrev::detect_mean_reversion;
use ftmo_engine_core::signals_trend::{detect_trend_pullback, TrendParams};
use ftmo_engine_core::state::EngineState;
use ftmo_engine_core::templates;
use ftmo_engine_core::Candle;
use rayon::prelude::*;
use serde::Serialize;

mod loader;

#[derive(Serialize, Clone, Debug)]
struct WindowResult {
    win_idx: usize,
    config_label: String,
    bars: usize,
    trades: usize,
    final_equity_pct: f64,
    final_day: u32,
    passed: bool,
    fail_reason: Option<String>,
    elapsed_ms: f64,
}

#[derive(Clone, Copy)]
enum SignalSrc {
    None,
    Breakout,
    MeanRev,
    Trend,
}

fn main() -> Result<()> {
    let mut candles_path: Option<PathBuf> = None;
    let mut config_selector: Option<String> = None;
    let mut windows: usize = 8;
    let mut threads: Option<usize> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut signals = SignalSrc::Breakout;

    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--candles" => candles_path = Some(PathBuf::from(args.next().unwrap())),
            "--config" => config_selector = Some(args.next().unwrap()),
            "--windows" => windows = args.next().unwrap().parse()?,
            "--threads" => threads = Some(args.next().unwrap().parse()?),
            "--out" => out_path = Some(PathBuf::from(args.next().unwrap())),
            "--signals" => {
                signals = match args.next().unwrap().as_str() {
                    "none" => SignalSrc::None,
                    "breakout" => SignalSrc::Breakout,
                    "meanrev" => SignalSrc::MeanRev,
                    "trend" => SignalSrc::Trend,
                    other => return Err(anyhow!("unknown --signals: {other}")),
                };
            }
            "--list-configs" => {
                for s in templates::known_selectors() {
                    println!("{s}");
                }
                return Ok(());
            }
            other => return Err(anyhow!("unknown arg: {other}")),
        }
    }
    let candles_path = candles_path.ok_or_else(|| anyhow!("--candles is required"))?;
    let candles = loader::load_candles(&candles_path)?;
    let symbol = candles_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.split('_').next().unwrap_or(s).to_string())
        .unwrap_or_else(|| "UNKNOWN".into());

    if let Some(t) = threads {
        rayon::ThreadPoolBuilder::new()
            .num_threads(t)
            .build_global()
            .ok();
    }

    let cfg = match config_selector.as_deref() {
        Some(s) => templates::template_by_selector(s)
            .ok_or_else(|| anyhow!("unknown selector: {s}"))?,
        None => {
            let mut c = templates::r28_v6_passlock();
            // Replace asset list with the single loaded symbol so signals match.
            c.assets = vec![AssetConfig {
                symbol: format!("{symbol}-TREND"),
                source_symbol: Some(symbol.clone()),
                tp_pct: None,
                stop_pct: None,
                risk_frac: 0.4,
                activate_after_day: None,
                min_equity_gain: None,
                max_equity_gain: None,
                hold_bars: None,
                invert_direction: false,
            }];
            c
        }
    };

    println!(
        "ftmo-sweep: {} bars / {} ({}); {} threads; signals={}",
        candles.len(),
        symbol,
        cfg.label,
        rayon::current_num_threads(),
        match signals {
            SignalSrc::None => "none",
            SignalSrc::Breakout => "breakout",
            SignalSrc::MeanRev => "meanrev",
            SignalSrc::Trend => "trend",
        },
    );

    let cfg = Arc::new(cfg);
    let candles = Arc::new(candles);
    let symbol = Arc::new(symbol);
    let atr_series = Arc::new(atr(&candles, 14));

    let started = Instant::now();
    let win_size = candles.len() / windows.max(1);

    let writer: Arc<Mutex<Option<BufWriter<File>>>> = Arc::new(Mutex::new(match &out_path {
        Some(p) => Some(BufWriter::new(File::create(p)?)),
        None => None,
    }));

    let reports: Vec<WindowResult> = (0..windows)
        .into_par_iter()
        .map(|w| {
            let lo = w * win_size;
            let hi = if w == windows - 1 { candles.len() } else { (w + 1) * win_size };
            let win_started = Instant::now();
            let mut state = EngineState::initial(&cfg.label);
            let mut bars = 0usize;
            let asset = if let Some(a) = cfg.assets.iter().find(|a| {
                a.source_symbol.as_deref() == Some(symbol.as_str())
                    || a.symbol == format!("{}-TREND", symbol.as_str())
            }) {
                a.clone()
            } else if !cfg.assets.is_empty() {
                cfg.assets[0].clone()
            } else {
                AssetConfig {
                    symbol: format!("{symbol}-TREND"),
                    source_symbol: Some(symbol.to_string()),
                    tp_pct: None,
                    stop_pct: None,
                    risk_frac: 0.4,
                    activate_after_day: None,
                    min_equity_gain: None,
                    max_equity_gain: None,
                    hold_bars: None,
                    invert_direction: false,
                }
            };
            let breakout_params = BreakoutParams::from_cfg(cfg.as_ref(), &asset);
            let trend_params = TrendParams::from_cfg(cfg.as_ref(), &asset);
            let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
            feed.insert(symbol.to_string(), Vec::with_capacity(hi - lo));
            let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
            atr_feed.insert(symbol.to_string(), Vec::with_capacity(hi - lo));
            let mut last_passed = false;
            let mut last_fail: Option<String> = None;
            for i in lo..hi {
                feed.get_mut(symbol.as_str()).unwrap().push(candles[i]);
                atr_feed.get_mut(symbol.as_str()).unwrap().push(atr_series[i]);
                let signals_for_bar: Vec<PollSignal> = match signals {
                    SignalSrc::None => vec![],
                    SignalSrc::Breakout => {
                        let arr = feed.get(symbol.as_str()).unwrap();
                        match detect_breakout(
                            &mut state,
                            cfg.as_ref(),
                            &asset,
                            symbol.as_str(),
                            arr,
                            &breakout_params,
                        ) {
                            Some(s) => vec![s],
                            None => vec![],
                        }
                    }
                    SignalSrc::MeanRev => {
                        let arr = feed.get(symbol.as_str()).unwrap();
                        let src = cfg.mean_reversion_source.unwrap_or(
                            ftmo_engine_core::config::MeanReversionSource {
                                period: 14,
                                oversold: 25.0,
                                overbought: 75.0,
                                cooldown_bars: 8,
                                size_mult: 0.5,
                            },
                        );
                        match detect_mean_reversion(
                            &mut state,
                            cfg.as_ref(),
                            &asset,
                            symbol.as_str(),
                            arr,
                            &src,
                        ) {
                            Some(s) => vec![s],
                            None => vec![],
                        }
                    }
                    SignalSrc::Trend => {
                        let arr = feed.get(symbol.as_str()).unwrap();
                        match detect_trend_pullback(
                            &mut state,
                            cfg.as_ref(),
                            &asset,
                            symbol.as_str(),
                            arr,
                            &trend_params,
                        ) {
                            Some(s) => vec![s],
                            None => vec![],
                        }
                    }
                };
                let r = step_bar(
                    &mut state,
                    &BarInput {
                        candles_by_source: &feed,
                        atr_series_by_source: &atr_feed,
                        signals: signals_for_bar,
                    },
                    cfg.as_ref(),
                );
                bars += 1;
                if r.challenge_ended {
                    last_passed = r.passed;
                    last_fail = r.fail_reason.map(|f| format!("{f:?}"));
                    break;
                }
            }
            let report = WindowResult {
                win_idx: w,
                config_label: cfg.label.clone(),
                bars,
                trades: state.closed_trades.len(),
                final_equity_pct: state.equity - 1.0,
                final_day: state.day,
                passed: last_passed,
                fail_reason: last_fail.or_else(|| state.stopped_reason.map(|r| format!("{r:?}"))),
                elapsed_ms: win_started.elapsed().as_secs_f64() * 1000.0,
            };
            // Stream JSONL if --out.
            if let Ok(mut g) = writer.lock() {
                if let Some(w) = g.as_mut() {
                    if let Ok(line) = serde_json::to_string(&report) {
                        let _ = writeln!(w, "{line}");
                    }
                }
            }
            report
        })
        .collect();

    if let Ok(mut g) = writer.lock() {
        if let Some(w) = g.as_mut() {
            w.flush()?;
        }
    }

    let elapsed = started.elapsed();
    let total_bars: usize = reports.iter().map(|r| r.bars).sum();
    let total_trades: usize = reports.iter().map(|r| r.trades).sum();
    let passed = reports.iter().filter(|r| r.passed).count();
    let bars_per_sec = total_bars as f64 / elapsed.as_secs_f64();

    println!(
        "{} bars / {} trades across {} windows in {:.3}s — {:.0} bars/sec",
        total_bars,
        total_trades,
        windows,
        elapsed.as_secs_f64(),
        bars_per_sec,
    );
    println!("passed={passed} / {windows} ({:.2}%)", passed as f64 / windows as f64 * 100.0);
    Ok(())
}
