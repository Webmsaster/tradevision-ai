//! Config templates indexed by `FTMO_TF` selector. Mirrors the
//! `FTMO_TF → cfg` mapping in `src/utils/ftmoLiveSignalV231.ts`.
//!
//! Only the most-used live configs are included (R28_V6_PASSLOCK, R28_V6,
//! V5_TITANIUM, V5_AMBER, V5_TOPAZ, V5_QUARTZ_LITE, V5_PLATINUM). The full
//! 30+ config matrix is replicated by passing a JSON/serde-encoded
//! `EngineConfig` directly via `serde_json::from_str`.
//!
//! Per-asset numeric overrides (tp_pct, stop_pct, risk_frac) are NOT here —
//! the canonical source-of-truth is `ftmoDaytrade24h.ts`. These templates
//! provide reasonable defaults shared across the V5_QUARTZ family; if a
//! caller needs bit-precise per-asset numbers they should load JSON.

use crate::config::{
    AssetConfig, BreakEven, ChandelierExit, CorrelationFilter, EngineConfig, LiveCaps,
    LossStreakCooldown, PartialTakeProfit, PeakDrawdownThrottle, PeakTrailingStop, TrailingStop,
};

const R28_V6_BASKET: &[&str] = &[
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "ETC-TREND",
    "XRP-TREND",
    "AAVE-TREND",
];

/// V5_TITANIUM 14-asset basket. Source: TS V5_TITANIUM derives from
/// V5_PLATINUM_30M which inherits the V5_DIAMOND asset list (V5_PRO + INJ
/// + RUNE + ETC + SAND). V5_PRO = V5_HIWIN minus LINK + AAVE + XRP, and
/// V5_HIWIN = V5 (9 assets ETH/BTC/BNB/ADA/DOGE/AVAX/LTC/BCH/LINK).
/// Final: 14 assets, no SOL, no LINK.
///
/// Pre-2026-05-09 fix the Rust port had SOL+LINK in this basket — wrong by
/// 2 assets. After the fix the per-asset TPs also align with the actual
/// 30m tune (e.g. AAVE=0.06, INJ=0.055, AVAX=0.04, XRP=0.04, ETC=0.035,
/// RUNE=0.03, all others 0.025).
const V5_TITANIUM_BASKET: &[&str] = &[
    "ETH-TREND",
    "BTC-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "DOGE-TREND",
    "AVAX-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "AAVE-TREND",
    "XRP-TREND",
    "INJ-TREND",
    "RUNE-TREND",
    "ETC-TREND",
    "SAND-TREND",
];

/// V5_OBSIDIAN basket = V5_TITANIUM + ARB (15 assets).
const V5_OBSIDIAN_BASKET: &[&str] = &[
    "ETH-TREND",
    "BTC-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "DOGE-TREND",
    "AVAX-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "AAVE-TREND",
    "XRP-TREND",
    "INJ-TREND",
    "RUNE-TREND",
    "ETC-TREND",
    "SAND-TREND",
    "ARB-TREND",
];

/// Build per-asset configs for the V5_TREND family. Every TREND asset in
/// `ftmoDaytrade24h.ts` (V1 root, lines 6491-6604, propagated through
/// V2→V3→V4→V5→QUARTZ→QUARTZ_LITE→R28_V4→R28_V6) carries the same fixed
/// per-asset stack:
///
///   costBp=30, slippageBp=8, swapBpPerDay=4
///   triggerBars=1, invertDirection=true, disableShort=true
///   stopPct=0.05, tpPct=0.07 (overridden later by R28_V6 multipliers)
///
/// Pre-2026-05-09 the Rust port set `invert_direction=false` and left
/// costs at None, which made the engine reproduce the *wrong* strategy
/// (pullback-recovery, no fees) and was the dominant source of the
/// PASSLOCK Rust=0% / TS=44.85% gap diagnosed in the R29 drift audit.
fn make_assets(symbols: &[&str], risk_frac: f64) -> Vec<AssetConfig> {
    symbols
        .iter()
        .map(|s| AssetConfig {
            symbol: (*s).to_string(),
            source_symbol: Some(s.replace("-TREND", "USDT")),
            tp_pct: None, // inherit from cfg / overrides applied by callers
            stop_pct: None,
            risk_frac,
            activate_after_day: None,
            min_equity_gain: None,
            max_equity_gain: None,
            hold_bars: None,
            invert_direction: true,
            disable_short: true,
            trigger_bars: Some(1),
            cost_bp: Some(30.0),
            slippage_bp: Some(8.0),
            swap_bp_per_day: Some(4.0),
            cvd_entry: None,
            vol_imbalance_entry: None,
            vol_poc_entry: None,
            max_funding_for_long: None,
            min_funding_for_short: None,
        })
        .collect()
}

/// Per-asset tp_pct overrides for the R28_V6 family (from
/// `ftmoDaytrade24h.ts:R28_V6` PTP-design comment, 2026-05-03):
///
///   BTC/BNB/ADA/BCH/ETC : 0.00825   (small-TP cohort, PTP inert)
///   ETH                : 0.011
///   AAVE               : 0.01375    (mid-TP, PTP fires)
///   XRP                : 0.0165
///   LTC                : 0.01925    (large-TP, PTP fires)
fn r28_v6_tp_for(symbol: &str) -> f64 {
    match symbol {
        "BTC-TREND" | "BNB-TREND" | "ADA-TREND" | "BCH-TREND" | "ETC-TREND" => 0.00825,
        "ETH-TREND" => 0.011,
        "AAVE-TREND" => 0.01375,
        "XRP-TREND" => 0.0165,
        "LTC-TREND" => 0.01925,
        _ => 0.022, // safe default for V5_TITANIUM expansion assets
    }
}

