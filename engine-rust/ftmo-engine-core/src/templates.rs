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
    LossStreakCooldown, PartialTakeProfit, PartialTakeProfitLevel, PeakDrawdownThrottle,
    PeakTrailingStop, TrailingStop,
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
///   triggerBars=1, invertDirection=true, disableShort=true
///   stopPct=0.05, tpPct=0.07 (overridden later by R28_V6 multipliers)
///
/// 2026-05-23 NOTE: per-asset cost scaffolding (`cost_bp_for` etc.) added
/// then reverted in same session — A/B vs uniform 30/8/4 measured -3.24pp
/// on V5_AMBER_MAX_PASSLOCK P1 (49.07% vs 52.31%). Net regression because
/// alts dominate trade count and got HIGHER cost (35 vs 30 bp). Per-asset
/// lookup remains as helpers below but is bypassed — see uniform `make_assets`
/// risk_frac arg. Re-enable only after live drift-monitor data calibrates
/// real costs. Source: prior agent's Scenario B "REALISTIC mid".
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
            disable_long: false,
            deactivate_after_day: None,
            trigger_bars: Some(1),
            cost_bp: Some(30.0),
            slippage_bp: Some(8.0),
            swap_bp_per_day: Some(4.0),
            cvd_entry: None,
            vol_imbalance_entry: None,
            vol_poc_entry: None,
            max_funding_for_long: None,
            min_funding_for_short: None,
            allowed_hours_utc: None,
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

/// Per-asset tp for V5_RUBIN: identical to V5_TOPAZ except INJ 0.045 → 0.050.
/// Source: ftmoDaytrade24h.ts:7466-7492. Phase ZA single-axis sweep on TOPAZ
/// concluded INJ wanted tp 5.0% (delta +0.09pp step=1d, +0.54pp step=3d).
fn v5_rubin_tp_for(symbol: &str) -> f64 {
    match symbol {
        "INJ-TREND" => 0.050,
        other => v5_topaz_tp_for(other),
    }
}

/// V5_SAPPHIR basket = V5_RUBIN (14 from TOPAZ) + DOT/TRX/ALGO/NEAR (18 total).
/// Source: ftmoDaytrade24h.ts:7510-7585. Cache claim: 66.85% step=3d / 64.73%
/// step=1d / wr 87.65% / TL 0 (best in V5 family on these dimensions).
const V5_SAPPHIR_NEW_ASSETS: &[&str] = &["DOT-TREND", "TRX-TREND", "ALGO-TREND", "NEAR-TREND"];

/// V5_DIAMOND extension = V5_SAPPHIR + ATOM/LINK/SOL/STX/UNI (23 total).
/// All 5 are available 30m candles with full history back to 2020-2021.
/// 2026-05-13 hypothesis: PASSLOCK family pattern is +6-12pp on base; if
/// adding these net-positive assets even slightly, SAPPHIR_PASSLOCK ≈ 60-65%
/// could clear 65% on the extended basket.
const V5_DIAMOND_NEW_ASSETS: &[&str] = &[
    "ATOM-TREND",
    "LINK-TREND",
    "SOL-TREND",
    "STX-TREND",
    "UNI-TREND",
];

/// Per-asset tp for V5_SAPPHIR: V5_RUBIN tps + DOT/TRX/ALGO/NEAR at 0.020.
fn v5_sapphir_tp_for(symbol: &str) -> f64 {
    match symbol {
        "DOT-TREND" | "TRX-TREND" | "ALGO-TREND" | "NEAR-TREND" => 0.020,
        other => v5_rubin_tp_for(other),
    }
}

/// Per-asset tp for V5_DIAMOND: V5_SAPPHIR tps + ATOM/LINK/SOL/STX/UNI at
/// 0.020 (same conservative default as the SAPPHIR additions — best-guess
/// before per-asset tuning).
fn v5_diamond_tp_for(symbol: &str) -> f64 {
    match symbol {
        "ATOM-TREND" | "LINK-TREND" | "SOL-TREND" | "STX-TREND" | "UNI-TREND" => 0.020,
        other => v5_sapphir_tp_for(other),
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
    cfg.live_caps = Some(LiveCaps {
        max_stop_pct: 0.05,
        max_risk_frac: 0.4,
    });
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 2.0,
    });
    cfg.chandelier_exit = Some(ChandelierExit {
        period: 56,
        mult: 2.0,
        min_move_r: Some(0.5),
    });
    cfg.break_even = Some(BreakEven { threshold: 0.03 });
    // R28_V4 override: triggerPct 0.02, closeFraction 0.7. R28_V6 keeps the
    // same shape but lifts trigger to 0.012; that override happens in
    // `r28_v6_passlock()` / `r28_v6()` below.
    cfg.partial_take_profit = Some(PartialTakeProfit {
        trigger_pct: 0.02,
        close_fraction: 0.7,
    });
    // R28_V4 override: 0.012 (not the V5_QUARTZ_LITE 0.02). −40% trail
    // distance — much earlier give-back lock.
    cfg.daily_peak_trailing_stop = Some(PeakTrailingStop {
        trail_distance: 0.012,
    });
    // R28_V4 → R28_V6 inherits this throttle: scale risk DOWN to 15% when
    // equity drops 3% below all-time peak.
    cfg.peak_drawdown_throttle = Some(PeakDrawdownThrottle {
        from_peak: 0.03,
        factor: 0.15,
    });
    // V5_ZIRKON (TS line 7293) overrides maxConcurrentTrades=10 — propagates
    // through V5_AMBER → V5_QUARTZ → V5_QUARTZ_LITE → R28_V4 → R28_V6 →
    // PASSLOCK. Earlier value (6) was V1 root, but the chain bumps it.
    cfg.max_concurrent_trades = Some(10);
    cfg.allowed_hours_utc = Some(vec![4, 6, 8, 10, 14, 18, 22]);
    cfg.pause_at_target_reached = true;
    // V3-inherited trailingStop {activatePct: 3%, trailPct: 0.5%}. None of V4,
    // V5, V5_QUARTZ, V5_QUARTZ_LITE, R28_V4 or R28_V6 override it. Closes the
    // -8.78pp Rust↔TS drift on R28_V6_PASSLOCK observed post-Phase-3.
    cfg.trailing_stop = Some(TrailingStop {
        activate_pct: 0.03,
        trail_pct: 0.005,
    });
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
    cfg.live_caps = Some(LiveCaps {
        max_stop_pct: 0.05,
        max_risk_frac: 0.4,
    });
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
    cfg.trailing_stop = Some(TrailingStop {
        activate_pct: 0.03,
        trail_pct: 0.005,
    });
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

/// 2026-05-13 V5_AMBER_EXT — V5_AMBER + DOT/TRX/ALGO/NEAR (19 assets). The
/// SAPPHIR-style basket extension applied to AMBER's higher-uplift engine
/// stack. AMBER showed +12pp PASSLOCK uplift vs TOPAZ family +8pp; extension
/// hopes are 60%+ PASSLOCK rate on the wider basket.
pub fn v5_amber_ext() -> EngineConfig {
    let mut cfg = v5_amber();
    cfg.label = "V5_AMBER_EXT".into();
    let mut extra = make_assets(V5_SAPPHIR_NEW_ASSETS, 0.4);
    for asset in extra.iter_mut() {
        asset.tp_pct = Some(0.020);
        asset.stop_pct = Some(0.05);
        asset.hold_bars = Some(240);
    }
    cfg.assets.extend(extra);
    cfg
}

/// 2026-05-13 V5_AMBER_EXT + PASSLOCK.
/// 2026-05-16 Round 9 KRIT FIX (templates agent): add atrStop {period:56,
/// stopMult:2} to match TS PASSLOCK family. Same drift class as
/// v5_amber_max_passlock.
pub fn v5_amber_ext_passlock() -> EngineConfig {
    let mut cfg = v5_amber_ext();
    cfg.label = "V5_AMBER_EXT_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 2.0,
    });
    cfg
}

/// 2026-05-13 V5_AMBER_MAX — V5_AMBER + 9 extra (DOT/TRX/ALGO/NEAR + ATOM/
/// LINK/SOL/STX/UNI) = 24 assets. Full available 30m universe.
pub fn v5_amber_max() -> EngineConfig {
    let mut cfg = v5_amber_ext();
    cfg.label = "V5_AMBER_MAX".into();
    let mut extra = make_assets(V5_DIAMOND_NEW_ASSETS, 0.4);
    for asset in extra.iter_mut() {
        asset.tp_pct = Some(0.020);
        asset.stop_pct = Some(0.05);
        asset.hold_bars = Some(240);
    }
    cfg.assets.extend(extra);
    cfg
}

/// 2026-05-13 V5_AMBER_MAX + PASSLOCK.
///
/// 2026-05-16 Round 9 KRIT FIX (templates agent + parity agent both KRIT):
/// TS reference `FTMO_DAYTRADE_24H_V5_AMBER_MAX_PASSLOCK` (ftmoDaytrade24h.ts
/// line 8740) explicitly sets `atrStop: { period: 56, stopMult: 2 }` on top
/// of PASSLOCK. Rust port previously inherited from `v5_amber()` which
/// builds from `v5_titanium_base()` and explicitly nulls atrStop. Result:
/// Rust AMBER_MAX_PASSLOCK ran WITHOUT trailing ATR-stop, while TS AND live
/// deploy both ran WITH it. This is a fundamental strategy drift — ATR-trail
/// protects gains and reduces total-loss tail. Add atrStop here to match TS.
/// Estimated pp impact: +3-8pp Combined-Funded pass-rate.
pub fn v5_amber_max_passlock() -> EngineConfig {
    let mut cfg = v5_amber_max();
    cfg.label = "V5_AMBER_MAX_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 2.0,
    });
    cfg
}

/// Step-2/Verification selector for the start-gated single-account flow.
/// Same strategy surface as AMBER_MAX_PASSLOCK, but with the real FTMO
/// Verification target of +5%.
pub fn v5_amber_max_passlock_step2() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_STEP2".into();
    cfg.profit_target = 0.05;
    cfg.max_days = 60;
    cfg
}

/// 2026-05-17 Bidirectional variant — enable shorts to address the long-only
/// fail mode discovered in failure_pattern_analysis: in non-qualifying setups
/// (bearish/sideways first 24h) the bot's 100% long bias means all entries
/// lose simultaneously, producing 88% of fails by Day 3.
///
/// Conservative change: keep V02 voters, base config, PASSLOCK + atrStop —
/// only flip `disable_short` to false on every asset. The existing voters
/// (HMM, bb-z-mr, supertrend, ad-line, poc-z) already vote both directions;
/// `disable_short=true` was filtering all short votes upstream.
///
/// `invert_direction` stays `true` for parity with the V5_AMBER family
/// trade direction convention (matched against TS V4 sim reference).
pub fn v5_amber_max_passlock_bidir() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_BIDIR".into();
    for asset in cfg.assets.iter_mut() {
        asset.disable_short = false;
    }
    cfg
}

/// 2026-05-24 MIXED hyperparam variants. Test 4 different param configs
/// for cvd lookback / vol_imb threshold / poc window to find sweet spot.
pub fn v5_amber_max_passlock_mixed_v2() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_MIXED_V2".into();
    let cvd_set: std::collections::HashSet<&str> = ["BTC", "ETH", "SOL", "AVAX", "BNB"]
        .iter()
        .copied()
        .collect();
    let vol_imb_set: std::collections::HashSet<&str> = ["LINK", "ADA", "AAVE", "ATOM", "DOT"]
        .iter()
        .copied()
        .collect();
    let vol_poc_set: std::collections::HashSet<&str> = ["ALGO", "NEAR", "ARB", "UNI", "TRX"]
        .iter()
        .copied()
        .collect();
    for asset in cfg.assets.iter_mut() {
        let base = asset
            .symbol
            .split('-')
            .next()
            .unwrap_or(&asset.symbol)
            .to_string();
        if cvd_set.contains(base.as_str()) {
            asset.cvd_entry = Some(crate::config::CvdEntry { lookback_bars: 30 });
        // tighter
        } else if vol_imb_set.contains(base.as_str()) {
            asset.vol_imbalance_entry = Some(crate::config::VolImbalanceEntry { long_min: 0.70 });
        // higher threshold
        } else if vol_poc_set.contains(base.as_str()) {
            asset.vol_poc_entry = Some(crate::config::VolPocEntry {
                window_bars: 30,
                min_dist_from_poc_pct: 0.008,
            });
        }
    }
    cfg
}

