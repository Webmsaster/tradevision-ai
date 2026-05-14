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
//!
//! Post-factor caps (centralized helper `apply_post_factor_caps`):
//!   8. dayBasedRiskMultiplier early-day conservative factor
//!   9. liveCaps.maxRiskFrac clamp
//!  10. derived LIVE_LOSS_CAP = maxDailyLoss × 0.8 / (stopPct × leverage)

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
            sorted.sort_by_key(|t| std::cmp::Reverse(t.day_at_least));
            for t in &sorted {
                if state.day >= t.day_at_least {
                    factor *= t.factor;
                    break;
                }
            }
        }
    }

    // 0b. Equity-progress defensive override (Detector #20 cross-cut).
    //
    // Lookahead-safe: state.equity is realized-only at the signal bar
    // (only mutated by `close_trade` via `state.equity *= 1.0 + pnl.eff_pnl`).
    // The override NEVER raises factor — it only caps DOWN, so a misconfigured
    // `factor: 2.0` is harmless. Trigger fires when realized PnL has already
    // captured `progress_frac` of profit_target → switch to defensive sizing
    // earlier than the day-stage schedule would.
    if let Some(edp) = cfg.early_defensive_on_progress {
        if edp.progress_frac > 0.0 && edp.factor.is_finite() {
            let progress = state.equity - 1.0;
            let trigger = cfg.profit_target * edp.progress_frac;
            if progress >= trigger && edp.factor < factor {
                factor = edp.factor;
            }
        }
    }

    // 1. Adaptive tiers (sorted ascending by equity_above).
    //
    // R29-R3.D: use f64::total_cmp so a NaN-poisoned tier (corrupt config)
    // produces a deterministic order. `partial_cmp().unwrap_or(Equal)` lets
    // two NaN-tiers compare as Equal regardless of position, which can
    // shuffle equal-equity_above tiers across runs depending on Vec
    // insertion order — small but real determinism gap, especially when
    // sweep configs are generated programmatically.
    if let Some(tiers) = cfg.adaptive_sizing.as_ref() {
        if !tiers.is_empty() {
            let mut sorted: Vec<_> = tiers.clone();
            sorted.sort_by(|a, b| a.equity_above.total_cmp(&b.equity_above));
            for tier in &sorted {
                if equity_above_baseline >= tier.equity_above {
                    factor = tier.factor;
                }
            }
        }
    }

    // 2. timeBoost — only overrides if INCREASES factor.
    if let Some(tb) = cfg.time_boost {
        if state.day >= tb.after_day
            && equity_above_baseline < tb.equity_below
            && tb.factor > factor
        {
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
            sorted_tiers.sort_by(|a, b| b.win_rate_above.total_cmp(&a.win_rate_above));
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

/// 2026-05-13 Codex Audit Round 3 — Fix 2: centralized post-factor sizing
/// caps. Previously only `signals_r28v6.rs` applied `dayBasedRiskMultiplier`
/// + the derived `LIVE_LOSS_CAP`, leaving MeanRev / Breakout / Trend / V12
/// / ForexMR / R29R5 detectors with only the legacy `liveCaps.maxRiskFrac`
/// clamp. Sweeps using `also_meanrev` / `also_breakout` / regime probes /
/// alt-detector configs were therefore over-sized in early days and
/// uncapped against the maxDailyLoss-derived live-loss limit.
///
/// Call AFTER `eff_risk = base * factor [* size_mult]`, BEFORE the
/// `eff_risk <= 0.0` short-circuit. Returns the (possibly reduced) eff_risk.
///
/// TS reference: `ftmoLiveEngineV4.ts:1975-1997`.
pub fn apply_post_factor_caps(
    cfg: &EngineConfig,
    state: &EngineState,
    mut eff_risk: f64,
    stop_pct: f64,
) -> f64 {
    // 8. dayBasedRiskMultiplier (TS L1975-1981).
    let day_risk_mult = match cfg.day_based_risk_multiplier {
        Some(dbrm) if state.day < dbrm.conservative_first_days => dbrm.conservative_factor,
        _ => 1.0,
    };
    eff_risk *= day_risk_mult;
    // 9. liveCaps.maxRiskFrac (TS L1983-1985).
    if !cfg.bypass_live_caps {
        if let Some(caps) = cfg.live_caps.as_ref() {
            eff_risk = eff_risk.min(caps.max_risk_frac);
        }
    }
    // 10. Derived live-loss cap from maxDailyLoss × 0.8 (TS L1991-1997).
    let live_loss_cap = cfg.max_daily_loss.max(0.0) * 0.8;
    if stop_pct > 0.0 && cfg.leverage > 0.0 && live_loss_cap > 0.0 {
        let modelled_loss = eff_risk * stop_pct * cfg.leverage;
        if modelled_loss > live_loss_cap {
            eff_risk = live_loss_cap / (stop_pct * cfg.leverage);
        }
    }
    eff_risk
}

/// 2026-05-14 Detector #11 Phase-1 — Funding-cost sizing modifier.
///
/// Returns a multiplicative sizing factor in `[min_factor, 1.0]` based on
/// the expected funding cost the about-to-open position would pay.
///
/// Math:
///   sign = +1 (long) | -1 (short)
///   expected_cost = sign × funding_series[trigger_idx] × expected_hold_8h_buckets
///   reference window = funding_series[trigger_idx - norm_window .. trigger_idx]
///       (STRICT before trigger_idx — no lookahead)
///   z = (expected_cost - mean) / std_dev
///   modifier = clamp(1 - alpha × max(0, z), min_factor, 1.0)
///
/// Asymmetric clamp: ONLY penalises pay-side (positive cost from the
/// position's perspective); never grants a bonus for receive-side trades.
/// This is conservative: free funding is a nice-to-have, not a sizing
/// signal — overweighting on receive-side would tilt the book towards
/// "fade the funding-paying side" which is a separate strategy with its
/// own risk profile.
///
/// Returns `1.0` (no-op) when:
///   - `funding_series` is `None` or shorter than `norm_window + 1`
///   - `trigger_idx` is `0` or beyond the series end
///   - the funding rate at trigger_idx is `None` / NaN
///   - the reference window has zero variance (e.g. all zeros)
///
/// All inputs are passed through; no state-mutation. Caller is responsible
/// for ensuring `trigger_idx` is the index of the candle that produced the
/// signal (NOT the entry-bar `i+1` — that would be lookahead).
pub fn funding_cost_modifier(
    direction: crate::position::PositionSide,
    funding_series: Option<&[Option<f64>]>,
    trigger_idx: usize,
    expected_hold_8h_buckets: f64,
    alpha: f64,
    norm_window_buckets: usize,
    min_factor: f64,
) -> f64 {
    let funding = match funding_series {
        Some(f) if !f.is_empty() => f,
        _ => return 1.0,
    };
    if trigger_idx == 0 || trigger_idx >= funding.len() {
        return 1.0;
    }
    // Need at least `norm_window_buckets` valid samples strictly BEFORE
    // trigger_idx — lookahead-clean by construction.
    let win_start = trigger_idx.saturating_sub(norm_window_buckets);
    if trigger_idx <= win_start {
        return 1.0;
    }
    let window = &funding[win_start..trigger_idx];

    // Current funding rate (used to estimate expected cost over the
    // intended holding period).
    let cur_rate = match funding[trigger_idx] {
        Some(r) if r.is_finite() => r,
        _ => return 1.0,
    };

    // Direction-signed expected funding cost over the hold.
    let sign = match direction {
        crate::position::PositionSide::Long => 1.0_f64,
        crate::position::PositionSide::Short => -1.0_f64,
    };
    let expected_cost = sign * cur_rate * expected_hold_8h_buckets;

    // Mean + std of the reference window (filter NaN/None).
    let mut n = 0usize;
    let mut sum = 0.0_f64;
    let mut sum_sq = 0.0_f64;
    for opt in window {
        if let Some(v) = opt {
            if v.is_finite() {
                let signed = sign * v * expected_hold_8h_buckets;
                sum += signed;
                sum_sq += signed * signed;
                n += 1;
            }
        }
    }
    if n < 2 {
        return 1.0;
    }
    let mean = sum / n as f64;
    // Population variance with numerical-safety floor. f64 round-off can
    // produce tiny negative or sub-epsilon positive variance when the
    // reference window is constant (e.g. all-zero funding before a perp
    // pair lists). Clamp to a small positive threshold to avoid both
    // sqrt(negative) and divide-by-tiny → huge spurious z-score.
    let var_raw = (sum_sq / n as f64) - mean * mean;
    if !var_raw.is_finite() || var_raw <= 1e-20 {
        return 1.0;
    }
    let std_dev = var_raw.sqrt();
    let z = (expected_cost - mean) / std_dev;
    // Asymmetric: only penalise when z > 0 (cost above historical norm).
    let penalty = alpha * z.max(0.0);
    let modifier = 1.0 - penalty;
    modifier.clamp(min_factor, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdaptiveSizingTier, DayProgressiveTier, DrawdownShield, EarlyDefensiveOnProgress,
        IntradayDailyLossThrottle, KellySizing, KellyTier, PeakDrawdownThrottle, TimeBoost,
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
            AdaptiveSizingTier {
                equity_above: 0.0,
                factor: 0.75,
            },
            AdaptiveSizingTier {
                equity_above: 0.03,
                factor: 1.125,
            },
            AdaptiveSizingTier {
                equity_above: 0.08,
                factor: 0.375,
            },
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
        c.adaptive_sizing = Some(vec![AdaptiveSizingTier {
            equity_above: 0.0,
            factor: 0.75,
        }]);
        c.time_boost = Some(TimeBoost {
            after_day: 10,
            equity_below: 0.05,
            factor: 2.0,
        });
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
        c.drawdown_shield = Some(DrawdownShield {
            below_equity: -0.02,
            factor: 0.5,
        });
        let mut s = EngineState::initial("x");
        s.equity = 0.97; // -3%
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 0.5).abs() < 1e-9);
    }

    #[test]
    fn peak_drawdown_throttle_caps_down() {
        let mut c = cfg();
        c.peak_drawdown_throttle = Some(PeakDrawdownThrottle {
            from_peak: 0.05,
            factor: 0.5,
        });
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
        c.adaptive_sizing = Some(vec![AdaptiveSizingTier {
            equity_above: 0.0,
            factor: 3.0,
        }]);
        c.time_boost = Some(TimeBoost {
            after_day: 0,
            equity_below: 1.0,
            factor: 5.0,
        });
        c.kelly_sizing = Some(KellySizing {
            window_size: 5,
            min_trades: 3,
            tiers: vec![KellyTier {
                win_rate_above: 0.0,
                multiplier: 2.0,
            }],
        });
        let mut s = EngineState::initial("x");
        for i in 0..5 {
            s.kelly_pnls.push(KellyPnl {
                close_time: i,
                eff_pnl: 0.01,
            });
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
                KellyTier {
                    win_rate_above: 0.7,
                    multiplier: 1.5,
                },
                KellyTier {
                    win_rate_above: 0.5,
                    multiplier: 1.0,
                },
                KellyTier {
                    win_rate_above: 0.0,
                    multiplier: 0.6,
                },
            ],
        });
        let mut s = EngineState::initial("x");
        // Seed 7 wins / 3 losses = 70% — borderline tier 0.
        for i in 0..7 {
            s.kelly_pnls.push(KellyPnl {
                close_time: i,
                eff_pnl: 0.01,
            });
        }
        for i in 7..10 {
            s.kelly_pnls.push(KellyPnl {
                close_time: i,
                eff_pnl: -0.01,
            });
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

    // ─── Detector #20 — 3-Phase Day-Stage Sizing + Equity-Progress ───

    /// Helper: build a 3-tier day-stage ladder [aggressive, neutral, defensive].
    fn three_phase_tiers() -> Vec<DayProgressiveTier> {
        vec![
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
        ]
    }

    #[test]
    fn day_stage_aggressive_at_day_0() {
        let mut c = cfg();
        c.day_progressive_sizing = Some(three_phase_tiers());
        let mut s = EngineState::initial("x");
        s.day = 0;
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 1.5).abs() < 1e-9, "day=0 aggressive 1.5×, got {f}");
    }

    #[test]
    fn day_stage_neutral_at_day_5() {
        let mut c = cfg();
        c.day_progressive_sizing = Some(three_phase_tiers());
        let mut s = EngineState::initial("x");
        s.day = 5;
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 1.0).abs() < 1e-9, "day=5 neutral 1.0×, got {f}");
    }

    #[test]
    fn day_stage_defensive_at_day_10() {
        let mut c = cfg();
        c.day_progressive_sizing = Some(three_phase_tiers());
        let mut s = EngineState::initial("x");
        s.day = 10;
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 0.7).abs() < 1e-9, "day=10 defensive 0.7×, got {f}");
    }

    #[test]
    fn early_defensive_overrides_aggressive() {
        // Day=1 → day-stage factor=1.5 (aggressive). But equity is already
        // ≥ 50% of profit_target (5%). Trigger at progress_frac=0.5 →
        // override to 0.7 (defensive). Use a small epsilon margin above the
        // trigger to dodge IEEE-754 subtraction noise on 1.025 - 1.0.
        let mut c = cfg();
        c.profit_target = 0.05;
        c.day_progressive_sizing = Some(three_phase_tiers());
        c.early_defensive_on_progress = Some(EarlyDefensiveOnProgress {
            progress_frac: 0.5,
            factor: 0.7,
        });
        let mut s = EngineState::initial("x");
        s.day = 1;
        s.equity = 1.0 + 0.05 * 0.5 + 1e-6; // 50% of target + epsilon
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!(
            (f - 0.7).abs() < 1e-9,
            "early-defensive should override 1.5 → 0.7, got {f}"
        );

        // Sub-trigger: equity below progress_frac → no override.
        s.equity = 1.0 + 0.05 * 0.5 - 1e-6;
        let f2 = resolve_sizing_factor(&mut s, &c, 0);
        assert!(
            (f2 - 1.5).abs() < 1e-9,
            "sub-trigger must keep aggressive 1.5, got {f2}"
        );
    }

    #[test]
    fn early_defensive_with_zero_progress_frac_disabled() {
        // progress_frac=0 → no trigger (config-disabled sentinel).
        let mut c = cfg();
        c.profit_target = 0.05;
        c.day_progressive_sizing = Some(three_phase_tiers());
        c.early_defensive_on_progress = Some(EarlyDefensiveOnProgress {
            progress_frac: 0.0,
            factor: 0.5,
        });
        let mut s = EngineState::initial("x");
        s.day = 1;
        s.equity = 1.04; // far into target territory
        let f = resolve_sizing_factor(&mut s, &c, 0);
        // Day=1 aggressive 1.5 untouched.
        assert!(
            (f - 1.5).abs() < 1e-9,
            "progress_frac=0 must disable override, got {f}"
        );
    }

    #[test]
    fn early_defensive_only_lowers_factor_never_raises() {
        // Day=10 → day-stage factor=0.7 (defensive). EDP factor=2.0 would
        // RAISE — but we cap DOWN only, so factor stays at 0.7.
        let mut c = cfg();
        c.profit_target = 0.05;
        c.day_progressive_sizing = Some(three_phase_tiers());
        c.early_defensive_on_progress = Some(EarlyDefensiveOnProgress {
            progress_frac: 0.5,
            factor: 2.0,
        });
        let mut s = EngineState::initial("x");
        s.day = 10;
        s.equity = 1.04; // trigger fires (≥ 50% of target)
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!(
            (f - 0.7).abs() < 1e-9,
            "edp.factor=2.0 must NOT raise day-stage 0.7, got {f}"
        );
    }

    #[test]
    fn day_stage_lookahead_audit() {
        // Lookahead audit: state.equity reflects realized-pnl only (no MTM).
        // Verify by setting mtm_equity divergent from equity — sizing must
        // consult `equity` (realized) not `mtm_equity` (mark-to-market).
        let mut c = cfg();
        c.profit_target = 0.05;
        c.early_defensive_on_progress = Some(EarlyDefensiveOnProgress {
            progress_frac: 0.5,
            factor: 0.5,
        });
        let mut s = EngineState::initial("x");
        s.day = 0;
        // Realized equity is FLAT (1.0). MTM has unrealized gain of +4% — if
        // sizing used MTM it would trip the trigger; we want it to NOT trip.
        s.equity = 1.0;
        s.mtm_equity = 1.04;
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!(
            (f - 1.0).abs() < 1e-9,
            "MTM-only gain must NOT trigger early-defensive (got {f})"
        );

        // Now flip: realized +4%, MTM also +4%. Trigger SHOULD fire.
        s.equity = 1.04;
        let f2 = resolve_sizing_factor(&mut s, &c, 0);
        assert!(
            (f2 - 0.5).abs() < 1e-9,
            "realized +4% must trigger early-defensive (got {f2})"
        );
    }

    #[test]
    fn early_defensive_interacts_correctly_with_drawdown_shield() {
        // Wechselwirkung: drawdown_shield can ONLY cap DOWN — so when EDP
        // already lowered factor, drawdown_shield with a HIGHER factor must
        // NOT raise it back up. Without day_progressive_sizing, baseline
        // factor is 1.0 → EDP caps to 0.3.
        let mut c = cfg();
        c.profit_target = 0.05;
        c.early_defensive_on_progress = Some(EarlyDefensiveOnProgress {
            progress_frac: 0.5,
            factor: 0.3,
        });
        c.drawdown_shield = Some(DrawdownShield {
            below_equity: -0.10, // never fires at +2.5% equity
            factor: 0.8,
        });
        let mut s = EngineState::initial("x");
        s.day = 0;
        s.equity = 1.0 + 0.05 * 0.5 + 1e-6;
        let f = resolve_sizing_factor(&mut s, &c, 0);
        // EDP fires (factor=0.3); drawdown_shield doesn't fire (equity>shield),
        // so factor stays at 0.3.
        assert!(
            (f - 0.3).abs() < 1e-9,
            "drawdown_shield must not raise EDP-capped 0.3, got {f}"
        );
    }

    #[test]
    fn day_stage_with_disabled_day_stage_template_falls_back() {
        // Smoke: day_progressive_sizing=None + EDP=None → baseline 1.0
        // even when day, equity, profit_target are set. Guards against the
        // override accidentally firing on a stale config.
        let mut c = cfg();
        c.day_progressive_sizing = None;
        c.early_defensive_on_progress = None;
        let mut s = EngineState::initial("x");
        s.day = 5;
        s.equity = 1.04;
        let f = resolve_sizing_factor(&mut s, &c, 0);
        assert!((f - 1.0).abs() < 1e-9, "no-config baseline = 1.0, got {f}");
    }

    // ────────────────────────────────────────────────────────────────
    // Detector #11 Phase-1 — funding_cost_modifier() tests
    // ────────────────────────────────────────────────────────────────

    use crate::position::PositionSide;

    fn mk_funding(values: &[f64]) -> Vec<Option<f64>> {
        values.iter().map(|&v| Some(v)).collect()
    }

    #[test]
    fn funding_modifier_returns_1_when_no_series() {
        let m = funding_cost_modifier(PositionSide::Long, None, 100, 3.0, 1.5, 720, 0.4);
        assert_eq!(m, 1.0);
    }

    #[test]
    fn funding_modifier_returns_1_when_idx_zero() {
        let series = mk_funding(&[0.0001, 0.0002]);
        let m = funding_cost_modifier(PositionSide::Long, Some(&series), 0, 3.0, 1.5, 720, 0.4);
        assert_eq!(m, 1.0);
    }

    #[test]
    fn funding_modifier_returns_1_when_idx_oob() {
        let series = mk_funding(&[0.0001, 0.0002]);
        let m = funding_cost_modifier(PositionSide::Long, Some(&series), 5, 3.0, 1.5, 720, 0.4);
        assert_eq!(m, 1.0);
    }

    #[test]
    fn funding_modifier_returns_1_when_zero_variance() {
        // All-zero history → std_dev = 0 → bail out with no-op.
        let mut v = vec![0.0_f64; 100];
        v.push(0.0005); // trigger
        let series = mk_funding(&v);
        let m = funding_cost_modifier(
            PositionSide::Long,
            Some(&series),
            100,
            3.0,
            1.5,
            50,
            0.4,
        );
        assert_eq!(m, 1.0, "zero-var window must yield no-op");
    }

    #[test]
    fn funding_modifier_no_bonus_for_receive_side() {
        // Build a window where current funding is BIG negative (long receives).
        // Asymmetric clamp must NOT inflate modifier > 1.0.
        let mut v: Vec<f64> = (0..100)
            .map(|i| 0.0001 * ((i % 7) as f64 - 3.0))
            .collect();
        v.push(-0.005); // huge negative funding @ trigger
        let series = mk_funding(&v);
        let m = funding_cost_modifier(
            PositionSide::Long,
            Some(&series),
            100,
            3.0,
            1.5,
            100,
            0.4,
        );
        assert_eq!(m, 1.0, "negative cost (receive-side) must not lift > 1.0");
    }

    #[test]
    fn funding_modifier_penalises_high_positive_cost_for_long() {
        // Construct a window with mean ≈ 0, std ≈ 0.0001, then trigger with
        // a +5σ outlier. modifier should drop to min_factor.
        let mut v: Vec<f64> = (0..200)
            .map(|i| if i % 2 == 0 { 0.0001 } else { -0.0001 })
            .collect();
        v.push(0.005); // huge positive funding @ trigger → long pays a lot
        let series = mk_funding(&v);
        let m = funding_cost_modifier(
            PositionSide::Long,
            Some(&series),
            200,
            3.0,
            1.5,
            200,
            0.4,
        );
        // Large +z × 1.5 alpha = strong penalty → clamp to min_factor.
        assert!(
            (m - 0.4).abs() < 1e-12,
            "expected min_factor=0.4 clamp for extreme positive z, got {m}"
        );
    }

    #[test]
    fn funding_modifier_short_symmetric_to_long() {
        // Same magnitude of "expected funding cost from position's POV":
        // long with +funding paying = short with -funding paying. Result
        // must be identical.
        let mut v_long_pos: Vec<f64> = vec![0.0001, -0.0001].repeat(50);
        v_long_pos.push(0.003);
        let series_long = mk_funding(&v_long_pos);
        let m_long = funding_cost_modifier(
            PositionSide::Long,
            Some(&series_long),
            100,
            3.0,
            1.0,
            100,
            0.4,
        );

        // Mirror for short: same rate-magnitude, opposite sign → short pays.
        let mut v_short_pay: Vec<f64> = vec![-0.0001, 0.0001].repeat(50);
        v_short_pay.push(-0.003);
        let series_short = mk_funding(&v_short_pay);
        let m_short = funding_cost_modifier(
            PositionSide::Short,
            Some(&series_short),
            100,
            3.0,
            1.0,
            100,
            0.4,
        );

        assert!(
            (m_long - m_short).abs() < 1e-12,
            "long-side and short-side cost-symmetry must yield same modifier (long={}, short={})",
            m_long,
            m_short
        );
    }

    #[test]
    fn funding_modifier_no_lookahead_uses_strict_before_trigger() {
        // Lookahead audit: build a window where every reference value is
        // small + sign-balanced (mean≈0, well-defined std), then place
        // an extreme OUT-of-distribution value AT trigger_idx. The
        // function MUST treat funding[trigger_idx] as the current rate
        // (drives expected_cost) but NEVER include it in the reference
        // statistics. We verify by computing the expected z-score using
        // the strict-before window and comparing to what would happen if
        // the trigger leaked in.
        let mut v: Vec<f64> = Vec::with_capacity(101);
        for i in 0..100 {
            // alternating small ±values → mean≈0, std≈0.0001
            v.push(if i % 2 == 0 { 0.0001 } else { -0.0001 });
        }
        // Trigger value: large positive funding rate. If this leaks into
        // the reference window, mean would shift by ~ 0.005/101 ≈ 5e-5 and
        // std would shoot up dramatically.
        v.push(0.5);
        let series = mk_funding(&v);
        // Strict-before window (100 alternating values) has:
        //   mean = 0, std = 0.0001 (exact for sign-balanced ±x)
        // expected_cost for long, hold=1: 1.0 * 0.5 * 1.0 = 0.5
        // z = (0.5 - 0) / 0.0001 = 5000 → huge penalty → clamp to 0.4.
        // If the trigger leaked in (101-value window), std would be ~0.05,
        // z ≈ 10, penalty still big enough to clamp → same 0.4 result.
        //
        // To DISTINGUISH leak vs strict-before, set alpha very small so
        // the penalty is bounded by alpha × z (no clamp engaged).
        let m_strict = funding_cost_modifier(
            PositionSide::Long,
            Some(&series),
            100,
            1.0,
            0.00001, // tiny alpha — penalty = alpha × z stays well above min_factor
            100,
            0.4,
        );
        // strict-before: z = 5000, penalty = 1e-5 × 5000 = 0.05 → modifier = 0.95
        // leaked-in:    z ≈ 10,  penalty = 1e-5 × 10 = 1e-4   → modifier ≈ 0.9999
        // The two values differ by ~5pp — a reliable lookahead detector.
        let expected_strict = 1.0 - 0.00001 * 5000.0; // = 0.95
        let expected_leak_approx = 1.0 - 0.00001 * 10.0; // = 0.9999
        assert!(
            (m_strict - expected_strict).abs() < 1e-3,
            "expected strict-before modifier ≈ {expected_strict} (got {m_strict}); \
             would have been ≈ {expected_leak_approx} if trigger leaked into reference window"
        );
    }

    #[test]
    fn funding_modifier_clamped_between_min_and_one() {
        // Random-ish positive funding spike that should produce a moderate
        // (not extreme) penalty — modifier in (min_factor, 1.0).
        let mut v: Vec<f64> = (0..100)
            .map(|i| 0.0001 * ((i as f64 * 0.7).sin()))
            .collect();
        v.push(0.0003);
        let series = mk_funding(&v);
        let m = funding_cost_modifier(
            PositionSide::Long,
            Some(&series),
            100,
            3.0,
            1.5,
            100,
            0.4,
        );
        assert!(
            m >= 0.4 && m <= 1.0,
            "modifier {} out of [min_factor=0.4, 1.0]",
            m
        );
    }
}