/// Apply R28_V6 per-asset tp_pct + stop_pct overrides to a config's asset list.
/// stop_pct=0.05 is the V5_QUARTZ baseline (matches `ftmoDaytrade24h.ts`
/// per-asset definitions). atrStop may widen further; live_caps clamp at 0.05.
fn apply_r28_v6_per_asset(cfg: &mut EngineConfig) {
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(r28_v6_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
    }
}

/// Per-asset tp_pct for V5_TITANIUM (ftmoDaytrade24h.ts:7180-7197). Phase O
/// greedy single-axis TP sweep on V5_PLATINUM_30M's 14-asset basket. These
/// are the *30m-native-tuned* TPs — they are LARGER than the R28_V6 small-TP
/// cohort numbers (×0.55 of V5_QUARTZ) the previous Rust port used.
///
///   ETH/BTC/BNB/ADA/DOGE/LTC/BCH/SAND : 0.025
///   RUNE                              : 0.030
///   ETC                               : 0.035
///   AVAX/XRP                          : 0.040
///   INJ                               : 0.055
///   AAVE                              : 0.060
///
/// Pre-2026-05-09 the Rust port called `apply_r28_v6_per_asset` on V5_TITANIUM
/// which forced ALL assets onto the R28_V6 small-TP scale (BTC=0.00825, ETH=0.011,
/// etc.). This was the dominant source of the V5_AMBER −17pp Rust drift after
/// Phase 1+2.
fn v5_titanium_tp_for(symbol: &str) -> f64 {
    match symbol {
        "ETH-TREND" | "BTC-TREND" | "BNB-TREND" | "ADA-TREND" | "DOGE-TREND" | "LTC-TREND"
        | "BCH-TREND" | "SAND-TREND" => 0.025,
        "RUNE-TREND" => 0.030,
        "ETC-TREND" => 0.035,
        "AVAX-TREND" | "XRP-TREND" => 0.040,
        "INJ-TREND" => 0.055,
        "AAVE-TREND" => 0.060,
        _ => 0.025, // safe default for OBSIDIAN expansion (ARB inherits 0.025)
    }
}

/// Per-asset tp_pct for V5_AMBER (ftmoDaytrade24h.ts:7345-7370). Phase T
/// per-asset TP greedy on V5_ZIRKON, optimised for step=1d pass-rate.
///
///   ETH                               : 0.025
///   BTC/BNB/ADA/AVAX/BCH/ETC/SAND/ARB : 0.020
///   AAVE                              : 0.030
///   RUNE                              : 0.025
///   XRP                               : 0.035
///   DOGE/LTC                          : 0.040
///   INJ                               : 0.050
///
/// V5_AMBER is V5_ZIRKON-shape (15 assets incl. ARB, mct=10,
/// allowedHoursUtc=[4,6,8,10,14,18,20,22], NO atrStop/chandelier/breakEven).
fn v5_amber_tp_for(symbol: &str) -> f64 {
    match symbol {
        "ETH-TREND" => 0.025,
        "DOGE-TREND" | "LTC-TREND" => 0.040,
        "AAVE-TREND" => 0.030,
        "RUNE-TREND" => 0.025,
        "XRP-TREND" => 0.035,
        "INJ-TREND" => 0.050,
        // BTC, BNB, ADA, AVAX, BCH, ETC, SAND, ARB → 0.020
        _ => 0.020,
    }
}

/// Per-asset tp_pct for V5_TOPAZ (ftmoDaytrade24h.ts:7453-7459). V5_TOPAZ =
/// V5_QUARTZ minus RUNE. V5_QUARTZ = V5_AMBER tp -0.005 floor 0.015 + atrStop
/// p56m2 + chandelier p56m2 + breakEven 3% + allowedHours drop hr 20.
///
///   ETH                                              : 0.020
///   BTC/BNB/ADA/AVAX/BCH/ETC/SAND/ARB                : 0.015
///   AAVE                                             : 0.025
///   XRP                                              : 0.030
///   DOGE/LTC                                         : 0.035
///   INJ                                              : 0.045
///   (RUNE dropped from basket)
fn v5_topaz_tp_for(symbol: &str) -> f64 {
    match symbol {
        "ETH-TREND" => 0.020,
        "DOGE-TREND" | "LTC-TREND" => 0.035,
        "AAVE-TREND" => 0.025,
        "XRP-TREND" => 0.030,
        "INJ-TREND" => 0.045,
        // BTC, BNB, ADA, AVAX, BCH, ETC, SAND, ARB → 0.015
        _ => 0.015,
    }
}