pub fn v5_amber_max_passlock_mixed_v3() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_MIXED_V3".into();
    let cvd_set: std::collections::HashSet<&str> = ["BTC", "ETH", "SOL", "AVAX", "BNB"]
        .iter()
        .copied()
        .collect();
    let vol_imb_set: std::collections::HashSet<&str> = ["LINK", "ADA", "AAVE", "ATOM", "DOT"]
        .iter()
        .copied()
        .collect();
    let vol_poc_set: std::collections::HashSet<&str> = ["ALGO", "NEAR", "ARB", "UNI", "TRX"]
        .iter()
        .copied()
        .collect();
    for asset in cfg.assets.iter_mut() {
        let base = asset
            .symbol
            .split('-')
            .next()
            .unwrap_or(&asset.symbol)
            .to_string();
        if cvd_set.contains(base.as_str()) {
            asset.cvd_entry = Some(crate::config::CvdEntry { lookback_bars: 100 });
        // wider
        } else if vol_imb_set.contains(base.as_str()) {
            asset.vol_imbalance_entry = Some(crate::config::VolImbalanceEntry { long_min: 0.60 });
        // lower threshold
        } else if vol_poc_set.contains(base.as_str()) {
            asset.vol_poc_entry = Some(crate::config::VolPocEntry {
                window_bars: 100,
                min_dist_from_poc_pct: 0.003,
            });
        }
    }
    cfg
}

// AGG_KR + adaptive sizing tier (2x on +3% buffer)
pub fn v5_amber_max_passlock_agg_kr_adaptive() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_ADAPTIVE".into();
    cfg.adaptive_sizing = Some(vec![
        crate::config::AdaptiveSizingTier {
            equity_above: 0.03,
            factor: 1.5,
        },
        crate::config::AdaptiveSizingTier {
            equity_above: 0.06,
            factor: 2.0,
        },
    ]);
    cfg
}

// AGG_KR + chandelier exit (ATR-trailing on winners)
pub fn v5_amber_max_passlock_agg_kr_chandelier() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_CHANDELIER".into();
    cfg.chandelier_exit = Some(crate::config::ChandelierExit {
        period: 22,
        mult: 2.5,
        min_move_r: Some(0.5),
    });
    cfg
}

// AGG_KR + partial take profit (lock 30% at +3%)
pub fn v5_amber_max_passlock_agg_kr_ptp() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_PTP".into();
    cfg.partial_take_profit = Some(crate::config::PartialTakeProfit {
        trigger_pct: 0.03,
        close_fraction: 0.3,
    });
    cfg
}

// AGG_KR + break-even threshold (move SL to entry at +1% — earlier than original 1.5%)
pub fn v5_amber_max_passlock_agg_kr_be_early() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_BE_EARLY".into();
    cfg.break_even = Some(crate::config::BreakEven { threshold: 0.01 });
    cfg
}

// AGG_KR + tighter stops (0.03 vs 0.05 default)
pub fn v5_amber_max_passlock_agg_kr_tight_stop() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_TIGHT_STOP".into();
    for asset in cfg.assets.iter_mut() {
        asset.stop_pct = Some(0.03);
    }
    cfg
}

// AGG_KR + wider stops (0.08)
pub fn v5_amber_max_passlock_agg_kr_wide_stop() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_WIDE_STOP".into();
    for asset in cfg.assets.iter_mut() {
        asset.stop_pct = Some(0.08);
    }
    cfg
}

// AGG_KR + 1.5x TP (bigger wins, fewer hits)
pub fn v5_amber_max_passlock_agg_kr_high_tp() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_HIGH_TP".into();
    for asset in cfg.assets.iter_mut() {
        if let Some(tp) = asset.tp_pct {
            asset.tp_pct = Some(tp * 1.5);
        }
    }
    cfg
}

// AGG_KR + 0.7x TP (faster turnover, more hits)
pub fn v5_amber_max_passlock_agg_kr_low_tp() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_LOW_TP".into();
    for asset in cfg.assets.iter_mut() {
        if let Some(tp) = asset.tp_pct {
            asset.tp_pct = Some(tp * 0.7);
        }
    }
    cfg
}

// V4: ONLY cvd_entry on all 19 assets (no R28V6 fallback) — test pure cvd signal
pub fn v5_amber_max_passlock_mixed_v4_cvd_only() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_MIXED_V4_CVD_ONLY".into();
    for asset in cfg.assets.iter_mut() {
        asset.cvd_entry = Some(crate::config::CvdEntry { lookback_bars: 50 });
    }
    cfg
}

/// 2026-05-25 SHORTS_AGG — SHORTS_ONLY base + AGG upgrades (bidir+mutex+
/// MCT=25+24h+kelly+reentry). Tests if SHORTS-side benefits from AGG.
pub fn v5_amber_max_passlock_shorts_agg() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_shorts_only();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_SHORTS_AGG".into();
    cfg.mutex_long_short = true;
    cfg.max_concurrent_trades = Some(25);
    cfg.allowed_hours_utc = None;
    cfg.kelly_sizing = Some(crate::config::KellySizing {
        window_size: 30,
        min_trades: 10,
        fraction: 0.5,
        tiers: vec![
            crate::config::KellyTier {
                win_rate_above: 0.65,
                multiplier: 2.0,
            },
            crate::config::KellyTier {
                win_rate_above: 0.55,
                multiplier: 1.5,
            },
            crate::config::KellyTier {
                win_rate_above: 0.45,
                multiplier: 1.0,
            },
            crate::config::KellyTier {
                win_rate_above: 0.0,
                multiplier: 0.5,
            },
        ],
    });
    cfg.reentry_after_stop = Some(crate::config::ReentryAfterStop {
        within_bars: 12,
        size_mult: 0.5,
    });
    cfg
}

/// 2026-05-25 AGG_KR_HOLD_120 — shorter hold (2.5d instead of 5d).
/// Faster turnover; tests if more trades per window helps.
pub fn v5_amber_max_passlock_agg_kr_hold_120() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_HOLD120".into();
    cfg.hold_bars = 120;
    for asset in cfg.assets.iter_mut() {
        asset.hold_bars = Some(120);
    }
    cfg
}

/// 2026-05-25 P2_GRINDER — designed for P2 only (+5%/60d).
/// AMBER base + chandelier (lock trail) + break-even-early (move SL to entry at +1%) +
/// tighter ATR (1.5x) + lower riskFrac (0.005 = half). Slow grind to +5% with
/// minimal drawdown. Tested for P2-slot specialization.
pub fn v5_amber_max_passlock_p2_grinder() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_P2_GRINDER".into();
    cfg.profit_target = 0.05;
    cfg.max_days = 60;
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 1.5,
    });
    cfg.chandelier_exit = Some(crate::config::ChandelierExit {
        period: 22,
        mult: 2.2,
        min_move_r: Some(0.5),
    });
    cfg.break_even = Some(crate::config::BreakEven { threshold: 0.008 });
    for asset in cfg.assets.iter_mut() {
        asset.risk_frac *= 0.5;
    }
    cfg
}

/// 2026-05-25 P2_DEFENDER — alternative P2 specialist. Tighter trail-from-peak,
/// fewer concurrent trades (cap=10), slower turnover.
pub fn v5_amber_max_passlock_p2_defender() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_P2_DEFENDER".into();
    cfg.profit_target = 0.05;
    cfg.max_days = 60;
    cfg.max_concurrent_trades = Some(10);
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 1.8,
    });
    cfg.challenge_peak_trailing_stop = Some(crate::config::PeakTrailingStop {
        trail_distance: 0.018,
    });
    cfg.break_even = Some(crate::config::BreakEven { threshold: 0.012 });
    cfg
}

/// 2026-05-25 AGG_KR with combined adaptive + chandelier (without ptp/be).
pub fn v5_amber_max_passlock_agg_kr_combo() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_KR_COMBO".into();
    cfg.adaptive_sizing = Some(vec![
        crate::config::AdaptiveSizingTier {
            equity_above: 0.03,
            factor: 1.5,
        },
        crate::config::AdaptiveSizingTier {
            equity_above: 0.06,
            factor: 2.0,
        },
    ]);
    cfg.chandelier_exit = Some(crate::config::ChandelierExit {
        period: 22,
        mult: 2.5,
        min_move_r: Some(0.5),
    });
    cfg
}

// 2026-05-25 Wave5 — INTRADAY hour-restricted templates.
// Hypothesis: crypto liquidity concentrates in US-overlap hours (13-16 UTC).
// Trading only during these "best hours" reduces noise-trades that lose to
// spreads/slippage during low-liquidity overnight (20-04 UTC).
//
// Base = v5_amber_max_passlock (best trend template). Override only
// `allowed_hours_utc` to restrict entries.

/// US-PEAK: 13-16 UTC only (4 hours, US open + EU close overlap).
pub fn v5_amber_max_passlock_intraday_us_peak() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_INTRADAY_US_PEAK".into();
    cfg.allowed_hours_utc = Some(vec![13, 14, 15, 16]);
    cfg
}

/// LIQUID: London + NY sessions (8h, 8-17 UTC).
pub fn v5_amber_max_passlock_intraday_liquid() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_INTRADAY_LIQUID".into();
    cfg.allowed_hours_utc = Some(vec![8, 10, 12, 14, 16]);
    cfg
}

/// NY-ONLY: NY session only (5h, 14-18 UTC).
pub fn v5_amber_max_passlock_intraday_ny_only() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_INTRADAY_NY_ONLY".into();
    cfg.allowed_hours_utc = Some(vec![14, 15, 16, 17, 18]);
    cfg
}

/// ASIA-AVOID: skip Asia low-liquidity (drop 0-4 + 20-22 UTC).
pub fn v5_amber_max_passlock_intraday_asia_avoid() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_INTRADAY_ASIA_AVOID".into();
    cfg.allowed_hours_utc = Some(vec![6, 8, 10, 12, 14, 16, 18]);
    cfg
}

/// 24H-PEAK: Asia open + London open + NY open + NY close (4 anchor hours).
pub fn v5_amber_max_passlock_intraday_4anchor() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_INTRADAY_4ANCHOR".into();
    cfg.allowed_hours_utc = Some(vec![0, 8, 14, 20]);
    cfg
}

/// 2026-05-24 PYRAMID variant — scale into winning trades. AGG_24H_KELLY_REENTRY
/// base + allow second same-asset+direction entry when existing position is
/// already +2% in profit. Pyramid entry uses half-size. Discretionary
/// trader pattern.
pub fn v5_amber_max_passlock_aggressive_24h_kelly_reentry_pyramid() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGG_24H_KELLY_REENTRY_PYRAMID".into();
    cfg.allow_pyramid_after_profit_pct = Some(0.02);
    cfg.pyramid_size_mult = 0.5;
    cfg
}

/// 2026-05-24 MIXED_DETECTORS — Florian's "diversify signal sources"
/// hypothesis. AGGRESSIVE_24H_KELLY_REENTRY base, then OVERRIDE per-asset
/// entry-type so different assets fire on UNCORRELATED signals:
///   - 5 high-vol assets (BTC, ETH, SOL, AVAX, BNB): cvd_entry (cumulative
///     volume delta — trends with money-flow)
///   - 5 mid-vol assets (LINK, ADA, AAVE, ATOM, DOT): vol_imbalance_entry
///     (taker-buy ratio extreme = aggression signal)
///   - 5 lower-vol assets (ALGO, NEAR, ARB, UNI, TRX): vol_poc_entry
///     (mean-revert from POC distance)
///   - 4 default-trend assets (BCH, ETC, LTC, XRP): keep R28V6 fallback
/// Hypothesis: 4 uncorrelated signal sources × 19 assets = more
/// diversification than single signal-source on same basket. If trade-
/// streams are independent, pass-rate could rise +2-4pp.
pub fn v5_amber_max_passlock_mixed_detectors() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly_reentry();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_MIXED_DETECTORS".into();
    let cvd_set: std::collections::HashSet<&str> = ["BTC", "ETH", "SOL", "AVAX", "BNB"]
        .iter()
        .copied()
        .collect();
    let vol_imb_set: std::collections::HashSet<&str> = ["LINK", "ADA", "AAVE", "ATOM", "DOT"]
        .iter()
        .copied()
        .collect();
    let vol_poc_set: std::collections::HashSet<&str> = ["ALGO", "NEAR", "ARB", "UNI", "TRX"]
        .iter()
        .copied()
        .collect();
    for asset in cfg.assets.iter_mut() {
        // strip suffix like "BTC-TREND" → "BTC", or "BTC-AMBER" / "BTC-SHORTS"
        let base = asset
            .symbol
            .split('-')
            .next()
            .unwrap_or(&asset.symbol)
            .to_string();
        if cvd_set.contains(base.as_str()) {
            asset.cvd_entry = Some(crate::config::CvdEntry { lookback_bars: 50 });
        } else if vol_imb_set.contains(base.as_str()) {
            asset.vol_imbalance_entry = Some(crate::config::VolImbalanceEntry { long_min: 0.65 });
        } else if vol_poc_set.contains(base.as_str()) {
            asset.vol_poc_entry = Some(crate::config::VolPocEntry {
                window_bars: 50,
                min_dist_from_poc_pct: 0.005,
            });
        }
        // others (BCH, ETC, LTC, XRP) keep default R28V6 detector
    }
    cfg
}

