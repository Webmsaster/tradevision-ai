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
    AssetConfig, BreakEven, ChandelierExit, EngineConfig, KellySizing, KellyTier,
    LiveCaps, LossStreakCooldown, PartialTakeProfit, PeakTrailingStop,
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

fn make_assets(symbols: &[&str], risk_frac: f64) -> Vec<AssetConfig> {
    symbols
        .iter()
        .map(|s| AssetConfig {
            symbol: (*s).to_string(),
            source_symbol: Some(s.replace("-TREND", "USDT")),
            tp_pct: None, // inherit from cfg
            stop_pct: None,
            risk_frac,
            activate_after_day: None,
            min_equity_gain: None,
            max_equity_gain: None,
            hold_bars: None,
            invert_direction: false,
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

/// Apply R28_V6 per-asset tp_pct overrides to a config's asset list.
fn apply_r28_v6_per_asset(cfg: &mut EngineConfig) {
    for asset in cfg.assets.iter_mut() {
        asset.tp_pct = Some(r28_v6_tp_for(&asset.symbol));
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

fn quartz_lite_base() -> EngineConfig {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.assets = make_assets(R28_V6_BASKET, 0.4);
    cfg.tp_pct = 0.04;
    cfg.stop_pct = 0.02;
    cfg.leverage = 2.0;
    cfg.hold_bars = 1200;
    cfg.live_caps = Some(LiveCaps { max_stop_pct: 0.05, max_risk_frac: 0.4 });
    cfg.atr_stop = Some(crate::config::AtrStop { period: 56, stop_mult: 2.0 });
    cfg.chandelier_exit = Some(ChandelierExit { period: 56, mult: 2.0, min_move_r: Some(0.5) });
    cfg.break_even = Some(BreakEven { threshold: 0.03 });
    cfg.partial_take_profit = Some(PartialTakeProfit { trigger_pct: 0.02, close_fraction: 0.3 });
    cfg.daily_peak_trailing_stop = Some(PeakTrailingStop { trail_distance: 0.02 });
    cfg.loss_streak_cooldown = Some(LossStreakCooldown { after_losses: 2, cooldown_bars: 200 });
    cfg.kelly_sizing = Some(KellySizing {
        window_size: 10,
        min_trades: 5,
        tiers: vec![
            KellyTier { win_rate_above: 0.7, multiplier: 1.5 },
            KellyTier { win_rate_above: 0.5, multiplier: 1.0 },
            KellyTier { win_rate_above: 0.0, multiplier: 0.6 },
        ],
    });
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
}