/// Base R28_V4 config (parent of R28_V6 / PASSLOCK chain). Mirrors
/// `FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4` in
/// `src/utils/ftmoDaytrade24h.ts:8201-8208` plus the engine stack
/// inherited from V5_QUARTZ (atrStop p56m2 + chandelier p56m2 + breakEven 3%
/// + hours [4,6,8,10,14,18,22]).
///
/// Pre-2026-05-09 the Rust template inherited from the V13_LIVEFIRST_30M
/// config (loss_streak_cooldown(2,200) + kelly_sizing + max_concurrent=10),
/// none of which exist in the actual TS R28_V6/PASSLOCK chain. Result: a
/// big chunk of TS-allowed entries were silently throttled in Rust.
/// daily_peak_trailing_stop was also wrong (0.02 vs TS R28_V4's 0.012).
fn quartz_lite_base() -> EngineConfig {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.assets = make_assets(R28_V6_BASKET, 0.4);
    cfg.tp_pct = 0.04;
    cfg.stop_pct = 0.02;
    cfg.leverage = 2.0;
    // V1 root + per-asset holdBars=240 (40h on 2h, 120h on 30m). V4-Sim
    // disables time-exit anyway; this only matters as a fallback ceiling.
    cfg.hold_bars = 240;
    cfg.live_caps = Some(LiveCaps { max_stop_pct: 0.05, max_risk_frac: 0.4 });
    cfg.atr_stop = Some(crate::config::AtrStop { period: 56, stop_mult: 2.0 });
    cfg.chandelier_exit = Some(ChandelierExit { period: 56, mult: 2.0, min_move_r: Some(0.5) });
    cfg.break_even = Some(BreakEven { threshold: 0.03 });
    // R28_V4 override: triggerPct 0.02, closeFraction 0.7. R28_V6 keeps the
    // same shape but lifts trigger to 0.012; that override happens in
    // `r28_v6_passlock()` / `r28_v6()` below.
    cfg.partial_take_profit = Some(PartialTakeProfit { trigger_pct: 0.02, close_fraction: 0.7 });
    // R28_V4 override: 0.012 (not the V5_QUARTZ_LITE 0.02). −40% trail
    // distance — much earlier give-back lock.
    cfg.daily_peak_trailing_stop = Some(PeakTrailingStop { trail_distance: 0.012 });
    // R28_V4 → R28_V6 inherits this throttle: scale risk DOWN to 15% when
    // equity drops 3% below all-time peak.
    cfg.peak_drawdown_throttle = Some(PeakDrawdownThrottle { from_peak: 0.03, factor: 0.15 });
    // V5_ZIRKON (TS line 7293) overrides maxConcurrentTrades=10 — propagates
    // through V5_AMBER → V5_QUARTZ → V5_QUARTZ_LITE → R28_V4 → R28_V6 →
    // PASSLOCK. Earlier value (6) was V1 root, but the chain bumps it.
    cfg.max_concurrent_trades = Some(10);
    cfg.allowed_hours_utc = Some(vec![4, 6, 8, 10, 14, 18, 22]);
    cfg.pause_at_target_reached = true;
    // V3-inherited trailingStop {activatePct: 3%, trailPct: 0.5%}. None of V4,
    // V5, V5_QUARTZ, V5_QUARTZ_LITE, R28_V4 or R28_V6 override it. Closes the
    // -8.78pp Rust↔TS drift on R28_V6_PASSLOCK observed post-Phase-3.
    cfg.trailing_stop = Some(TrailingStop { activate_pct: 0.03, trail_pct: 0.005 });
    cfg
}

/// R28_V6_PASSLOCK (R60 champion). Adds `closeAllOnTargetReached` to lock
/// realised gains the moment realised equity hits target. Per-asset
/// tp_pct overrides applied (×0.55 of V5_QUARTZ baseline — see
/// `r28_v6_tp_for`). PTP triggerPct=0.012 so small-TP assets go full-TP
/// while large-TP assets partial-close at the cushion threshold.
pub fn r28_v6_passlock() -> EngineConfig {
    let mut cfg = quartz_lite_base();
    cfg.label = "R28_V6_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    apply_r28_v6_per_asset(&mut cfg);
    // R28_V6 PTP: triggerPct=0.012, closeFraction=0.7 (per audit-trail comment).
    cfg.partial_take_profit = Some(crate::config::PartialTakeProfit {
        trigger_pct: 0.012,
        close_fraction: 0.7,
    });
    cfg
}

/// R28_V6 baseline (without PASSLOCK).
pub fn r28_v6() -> EngineConfig {
    let mut cfg = quartz_lite_base();
    cfg.label = "R28_V6".into();
    cfg.close_all_on_target_reached = false;
    apply_r28_v6_per_asset(&mut cfg);
    cfg.partial_take_profit = Some(crate::config::PartialTakeProfit {
        trigger_pct: 0.012,
        close_fraction: 0.7,
    });
    cfg
}

/// V5_TITANIUM family base. UNLIKE `quartz_lite_base()` this does NOT bring
/// the V5_QUARTZ engine stack (no atrStop, no chandelier, no breakEven, no
/// PTP, no peak-DD throttle, no daily-peak-trailing-stop). The TS V5_TITANIUM
/// inherits straight from V5_PLATINUM_30M which is just V5_PRO + per-asset TP
/// + 30m TF — pure plain-vanilla V3 trailing-stop strategy.
///
///   maxConcurrentTrades = 6
///   allowedHoursUtc     = [2, 4, 6, 8, 10, 12, 14, 18, 20, 22]
///   liveCaps            = {maxStopPct: 0.05, maxRiskFrac: 0.4}
///   pauseAtTargetReached= true
///
/// V5_AMBER overrides hours+mct (10 + reduced hour-list); V5_TOPAZ goes back
/// to the QUARTZ engine stack and rides on `quartz_lite_base()`.
fn v5_titanium_base() -> EngineConfig {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.tp_pct = 0.04;
    cfg.stop_pct = 0.05;
    cfg.leverage = 2.0;
    cfg.hold_bars = 240;
    cfg.live_caps = Some(LiveCaps { max_stop_pct: 0.05, max_risk_frac: 0.4 });
    // No atrStop / chandelier / breakEven / PTP / peakDD / dailyPeakTrail.
    cfg.atr_stop = None;
    cfg.chandelier_exit = None;
    cfg.break_even = None;
    cfg.partial_take_profit = None;
    cfg.partial_take_profit_levels = None;
    cfg.peak_drawdown_throttle = None;
    cfg.daily_peak_trailing_stop = None;
    cfg.max_concurrent_trades = Some(6);
    cfg.allowed_hours_utc = Some(vec![2, 4, 6, 8, 10, 12, 14, 18, 20, 22]);
    cfg.pause_at_target_reached = true;
    cfg.close_all_on_target_reached = false;
    // V3-inherited trailingStop {activatePct: 3%, trailPct: 0.5%}. Same chain
    // V4 → V5 → V5_PRO → V5_GOLD → V5_DIAMOND → V5_PLATINUM → V5_PLATINUM_30M
    // → V5_TITANIUM (none override). Closes the -15.21pp drift on V5_AMBER and
    // -24pp on V5_TOPAZ.
    cfg.trailing_stop = Some(TrailingStop { activate_pct: 0.03, trail_pct: 0.005 });
    cfg
}