/// 2026-05-24 AGGRESSIVE_24H_KELLY_REENTRY — AGG_24H_KELLY + reentry-
/// after-stop. When a stop fires, re-enter same direction at half-size
/// within reentry_window. Hypothesis: stops often happen near
/// reversal — second attempt captures the recovery.
pub fn v5_amber_max_passlock_aggressive_24h_kelly_reentry() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h_kelly();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGGRESSIVE_24H_KELLY_REENTRY".into();
    cfg.reentry_after_stop = Some(crate::config::ReentryAfterStop {
        within_bars: 12, // re-attempt within 6h (12 × 30m)
        size_mult: 0.5,
    });
    cfg
}

/// 2026-05-24 AGGRESSIVE_24H_ADAPTIVE — 24h + adaptive sizing tier.
/// When equity already > +3% buffer, scale risk_frac up 1.5×; > +6%
/// scale 2×. Snowball compound effect when ahead.
pub fn v5_amber_max_passlock_aggressive_24h_adaptive() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGGRESSIVE_24H_ADAPTIVE".into();
    cfg.adaptive_sizing = Some(vec![
        crate::config::AdaptiveSizingTier {
            equity_above: 0.03,
            factor: 1.5,
        },
        crate::config::AdaptiveSizingTier {
            equity_above: 0.06,
            factor: 2.0,
        },
    ]);
    cfg
}

/// 2026-05-24 AGGRESSIVE_24H_KELLY — 24h + kelly sizing based on
/// rolling win-rate. When recent wr > 0.55, scale risk_frac up.
pub fn v5_amber_max_passlock_aggressive_24h_kelly() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive_24h();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGGRESSIVE_24H_KELLY".into();
    cfg.kelly_sizing = Some(crate::config::KellySizing {
        window_size: 30,
        min_trades: 10,
        fraction: 0.5, // half-Kelly (Thorp criterion)
        tiers: vec![
            crate::config::KellyTier {
                win_rate_above: 0.65,
                multiplier: 2.0,
            },
            crate::config::KellyTier {
                win_rate_above: 0.55,
                multiplier: 1.5,
            },
            crate::config::KellyTier {
                win_rate_above: 0.45,
                multiplier: 1.0,
            },
            crate::config::KellyTier {
                win_rate_above: 0.0,
                multiplier: 0.5,
            },
        ],
    });
    cfg
}

/// 2026-05-24 AGGRESSIVE_24H — remove the cfg-level allowedHoursUtc gate
/// so trades fire on ALL 24 hours (vs default 8). +3× signal exposure.
pub fn v5_amber_max_passlock_aggressive_24h() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGGRESSIVE_24H".into();
    cfg.allowed_hours_utc = None;
    cfg
}

/// 2026-05-24 AGGRESSIVE_MCT50 — max_concurrent_trades 25 → 50.
/// Tests if more parallel exposure helps further.
pub fn v5_amber_max_passlock_aggressive_mct50() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGGRESSIVE_MCT50".into();
    cfg.max_concurrent_trades = Some(50);
    cfg
}

/// 2026-05-24 AGGRESSIVE_BE — AGGRESSIVE + break-even ONLY (no PTP).
/// Tests if breakEven alone helps without the PTP profit-cap cost.
pub fn v5_amber_max_passlock_aggressive_be() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGGRESSIVE_BE".into();
    cfg.break_even = Some(crate::config::BreakEven { threshold: 0.015 });
    cfg
}

/// 2026-05-24 FULLY_LOADED — Florian's "denk um die Ecke" insight:
/// AMBER_MAX_PASSLOCK uses only 2 of 8 available engine safety features.
/// Most templates were copy-paste minimal, leaving big risk-management
/// levers off. This template enables the FULL stack on top of AGGRESSIVE:
///
///   ✅ already in AGGRESSIVE: bidir + mutex + MCT=25 + atr_stop +
///                              trailing_stop + closeAllOnTargetReached
///   ✅ NEW: partial_take_profit_levels  (lock +3%/+5%/+8% in stages)
///   ✅ NEW: break_even at +1.5%        (move SL to entry → "free trade")
///   ✅ NEW: peak_drawdown_throttle      (halve size after -3% DD)
///   ✅ NEW: daily_peak_trailing_stop   (preserve intraday gains)
///   ✅ NEW: adaptive_sizing tier        (2× risk after +3% equity buffer)
///
/// Hypothesis: each safety feature should add 1-3pp to TRUE-SEQ CF by
/// reducing the structural fail-modes (lock profit early → less reversal
/// risk; daily-peak-trail → less DL hits after big intraday win; adaptive
/// sizing → snowball compounding when buffered). If 5 features × 1-3pp
/// = +5-15pp on top of AGGRESSIVE 34.30% → projected 39-49% single-account.
pub fn v5_amber_max_passlock_fully_loaded() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_aggressive();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_FULLY_LOADED".into();

    // 1) Multi-level partial take profit: lock 25% at +3%, 25% at +5%,
    //    25% at +8% — last 25% rides via PASSLOCK closeAll at +10%.
    cfg.partial_take_profit_levels = Some(vec![
        crate::config::PartialTakeProfitLevel {
            trigger_pct: 0.03,
            close_fraction: 0.25,
        },
        crate::config::PartialTakeProfitLevel {
            trigger_pct: 0.05,
            close_fraction: 0.25,
        },
        crate::config::PartialTakeProfitLevel {
            trigger_pct: 0.08,
            close_fraction: 0.25,
        },
    ]);

    // 2) Break-even: once unrealised P&L hits +1.5%, move SL to entry
    //    → trade becomes risk-free.
    cfg.break_even = Some(crate::config::BreakEven { threshold: 0.015 });

    // 3) Peak-drawdown throttle: if equity drops 3% from peak, halve
    //    new-trade risk_frac. Lets us recover without compounding
    //    losses.
    cfg.peak_drawdown_throttle = Some(crate::config::PeakDrawdownThrottle {
        from_peak: 0.03,
        factor: 0.5,
    });

    // 4) Daily-peak trailing stop: if intraday equity drops 1.5% from
    //    today's high, halt new entries for the day (preserve gains).
    cfg.daily_peak_trailing_stop = Some(crate::config::PeakTrailingStop {
        trail_distance: 0.015,
    });

    // 5) Adaptive sizing tier: when equity is above +3% buffer, scale
    //    risk_frac up to use the cushion aggressively (snowball).
    cfg.adaptive_sizing = Some(vec![
        crate::config::AdaptiveSizingTier {
            equity_above: 0.03,
            factor: 1.5,
        },
        crate::config::AdaptiveSizingTier {
            equity_above: 0.06,
            factor: 2.0,
        },
    ]);

    cfg
}

/// 2026-05-24 SCHEDULED_SPLIT — Florian's hour-disjoint hybrid hypothesis.
///
/// Architecture: duplicate every asset into AMBER-side + SHORT-side
/// clones (same source_symbol). AMBER-side fires only during the original
/// AMBER allowed-hours window [4, 6, 8, 10, 14, 18, 20, 22] (8h/day);
/// SHORT-side fires only during DISJOINT hours [1, 3, 5, 7, 9, 11, 13, 15,
/// 17, 19, 21, 23] (12 odd hours/day). With per-asset allowed_hours_utc
/// gating (added in same commit), no single source_symbol can have a long
/// AND a short open simultaneously — eliminates the shared-equity hedge
/// problem of single-account hybrids WITHOUT needing mutex_long_short.
///
/// cfg-level allowed_hours_utc is cleared (set to None) so the per-asset
/// gates fully control entry timing. risk_frac halved per side (0.4 → 0.2)
/// so combined exposure per source_symbol matches single-strategy.
///
/// Hypothesis: time-disjoint scheduling lets both trade-streams compound
/// independently on the same equity. Sample-day count of SHORT hours
/// (12) >> AMBER hours (8), so SHORT-side has higher trade-frequency
/// potential and may add the +5-10pp boost AMBER + simultaneous-SHORTS
/// (debunked) could not.
pub fn v5_amber_max_passlock_scheduled_split() -> EngineConfig {
    let base = v5_amber_max_passlock();
    let mut cfg = base.clone();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_SCHEDULED_SPLIT".into();
    cfg.allowed_hours_utc = None; // per-asset gates take over
    let amber_hours = vec![4, 6, 8, 10, 14, 18, 20, 22];
    let short_hours = vec![1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];
    let mut combined = Vec::with_capacity(base.assets.len() * 2);
    for a in base.assets.iter() {
        let mut amber = a.clone();
        amber.symbol = format!("{}-AMBER", a.symbol);
        amber.invert_direction = true;
        amber.disable_long = false;
        amber.disable_short = true;
        amber.risk_frac = a.risk_frac * 0.5;
        amber.allowed_hours_utc = Some(amber_hours.clone());
        combined.push(amber);
        let mut shorts = a.clone();
        shorts.symbol = format!("{}-SHORT", a.symbol);
        shorts.invert_direction = false;
        shorts.disable_long = true;
        shorts.disable_short = false;
        shorts.risk_frac = a.risk_frac * 0.5;
        shorts.allowed_hours_utc = Some(short_hours.clone());
        combined.push(shorts);
    }
    cfg.assets = combined;
    cfg
}

/// 2026-05-24 RISK_05 — Boost per-trade risk_frac 0.4 → 0.5 (+25% size).
/// Hypothesis: faster equity accrual to +10% target. Risk: bigger
/// per-trade DL hits.
pub fn v5_amber_max_passlock_risk_05() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_RISK05".into();
    for asset in cfg.assets.iter_mut() {
        asset.risk_frac = 0.5;
    }
    cfg
}

/// 2026-05-24 RISK_06 — risk_frac 0.4 → 0.6 (+50% size). Approaches
/// liveCaps ceiling. Tests upper-bound.
pub fn v5_amber_max_passlock_risk_06() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_RISK06".into();
    for asset in cfg.assets.iter_mut() {
        asset.risk_frac = 0.6;
    }
    cfg
}

/// 2026-05-24 AGGRESSIVE — combo of all single-account boost levers:
///   - bidir (longs + shorts)
///   - mutex_long_short (no hedge)
///   - risk_frac 0.5 (bigger positions)
///   - max_concurrent_trades 25 (was 10 — more parallel exposure)
/// Tests the upper-bound of single-account passrate before structural
/// stack-of-accounts is needed.
pub fn v5_amber_max_passlock_aggressive() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_bidir_mutex();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AGGRESSIVE".into();
    cfg.max_concurrent_trades = Some(25);
    for asset in cfg.assets.iter_mut() {
        asset.risk_frac = 0.5;
    }
    cfg
}

/// 2026-05-24 BIDIR_MUTEX — Florian's "richtig implementierter shorts"
/// Hypothese. BIDIR alone fail (9.6% TRUE-SEQ CF) was caused by
/// same-bar long+short hedge on shared equity. Mutex_long_short forbids
/// opposite-direction positions opening when any position is already
/// open — eliminating the hedge while still allowing both directions
/// to fire over time (whichever the voter triggers first wins the slot).
///
/// Memory's 2026-05-23 v7-mutex-debunk used same-window proxy (29.23%
/// vs AMBER 32.10%). This template re-measures with TRUE-SEQUENTIAL
/// methodology and 1000-window robustness test.
pub fn v5_amber_max_passlock_bidir_mutex() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_bidir();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_BIDIR_MUTEX".into();
    cfg.mutex_long_short = true;
    cfg
}

/// 2026-05-24 BIDIR_SAFE — Florian's hypothesis: single-account hybrid
/// LONG+SHORT was empirically debunked across 9 variants (best 29.23%
/// vs AMBER alone 32.10%) due to shared-equity path-dependency.
/// BUT — those variants ran with the SAME stop_pct/risk_frac as AMBER
/// (2% stop, 0.4 risk_frac). The new angle: scale BOTH down per-trade
/// so a long-stop + short-tp on the same window doesn't burn the
/// total-loss budget. Smaller positions = more survival days =
/// min_trading_days hit sooner = PASSLOCK fires more often.
///
/// Changes vs BIDIR:
///   - per-asset stop_pct: None → 0.015 (1.5% instead of 2%)
///   - per-asset risk_frac: 0.4 → 0.3 (smaller eff_risk per trade)
///   - per-asset tp_pct: 0.025 (statt None → cfg.tp_pct fallback)
///     keeps the same R-multiple (1.66) as the original AMBER ratio.
pub fn v5_amber_max_passlock_bidir_safe() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_bidir();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_BIDIR_SAFE".into();
    for asset in cfg.assets.iter_mut() {
        asset.stop_pct = Some(0.015);
        asset.tp_pct = Some(0.025);
        asset.risk_frac = 0.3;
    }
    cfg
}

/// 2026-05-24 hold_bars variant — give the engine more time per trade to
/// reach TP. AMBER_MAX_PASSLOCK default = 240 bars (5d). This bumps to
/// 480 (10d). Hypothesis: many trades that time-exit currently would
/// have hit TP if held longer; longer hold → higher per-trade win-rate
/// → faster equity accrual → more PASSLOCK fires.
pub fn v5_amber_max_passlock_hold_480() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_HOLD480".into();
    cfg.hold_bars = 480;
    for asset in cfg.assets.iter_mut() {
        asset.hold_bars = Some(480);
    }
    cfg
}

