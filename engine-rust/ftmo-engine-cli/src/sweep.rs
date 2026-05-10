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

fn ml_features_for_signal(
    series: &MlFeatureSeries,
    bar_idx: usize,
    asset_idx: usize,
    direction_long: bool,
    entry_time_ms: i64,
) -> [f64; 13] {
    let i = bar_idx;
    let close = series.closes.get(i).copied().unwrap_or(0.0);
    let close5 = series.closes.get(i.saturating_sub(5)).copied().unwrap_or(close);
    let close20 = series.closes.get(i.saturating_sub(20)).copied().unwrap_or(close);
    let prior5 = if close5 > 0.0 { (close - close5) / close5 } else { 0.0 };
    let prior20 = if close20 > 0.0 { (close - close20) / close20 } else { 0.0 };
    let atr_pct = match (series.atr14.get(i).copied().flatten(), close) {
        (Some(a), c) if c > 0.0 => a / c,
        _ => 0.0,
    };
    let slope = |s: &[Option<f64>], lookback: usize| -> f64 {
        let cur = s.get(i).copied().flatten();
        let prev = s.get(i.saturating_sub(lookback)).copied().flatten();
        match (cur, prev) {
            (Some(c), Some(p)) if p != 0.0 => (c - p) / p,
            _ => 0.0,
        }
    };
    use chrono::{DateTime, Datelike, Timelike, Utc};
    let dt = DateTime::<Utc>::from_timestamp_millis(entry_time_ms);
    let (hour, dow) = match dt {
        Some(t) => (t.hour() as f64, t.weekday().num_days_from_sunday() as f64),
        None => (0.0, 0.0),
    };
    [
        series.rsi14.get(i).copied().flatten().unwrap_or(0.0),
        series.rsi28.get(i).copied().flatten().unwrap_or(0.0),
        series.adx14.get(i).copied().flatten().unwrap_or(0.0),
        atr_pct,
        slope(&series.sma20, 20),
        slope(&series.sma50, 50),
        slope(&series.sma200, 200),
        hour,
        dow,
        prior5,
        prior20,
        asset_idx as f64,
        if direction_long { 1.0 } else { 0.0 },
    ]
}

/// R29-Track-B3 pre-computed feature series per symbol.
struct MlFeatureSeries {
    rsi14: Vec<Option<f64>>,
    rsi28: Vec<Option<f64>>,
    adx14: Vec<Option<f64>>,
    atr14: Vec<Option<f64>>,
    sma20: Vec<Option<f64>>,
    sma50: Vec<Option<f64>>,
    sma200: Vec<Option<f64>>,
    closes: Vec<f64>,
}

/// R29-Stage-B multi-signal stacking. When set, the per-asset signal loop
/// fires the named extra detectors in addition to the default per-asset
/// dispatch (R28V6 / cvd / volimb / poc). Each detector emits at most one
/// signal per asset per bar, but multi-detector means up to 3-4 signals
/// per asset per bar reach the harness — MCT cap arbitrates.
#[derive(Default, Debug, Clone)]
struct MultiSignalCfg {
    also_meanrev: bool,
    also_breakout: bool,
    mr_period: Option<u32>,
    mr_oversold: Option<f64>,
    mr_overbought: Option<f64>,
    mr_cooldown: Option<u64>,
    mr_size_mult: Option<f64>,
    /// Phantom-trade pre-pass: opt-in (default off). Mirrors TS detectAsset
    /// internal cooldown across warmup boundary, but at ~1000× CPU cost
    /// because the per-asset detector iterates O(N_bars²) per window. Use
    /// for parity-validation runs; not for fast parameter sweeps.
    phantom_suppress: bool,
    /// R29-Track-B3 ML signal-gate: arc-shared model and threshold. None →
    /// gate disabled.
    ml_model: Option<Arc<ftmo_engine_core::ml_gate::MlModel>>,
    ml_threshold: f64,
    /// R29-Audit: random-gate sanity check. When set to Some(f), each signal
    /// is kept with probability f (deterministic per `random_gate_seed +
    /// entry_time + symbol_hash`). Used to confirm ML "wins" come from signal
    /// quality, not trade-count reduction.
    random_gate_keep: Option<f64>,
    random_gate_seed: u64,
}

/// R29-PassrateHunt: post-template config mutations. Bundle all override
/// flags into a single struct so `run_multi_asset` doesn't grow N more args.
#[derive(Default, Debug, Clone)]
struct CfgOverrides {
    tp_mult: Option<f64>,
    stop_pct: Option<f64>,
    mct: Option<u32>,
    trail_activate: Option<f64>,
    trail_pct: Option<f64>,
    leverage: Option<f64>,
    hold_bars: Option<u32>,
    hours: Option<String>,
    dows: Option<String>,
    drop_symbols: Option<String>,
    keep_symbols: Option<String>,
    disable_trail: bool,
    disable_passlock: bool,
    enable_passlock: bool,
    be_threshold: Option<f64>,
    funding_max_long: Option<f64>,
    funding_min_short: Option<f64>,
    adaptive_tp: Option<String>,
    pdd_from_peak: Option<f64>,
    pdd_factor: Option<f64>,
    dpts_trail: Option<f64>,
    cpts_trail: Option<f64>,
    idl_threshold: Option<f64>,
    idl_factor: Option<f64>,
    min_trading_days: Option<u32>,
    profit_target: Option<f64>,
    lscool_after: Option<u32>,
    lscool_bars: Option<u64>,
}