/// V5_TITANIUM — 14-asset wider basket, longer-history validated.
/// Uses 30m-native per-asset TPs (NOT the R28_V6 ×0.55 multipliers).
pub fn v5_titanium() -> EngineConfig {
    let mut cfg = v5_titanium_base();
    cfg.label = "V5_TITANIUM".into();
    cfg.assets = make_assets(V5_TITANIUM_BASKET, 0.4);
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(v5_titanium_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
    }
    cfg
}

/// V5_AMBER — V5_ZIRKON + Phase T per-asset TP retune. 15 assets (TITANIUM +
/// ARB), mct=10, allowedHoursUtc=[4,6,8,10,14,18,20,22]. NO atrStop/chand/BE.
pub fn v5_amber() -> EngineConfig {
    let mut cfg = v5_titanium_base();
    cfg.label = "V5_AMBER".into();
    cfg.assets = make_assets(V5_OBSIDIAN_BASKET, 0.4); // 15 assets incl. ARB
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(v5_amber_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
    }
    cfg.max_concurrent_trades = Some(10);
    cfg.allowed_hours_utc = Some(vec![4, 6, 8, 10, 14, 18, 20, 22]);
    cfg
}

/// V5_TOPAZ — V5_QUARTZ minus RUNE (14 assets). Inherits the QUARTZ engine
/// stack (atrStop p56m2 + chandelier p56m2 + breakEven 3%, mct=10,
/// allowedHoursUtc=[4,6,8,10,14,18,22]).
pub fn v5_topaz() -> EngineConfig {
    let mut cfg = quartz_lite_base();
    cfg.label = "V5_TOPAZ".into();
    // V5_QUARTZ_LITE has the QUARTZ engine stack but adds R28-specific PTP +
    // peakDD throttle + dailyPeakTrail that V5_TOPAZ does NOT inherit (TOPAZ
    // is pure V5_QUARTZ - RUNE, no R28 overlays). Strip those.
    cfg.partial_take_profit = None;
    cfg.peak_drawdown_throttle = None;
    cfg.daily_peak_trailing_stop = None;
    // V5_QUARTZ basket = OBSIDIAN basket (15) → V5_TOPAZ drops RUNE → 14.
    let basket: Vec<&str> = V5_OBSIDIAN_BASKET
        .iter()
        .copied()
        .filter(|s| *s != "RUNE-TREND")
        .collect();
    cfg.assets = make_assets(&basket, 0.4);
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(v5_topaz_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
    }
    cfg.max_concurrent_trades = Some(10);
    cfg.allowed_hours_utc = Some(vec![4, 6, 8, 10, 14, 18, 22]);
    cfg.close_all_on_target_reached = false;
    cfg
}

// ─────────────────────────────────────────────────────────────────────
// R29 Round 10 — TITANIUM + PASSLOCK stacking variants. Mirrors
// `FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_*` in
// `src/utils/ftmoDaytrade24h.ts:8727-8808`. All inherit V5_TITANIUM-shape
// (14 assets, mct=6, allowedHoursUtc=[2,4,6,8,10,12,14,18,20,22],
// closeAllOnTargetReached=true) and stack a single additional gate.
// ─────────────────────────────────────────────────────────────────────

/// R29-R10 V5_TITANIUM + closeAllOnTargetReached (PASSLOCK semantics).
pub fn v5_titanium_passlock() -> EngineConfig {
    let mut cfg = v5_titanium();
    cfg.label = "V5_TITANIUM_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    cfg
}

/// R29-R10a V5_TITANIUM_PASSLOCK − RUNE (13 assets) — greedy ablation.
pub fn v5_titanium_passlock_norune() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_NORUNE".into();
    cfg.assets.retain(|a| a.symbol != "RUNE-TREND");
    cfg
}

/// R29-R10b V5_OBSIDIAN_PASSLOCK = TITANIUM + ARB + PASSLOCK (15 assets).
pub fn v5_obsidian_passlock() -> EngineConfig {
    let mut cfg = v5_titanium_base();
    cfg.label = "V5_OBSIDIAN_PASSLOCK".into();
    cfg.assets = make_assets(V5_OBSIDIAN_BASKET, 0.4);
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(v5_titanium_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
    }
    cfg.close_all_on_target_reached = true;
    cfg
}

/// R29-R10c V5_TITANIUM_PASSLOCK + lossStreakCooldown(afterLosses=1, cd=400).
pub fn v5_titanium_passlock_lscool_tight() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_LSCOOL_TIGHT".into();
    cfg.loss_streak_cooldown = Some(LossStreakCooldown {
        after_losses: 1,
        cooldown_bars: 400,
    });
    cfg
}

/// R29-R10d V5_TITANIUM_PASSLOCK + lossStreakCooldown(afterLosses=3, cd=96).
pub fn v5_titanium_passlock_lscool_loose() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_LSCOOL_LOOSE".into();
    cfg.loss_streak_cooldown = Some(LossStreakCooldown {
        after_losses: 3,
        cooldown_bars: 96,
    });
    cfg
}

/// R29-R10e V5_TITANIUM_PASSLOCK + maxConcurrentTrades=5 (vs default 6).
pub fn v5_titanium_passlock_mct5() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_MCT5".into();
    cfg.max_concurrent_trades = Some(5);
    cfg
}