/// 2026-05-24 hold_bars variant — even longer (720 bars = 15 days).
/// Tests the upper end. Risk: more correlated holds → DL exposure rises.
pub fn v5_amber_max_passlock_hold_720() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_HOLD720".into();
    cfg.hold_bars = 720;
    for asset in cfg.assets.iter_mut() {
        asset.hold_bars = Some(720);
    }
    cfg
}

/// 2026-05-24 Florian's "amber + independent shorts on same account"
/// hypothesis. Architecture differs from BIDIR (which made AMBER itself
/// bidirectional via disable_short=false on the inverted voter): here we
/// DUPLICATE every asset as TWO logical entries pointing to the SAME
/// source_symbol cache. The AMBER half keeps `invert_direction=true`
/// (engine longs when voter says SHORT — AMBER's mean-revert convention).
/// The SHORTS half keeps `invert_direction=false` + `disable_long=true`
/// (engine shorts when voter says SHORT — direct trend-following). Both
/// fire INDEPENDENTLY on the same bar based on what the shared voter
/// outputs, but they trade in opposite directions on different setups
/// (AMBER on voter-short bars, SHORTS on voter-short bars also — but
/// from opposite trade-direction perspective on the equity curve).
///
/// Path-dependency caveat from 2026-05-23 hybrid debunk still applies:
/// shared equity means two simultaneous opposite trades partially hedge.
/// But Florian's argument: across N independent trade streams the
/// probability of hitting target+10% is approximately
/// P(target | longs) + P(target | shorts) - P(both same window),
/// and the second term is small when correlations are negative.
pub fn v5_amber_max_passlock_amber_plus_shorts() -> EngineConfig {
    let base = v5_amber_max_passlock();
    let mut cfg = base.clone();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_AMBER_PLUS_SHORTS".into();
    let mut combined = Vec::with_capacity(base.assets.len() * 2);
    for a in base.assets.iter() {
        // AMBER half — preserve original (invert=true, allows both
        // directions but acts as mean-revert long via invert).
        let mut amber = a.clone();
        amber.symbol = format!("{}-AMBER", a.symbol);
        amber.invert_direction = true;
        amber.disable_long = false;
        amber.disable_short = true;
        combined.push(amber);
        // SHORTS half — direct short on voter-short signal, no invert.
        let mut shorts = a.clone();
        shorts.symbol = format!("{}-SHORTS", a.symbol);
        shorts.invert_direction = false;
        shorts.disable_long = true;
        shorts.disable_short = false;
        // Half risk so both halves together don't double the eff_risk.
        shorts.risk_frac = a.risk_frac * 0.5;
        combined.push(shorts);
    }
    // Also halve the AMBER risk so combined eff_risk per source_symbol
    // is similar to single-strategy.
    for amber in combined.iter_mut().filter(|a| a.symbol.ends_with("-AMBER")) {
        amber.risk_frac *= 0.5;
    }
    cfg.assets = combined;
    cfg
}

// 2026-05-23 REMOVED: v5_amber_max_passlock_hybrid (single-account LONG+SHORT
// fusion). Empirically debunked across 9 architectural variants (all worse
// than AMBER alone) due to shared-equity path-dependency dominating
// orthogonality. Additional Wave1 audit found 3 KRIT internal bugs in the
// template itself (source_symbol mismatch breaks cache lookup, doubled risk
// vs documented intent, doc/code semantic flip on equity-gating). Deleted
// rather than fixed since the architecture is fundamentally non-viable.
// See HANDOFF for empirical results: best variant (v7 mutex_long_short) =
// 29.23% combined-funded vs AMBER alone = 32.10%. For orthogonality use
// multi-account stacking (Stack-4 = 59.10%).

/// 2026-05-23 V5_FOREX_MR_PASSLOCK — Bollinger-band mean-reversion on Forex
/// majors (EURUSD/GBPUSD/USDJPY/USDCAD/AUDUSD/NZDUSD). Cross-asset-class
/// diversification candidate vs crypto stack (corr ≈ 0 with crypto-trend).
///
/// Daily-tuned params (10-bar BB, cooldown 2d, 7-period RSI) — defaults in
/// signals_forex_mr.rs are 30m-zugeschnitten and would yield max 2-3 trades
/// per 30d-window on daily bars. CLI override via `--mr-period/--mr-cooldown`
/// at sweep-time (signals_forex_mr.rs:38 reads from cfg.tp_pct/stop_pct).
///
/// USDJPY + USDCAD have `invert_direction: true` (reverse-MR character).
/// liveCaps 0.05/0.4 inherited from PASSLOCK_DEFAULT. PASSLOCK active.
pub fn v5_forex_mr_passlock() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_FOREX_MR_PASSLOCK".into();
    cfg.assets = vec![
        AssetConfig {
            symbol: "EURUSD-MR".into(),
            source_symbol: Some("EURUSD".into()),
            tp_pct: Some(0.015),
            stop_pct: Some(0.012),
            risk_frac: 0.4,
            invert_direction: false,
            disable_short: false,
            disable_long: false,
            trigger_bars: Some(1),
            cost_bp: Some(2.0),
            slippage_bp: Some(1.0),
            swap_bp_per_day: Some(1.0),
            ..AssetConfig::default()
        },
        AssetConfig {
            symbol: "GBPUSD-MR".into(),
            source_symbol: Some("GBPUSD".into()),
            tp_pct: Some(0.018),
            stop_pct: Some(0.014),
            risk_frac: 0.4,
            invert_direction: false,
            disable_short: false,
            disable_long: false,
            trigger_bars: Some(1),
            cost_bp: Some(2.0),
            slippage_bp: Some(1.0),
            swap_bp_per_day: Some(1.0),
            ..AssetConfig::default()
        },
        AssetConfig {
            symbol: "USDJPY-MR".into(),
            source_symbol: Some("USDJPY".into()),
            tp_pct: Some(0.020),
            stop_pct: Some(0.015),
            risk_frac: 0.4,
            invert_direction: true,
            disable_short: false,
            disable_long: false,
            trigger_bars: Some(1),
            cost_bp: Some(2.0),
            slippage_bp: Some(1.0),
            swap_bp_per_day: Some(1.5),
            ..AssetConfig::default()
        },
        AssetConfig {
            symbol: "USDCAD-MR".into(),
            source_symbol: Some("USDCAD".into()),
            tp_pct: Some(0.018),
            stop_pct: Some(0.014),
            risk_frac: 0.4,
            invert_direction: true,
            disable_short: false,
            disable_long: false,
            trigger_bars: Some(1),
            cost_bp: Some(2.0),
            slippage_bp: Some(1.0),
            swap_bp_per_day: Some(1.0),
            ..AssetConfig::default()
        },
        AssetConfig {
            symbol: "AUDUSD-MR".into(),
            source_symbol: Some("AUDUSD".into()),
            tp_pct: Some(0.018),
            stop_pct: Some(0.014),
            risk_frac: 0.4,
            invert_direction: false,
            disable_short: false,
            disable_long: false,
            trigger_bars: Some(1),
            cost_bp: Some(2.0),
            slippage_bp: Some(1.0),
            swap_bp_per_day: Some(1.0),
            ..AssetConfig::default()
        },
        AssetConfig {
            symbol: "NZDUSD-MR".into(),
            source_symbol: Some("NZDUSD".into()),
            tp_pct: Some(0.020),
            stop_pct: Some(0.015),
            risk_frac: 0.4,
            invert_direction: false,
            disable_short: false,
            disable_long: false,
            trigger_bars: Some(1),
            cost_bp: Some(2.0),
            slippage_bp: Some(1.0),
            swap_bp_per_day: Some(1.0),
            ..AssetConfig::default()
        },
    ];
    cfg.invert_direction = false;
    // 2026-05-24 forex template params adjusted to actual 2h-bar data
    // (scripts/cache_forex_2h/forex_2h.json). Prior cfg.bar_minutes=1440
    // (daily) didn't match the 2h cache → engine refused to run with
    // bar-duration mismatch. Re-scale wall-clock semantics:
    //   bar_minutes: 120 (2h)
    //   hold_bars:   120 (= 10 days × 12 bars/day)
    //   BB period:   60  (= 10 days × 12 bars/day, ~wall-clock identical
    //                     to the daily 10-period intent)
    //   cooldown:    24  (= 2 days × 12 bars)
    cfg.bar_minutes = 120;
    cfg.hold_bars = 120;
    cfg.allowed_hours_utc = None; // forex 24/5
    cfg.mean_reversion_source = Some(crate::config::MeanReversionSource {
        period: 60,
        oversold: 20.0,
        overbought: 80.0,
        cooldown_bars: 24,
        size_mult: 0.5,
    });
    cfg
}

/// 2026-05-25 Wave5 — V5_FOREX_MR variants with FTMO-target-scaled TPs.
/// Original `v5_forex_mr_passlock` used daily-tuned TPs (1.5-2%) which
/// produced 0% P1 pass-rate (27 trades × 2% TP × 0.4 risk = max ~2% equity).
/// FTMO needs +10%/30d → per-trade TP needs to scale up.
///
/// Helper: scale all TP/stop on existing forex assets.
fn scale_forex_assets(cfg: &mut EngineConfig, tp_mult: f64, stop_mult: f64) {
    for asset in cfg.assets.iter_mut() {
        if let Some(tp) = asset.tp_pct {
            asset.tp_pct = Some(tp * tp_mult);
        }
        if let Some(stop) = asset.stop_pct {
            asset.stop_pct = Some(stop * stop_mult);
        }
    }
}

/// V5_FOREX_MR_AGG — TPs × 2.5 (~4-5%), stops × 2.0 (~3%).
pub fn v5_forex_mr_passlock_agg() -> EngineConfig {
    let mut cfg = v5_forex_mr_passlock();
    cfg.label = "V5_FOREX_MR_PASSLOCK_AGG".into();
    scale_forex_assets(&mut cfg, 2.5, 2.0);
    cfg
}

/// V5_FOREX_MR_BIG — TPs × 3.5 (~5-7%), stops × 2.5 (~3.5-4%).
pub fn v5_forex_mr_passlock_big() -> EngineConfig {
    let mut cfg = v5_forex_mr_passlock();
    cfg.label = "V5_FOREX_MR_PASSLOCK_BIG".into();
    scale_forex_assets(&mut cfg, 3.5, 2.5);
    cfg
}

/// V5_FOREX_MR_HUGE — TPs × 5.0 (~7.5-10%), stops × 3.0 (~4-5%).
pub fn v5_forex_mr_passlock_huge() -> EngineConfig {
    let mut cfg = v5_forex_mr_passlock();
    cfg.label = "V5_FOREX_MR_PASSLOCK_HUGE".into();
    scale_forex_assets(&mut cfg, 5.0, 3.0);
    cfg
}

/// V5_FOREX_MR_AGG_NARROW — TPs × 2.5 + tighter BB-deviation (more triggers).
/// Tightens BB oversold/overbought from 20/80 to 25/75 (closer to mean).
pub fn v5_forex_mr_passlock_agg_narrow() -> EngineConfig {
    let mut cfg = v5_forex_mr_passlock_agg();
    cfg.label = "V5_FOREX_MR_PASSLOCK_AGG_NARROW".into();
    cfg.mean_reversion_source = Some(crate::config::MeanReversionSource {
        period: 60,
        oversold: 25.0,
        overbought: 75.0,
        cooldown_bars: 24,
        size_mult: 0.5,
    });
    cfg
}

/// V5_FOREX_MR_TIGHT_STOP — keep AGG TPs but TIGHTEN stops (1.5% absolute)
/// to limit DailyLoss-fail rate (was 25% with default stops). Trade fewer
/// losers fully before stopping out.
pub fn v5_forex_mr_passlock_tight_stop() -> EngineConfig {
    let mut cfg = v5_forex_mr_passlock_agg();
    cfg.label = "V5_FOREX_MR_PASSLOCK_TIGHT_STOP".into();
    for asset in cfg.assets.iter_mut() {
        asset.stop_pct = Some(0.015); // 1.5% hard stop on all forex
    }
    cfg
}

/// V5_FOREX_MR_HUGE_TIGHT — HUGE TPs (5-10%) + tight 1.5% stops = 5:1 R:R
/// on winning trades. Theoretical: 25% win rate breaks even.
pub fn v5_forex_mr_passlock_huge_tight() -> EngineConfig {
    let mut cfg = v5_forex_mr_passlock_huge();
    cfg.label = "V5_FOREX_MR_PASSLOCK_HUGE_TIGHT".into();
    for asset in cfg.assets.iter_mut() {
        asset.stop_pct = Some(0.015);
    }
    cfg
}

