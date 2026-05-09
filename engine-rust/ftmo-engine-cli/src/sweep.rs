//! ftmo-sweep — rayon-native sharded backtest sweeper. Replaces the
//! `_r28V6Shard.ts × 8 + _r28V6Aggregate.ts` pipeline with a single Rust
//! binary that walks the configured windows in parallel and emits JSONL
//! one-result-per-line.
//!
//! Invocation (single-asset, legacy):
//!     ftmo-sweep --candles <BTCUSDT_30m.json> [--config R28_V6_PASSLOCK]
//!                [--windows N] [--threads T] [--out results.jsonl]
//!                [--signals breakout|trend|meanrev|none]
//!
//! Invocation (multi-asset, R29-R5 sweep):
//!     ftmo-sweep --candles-dir scripts/cache_bakeoff
//!                --symbols BTCUSDT,ETHUSDT,...
//!                --config r28_v6_cvd
//!                [--windows N] [--threads T] [--out results.jsonl]
//!
//! In multi-asset mode each window opens a fresh challenge across the full
//! basket; the detector for each asset is dispatched off the asset's
//! `cvd_entry / vol_imbalance_entry / vol_poc_entry` field. If none are
//! configured, fallback is the same single-asset signal source as legacy.
//!
//! Exit code 0 = run finished, regardless of pass/fail rate.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use anyhow::{anyhow, Result};
use ftmo_engine_core::config::AssetConfig;
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::indicators::atr;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::signals_breakout::{detect_breakout, BreakoutParams};
use ftmo_engine_core::signals_meanrev::detect_mean_reversion;
use ftmo_engine_core::signals_r28v6::{detect_r28_v6, R28V6Inputs, R28V6Params};
use ftmo_engine_core::signals_r29r5::{
    detect_cvd_divergence, detect_vol_imbalance, detect_vol_poc,
};
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
    /// R29-R7: R28_V6 trend-pullback detector (consults
    /// `cfg.funding_rate_filter` when funding-series is supplied).
    R28V6,
    /// Multi-asset mode dispatches per-asset based on the config field set
    /// (cvd_entry / vol_imbalance_entry / vol_poc_entry). When no per-asset
    /// entry-type is set BUT the cfg has `funding_rate_filter` configured,
    /// falls back to `detect_r28_v6` so the funding gate gets honoured.
    PerAssetCfg,
}