/// R29-R10f V5_TITANIUM_PASSLOCK + correlationFilter maxOpenSameDirection=2.
pub fn v5_titanium_passlock_corrcap2() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_CORRCAP2".into();
    cfg.correlation_filter = Some(CorrelationFilter {
        max_open_same_direction: 2,
    });
    cfg
}

/// R29-R10g V5_TITANIUM_PASSLOCK + drop late hours: allowedHoursUtc=[4,6,8,10,14,18].
pub fn v5_titanium_passlock_todcut18() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_TODCUT18".into();
    cfg.allowed_hours_utc = Some(vec![4, 6, 8, 10, 14, 18]);
    cfg
}

// ─────────────────────────────────────────────────────────────────────
// R29 Round 5 — Order-Flow / Volume-Profile templates. Built on the
// R28_V6 + PASSLOCK base; only the per-asset entry trigger differs.
// Mirrors `FTMO_DAYTRADE_24H_R28_V6_{CVD,VOLIMB,POC}` in
// `src/utils/ftmoDaytrade24h.ts:8574-8649`.
// ─────────────────────────────────────────────────────────────────────

/// R29-R5 CVD divergence (24h lookback on 30m = 48 bars).
pub fn r28_v6_cvd_template() -> EngineConfig {
    let mut cfg = r28_v6_passlock();
    cfg.label = "R28_V6_CVD".into();
    for asset in cfg.assets.iter_mut() {
        asset.cvd_entry = Some(crate::config::CvdEntry { lookback_bars: 48 });
    }
    cfg
}

/// R29-R5 Volume-Imbalance: extreme buyer-aggressive bars (≥ 62% taker-buy).
pub fn r28_v6_volimb_template() -> EngineConfig {
    let mut cfg = r28_v6_passlock();
    cfg.label = "R28_V6_VOLIMB".into();
    for asset in cfg.assets.iter_mut() {
        asset.vol_imbalance_entry =
            Some(crate::config::VolImbalanceEntry { long_min: 0.62 });
    }
    cfg
}

/// R29-R5 Volume-Profile POC mean-reversion (48h window, 1.5% offset).
pub fn r28_v6_poc_template() -> EngineConfig {
    let mut cfg = r28_v6_passlock();
    cfg.label = "R28_V6_POC".into();
    for asset in cfg.assets.iter_mut() {
        asset.vol_poc_entry = Some(crate::config::VolPocEntry {
            window_bars: 96,
            min_dist_from_poc_pct: 0.015,
        });
    }
    cfg
}

// ─────────────────────────────────────────────────────────────────────
// R29 Round 7 — funding-rate-filter templates. Stack with PASSLOCK base.
// Mirrors `FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_{FRMED,FRLONG,FRMILD,FRSTRICT}`
// in `src/utils/ftmoDaytrade24h.ts:8696-8719`. R29-R7 result: PASSLOCK 44.85%
// → FRMED 47.06% (+2.21pp).
// ─────────────────────────────────────────────────────────────────────

/// R29-R7 PASSLOCK + funding (mild: skip longs >0.1%, shorts <-0.05%).
pub fn r28_v6_passlock_frmild_template() -> EngineConfig {
    let mut cfg = r28_v6_passlock();
    cfg.label = "R28_V6_PASSLOCK_FRMILD".into();
    cfg.funding_rate_filter = Some(crate::config::FundingRateFilter {
        max_funding_for_long: Some(0.001),
        min_funding_for_short: Some(-0.0005),
    });
    cfg
}

/// R29-R7 PASSLOCK + funding (medium: top/bottom 5%). +2.21pp vs PASSLOCK.
pub fn r28_v6_passlock_frmed_template() -> EngineConfig {
    let mut cfg = r28_v6_passlock();
    cfg.label = "R28_V6_PASSLOCK_FRMED".into();
    cfg.funding_rate_filter = Some(crate::config::FundingRateFilter {
        max_funding_for_long: Some(0.0005),
        min_funding_for_short: Some(-0.0003),
    });
    cfg
}

/// R29-R7 PASSLOCK + funding (strict: top 25%).
pub fn r28_v6_passlock_frstrict_template() -> EngineConfig {
    let mut cfg = r28_v6_passlock();
    cfg.label = "R28_V6_PASSLOCK_FRSTRICT".into();
    cfg.funding_rate_filter = Some(crate::config::FundingRateFilter {
        max_funding_for_long: Some(0.0003),
        min_funding_for_short: Some(-0.0002),
    });
    cfg
}

/// R29-R7 PASSLOCK + funding (long-only — neg-tail too rare to gate).
pub fn r28_v6_passlock_frlong_template() -> EngineConfig {
    let mut cfg = r28_v6_passlock();
    cfg.label = "R28_V6_PASSLOCK_FRLONG".into();
    cfg.funding_rate_filter = Some(crate::config::FundingRateFilter {
        max_funding_for_long: Some(0.0005),
        min_funding_for_short: None,
    });
    cfg
}