/// 2026-06-07 EDGE-DETECTOR SUBSTRATE — neutral forex base. NOT a deploy
/// config: a measurement instrument for `scripts/steady_risk_grid.py`. The
/// debunked V5_FOREX_MR family baked per-asset `invert_direction` (USDJPY/
/// USDCAD = true) tuned for mean-reversion — which CONTAMINATES any other
/// `--signals` mode (a trend signal on an inverted pair tests anti-trend).
/// This base is fully NEUTRAL so `--signals trend|meanrev|breakout|regime|
/// forex-mr` each express their NATIVE signal direction, letting the
/// edge-detector measure each signal class's true expectancy on forex.
///
/// All 6 majors: invert_direction=false, bidirectional (long+short enabled),
/// forex costs (2bp commission / 1bp slippage / 1bp-per-day swap), PASSLOCK +
/// liveCaps inherited from the AMBER base. Moderate fixed tp/stop; ATR-stop
/// (56,2.0) + trailing handle volatility adaptivity. The edge-detector scales
/// position size via --risk-frac-mult, so absolute tp/stop only set trade
/// structure — the SIGN of net drift is what the probe reads.
fn forex_neutralize(cfg: &mut EngineConfig, tp: f64, stop: f64) {
    for a in cfg.assets.iter_mut() {
        a.invert_direction = false;
        a.disable_short = false;
        a.disable_long = false;
        a.tp_pct = Some(tp);
        a.stop_pct = Some(stop);
        // keep forex cost_bp/slippage_bp/swap_bp_per_day from the MR base
    }
    cfg.invert_direction = false;
}

/// 2h neutral forex substrate (2yr data: scripts/cache_forex_2h_split).
pub fn v5_forex_neutral_2h() -> EngineConfig {
    let mut cfg = v5_forex_mr_passlock(); // 6 majors + forex costs + PASSLOCK + bar_minutes=120
    cfg.label = "V5_FOREX_NEUTRAL_2H".into();
    forex_neutralize(&mut cfg, 0.025, 0.015);
    // bar_minutes=120, hold_bars=120, allowed_hours_utc=None already set by MR base.
    // forex-mr signal params (wall-clock 10d BB / 2d cooldown on 2h bars):
    cfg.mean_reversion_source = Some(crate::config::MeanReversionSource {
        period: 60,
        oversold: 20.0,
        overbought: 80.0,
        cooldown_bars: 24,
        size_mult: 1.0,
    });
    cfg
}

/// 2026-06-07 GOLD edge-detector substrate. Single asset (PAXG gold proxy,
/// scripts/cache_forex_indices/GOLD_daily.json). Literature flags commodity/
/// gold trend as the strongest price-only candidate (Lempériere et al.: gold
/// trend Sharpe ~0.8, de-biased ~0.33 vs FX ~0.05). Neutral/bidirectional so
/// `--signals trend|breakout|meanrev` express native direction. Wider tp/stop
/// for gold's ~1.3%/day vol. NOT a deploy config — a measurement instrument.
pub fn v5_gold_neutral_daily() -> EngineConfig {
    let mut cfg = v5_forex_neutral_daily();
    cfg.label = "V5_GOLD_NEUTRAL_DAILY".into();
    cfg.assets = vec![AssetConfig {
        symbol: "GOLD".into(),
        source_symbol: Some("GOLD".into()),
        tp_pct: Some(0.04),
        stop_pct: Some(0.025),
        risk_frac: 0.4,
        invert_direction: false,
        disable_short: false,
        disable_long: false,
        trigger_bars: Some(1),
        cost_bp: Some(5.0),
        slippage_bp: Some(2.0),
        swap_bp_per_day: Some(1.0),
        ..AssetConfig::default()
    }];
    cfg.bar_minutes = 1440;
    cfg
}

/// daily neutral forex substrate (10yr data: scripts/cache_forex). The long
/// history is the project's best out-of-sample target for EDGE DETECTION
/// (the SIGN of expectancy needs many independent windows). NOTE: daily bars
/// understate the FTMO intraday DailyLoss rule (close-based MTM hides the
/// intrabar swing), so this substrate is for *edge presence*, not realistic
/// pass-rate — confirm any positive finding on the 2h substrate.
pub fn v5_forex_neutral_daily() -> EngineConfig {
    let mut cfg = v5_forex_neutral_2h();
    cfg.label = "V5_FOREX_NEUTRAL_DAILY".into();
    cfg.bar_minutes = 1440;
    cfg.hold_bars = 30; // 30 daily bars = 30 days max hold (let trends run)
                        // forex-mr params re-scaled to daily bars (10d BB / 2d cooldown):
    cfg.mean_reversion_source = Some(crate::config::MeanReversionSource {
        period: 10,
        oversold: 20.0,
        overbought: 80.0,
        cooldown_bars: 2,
        size_mult: 1.0,
    });
    cfg
}

/// 2026-05-23 V5_AMBER_MAX_PASSLOCK_SHORTS_ONLY — short-only variant
/// of V5_AMBER_MAX_PASSLOCK. Hypothesis: AMBER trades long-pullback-recovery
/// (invert_direction=true → engine longs when voters fire SHORT, in bearish
/// windows). BIDIR opens both sides. A pure SHORTS-only template removes
/// invert and only allows SHORT trades — projected corr -0.05 to -0.15 with
/// AMBER (Stack-5 uplift +4.5 to +5.5pp honest based on n=997 sister sweep).
///
/// Changes vs `v5_amber_max_passlock()`:
///   - per-asset `invert_direction: false`  (trade native voter direction)
///   - per-asset `disable_long: true`       (block longs)
///   - per-asset `disable_short: false`     (allow shorts)
///   - cfg `invert_direction: false`        (engine-level fallback)
///
/// All other AMBER_MAX stack (basket, per-asset TP, PASSLOCK, mct=10, hours,
/// risk caps, voters) is preserved so the only experimental variable is direction.
pub fn v5_amber_max_passlock_shorts_only() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_SHORTS_ONLY".into();
    for asset in cfg.assets.iter_mut() {
        asset.invert_direction = false;
        asset.disable_long = true;
        asset.disable_short = false;
    }
    cfg.invert_direction = false;
    cfg
}

/// 2026-05-19 V5_AMBER_MAX_MR_PASSLOCK — mean-revert (range-bound) variant
/// of V5_AMBER_MAX_PASSLOCK. Hypothesis: trend-following V5 plateaus at ~50%
/// uncond pass-rate because chop/range windows (the ~50% fail-bucket) are
/// structurally hostile to trend signals. A complementary RSI-MR signal on
/// the same engine stack should pass a *different* subset of windows,
/// enabling a 2-strategy ensemble with combined uncond ≥60%.
///
/// Changes vs `v5_amber_max_passlock()`:
///   - per-asset `invert_direction: false`  (vanilla MR signal direction)
///   - per-asset `disable_short: false`     (allow MR shorts on overbought)
///   - cfg `mean_reversion_source`: RSI(14), oversold 25 / overbought 75,
///     cooldown 8 bars, size_mult 0.5 — engine-default-equivalent so the
///     `--signals meanrev` path picks it up without CLI overrides.
///
/// All other AMBER_MAX stack (basket, per-asset TP, PASSLOCK, mct=10, hours,
/// risk caps) is preserved so the only experimental variable is signal type.
pub fn v5_amber_max_mr_passlock() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_MR_PASSLOCK".into();
    // Flip every asset out of the V5_TREND short-disabled / inverted layout
    // (set by `make_assets`) so MR longs/shorts pass through unmodified.
    for asset in cfg.assets.iter_mut() {
        asset.invert_direction = false;
        asset.disable_short = false;
    }
    // Engine-level fallback already off — keep it explicit.
    cfg.invert_direction = false;
    // Engine-default MR source. Matches the literal used in `sweep.rs`
    // (SignalSrc::MeanRev fallback) so passing `--signals meanrev` without
    // overrides reproduces this template's intent.
    cfg.mean_reversion_source = Some(crate::config::MeanReversionSource {
        period: 14,
        oversold: 25.0,
        overbought: 75.0,
        cooldown_bars: 8,
        size_mult: 0.5,
    });
    cfg
}

/// 2026-05-13 V5_AMBER_QUARTZ — AMBER assets + Quartz engine stack:
/// atrStop p56m2, chandelierExit p56m2 min_move_r=0.5, breakEven 3%,
/// PTP trigger=0.012 closeFraction=0.7. Hypothesis: AMBER's 15-asset basket
/// combined with QUARTZ's loss-distribution-improving engine stack lifts
/// PASSLOCK pass-rate above 60%.
pub fn v5_amber_quartz() -> EngineConfig {
    let mut cfg = v5_amber();
    cfg.label = "V5_AMBER_QUARTZ".into();
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 2.0,
    });
    cfg.chandelier_exit = Some(ChandelierExit {
        period: 56,
        mult: 2.0,
        min_move_r: Some(0.5),
    });
    cfg.break_even = Some(BreakEven { threshold: 0.03 });
    cfg.partial_take_profit = Some(PartialTakeProfit {
        trigger_pct: 0.012,
        close_fraction: 0.7,
    });
    cfg
}

/// 2026-05-13 V5_AMBER_QUARTZ + PASSLOCK.
pub fn v5_amber_quartz_passlock() -> EngineConfig {
    let mut cfg = v5_amber_quartz();
    cfg.label = "V5_AMBER_QUARTZ_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    cfg
}

/// 2026-05-13 V5_AMBER + BreakEven 3% only (isolate the BE contribution).
pub fn v5_amber_be_passlock() -> EngineConfig {
    let mut cfg = v5_amber();
    cfg.label = "V5_AMBER_BE_PASSLOCK".into();
    cfg.break_even = Some(BreakEven { threshold: 0.03 });
    cfg.close_all_on_target_reached = true;
    cfg
}

/// 2026-05-13 V5_AMBER + PTP only (isolate the PTP contribution).
pub fn v5_amber_ptp_passlock() -> EngineConfig {
    let mut cfg = v5_amber();
    cfg.label = "V5_AMBER_PTP_PASSLOCK".into();
    cfg.partial_take_profit = Some(PartialTakeProfit {
        trigger_pct: 0.012,
        close_fraction: 0.7,
    });
    cfg.close_all_on_target_reached = true;
    cfg
}

/// 2026-05-13 V5_AMBER + atrStop only (isolate the trailing-stop contribution).
pub fn v5_amber_atr_passlock() -> EngineConfig {
    let mut cfg = v5_amber();
    cfg.label = "V5_AMBER_ATR_PASSLOCK".into();
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 2.0,
    });
    cfg.close_all_on_target_reached = true;
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

/// 2026-05-12 V5_AMBER + PASSLOCK. Memory says V5_AMBER alone hit 62.83%
/// step=1d. Adding closeAllOnTargetReached typically yields +6-8pp on
/// PASSLOCK family, so worth a directed test for the 65% mandate.
pub fn v5_amber_passlock() -> EngineConfig {
    let mut cfg = v5_amber();
    cfg.label = "V5_AMBER_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    // 2026-05-16 Round 9 KRIT FIX (templates agent): TS reference at
    // ftmoDaytrade24h.ts:8691 sets atrStop {period:56, stopMult:2} for
    // AMBER_PASSLOCK. Rust port previously inherited atr_stop=None from
    // v5_titanium_base. Same strategy drift as v5_amber_max_passlock.
    cfg.atr_stop = Some(crate::config::AtrStop {
        period: 56,
        stop_mult: 2.0,
    });
    cfg
}

/// 2026-05-14 Detector #18 — V5_AMBER + PASSLOCK with the default
/// multi-level PTP ladder. Three tiers crammed below the per-asset tp_pct
/// (typical AMBER tp ≈ 0.04-0.06): scale-out 25% at +1.5%, another 30% at
/// +3%, and 45% at +4.5%. After the first realisation `exit.rs` shifts the
/// stop to cost-adjusted break-even, so subsequent tiers effectively trade
/// risk-free.
///
/// Single-tier `partial_take_profit` is explicitly cleared to prevent the
/// two PRE-cross PTP branches in `process_position_exit_with_held` from
/// stacking on the same bar.
pub fn v5_amber_passlock_mptp() -> EngineConfig {
    let mut cfg = v5_amber_passlock();
    cfg.label = "V5_AMBER_PASSLOCK_MPTP".into();
    cfg.partial_take_profit = None;
    cfg.partial_take_profit_levels = Some(vec![
        PartialTakeProfitLevel {
            trigger_pct: 0.015,
            close_fraction: 0.25,
        },
        PartialTakeProfitLevel {
            trigger_pct: 0.030,
            close_fraction: 0.30,
        },
        PartialTakeProfitLevel {
            trigger_pct: 0.045,
            close_fraction: 0.45,
        },
    ]);
    cfg
}

