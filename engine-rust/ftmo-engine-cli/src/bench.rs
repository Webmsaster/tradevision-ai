//! ftmo-bench — multi-window engine benchmark with rayon parallel windows.
//!
//! Invocation:
//!     ftmo-bench --candles <BTCUSDT_30m.json> [--windows N] [--threads T]
//!                [--signals breakout]
//!
//! Without `--signals`, walks `step_bar` over the candle stream with NO
//! entries — exercises only day-rollover, MTM, and idle bookkeeping paths.
//! With `--signals breakout`, runs a Donchian-style detector → step_bar
//! pipeline end-to-end.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use anyhow::{anyhow, Result};
use ftmo_engine_core::config::{AssetConfig, EngineConfig};
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::indicators::atr;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::signals_breakout::{detect_breakout, BreakoutParams};
use ftmo_engine_core::state::EngineState;
use ftmo_engine_core::Candle;
use rayon::prelude::*;

mod loader;

#[derive(Debug)]
struct WindowReport {
    idx: usize,
    bars: usize,
    final_equity: f64,
    final_day: u32,
    trades: usize,
    passed: bool,
    stopped: Option<String>,
    elapsed_ms: f64,
}

#[derive(Clone, Copy)]
enum SignalSrc {
    None,
    Breakout,
}

fn main() -> Result<()> {
    let mut candles_path: Option<PathBuf> = None;
    let mut windows: usize = 1;
    let mut threads: Option<usize> = None;
    let mut signals = SignalSrc::None;
    // R67 audit (Round 2): same `unwrap on None` panic-on-missing-arg as
    // sweep.rs — replaced with anyhow ok_or_else.
    let mut args = std::env::args().skip(1);
    macro_rules! need {
        ($flag:expr) => {
            args.next()
                .ok_or_else(|| anyhow!(concat!($flag, " requires a value")))?
        };
    }
    while let Some(a) = args.next() {
        match a.as_str() {
            "--candles" => candles_path = Some(PathBuf::from(need!("--candles"))),
            "--windows" => windows = need!("--windows").parse()?,
            "--threads" => threads = Some(need!("--threads").parse()?),
            "--signals" => {
                signals = match need!("--signals").as_str() {
                    "none" => SignalSrc::None,
                    "breakout" => SignalSrc::Breakout,
                    other => return Err(anyhow!("unknown --signals: {other}")),
                };
            }
            other => return Err(anyhow!("unknown arg: {other}")),
        }
    }
    if windows == 0 {
        return Err(anyhow!("--windows must be ≥ 1"));
    }
    let candles_path = candles_path.ok_or_else(|| anyhow!("--candles is required"))?;
    let candles = loader::load_candles_json(&candles_path)?;
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

    println!(
        "loaded {} candles ({}); rayon threads = {}; signals = {}",
        candles.len(),
        symbol,
        rayon::current_num_threads(),
        match signals {
            SignalSrc::None => "none",
            SignalSrc::Breakout => "breakout",
        }
    );
    if candles.is_empty() {
        return Ok(());
    }

    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.trigger_bars = 24; // ~12h on 30m bars
    cfg.assets = vec![AssetConfig {
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
    let cfg = Arc::new(cfg);
    let atr_series = Arc::new(atr(&candles, 14));
    let candles = Arc::new(candles);
    let symbol = Arc::new(symbol);

    let started = Instant::now();
    let win_size = candles.len() / windows.max(1);

    let reports: Vec<WindowReport> = (0..windows)
        .into_par_iter()
        .map(|w| {
            let lo = w * win_size;
            let hi = if w == windows - 1 { candles.len() } else { (w + 1) * win_size };
            let win_started = Instant::now();
            let mut state = EngineState::initial(&cfg.label);
            let mut bars = 0usize;
            let asset = &cfg.assets[0];
            let breakout_params = BreakoutParams::from_cfg(cfg.as_ref(), asset);
            let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
            feed.insert(symbol.to_string(), Vec::with_capacity(hi - lo));
            let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
            atr_feed.insert(symbol.to_string(), Vec::with_capacity(hi - lo));
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
                            asset,
                            symbol.as_str(),
                            arr,
                            &breakout_params,
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
                    return WindowReport {
                        idx: w,
                        bars,
                        final_equity: state.equity,
                        final_day: state.day,
                        trades: state.closed_trades.len(),
                        passed: r.passed,
                        stopped: state.stopped_reason.map(|r| format!("{r:?}")),
                        elapsed_ms: win_started.elapsed().as_secs_f64() * 1000.0,
                    };
                }
            }
            WindowReport {
                idx: w,
                bars,
                final_equity: state.equity,
                final_day: state.day,
                trades: state.closed_trades.len(),
                passed: false,
                stopped: state.stopped_reason.map(|r| format!("{r:?}")),
                elapsed_ms: win_started.elapsed().as_secs_f64() * 1000.0,
            }
        })
        .collect();

    let elapsed = started.elapsed();
    let total_bars: usize = reports.iter().map(|r| r.bars).sum();
    let total_trades: usize = reports.iter().map(|r| r.trades).sum();
    let passed = reports.iter().filter(|r| r.passed).count();
    let bars_per_sec = total_bars as f64 / elapsed.as_secs_f64();

    for r in &reports {
        println!(
            "  win {:>3}: bars={:>5} trades={:>3} equity={:.4} day={} passed={} stopped={:?} {:.2}ms",
            r.idx, r.bars, r.trades, r.final_equity, r.final_day, r.passed, r.stopped, r.elapsed_ms
        );
    }
    println!(
        "\n{} bars / {} trades across {} windows in {:.3}s — {:.0} bars/sec ({} threads)",
        total_bars,
        total_trades,
        windows,
        elapsed.as_secs_f64(),
        bars_per_sec,
        rayon::current_num_threads()
    );
    println!("passed={passed} / {windows}");
    Ok(())
}