/// Resolve an `FTMO_TF` selector to an `EngineConfig` template. Returns
/// `None` for unknown selectors — caller should fall back to JSON config.
pub fn template_by_selector(selector: &str) -> Option<EngineConfig> {
    Some(match selector {
        "2h-trend-v5-r28-v6-passlock" | "2h-trend-v5-quartz-lite-r28-v6-passlock" => {
            r28_v6_passlock()
        }
        "2h-trend-v5-quartz-lite-r28-v6" | "2h-trend-v5-quartz-lite-r28-v6-v4engine" => r28_v6(),
        "2h-trend-v5-titanium" => v5_titanium(),
        "2h-trend-v5-amber" => v5_amber(),
        "2h-trend-v5-topaz" => v5_topaz(),
        "r28_v6_cvd" => r28_v6_cvd_template(),
        "r28_v6_volimb" => r28_v6_volimb_template(),
        "r28_v6_poc" => r28_v6_poc_template(),
        "r28_v6_passlock_frmild" => r28_v6_passlock_frmild_template(),
        "r28_v6_passlock_frmed" => r28_v6_passlock_frmed_template(),
        "r28_v6_passlock_frstrict" => r28_v6_passlock_frstrict_template(),
        "r28_v6_passlock_frlong" => r28_v6_passlock_frlong_template(),
        // R29-R10 stacking variants
        "2h-trend-v5-titanium-passlock" => v5_titanium_passlock(),
        "2h-trend-v5-titanium-passlock-norune" => v5_titanium_passlock_norune(),
        "2h-trend-v5-obsidian-passlock" => v5_obsidian_passlock(),
        "2h-trend-v5-titanium-passlock-lscool-tight" => v5_titanium_passlock_lscool_tight(),
        "2h-trend-v5-titanium-passlock-lscool-loose" => v5_titanium_passlock_lscool_loose(),
        "2h-trend-v5-titanium-passlock-mct5" => v5_titanium_passlock_mct5(),
        "2h-trend-v5-titanium-passlock-corrcap2" => v5_titanium_passlock_corrcap2(),
        "2h-trend-v5-titanium-passlock-todcut18" => v5_titanium_passlock_todcut18(),
        _ => return None,
    })
}

