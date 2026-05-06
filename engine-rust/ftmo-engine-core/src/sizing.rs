//! Sizing factor pipeline — port of `resolveSizingFactor` from
//! `ftmoLiveEngineV4.ts`.
//!
//! Pipeline order (matches V4 + R57-V4-3 hysteresis):
//!   1. adaptiveSizing tiers (sorted asc by equityAbove)
//!   2. timeBoost — only INCREASES factor (never overrides protection)
//!   3. kellySizing with persisted-tier hysteresis (HYST = 5pp)
//!   4. Hard cap at 4×
//!   5. drawdownShield — caps DOWN
//!   6. peakDrawdownThrottle — caps DOWN (MTM-based)
//!   7. intradayDailyLossThrottle.soft — caps DOWN

use crate::config::EngineConfig;
use crate::state::EngineState;

/// Hysteresis for kelly tier transitions.
const HYST: f64 = 0.05;

/// Hard cap to prevent compound timeBoost(2) × kelly(1.5) blow-ups.
const HARD_CAP: f64 = 4.0;

/// Return the sizing factor for a NEW entry at `entry_time_ms`. Mutates
/// `state.kelly_tier_idx` to persist the chosen kelly tier across calls.
pub fn resolve_sizing_factor(
    state: &mut EngineState,
    cfg: &EngineConfig,
    entry_time_ms: i64,
) -> f64 {
    let mut factor = 1.0_f64;
    let equity_above_baseline = state.equity - 1.0;

    // 0. dayProgressiveSizing (V5R) — pick the highest matching tier.
    if let Some(tiers) = cfg.day_progressive_sizing.as_ref() {
        if !tiers.is_empty() {
            let mut sorted: Vec<_> = tiers.clone();
            sorted.sort_by(|a, b| b.day_at_least.cmp(&a.day_at_least));
            for t in &sorted {
                if state.day >= t.day_at_least {
                    factor *= t.factor;
                    break;
                }
            }
        }
    }

    // 1. Adaptive tiers (sorted ascending by equity_above).
    if let Some(tiers) = cfg.adaptive_sizing.as_ref() {
        if !tiers.is_empty() {
            let mut sorted: Vec<_> = tiers.clone();
            sorted.sort_by(|a, b| a.equity_above.partial_cmp(&b.equity_above).unwrap_or(std::cmp::Ordering::Equal));
            for tier in &sorted {
                if equity_above_baseline >= tier.equity_above {
                    factor = tier.factor;
                }
            }
        }
    }

    // 2. timeBoost — only overrides if INCREASES factor.
    if let Some(tb) = cfg.time_boost {
        if state.day >= tb.after_day && equity_above_baseline < tb.equity_below && tb.factor > factor {
            factor = tb.factor;
        }
    }

    // 3. Kelly multiplier with hysteresis.
    if let Some(ks) = cfg.kelly_sizing.as_ref() {
        let recent: Vec<f64> = state
            .kelly_pnls
            .iter()
            .filter(|p| p.close_time < entry_time_ms)
            .rev()
            .take(ks.window_size as usize)
            .map(|p| p.eff_pnl)
            .collect();
        if recent.len() >= ks.min_trades as usize && !ks.tiers.is_empty() {
            let wr = recent.iter().filter(|&&p| p > 0.0).count() as f64 / recent.len() as f64;
            // Sort tiers descending by win_rate_above.
            let mut sorted_tiers: Vec<_> = ks.tiers.clone();
            sorted_tiers.sort_by(|a, b| b.win_rate_above.partial_cmp(&a.win_rate_above).unwrap_or(std::cmp::Ordering::Equal));
            let n = sorted_tiers.len();
            let tier_idx: usize = match state.kelly_tier_idx {
                None => {
                    // Cold start: greedy lookup, then persist.
                    sorted_tiers
                        .iter()
                        .position(|t| wr >= t.win_rate_above)
                        .unwrap_or(n - 1)
                }
                Some(prev) => {
                    let cur = prev.min(n - 1);
                    let cur_tier = &sorted_tiers[cur];
                    if cur > 0 && wr >= sorted_tiers[cur - 1].win_rate_above + HYST {
                        // Step UP — find highest tier we comfortably cleared.
                        let mut idx = cur - 1;
                        while idx > 0 && wr >= sorted_tiers[idx - 1].win_rate_above + HYST {
                            idx -= 1;
                        }
                        idx
                    } else if cur < n - 1 && wr <= cur_tier.win_rate_above - HYST {
                        // Step DOWN.
                        let mut idx = cur + 1;
                        while idx < n - 1 && wr <= sorted_tiers[idx].win_rate_above - HYST {
                            idx += 1;
                        }
                        idx
                    } else {
                        cur
                    }
                }
            };
            state.kelly_tier_idx = Some(tier_idx);
            factor *= sorted_tiers[tier_idx].multiplier;
        }
    }

    // 4. Hard cap.
    factor = factor.min(HARD_CAP);

    // 5. drawdownShield (caps DOWN).
    if let Some(ds) = cfg.drawdown_shield {
        if equity_above_baseline <= ds.below_equity {
            factor = factor.min(ds.factor);
        }
    }

    // 6. peakDrawdownThrottle (MTM-based, caps DOWN).
    if let Some(pdt) = cfg.peak_drawdown_throttle {
        if state.challenge_peak > 0.0 {
            let from_peak = (state.challenge_peak - state.mtm_equity) / state.challenge_peak;
            if from_peak >= pdt.from_peak {
                factor = factor.min(pdt.factor);
            }
        }
    }

    // 7. intradayDailyLossThrottle.soft (caps DOWN).
    if let Some(idl) = cfg.intraday_daily_loss_throttle {
        if state.day_start > 0.0 {
            let day_pnl = (state.equity - state.day_start) / state.day_start;
            if day_pnl <= -idl.soft_loss_threshold {
                factor = factor.min(idl.soft_factor);
            }
        }
    }

    factor
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdaptiveSizingTier, DrawdownShield, IntradayDailyLossThrottle, KellySizing, KellyTier,
        PeakDrawdownThrottle, TimeBoost,
    };
    use crate::state::KellyPnl;

    fn cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }

    #[test]
    fn baseline_factor_is_one() {
        let mut s = EngineState::initial("x");
        assert_eq!(resolve_sizing_factor(&mut s, &cfg(), 100), 1.0);
    }

    #[test]
    fn adaptive_tiers_walk_with_equity() {
        let mut c = cfg();
        c.adaptive_sizing = Some(vec![
            AdaptiveSizingTier { equity_above: 0.0, factor: 0.75 },
            AdaptiveSizingTier { equity_above: 0.03, factor: 1.125 },
            AdaptiveSizingTier { equity_above: 0.08, factor: 0.375 },
        ]);
        let mut s = EngineState::initial("x");

        s.equity = 1.0;
        assert!((resolve_sizing_factor(&mut s, &c, 0) - 0.75).abs() < 1e-9);
        s.equity = 1.04;
        assert!((resolve_sizing_factor(&mut s, &c, 0) - 1.125).abs() < 1e-9);
        s.equity = 1.10;
        assert!((resolve_sizing_factor(&mut s, &c, 0) - 0.375).abs() < 1e-9);
    }

    #[test]
    fn time_boost_only_increases() {
        let mut c = cfg();
        c.adaptive_sizing = Some(vec![AdaptiveSizingTier { equity_above: 0.0, factor: 0.75 }]);
        c.time_boost = Some(TimeBoost { after_day: 10, equity_below: 0.05, factor: 2.0 });
        let mut s = EngineState::initial("x");

        // day 5 — too early.
        s.day = 5;
        assert!((resolve_sizing_factor(&mut s, &c, 0) - 0.75).abs() < 1e-9);
        // day 11 — boost fires.
        s.day = 11;
        assert!((resolve_sizing_factor(&mut s, &c, 0) - 2.0).abs() < 1e-9);
        // day 11 but already at +6% — boost doesn't fire (equity_below 5% missed).
        s.equity = 1.06;
        assert!((resolve_sizing_factor(&mut s, &c, 0) - 0.75).abs() < 1e-9);
    }

    #[test]
    fn drawdown_shield_caps_down() {
        let mut c = cfg();
        c.drawdown_shield = Some(DrawdownShield { below_equity: -0.02, factor: 0.5 });
        let mut s = EngineState::initial("x");
        s.equity = 0.97; // -3%
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 0.5).abs() < 1e-9);
    }

    #[test]
    fn peak_drawdown_throttle_caps_down() {
        let mut c = cfg();
        c.peak_drawdown_throttle = Some(PeakDrawdownThrottle { from_peak: 0.05, factor: 0.5 });
        let mut s = EngineState::initial("x");
        s.challenge_peak = 1.10;
        s.mtm_equity = 1.04; // -5.45% from peak
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 0.5).abs() < 1e-9);
    }

    #[test]
    fn intraday_daily_loss_throttle_caps_down() {
        let mut c = cfg();
        c.intraday_daily_loss_throttle = Some(IntradayDailyLossThrottle {
            soft_loss_threshold: 0.03,
            hard_loss_threshold: 0.04,
            soft_factor: 0.5,
        });
        let mut s = EngineState::initial("x");
        s.day_start = 1.0;
        s.equity = 0.96; // -4% intraday
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 0.5).abs() < 1e-9);
    }

    #[test]
    fn hard_cap_at_four() {
        let mut c = cfg();
        c.adaptive_sizing = Some(vec![AdaptiveSizingTier { equity_above: 0.0, factor: 3.0 }]);
        c.time_boost = Some(TimeBoost { after_day: 0, equity_below: 1.0, factor: 5.0 });
        c.kelly_sizing = Some(KellySizing {
            window_size: 5,
            min_trades: 3,
            tiers: vec![KellyTier { win_rate_above: 0.0, multiplier: 2.0 }],
        });
        let mut s = EngineState::initial("x");
        for i in 0..5 {
            s.kelly_pnls.push(KellyPnl { close_time: i, eff_pnl: 0.01 });
        }
        let f = resolve_sizing_factor(&mut s, &c, 1000);
        assert!((f - HARD_CAP).abs() < 1e-9);
    }

    #[test]
    fn kelly_hysteresis_no_flicker_at_boundary() {
        let mut c = cfg();
        c.kelly_sizing = Some(KellySizing {
            window_size: 10,
            min_trades: 5,
            tiers: vec![
                KellyTier { win_rate_above: 0.7, multiplier: 1.5 },
                KellyTier { win_rate_above: 0.5, multiplier: 1.0 },
                KellyTier { win_rate_above: 0.0, multiplier: 0.6 },
            ],
        });
        let mut s = EngineState::initial("x");
        // Seed 7 wins / 3 losses = 70% — borderline tier 0.
        for i in 0..7 {
            s.kelly_pnls.push(KellyPnl { close_time: i, eff_pnl: 0.01 });
        }
        for i in 7..10 {
            s.kelly_pnls.push(KellyPnl { close_time: i, eff_pnl: -0.01 });
        }
        // Cold start picks tier 0 greedily.
        let f1 = resolve_sizing_factor(&mut s, &c, 100);
        assert_eq!(s.kelly_tier_idx, Some(0));
        assert!((f1 - 1.5).abs() < 1e-9);
        // Drop one win → 60% wr. With hysteresis cur=0, cur.win_rate_above=0.7.
        // Need wr <= 0.65 to step DOWN. 0.6 ≤ 0.65 → tier 1.
        s.kelly_pnls[0].eff_pnl = -0.01;
        let f2 = resolve_sizing_factor(&mut s, &c, 100);
        assert_eq!(s.kelly_tier_idx, Some(1));
        assert!((f2 - 1.0).abs() < 1e-9);
        // Bring back to exactly 70% wr — but at tier 1, stepping UP to tier 0
        // needs wr ≥ 0.7 + HYST = 0.75. 70% is NOT enough → stays at tier 1.
        s.kelly_pnls[0].eff_pnl = 0.01;
        let f3 = resolve_sizing_factor(&mut s, &c, 100);
        assert_eq!(s.kelly_tier_idx, Some(1));
        assert!((f3 - 1.0).abs() < 1e-9);
        // Push wr to 80% (8 wins / 2 losses) — flip one of the losses (index 7)
        // back to a win. Comfortably ≥ 0.75 → step UP from tier 1 to tier 0.
        s.kelly_pnls[7].eff_pnl = 0.01;
        let f4 = resolve_sizing_factor(&mut s, &c, 100);
        assert_eq!(s.kelly_tier_idx, Some(0));
        assert!((f4 - 1.5).abs() < 1e-9);
    }
}