fn main() -> Result<()> {
    let mut candles_path: Option<PathBuf> = None;
    let mut candles_dir: Option<PathBuf> = None;
    let mut funding_dir: Option<PathBuf> = None;
    let mut symbols_arg: Option<String> = None;
    let mut config_selector: Option<String> = None;
    let mut windows: usize = 8;
    let mut threads: Option<usize> = None;
    let mut out_path: Option<PathBuf> = None;
    let mut signals = SignalSrc::Breakout;
    let mut signals_user_set = false;
    let mut step_days: Option<u32> = None; // overlap-window stride in DAYS

    // R67 audit (Round 2): replace `args.next().unwrap()` with `ok_or_else`
    // — `ftmo-sweep --candles` (no path follows) panics with the usual Rust
    // backtrace. Now exits cleanly with a one-line error.
    // R67 audit (Round 3): add windows ≥ 1 guard analog to bench.rs (was
    // missing here → --windows 0 silently returned NaN%).
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
            "--candles-dir" => candles_dir = Some(PathBuf::from(need!("--candles-dir"))),
            "--funding-dir" => funding_dir = Some(PathBuf::from(need!("--funding-dir"))),
            "--symbols" => symbols_arg = Some(need!("--symbols")),
            "--config" => config_selector = Some(need!("--config")),
            "--windows" => windows = need!("--windows").parse()?,
            "--step-days" => step_days = Some(need!("--step-days").parse()?),
            "--threads" => threads = Some(need!("--threads").parse()?),
            "--out" => out_path = Some(PathBuf::from(need!("--out"))),
            "--signals" => {
                signals_user_set = true;
                signals = match need!("--signals").as_str() {
                    "none" => SignalSrc::None,
                    "breakout" => SignalSrc::Breakout,
                    "meanrev" => SignalSrc::MeanRev,
                    "trend" => SignalSrc::Trend,
                    "r28v6" => SignalSrc::R28V6,
                    "per-asset" => SignalSrc::PerAssetCfg,
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
    if windows == 0 {
        return Err(anyhow!("--windows must be ≥ 1"));
    }

    if let Some(t) = threads {
        rayon::ThreadPoolBuilder::new()
            .num_threads(t)
            .build_global()
            .ok();
    }

    if candles_dir.is_some() || symbols_arg.is_some() {
        return run_multi_asset(
            candles_dir,
            funding_dir,
            symbols_arg,
            config_selector,
            windows,
            step_days,
            out_path,
            signals,
            signals_user_set,
        );
    }

    let candles_path = candles_path
        .ok_or_else(|| anyhow!("either --candles or --candles-dir + --symbols is required"))?;
    run_single_asset(candles_path, config_selector, windows, out_path, signals)
}

// ───────────────── Single-asset (legacy) path ───────────────────────

fn run_single_asset(
    candles_path: PathBuf,
    config_selector: Option<String>,
    windows: usize,
    out_path: Option<PathBuf>,
    signals: SignalSrc,
) -> Result<()> {
    let candles = loader::load_candles(&candles_path)?;
    let symbol = candles_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.split('_').next().unwrap_or(s).to_string())
        .unwrap_or_else(|| "UNKNOWN".into());

    let cfg = match config_selector.as_deref() {
        Some(s) => templates::template_by_selector(s)
            .ok_or_else(|| anyhow!("unknown selector: {s}"))?,
        None => {
            let mut c = templates::r28_v6_passlock();
            c.assets = vec![AssetConfig {
                symbol: format!("{symbol}-TREND"),
                source_symbol: Some(symbol.clone()),
                risk_frac: 0.4,
                ..Default::default()
            }];
            c
        }
    };

    println!(
        "ftmo-sweep (single-asset): {} bars / {} ({}); {} threads; signals={}",
        candles.len(),
        symbol,
        cfg.label,
        rayon::current_num_threads(),
        signal_label(signals),
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
            let hi = if w == windows - 1 {
                candles.len()
            } else {
                (w + 1) * win_size
            };
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
                    risk_frac: 0.4,
                    ..Default::default()
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
                atr_feed
                    .get_mut(symbol.as_str())
                    .unwrap()
                    .push(atr_series[i]);
                let signals_for_bar: Vec<PollSignal> = match signals {
                    SignalSrc::None | SignalSrc::PerAssetCfg => vec![],
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
                    SignalSrc::R28V6 => {
                        // Single-asset path: no funding-data plumbing here
                        // (funding-rate filter is a multi-asset feature).
                        // Detector still runs and respects every other gate.
                        let arr = feed.get(symbol.as_str()).unwrap();
                        let r28p = R28V6Params::default_for(&asset, cfg.as_ref());
                        let r28in = R28V6Inputs {
                            htf_closes: None,
                            cross_asset_closes: None,
                            news_events: None,
                            funding_series: None,
                        };
                        match detect_r28_v6(
                            &mut state,
                            cfg.as_ref(),
                            &asset,
                            symbol.as_str(),
                            arr,
                            &r28p,
                            &r28in,
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
            // End-of-window pass-check — mirrors TS simulate() tail.
            let mut last_passed = last_passed;
            if !last_passed && state.stopped_reason.is_none() {
                let target_hit = state.first_target_hit_day.is_some()
                    && state.trading_days.len() >= cfg.min_trading_days as usize;
                let final_equity_floor = 1.0 + cfg.profit_target * 0.5;
                let give_back_too_far = target_hit
                    && state.equity.is_finite()
                    && state.equity < final_equity_floor;
                if target_hit && !give_back_too_far {
                    last_passed = true;
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
                fail_reason: last_fail
                    .or_else(|| state.stopped_reason.map(|r| format!("{r:?}"))),
                elapsed_ms: win_started.elapsed().as_secs_f64() * 1000.0,
            };
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

    finalise_report(&reports, windows, started);
    Ok(())
}

fn signal_label(s: SignalSrc) -> &'static str {
    match s {
        SignalSrc::None => "none",
        SignalSrc::Breakout => "breakout",
        SignalSrc::MeanRev => "meanrev",
        SignalSrc::Trend => "trend",
        SignalSrc::R28V6 => "r28v6",
        SignalSrc::PerAssetCfg => "per-asset",
    }
}

fn finalise_report(reports: &[WindowResult], windows: usize, started: Instant) {
    let elapsed = started.elapsed();
    let total_bars: usize = reports.iter().map(|r| r.bars).sum();
    let total_trades: usize = reports.iter().map(|r| r.trades).sum();
    let passed = reports.iter().filter(|r| r.passed).count();
    let bars_per_sec = total_bars as f64 / elapsed.as_secs_f64().max(1e-9);

    println!(
        "{} bars / {} trades across {} windows in {:.3}s — {:.0} bars/sec",
        total_bars,
        total_trades,
        windows,
        elapsed.as_secs_f64(),
        bars_per_sec,
    );
    println!(
        "passed={passed} / {windows} ({:.2}%)",
        passed as f64 / windows as f64 * 100.0
    );
}

// ───────────────── Multi-asset (R29-R5) path ────────────────────────

#[allow(clippy::too_many_arguments)]
fn run_multi_asset(
    candles_dir: Option<PathBuf>,
    funding_dir: Option<PathBuf>,
    symbols_arg: Option<String>,
    config_selector: Option<String>,
    windows: usize,
    step_days: Option<u32>,
    out_path: Option<PathBuf>,
    signals_mode: SignalSrc,
    signals_user_set: bool,
) -> Result<()> {
    let dir = candles_dir.ok_or_else(|| anyhow!("--candles-dir is required for multi-asset"))?;
    let symbols_str =
        symbols_arg.ok_or_else(|| anyhow!("--symbols is required for multi-asset"))?;
    let symbols: Vec<String> = symbols_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if symbols.is_empty() {
        return Err(anyhow!("--symbols list is empty"));
    }

    // Resolve config — must come from a known selector since per-asset
    // entry-fields only exist in templates that pre-baked them.
    let selector = config_selector
        .ok_or_else(|| anyhow!("--config is required (e.g. r28_v6_cvd, r28_v6_volimb, r28_v6_poc)"))?;
    let cfg = templates::template_by_selector(&selector)
        .ok_or_else(|| anyhow!("unknown selector: {selector}"))?;

    // Load candles per symbol.
    let mut candles_by_sym: HashMap<String, Vec<Candle>> = HashMap::new();
    for sym in &symbols {
        let p = locate_candle_file(&dir, sym)?;
        let candles = loader::load_candles(&p)?;
        candles_by_sym.insert(sym.clone(), candles);
    }

    // Align by openTime intersection. Build a sorted vector of bar-times
    // present in EVERY symbol — those are our common bars.
    let aligned_times = align_open_times(&candles_by_sym);
    if aligned_times.is_empty() {
        return Err(anyhow!("no overlapping openTimes across symbols"));
    }

    // Build aligned per-symbol candle vectors of length aligned_times.len().
    let mut aligned: HashMap<String, Vec<Candle>> = HashMap::new();
    for (sym, cs) in candles_by_sym.iter() {
        let by_ts: HashMap<i64, Candle> = cs.iter().map(|c| (c.open_time, *c)).collect();
        let aligned_v: Vec<Candle> = aligned_times
            .iter()
            .map(|t| *by_ts.get(t).expect("alignment invariant"))
            .collect();
        aligned.insert(sym.clone(), aligned_v);
    }

    // Pre-compute ATR per symbol. Use cfg.chandelier_exit.period when set so
    // the harness's chandelier-trail uses the ATR period that the config asks
    // for (R28_V6_PASSLOCK: 56). With the previous hard-coded period=14, the
    // chandelier ran on a much shorter ATR than TS → tighter trail stops →
    // earlier exits → meaningful drift on V5_QUARTZ-family configs.
    let chand_period = cfg.chandelier_exit.map(|c| c.period as usize).unwrap_or(14);
    let atr_by_sym: HashMap<String, Vec<Option<f64>>> = aligned
        .iter()
        .map(|(s, cs)| (s.clone(), atr(cs, chand_period)))
        .collect();

    // R29-R7: load + forward-fill funding-rate series per symbol, aligned
    // to the same openTime sequence as `aligned`. Missing files become
    // `vec![None; n]` so detectors see "no data → gate dormant" semantics.
    let funding_by_sym: HashMap<String, Vec<Option<f64>>> = match &funding_dir {
        Some(fd) => {
            let mut map = HashMap::new();
            for sym in symbols.iter() {
                let candles_for_sym = aligned.get(sym).expect("aligned missing sym");
                let pts = loader::load_funding(fd, sym)?;
                let series = match pts {
                    Some(p) => loader::align_funding(candles_for_sym, &p),
                    None => vec![None; candles_for_sym.len()],
                };
                map.insert(sym.clone(), series);
            }
            map
        }
        None => symbols
            .iter()
            .map(|s| {
                let n = aligned.get(s).map(|v| v.len()).unwrap_or(0);
                (s.clone(), vec![None; n])
            })
            .collect(),
    };

    let total_bars = aligned_times.len();
    println!(
        "ftmo-sweep (multi-asset): {} symbols × {} bars; cfg={}; {} threads; funding={}",
        symbols.len(),
        total_bars,
        cfg.label,
        rayon::current_num_threads(),
        if funding_dir.is_some() { "yes" } else { "no" },
    );

    // Effective signal mode default for multi-asset: PerAssetCfg unless user
    // explicitly overrode with --signals.
    let signals_mode = if signals_user_set {
        signals_mode
    } else {
        SignalSrc::PerAssetCfg
    };

    // Window plan: by default we cut `windows` non-overlapping slices of
    // total_bars (matches single-asset behaviour). With `--step-days`, we
    // emit overlapping windows starting every step_days×48 bars (30m bars),
    // each running until challenge ends or hitting cfg.max_days.
    // Match TS shard plan: windows start at bar `WARMUP + w*stride` and run
    // for `max_days*48` bars. The detector consumes the WARMUP bars before
    // the window-start to seed indicators (mirrors `_r28V6Round60Shard.ts`).
    const WIN_PLAN_WARMUP: usize = 5000;
    let bars_per_day: usize = 48; // 30m bars; matches the R28_V6 30m basket.
    let win_plans: Vec<(usize, usize)> = if let Some(sd) = step_days {
        let stride = (sd as usize) * bars_per_day;
        let max_w_bars = cfg.max_days as usize * bars_per_day;
        (0..windows)
            .map(|w| {
                let lo = WIN_PLAN_WARMUP + w * stride;
                let hi = (lo + max_w_bars).min(total_bars);
                (lo, hi)
            })
            .filter(|(lo, hi)| *hi > *lo + bars_per_day)
            .collect()
    } else {
        let win_size = total_bars / windows.max(1);
        (0..windows)
            .map(|w| {
                let lo = w * win_size;
                let hi = if w == windows - 1 { total_bars } else { (w + 1) * win_size };
                (lo, hi)
            })
            .collect()
    };
    let actual_windows = win_plans.len();

    let writer: Arc<Mutex<Option<BufWriter<File>>>> = Arc::new(Mutex::new(match &out_path {
        Some(p) => Some(BufWriter::new(File::create(p)?)),
        None => None,
    }));

    let cfg = Arc::new(cfg);
    let aligned = Arc::new(aligned);
    let atr_by_sym = Arc::new(atr_by_sym);
    let funding_by_sym = Arc::new(funding_by_sym);
    let symbols = Arc::new(symbols);

    let started = Instant::now();
    let reports: Vec<WindowResult> = win_plans
        .par_iter()
        .enumerate()
        .map(|(w_idx, (lo, hi))| {
            run_one_window(
                w_idx,
                *lo,
                *hi,
                cfg.as_ref(),
                aligned.as_ref(),
                atr_by_sym.as_ref(),
                funding_by_sym.as_ref(),
                symbols.as_ref(),
                signals_mode,
                writer.clone(),
            )
        })
        .collect();

    if let Ok(mut g) = writer.lock() {
        if let Some(w) = g.as_mut() {
            w.flush()?;
        }
    }

    finalise_report(&reports, actual_windows, started);
    Ok(())
}

fn locate_candle_file(dir: &Path, symbol: &str) -> Result<PathBuf> {
    // Convention: <dir>/<SYMBOL>_<TF>.json — pick first match.
    for ext in &["_30m.json", "_1h.json", "_2h.json", "_4h.json", "_15m.json"] {
        let p = dir.join(format!("{symbol}{ext}"));
        if p.exists() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no candle file for symbol {symbol} in {}",
        dir.display()
    ))
}

fn align_open_times(by_sym: &HashMap<String, Vec<Candle>>) -> Vec<i64> {
    let mut sets: Vec<std::collections::BTreeSet<i64>> = by_sym
        .values()
        .map(|v| v.iter().map(|c| c.open_time).collect())
        .collect();
    if sets.is_empty() {
        return vec![];
    }
    let first = sets.remove(0);
    let intersection: std::collections::BTreeSet<i64> =
        sets.iter().fold(first, |acc, s| &acc & s);
    intersection.into_iter().collect()
}

#[allow(clippy::too_many_arguments)]
fn run_one_window(
    w_idx: usize,
    lo: usize,
    hi: usize,
    cfg: &ftmo_engine_core::config::EngineConfig,
    aligned: &HashMap<String, Vec<Candle>>,
    atr_by_sym: &HashMap<String, Vec<Option<f64>>>,
    funding_by_sym: &HashMap<String, Vec<Option<f64>>>,
    symbols: &[String],
    signals_mode: SignalSrc,
    writer: Arc<Mutex<Option<BufWriter<File>>>>,
) -> WindowResult {
    let win_started = Instant::now();
    let mut state = EngineState::initial(&cfg.label);
    let mut bars = 0usize;

    // Per-symbol growing feed (slice of aligned[lo..i] up to current bar).
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    let mut atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    let mut funding_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    for sym in symbols.iter() {
        feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
        atr_feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
        funding_feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
    }

    // PerAssetCfg dispatch: prefer per-asset entry-type (cvd/volimb/poc)
    // when set; otherwise fall through to the default R28_V6 detector.
    //
    // R29-R7 originally gated this default on `cfg.funding_rate_filter.is_some()`
    // so only PASSLOCK_FRMED/FRLONG would route to R28V6. That made every
    // plain R28_V6_PASSLOCK / V5_TITANIUM sweep produce zero signals (no
    // per-asset entry-type → falls through to `None`), which masked the
    // detector behind a 0% pass-rate. The funding-filter precondition is
    // dropped so the default R28V6 fallback covers the whole V5_TREND family.
    let default_to_r28v6 = matches!(signals_mode, SignalSrc::PerAssetCfg)
        && cfg.assets.iter().all(|a| {
            a.cvd_entry.is_none()
                && a.vol_imbalance_entry.is_none()
                && a.vol_poc_entry.is_none()
        });

    let mut last_passed = false;
    let mut last_fail: Option<String> = None;

    // R29-Rust-Phase2: pre-fill feed with WARMUP bars BEFORE the challenge
    // window. The TS shard test (`scripts/_r28V6Round60Shard.ts:112`) runs
    // simulate(slice, cfg, WARMUP, WARMUP+winBars) with WARMUP=5000, giving
    // the detector ~5000 bars of indicator history before the challenge
    // starts. Without it the Rust detector sees an empty buffer at bar lo
    // and silently no-ops for the first ~slow_period bars (50 bars on V5);
    // worse, ATR / SMA series are computed on a stunted history vs TS.
    const WARMUP: usize = 5000;
    let warmup_lo = lo.saturating_sub(WARMUP);
    for i in warmup_lo..lo {
        for sym in symbols.iter() {
            let c = aligned.get(sym).expect("aligned missing sym")[i];
            feed.get_mut(sym).unwrap().push(c);
            let a = atr_by_sym.get(sym).expect("atr missing sym")[i];
            atr_feed.get_mut(sym).unwrap().push(a);
            let f = funding_by_sym
                .get(sym)
                .and_then(|s| s.get(i).copied())
                .flatten();
            funding_feed.get_mut(sym).unwrap().push(f);
        }
    }

    for i in lo..hi {
        // Push current bar for every symbol.
        for sym in symbols.iter() {
            let c = aligned.get(sym).expect("aligned missing sym")[i];
            feed.get_mut(sym).unwrap().push(c);
            let a = atr_by_sym.get(sym).expect("atr missing sym")[i];
            atr_feed.get_mut(sym).unwrap().push(a);
            let f = funding_by_sym
                .get(sym)
                .and_then(|s| s.get(i).copied())
                .flatten();
            funding_feed.get_mut(sym).unwrap().push(f);
        }

        // Build signals: one detector pass per asset entry, dispatched off
        // its config field set when in PerAssetCfg mode.
        let mut signals_for_bar: Vec<PollSignal> = Vec::new();
        for asset in cfg.assets.iter() {
            let source = asset
                .source_symbol
                .clone()
                .unwrap_or_else(|| asset.symbol.replace("-TREND", "USDT"));
            let arr = match feed.get(&source) {
                Some(v) => v,
                None => continue, // symbol not in --symbols list — skip silently
            };
            let sig = match signals_mode {
                SignalSrc::PerAssetCfg => {
                    if let Some(p) = asset.cvd_entry {
                        detect_cvd_divergence(&mut state, cfg, asset, &source, arr, &p)
                    } else if let Some(p) = asset.vol_imbalance_entry {
                        detect_vol_imbalance(&mut state, cfg, asset, &source, arr, &p)
                    } else if let Some(p) = asset.vol_poc_entry {
                        detect_vol_poc(&mut state, cfg, asset, &source, arr, &p)
                    } else if default_to_r28v6 {
                        let r28p = R28V6Params::default_for(asset, cfg);
                        let funding = funding_feed.get(&source).map(|v| v.as_slice());
                        let r28in = R28V6Inputs {
                            htf_closes: None,
                            cross_asset_closes: None,
                            news_events: None,
                            funding_series: funding,
                        };
                        detect_r28_v6(&mut state, cfg, asset, &source, arr, &r28p, &r28in)
                    } else {
                        None
                    }
                }
                SignalSrc::Breakout => {
                    let bp = BreakoutParams::from_cfg(cfg, asset);
                    detect_breakout(&mut state, cfg, asset, &source, arr, &bp)
                }
                SignalSrc::Trend => {
                    let tp = TrendParams::from_cfg(cfg, asset);
                    detect_trend_pullback(&mut state, cfg, asset, &source, arr, &tp)
                }
                SignalSrc::R28V6 => {
                    let r28p = R28V6Params::default_for(asset, cfg);
                    let funding = funding_feed.get(&source).map(|v| v.as_slice());
                    let r28in = R28V6Inputs {
                        htf_closes: None,
                        cross_asset_closes: None,
                        news_events: None,
                        funding_series: funding,
                    };
                    detect_r28_v6(&mut state, cfg, asset, &source, arr, &r28p, &r28in)
                }
                SignalSrc::MeanRev => {
                    let src = cfg.mean_reversion_source.unwrap_or(
                        ftmo_engine_core::config::MeanReversionSource {
                            period: 14,
                            oversold: 25.0,
                            overbought: 75.0,
                            cooldown_bars: 8,
                            size_mult: 0.5,
                        },
                    );
                    detect_mean_reversion(&mut state, cfg, asset, &source, arr, &src)
                }
                SignalSrc::None => None,
            };
            if let Some(s) = sig {
                signals_for_bar.push(s);
            }
        }

        let r = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feed,
                atr_series_by_source: &atr_feed,
                signals: signals_for_bar,
            },
            cfg,
        );
        bars += 1;
        if r.challenge_ended {
            last_passed = r.passed;
            last_fail = r.fail_reason.map(|f| format!("{f:?}"));
            break;
        }
    }

    // R29-Rust-Phase2: end-of-window pass-check — mirrors TS `simulate()`
    // tail at `ftmoLiveEngineV4.ts:2185-2198`. Without this, windows whose
    // bar count is short of `cfg.max_days` (e.g. 28×48 bars on a 30-day
    // max_days config) never trigger the harness force-close path; any
    // mid-run target-hit was silently discarded as `passed=false`.
    let mut last_passed = last_passed;
    if !last_passed && state.stopped_reason.is_none() {
        let target_hit = state.first_target_hit_day.is_some()
            && state.trading_days.len() >= cfg.min_trading_days as usize;
        let final_equity_floor = 1.0 + cfg.profit_target * 0.5;
        let give_back_too_far = target_hit
            && state.equity.is_finite()
            && state.equity < final_equity_floor;
        if target_hit && !give_back_too_far {
            last_passed = true;
        }
    }

    let report = WindowResult {
        win_idx: w_idx,
        config_label: cfg.label.clone(),
        bars,
        trades: state.closed_trades.len(),
        final_equity_pct: state.equity - 1.0,
        final_day: state.day,
        passed: last_passed,
        fail_reason: last_fail.or_else(|| state.stopped_reason.map(|r| format!("{r:?}"))),
        elapsed_ms: win_started.elapsed().as_secs_f64() * 1000.0,
    };
    if let Ok(mut g) = writer.lock() {
        if let Some(w) = g.as_mut() {
            if let Ok(line) = serde_json::to_string(&report) {
                let _ = writeln!(w, "{line}");
            }
        }
    }
    report
}
