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
    AssetConfig, BreakEven, ChandelierExit, EngineConfig, LiveCaps, PartialTakeProfit,
    PeakDrawdownThrottle, PeakTrailingStop,
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

const V5_TITANIUM_BASKET: &[&str] = &[
    "BTC-TREND",
    "ETH-TREND",
    "BNB-TREND",
    "ADA-TREND",
    "LTC-TREND",
    "BCH-TREND",
    "ETC-TREND",
    "XRP-TREND",
    "AAVE-TREND",
    "SOL-TREND",
    "DOGE-TREND",
    "LINK-TREND",
    "AVAX-TREND",
    "RUNE-TREND",
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

/// Per-asset tp_pct for V5_TITANIUM expansion (4 extra assets vs R28_V6).
/// Values inherited from V5_DIAMOND base (ftmoDaytrade24h.ts:V5_DIAMOND):
///   SOL/DOGE/LINK/AVAX/RUNE  : 0.04 base × 0.55 = 0.022
fn v5_titanium_tp_for(symbol: &str) -> f64 {
    match symbol {
        // R28_V6 cohort uses same numbers
        "BTC-TREND" | "BNB-TREND" | "ADA-TREND" | "BCH-TREND" | "ETC-TREND" => 0.00825,
        "ETH-TREND" => 0.011,
        "AAVE-TREND" => 0.01375,
        "XRP-TREND" => 0.0165,
        "LTC-TREND" => 0.01925,
        // V5_TITANIUM expansion (uniform 0.022)
        "SOL-TREND" | "DOGE-TREND" | "LINK-TREND" | "AVAX-TREND" | "RUNE-TREND" => 0.022,
        _ => 0.022,
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

/// V5_TITANIUM — 14-asset wider basket, longer-history validated.
pub fn v5_titanium() -> EngineConfig {
    let mut cfg = quartz_lite_base();
    cfg.label = "V5_TITANIUM".into();
    cfg.assets = make_assets(V5_TITANIUM_BASKET, 0.4);
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(v5_titanium_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
    }
    cfg.close_all_on_target_reached = false;
    cfg
}

/// V5_AMBER — V5_QUARTZ minus RUNE, optimised for step=1d anchor.
pub fn v5_amber() -> EngineConfig {
    let mut cfg = quartz_lite_base();
    cfg.label = "V5_AMBER".into();
    let basket: Vec<&str> = V5_TITANIUM_BASKET.iter().copied().filter(|s| *s != "RUNE-TREND").collect();
    cfg.assets = make_assets(&basket, 0.4);
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(v5_titanium_tp_for(&asset.symbol));
        asset.stop_pct = Some(0.05);
    }
    cfg.close_all_on_target_reached = false;
    cfg
}

/// V5_TOPAZ — V5_AMBER variant.
pub fn v5_topaz() -> EngineConfig {
    let mut cfg = v5_amber();
    cfg.label = "V5_TOPAZ".into();
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
    fn v5_titanium_has_14_assets() {
        let cfg = v5_titanium();
        assert_eq!(cfg.assets.len(), 14);
    }

    #[test]
    fn v5_amber_drops_rune() {
        let cfg = v5_amber();
        assert_eq!(cfg.assets.len(), 13);
        assert!(!cfg.assets.iter().any(|a| a.symbol == "RUNE-TREND"));
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