/// 2026-05-16 V04a — V5_AMBER_MAX_PASSLOCK + multi-tier PTP with tiers
/// UNDER per-asset tp_pct (most assets 0.020-0.025).
///
/// 50-agent brainstorm diagnosis: V04 catastrophic (-14pp Combined) because
/// tier-2 (3.0%) and tier-3 (4.5%) exceeded most assets' tp_pct (0.020),
/// so they never fired but tier-1 (1.5%) still scaled out 25% before TP.
/// Solution: tiers strictly UNDER lowest tp_pct. 40% close at 0.8%, 40% at
/// 1.5%, 20% runner — captures partial gains without decapitating winners.
pub fn v5_amber_max_passlock_mptp_v04a() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_MPTP_V04A".into();
    cfg.partial_take_profit = None;
    cfg.partial_take_profit_levels = Some(vec![
        PartialTakeProfitLevel {
            trigger_pct: 0.008,
            close_fraction: 0.40,
        },
        PartialTakeProfitLevel {
            trigger_pct: 0.015,
            close_fraction: 0.40,
        },
    ]);
    cfg
}

/// 2026-05-14 Detector #20 — V5_AMBER_PASSLOCK + 3-phase day-stage sizing
/// + equity-progress early-defensive override.
///
/// Phase 1 (day 0..2): aggressive 1.5× — fastest possible target run while
/// drawdown headroom is full.
/// Phase 2 (day 3..7): neutral 1.0× — once initial gains are realized.
/// Phase 3 (day 8+):   defensive 0.7× — preserve capital toward closeout.
///
/// Cross-cut: when realized equity already reflects 70% of profit_target
/// (e.g. +5.6% on a 8% target), switch to 0.5× immediately regardless of
/// day-stage. Lookahead-safe (uses realized equity only).
pub fn v5_amber_passlock_daystage() -> EngineConfig {
    use crate::config::{DayProgressiveTier, EarlyDefensiveOnProgress};
    let mut cfg = v5_amber_passlock();
    cfg.label = "V5_AMBER_PASSLOCK_DAYSTAGE".into();
    cfg.day_progressive_sizing = Some(vec![
        DayProgressiveTier {
            day_at_least: 0,
            factor: 1.5,
        },
        DayProgressiveTier {
            day_at_least: 3,
            factor: 1.0,
        },
        DayProgressiveTier {
            day_at_least: 8,
            factor: 0.7,
        },
    ]);
    cfg.early_defensive_on_progress = Some(EarlyDefensiveOnProgress {
        progress_frac: 0.7,
        factor: 0.5,
    });
    cfg
}

/// 2026-05-14 Detector #48 — V5_AMBER_PASSLOCK + Time-Decay Sizing.
///
/// Applies the default decay schedule (`decay=0.7`, `start_day=15`,
/// `min_factor=0.3`, mode=CapDown) on top of the AMBER_PASSLOCK basket.
/// Hypothesis: late-challenge bars carry the highest blow-up risk because
/// the FTMO trailing-equity rules trigger on the running peak — reducing
/// sizing as `state.day` approaches `max_days=30` should preserve realised
/// gains without forfeiting earlier compounding.
pub fn v5_amber_passlock_timedecay() -> EngineConfig {
    use crate::config::{TimeDecayMode, TimeDecaySizing};
    let mut cfg = v5_amber_passlock();
    cfg.label = "V5_AMBER_PASSLOCK_TIMEDECAY".into();
    cfg.time_decay_sizing = Some(TimeDecaySizing {
        decay: 0.7,
        start_day: 15,
        min_factor: 0.3,
        mode: TimeDecayMode::CapDown,
    });
    cfg
}

/// 2026-05-14 Detector #49 — V5_AMBER_PASSLOCK + Sharpe-ratio-optimized
/// sizing modifier.
///
/// Tiers chosen to bite progressively as recent Sharpe deteriorates:
///   sharpe ≥  0.30 → no-op (1.0 — cap-down only, so config harmless)
///   sharpe ≥  0.10 → 0.85
///   sharpe ≥ -0.10 → 0.60
///   sharpe ≥ -∞    → 0.40
///
/// Window 100 / min_trades 30 balances responsiveness against statistical
/// stability: at AMBER's typical ~3-5 trades/day on the 30m basket, 100
/// closed PnLs span ~3 weeks — enough samples for a meaningful mean/std
/// without lagging the regime indefinitely.
pub fn v5_amber_passlock_sharpe() -> EngineConfig {
    use crate::config::{SharpeSizing, SharpeTier};
    let mut cfg = v5_amber_passlock();
    cfg.label = "V5_AMBER_PASSLOCK_SHARPE".into();
    cfg.sharpe_sizing = Some(SharpeSizing {
        window_size: 100,
        min_trades: 30,
        tiers: vec![
            SharpeTier {
                sharpe_above: 0.30,
                multiplier: 1.0,
            },
            SharpeTier {
                sharpe_above: 0.10,
                multiplier: 0.85,
            },
            SharpeTier {
                sharpe_above: -0.10,
                multiplier: 0.60,
            },
            SharpeTier {
                sharpe_above: f64::NEG_INFINITY,
                multiplier: 0.40,
            },
        ],
    });
    cfg
}

/// 2026-05-16 V5_AMBER_MAX_PASSLOCK + Sharpe-Sizing with TIGHTER tiers.
///
/// 50-agent brainstorm finding: default Sharpe-tier thresholds (0.3/0.1/-0.1)
/// have most AMBER trades land in top-tier (1.0× = no-op) because AMBER
/// has 60%+ win-rate → rolling sharpe almost always > 0.3. Tightened
/// thresholds (0.5/0.3/0.1) force more bars into 0.8×/0.5× tiers,
/// modestly reducing risk on weak-Sharpe windows. window=60 + min_trades=20
/// for faster adaptation than baseline (100/30) which was too slow.
pub fn v5_amber_max_passlock_sharpe_tight() -> EngineConfig {
    use crate::config::{SharpeSizing, SharpeTier};
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_SHARPE_TIGHT".into();
    cfg.sharpe_sizing = Some(SharpeSizing {
        window_size: 60,
        min_trades: 20,
        tiers: vec![
            SharpeTier {
                sharpe_above: 0.50,
                multiplier: 1.0,
            },
            SharpeTier {
                sharpe_above: 0.30,
                multiplier: 0.80,
            },
            SharpeTier {
                sharpe_above: 0.10,
                multiplier: 0.50,
            },
            SharpeTier {
                sharpe_above: f64::NEG_INFINITY,
                multiplier: 0.30,
            },
        ],
    });
    cfg
}

/// 2026-05-12 V5_TOPAZ + PASSLOCK. V5_TOPAZ = V5_QUARTZ - RUNE (14 assets,
/// QUARTZ engine stack with atrStop p56m2 + chandelier p56m2 + breakEven).
pub fn v5_topaz_passlock() -> EngineConfig {
    let mut cfg = v5_topaz();
    cfg.label = "V5_TOPAZ_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    cfg
}

/// 2026-05-13 V5_RUBIN — V5_TOPAZ + INJ tp 0.045 → 0.050. Cache: 64.40%
/// step=3d / 61.74% step=1d / wr 86.72% / TL 0. Source: ftmoDaytrade24h.ts:
/// FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN.
pub fn v5_rubin() -> EngineConfig {
    let mut cfg = v5_topaz();
    cfg.label = "V5_RUBIN".into();
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(v5_rubin_tp_for(&asset.symbol));
    }
    cfg
}

/// 2026-05-13 V5_RUBIN + PASSLOCK — closeAllOnTargetReached. Honest target ≥65%.
pub fn v5_rubin_passlock() -> EngineConfig {
    let mut cfg = v5_rubin();
    cfg.label = "V5_RUBIN_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    cfg
}

/// 2026-05-13 V5_SAPPHIR — V5_RUBIN + DOT/TRX/ALGO/NEAR (18 assets). Cache:
/// 66.85% step=3d / 64.73% step=1d / wr 87.65% / TL 0 (best in V5 family on
/// these dimensions per ftmoDaytrade24h.ts:7510-7522).
pub fn v5_sapphir() -> EngineConfig {
    let mut cfg = v5_rubin();
    cfg.label = "V5_SAPPHIR".into();
    let mut extra = make_assets(V5_SAPPHIR_NEW_ASSETS, 0.4);
    for asset in extra.iter_mut() {
        asset.tp_pct = Some(v5_sapphir_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
        asset.hold_bars = Some(240);
    }
    cfg.assets.extend(extra);
    cfg
}

/// 2026-05-13 V5_SAPPHIR + PASSLOCK — primary 65%-mandate candidate.
pub fn v5_sapphir_passlock() -> EngineConfig {
    let mut cfg = v5_sapphir();
    cfg.label = "V5_SAPPHIR_PASSLOCK".into();
    cfg.close_all_on_target_reached = true;
    cfg
}

/// 2026-05-13 V5_DIAMOND — V5_SAPPHIR + ATOM/LINK/SOL/STX/UNI (23 assets).
/// Extension over SAPPHIR's basket; new assets default tp 0.020, hold 240.
pub fn v5_diamond() -> EngineConfig {
    let mut cfg = v5_sapphir();
    cfg.label = "V5_DIAMOND".into();
    let mut extra = make_assets(V5_DIAMOND_NEW_ASSETS, 0.4);
    for asset in extra.iter_mut() {
        asset.tp_pct = Some(v5_diamond_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
        asset.hold_bars = Some(240);
    }
    cfg.assets.extend(extra);
    cfg
}

/// 2026-05-13 V5_DIAMOND + PASSLOCK — secondary 65%-mandate candidate
/// with 23-asset universe diversification.
pub fn v5_diamond_passlock() -> EngineConfig {
    let mut cfg = v5_diamond();
    cfg.label = "V5_DIAMOND_PASSLOCK".into();
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

/// R29-5M baseline — V5_TITANIUM_PASSLOCK shape but with periods scaled
/// to 5m bars (×6 vs 30m). Mostly a starting point for 5m sweeps;
/// untuned vs 30m-native params.
///
/// Scaling rationale:
///   - 30m has 48 bars/day, 5m has 288 → ratio 6
///   - hold_bars 240 (=5 days @ 30m) → 1440 (=5 days @ 5m)
///   - All else unchanged: tp 4%, stop 5%, leverage 2x, MCT 6
/// 2026-05-25 Wave5 — AMBER_MAX_PASSLOCK on 5m bars (Path B: faster decisions).
/// 6× more bars/day → more entry opportunities, potentially +2-5pp Stack-lift.
/// Risk: spreads + commissions eat per-trade PnL on shorter timeframe.
pub fn v5_amber_max_passlock_5m() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_5M".into();
    cfg.bar_minutes = 5;
    cfg.hold_bars = 720; // 30m × 120 / 5 = 720 bars (= 2.5d on 5m)
    for asset in cfg.assets.iter_mut() {
        if asset.hold_bars.is_some() {
            asset.hold_bars = Some(720);
        }
    }
    cfg
}

/// 2026-05-25 Wave5 — Mixed-V4 CVD-only on 5m bars (current solo champion 11%).
pub fn v5_amber_max_passlock_mixed_v4_cvd_only_5m() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_mixed_v4_cvd_only();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_MIXED_V4_CVD_ONLY_5M".into();
    cfg.bar_minutes = 5;
    cfg.hold_bars = 720;
    for asset in cfg.assets.iter_mut() {
        if asset.hold_bars.is_some() {
            asset.hold_bars = Some(720);
        }
    }
    cfg
}

/// 2026-05-25 Wave5 — Mixed-V2 on 5m bars.
pub fn v5_amber_max_passlock_mixed_v2_5m() -> EngineConfig {
    let mut cfg = v5_amber_max_passlock_mixed_v2();
    cfg.label = "V5_AMBER_MAX_PASSLOCK_MIXED_V2_5M".into();
    cfg.bar_minutes = 5;
    cfg.hold_bars = 720;
    for asset in cfg.assets.iter_mut() {
        if asset.hold_bars.is_some() {
            asset.hold_bars = Some(720);
        }
    }
    cfg
}

pub fn v5_titanium_passlock_5m() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_5M".into();
    cfg.hold_bars = 1440; // 5 days × 288 5m-bars
                          // R29-R3.2: tells detectors to scale bar-counted periods (SMA fast/slow,
                          // CVD lookback, prior-N return) by 30/5 = 6× so a 5m run sees the same
                          // wall-clock window the 30m baseline was tuned for.
    cfg.bar_minutes = 5;
    for asset in cfg.assets.iter_mut() {
        if asset.hold_bars.is_some() {
            asset.hold_bars = Some(1440);
        }
    }
    cfg
}

