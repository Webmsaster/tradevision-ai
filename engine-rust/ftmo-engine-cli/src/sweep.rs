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
    bar_minutes: u32,
    funding_at_bar: Option<f64>,
) -> Option<[f64; 14]> {
    // R29-Audit-2026-05-10: CRITICAL FIX — use bar BEFORE entry. At entry
    // time (= candles[bar_idx].open_time) bar `bar_idx` has just started;
    // its close/high/low are FUTURE. Read features at i = bar_idx - 1.
    let i = bar_idx.saturating_sub(1);
    // R29-Audit-Round3 2026-05-12 (Bug-4 fix): cold-start guard. The five
    // critical indicators (sma200 the most fragile) must all be present at
    // bar `i` or the feature vector collapses to zeros — and a zero-vector
    // sent through a forest of 200 trees with split thresholds around
    // RSI≈50, SMA-slope≈0, ATR≈0.01 routes deterministically to a single
    // leaf, slamming P(win) far from the asset's baseline. The training
    // pipeline already skips trades when `entryIdx < 201` (sma200 warmup),
    // so inference should likewise refuse to score them. Caller treats
    // None as "pass-through" (no gate). We *don't* drop the trade — that
    // would diverge from training, where these trades are simply absent
    // from the label distribution.
    let sma200_ready = series.sma200.get(i).copied().flatten().is_some();
    let sma50_ready = series.sma50.get(i).copied().flatten().is_some();
    let sma20_ready = series.sma20.get(i).copied().flatten().is_some();
    let rsi14_ready = series.rsi14.get(i).copied().flatten().is_some();
    let atr14_ready = series.atr14.get(i).copied().flatten().is_some();
    if !(sma200_ready && sma50_ready && sma20_ready && rsi14_ready && atr14_ready) {
        return None;
    }
    // R29-R3.3: prior-N return is anchored in *wall-clock minutes*, not bars,
    // so the same trained model sees the same look-back window across TFs.
    // Trained on 30m: 5-bar = 150min, 20-bar = 600min. Map to current TF.
    let scale = (30.0 / (bar_minutes.max(1) as f64)).round().max(1.0) as usize;
    let lb_short = 5 * scale;
    let lb_long = 20 * scale;
    let close = series.closes.get(i).copied().unwrap_or(0.0);
    let close5 = series
        .closes
        .get(i.saturating_sub(lb_short))
        .copied()
        .unwrap_or(close);
    let close20 = series
        .closes
        .get(i.saturating_sub(lb_long))
        .copied()
        .unwrap_or(close);
    let prior5 = if close5 > 0.0 {
        (close - close5) / close5
    } else {
        0.0
    };
    let prior20 = if close20 > 0.0 {
        (close - close20) / close20
    } else {
        0.0
    };
    let atr_pct = match (series.atr14.get(i).copied().flatten(), close) {
        (Some(a), c) if c > 0.0 => a / c,
        _ => 0.0,
    };
    let slope = |s: &[Option<f64>], lookback_30m: usize| -> f64 {
        // R29-R3.3: lookback comes in 30m-native bar units; scale by
        // `30 / bar_minutes` for the actual run TF.
        let lookback = lookback_30m * scale;
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
    Some([
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
        // R29-R2.5: forward-filled funding rate at bar_idx-1; null→0
        // matches `nan_to_num(0.0)` in `_mlTrainClassifier.py`.
        funding_at_bar.unwrap_or(0.0),
    ])
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
    /// 2026-05-13 — R28V6 detector secondary-gate overrides. Activate ADX,
    /// choppiness, RSI gates that exist in `signals_r28v6.rs` but were
    /// never wired to a config field. Honest sweep target = lift pass-rate
    /// above 58-60% plateau on AMBER/AMBER_EXT PASSLOCK by filtering out
    /// no-trend / overextended entries.
    r28v6_adx_min: Option<f64>,
    r28v6_adx_period: Option<usize>,
    r28v6_chop_max: Option<f64>,
    r28v6_chop_period: Option<usize>,
    r28v6_rsi_long_max: Option<f64>,
    r28v6_rsi_short_min: Option<f64>,
    r28v6_rsi_period: Option<usize>,
    /// 2026-05-13 65%-hunt: activate dormant HTF-EMA stack via downsampled
    /// 30m → 4h closes. When true, every 8th bar of `feed` is forwarded as
    /// `R28V6Inputs.htf_closes`, gating long-entries on EMA-fast > EMA-slow
    /// and shorts on the inverse.
    use_htf_confirm: bool,
    /// HTF downsample stride (bars). Default 8 (30m → 4h). Configurable for
    /// experiment: 4 (2h), 16 (8h), 24 (12h), 48 (1d).
    htf_stride: usize,
    /// Phase B Regime-Confluence: min consensus votes (1-4). Default 2.
    regime_min_votes: usize,
    /// When true, the winning side MUST include the R28V6 detector's vote.
    regime_require_r28v6: bool,
    /// 2026-05-13 Phase B-2: enable a 4th vote from a volume-spike confirm.
    regime_use_vol_confirm: bool,
    regime_vol_period: usize,
    regime_vol_mult: f64,
    /// Force MR-source override even if template doesn't carry one.
    regime_force_mr: bool,
    /// 2026-05-14 Detector #34 — Coinbase-Binance Premium voter activation
    /// + tunable knobs. CLI flags: `--regime-cb-premium`,
    /// `--cb-threshold-bps`, `--cb-consecutive`. The premium data
    /// directory comes via `--cb-premium-dir` (separate top-level
    /// argument so the loader call sees it before MultiSignalCfg is built).
    regime_use_cb_premium: bool,
    cb_threshold_bps: u32,
    cb_consecutive_bars: usize,
    /// 2026-05-13 Audit Round 3: when true, disable the engine's "soft pass"
    /// tail check that allows a window to pass if target was ever hit AND
    /// `final_equity >= 0.5 × target`. Strict mode requires `final_equity ≥
    /// target` at end. Champion C2 (pt=0.04) drops from 80.04% → 73.25%
    /// under strict rule; Champion B (pt=0.08) drops 72.37% → 64.04%.
    strict_pass: bool,
    /// 2026-05-13 Phase 3b: VWAP-trend 5th-voter activation + params.
    regime_use_vwap_trend: bool,
    regime_vwap_period: usize,
    regime_vwap_min_dev: f64,
    /// 2026-05-14 Detector #14 — Stop-Hunt Liquidity-Sweep Reversal voter
    /// activation + params. 6th independent voter in the REGIME panel.
    regime_use_stop_hunt: bool,
    regime_sh_lookback: usize,
    regime_sh_wick_pct: f64,
    regime_sh_close_strict: bool,
    /// 2026-05-14 Detector #1 — Bollinger-Band Z-score Mean-Reversion voter
    /// activation + params. 7th independent voter in the REGIME panel.
    regime_use_bb_z_mr: bool,
    regime_bb_z_period: u32,
    regime_bb_z_mult: f64,
    regime_bb_z_threshold: f64,
    regime_bb_z_cooldown: u64,
    /// 2026-05-14 Detector #2 — Order-Flow-Imbalance Persistent Cluster.
    /// `also_fire_ofi_persistent` adds the detector as an ADDITIVE entry
    /// alongside R28V6 (mirrors `also_fire_meanrev/breakout`). `regime_use_ofi`
    /// enrolls it as the 8th independent voter inside the regime panel.
    /// Tuneable knobs: window_bars (5), delta_threshold (0.20 ≈ 60/40 ratio),
    /// SMA-period (20), cooldown (12 bars on a 30m feed = 6 hours).
    also_fire_ofi_persistent: bool,
    regime_use_ofi: bool,
    ofi_window: usize,
    ofi_threshold: f64,
    ofi_sma: usize,
    ofi_cooldown: u64,
    // 2026-05-14 Phase-2 voter flags (CMF + RSI-Hidden-Divergence wired).
    regime_use_cmf: bool,
    regime_use_rsi_hidden_div: bool,
    // 2026-05-14 Phase-3 voter flags (7 new modules — cb_premium deferred for series loader).
    regime_use_ad_line: bool,
    regime_use_aroon: bool,
    regime_use_double_top: bool,
    regime_use_smc_fvg: bool,
    regime_use_supertrend: bool,
    regime_use_kalman_trend: bool,
    // 2026-05-14 — macro / cross-market voters. Toggle-only; external series
    // are still default-None until per-feed loaders ship.
    // (regime_use_cb_premium is defined above with detector-34 knobs.)
    regime_use_cme_basis: bool,
    regime_use_hmm: bool,
    regime_use_nupl: bool,
    regime_use_top_trader_ls: bool,
    regime_use_stablecoin: bool,
    /// 2026-05-14 Detector #13 — Higher-timeframe MACD-histogram trend
    /// confluence gate. Wired into both standalone-R28V6
    /// (`apply_r28v6_param_overrides`) and REGIME mode
    /// (`RegimeConfluenceParams.htf_macd_*`). Dormant by default; activate
    /// with `--use-htf-macd-gate`. Operates on the same `htf_closes` buffer
    /// as the EMA-9/21 gate so the user only needs to pass `--use-htf-confirm`
    /// once.
    use_htf_macd_gate: bool,
    htf_macd_fast: usize,
    htf_macd_slow: usize,
    htf_macd_signal: usize,
    htf_macd_rising_lookback: usize,
    htf_macd_min_magnitude: f64,
    // Below: deliberately at end so the field-init order in `let cfg =
    // MultiSignalCfg { ... }` stays stable for existing call sites.
    /// R29-Audit-2026-05-12: phantom_suppress field REMOVED. The feature
    /// over-blocked legitimate entries (-23pp on R28_V6_PASSLOCK vs TS V4-Sim)
    /// because TS detectAsset's stateless slice-from-zero re-detection is not
    /// bar-perfect either; mirroring it in stateful Rust diverged in both
    /// directions. Default was already OFF, no silent-misuse risk after removal.
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

/// 2026-05-13 65%-hunt: apply CLI-flag overrides for the secondary R28V6
/// detector gates (ADX, choppiness, RSI). All gates default to None in
/// `R28V6Params::default_for`; this helper activates them when the user
/// passed `--override-adx-min` etc.
/// 2026-05-14 Detector #18 — parse `--ptp-levels "0.02:0.30,0.04:0.30,0.06:0.40"`.
///
/// Validation rules (mirror `exit.rs` invariants):
///   * each token must be `trigger_pct:close_fraction` floats
///   * trigger_pct strictly monotone increasing (early-stop in
///     `process_position_exit_with_held` requires sorted-ascending levels)
///   * every trigger_pct > 0 and every close_fraction > 0
///   * sum(close_fraction) <= 1.0 (cannot close more than 100% of the
///     remaining position across all tiers)
fn parse_ptp_levels(
    csv: &str,
) -> Result<Vec<ftmo_engine_core::config::PartialTakeProfitLevel>> {
    let mut out: Vec<ftmo_engine_core::config::PartialTakeProfitLevel> = Vec::new();
    let mut prev_trigger: Option<f64> = None;
    let mut frac_sum = 0.0_f64;
    for raw in csv.split(',') {
        let tok = raw.trim();
        if tok.is_empty() {
            continue;
        }
        let mut parts = tok.splitn(2, ':');
        let t_str = parts
            .next()
            .ok_or_else(|| anyhow!("--ptp-levels token '{tok}' missing trigger_pct"))?;
        let f_str = parts
            .next()
            .ok_or_else(|| anyhow!("--ptp-levels token '{tok}' missing close_fraction"))?;
        let trigger_pct: f64 = t_str
            .trim()
            .parse()
            .map_err(|e| anyhow!("--ptp-levels '{tok}': trigger_pct parse error: {e}"))?;
        let close_fraction: f64 = f_str
            .trim()
            .parse()
            .map_err(|e| anyhow!("--ptp-levels '{tok}': close_fraction parse error: {e}"))?;
        if !(trigger_pct > 0.0) {
            return Err(anyhow!(
                "--ptp-levels '{tok}': trigger_pct must be > 0 (got {trigger_pct})"
            ));
        }
        if !(close_fraction > 0.0) {
            return Err(anyhow!(
                "--ptp-levels '{tok}': close_fraction must be > 0 (got {close_fraction})"
            ));
        }
        if let Some(prev) = prev_trigger {
            if !(trigger_pct > prev) {
                return Err(anyhow!(
                    "--ptp-levels: trigger_pct must be strictly increasing (got {trigger_pct} after {prev})"
                ));
            }
        }
        prev_trigger = Some(trigger_pct);
        frac_sum += close_fraction;
        out.push(ftmo_engine_core::config::PartialTakeProfitLevel {
            trigger_pct,
            close_fraction,
        });
    }
    if out.is_empty() {
        return Err(anyhow!("--ptp-levels: at least one level required"));
    }
    // Allow tiny FP slack so "0.30,0.30,0.40" doesn't trip on epsilon drift.
    if frac_sum > 1.0 + 1e-9 {
        return Err(anyhow!(
            "--ptp-levels: sum(close_fraction) = {frac_sum} > 1.0 (cannot close more than full position)"
        ));
    }
    Ok(out)
}

fn apply_r28v6_param_overrides(
    params: &mut ftmo_engine_core::signals_r28v6::R28V6Params,
    cfg: &MultiSignalCfg,
) {
    if let Some(min) = cfg.r28v6_adx_min {
        params.adx_min = Some(min);
        params.adx_period = Some(cfg.r28v6_adx_period.unwrap_or(14));
    }
    if let Some(max) = cfg.r28v6_chop_max {
        params.choppiness_max = Some(max);
        params.choppiness_period = Some(cfg.r28v6_chop_period.unwrap_or(14));
    }
    if cfg.r28v6_rsi_long_max.is_some() || cfg.r28v6_rsi_short_min.is_some() {
        params.rsi_period = Some(cfg.r28v6_rsi_period.unwrap_or(14));
        params.rsi_long_max = cfg.r28v6_rsi_long_max;
        params.rsi_short_min = cfg.r28v6_rsi_short_min;
    }
    // 2026-05-14 Detector #13 — HTF MACD-histogram gate. Mirror of the
    // wiring in `RegimeConfluenceParams::apply_r28v6_overrides` so the same
    // CLI flags govern both signal paths (Codex Round 2 bug class: silent
    // no-op when REGIME mode rebuilds R28V6Params via `default_for`).
    if cfg.use_htf_macd_gate {
        params.htf_macd_enabled = true;
        params.htf_macd_fast = cfg.htf_macd_fast;
        params.htf_macd_slow = cfg.htf_macd_slow;
        params.htf_macd_signal = cfg.htf_macd_signal;
        params.htf_macd_rising_lookback = cfg.htf_macd_rising_lookback;
        params.htf_macd_min_magnitude = cfg.htf_macd_min_magnitude;
    }
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
    max_days: Option<u32>,
    lscool_after: Option<u32>,
    lscool_bars: Option<u64>,
    /// 2026-05-13 Hebel 2: cross-asset stress filter (e.g. BTC trend gate
    /// for AMBER basket). Activates `cfg.cross_asset_filter` and injects
    /// per-asset cross-symbol closes at sweep-loop time.
    cross_asset_sym: Option<String>,
    cross_asset_dir: Option<String>,
    cross_asset_fast: Option<u32>,
    cross_asset_slow: Option<u32>,
    /// 2026-05-14 Detector #18 — multi-level PTP CSV override.
    /// Format: "trigger_pct:close_fraction[,trigger_pct:close_fraction]...".
    /// Parsed list is forwarded to `cfg.partial_take_profit_levels` and the
    /// single-tier `partial_take_profit` is forcibly cleared so the two
    /// branches in `exit::process_position_exit` cannot double-fire on the
    /// same bar.
    ptp_levels: Option<Vec<ftmo_engine_core::config::PartialTakeProfitLevel>>,
    /// Detector #20 — 3-phase day-stage sizing (aggressive → neutral →
    /// defensive). When any of the `ds_*_factor` flags is set, a fresh tier
    /// ladder is built in `apply_overrides`. Template-supplied tiers are
    /// kept when no flag is supplied.
    ds_aggressive_until: Option<u32>,
    ds_aggressive_factor: Option<f64>,
    ds_neutral_until: Option<u32>,
    ds_neutral_factor: Option<f64>,
    ds_defensive_factor: Option<f64>,
    /// Detector #20 cross-cut — equity-progress early-defensive trigger.
    ds_progress_frac: Option<f64>,
    ds_progress_factor: Option<f64>,
    /// Detector #20 kill-switch — wipes day-stage AND early-progress.
    disable_day_stage: bool,
    /// 2026-05-14 Detector #11 Phase-1 — funding-cost sizing modifier.
    /// All three flags wire `cfg.funding_cost_sizing = Some(...)`. Any
    /// `Some` value triggers activation; defaults match `FundingCostSizing::default()`.
    funding_sizing_alpha: Option<f64>,
    funding_sizing_window: Option<u32>,
    funding_sizing_min_factor: Option<f64>,
    /// 2026-05-14 (detector-41): when set, the cross-asset filter inverts
    /// secondary-trend semantics before gating (DXY ↔ crypto-style).
    cross_asset_inverse: bool,
}

fn apply_overrides(
    cfg: &mut ftmo_engine_core::config::EngineConfig,
    ov: &CfgOverrides,
) -> Result<()> {
    use ftmo_engine_core::config::{
        BreakEven, DayProgressiveTier, EarlyDefensiveOnProgress, FundingRateFilter,
        IntradayDailyLossThrottle, LossStreakCooldown, PeakDrawdownThrottle, PeakTrailingStop,
        TrailingStop,
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
        // Bug-fix 2026-05-12: normalize drop-list by stripping USDT suffix.
        // cfg.assets bare/src are stored without USDT (e.g. "ARB"), so input
        // "ARBUSDT" would never match. Strip USDT from BOTH sides to match.
        let drop: std::collections::HashSet<String> = csv
            .split(',')
            .map(|s| s.trim().to_uppercase().replace("USDT", ""))
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
        // Bug-fix 2026-05-12: same USDT-normalize as drop-symbols.
        let keep: std::collections::HashSet<String> = csv
            .split(',')
            .map(|s| s.trim().to_uppercase().replace("USDT", ""))
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
    if let Some(d) = ov.max_days {
        cfg.max_days = d;
    }
    if let Some(sym) = ov.cross_asset_sym.as_ref() {
        cfg.cross_asset_filter = Some(ftmo_engine_core::config::CrossAssetFilter {
            symbol: sym.clone(),
            direction: ov
                .cross_asset_dir
                .clone()
                .unwrap_or_else(|| "any".to_string()),
            fast_period: ov.cross_asset_fast.unwrap_or(9),
            slow_period: ov.cross_asset_slow.unwrap_or(21),
            skip_longs_if_secondary_downtrend: false,
            skip_shorts_if_secondary_uptrend: false,
            inverse_correlation: ov.cross_asset_inverse,
        });
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
        let cur = cfg
            .intraday_daily_loss_throttle
            .unwrap_or(IntradayDailyLossThrottle {
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
    // 2026-05-14 Detector #18 — multi-level PTP override. When set, we
    // FORCE-CLEAR single-tier `partial_take_profit` so the two PRE-cross PTP
    // branches in `exit::process_position_exit_with_held` cannot stack on the
    // same bar (single-tier sets ptp_triggered + BE; multi-level then would
    // also realise its levels and shift BE a second time). Documented in
    // CfgOverrides::ptp_levels above.
    if let Some(levels) = ov.ptp_levels.as_ref() {
        cfg.partial_take_profit = None;
        cfg.partial_take_profit_levels = Some(levels.clone());
    }
    // ─── Detector #20 — 3-phase day-stage sizing + equity-progress ──
    if ov.disable_day_stage {
        cfg.day_progressive_sizing = None;
        cfg.early_defensive_on_progress = None;
    } else if ov.ds_aggressive_factor.is_some()
        || ov.ds_defensive_factor.is_some()
        || ov.ds_neutral_factor.is_some()
        || ov.ds_aggressive_until.is_some()
        || ov.ds_neutral_until.is_some()
    {
        let agg_until = ov.ds_aggressive_until.unwrap_or(3);
        let neu_until = ov.ds_neutral_until.unwrap_or(8);
        let agg_f = ov.ds_aggressive_factor.unwrap_or(1.5);
        let neu_f = ov.ds_neutral_factor.unwrap_or(1.0);
        let def_f = ov.ds_defensive_factor.unwrap_or(0.7);
        cfg.day_progressive_sizing = Some(vec![
            DayProgressiveTier {
                day_at_least: 0,
                factor: agg_f,
            },
            DayProgressiveTier {
                day_at_least: agg_until,
                factor: neu_f,
            },
            DayProgressiveTier {
                day_at_least: neu_until,
                factor: def_f,
            },
        ]);
    }
    if let (Some(p), Some(f)) = (ov.ds_progress_frac, ov.ds_progress_factor) {
        cfg.early_defensive_on_progress = Some(EarlyDefensiveOnProgress {
            progress_frac: p,
            factor: f,
        });
    }
    // 2026-05-14 Detector #11 Phase-1 — funding-cost sizing modifier.
    // Any flag activates the modifier; missing flags fall back to defaults.
    if ov.funding_sizing_alpha.is_some()
        || ov.funding_sizing_window.is_some()
        || ov.funding_sizing_min_factor.is_some()
    {
        let cur = cfg
            .funding_cost_sizing
            .unwrap_or_else(ftmo_engine_core::config::FundingCostSizing::default);
        cfg.funding_cost_sizing = Some(ftmo_engine_core::config::FundingCostSizing {
            alpha: ov.funding_sizing_alpha.unwrap_or(cur.alpha),
            norm_window_buckets: ov.funding_sizing_window.unwrap_or(cur.norm_window_buckets),
            min_factor: ov.funding_sizing_min_factor.unwrap_or(cur.min_factor),
        });
    }
    if let Some(csv) = &ov.adaptive_tp {
        // Format: "BTC:0.025,ETH:0.030,..."
        for pair in csv.split(',') {
            let mut sp = pair.splitn(2, ':');
            let key = sp
                .next()
                .map(|s| s.trim().to_uppercase())
                .unwrap_or_default();
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
    /// 2026-05-13 Phase B — Regime-Confluence consensus detector. Polls
    /// R28V6 + breakout + meanrev simultaneously and only emits a signal
    /// when `min_votes` detectors agree on direction. See
    /// `signals_regime_confluence.rs`.
    RegimeConfluence,
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
    let mut override_dows: Option<String> = None; // CSV "1,2,3,4,5"
    let mut drop_symbols: Option<String> = None; // CSV "RUNE,SAND"
    let mut keep_symbols: Option<String> = None; // CSV "BTC,ETH,..." (whitelist)
    let mut disable_trail: bool = false;
    let mut disable_passlock: bool = false;
    let mut enable_passlock: bool = false;
    let mut be_threshold: Option<f64> = None; // add break-even
    let mut funding_max_long: Option<f64> = None;
    let mut funding_min_short: Option<f64> = None;
    let mut adaptive_tp_per_asset: Option<String> = None; // "BTC:0.025,ETH:0.030"
    let mut pdd_from_peak: Option<f64> = None; // peak_drawdown_throttle.from_peak
    let mut pdd_factor: Option<f64> = None; // peak_drawdown_throttle.factor
    let mut dpts_trail: Option<f64> = None; // daily_peak_trailing_stop.trail_distance
    let mut cpts_trail: Option<f64> = None; // challenge_peak_trailing_stop.trail_distance
    let mut idl_threshold: Option<f64> = None; // intraday_daily_loss_throttle.hard_loss_threshold
    let mut idl_factor: Option<f64> = None; // intraday_daily_loss_throttle.size_factor
    let mut min_trading_days: Option<u32> = None;
    let mut profit_target: Option<f64> = None;
    let mut max_days: Option<u32> = None;
    let mut cross_asset_sym: Option<String> = None;
    let mut cross_asset_dir: Option<String> = None;
    let mut cross_asset_fast: Option<u32> = None;
    let mut cross_asset_slow: Option<u32> = None;
    // Detector #20 — 3-phase day-stage sizing + equity-progress trigger.
    let mut ds_aggressive_until: Option<u32> = None;
    let mut ds_aggressive_factor: Option<f64> = None;
    let mut ds_neutral_until: Option<u32> = None;
    let mut ds_neutral_factor: Option<f64> = None;
    let mut ds_defensive_factor: Option<f64> = None;
    let mut ds_progress_frac: Option<f64> = None;
    let mut ds_progress_factor: Option<f64> = None;
    let mut disable_day_stage: bool = false;
    // 2026-05-14 Detector #11 Phase-1 — funding-cost sizing modifier flags.
    let mut funding_sizing_alpha: Option<f64> = None;
    let mut funding_sizing_window: Option<u32> = None;
    let mut funding_sizing_min_factor: Option<f64> = None;
    // 2026-05-14 (detector-41): inverse-correlation gate for DXY-style drivers.
    let mut cross_asset_inverse: bool = false;
    let mut adx_min: Option<f64> = None;
    let mut adx_period: Option<usize> = None;
    let mut chop_max: Option<f64> = None;
    let mut chop_period: Option<usize> = None;
    let mut rsi_long_max: Option<f64> = None;
    let mut rsi_short_min: Option<f64> = None;
    let mut rsi_period: Option<usize> = None;
    let mut lscool_after: Option<u32> = None;
    let mut lscool_bars: Option<u64> = None;
    let mut ml_model_path: Option<PathBuf> = None;
    // R29-Audit-Round3 2026-05-12 (Bug-1 fix): default sentinel `NaN` lets us
    // detect "user passed `--ml-model` but forgot `--ml-threshold`" and
    // fail-loud below instead of silently keeping every signal (threshold=0
    // accepts P(win)≥0 = always true → ML gate is a no-op but logs claim
    // it's loaded).
    let mut ml_threshold: f64 = f64::NAN;
    let mut start_after_ts: Option<i64> = None;
    let mut random_gate_keep: Option<f64> = None;
    let mut random_gate_seed: u64 = 42;
    let mut timeframe: Option<String> = None;
    let mut also_fire_meanrev: bool = false;
    let mut also_fire_breakout: bool = false;
    let mut use_htf_confirm: bool = false;
    let mut htf_stride: usize = 8;
    let mut regime_min_votes: usize = 2;
    let mut regime_require_r28v6: bool = false;
    let mut regime_use_vol_confirm: bool = false;
    let mut regime_vol_period: usize = 20;
    let mut regime_vol_mult: f64 = 1.2;
    let mut regime_force_mr: bool = false;
    let mut strict_pass: bool = false;
    let mut regime_use_vwap_trend: bool = false;
    let mut regime_vwap_period: usize = 20;
    let mut regime_vwap_min_dev: f64 = 0.0;
    // 2026-05-14 Detector #14 — Stop-Hunt Liquidity-Sweep voter knobs.
    let mut regime_use_stop_hunt: bool = false;
    let mut regime_sh_lookback: usize = 20;
    let mut regime_sh_wick_pct: f64 = 0.003;
    let mut regime_sh_close_strict: bool = false;
    // 2026-05-14 Detector #1 — Bollinger-Band Z-score MR voter knobs.
    let mut regime_use_bb_z_mr: bool = false;
    let mut regime_bb_z_period: u32 = 20;
    let mut regime_bb_z_mult: f64 = 2.0;
    let mut regime_bb_z_threshold: f64 = 2.0;
    let mut regime_bb_z_cooldown: u64 = 8;
    // 2026-05-14 Detector #2 — OFI persistent-cluster knobs. Defaults mirror
    // `OfiPersistentParams::default_30m_crypto()` so flag-free callers see
    // the same shape as direct API users.
    let mut also_fire_ofi_persistent: bool = false;
    let mut regime_use_ofi: bool = false;
    let mut ofi_window: usize = 5;
    let mut ofi_threshold: f64 = 0.20;
    let mut ofi_sma: usize = 20;
    let mut ofi_cooldown: u64 = 12;
    // 2026-05-14 Phase-2 — voter on/off flags.
    let mut regime_use_cmf: bool = false;
    let mut regime_use_rsi_hidden_div: bool = false;
    // 2026-05-14 Phase-3 — voter on/off flags (defaults off).
    let mut regime_use_ad_line: bool = false;
    let mut regime_use_aroon: bool = false;
    let mut regime_use_double_top: bool = false;
    let mut regime_use_smc_fvg: bool = false;
    let mut regime_use_supertrend: bool = false;
    let mut regime_use_kalman_trend: bool = false;
    let mut regime_use_cb_premium: bool = false;
    let mut regime_use_cme_basis: bool = false;
    let mut regime_use_hmm: bool = false;
    let mut regime_use_nupl: bool = false;
    let mut regime_use_top_trader_ls: bool = false;
    let mut regime_use_stablecoin: bool = false;
    // 2026-05-14 Detector #34 — Coinbase-Binance Premium voter knobs.
    let mut cb_threshold_bps: u32 = 15;
    let mut cb_consecutive_bars: usize = 2;
    let mut cb_premium_dir: Option<PathBuf> = None;
    // Detector #13 — HTF MACD-histogram gate. Defaults match classic
    // MACD(12, 26, 9) with `rising_lookback = 1` (bar-over-bar momentum).
    let mut use_htf_macd_gate: bool = false;
    let mut htf_macd_fast: usize = 12;
    let mut htf_macd_slow: usize = 26;
    let mut htf_macd_signal: usize = 9;
    let mut htf_macd_rising_lookback: usize = 1;
    let mut htf_macd_min_magnitude: f64 = 0.0;
    let mut mr_period: Option<u32> = None;
    let mut mr_oversold: Option<f64> = None;
    let mut mr_overbought: Option<f64> = None;
    let mut mr_cooldown: Option<u64> = None;
    let mut mr_size_mult: Option<f64> = None;
    // 2026-05-14 Detector #18 — multi-level PTP CLI override.
    let mut ptp_levels: Option<Vec<ftmo_engine_core::config::PartialTakeProfitLevel>> = None;

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
                    "regime" | "regime-confluence" => SignalSrc::RegimeConfluence,
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
            "--override-stop-pct" => {
                override_stop_pct = Some(need!("--override-stop-pct").parse()?)
            }
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
            "--funding-max-long" => funding_max_long = Some(need!("--funding-max-long").parse()?),
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
            "--max-days" => max_days = Some(need!("--max-days").parse()?),
            "--cross-asset-sym" => cross_asset_sym = Some(need!("--cross-asset-sym")),
            "--cross-asset-dir" => cross_asset_dir = Some(need!("--cross-asset-dir")),
            "--cross-asset-fast" => cross_asset_fast = Some(need!("--cross-asset-fast").parse()?),
            "--cross-asset-slow" => cross_asset_slow = Some(need!("--cross-asset-slow").parse()?),
            // 2026-05-14 (detector-41): boolean flag — presence enables inverse
            // correlation (DXY ↔ crypto). Defaults to false (direct-correlation).
            "--cross-asset-inverse" => cross_asset_inverse = true,
            "--override-adx-min" => adx_min = Some(need!("--override-adx-min").parse()?),
            "--override-adx-period" => adx_period = Some(need!("--override-adx-period").parse()?),
            "--override-chop-max" => chop_max = Some(need!("--override-chop-max").parse()?),
            "--override-chop-period" => {
                chop_period = Some(need!("--override-chop-period").parse()?)
            }
            "--override-rsi-long-max" => {
                rsi_long_max = Some(need!("--override-rsi-long-max").parse()?)
            }
            "--override-rsi-short-min" => {
                rsi_short_min = Some(need!("--override-rsi-short-min").parse()?)
            }
            "--override-rsi-period" => rsi_period = Some(need!("--override-rsi-period").parse()?),
            "--lscool-after" => lscool_after = Some(need!("--lscool-after").parse()?),
            "--lscool-bars" => lscool_bars = Some(need!("--lscool-bars").parse()?),
            "--trades-out" => trades_out = Some(PathBuf::from(need!("--trades-out"))),
            "--debug-window" => debug_window = Some(need!("--debug-window").parse()?),
            // R29-Audit-2026-05-12: --phantom-suppress flag removed.
            // Accepted as a no-op for one release so existing hunt scripts
            // don't error out; emit warning so callers update.
            "--phantom-suppress" => {
                eprintln!("[sweep] WARN: --phantom-suppress is removed and ignored (R29-Audit-2026-05-12)");
            }
            "--ml-model" => ml_model_path = Some(PathBuf::from(need!("--ml-model"))),
            "--ml-threshold" => ml_threshold = need!("--ml-threshold").parse()?,
            "--start-after-ts" => start_after_ts = Some(need!("--start-after-ts").parse()?),
            "--random-gate-keep" => {
                random_gate_keep = Some(need!("--random-gate-keep").parse()?);
            }
            "--random-gate-seed" => {
                random_gate_seed = need!("--random-gate-seed").parse()?;
            }
            "--timeframe" => timeframe = Some(need!("--timeframe")),
            "--also-fire-meanrev" => also_fire_meanrev = true,
            "--also-fire-breakout" => also_fire_breakout = true,
            "--use-htf-confirm" => use_htf_confirm = true,
            "--htf-stride" => htf_stride = need!("--htf-stride").parse()?,
            "--strict-pass" => strict_pass = true,
            "--regime-min-votes" => regime_min_votes = need!("--regime-min-votes").parse()?,
            "--regime-require-r28v6" => regime_require_r28v6 = true,
            "--regime-vol-confirm" => regime_use_vol_confirm = true,
            "--regime-vol-period" => regime_vol_period = need!("--regime-vol-period").parse()?,
            "--regime-vol-mult" => regime_vol_mult = need!("--regime-vol-mult").parse()?,
            "--regime-force-mr" => regime_force_mr = true,
            "--regime-vwap-trend" => regime_use_vwap_trend = true,
            "--regime-vwap-period" => regime_vwap_period = need!("--regime-vwap-period").parse()?,
            "--regime-vwap-min-dev" => {
                regime_vwap_min_dev = need!("--regime-vwap-min-dev").parse()?
            }
            // 2026-05-14 Detector #14 — Stop-Hunt Liquidity-Sweep voter flags.
            "--regime-stophunt" => regime_use_stop_hunt = true,
            "--regime-sh-lookback" => {
                regime_sh_lookback = need!("--regime-sh-lookback").parse()?
            }
            "--regime-sh-wick-pct" => {
                regime_sh_wick_pct = need!("--regime-sh-wick-pct").parse()?
            }
            "--regime-sh-close-strict" => regime_sh_close_strict = true,
            // 2026-05-14 Detector #1 — Bollinger-Band Z-score MR voter flags.
            "--regime-bb-z-mr" => regime_use_bb_z_mr = true,
            "--regime-bb-z-period" => {
                regime_bb_z_period = need!("--regime-bb-z-period").parse()?
            }
            "--regime-bb-z-mult" => {
                regime_bb_z_mult = need!("--regime-bb-z-mult").parse()?
            }
            "--regime-bb-z-threshold" => {
                regime_bb_z_threshold = need!("--regime-bb-z-threshold").parse()?
            }
            "--regime-bb-z-cooldown" => {
                regime_bb_z_cooldown = need!("--regime-bb-z-cooldown").parse()?
            }
            // 2026-05-14 Detector #2 — Order-Flow-Imbalance Persistent Cluster.
            // `--also-fire-ofi-persistent` runs OFI as an additive entry source
            // alongside the primary R28V6 detector; `--regime-use-ofi` enrolls
            // it as the 8th voter in regime-confluence.
            "--also-fire-ofi-persistent" => also_fire_ofi_persistent = true,
            "--regime-use-ofi" => regime_use_ofi = true,
            "--ofi-window" => ofi_window = need!("--ofi-window").parse()?,
            "--ofi-threshold" => ofi_threshold = need!("--ofi-threshold").parse()?,
            "--ofi-sma" => ofi_sma = need!("--ofi-sma").parse()?,
            "--ofi-cooldown" => ofi_cooldown = need!("--ofi-cooldown").parse()?,
            // 2026-05-14 Phase-2 voter flags
            "--regime-use-cmf" => regime_use_cmf = true,
            "--regime-use-rsi-hidden-div" => regime_use_rsi_hidden_div = true,
            // 2026-05-14 Phase-3 voter flags
            "--regime-use-ad-line" => regime_use_ad_line = true,
            "--regime-use-aroon" => regime_use_aroon = true,
            "--regime-use-double-top" => regime_use_double_top = true,
            "--regime-use-smc-fvg" => regime_use_smc_fvg = true,
            "--regime-use-supertrend" => regime_use_supertrend = true,
            "--regime-use-kalman-trend" => regime_use_kalman_trend = true,
            // 2026-05-14 macro / cross-market voter toggles. Series loaders
            // are pending; until then these flags enable the voter machinery
            // but the helper abstains on missing series → zero votes
            // contributed. CLI surface is forward-compatible so a follow-up
            // loader patch immediately activates the voters.
            "--regime-use-cb-premium" => regime_use_cb_premium = true,
            "--regime-use-cme-basis" => regime_use_cme_basis = true,
            "--regime-use-hmm" => regime_use_hmm = true,
            "--regime-use-nupl" => regime_use_nupl = true,
            "--regime-use-top-trader-ls" => regime_use_top_trader_ls = true,
            "--regime-use-stablecoin" => regime_use_stablecoin = true,
            // Detector #20 — day-stage sizing CLI flags.
            "--ds-aggressive-until" => {
                ds_aggressive_until = Some(need!("--ds-aggressive-until").parse()?)
            }
            "--ds-aggressive-factor" => {
                ds_aggressive_factor = Some(need!("--ds-aggressive-factor").parse()?)
            }
            "--ds-neutral-until" => ds_neutral_until = Some(need!("--ds-neutral-until").parse()?),
            "--ds-neutral-factor" => {
                ds_neutral_factor = Some(need!("--ds-neutral-factor").parse()?)
            }
            "--ds-defensive-factor" => {
                ds_defensive_factor = Some(need!("--ds-defensive-factor").parse()?)
            }
            "--ds-progress-frac" => ds_progress_frac = Some(need!("--ds-progress-frac").parse()?),
            "--ds-progress-factor" => {
                ds_progress_factor = Some(need!("--ds-progress-factor").parse()?)
            }
            "--disable-day-stage" => disable_day_stage = true,
            // 2026-05-14 Detector #34 — Coinbase-Binance Premium voter flags.
            "--cb-premium-dir" => {
                cb_premium_dir = Some(PathBuf::from(need!("--cb-premium-dir")))
            }
            "--regime-cb-premium" => regime_use_cb_premium = true,
            "--cb-threshold-bps" => {
                cb_threshold_bps = need!("--cb-threshold-bps").parse()?
            }
            "--cb-consecutive" => {
                cb_consecutive_bars = need!("--cb-consecutive").parse()?
            }
            // Detector #13 — HTF MACD-histogram trend confluence gate.
            "--use-htf-macd-gate" => use_htf_macd_gate = true,
            "--htf-macd-fast" => htf_macd_fast = need!("--htf-macd-fast").parse()?,
            "--htf-macd-slow" => htf_macd_slow = need!("--htf-macd-slow").parse()?,
            "--htf-macd-signal" => htf_macd_signal = need!("--htf-macd-signal").parse()?,
            "--htf-macd-rising-lookback" => {
                htf_macd_rising_lookback = need!("--htf-macd-rising-lookback").parse()?
            }
            "--htf-macd-min-magnitude" => {
                htf_macd_min_magnitude = need!("--htf-macd-min-magnitude").parse()?
            }
            "--mr-period" => mr_period = Some(need!("--mr-period").parse()?),
            "--mr-oversold" => mr_oversold = Some(need!("--mr-oversold").parse()?),
            "--mr-overbought" => mr_overbought = Some(need!("--mr-overbought").parse()?),
            "--mr-cooldown" => mr_cooldown = Some(need!("--mr-cooldown").parse()?),
            "--mr-size-mult" => mr_size_mult = Some(need!("--mr-size-mult").parse()?),
            // 2026-05-14 Detector #18 — multi-level PTP exposure. Parser +
            // validator lives in `parse_ptp_levels` above. Setting this
            // clears `cfg.partial_take_profit` in `apply_overrides` so the
            // two PRE-cross branches in `exit.rs` cannot double-fire.
            "--ptp-levels" => {
                ptp_levels = Some(parse_ptp_levels(&need!("--ptp-levels"))?);
            }
            // 2026-05-14 Detector #11 Phase-1 — funding-cost sizing modifier.
            "--funding-sizing-alpha" => {
                funding_sizing_alpha = Some(need!("--funding-sizing-alpha").parse()?)
            }
            "--funding-sizing-window" => {
                funding_sizing_window = Some(need!("--funding-sizing-window").parse()?)
            }
            "--funding-sizing-min-factor" => {
                funding_sizing_min_factor = Some(need!("--funding-sizing-min-factor").parse()?)
            }
            other => return Err(anyhow!("unknown arg: {other}")),
        }
    }
    if windows == 0 {
        return Err(anyhow!("--windows must be ≥ 1"));
    }
    // R29-Audit-Round3 2026-05-12 (Bug-1 fix): when --ml-model is set the
    // user MUST supply an explicit threshold. Anything ≤ 0 silently disables
    // the gate (P(win) ≥ 0 is always true) which has been the source of
    // multiple "ML gate appears loaded but never drops a trade" debug
    // sessions. Default to 0.5 with a loud warning when omitted entirely
    // (NaN sentinel); reject ≤ 0 outright as an explicit user error.
    if ml_model_path.is_some() {
        if ml_threshold.is_nan() {
            eprintln!(
                "[ml-gate] WARNING: --ml-model supplied without --ml-threshold; \
                 defaulting to 0.5. Pass `--ml-threshold N` explicitly to silence."
            );
            ml_threshold = 0.5;
        } else if ml_threshold <= 0.0 {
            return Err(anyhow!(
                "--ml-threshold {} ≤ 0 would silently disable the ML gate; \
                 use a positive value (e.g. 0.5) or omit --ml-model entirely",
                ml_threshold
            ));
        }
    } else if !ml_threshold.is_nan() {
        // Threshold without model is harmless but most likely a typo.
        eprintln!("[ml-gate] note: --ml-threshold set but no --ml-model — ignoring");
    }
    // R29-Audit-Round3 2026-05-12 (Bug-5 fix): ML model was trained on 30m
    // candles. We *do* TF-scale lookback periods in `ml_features_for_signal`,
    // but the slopes / RSI / ATR series themselves are recomputed at runtime
    // with the same TF-scaled periods — that's not equivalent to running the
    // 30m model on a 30m feed. Until we add explicit per-TF training, fail
    // loudly when someone tries `--ml-model X --timeframe 5m`.
    if ml_model_path.is_some() {
        let tf = timeframe.as_deref().unwrap_or("30m");
        if tf != "30m" {
            return Err(anyhow!(
                "ML inference only supported on 30m (--timeframe={tf}); \
                 retrain a TF-native model before inferring on other TFs"
            ));
        }
    }

    if let Some(t) = threads {
        // 2026-05-13 Codex Round 7 #B10 FIX: reject --threads 0. Rayon
        // interprets 0 as "all logical CPUs" — surprising semantic when a
        // hunt loop computes threads from another arg and produces 0.
        if t == 0 {
            anyhow::bail!("--threads must be > 0 (got 0; rayon would silently use all CPUs)");
        }
        // .ok() previously swallowed double-init failures; surface them.
        if let Err(e) = rayon::ThreadPoolBuilder::new().num_threads(t).build_global() {
            eprintln!("[sweep] WARN: rayon thread-pool init failed: {e}");
        }
    }

    // 2026-05-13 Codex Round 7 #B8 FIX: hard-error when single-asset path
    // (--candles) is combined with flags that ONLY work via --candles-dir
    // + --symbols multi-asset orchestration. Previously silently ignored.
    // Done BEFORE the CfgOverrides struct literal so we can still read the
    // option-values by reference.
    if candles_path.is_some() {
        let mut unsupported: Vec<&str> = Vec::new();
        if strict_pass {
            unsupported.push("--strict-pass");
        }
        if ml_model_path.is_some() {
            unsupported.push("--ml-model");
        }
        if random_gate_keep.is_some() {
            unsupported.push("--random-gate-keep");
        }
        if use_htf_confirm {
            unsupported.push("--use-htf-confirm");
        }
        if cross_asset_sym.is_some() {
            unsupported.push("--cross-asset-sym");
        }
        if also_fire_meanrev {
            unsupported.push("--also-fire-meanrev");
        }
        if also_fire_breakout {
            unsupported.push("--also-fire-breakout");
        }
        if also_fire_ofi_persistent {
            unsupported.push("--also-fire-ofi-persistent");
        }
        if regime_use_vol_confirm
            || regime_use_vwap_trend
            || regime_use_stop_hunt
            || regime_use_bb_z_mr
            || regime_use_ofi
            || regime_force_mr
            || adx_min.is_some()
            || chop_max.is_some()
            || rsi_long_max.is_some()
            || rsi_short_min.is_some()
        {
            unsupported.push("--regime-* / --override-adx-* / --override-chop-* / --override-rsi-*");
        }
        if !unsupported.is_empty() {
            anyhow::bail!(
                "single-asset path (--candles) does not honor: {}. Use --candles-dir + --symbols instead.",
                unsupported.join(", "),
            );
        }
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
        max_days,
        cross_asset_sym,
        cross_asset_dir,
        cross_asset_fast,
        cross_asset_slow,
        cross_asset_inverse,
        lscool_after,
        lscool_bars,
        ptp_levels,
        ds_aggressive_until,
        ds_aggressive_factor,
        ds_neutral_until,
        ds_neutral_factor,
        ds_defensive_factor,
        ds_progress_frac,
        ds_progress_factor,
        disable_day_stage,
        funding_sizing_alpha,
        funding_sizing_window,
        funding_sizing_min_factor,
    };

    if candles_dir.is_some() || symbols_arg.is_some() {
        return run_multi_asset(
            candles_dir,
            funding_dir,
            cb_premium_dir,
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
            timeframe.clone(),
            MultiSignalCfg {
                also_meanrev: also_fire_meanrev,
                also_breakout: also_fire_breakout,
                mr_period,
                mr_oversold,
                mr_overbought,
                mr_cooldown,
                mr_size_mult,
                r28v6_adx_min: adx_min,
                r28v6_adx_period: adx_period,
                r28v6_chop_max: chop_max,
                r28v6_chop_period: chop_period,
                r28v6_rsi_long_max: rsi_long_max,
                r28v6_rsi_short_min: rsi_short_min,
                r28v6_rsi_period: rsi_period,
                use_htf_confirm,
                htf_stride,
                regime_min_votes,
                regime_require_r28v6,
                regime_use_vol_confirm,
                regime_vol_period,
                regime_vol_mult,
                regime_force_mr,
                strict_pass,
                regime_use_vwap_trend,
                regime_vwap_period,
                regime_vwap_min_dev,
                regime_use_stop_hunt,
                regime_sh_lookback,
                regime_sh_wick_pct,
                regime_sh_close_strict,
                regime_use_bb_z_mr,
                regime_bb_z_period,
                regime_bb_z_mult,
                regime_bb_z_threshold,
                regime_bb_z_cooldown,
                // Build-fix: OFI voter fields default off — not exposed as
                // CLI flags in this Detector #20 patch.
                also_fire_ofi_persistent,
                regime_use_ofi,
                ofi_window,
                ofi_threshold,
                ofi_sma,
                ofi_cooldown,
                regime_use_cmf,
                regime_use_rsi_hidden_div,
                regime_use_ad_line,
                regime_use_aroon,
                regime_use_double_top,
                regime_use_smc_fvg,
                regime_use_supertrend,
                regime_use_kalman_trend,
                regime_use_cb_premium,
                regime_use_cme_basis,
                regime_use_hmm,
                regime_use_nupl,
                regime_use_top_trader_ls,
                regime_use_stablecoin,
                // 2026-05-14 Detector #34 — CB-premium voter init.
                cb_threshold_bps,
                cb_consecutive_bars,
                // 2026-05-14 Detector #13 — HTF MACD-histogram gate.
                use_htf_macd_gate,
                htf_macd_fast,
                htf_macd_slow,
                htf_macd_signal,
                htf_macd_rising_lookback,
                htf_macd_min_magnitude,
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
        Some(s) => {
            templates::template_by_selector(s).ok_or_else(|| anyhow!("unknown selector: {s}"))?
        }
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
                    SignalSrc::None | SignalSrc::PerAssetCfg | SignalSrc::RegimeConfluence => {
                        vec![]
                    }
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
                            cb_premium_series: None,
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
                        funding_by_source: None,
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
            if !last_passed && state.stopped_reason.is_none() {
                let target_hit = state.first_target_hit_day.is_some()
                    && state.trading_days.len() >= cfg.min_trading_days as usize;
                let final_equity_floor = 1.0 + cfg.profit_target * 0.5;
                let give_back_too_far =
                    target_hit && state.equity.is_finite() && state.equity < final_equity_floor;
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
        SignalSrc::RegimeConfluence => "regime",
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
    cb_premium_dir: Option<PathBuf>,
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
    timeframe: Option<String>,
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
    let selector = config_selector.ok_or_else(|| {
        anyhow!("--config is required (e.g. r28_v6_cvd, r28_v6_volimb, r28_v6_poc)")
    })?;
    let mut cfg = templates::template_by_selector(&selector)
        .ok_or_else(|| anyhow!("unknown selector: {selector}"))?;
    // R29-PassrateHunt: apply CLI overrides post-template.
    apply_overrides(&mut cfg, overrides)?;

    // R29-Hunt-Audit 2026-05-12 (CRITICAL fix): restrict alignment to the
    // ACTIVE source-symbol set after --drop-symbols / --keep-symbols pruning
    // of `cfg.assets`. Previously `align_open_times` intersected ALL files
    // listed in --symbols, which silently clipped history to the
    // shortest-history asset even when that asset was dropped from
    // cfg.assets. Concrete example: champion sweep passes `--symbols
    // ETH..,...ARBUSDT,...` with `--drop-symbols ARBUSDT` — ARB had only
    // 2.4y data (first bar 2023-03-23) vs BTC/ETH 5.5y (2020-08), so the
    // common-intersection window collapsed by ~3 years even though no ARB
    // signal would ever be evaluated. That artificially inflated the
    // per-asset stride density on the remaining basket (more 2023+ recency-
    // bias) and reduced effective backtest sample.
    //
    // Fix: derive the active source set from cfg.assets AFTER overrides.
    // Keep `symbols` for legacy CLI compatibility but only load + align
    // the ones cfg.assets actually trades. Symbols passed via --symbols
    // that aren't in cfg.assets are silently skipped (matches the existing
    // `feed.get(&source) → None → continue` semantic in run_one_window).
    let active_sources: std::collections::HashSet<String> = cfg
        .assets
        .iter()
        .map(|a| {
            a.source_symbol
                .clone()
                .unwrap_or_else(|| a.symbol.replace("-TREND", "USDT"))
        })
        .collect();
    let symbols: Vec<String> = symbols
        .into_iter()
        .filter(|s| active_sources.contains(s))
        .collect();
    if symbols.is_empty() {
        return Err(anyhow!(
            "post-override symbol set is empty (cfg.assets vs --symbols intersection); \
             check --drop-symbols / --keep-symbols vs --symbols"
        ));
    }

    // Load candles per symbol.
    let mut candles_by_sym: HashMap<String, Vec<Candle>> = HashMap::new();
    for sym in &symbols {
        let p = locate_candle_file_tf(&dir, sym, timeframe.as_deref())?;
        let candles = loader::load_candles(&p)?;
        candles_by_sym.insert(sym.clone(), candles);
    }

    // 2026-05-13 Codex Round 7 #B17 FIX: warn on duplicate openTimes
    // (silent dedup hides corrupt cache files).
    for (sym, cs) in candles_by_sym.iter() {
        let mut seen: std::collections::HashSet<i64> =
            std::collections::HashSet::with_capacity(cs.len());
        let mut dupes = 0usize;
        for c in cs.iter() {
            if !seen.insert(c.open_time) {
                dupes += 1;
            }
        }
        if dupes > 0 {
            eprintln!(
                "[sweep] WARN: {sym} has {dupes} duplicate openTime entries — \
                 silently using last-seen close. Cache file may be corrupt."
            );
        }
    }

    // Align by openTime intersection. Build a sorted vector of bar-times
    // present in EVERY symbol — those are our common bars.
    let aligned_times = align_open_times(&candles_by_sym);
    if aligned_times.is_empty() {
        return Err(anyhow!("no overlapping openTimes across symbols"));
    }

    // 2026-05-13 Codex Round 7 #B16 FIX: assert observed bar-duration
    // matches cfg.bar_minutes. funding-cost bucket-indexing relies on this
    // invariant; a 5m cache loaded with a 30m cfg silently mis-bucketizes
    // funding by 6×.
    if aligned_times.len() >= 2 {
        let observed_ms = aligned_times[1] - aligned_times[0];
        let expected_ms = (cfg.bar_minutes as i64) * 60_000;
        if expected_ms > 0 && observed_ms != expected_ms {
            eprintln!(
                "[sweep] WARN: observed bar duration {observed_ms} ms ≠ cfg.bar_minutes \
                 {} ms ({} min). Funding-cost bucket indexing may mis-align.",
                expected_ms,
                cfg.bar_minutes,
            );
        }
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
    //
    // R29-R3.3: scale all bar-counted periods by `30 / bar_minutes` so a
    // model trained on 30m candles still sees the same wall-clock window
    // when run on 5m / 2h / 4h. (Wraps `_mlTrainingDataGen.ts:170` which is
    // 30m-native.) The ML model file itself is timeframe-agnostic; the
    // feature pipeline does the scaling at runtime.
    let ml_scale = (30.0 / (cfg.bar_minutes.max(1) as f64)).round().max(1.0) as usize;
    // R29-Audit-Round3 2026-05-12 (Bug-5 hardening): mirror the CLI-arg
    // guard with a runtime assertion against cfg.bar_minutes. The CLI block
    // catches `--timeframe=5m`, this catches a config whose `bar_minutes`
    // disagrees with the user-supplied `--timeframe` (e.g. r28v6_5m loaded
    // with no --timeframe flag → cfg.bar_minutes=5).
    if multi_signal.ml_model.is_some() {
        assert_eq!(
            cfg.bar_minutes, 30,
            "ML inference only supported on 30m; cfg.bar_minutes={} — \
             train a new model for that TF or run sweep without --ml-model",
            cfg.bar_minutes
        );
    }
    let ml_features_by_sym: HashMap<String, MlFeatureSeries> = if multi_signal.ml_model.is_some() {
        use ftmo_engine_core::detector_filters::adx as adx_fn;
        use ftmo_engine_core::indicators::{atr as atr_fn, rsi as rsi_fn, sma as sma_fn};
        let mut map = HashMap::new();
        for (sym, cs) in aligned.iter() {
            let closes: Vec<f64> = cs.iter().map(|c| c.close).collect();
            map.insert(
                sym.clone(),
                MlFeatureSeries {
                    rsi14: rsi_fn(&closes, 14 * ml_scale),
                    rsi28: rsi_fn(&closes, 28 * ml_scale),
                    adx14: adx_fn(cs, 14 * ml_scale),
                    atr14: atr_fn(cs, 14 * ml_scale),
                    sma20: sma_fn(&closes, 20 * ml_scale),
                    sma50: sma_fn(&closes, 50 * ml_scale),
                    sma200: sma_fn(&closes, 200 * ml_scale),
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

    // 2026-05-14 Detector #22 — load DefiLlama USDT-supply macro feed once and
    // forward-fill it onto each symbol's candle timeline. Single global feed
    // reused across the basket. Missing file → all symbols get `vec![None; n]`.
    let stablecoin_by_sym: HashMap<String, Vec<Option<f64>>> = match &funding_dir {
        Some(fd) => {
            let pts = loader::load_stablecoin_supply(fd).unwrap_or(None);
            let mut map = HashMap::new();
            for sym in symbols.iter() {
                let candles_for_sym = aligned.get(sym).expect("aligned missing sym");
                let series = match &pts {
                    Some(p) => loader::align_stablecoin_supply(candles_for_sym, p),
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

    // 2026-05-14 Detector #34 — load + forward-fill Coinbase-Binance Premium
    // series per symbol, aligned 1:1 onto the candle openTime sequence.
    // Missing files become `vec![None; n]` so the voter sees "no data →
    // abstain" semantics (matches funding-rate convention).
    let cb_premium_by_sym: HashMap<String, Vec<Option<f64>>> = match &cb_premium_dir {
        Some(pd) => {
            let mut map = HashMap::new();
            for sym in symbols.iter() {
                let candles_for_sym = aligned.get(sym).expect("aligned missing sym");
                let pts = loader::load_cb_premium(pd, sym)?;
                let series = match pts {
                    Some(p) => loader::align_cb_premium(candles_for_sym, &p),
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
        "ftmo-sweep (multi-asset): {} symbols × {} bars; cfg={}; {} threads; funding={}; cb_premium={}",
        symbols.len(),
        total_bars,
        cfg.label,
        rayon::current_num_threads(),
        if funding_dir.is_some() { "yes" } else { "no" },
        if cb_premium_dir.is_some() { "yes" } else { "no" },
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
    // R29-Audit-2026-05-10: bars_per_day was hardcoded to 48 (30m). For 5m
    // it's 288, for 1h 24, for 2h 12, for 4h 6. Derive from --timeframe
    // flag; default 30m to preserve back-compat.
    let bars_per_day: usize = match timeframe.as_deref() {
        Some("5m") => 288,
        Some("15m") => 96,
        Some("30m") | None => 48,
        Some("1h") => 24,
        Some("2h") => 12,
        Some("4h") => 6,
        Some(other) => return Err(anyhow!("unknown --timeframe: {other}")),
    };
    let win_plans: Vec<(usize, usize)> = if let Some(sd) = step_days {
        let stride = (sd as usize) * bars_per_day;
        let max_w_bars = cfg.max_days as usize * bars_per_day;
        (0..windows)
            .map(|w| {
                let lo = WIN_PLAN_WARMUP + w * stride;
                let hi = (lo + max_w_bars).min(total_bars);
                (lo, hi)
            })
            // R29-Audit-Round3.1: TS shard rejects windows where
            // `start + winBars > minBars` (strict). Earlier Rust filter
            // `hi > lo + bars_per_day` accepted truncated 1-day stub
            // windows that TS never sees, deflating pass-rate. Match TS
            // by requiring the FULL `max_w_bars` window length. Guard
            // against the `lo > hi` underflow that bit windows where the
            // requested `--windows` exceeds available capacity.
            .filter(|(lo, hi)| *hi >= *lo + max_w_bars)
            .collect()
    } else {
        let win_size = total_bars / windows.max(1);
        (0..windows)
            .map(|w| {
                let lo = w * win_size;
                let hi = if w == windows - 1 {
                    total_bars
                } else {
                    (w + 1) * win_size
                };
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
    // 2026-05-13 Codex Round 7 #B9 FIX: warn loudly when window-plan
    // construction drops everything (cache too short for requested
    // --max-days + --step-days, or --start-after-ts cuts past the cache).
    // Without this, output reads `passed=0 / 0 (NaN%)` — looks identical
    // to "all windows failed" and the unsatisfiable-request reason is
    // hidden.
    if actual_windows == 0 && windows > 0 {
        eprintln!(
            "[sweep] WARN: --windows {windows} requested but ZERO survived planning. \
             Likely causes: (a) cache too short for max_days × bars_per_day, \
             (b) --start-after-ts cuts past the cache end, \
             (c) step_days × windows exceeds cache range."
        );
    } else if actual_windows < (windows / 2).max(1) && windows > 0 {
        eprintln!(
            "[sweep] WARN: only {actual_windows}/{windows} windows survived planning. \
             Check --max-days / --start-after-ts vs cache extent."
        );
    }

    let writer: Arc<Mutex<Option<BufWriter<File>>>> = Arc::new(Mutex::new(match &out_path {
        Some(p) => Some(BufWriter::new(File::create(p)?)),
        None => None,
    }));
    let trades_writer: Arc<Mutex<Option<BufWriter<File>>>> =
        Arc::new(Mutex::new(match &trades_out {
            Some(p) => Some(BufWriter::new(File::create(p)?)),
            None => None,
        }));

    let cfg = Arc::new(cfg);
    let aligned = Arc::new(aligned);
    let atr_by_sym = Arc::new(atr_by_sym);
    let funding_by_sym = Arc::new(funding_by_sym);
    let stablecoin_by_sym = Arc::new(stablecoin_by_sym);
    let cb_premium_by_sym = Arc::new(cb_premium_by_sym);
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
                stablecoin_by_sym.as_ref(),
                cb_premium_by_sym.as_ref(),
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

#[allow(dead_code)]
fn locate_candle_file(dir: &Path, symbol: &str) -> Result<PathBuf> {
    locate_candle_file_tf(dir, symbol, None)
}

fn locate_candle_file_tf(dir: &Path, symbol: &str, timeframe: Option<&str>) -> Result<PathBuf> {
    // R29-Audit-2026-05-10: timeframe-aware candle lookup. With --timeframe,
    // use the matching `_<tf>.json` and ERROR if missing — earlier code
    // would silently fall back to 30m which produced silent timeframe
    // mixing on configs that were tuned for one TF but ran on another.
    let preferred: &[&str] = match timeframe {
        Some("5m") => &["_5m.json"],
        Some("15m") => &["_15m.json"],
        Some("30m") => &["_30m.json"],
        Some("1h") => &["_1h.json"],
        Some("2h") => &["_2h.json"],
        Some("4h") => &["_4h.json"],
        _ => &["_30m.json", "_1h.json", "_2h.json", "_4h.json", "_15m.json"],
    };
    for ext in preferred {
        let p = dir.join(format!("{symbol}{ext}"));
        if p.exists() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no candle file for symbol {symbol} (tf={:?}) in {}",
        timeframe,
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
    let intersection: std::collections::BTreeSet<i64> = sets.iter().fold(first, |acc, s| &acc & s);
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
    stablecoin_by_sym: &HashMap<String, Vec<Option<f64>>>,
    cb_premium_by_sym: &HashMap<String, Vec<Option<f64>>>,
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
    // 2026-05-14 Detector #22 — per-symbol growing stablecoin-supply feed,
    // parallel to funding_feed. Each bar appends `stablecoin_by_sym[sym][i]`.
    let mut stablecoin_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    // 2026-05-14 Detector #34 — per-symbol Coinbase-Binance Premium growing
    // feed. Mirrors `funding_feed` shape exactly so the slice consumed by
    // `R28V6Inputs.cb_premium_series` matches the candle-feed length at
    // every poll. Empty / None-only entries are safe (the voter abstains).
    let mut cb_premium_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    // 2026-05-13 65%-hunt: per-symbol HTF closes (every `htf_stride`-th
    // primary close). Only populated when `multi_signal.use_htf_confirm`.
    let mut htf_closes_buf: HashMap<String, Vec<f64>> = HashMap::new();
    for sym in symbols.iter() {
        feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
        atr_feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
        funding_feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
        stablecoin_feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
        cb_premium_feed.insert(sym.clone(), Vec::with_capacity(hi - lo));
        if multi_signal.use_htf_confirm {
            htf_closes_buf.insert(
                sym.clone(),
                Vec::with_capacity((hi - lo) / multi_signal.htf_stride + 8),
            );
        }
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
    //
    // R29-R3.6: the global `default_to_r28v6` (all-or-nothing) gate was
    // replaced by per-asset fallback so a single cvd/volimb/poc asset no
    // longer disables the extra-detector pipelines for the whole basket.

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
            let sc = stablecoin_by_sym
                .get(sym)
                .and_then(|s| s.get(i).copied())
                .flatten();
            stablecoin_feed.get_mut(sym).unwrap().push(sc);
            // 2026-05-14 Detector #34 — keep CB-premium feed in lock-step
            // with funding_feed shape. None entries are safe (voter abstains).
            let cb_p = cb_premium_by_sym
                .get(sym)
                .and_then(|s| s.get(i).copied())
                .flatten();
            cb_premium_feed.get_mut(sym).unwrap().push(cb_p);
            if multi_signal.use_htf_confirm && i % multi_signal.htf_stride == 0 {
                if let Some(buf) = htf_closes_buf.get_mut(sym) {
                    buf.push(c.close);
                }
            }
        }
    }

    // R29-Audit-2026-05-12: phantom-trade pre-pass REMOVED.
    //
    // The phantom-suppress feature attempted to mirror TS `detectAsset`'s
    // implicit "in-flight" trade cooldown by simulating a shadow strategy
    // across the warmup boundary. Direct R28_V6_PASSLOCK comparison showed
    // it **deflated** Rust pass-rate by ~23pp (Rust WITH=13.16% vs
    // Rust WITHOUT=34.21% vs TS V4-Sim=36.84% on step=14d). Root cause:
    // TS detectAsset is itself not bar-perfect (slice-from-zero re-detects
    // all warmup phantoms every call, so trade-exclusivity only filters
    // the LAST detected trade chain), so any stateful mirror in Rust will
    // diverge in one direction or the other. The feature was default-OFF,
    // therefore removal carries no silent-misuse risk. The `--phantom-suppress`
    // CLI flag is preserved as a no-op (with deprecation warning) so existing
    // hunt scripts keep working.
    let phantom_open_until: HashMap<(String, ftmo_engine_core::position::PositionSide), usize> =
        HashMap::new();
    // Helper retained: still consumed by extra-detector branches
    // (`also_meanrev` / `also_breakout`) to decide whether the asset falls
    // through to the R28V6 default pipeline.
    let asset_uses_r28v6_fallback = |a: &ftmo_engine_core::config::AssetConfig| -> bool {
        match signals_mode {
            SignalSrc::R28V6 => true,
            SignalSrc::PerAssetCfg => {
                a.cvd_entry.is_none()
                    && a.vol_imbalance_entry.is_none()
                    && a.vol_poc_entry.is_none()
            }
            _ => false,
        }
    };

    for i in lo..hi {
        // Push current bar for every symbol. `feed` MUST contain bar i so
        // `step_bar` can apply exits against the just-arrived candle; detectors
        // that read it use `candles.len()-1` as the entry bar and rely on
        // their own trigger_idx = i-1 convention to avoid lookahead.
        //
        // 2026-05-13 Codex HIGH FIX (Fix 4): the HTF-close buffer must NOT
        // include bar i's close at detector-time — the filter calls .last()
        // on it. Push is deferred to the END of the loop iter so detectors
        // for bar i only see HTF closes up to bar i-1 (TS V4 parity:
        // `htfCloses` series in ts-source is built from CLOSED bars only).
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
            let sc = stablecoin_by_sym
                .get(sym)
                .and_then(|s| s.get(i).copied())
                .flatten();
            stablecoin_feed.get_mut(sym).unwrap().push(sc);
            // 2026-05-14 Detector #34 — keep CB-premium feed in lock-step.
            let cb_p = cb_premium_by_sym
                .get(sym)
                .and_then(|s| s.get(i).copied())
                .flatten();
            cb_premium_feed.get_mut(sym).unwrap().push(cb_p);
        }

        // Build signals: one detector pass per asset entry, dispatched off
        // its config field set when in PerAssetCfg mode.
        let mut signals_for_bar: Vec<PollSignal> = Vec::new();

        // 2026-05-13 Hebel 2: build cross-asset closes (e.g. BTCUSDT) once
        // per bar, then re-use for every asset's detector call below. Only
        // built when cfg.cross_asset_filter is set (CLI flag activated).
        //
        // 2026-05-13 Codex HIGH FIX (Fix 4): cross_closes EXCLUDES bar i so
        // the EMA-cross trend filter (which calls .last() on this slice) is
        // computed only on closed bars. Without this skip, signal-time
        // direction-test sees future bar-i close → lookahead. `v.len() - 1`
        // is safe because we always push to feed BEFORE building this slice;
        // saturating_sub keeps it well-defined on bar 0.
        let cross_closes_owned: Option<Vec<f64>> = cfg
            .cross_asset_filter
            .as_ref()
            .and_then(|f| feed.get(f.symbol.as_str()))
            .map(|v| {
                let end = v.len().saturating_sub(1);
                v.iter().take(end).map(|c| c.close).collect()
            });
        let cross_closes_slice: Option<&[f64]> = cross_closes_owned.as_deref();

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
                    } else {
                        // R29-Audit-Round3.7: per-asset fallback to R28V6
                        // default. Earlier `default_to_r28v6` was a global
                        // all-or-nothing: ONE asset with cvd_entry silenced
                        // ALL others. Now each asset that doesn't set an
                        // alt entry-type falls through individually.
                        let mut r28p = R28V6Params::default_for(asset, cfg);
                        apply_r28v6_param_overrides(&mut r28p, multi_signal);
                        let funding = funding_feed.get(&source).map(|v| v.as_slice());
                        // 2026-05-13 65%-hunt: enable dormant HTF-EMA stack
                        // confirmation. `htf_closes` was always None in the
                        // sweep path → `htf_trend_allows()` never ran. Build
                        // a same-source HTF series by downsampling primary
                        // 30m bars every 8 → 4h closes (htf_fast=9 / htf_slow=21
                        // = 9× & 21× 4h-bar EMAs).
                        let htf_buf = htf_closes_buf.get(&source).map(|v| v.as_slice());
                        let r28in = R28V6Inputs {
                            htf_closes: if multi_signal.use_htf_confirm {
                                htf_buf
                            } else {
                                None
                            },
                            cross_asset_closes: cross_closes_slice,
                            news_events: None,
                            funding_series: funding,
                            // 2026-05-14 Detector #34: CB-premium is wired to
                            // None on the per-asset primary R28V6 path. The
                            // voter is only consulted inside the regime-
                            // confluence panel where the slice is plumbed in
                            // via `cb_premium_feed`.
                            cb_premium_series: None,
                        };
                        detect_r28_v6(&mut state, cfg, asset, &source, arr, &r28p, &r28in)
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
                    let mut r28p = R28V6Params::default_for(asset, cfg);
                    apply_r28v6_param_overrides(&mut r28p, multi_signal);
                    let funding = funding_feed.get(&source).map(|v| v.as_slice());
                    let htf_buf = htf_closes_buf.get(&source).map(|v| v.as_slice());
                    let r28in = R28V6Inputs {
                        htf_closes: if multi_signal.use_htf_confirm {
                            htf_buf
                        } else {
                            None
                        },
                        cross_asset_closes: None,
                        news_events: None,
                        funding_series: funding,
                        cb_premium_series: None,
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
                SignalSrc::RegimeConfluence => {
                    let funding = funding_feed.get(&source).map(|v| v.as_slice());
                    let htf_buf = htf_closes_buf.get(&source).map(|v| v.as_slice());
                    // 2026-05-14 Detector #34 — wire growing CB-premium feed
                    // into the regime panel so `compute_cb_premium_vote` sees
                    // the per-asset slice matched to the current candle feed
                    // length. None when --regime-cb-premium isn't active or
                    // the symbol has no premium cache file (voter abstains).
                    let cb_premium = cb_premium_feed.get(&source).map(|v| v.as_slice());
                    let r28in = R28V6Inputs {
                        htf_closes: if multi_signal.use_htf_confirm {
                            htf_buf
                        } else {
                            None
                        },
                        cross_asset_closes: cross_closes_slice,
                        news_events: None,
                        funding_series: funding,
                        cb_premium_series: cb_premium,
                    };
                    let mr_override = if multi_signal.regime_force_mr {
                        Some(ftmo_engine_core::config::MeanReversionSource {
                            period: multi_signal.mr_period.unwrap_or(14),
                            oversold: multi_signal.mr_oversold.unwrap_or(25.0),
                            overbought: multi_signal.mr_overbought.unwrap_or(75.0),
                            cooldown_bars: multi_signal.mr_cooldown.unwrap_or(8),
                            size_mult: multi_signal.mr_size_mult.unwrap_or(0.5),
                        })
                    } else {
                        None
                    };
                    let rc_params =
                        ftmo_engine_core::signals_regime_confluence::RegimeConfluenceParams {
                            min_votes: multi_signal.regime_min_votes,
                            require_r28v6: multi_signal.regime_require_r28v6,
                            mr_source_override: mr_override,
                            use_vol_confirm: multi_signal.regime_use_vol_confirm,
                            vol_confirm_period: multi_signal.regime_vol_period,
                            vol_confirm_mult: multi_signal.regime_vol_mult,
                            // 2026-05-13 Audit Round 2 — propagate R28V6 secondary
                            // gate flags into REGIME mode so they don't silently
                            // no-op.
                            r28v6_adx_min: multi_signal.r28v6_adx_min,
                            r28v6_adx_period: multi_signal.r28v6_adx_period,
                            r28v6_chop_max: multi_signal.r28v6_chop_max,
                            r28v6_chop_period: multi_signal.r28v6_chop_period,
                            r28v6_rsi_long_max: multi_signal.r28v6_rsi_long_max,
                            r28v6_rsi_short_min: multi_signal.r28v6_rsi_short_min,
                            r28v6_rsi_period: multi_signal.r28v6_rsi_period,
                            use_vwap_trend: multi_signal.regime_use_vwap_trend,
                            vwap_period: multi_signal.regime_vwap_period,
                            vwap_min_dev_pct: multi_signal.regime_vwap_min_dev,
                            use_stop_hunt: multi_signal.regime_use_stop_hunt,
                            stop_hunt_lookback: multi_signal.regime_sh_lookback,
                            stop_hunt_wick_pct: multi_signal.regime_sh_wick_pct,
                            stop_hunt_close_strict: multi_signal.regime_sh_close_strict,
                            use_bb_z_mr: multi_signal.regime_use_bb_z_mr,
                            bb_z_params: ftmo_engine_core::signals_bb_zscore_mr::BollingerZScoreSource {
                                bb_period: multi_signal.regime_bb_z_period,
                                bb_mult: multi_signal.regime_bb_z_mult,
                                z_threshold: multi_signal.regime_bb_z_threshold,
                                cooldown_bars: multi_signal.regime_bb_z_cooldown,
                                ..ftmo_engine_core::signals_bb_zscore_mr::BollingerZScoreSource::default()
                            },
                            // 2026-05-14 Detector #2 — wire CLI-supplied OFI knobs
                            // through to the regime voter. Keep the rest of the
                            // `OfiPersistentParams` defaults so the user only
                            // overrides what they explicitly passed.
                            use_ofi: multi_signal.regime_use_ofi,
                            ofi_params: ftmo_engine_core::signals_ofi::OfiPersistentParams {
                                window_bars: multi_signal.ofi_window,
                                delta_threshold: multi_signal.ofi_threshold,
                                sma_period: multi_signal.ofi_sma,
                                cooldown_bars: multi_signal.ofi_cooldown,
                                ..ftmo_engine_core::signals_ofi::OfiPersistentParams::default_30m_crypto()
                            },
                            use_cmf: multi_signal.regime_use_cmf,
                            cmf_params: ftmo_engine_core::signals_cmf::CmfParams::default_30m_crypto(),
                            use_cme_basis: multi_signal.regime_use_cme_basis,
                            cme_basis_params: ftmo_engine_core::signals_cme_basis::CmeBasisParams::default(),
                            use_hmm_regime: multi_signal.regime_use_hmm,
                            hmm_regime_params: ftmo_engine_core::signals_hmm_regime::HmmRegimeParams::default(),
                            use_nupl: multi_signal.regime_use_nupl,
                            nupl_params: ftmo_engine_core::signals_nupl::NuplParams::default(),
                            use_rsi_hidden_div: multi_signal.regime_use_rsi_hidden_div,
                            rsi_hidden_div_params: ftmo_engine_core::signals_rsi_hidden_div::RsiHiddenDivParams::default(),
                            use_top_trader_ls: multi_signal.regime_use_top_trader_ls,
                            top_trader_ls_params: ftmo_engine_core::signals_top_trader_ls::TopTraderLsParams::default(),
                            // 2026-05-14 Phase-3 voters — default-off; CLI flags wired below in a follow-up.
                            use_ad_line: multi_signal.regime_use_ad_line,
                            ad_line_params: ftmo_engine_core::signals_ad_line::AdLineTrendParams::default_30m_crypto(),
                            use_aroon: multi_signal.regime_use_aroon,
                            aroon_params: ftmo_engine_core::signals_aroon::AroonParams::default_30m_crypto(),
                            use_double_top: multi_signal.regime_use_double_top,
                            double_top_params: ftmo_engine_core::signals_double_top::DoubleTopParams::default(),
                            use_smc_fvg: multi_signal.regime_use_smc_fvg,
                            smc_fvg_params: ftmo_engine_core::signals_smc_fvg::FvgParams::default_30m_crypto(),
                            use_supertrend: multi_signal.regime_use_supertrend,
                            supertrend_params: ftmo_engine_core::signals_supertrend::SupertrendParams::default_30m_crypto(),
                            use_kalman_trend: multi_signal.regime_use_kalman_trend,
                            kalman_trend_params: ftmo_engine_core::signals_kalman_trend::KalmanTrendParams::default_30m_crypto(),
                            // 2026-05-14 — newly-wired macro / cross-market voters.
                            //
                            // Activation status per voter:
                            //   --regime-use-hmm       ACTIVE (HMM falls back to
                            //                          `HmmModel::default_btc_30m()`
                            //                          when hmm_model is None, so
                            //                          the voter fires immediately
                            //                          on any backtest).
                            //   --regime-use-cb-premium     INERT until a per-bar
                            //   --regime-use-cme-basis        cb_premium / cme_basis
                            //   --regime-use-top-trader-ls   / top-trader-LS /
                            //   --regime-use-nupl             nupl-samples /
                            //   --regime-use-stablecoin       stablecoin supply
                            //                          series is fed via
                            //                          `RegimeConfluenceInputs`.
                            //                          Loader-side helpers exist
                            //                          for stablecoin
                            //                          (`loader::load_stablecoin_
                            //                          supply`) but are not yet
                            //                          wired into the sweep loop.
                            //                          CLI flag accepts the
                            //                          toggle so future loader
                            //                          patches activate the
                            //                          voter without re-touching
                            //                          this surface.
                            // 2026-05-14 Detector #34 — CB-premium voter wired
                            // through CLI flags (threshold_bps, consecutive_bars).
                            // `cb_premium_series` is plumbed via `R28V6Inputs`
                            // / `RegimeConfluenceInputs` on the side that owns
                            // the per-asset loaded data.
                            use_cb_premium: multi_signal.regime_use_cb_premium,
                            cb_premium_params:
                                ftmo_engine_core::signals_cb_premium::CbPremiumParams {
                                    threshold_bps: multi_signal.cb_threshold_bps,
                                    consecutive_bars: multi_signal.cb_consecutive_bars,
                                    ..ftmo_engine_core::signals_cb_premium::CbPremiumParams::default_30m_crypto()
                                },
                            use_stablecoin_flow: multi_signal.regime_use_stablecoin,
                            stablecoin_flow_params: ftmo_engine_core::signals_stablecoin_flow::StablecoinFlowParams::default_30m_crypto(),
                            hmm_model: None,
                            nupl_samples: None,
                            // 2026-05-14 Detector #13 — forward HTF MACD-hist
                            // params so the same CLI flags activate the gate
                            // inside REGIME mode AND on standalone-R28V6.
                            htf_macd_enabled: multi_signal.use_htf_macd_gate,
                            htf_macd_fast: multi_signal.htf_macd_fast,
                            htf_macd_slow: multi_signal.htf_macd_slow,
                            htf_macd_signal: multi_signal.htf_macd_signal,
                            htf_macd_rising_lookback: multi_signal.htf_macd_rising_lookback,
                            htf_macd_min_magnitude: multi_signal.htf_macd_min_magnitude,
                        };
                    let stablecoin_slice =
                        stablecoin_feed.get(&source).map(|v| v.as_slice());
                    let cb_premium_slice =
                        cb_premium_feed.get(&source).map(|v| v.as_slice());
                    let regime_inputs =
                        ftmo_engine_core::signals_regime_confluence::RegimeConfluenceInputs {
                            stablecoin_supply_series: stablecoin_slice,
                            cb_premium_series: cb_premium_slice,
                            ..ftmo_engine_core::signals_regime_confluence::RegimeConfluenceInputs::default()
                        };
                    ftmo_engine_core::signals_regime_confluence::detect_regime_confluence(
                        &mut state,
                        cfg,
                        asset,
                        &source,
                        arr,
                        &rc_params,
                        &r28in,
                        &regime_inputs,
                    )
                }
                SignalSrc::None => None,
            };
            // R29-R3.7: post-detection gate chain (phantom-suppress +
            // random-gate + ML-gate). Earlier this lived inline in the
            // primary detector branch only; CVD/VOLIMB/POC went through the
            // same primary branch but the also_meanrev / also_breakout
            // extra-detector branches below bypassed both random- and ML-
            // gates. Extracted into a single helper so every signal path
            // applies the same gates.
            let push_with_gates = |s: ftmo_engine_core::signal::PollSignal,
                                   signals_for_bar: &mut Vec<
                ftmo_engine_core::signal::PollSignal,
            >| {
                let key = (s.symbol.clone(), s.direction);
                if let Some(&exit_bar) = phantom_open_until.get(&key) {
                    if i < exit_bar {
                        return;
                    }
                }
                if let Some(keep) = multi_signal.random_gate_keep {
                    let mut h = std::hash::DefaultHasher::new();
                    use std::hash::{Hash, Hasher};
                    multi_signal.random_gate_seed.hash(&mut h);
                    s.entry_time.hash(&mut h);
                    s.symbol.hash(&mut h);
                    let v = (h.finish() & 0xffff_ffff) as f64 / (1u64 << 32) as f64;
                    if v >= keep {
                        return;
                    }
                }
                if let Some(model) = multi_signal.ml_model.as_ref() {
                    if let Some(series) = ml_features_by_sym.get(&source) {
                        // R29-Audit-Round3 2026-05-12 (Bug-2 fix): prefer
                        // the trainer's asset_id_map over position-in-
                        // `cfg.assets`. With --drop-symbols / --keep-
                        // symbols the runtime cfg has fewer assets than
                        // training saw, so position-based ids shift and
                        // the model evaluates against the WRONG asset id
                        // feature — silently degrading P(win). Falls
                        // back to position when the model lacks the map
                        // (legacy models pre-schema-v1 are rejected at
                        // load time, so this branch only fires for new
                        // models with an empty map, i.e. trainer didn't
                        // see any assets).
                        let asset_idx = model
                            .asset_id_for(&s.symbol)
                            .or_else(|| model.asset_id_for(&source))
                            .unwrap_or_else(|| {
                                cfg.assets
                                    .iter()
                                    .position(|a| a.symbol == s.symbol)
                                    .unwrap_or(0)
                            });
                        let direction_long =
                            matches!(s.direction, ftmo_engine_core::position::PositionSide::Long);
                        // R29-R2.5: read forward-filled funding at bar
                        // i-1 (last fully closed bar). Aligned with
                        // training-time `findFundingAt(candles[i].openTime)`
                        // in `_mlTrainingDataGen.ts`.
                        //
                        // R29-Audit-Round1 2026-05-12 BUG FIX: previously
                        // read from `funding_feed` (the GROWING per-bar
                        // feed slice that only contains entries pushed so
                        // far). `funding_feed.get(i-1)` indexes by GLOBAL
                        // bar number but the feed only has `i - warmup_lo
                        // + 1` entries → for any `warmup_lo > 0` the
                        // lookup either reads the WRONG bar (when i-1 <
                        // feed.len()) or returns None (out-of-bounds).
                        // The full pre-aligned `funding_by_sym` is
                        // globally indexed (same as `series.closes`) and
                        // therefore the correct source.
                        let funding_idx = i.saturating_sub(1);
                        let funding_at = funding_by_sym
                            .get(&source)
                            .and_then(|s| s.get(funding_idx).copied())
                            .flatten();
                        let feats = ml_features_for_signal(
                            series,
                            i,
                            asset_idx,
                            direction_long,
                            s.entry_time,
                            cfg.bar_minutes,
                            funding_at,
                        );
                        // R29-Audit-Round3 2026-05-12 (Bug-4 fix):
                        // `None` = warmup window (sma200 not ready), the
                        // trainer skipped these bars too. Mirror that
                        // by neither dropping nor double-counting: keep
                        // the signal (gate pass-through) since training
                        // never produced a label here.
                        if let Some(feats) = feats {
                            let p_win = model.predict_proba(&feats);
                            if p_win < multi_signal.ml_threshold {
                                return;
                            }
                        }
                    }
                }
                signals_for_bar.push(s);
            };

            if let Some(s) = sig {
                push_with_gates(s, &mut signals_for_bar);
            }

            // R29-Stage-B: extra detectors fired in PARALLEL when
            // requested. Each emits at most one signal per asset per bar;
            // multi-detector means trend + mean-rev (or breakout) signals
            // can both reach the harness for the same asset on the same
            // bar. The harness's per-asset+direction trade-exclusivity
            // gate (commit 50194dc) ensures only one position opens.
            // 2026-05-13 Codex Round 7 #B11 FIX: drop the PerAssetCfg gate.
            // The extras should fire when the asset's primary path is
            // R28V6-style (asset_uses_r28v6_fallback), regardless of the
            // outer signals_mode. Previously --signals r28v6 --also-fire-meanrev
            // silently no-op'd because signals_mode != PerAssetCfg.
            if multi_signal.also_meanrev && asset_uses_r28v6_fallback(asset) {
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
                    push_with_gates(s, &mut signals_for_bar);
                }
            }
            // 2026-05-13 Codex Round 7 #B11 FIX: mirror of also_meanrev gate fix.
            if multi_signal.also_breakout && asset_uses_r28v6_fallback(asset) {
                let arr = match feed.get(&source) {
                    Some(v) => v,
                    None => continue,
                };
                let bp = BreakoutParams::from_cfg(cfg, asset);
                if let Some(s) = detect_breakout(&mut state, cfg, asset, &source, arr, &bp) {
                    push_with_gates(s, &mut signals_for_bar);
                }
            }
            // 2026-05-14 Detector #2 — additive OFI persistent-cluster. Mirrors
            // the `also_fire_breakout` wiring. Same `push_with_gates` pipeline
            // (phantom-suppress + random-gate + ML-gate) applies.
            if multi_signal.also_fire_ofi_persistent && asset_uses_r28v6_fallback(asset) {
                let arr = match feed.get(&source) {
                    Some(v) => v,
                    None => continue,
                };
                let ofi_p = ftmo_engine_core::signals_ofi::OfiPersistentParams {
                    window_bars: multi_signal.ofi_window,
                    delta_threshold: multi_signal.ofi_threshold,
                    sma_period: multi_signal.ofi_sma,
                    cooldown_bars: multi_signal.ofi_cooldown,
                    ..ftmo_engine_core::signals_ofi::OfiPersistentParams::default_30m_crypto()
                };
                if let Some(s) = ftmo_engine_core::signals_ofi::detect_ofi_persistent(
                    &mut state, cfg, asset, &source, arr, &ofi_p,
                ) {
                    push_with_gates(s, &mut signals_for_bar);
                }
            }
        }

        let r = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feed,
                atr_series_by_source: &atr_feed,
                // 2026-05-13 Phase 2: feed funding series into harness so
                // apply_exits can deduct funding-cost over 8h settlement
                // boundaries crossed during the trade lifetime. Closes the
                // CLAUDE.md-documented "Rust gap" (perp-crypto funding
                // payments were filtered but never charged against PnL).
                funding_by_source: Some(&funding_feed),
                signals: signals_for_bar,
            },
            cfg,
        );
        bars += 1;
        // 2026-05-13 Codex HIGH FIX (Fix 4): HTF push deferred to AFTER
        // step_bar so the NEXT bar's detector pass sees this bar's close
        // (now closed and safe). Pushing BEFORE detector at the same i
        // would make bar i's close visible via htf_closes_buf.last() →
        // lookahead through htf_trend_allows.
        if multi_signal.use_htf_confirm && i % multi_signal.htf_stride == 0 {
            for sym in symbols.iter() {
                let c = aligned.get(sym).expect("aligned missing sym")[i];
                if let Some(buf) = htf_closes_buf.get_mut(sym) {
                    buf.push(c.close);
                }
            }
        }
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
    //
    // 2026-05-13 Audit Round 3 (bug-frei 80% audit): strict_pass disables
    // the "give-back half" soft rule below — only equity >= 1+target at
    // window-end counts as pass. On Champion C2 (pt=0.04) this drops
    // 80.04% → 73.25% (31 soft passes / 456 windows). For honest FTMO
    // backtests use --strict-pass.
    if !last_passed && state.stopped_reason.is_none() && !multi_signal.strict_pass {
        let target_hit = state.first_target_hit_day.is_some()
            && state.trading_days.len() >= cfg.min_trading_days as usize;
        let final_equity_floor = 1.0 + cfg.profit_target * 0.5;
        let give_back_too_far =
            target_hit && state.equity.is_finite() && state.equity < final_equity_floor;
        if target_hit && !give_back_too_far {
            last_passed = true;
        }
    } else if multi_signal.strict_pass
        && !last_passed
        && state.stopped_reason.is_none()
        && state.equity >= 1.0 + cfg.profit_target
        && state.mtm_equity >= 1.0 + cfg.profit_target
        && state.trading_days.len() >= cfg.min_trading_days as usize
    {
        // Strict path: final equity AND mtm_equity must both be ≥ 1+target
        // AND min_trading_days satisfied. No give-back tolerance.
        //
        // 2026-05-13 Bug-Audit Round 3 — BUG #6 FIX: previously only equity
        // was checked, but the R29-R4.3 parity gate in harness.rs L485-487
        // requires BOTH equity AND mtm_equity ≥ target. The strict-pass tail
        // mirrors that parity requirement now (also matches TS V4 sim tail
        // gate which checks both).
        last_passed = true;
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