/// All known selectors — useful for self-test / CLI listings.
pub fn known_selectors() -> &'static [&'static str] {
    &[
        "2h-trend-v5-r28-v6-passlock",
        "2h-trend-v5-quartz-lite-r28-v6-passlock",
        "2h-trend-v5-quartz-lite-r28-v6",
        "2h-trend-v5-quartz-lite-r28-v6-v4engine",
        "2h-trend-v5-titanium",
        "2h-trend-v5-amber",
        "2h-trend-v5-topaz",
        "r28_v6_cvd",
        "r28_v6_volimb",
        "r28_v6_poc",
        "r28_v6_passlock_frmild",
        "r28_v6_passlock_frmed",
        "r28_v6_passlock_frstrict",
        "r28_v6_passlock_frlong",
        // R29-R10 stacking variants
        "2h-trend-v5-titanium-passlock",
        "2h-trend-v5-titanium-passlock-norune",
        "2h-trend-v5-obsidian-passlock",
        "2h-trend-v5-titanium-passlock-lscool-tight",
        "2h-trend-v5-titanium-passlock-lscool-loose",
        "2h-trend-v5-titanium-passlock-mct5",
        "2h-trend-v5-titanium-passlock-corrcap2",
        "2h-trend-v5-titanium-passlock-todcut18",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r28_v6_passlock_has_passlock_flag() {
        let cfg = r28_v6_passlock();
        assert!(cfg.close_all_on_target_reached);
        assert_eq!(cfg.assets.len(), 9);
    }

    #[test]
    fn v5_titanium_has_14_assets_and_no_quartz_stack() {
        let cfg = v5_titanium();
        assert_eq!(cfg.assets.len(), 14);
        assert!(!cfg.close_all_on_target_reached);
        // V5_TITANIUM should NOT inherit V5_QUARTZ engine stack — it inherits
        // from V5_PLATINUM_30M which is plain V5_PRO + 30m TF + per-asset TP.
        assert!(cfg.atr_stop.is_none(), "V5_TITANIUM must NOT have atrStop");
        assert!(
            cfg.chandelier_exit.is_none(),
            "V5_TITANIUM must NOT have chandelier"
        );
        assert!(
            cfg.break_even.is_none(),
            "V5_TITANIUM must NOT have breakEven"
        );
        assert!(
            cfg.partial_take_profit.is_none(),
            "V5_TITANIUM must NOT have PTP"
        );
        assert_eq!(cfg.max_concurrent_trades, Some(6));
        // SOL and LINK are NOT in V5_TITANIUM (TS basket = V5_DIAMOND).
        assert!(!cfg.assets.iter().any(|a| a.symbol == "SOL-TREND"));
        assert!(!cfg.assets.iter().any(|a| a.symbol == "LINK-TREND"));
        assert!(cfg.assets.iter().any(|a| a.symbol == "SAND-TREND"));
        assert!(cfg.assets.iter().any(|a| a.symbol == "INJ-TREND"));
    }

    #[test]
    fn v5_titanium_per_asset_tp_matches_ts() {
        let cfg = v5_titanium();
        let by_sym: std::collections::HashMap<&str, f64> = cfg
            .assets
            .iter()
            .map(|a| (a.symbol.as_str(), a.tp_pct.unwrap()))
            .collect();
        // Phase O greedy 30m tune
        assert!((by_sym["ETH-TREND"] - 0.025).abs() < 1e-9);
        assert!((by_sym["BTC-TREND"] - 0.025).abs() < 1e-9);
        assert!((by_sym["AAVE-TREND"] - 0.060).abs() < 1e-9);
        assert!((by_sym["INJ-TREND"] - 0.055).abs() < 1e-9);
        assert!((by_sym["AVAX-TREND"] - 0.040).abs() < 1e-9);
        assert!((by_sym["XRP-TREND"] - 0.040).abs() < 1e-9);
        assert!((by_sym["ETC-TREND"] - 0.035).abs() < 1e-9);
        assert!((by_sym["RUNE-TREND"] - 0.030).abs() < 1e-9);
        assert!((by_sym["SAND-TREND"] - 0.025).abs() < 1e-9);
    }

    #[test]
    fn v5_amber_has_15_assets_includes_arb() {
        let cfg = v5_amber();
        assert_eq!(cfg.assets.len(), 15, "V5_AMBER = OBSIDIAN basket (TITANIUM + ARB)");
        assert!(cfg.assets.iter().any(|a| a.symbol == "ARB-TREND"));
        assert!(cfg.assets.iter().any(|a| a.symbol == "RUNE-TREND"));
        assert_eq!(cfg.max_concurrent_trades, Some(10));
        assert_eq!(
            cfg.allowed_hours_utc.as_ref().unwrap(),
            &vec![4u32, 6, 8, 10, 14, 18, 20, 22]
        );
        // Same shape as TITANIUM: NO QUARTZ engine stack.
        assert!(cfg.atr_stop.is_none());
        assert!(cfg.chandelier_exit.is_none());
        assert!(cfg.break_even.is_none());
        assert!(cfg.partial_take_profit.is_none());
    }

    #[test]
    fn v5_amber_per_asset_tp_matches_ts() {
        let cfg = v5_amber();
        let by_sym: std::collections::HashMap<&str, f64> = cfg
            .assets
            .iter()
            .map(|a| (a.symbol.as_str(), a.tp_pct.unwrap()))
            .collect();
        // Phase T per-asset TP retune
        assert!((by_sym["ETH-TREND"] - 0.025).abs() < 1e-9);
        assert!((by_sym["BTC-TREND"] - 0.020).abs() < 1e-9);
        assert!((by_sym["DOGE-TREND"] - 0.040).abs() < 1e-9);
        assert!((by_sym["AVAX-TREND"] - 0.020).abs() < 1e-9);
        assert!((by_sym["LTC-TREND"] - 0.040).abs() < 1e-9);
        assert!((by_sym["AAVE-TREND"] - 0.030).abs() < 1e-9);
        assert!((by_sym["XRP-TREND"] - 0.035).abs() < 1e-9);
        assert!((by_sym["INJ-TREND"] - 0.050).abs() < 1e-9);
        assert!((by_sym["RUNE-TREND"] - 0.025).abs() < 1e-9);
        assert!((by_sym["ARB-TREND"] - 0.020).abs() < 1e-9);
    }

    #[test]
    fn v5_topaz_drops_rune_and_has_quartz_stack() {
        let cfg = v5_topaz();
        assert_eq!(cfg.assets.len(), 14, "TOPAZ = QUARTZ basket (15) - RUNE");
        assert!(!cfg.assets.iter().any(|a| a.symbol == "RUNE-TREND"));
        assert!(cfg.assets.iter().any(|a| a.symbol == "ARB-TREND"));
        assert!(cfg.atr_stop.is_some(), "V5_TOPAZ inherits QUARTZ engine stack");
        assert!(cfg.chandelier_exit.is_some());
        assert!(cfg.break_even.is_some());
        // tp -0.005 vs AMBER, floor 0.015
        let by_sym: std::collections::HashMap<&str, f64> = cfg
            .assets
            .iter()
            .map(|a| (a.symbol.as_str(), a.tp_pct.unwrap()))
            .collect();
        assert!((by_sym["ETH-TREND"] - 0.020).abs() < 1e-9);
        assert!((by_sym["BTC-TREND"] - 0.015).abs() < 1e-9);
        assert!((by_sym["INJ-TREND"] - 0.045).abs() < 1e-9);
        assert!((by_sym["AAVE-TREND"] - 0.025).abs() < 1e-9);
    }

    // ─── R29-R10 stacking variant tests ──────────────────────────────

    #[test]
    fn v5_titanium_passlock_has_passlock_flag() {
        let cfg = v5_titanium_passlock();
        assert!(cfg.close_all_on_target_reached);
        assert_eq!(cfg.assets.len(), 14);
        // Inherits TITANIUM shape (no QUARTZ stack).
        assert!(cfg.atr_stop.is_none());
        assert_eq!(cfg.max_concurrent_trades, Some(6));
    }

    #[test]
    fn v5_titanium_passlock_norune_drops_rune() {
        let cfg = v5_titanium_passlock_norune();
        assert!(cfg.close_all_on_target_reached);
        assert_eq!(cfg.assets.len(), 13);
        assert!(!cfg.assets.iter().any(|a| a.symbol == "RUNE-TREND"));
    }

    #[test]
    fn v5_obsidian_passlock_has_15_assets() {
        let cfg = v5_obsidian_passlock();
        assert!(cfg.close_all_on_target_reached);
        assert_eq!(cfg.assets.len(), 15);
        assert!(cfg.assets.iter().any(|a| a.symbol == "ARB-TREND"));
    }

    #[test]
    fn v5_titanium_passlock_lscool_tight_sets_cooldown() {
        let cfg = v5_titanium_passlock_lscool_tight();
        let lsc = cfg.loss_streak_cooldown.expect("must set lossStreakCooldown");
        assert_eq!(lsc.after_losses, 1);
        assert_eq!(lsc.cooldown_bars, 400);
        assert!(cfg.close_all_on_target_reached);
    }

    #[test]
    fn v5_titanium_passlock_lscool_loose_sets_cooldown() {
        let cfg = v5_titanium_passlock_lscool_loose();
        let lsc = cfg.loss_streak_cooldown.expect("must set lossStreakCooldown");
        assert_eq!(lsc.after_losses, 3);
        assert_eq!(lsc.cooldown_bars, 96);
    }

    #[test]
    fn v5_titanium_passlock_mct5_sets_concurrent() {
        let cfg = v5_titanium_passlock_mct5();
        assert_eq!(cfg.max_concurrent_trades, Some(5));
        assert!(cfg.close_all_on_target_reached);
    }

    #[test]
    fn v5_titanium_passlock_corrcap2_sets_filter() {
        let cfg = v5_titanium_passlock_corrcap2();
        let cf = cfg.correlation_filter.expect("must set correlationFilter");
        assert_eq!(cf.max_open_same_direction, 2);
    }

    #[test]
    fn v5_titanium_passlock_todcut18_overrides_hours() {
        let cfg = v5_titanium_passlock_todcut18();
        assert_eq!(
            cfg.allowed_hours_utc.as_ref().unwrap(),
            &vec![4u32, 6, 8, 10, 14, 18]
        );
    }

    #[test]
    fn v3_inherited_trailing_stop_propagates() {
        // V3 sets trailingStop {3%, 0.5%}; the V4/V5 chain inherits without
        // override. Confirm both engine bases (quartz_lite + v5_titanium)
        // carry the field, and a representative leaf inherits it.
        for cfg in [
            r28_v6_passlock(),
            r28_v6(),
            v5_titanium(),
            v5_amber(),
            v5_topaz(),
            v5_titanium_passlock(),
            v5_obsidian_passlock(),
        ] {
            let ts = cfg.trailing_stop.expect("trailing_stop must propagate");
            assert!((ts.activate_pct - 0.03).abs() < 1e-12, "{}: activate_pct", cfg.label);
            assert!((ts.trail_pct - 0.005).abs() < 1e-12, "{}: trail_pct", cfg.label);
        }
    }

    #[test]
    fn r10_selectors_resolve() {
        for s in &[
            "2h-trend-v5-titanium-passlock",
            "2h-trend-v5-titanium-passlock-norune",
            "2h-trend-v5-obsidian-passlock",
            "2h-trend-v5-titanium-passlock-lscool-tight",
            "2h-trend-v5-titanium-passlock-lscool-loose",
            "2h-trend-v5-titanium-passlock-mct5",
            "2h-trend-v5-titanium-passlock-corrcap2",
            "2h-trend-v5-titanium-passlock-todcut18",
        ] {
            assert!(
                template_by_selector(s).is_some(),
                "R29-R10 selector {s:?} did not resolve"
            );
        }
    }

    #[test]
    fn selector_resolution() {
        assert_eq!(
            template_by_selector("2h-trend-v5-r28-v6-passlock").unwrap().label,
            "R28_V6_PASSLOCK"
        );
        assert_eq!(
            template_by_selector("2h-trend-v5-titanium").unwrap().label,
            "V5_TITANIUM"
        );
        assert!(template_by_selector("nonsense-xyz").is_none());
    }

    #[test]
    fn all_known_selectors_resolve() {
        for s in known_selectors() {
            assert!(
                template_by_selector(s).is_some(),
                "selector {s:?} did not resolve"
            );
        }
    }

    #[test]
    fn r28_v6_per_asset_tp_pct() {
        let cfg = r28_v6_passlock();
        let by_sym: std::collections::HashMap<&str, f64> = cfg
            .assets
            .iter()
            .map(|a| (a.symbol.as_str(), a.tp_pct.unwrap()))
            .collect();
        // Small-TP cohort
        assert!((by_sym["BTC-TREND"] - 0.00825).abs() < 1e-9);
        assert!((by_sym["BNB-TREND"] - 0.00825).abs() < 1e-9);
        assert!((by_sym["ETC-TREND"] - 0.00825).abs() < 1e-9);
        // Mid
        assert!((by_sym["ETH-TREND"] - 0.011).abs() < 1e-9);
        assert!((by_sym["AAVE-TREND"] - 0.01375).abs() < 1e-9);
        // Large
        assert!((by_sym["XRP-TREND"] - 0.0165).abs() < 1e-9);
        assert!((by_sym["LTC-TREND"] - 0.01925).abs() < 1e-9);
    }

    #[test]
    fn r28_v6_ptp_design_present() {
        let cfg = r28_v6_passlock();
        let ptp = cfg.partial_take_profit.unwrap();
        assert!((ptp.trigger_pct - 0.012).abs() < 1e-9);
        assert!((ptp.close_fraction - 0.7).abs() < 1e-9);
    }

    #[test]
    fn frmed_template_has_both_thresholds() {
        let cfg = r28_v6_passlock_frmed_template();
        assert_eq!(cfg.label, "R28_V6_PASSLOCK_FRMED");
        let f = cfg.funding_rate_filter.expect("FRMED must set filter");
        assert!((f.max_funding_for_long.unwrap() - 0.0005).abs() < 1e-12);
        assert!((f.min_funding_for_short.unwrap() - (-0.0003)).abs() < 1e-12);
        // Inherits PASSLOCK semantics.
        assert!(cfg.close_all_on_target_reached);
        assert_eq!(cfg.assets.len(), 9);
    }

    #[test]
    fn frlong_template_only_sets_long_threshold() {
        let cfg = r28_v6_passlock_frlong_template();
        assert_eq!(cfg.label, "R28_V6_PASSLOCK_FRLONG");
        let f = cfg.funding_rate_filter.expect("FRLONG must set filter");
        assert!((f.max_funding_for_long.unwrap() - 0.0005).abs() < 1e-12);
        assert!(f.min_funding_for_short.is_none());
        assert!(cfg.close_all_on_target_reached);
    }

    #[test]
    fn frmild_and_frstrict_templates_resolve() {
        let mild = r28_v6_passlock_frmild_template();
        let strict = r28_v6_passlock_frstrict_template();
        assert!((mild.funding_rate_filter.unwrap().max_funding_for_long.unwrap() - 0.001).abs() < 1e-12);
        assert!((strict.funding_rate_filter.unwrap().max_funding_for_long.unwrap() - 0.0003).abs() < 1e-12);
    }

    #[test]
    fn frmed_selector_resolves() {
        let cfg = template_by_selector("r28_v6_passlock_frmed").unwrap();
        assert_eq!(cfg.label, "R28_V6_PASSLOCK_FRMED");
        assert!(cfg.funding_rate_filter.is_some());
    }
}