fn apply_overrides(
    cfg: &mut ftmo_engine_core::config::EngineConfig,
    ov: &CfgOverrides,
) -> Result<()> {
    use ftmo_engine_core::config::{
        BreakEven, FundingRateFilter, IntradayDailyLossThrottle, LossStreakCooldown,
        PeakDrawdownThrottle, PeakTrailingStop, TrailingStop,
    };

    if let Some(m) = ov.tp_mult {
        for a in cfg.assets.iter_mut() {
            if let Some(t) = a.tp_pct {
                a.tp_pct = Some(t * m);
            } else {
                a.tp_pct = Some(cfg.tp_pct * m);
            }
        }
    }
    if let Some(s) = ov.stop_pct {
        cfg.stop_pct = s;
        for a in cfg.assets.iter_mut() {
            a.stop_pct = Some(s);
        }
    }
    if let Some(m) = ov.mct {
        cfg.max_concurrent_trades = Some(m);
    }
    if let Some(l) = ov.leverage {
        cfg.leverage = l;
    }
    if let Some(h) = ov.hold_bars {
        cfg.hold_bars = h;
        for a in cfg.assets.iter_mut() {
            a.hold_bars = Some(h);
        }
    }
    if ov.disable_trail {
        cfg.trailing_stop = None;
    } else {
        let act = ov.trail_activate;
        let pct = ov.trail_pct;
        if act.is_some() || pct.is_some() {
            let cur = cfg.trailing_stop.unwrap_or(TrailingStop {
                activate_pct: 0.03,
                trail_pct: 0.005,
            });
            cfg.trailing_stop = Some(TrailingStop {
                activate_pct: act.unwrap_or(cur.activate_pct),
                trail_pct: pct.unwrap_or(cur.trail_pct),
            });
        }
    }
    if ov.disable_passlock {
        cfg.close_all_on_target_reached = false;
    }
    if ov.enable_passlock {
        cfg.close_all_on_target_reached = true;
    }
    if let Some(t) = ov.be_threshold {
        cfg.break_even = Some(BreakEven { threshold: t });
    }
    if let Some(csv) = &ov.hours {
        let v: Vec<u32> = csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        cfg.allowed_hours_utc = Some(v);
    }
    if let Some(csv) = &ov.dows {
        let v: Vec<u32> = csv
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        cfg.allowed_dows_utc = Some(v);
    }
    if let Some(csv) = &ov.drop_symbols {
        let drop: std::collections::HashSet<String> = csv
            .split(',')
            .map(|s| s.trim().to_uppercase())
            .filter(|s| !s.is_empty())
            .collect();
        cfg.assets.retain(|a| {
            let bare = a.symbol.replace("-TREND", "");
            let src = a
                .source_symbol
                .clone()
                .unwrap_or_default()
                .replace("USDT", "");
            !drop.contains(&bare) && !drop.contains(&src)
        });
    }
    if let Some(csv) = &ov.keep_symbols {
        let keep: std::collections::HashSet<String> = csv
            .split(',')
            .map(|s| s.trim().to_uppercase())
            .filter(|s| !s.is_empty())
            .collect();
        cfg.assets.retain(|a| {
            let bare = a.symbol.replace("-TREND", "");
            let src = a
                .source_symbol
                .clone()
                .unwrap_or_default()
                .replace("USDT", "");
            keep.contains(&bare) || keep.contains(&src)
        });
    }
    if ov.funding_max_long.is_some() || ov.funding_min_short.is_some() {
        cfg.funding_rate_filter = Some(FundingRateFilter {
            max_funding_for_long: ov.funding_max_long,
            min_funding_for_short: ov.funding_min_short,
        });
    }
    if let Some(t) = ov.profit_target {
        cfg.profit_target = t;
    }
    if let Some(d) = ov.min_trading_days {
        cfg.min_trading_days = d;
    }
    if ov.pdd_from_peak.is_some() || ov.pdd_factor.is_some() {
        let cur = cfg.peak_drawdown_throttle.unwrap_or(PeakDrawdownThrottle {
            from_peak: 0.03,
            factor: 0.15,
        });
        cfg.peak_drawdown_throttle = Some(PeakDrawdownThrottle {
            from_peak: ov.pdd_from_peak.unwrap_or(cur.from_peak),
            factor: ov.pdd_factor.unwrap_or(cur.factor),
        });
    }
    if let Some(d) = ov.dpts_trail {
        cfg.daily_peak_trailing_stop = Some(PeakTrailingStop { trail_distance: d });
    }
    if let Some(d) = ov.cpts_trail {
        cfg.challenge_peak_trailing_stop = Some(PeakTrailingStop { trail_distance: d });
    }
    if ov.idl_threshold.is_some() || ov.idl_factor.is_some() {
        let cur = cfg.intraday_daily_loss_throttle.unwrap_or(IntradayDailyLossThrottle {
            soft_loss_threshold: 0.025,
            hard_loss_threshold: 0.04,
            soft_factor: 0.5,
        });
        cfg.intraday_daily_loss_throttle = Some(IntradayDailyLossThrottle {
            soft_loss_threshold: cur.soft_loss_threshold,
            hard_loss_threshold: ov.idl_threshold.unwrap_or(cur.hard_loss_threshold),
            soft_factor: ov.idl_factor.unwrap_or(cur.soft_factor),
        });
    }
    if ov.lscool_after.is_some() || ov.lscool_bars.is_some() {
        let cur = cfg.loss_streak_cooldown.unwrap_or(LossStreakCooldown {
            after_losses: 3,
            cooldown_bars: 96,
        });
        cfg.loss_streak_cooldown = Some(LossStreakCooldown {
            after_losses: ov.lscool_after.unwrap_or(cur.after_losses),
            cooldown_bars: ov.lscool_bars.unwrap_or(cur.cooldown_bars),
        });
    }
    if let Some(csv) = &ov.adaptive_tp {
        // Format: "BTC:0.025,ETH:0.030,..."
        for pair in csv.split(',') {
            let mut sp = pair.splitn(2, ':');
            let key = sp.next().map(|s| s.trim().to_uppercase()).unwrap_or_default();
            let val: Option<f64> = sp.next().and_then(|s| s.trim().parse().ok());
            if key.is_empty() || val.is_none() {
                continue;
            }
            for a in cfg.assets.iter_mut() {
                let bare = a.symbol.replace("-TREND", "");
                let src = a
                    .source_symbol
                    .clone()
                    .unwrap_or_default()
                    .replace("USDT", "");
                if bare == key || src == key {
                    a.tp_pct = val;
                }
            }
        }
    }
    Ok(())
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
    let mut trades_out: Option<PathBuf> = None;
    let mut debug_window: Option<usize> = None;
    // R29-PassrateHunt: lightweight CLI overrides so a bash-orchestrated grid
    // sweep can probe parameter space without recompiling templates per run.
    // All overrides are post-template (applied after `template_by_selector`).
    let mut override_tp_mult: Option<f64> = None;
    let mut override_stop_pct: Option<f64> = None;
    let mut override_mct: Option<u32> = None;
    let mut override_trail_activate: Option<f64> = None;
    let mut override_trail_pct: Option<f64> = None;
    let mut override_leverage: Option<f64> = None;
    let mut override_hold_bars: Option<u32> = None;
    let mut override_hours: Option<String> = None; // CSV "2,4,6,..."
    let mut override_dows: Option<String> = None;  // CSV "1,2,3,4,5"
    let mut drop_symbols: Option<String> = None;   // CSV "RUNE,SAND"
    let mut keep_symbols: Option<String> = None;   // CSV "BTC,ETH,..." (whitelist)
    let mut disable_trail: bool = false;
    let mut disable_passlock: bool = false;
    let mut enable_passlock: bool = false;
    let mut be_threshold: Option<f64> = None;      // add break-even
    let mut funding_max_long: Option<f64> = None;
    let mut funding_min_short: Option<f64> = None;
    let mut adaptive_tp_per_asset: Option<String> = None; // "BTC:0.025,ETH:0.030"
    let mut pdd_from_peak: Option<f64> = None;   // peak_drawdown_throttle.from_peak
    let mut pdd_factor: Option<f64> = None;      // peak_drawdown_throttle.factor
    let mut dpts_trail: Option<f64> = None;      // daily_peak_trailing_stop.trail_distance
    let mut cpts_trail: Option<f64> = None;      // challenge_peak_trailing_stop.trail_distance
    let mut idl_threshold: Option<f64> = None;   // intraday_daily_loss_throttle.hard_loss_threshold
    let mut idl_factor: Option<f64> = None;      // intraday_daily_loss_throttle.size_factor
    let mut min_trading_days: Option<u32> = None;
    let mut profit_target: Option<f64> = None;
    let mut lscool_after: Option<u32> = None;
    let mut lscool_bars: Option<u64> = None;
    let mut phantom_suppress: bool = false;
    let mut ml_model_path: Option<PathBuf> = None;
    let mut ml_threshold: f64 = 0.0;
    let mut start_after_ts: Option<i64> = None;
    let mut random_gate_keep: Option<f64> = None;
    let mut random_gate_seed: u64 = 42;
    let mut also_fire_meanrev: bool = false;
    let mut also_fire_breakout: bool = false;
    let mut mr_period: Option<u32> = None;
    let mut mr_oversold: Option<f64> = None;
    let mut mr_overbought: Option<f64> = None;
    let mut mr_cooldown: Option<u64> = None;
    let mut mr_size_mult: Option<f64> = None;

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
            // R29-PassrateHunt overrides
            "--override-tp-mult" => override_tp_mult = Some(need!("--override-tp-mult").parse()?),
            "--override-stop-pct" => override_stop_pct = Some(need!("--override-stop-pct").parse()?),
            "--override-mct" => override_mct = Some(need!("--override-mct").parse()?),
            "--override-trail-activate" => {
                override_trail_activate = Some(need!("--override-trail-activate").parse()?)
            }
            "--override-trail-pct" => {
                override_trail_pct = Some(need!("--override-trail-pct").parse()?)
            }
            "--override-leverage" => {
                override_leverage = Some(need!("--override-leverage").parse()?)
            }
            "--override-hold-bars" => {
                override_hold_bars = Some(need!("--override-hold-bars").parse()?)
            }
            "--override-hours" => override_hours = Some(need!("--override-hours")),
            "--override-dows" => override_dows = Some(need!("--override-dows")),
            "--drop-symbols" => drop_symbols = Some(need!("--drop-symbols")),
            "--keep-symbols" => keep_symbols = Some(need!("--keep-symbols")),
            "--disable-trail" => disable_trail = true,
            "--disable-passlock" => disable_passlock = true,
            "--enable-passlock" => enable_passlock = true,
            "--be-threshold" => be_threshold = Some(need!("--be-threshold").parse()?),
            "--funding-max-long" => {
                funding_max_long = Some(need!("--funding-max-long").parse()?)
            }
            "--funding-min-short" => {
                funding_min_short = Some(need!("--funding-min-short").parse()?)
            }
            "--adaptive-tp" => adaptive_tp_per_asset = Some(need!("--adaptive-tp")),
            "--pdd-from-peak" => pdd_from_peak = Some(need!("--pdd-from-peak").parse()?),
            "--pdd-factor" => pdd_factor = Some(need!("--pdd-factor").parse()?),
            "--dpts-trail" => dpts_trail = Some(need!("--dpts-trail").parse()?),
            "--cpts-trail" => cpts_trail = Some(need!("--cpts-trail").parse()?),
            "--idl-threshold" => idl_threshold = Some(need!("--idl-threshold").parse()?),
            "--idl-factor" => idl_factor = Some(need!("--idl-factor").parse()?),
            "--min-trading-days" => min_trading_days = Some(need!("--min-trading-days").parse()?),
            "--profit-target" => profit_target = Some(need!("--profit-target").parse()?),
            "--lscool-after" => lscool_after = Some(need!("--lscool-after").parse()?),
            "--lscool-bars" => lscool_bars = Some(need!("--lscool-bars").parse()?),
            "--trades-out" => trades_out = Some(PathBuf::from(need!("--trades-out"))),
            "--debug-window" => debug_window = Some(need!("--debug-window").parse()?),
            "--phantom-suppress" => phantom_suppress = true,
            "--ml-model" => ml_model_path = Some(PathBuf::from(need!("--ml-model"))),
            "--ml-threshold" => ml_threshold = need!("--ml-threshold").parse()?,
            "--start-after-ts" => start_after_ts = Some(need!("--start-after-ts").parse()?),
            "--random-gate-keep" => {
                random_gate_keep = Some(need!("--random-gate-keep").parse()?);
            }
            "--random-gate-seed" => {
                random_gate_seed = need!("--random-gate-seed").parse()?;
            }
            "--also-fire-meanrev" => also_fire_meanrev = true,
            "--also-fire-breakout" => also_fire_breakout = true,
            "--mr-period" => mr_period = Some(need!("--mr-period").parse()?),
            "--mr-oversold" => mr_oversold = Some(need!("--mr-oversold").parse()?),
            "--mr-overbought" => mr_overbought = Some(need!("--mr-overbought").parse()?),
            "--mr-cooldown" => mr_cooldown = Some(need!("--mr-cooldown").parse()?),
            "--mr-size-mult" => mr_size_mult = Some(need!("--mr-size-mult").parse()?),
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

    let overrides = CfgOverrides {
        tp_mult: override_tp_mult,
        stop_pct: override_stop_pct,
        mct: override_mct,
        trail_activate: override_trail_activate,
        trail_pct: override_trail_pct,
        leverage: override_leverage,
        hold_bars: override_hold_bars,
        hours: override_hours,
        dows: override_dows,
        drop_symbols,
        keep_symbols,
        disable_trail,
        disable_passlock,
        enable_passlock,
        be_threshold,
        funding_max_long,
        funding_min_short,
        adaptive_tp: adaptive_tp_per_asset,
        pdd_from_peak,
        pdd_factor,
        dpts_trail,
        cpts_trail,
        idl_threshold,
        idl_factor,
        min_trading_days,
        profit_target,
        lscool_after,
        lscool_bars,
    };

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
            &overrides,
            trades_out,
            debug_window,
            start_after_ts,
            MultiSignalCfg {
                also_meanrev: also_fire_meanrev,
                also_breakout: also_fire_breakout,
                mr_period,
                mr_oversold,
                mr_overbought,
                mr_cooldown,
                mr_size_mult,
                phantom_suppress,
                ml_model: match &ml_model_path {
                    Some(p) => {
                        let m = ftmo_engine_core::ml_gate::MlModel::load_from_path(
                            p.to_string_lossy().as_ref(),
                        )
                        .map_err(|e| anyhow!("ml model load: {e}"))?;
                        eprintln!(
                            "[ml-gate] loaded {} trees, AUC={:.4}, baseline winRate={:.3}, threshold={:.2}",
                            m.n_trees, m.validation_auc, m.win_rate_baseline, ml_threshold
                        );
                        Some(Arc::new(m))
                    }
                    None => None,
                },
                ml_threshold,
                random_gate_keep,
                random_gate_seed,
            },
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
    overrides: &CfgOverrides,
    trades_out: Option<PathBuf>,
    debug_window: Option<usize>,
    start_after_ts: Option<i64>,
    multi_signal: MultiSignalCfg,
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
    let mut cfg = templates::template_by_selector(&selector)
        .ok_or_else(|| anyhow!("unknown selector: {selector}"))?;
    // R29-PassrateHunt: apply CLI overrides post-template.
    apply_overrides(&mut cfg, overrides)?;

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

    // R29-Track-B3 ML feature series. Pre-compute per symbol once, reused
    // across all windows. Match feature layout in `_mlTrainClassifier.py`.
    let ml_features_by_sym: HashMap<String, MlFeatureSeries> = if multi_signal
        .ml_model
        .is_some()
    {
        use ftmo_engine_core::detector_filters::adx as adx_fn;
        use ftmo_engine_core::indicators::{atr as atr_fn, rsi as rsi_fn, sma as sma_fn};
        let mut map = HashMap::new();
        for (sym, cs) in aligned.iter() {
            let closes: Vec<f64> = cs.iter().map(|c| c.close).collect();
            map.insert(
                sym.clone(),
                MlFeatureSeries {
                    rsi14: rsi_fn(&closes, 14),
                    rsi28: rsi_fn(&closes, 28),
                    adx14: adx_fn(cs, 14),
                    atr14: atr_fn(cs, 14),
                    sma20: sma_fn(&closes, 20),
                    sma50: sma_fn(&closes, 50),
                    sma200: sma_fn(&closes, 200),
                    closes,
                },
            );
        }
        map
    } else {
        HashMap::new()
    };

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
    // R29-Track-B4: filter windows whose start time is before user-supplied
    // cutoff (out-of-sample test mode for ML-gated runs). aligned_times[lo]
    // is the open_time of bar lo.
    let win_plans: Vec<(usize, usize)> = if let Some(cutoff) = start_after_ts {
        win_plans
            .into_iter()
            .filter(|(lo, _)| {
                aligned_times
                    .get(*lo)
                    .copied()
                    .map(|t| t >= cutoff)
                    .unwrap_or(false)
            })
            .collect()
    } else {
        win_plans
    };
    let actual_windows = win_plans.len();

    let writer: Arc<Mutex<Option<BufWriter<File>>>> = Arc::new(Mutex::new(match &out_path {
        Some(p) => Some(BufWriter::new(File::create(p)?)),
        None => None,
    }));
    let trades_writer: Arc<Mutex<Option<BufWriter<File>>>> = Arc::new(Mutex::new(match &trades_out {
        Some(p) => Some(BufWriter::new(File::create(p)?)),
        None => None,
    }));

    let cfg = Arc::new(cfg);
    let aligned = Arc::new(aligned);
    let atr_by_sym = Arc::new(atr_by_sym);
    let funding_by_sym = Arc::new(funding_by_sym);
    let symbols = Arc::new(symbols);
    let multi_signal = Arc::new(multi_signal);
    let ml_features_by_sym = Arc::new(ml_features_by_sym);

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
                trades_writer.clone(),
                debug_window,
                multi_signal.as_ref(),
                ml_features_by_sym.as_ref(),
            )
        })
        .collect();

    if let Ok(mut g) = writer.lock() {
        if let Some(w) = g.as_mut() {
            w.flush()?;
        }
    }
    if let Ok(mut g) = trades_writer.lock() {
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
    trades_writer: Arc<Mutex<Option<BufWriter<File>>>>,
    debug_window: Option<usize>,
    multi_signal: &MultiSignalCfg,
    ml_features_by_sym: &HashMap<String, MlFeatureSeries>,
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

    // R29-Bug-Audit-2026-05-09: phantom-trade pre-pass.
    //
    // TS V4-LIVE simulate calls `detectAsset` per bar with the FULL trimmed
    // candle slice (warmup + window). detectAsset iterates chronologically
    // and, after each found trade, advances `i` past the trade's exit bar
    // (cooldown = exitBar + 1). This is per-direction. Effect: detectAsset
    // implicitly tracks "in-flight" trades, suppressing new signals on the
    // same asset+direction until the previous trade exits.
    //
    // Rust's detect_r28_v6 is stateless. Without phantom-trade simulation,
    // the first window-bar signal fires even if a phantom from warmup
    // would have suppressed it. Empirically this inflates pass-rate by
    // ~7pp on small-basket configs (Hunter post-trade-exclusivity Rust
    // 62.20% / TS 55.20%). Per-window proof: win=1 BTC at 1626028200000 in
    // Rust (window first bar) vs at 1626040800000 in TS (after phantom
    // exit).
    //
    // Fix: simulate phantom trades through the full warmup, tracking per
    // (symbol, direction) "phantom open until bar i". On each window bar,
    // suppress signals when their phantom is still open.
    //
    // Phantom simulation uses the same `detect_r28_v6` for entry and
    // `process_position_exit_with_held` for exit, matching TS detectAsset
    // bit-for-bit. The state passed to detector is a throw-away shadow.
    use ftmo_engine_core::exit::process_position_exit_with_held;
    use ftmo_engine_core::position::OpenPosition;
    let phantom_open_until: HashMap<(String, ftmo_engine_core::position::PositionSide), usize> = {
        let mut map = HashMap::new();
        // Only run when default detector is active AND user opt-in via
        // --phantom-suppress. Phantom pre-pass is O(N²) per asset and adds
        // ~1000× CPU cost — keep it off by default for fast parameter sweeps,
        // turn on for parity-validation runs.
        if default_to_r28v6 && multi_signal.phantom_suppress {
            for asset in cfg.assets.iter() {
                let source = asset
                    .source_symbol
                    .clone()
                    .unwrap_or_else(|| asset.symbol.replace("-TREND", "USDT"));
                let candles_full = match aligned.get(&source) {
                    Some(v) => v.as_slice(),
                    None => continue,
                };
                let atr_full = atr_by_sym.get(&source).map(|v| v.as_slice());
                let funding_full = funding_by_sym.get(&source).map(|v| v.as_slice());
                let r28p = R28V6Params::default_for(asset, cfg);
                let mut shadow_state = EngineState::initial("phantom");
                let mut current_open: Option<(usize, OpenPosition)> = None;
                // Iterate from warmup_lo+1 (need at least 1 prior bar for trigger)
                // through `hi-1` so phantom that opens late in warmup but exits in
                // window is correctly tracked across the boundary.
                for i in (warmup_lo + 1)..hi {
                    if let Some((entry_idx, ref mut pos)) = current_open.as_mut() {
                        let candle = candles_full[i];
                        let atr_at_bar = atr_full
                            .and_then(|s| s.get(i).copied())
                            .flatten();
                        let bars_held = (i - *entry_idx) as u64;
                        let exit = process_position_exit_with_held(
                            pos, &candle, cfg, atr_at_bar, bars_held,
                        );
                        if exit.is_some() {
                            current_open = None; // phantom exits, no signal at i
                        }
                    } else {
                        // No phantom open — try to detect a new signal at bar i.
                        let arr = &candles_full[..=i];
                        let funding_slice = funding_full.map(|s| &s[..=i]);
                        let r28in = R28V6Inputs {
                            htf_closes: None,
                            cross_asset_closes: None,
                            news_events: None,
                            funding_series: funding_slice,
                        };
                        let sig = detect_r28_v6(
                            &mut shadow_state,
                            cfg,
                            asset,
                            &source,
                            arr,
                            &r28p,
                            &r28in,
                        );
                        if let Some(s) = sig {
                            // Phantom opens at bar i (entry uses candles[i].open).
                            let pos = OpenPosition {
                                ticket_id: format!("phantom-{}-{}", source, i),
                                symbol: s.symbol.clone(),
                                source_symbol: s.source_symbol.clone(),
                                direction: s.direction,
                                entry_time: s.entry_time,
                                entry_price: s.entry_price,
                                initial_stop_pct: s.stop_pct,
                                stop_price: s.stop_price,
                                tp_price: s.tp_price,
                                eff_risk: s.eff_risk,
                                entry_bar_idx: i as u64,
                                high_watermark: s.entry_price,
                                be_active: false,
                                ptp_triggered: false,
                                ptp_realized_pct: 0.0,
                                ptp_level_idx: 0,
                                ptp_levels_realized: 0.0,
                                last_known_price: Some(s.entry_price),
                                trail_active: false,
                                trail_peak: s.entry_price,
                            };
                            current_open = Some((i, pos));
                            // Record phantom-open period — for window suppression.
                            // The actual exit bar is unknown until we simulate forward,
                            // so we provisionally mark "open until hi" and tighten when exit fires.
                            map.insert((asset.symbol.clone(), s.direction), hi.saturating_sub(1));
                        }
                    }
                }
                // If phantom never closes, leave it open until hi-1 (suppresses entire window).
                // If phantom did close, the latest entry in `map` should reflect the closure
                // bar. Walk through second pass to correctly record exits.
            }
            // Second pass: rebuild map with EXACT exit bars per phantom trade.
            // The first pass populated entries opportunistically — overwriting on each
            // re-open. We need: for each (symbol, direction), the EXIT bar of the phantom
            // that was open at window-start (lo). If no phantom open at lo, map entry should
            // be missing (no suppression).
            map.clear();
            for asset in cfg.assets.iter() {
                let source = asset
                    .source_symbol
                    .clone()
                    .unwrap_or_else(|| asset.symbol.replace("-TREND", "USDT"));
                let candles_full = match aligned.get(&source) {
                    Some(v) => v.as_slice(),
                    None => continue,
                };
                let atr_full = atr_by_sym.get(&source).map(|v| v.as_slice());
                let funding_full = funding_by_sym.get(&source).map(|v| v.as_slice());
                let r28p = R28V6Params::default_for(asset, cfg);
                let mut shadow_state = EngineState::initial("phantom");
                let mut current_open: Option<(usize, ftmo_engine_core::position::PositionSide, OpenPosition)> = None;
                // R29-Bug-Audit Phase-2: 1-bar post-exit cooldown to mirror TS
                // `cooldown = exitBar + 1` (ftmoDaytrade24h.ts:4998). Without
                // this, Rust phantom re-fires 1 bar earlier than TS would,
                // causing divergent phantom #2 entry prices and over-suppression.
                let mut cooldown_until_iter: usize = 0;
                for i in (warmup_lo + 1)..hi {
                    if let Some((entry_idx, dir, ref mut pos)) = current_open.as_mut() {
                        let candle = candles_full[i];
                        let atr_at_bar = atr_full
                            .and_then(|s| s.get(i).copied())
                            .flatten();
                        let bars_held = (i - *entry_idx) as u64;
                        let exit = process_position_exit_with_held(
                            pos, &candle, cfg, atr_at_bar, bars_held,
                        );
                        if exit.is_some() {
                            // Phantom exited at bar i. The TS suppression
                            // window in candle-index terms is
                            //   [entry_bar, exit_bar+1] (incl. entry, incl. cooldown).
                            // Real engine should not fire on (asset, dir) at any
                            // bar i_main where i_main < exit_bar + 2 (the next
                            // legitimate entry bar in TS convention).
                            // Next-legitimate-entry bar in TS convention is i+2:
                            //   exit at iter i, cooldown=i+1, next trigger at iter i+1
                            //   blocked, entry at iter i+2 = entry-bar i+2.
                            // Map value = first allowed i_main; suppression check
                            // is `if i_main < phantom_open_until` (strict <).
                            let next_allowed = i + 2;
                            if *entry_idx < lo && next_allowed > lo {
                                map.insert(
                                    (asset.symbol.clone(), *dir),
                                    next_allowed.max(lo),
                                );
                            }
                            current_open = None;
                            cooldown_until_iter = i + 2; // skip iter i+1 in next pass
                        }
                    } else {
                        if i < cooldown_until_iter {
                            continue;
                        }
                        let arr = &candles_full[..=i];
                        let funding_slice = funding_full.map(|s| &s[..=i]);
                        let r28in = R28V6Inputs {
                            htf_closes: None,
                            cross_asset_closes: None,
                            news_events: None,
                            funding_series: funding_slice,
                        };
                        let sig = detect_r28_v6(
                            &mut shadow_state,
                            cfg,
                            asset,
                            &source,
                            arr,
                            &r28p,
                            &r28in,
                        );
                        if let Some(s) = sig {
                            let pos = OpenPosition {
                                ticket_id: format!("phantom-{}-{}", source, i),
                                symbol: s.symbol.clone(),
                                source_symbol: s.source_symbol.clone(),
                                direction: s.direction,
                                entry_time: s.entry_time,
                                entry_price: s.entry_price,
                                initial_stop_pct: s.stop_pct,
                                stop_price: s.stop_price,
                                tp_price: s.tp_price,
                                eff_risk: s.eff_risk,
                                entry_bar_idx: i as u64,
                                high_watermark: s.entry_price,
                                be_active: false,
                                ptp_triggered: false,
                                ptp_realized_pct: 0.0,
                                ptp_level_idx: 0,
                                ptp_levels_realized: 0.0,
                                last_known_price: Some(s.entry_price),
                                trail_active: false,
                                trail_peak: s.entry_price,
                            };
                            current_open = Some((i, s.direction, pos));
                        }
                    }
                }
                // If phantom is still open at end of slice AND entered before
                // window start, suppress for entire window.
                if let Some((entry_idx, dir, _)) = current_open {
                    if entry_idx < lo {
                        map.insert((asset.symbol.clone(), dir), hi.saturating_sub(1));
                    }
                }
            }
        }
        map
    };

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
                // R29-Bug-Audit-2026-05-09: phantom suppression. If a phantom
                // trade from warmup is still open at the current bar `i`,
                // skip the signal — TS detectAsset would have suppressed it
                // via internal cooldown.
                let key = (s.symbol.clone(), s.direction);
                if let Some(&exit_bar) = phantom_open_until.get(&key) {
                    if i < exit_bar {
                        // Phantom still open; suppress.
                        continue;
                    }
                }
                // R29-Audit: random-gate sanity check. Drop the signal with
                // (1 - keep_frac) probability. Deterministic per signal so
                // results are reproducible. Used to confirm ML gain isn't
                // just trade-count reduction.
                if let Some(keep) = multi_signal.random_gate_keep {
                    let mut h = std::hash::DefaultHasher::new();
                    use std::hash::{Hash, Hasher};
                    multi_signal.random_gate_seed.hash(&mut h);
                    s.entry_time.hash(&mut h);
                    s.symbol.hash(&mut h);
                    let v = (h.finish() & 0xffff_ffff) as f64 / (1u64 << 32) as f64;
                    if v >= keep {
                        continue;
                    }
                }
                // R29-Track-B3: ML signal-gate. Predict P(win) and skip
                // signals whose probability falls below the threshold.
                if let Some(model) = multi_signal.ml_model.as_ref() {
                    if let Some(series) = ml_features_by_sym.get(&source) {
                        let asset_idx = cfg
                            .assets
                            .iter()
                            .position(|a| a.symbol == s.symbol)
                            .unwrap_or(0);
                        let direction_long = matches!(
                            s.direction,
                            ftmo_engine_core::position::PositionSide::Long
                        );
                        let feats = ml_features_for_signal(
                            series,
                            i,
                            asset_idx,
                            direction_long,
                            s.entry_time,
                        );
                        let p_win = model.predict_proba(&feats);
                        if p_win < multi_signal.ml_threshold {
                            continue;
                        }
                    }
                }
                signals_for_bar.push(s);
            }

            // R29-Stage-B: extra detectors fired in PARALLEL when
            // requested. Each emits at most one signal per asset per bar;
            // multi-detector means trend + mean-rev (or breakout) signals
            // can both reach the harness for the same asset on the same
            // bar. The harness's per-asset+direction trade-exclusivity
            // gate (commit 50194dc) ensures only one position opens.
            if multi_signal.also_meanrev
                && matches!(signals_mode, SignalSrc::PerAssetCfg)
                && default_to_r28v6
            {
                let arr = match feed.get(&source) {
                    Some(v) => v,
                    None => continue,
                };
                let mr_src = ftmo_engine_core::config::MeanReversionSource {
                    period: multi_signal.mr_period.unwrap_or(14),
                    oversold: multi_signal.mr_oversold.unwrap_or(25.0),
                    overbought: multi_signal.mr_overbought.unwrap_or(75.0),
                    cooldown_bars: multi_signal.mr_cooldown.unwrap_or(8),
                    size_mult: multi_signal.mr_size_mult.unwrap_or(0.5),
                };
                if let Some(s) =
                    detect_mean_reversion(&mut state, cfg, asset, &source, arr, &mr_src)
                {
                    let key = (s.symbol.clone(), s.direction);
                    if let Some(&exit_bar) = phantom_open_until.get(&key) {
                        if i < exit_bar {
                            continue;
                        }
                    }
                    signals_for_bar.push(s);
                }
            }
            if multi_signal.also_breakout
                && matches!(signals_mode, SignalSrc::PerAssetCfg)
                && default_to_r28v6
            {
                let arr = match feed.get(&source) {
                    Some(v) => v,
                    None => continue,
                };
                let bp = BreakoutParams::from_cfg(cfg, asset);
                if let Some(s) = detect_breakout(&mut state, cfg, asset, &source, arr, &bp) {
                    signals_for_bar.push(s);
                }
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
    // Dump full closed_trades for this window when --trades-out (and
    // optionally --debug-window) is set. One trade per JSONL line, prefixed
    // with `win_idx`. Used for per-trade Rust↔TS audit on bug-suspect windows.
    let dump_trades = match debug_window {
        Some(target) => target == w_idx,
        None => trades_writer.lock().map(|g| g.is_some()).unwrap_or(false),
    };
    if dump_trades {
        if let Ok(mut g) = trades_writer.lock() {
            if let Some(w) = g.as_mut() {
                for t in &state.closed_trades {
                    let mut line = serde_json::to_value(t).unwrap_or(serde_json::Value::Null);
                    if let Some(o) = line.as_object_mut() {
                        o.insert("winIdx".into(), serde_json::json!(w_idx));
                    }
                    let _ = writeln!(w, "{line}");
                }
            }
        }
    }
    report
}