/// R29-Hunter — 65%+ pass-rate hunt winner (2026-05-09).
///
/// Discovery via mass parameter sweep on V5_TITANIUM_PASSLOCK:
///   1. Greedy basket prune: drop {DOGE,ETH,INJ,ADA,RUNE} → 9 assets
///   2. Tighter trail: trailPct 0.005 → 0.001 (lock more profit per peak)
///   3. Hours subset: drop hours 8 & 12 (low-conviction trade hours)
///   4. ETC tp_pct 0.035 → 0.020 (asset-level greedy refinement)
///
/// Pass-rate (Rust, post-Phase-4 engine): **66.14%** on step=14d / 127 windows.
/// Cross-step robustness:
///   step=3d  : 53.25%
///   step=7d  : 58.10%
///   step=14d : 66.14%  ← canonical
///   step=21d : 57.65%
///   step=28d : 64.06%
///
/// Multi-step variance is expected: hour mask correlates with step phase.
/// step=14d is the same measurement basis as the post-Phase-4 baseline 55.12%
/// (TS-honest 55.56%) so the +11.02pp gain is on parity ground.
///
/// Live deploy considerations:
///   - 9-asset basket reduces correlation tail-risk vs 14
///   - tighter trailing-stop = less give-back at peak
///   - hour mask reduces noise around 8 & 12 UTC
pub fn v5_titanium_passlock_hunter() -> EngineConfig {
    let mut cfg = v5_titanium_passlock();
    cfg.label = "V5_TITANIUM_PASSLOCK_HUNTER".into();
    // 9-asset basket: drop DOGE, ETH, INJ, ADA, RUNE
    cfg.assets.retain(|a| {
        !matches!(
            a.symbol.as_str(),
            "DOGE-TREND" | "ETH-TREND" | "INJ-TREND" | "ADA-TREND" | "RUNE-TREND"
        )
    });
    // Hours subset (drop 8 & 12)
    cfg.allowed_hours_utc = Some(vec![2, 4, 6, 10, 14, 18, 20, 22]);
    // Tighter trail
    cfg.trailing_stop = Some(TrailingStop {
        activate_pct: 0.03,
        trail_pct: 0.001,
    });
    // ETC asset-level tp override 0.035 → 0.020.
    for asset in cfg.assets.iter_mut() {
        if asset.symbol == "ETC-TREND" {
            asset.tp_pct = Some(0.020);
        }
    }
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
        asset.vol_imbalance_entry = Some(crate::config::VolImbalanceEntry { long_min: 0.62 });
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
        "2h-trend-v5-amber-passlock" => v5_amber_passlock(),
        "2h-trend-v5-amber-passlock-daystage" => v5_amber_passlock_daystage(),
        "2h-trend-v5-amber-passlock-mptp" => v5_amber_passlock_mptp(),
        "2h-trend-v5-amber-passlock-timedecay" => v5_amber_passlock_timedecay(),
        "2h-trend-v5-amber-passlock-sharpe" => v5_amber_passlock_sharpe(),
        "2h-trend-v5-topaz-passlock" => v5_topaz_passlock(),
        "2h-trend-v5-rubin" => v5_rubin(),
        "2h-trend-v5-rubin-passlock" => v5_rubin_passlock(),
        "2h-trend-v5-sapphir" => v5_sapphir(),
        "2h-trend-v5-sapphir-passlock" => v5_sapphir_passlock(),
        "2h-trend-v5-diamond" => v5_diamond(),
        "2h-trend-v5-diamond-passlock" => v5_diamond_passlock(),
        "2h-trend-v5-amber-ext" => v5_amber_ext(),
        "2h-trend-v5-amber-ext-passlock" => v5_amber_ext_passlock(),
        "2h-trend-v5-amber-max" => v5_amber_max(),
        "2h-trend-v5-amber-max-passlock" => v5_amber_max_passlock(),
        "2h-trend-v5-amber-max-passlock-step2" => v5_amber_max_passlock_step2(),
        "2h-trend-v5-amber-max-passlock-bidir" => v5_amber_max_passlock_bidir(),
        "2h-trend-v5-amber-max-passlock-bidir-mutex" => v5_amber_max_passlock_bidir_mutex(),
        "2h-trend-v5-amber-max-passlock-risk05" => v5_amber_max_passlock_risk_05(),
        "2h-trend-v5-amber-max-passlock-risk06" => v5_amber_max_passlock_risk_06(),
        "2h-trend-v5-amber-max-passlock-aggressive" => v5_amber_max_passlock_aggressive(),
        "2h-trend-v5-amber-max-passlock-fully-loaded" => v5_amber_max_passlock_fully_loaded(),
        "2h-trend-v5-amber-max-passlock-aggressive-24h" => v5_amber_max_passlock_aggressive_24h(),
        "2h-trend-v5-amber-max-passlock-aggressive-mct50" => {
            v5_amber_max_passlock_aggressive_mct50()
        }
        "2h-trend-v5-amber-max-passlock-aggressive-be" => v5_amber_max_passlock_aggressive_be(),
        "2h-trend-v5-amber-max-passlock-aggressive-24h-adaptive" => {
            v5_amber_max_passlock_aggressive_24h_adaptive()
        }
        "2h-trend-v5-amber-max-passlock-aggressive-24h-kelly" => {
            v5_amber_max_passlock_aggressive_24h_kelly()
        }
        "2h-trend-v5-amber-max-passlock-aggressive-24h-kelly-reentry" => {
            v5_amber_max_passlock_aggressive_24h_kelly_reentry()
        }
        "2h-trend-v5-amber-max-passlock-mixed-detectors" => v5_amber_max_passlock_mixed_detectors(),
        "2h-trend-v5-amber-max-passlock-agg-24h-kr-pyramid" => {
            v5_amber_max_passlock_aggressive_24h_kelly_reentry_pyramid()
        }
        "2h-trend-v5-amber-max-passlock-mixed-v2" => v5_amber_max_passlock_mixed_v2(),
        "2h-trend-v5-amber-max-passlock-mixed-v3" => v5_amber_max_passlock_mixed_v3(),
        "2h-trend-v5-amber-max-passlock-mixed-v4-cvd-only" => {
            v5_amber_max_passlock_mixed_v4_cvd_only()
        }
        "2h-trend-v5-amber-max-passlock-agg-kr-tight-stop" => {
            v5_amber_max_passlock_agg_kr_tight_stop()
        }
        "2h-trend-v5-amber-max-passlock-agg-kr-wide-stop" => {
            v5_amber_max_passlock_agg_kr_wide_stop()
        }
        "2h-trend-v5-amber-max-passlock-agg-kr-high-tp" => v5_amber_max_passlock_agg_kr_high_tp(),
        "2h-trend-v5-amber-max-passlock-agg-kr-low-tp" => v5_amber_max_passlock_agg_kr_low_tp(),
        "2h-trend-v5-amber-max-passlock-agg-kr-adaptive" => v5_amber_max_passlock_agg_kr_adaptive(),
        "2h-trend-v5-amber-max-passlock-agg-kr-chandelier" => {
            v5_amber_max_passlock_agg_kr_chandelier()
        }
        "2h-trend-v5-amber-max-passlock-agg-kr-ptp" => v5_amber_max_passlock_agg_kr_ptp(),
        "2h-trend-v5-amber-max-passlock-agg-kr-be-early" => v5_amber_max_passlock_agg_kr_be_early(),
        "2h-trend-v5-amber-max-passlock-shorts-agg" => v5_amber_max_passlock_shorts_agg(),
        "2h-trend-v5-amber-max-passlock-agg-kr-hold120" => v5_amber_max_passlock_agg_kr_hold_120(),
        "2h-trend-v5-amber-max-passlock-agg-kr-combo" => v5_amber_max_passlock_agg_kr_combo(),
        "2h-trend-v5-amber-max-passlock-p2-grinder" => v5_amber_max_passlock_p2_grinder(),
        "2h-trend-v5-amber-max-passlock-p2-defender" => v5_amber_max_passlock_p2_defender(),
        "2h-trend-v5-amber-max-passlock-scheduled-split" => v5_amber_max_passlock_scheduled_split(),
        "2h-trend-v5-amber-max-passlock-bidir-safe" => v5_amber_max_passlock_bidir_safe(),
        "2h-trend-v5-amber-max-passlock-hold480" => v5_amber_max_passlock_hold_480(),
        "2h-trend-v5-amber-max-passlock-hold720" => v5_amber_max_passlock_hold_720(),
        "2h-trend-v5-amber-max-passlock-amber-plus-shorts" => {
            v5_amber_max_passlock_amber_plus_shorts()
        }
        "2h-trend-v5-amber-max-passlock-shorts-only" => v5_amber_max_passlock_shorts_only(),
        "v5-forex-mr-passlock" => v5_forex_mr_passlock(),
        "v5-forex-mr-passlock-agg" => v5_forex_mr_passlock_agg(),
        "v5-forex-mr-passlock-big" => v5_forex_mr_passlock_big(),
        "v5-forex-mr-passlock-huge" => v5_forex_mr_passlock_huge(),
        "v5-forex-mr-passlock-agg-narrow" => v5_forex_mr_passlock_agg_narrow(),
        "v5-forex-mr-passlock-tight-stop" => v5_forex_mr_passlock_tight_stop(),
        "v5-forex-mr-passlock-huge-tight" => v5_forex_mr_passlock_huge_tight(),
        "v5-forex-neutral-2h" => v5_forex_neutral_2h(),
        "v5-forex-neutral-daily" => v5_forex_neutral_daily(),
        "v5-gold-neutral-daily" => v5_gold_neutral_daily(),
        "2h-trend-v5-amber-max-passlock-intraday-us-peak" => {
            v5_amber_max_passlock_intraday_us_peak()
        }
        "2h-trend-v5-amber-max-passlock-intraday-liquid" => v5_amber_max_passlock_intraday_liquid(),
        "2h-trend-v5-amber-max-passlock-intraday-ny-only" => {
            v5_amber_max_passlock_intraday_ny_only()
        }
        "2h-trend-v5-amber-max-passlock-intraday-asia-avoid" => {
            v5_amber_max_passlock_intraday_asia_avoid()
        }
        "2h-trend-v5-amber-max-passlock-intraday-4anchor" => {
            v5_amber_max_passlock_intraday_4anchor()
        }
        "2h-trend-v5-amber-max-passlock-mptp-v04a" => v5_amber_max_passlock_mptp_v04a(),
        "2h-trend-v5-amber-max-passlock-sharpe-tight" => v5_amber_max_passlock_sharpe_tight(),
        "2h-trend-v5-amber-max-mr-passlock" => v5_amber_max_mr_passlock(),
        "2h-trend-v5-amber-quartz" => v5_amber_quartz(),
        "2h-trend-v5-amber-quartz-passlock" => v5_amber_quartz_passlock(),
        "2h-trend-v5-amber-be-passlock" => v5_amber_be_passlock(),
        "2h-trend-v5-amber-ptp-passlock" => v5_amber_ptp_passlock(),
        "2h-trend-v5-amber-atr-passlock" => v5_amber_atr_passlock(),
        "2h-trend-v5-titanium-passlock-lscool-tight" => v5_titanium_passlock_lscool_tight(),
        "2h-trend-v5-titanium-passlock-lscool-loose" => v5_titanium_passlock_lscool_loose(),
        "2h-trend-v5-titanium-passlock-mct5" => v5_titanium_passlock_mct5(),
        "2h-trend-v5-titanium-passlock-corrcap2" => v5_titanium_passlock_corrcap2(),
        "2h-trend-v5-titanium-passlock-todcut18" => v5_titanium_passlock_todcut18(),
        // R29-Hunter (2026-05-09 mass-sweep winner @ step=14d 66.14%)
        "2h-trend-v5-titanium-passlock-hunter" => v5_titanium_passlock_hunter(),
        "2h-trend-v5-titanium-passlock-5m" => v5_titanium_passlock_5m(),
        "2h-trend-v5-amber-max-passlock-5m" => v5_amber_max_passlock_5m(),
        "2h-trend-v5-amber-max-passlock-mixed-v4-cvd-only-5m" => {
            v5_amber_max_passlock_mixed_v4_cvd_only_5m()
        }
        "2h-trend-v5-amber-max-passlock-mixed-v2-5m" => v5_amber_max_passlock_mixed_v2_5m(),
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
        "2h-trend-v5-amber-passlock",
        "2h-trend-v5-amber-passlock-daystage",
        "2h-trend-v5-amber-passlock-mptp",
        "2h-trend-v5-amber-passlock-timedecay",
        "2h-trend-v5-amber-passlock-sharpe",
        "2h-trend-v5-topaz",
        "2h-trend-v5-topaz-passlock",
        "2h-trend-v5-rubin",
        "2h-trend-v5-rubin-passlock",
        "2h-trend-v5-sapphir",
        "2h-trend-v5-sapphir-passlock",
        "2h-trend-v5-diamond",
        "2h-trend-v5-diamond-passlock",
        "2h-trend-v5-amber-ext",
        "2h-trend-v5-amber-ext-passlock",
        "2h-trend-v5-amber-max",
        "2h-trend-v5-amber-max-passlock",
        "2h-trend-v5-amber-max-passlock-bidir",
        "2h-trend-v5-amber-max-passlock-bidir-mutex",
        "2h-trend-v5-amber-max-passlock-risk05",
        "2h-trend-v5-amber-max-passlock-risk06",
        "2h-trend-v5-amber-max-passlock-aggressive",
        "2h-trend-v5-amber-max-passlock-fully-loaded",
        "2h-trend-v5-amber-max-passlock-aggressive-24h",
        "2h-trend-v5-amber-max-passlock-aggressive-mct50",
        "2h-trend-v5-amber-max-passlock-aggressive-be",
        "2h-trend-v5-amber-max-passlock-aggressive-24h-adaptive",
        "2h-trend-v5-amber-max-passlock-aggressive-24h-kelly",
        "2h-trend-v5-amber-max-passlock-aggressive-24h-kelly-reentry",
        "2h-trend-v5-amber-max-passlock-mixed-detectors",
        "2h-trend-v5-amber-max-passlock-agg-24h-kr-pyramid",
        "2h-trend-v5-amber-max-passlock-mixed-v2",
        "2h-trend-v5-amber-max-passlock-mixed-v3",
        "2h-trend-v5-amber-max-passlock-mixed-v4-cvd-only",
        "2h-trend-v5-amber-max-passlock-agg-kr-tight-stop",
        "2h-trend-v5-amber-max-passlock-agg-kr-wide-stop",
        "2h-trend-v5-amber-max-passlock-agg-kr-high-tp",
        "2h-trend-v5-amber-max-passlock-agg-kr-low-tp",
        "2h-trend-v5-amber-max-passlock-agg-kr-adaptive",
        "2h-trend-v5-amber-max-passlock-agg-kr-chandelier",
        "2h-trend-v5-amber-max-passlock-agg-kr-ptp",
        "2h-trend-v5-amber-max-passlock-agg-kr-be-early",
        "2h-trend-v5-amber-max-passlock-shorts-agg",
        "2h-trend-v5-amber-max-passlock-agg-kr-hold120",
        "2h-trend-v5-amber-max-passlock-agg-kr-combo",
        "2h-trend-v5-amber-max-passlock-p2-grinder",
        "2h-trend-v5-amber-max-passlock-p2-defender",
        "2h-trend-v5-amber-max-passlock-scheduled-split",
        "2h-trend-v5-amber-max-passlock-bidir-safe",
        "2h-trend-v5-amber-max-passlock-hold480",
        "2h-trend-v5-amber-max-passlock-hold720",
        "2h-trend-v5-amber-max-passlock-amber-plus-shorts",
        "2h-trend-v5-amber-max-passlock-shorts-only",
        "v5-forex-mr-passlock",
        "v5-forex-mr-passlock-agg",
        "v5-forex-mr-passlock-big",
        "v5-forex-mr-passlock-huge",
        "v5-forex-mr-passlock-agg-narrow",
        "v5-forex-mr-passlock-tight-stop",
        "v5-forex-mr-passlock-huge-tight",
        "v5-forex-neutral-2h",
        "v5-forex-neutral-daily",
        "v5-gold-neutral-daily",
        "2h-trend-v5-amber-max-passlock-intraday-us-peak",
        "2h-trend-v5-amber-max-passlock-intraday-liquid",
        "2h-trend-v5-amber-max-passlock-intraday-ny-only",
        "2h-trend-v5-amber-max-passlock-intraday-asia-avoid",
        "2h-trend-v5-amber-max-passlock-intraday-4anchor",
        "2h-trend-v5-amber-max-mr-passlock",
        "2h-trend-v5-amber-quartz",
        "2h-trend-v5-amber-quartz-passlock",
        "2h-trend-v5-amber-be-passlock",
        "2h-trend-v5-amber-ptp-passlock",
        "2h-trend-v5-amber-atr-passlock",
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
        // R29-Hunter
        "2h-trend-v5-titanium-passlock-hunter",
        // R29 5m
        "2h-trend-v5-titanium-passlock-5m",
        "2h-trend-v5-amber-max-passlock-5m",
        "2h-trend-v5-amber-max-passlock-mixed-v4-cvd-only-5m",
        "2h-trend-v5-amber-max-passlock-mixed-v2-5m",
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
        assert_eq!(
            cfg.assets.len(),
            15,
            "V5_AMBER = OBSIDIAN basket (TITANIUM + ARB)"
        );
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
        assert!(
            cfg.atr_stop.is_some(),
            "V5_TOPAZ inherits QUARTZ engine stack"
        );
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
        let lsc = cfg
            .loss_streak_cooldown
            .expect("must set lossStreakCooldown");
        assert_eq!(lsc.after_losses, 1);
        assert_eq!(lsc.cooldown_bars, 400);
        assert!(cfg.close_all_on_target_reached);
    }

    #[test]
    fn v5_titanium_passlock_lscool_loose_sets_cooldown() {
        let cfg = v5_titanium_passlock_lscool_loose();
        let lsc = cfg
            .loss_streak_cooldown
            .expect("must set lossStreakCooldown");
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
            assert!(
                (ts.activate_pct - 0.03).abs() < 1e-12,
                "{}: activate_pct",
                cfg.label
            );
            assert!(
                (ts.trail_pct - 0.005).abs() < 1e-12,
                "{}: trail_pct",
                cfg.label
            );
        }
    }

    #[test]
    fn hunter_template_winner_shape() {
        let cfg = v5_titanium_passlock_hunter();
        assert_eq!(cfg.label, "V5_TITANIUM_PASSLOCK_HUNTER");
        assert!(
            cfg.close_all_on_target_reached,
            "PASSLOCK semantic preserved"
        );
        assert_eq!(cfg.assets.len(), 9, "9-asset basket");
        for forbidden in &[
            "DOGE-TREND",
            "ETH-TREND",
            "INJ-TREND",
            "ADA-TREND",
            "RUNE-TREND",
        ] {
            assert!(
                !cfg.assets.iter().any(|a| a.symbol == *forbidden),
                "{forbidden} must be dropped"
            );
        }
        assert_eq!(
            cfg.allowed_hours_utc.as_ref().unwrap(),
            &vec![2u32, 4, 6, 10, 14, 18, 20, 22],
            "hours subset (drop 8,12)"
        );
        let trail = cfg.trailing_stop.expect("trailing_stop must be set");
        assert!((trail.activate_pct - 0.03).abs() < 1e-12);
        assert!((trail.trail_pct - 0.001).abs() < 1e-12, "tighter trail");
        let etc = cfg
            .assets
            .iter()
            .find(|a| a.symbol == "ETC-TREND")
            .expect("ETC must remain in basket");
        assert!((etc.tp_pct.unwrap() - 0.020).abs() < 1e-12, "ETC tp 0.020");
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
    fn rubin_sapphir_selectors_resolve_and_shape() {
        for s in &[
            "2h-trend-v5-rubin",
            "2h-trend-v5-rubin-passlock",
            "2h-trend-v5-sapphir",
            "2h-trend-v5-sapphir-passlock",
        ] {
            assert!(
                template_by_selector(s).is_some(),
                "RUBIN/SAPPHIR selector {s:?} did not resolve"
            );
        }
        // V5_RUBIN: same 14 assets as TOPAZ, INJ tp 0.050
        let rubin = v5_rubin();
        assert_eq!(rubin.assets.len(), 14);
        let inj = rubin
            .assets
            .iter()
            .find(|a| a.symbol == "INJ-TREND")
            .expect("INJ in RUBIN");
        assert!((inj.tp_pct.unwrap() - 0.050).abs() < 1e-12, "INJ tp 0.050");
        // V5_RUBIN_PASSLOCK carries PASSLOCK flag
        assert!(v5_rubin_passlock().close_all_on_target_reached);
        // V5_SAPPHIR: 18 assets (14 + DOT/TRX/ALGO/NEAR), new ones tp 0.020
        let sapphir = v5_sapphir();
        assert_eq!(sapphir.assets.len(), 18);
        for new_sym in &["DOT-TREND", "TRX-TREND", "ALGO-TREND", "NEAR-TREND"] {
            let a = sapphir
                .assets
                .iter()
                .find(|a| a.symbol == *new_sym)
                .unwrap_or_else(|| panic!("{new_sym} missing"));
            assert!(
                (a.tp_pct.unwrap() - 0.020).abs() < 1e-12,
                "{new_sym} tp 0.020"
            );
            assert_eq!(a.hold_bars, Some(240), "{new_sym} hold_bars 240");
            assert!(a.invert_direction, "{new_sym} invert_direction");
            assert!(a.disable_short, "{new_sym} disable_short");
        }
        assert!(v5_sapphir_passlock().close_all_on_target_reached);
    }

    #[test]
    fn selector_resolution() {
        assert_eq!(
            template_by_selector("2h-trend-v5-r28-v6-passlock")
                .unwrap()
                .label,
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
        assert!(
            (mild
                .funding_rate_filter
                .unwrap()
                .max_funding_for_long
                .unwrap()
                - 0.001)
                .abs()
                < 1e-12
        );
        assert!(
            (strict
                .funding_rate_filter
                .unwrap()
                .max_funding_for_long
                .unwrap()
                - 0.0003)
                .abs()
                < 1e-12
        );
    }

    #[test]
    fn frmed_selector_resolves() {
        let cfg = template_by_selector("r28_v6_passlock_frmed").unwrap();
        assert_eq!(cfg.label, "R28_V6_PASSLOCK_FRMED");
        assert!(cfg.funding_rate_filter.is_some());
    }

    // ========================================================================
    // 2026-05-23 Wave1 audit fix: regression tests for 4 newest templates +
    // 2 engine flags. Previously had ZERO coverage on this session's shipped
    // features. Each test pins the structural invariants — anyone refactoring
    // the templates later gets immediate signal if they break the intent.
    // ========================================================================

    #[test]
    fn shorts_only_template_is_shorts_only() {
        let cfg = v5_amber_max_passlock_shorts_only();
        assert_eq!(cfg.label, "V5_AMBER_MAX_PASSLOCK_SHORTS_ONLY");
        assert!(cfg.close_all_on_target_reached, "PASSLOCK lineage");
        // All assets must reject longs + allow shorts + NOT invert direction
        for a in cfg.assets.iter() {
            assert!(a.disable_long, "{}: must disable_long", a.symbol);
            assert!(!a.disable_short, "{}: must allow shorts", a.symbol);
            assert!(!a.invert_direction, "{}: must NOT invert", a.symbol);
        }
        assert!(!cfg.invert_direction, "engine-level invert must be off");
    }

    #[test]
    fn bidir_template_allows_both_sides() {
        let cfg = v5_amber_max_passlock_bidir();
        assert_eq!(cfg.label, "V5_AMBER_MAX_PASSLOCK_BIDIR");
        assert!(cfg.close_all_on_target_reached);
        // BIDIR keeps AMBER's invert=true but flips disable_short=false so
        // both inverted-long AND inverted-short signals can fire.
        for a in cfg.assets.iter() {
            assert!(a.invert_direction, "{}: AMBER invert", a.symbol);
            assert!(!a.disable_short, "{}: shorts enabled", a.symbol);
            assert!(!a.disable_long, "{}: longs enabled", a.symbol);
        }
    }

    #[test]
    fn regime_flip_close_opposite_flag_defaults_off() {
        // Default must be FALSE so existing templates unchanged. Flag is
        // opt-in via template-mutator; activating in a fresh config is the
        // whitelist check.
        let cfg = v5_amber_max_passlock();
        assert!(
            !cfg.regime_flip_close_opposite,
            "default-off; only opt-in templates may enable"
        );
    }

    #[test]
    fn mutex_long_short_flag_defaults_off() {
        // Same default-off invariant for the position-level mutex flag.
        let cfg = v5_amber_max_passlock();
        assert!(
            !cfg.mutex_long_short,
            "default-off; only opt-in templates may enable"
        );
    }

    #[test]
    fn forex_mr_passlock_basket_and_invariants() {
        let cfg = v5_forex_mr_passlock();
        assert_eq!(cfg.label, "V5_FOREX_MR_PASSLOCK");
        assert!(cfg.close_all_on_target_reached);
        assert_eq!(cfg.assets.len(), 6, "EUR/GBP/JPY/CAD/AUD/NZD");
        // 2026-05-24 forex template re-tuned for 2h-bar data (scripts/cache_forex_2h/)
        // since no daily-bar forex cache exists. Wall-clock window semantics
        // preserved via BB period 60 (= 10d × 12 bars/day).
        assert_eq!(cfg.bar_minutes, 120, "2h TF (matches forex_2h.json cache)");
        // JPY/CAD pairs must invert (reverse-MR character documented in
        // signals_forex_mr.rs).
        let jpy = cfg.assets.iter().find(|a| a.symbol == "USDJPY-MR").unwrap();
        assert!(jpy.invert_direction, "USDJPY must invert");
        let cad = cfg.assets.iter().find(|a| a.symbol == "USDCAD-MR").unwrap();
        assert!(cad.invert_direction, "USDCAD must invert");
        // Pairs NOT in the invert list must trade native direction.
        let eur = cfg.assets.iter().find(|a| a.symbol == "EURUSD-MR").unwrap();
        assert!(!eur.invert_direction, "EURUSD must NOT invert");
    }
}
