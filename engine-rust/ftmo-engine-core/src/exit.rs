//! Exit logic — port of `processPositionExit` from `ftmoLiveEngineV4.ts`.
//!
//! 2026-05-13 Codex Round 6 #P2+P4 FIX: SL/TP cross-detection runs FIRST at
//! each call; high-watermark / PTP / BE / trailingStop / chandelier are
//! POST-CROSS state-updates that only mutate state when no exit fired. This
//! mirrors source backtest `ftmoDaytrade24h.ts:4575+4620+4692` and was
//! shipped earlier to TS V4 in commit `a6a411c` (Codex Round 5 #2). The
//! legacy "mutate-then-cross" order let BE/chandelier tighten the stop
//! using the same bar's high/low and then immediately stop out within that
//! same bar — diverging from source by 1-3pp on chandelier-heavy configs.

use crate::candle::Candle;
use crate::config::EngineConfig;
use crate::position::{OpenPosition, PositionSide};
use crate::trade::ExitReason;

/// 2026-05-13 Codex Round 6 #P3 FIX: cost-adjusted BE stop level. Source
/// backtest `ftmoDaytrade24h.ts:4634` moves the BE stop to
///   entry × (1 + cost) for longs, entry × (1 - cost) for shorts
/// so a BE-stop-out realises ~0 net of round-trip cost. Rust previously
/// moved to raw entry, leaving a -cost bp drag on every BE-stop. Mirrors
/// the TS-side `computeBeStop` shipped in commit `a6a411c`.
fn cost_adjusted_be(pos: &OpenPosition, cfg: &EngineConfig) -> f64 {
    let asset = cfg.assets.iter().find(|a| a.symbol == pos.symbol);
    let cost_bp = asset.and_then(|a| a.cost_bp).unwrap_or(0.0);
    if cost_bp <= 0.0 {
        return pos.entry_price;
    }
    let cost = cost_bp / 10_000.0;
    match pos.direction {
        PositionSide::Long => pos.entry_price * (1.0 + cost),
        PositionSide::Short => pos.entry_price * (1.0 - cost),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExitOutcome {
    pub exit_price: f64,
    pub reason: ExitReason,
}

/// Process exits for one open position at the current bar. Mutates `pos`
/// in-place: high_watermark, beActive, ptpTriggered, ptpRealizedPct,
/// ptpLevelIdx, ptpLevelsRealized, stopPrice (chandelier / BE).
///
/// Returns Some(ExitOutcome) if this bar closes the position; None to
/// continue holding.
///
/// `bars_held` is the count of bars elapsed since entry. Used by the
/// optional time-exit when `cfg.time_exit_enabled`.
pub fn process_position_exit(
    pos: &mut OpenPosition,
    candle: &Candle,
    cfg: &EngineConfig,
    atr_at_bar: Option<f64>,
) -> Option<ExitOutcome> {
    process_position_exit_with_held(pos, candle, cfg, atr_at_bar, 0)
}

pub fn process_position_exit_with_held(
    pos: &mut OpenPosition,
    candle: &Candle,
    cfg: &EngineConfig,
    atr_at_bar: Option<f64>,
    bars_held: u64,
) -> Option<ExitOutcome> {
    // 2026-05-13 Codex Round 6 #P2+P4 FIX (REVISED): exit-modifier ordering
    // mirrors source backtest `ftmoDaytrade24h.ts` exactly:
    //   1. high-watermark update (pre-cross)
    //   2. PTP single-tier (PRE-cross; has stop-guard + gap-past-ptp
    //      exception that lets PTP fire even when stop also hit — source
    //      ftmoDaytrade24h.ts:4520-4569)
    //   3. PTP multi-level (PRE-cross — same gap-past + stop-guard rules)
    //   4. SL/TP cross-check (with the possibly BE-adjusted stop from PTP)
    //   5. POST-cross: standalone-BE, trailingStop, chandelier (these MUST
    //      stay post-cross because their same-bar tighten-then-stop pattern
    //      is the bug Codex Round 5 flagged — they read candle.high/low
    //      and could otherwise fire stop_hit within the same bar)
    //   6. Optional time-exit (post-cross)
    // The earlier Round 6 attempt moved PTP to post-cross too, which broke
    // gap-past-ptp + same-bar-stop → BE-stop semantics.

    // 1. Update high-watermark.
    match pos.direction {
        PositionSide::Long => {
            if candle.high > pos.high_watermark {
                pos.high_watermark = candle.high;
            }
        }
        PositionSide::Short => {
            if candle.low < pos.high_watermark {
                pos.high_watermark = candle.low;
            }
        }
    }

    // 2. PartialTakeProfit (single-tier) — PRE-cross with stop-guard.
    if let Some(ptp) = cfg.partial_take_profit {
        if !pos.ptp_triggered {
            let trigger_price = match pos.direction {
                PositionSide::Long => pos.entry_price * (1.0 + ptp.trigger_pct),
                PositionSide::Short => pos.entry_price * (1.0 - ptp.trigger_pct),
            };
            let ptp_hit = match pos.direction {
                PositionSide::Long => candle.high >= trigger_price,
                PositionSide::Short => candle.low <= trigger_price,
            };
            let stop_hit = match pos.direction {
                PositionSide::Long => candle.low <= pos.stop_price,
                PositionSide::Short => candle.high >= pos.stop_price,
            };
            let gap_past_ptp = match pos.direction {
                PositionSide::Long => candle.open >= trigger_price,
                PositionSide::Short => candle.open <= trigger_price,
            };
            // R54-V4-3: stop wins same-bar tie unless the bar GAPPED past PTP.
            if ptp_hit && (!stop_hit || gap_past_ptp) {
                pos.ptp_triggered = true;
                // 2026-05-13 Codex Round 6 #P3 FIX: PTP realized net of
                // partial-fill cost (round-trip cost on the closed
                // fraction). Mirrors TS V4 commit a6a411c.
                let asset = cfg.assets.iter().find(|a| a.symbol == pos.symbol);
                let cost = asset.and_then(|a| a.cost_bp).unwrap_or(0.0) / 10_000.0;
                pos.ptp_realized_pct =
                    ptp.close_fraction * (ptp.trigger_pct - cost);
                // Auto-BE — cost-adjusted (Codex Round 6 #P3).
                let be_stop = cost_adjusted_be(pos, cfg);
                match pos.direction {
                    PositionSide::Long => {
                        if be_stop > pos.stop_price {
                            pos.stop_price = be_stop;
                        }
                    }
                    PositionSide::Short => {
                        if be_stop < pos.stop_price {
                            pos.stop_price = be_stop;
                        }
                    }
                }
                pos.be_active = true;
                pos.high_watermark = candle.close;
            }
        }
    }

    // 2b. Multi-level PTP.
    // R67-r17 BIT-PRECISE port from TS lines 840-878:
    //   1. Same-bar stop-guard: if stop also hit on this bar AND the bar
    //      did NOT gap past the level trigger, stop wins for this level
    //      (and all subsequent — they require a higher wick).
    //   2. After at least one level realises: auto-move stop to BE
    //      (direction-aware, only if entry is more favourable than current
    //      stop), set be_active=true, reset high_watermark = candle.close
    //      (parity with single-tier branch).
    if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
        let stop_hit_multi = match pos.direction {
            PositionSide::Long => candle.low <= pos.stop_price,
            PositionSide::Short => candle.high >= pos.stop_price,
        };
        let mut realised_any = false;
        while pos.ptp_level_idx < levels.len() {
            let lvl = &levels[pos.ptp_level_idx];
            let trigger_price = match pos.direction {
                PositionSide::Long => pos.entry_price * (1.0 + lvl.trigger_pct),
                PositionSide::Short => pos.entry_price * (1.0 - lvl.trigger_pct),
            };
            let lvl_hit = match pos.direction {
                PositionSide::Long => candle.high >= trigger_price,
                PositionSide::Short => candle.low <= trigger_price,
            };
            if !lvl_hit {
                break;
            }
            // Stop-guard: if stop also hit and we did not gap past the
            // trigger, stop wins for THIS level (and all subsequent).
            let gap_past_lvl = match pos.direction {
                PositionSide::Long => candle.open >= trigger_price,
                PositionSide::Short => candle.open <= trigger_price,
            };
            if stop_hit_multi && !gap_past_lvl {
                break;
            }
            // 2026-05-13 Codex Round 6 #P3: cost-net per level.
            let asset = cfg.assets.iter().find(|a| a.symbol == pos.symbol);
            let cost = asset.and_then(|a| a.cost_bp).unwrap_or(0.0) / 10_000.0;
            pos.ptp_levels_realized +=
                lvl.close_fraction * (lvl.trigger_pct - cost);
            pos.ptp_level_idx += 1;
            realised_any = true;
        }
        if realised_any {
            // 2026-05-13 Codex Round 6 #P3: cost-adjusted BE after partial.
            let be_stop = cost_adjusted_be(pos, cfg);
            match pos.direction {
                PositionSide::Long => {
                    if be_stop > pos.stop_price {
                        pos.stop_price = be_stop;
                    }
                }
                PositionSide::Short => {
                    if be_stop < pos.stop_price {
                        pos.stop_price = be_stop;
                    }
                }
            }
            pos.be_active = true;
            pos.high_watermark = candle.close;
        }
    }

    // 2c. SL/TP cross-check — runs AFTER PTP pre-cross (which may have moved
    // stop to BE) but BEFORE standalone-BE/trailingStop/chandelier (which
    // must be post-cross to avoid same-bar tighten-then-stop). Mirrors
    // source backtest ftmoDaytrade24h.ts:4575+.
    match pos.direction {
        PositionSide::Long => {
            let stop_hit = candle.low <= pos.stop_price;
            let tp_hit = candle.high >= pos.tp_price;
            let gap_past_tp = candle.open >= pos.tp_price;
            if tp_hit && gap_past_tp {
                return Some(ExitOutcome {
                    exit_price: candle.open,
                    reason: ExitReason::Tp,
                });
            }
            if stop_hit {
                let exit_price = if candle.open < pos.stop_price {
                    candle.open
                } else {
                    pos.stop_price
                };
                return Some(ExitOutcome {
                    exit_price,
                    reason: ExitReason::Stop,
                });
            }
            if tp_hit {
                return Some(ExitOutcome {
                    exit_price: pos.tp_price,
                    reason: ExitReason::Tp,
                });
            }
        }
        PositionSide::Short => {
            let stop_hit = candle.high >= pos.stop_price;
            let tp_hit = candle.low <= pos.tp_price;
            let gap_past_tp = candle.open <= pos.tp_price;
            if tp_hit && gap_past_tp {
                return Some(ExitOutcome {
                    exit_price: candle.open,
                    reason: ExitReason::Tp,
                });
            }
            if stop_hit {
                let exit_price = if candle.open > pos.stop_price {
                    candle.open
                } else {
                    pos.stop_price
                };
                return Some(ExitOutcome {
                    exit_price,
                    reason: ExitReason::Stop,
                });
            }
            if tp_hit {
                return Some(ExitOutcome {
                    exit_price: pos.tp_price,
                    reason: ExitReason::Tp,
                });
            }
        }
    }

    // 3. BreakEven shift — cost-adjusted (Codex Round 6 #P3). POST-CROSS.
    if let Some(be) = cfg.break_even {
        if !pos.be_active {
            let fav = match pos.direction {
                PositionSide::Long => (candle.close - pos.entry_price) / pos.entry_price,
                PositionSide::Short => (pos.entry_price - candle.close) / pos.entry_price,
            };
            if fav >= be.threshold {
                pos.stop_price = cost_adjusted_be(pos, cfg);
                pos.be_active = true;
            }
        }
    }

    // 4. ChandelierExit — ATR-smoothed trailing stop gated by minMoveR.
    if let (Some(chand), Some(atr)) = (cfg.chandelier_exit, atr_at_bar) {
        let min_move_r = chand.min_move_r.unwrap_or(0.5);
        let original_r = pos.initial_stop_pct * pos.entry_price;
        if original_r > 0.0 {
            let move_r = match pos.direction {
                PositionSide::Long => (pos.high_watermark - pos.entry_price) / original_r,
                PositionSide::Short => (pos.entry_price - pos.high_watermark) / original_r,
            };
            if move_r >= min_move_r {
                let trail_dist = chand.mult * atr;
                match pos.direction {
                    PositionSide::Long => {
                        let new_stop = pos.high_watermark - trail_dist;
                        if new_stop > pos.stop_price {
                            pos.stop_price = new_stop;
                        }
                    }
                    PositionSide::Short => {
                        let new_stop = pos.high_watermark + trail_dist;
                        if new_stop < pos.stop_price {
                            pos.stop_price = new_stop;
                        }
                    }
                }
            }
        }
    }

    // 5. POST-CROSS TrailingStop — only updates state if the position
    //    survived this bar's SL/TP cross. Mirrors `ftmoDaytrade24h.ts:4670-4691`
    //    where trailingStop runs AFTER the cross-detection block at L4587-4619.
    //    Tightened stop affects the NEXT bar's cross, not the current — TS
    //    semantic prevents same-bar premature stop-outs when the bar wicks
    //    below the trail-stop after closing higher than the previous peak.
    if let Some(trail) = cfg.trailing_stop {
        let unrealized = match pos.direction {
            PositionSide::Long => (candle.close - pos.entry_price) / pos.entry_price,
            PositionSide::Short => (pos.entry_price - candle.close) / pos.entry_price,
        };
        if !pos.trail_active && unrealized >= trail.activate_pct {
            pos.trail_active = true;
            pos.trail_peak = candle.close;
        }
        if pos.trail_active {
            match pos.direction {
                PositionSide::Long => {
                    if candle.close > pos.trail_peak {
                        pos.trail_peak = candle.close;
                    }
                    let trail_stop = pos.trail_peak * (1.0 - trail.trail_pct);
                    if trail_stop > pos.stop_price {
                        pos.stop_price = trail_stop;
                    }
                }
                PositionSide::Short => {
                    if candle.close < pos.trail_peak {
                        pos.trail_peak = candle.close;
                    }
                    let trail_stop = pos.trail_peak * (1.0 + trail.trail_pct);
                    if trail_stop < pos.stop_price {
                        pos.stop_price = trail_stop;
                    }
                }
            }
        }
    }

    // 7. Optional time-exit. V4-Sim disables this for parity; V5R/Backtest engines
    //    may opt in via `cfg.time_exit_enabled`. The hold-bars limit comes from
    //    the per-asset override or `cfg.hold_bars` fallback.
    if cfg.time_exit_enabled {
        let hold_limit = cfg
            .assets
            .iter()
            .find(|a| a.symbol == pos.symbol)
            .and_then(|a| a.hold_bars)
            .unwrap_or(cfg.hold_bars) as u64;
        if hold_limit > 0 && bars_held >= hold_limit {
            return Some(ExitOutcome {
                exit_price: candle.close,
                reason: ExitReason::Time,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        BreakEven, ChandelierExit, EngineConfig, PartialTakeProfit, PartialTakeProfitLevel,
        TrailingStop,
    };

    fn base_cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }

    fn long_pos(entry: f64) -> OpenPosition {
        OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: entry,
            initial_stop_pct: 0.02,
            stop_price: entry * 0.98,
            tp_price: entry * 1.04,
            eff_risk: 0.4,
            entry_bar_idx: 0,
            high_watermark: entry,
            be_active: false,
            ptp_triggered: false,
            ptp_realized_pct: 0.0,
            ptp_level_idx: 0,
            ptp_levels_realized: 0.0,
            last_known_price: None,
            trail_active: false,
            trail_peak: 0.0,
            original_eff_risk: 0.4,
            pyramid_adds_done: 0,
        }
    }

    fn short_pos(entry: f64) -> OpenPosition {
        let mut p = long_pos(entry);
        p.direction = PositionSide::Short;
        p.stop_price = entry * 1.02;
        p.tp_price = entry * 0.96;
        p
    }

    fn bar(open: f64, high: f64, low: f64, close: f64) -> Candle {
        Candle::new(0, open, high, low, close, 0.0)
    }

    #[test]
    fn long_normal_tp_cross() {
        let cfg = base_cfg();
        let mut p = long_pos(100.0);
        let c = bar(101.0, 104.5, 100.5, 104.0);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        assert_eq!(r.reason, ExitReason::Tp);
        assert!((r.exit_price - 104.0).abs() < 1e-9);
    }

    #[test]
    fn long_normal_stop_cross() {
        let cfg = base_cfg();
        let mut p = long_pos(100.0);
        let c = bar(99.5, 99.9, 97.5, 98.5);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        assert_eq!(r.reason, ExitReason::Stop);
        assert!((r.exit_price - 98.0).abs() < 1e-9);
    }

    #[test]
    fn long_gap_past_tp_uses_open_price() {
        let cfg = base_cfg();
        let mut p = long_pos(100.0);
        // Gap-up: open at 105 (above TP=104). exitPrice should be open.
        let c = bar(105.0, 106.0, 104.5, 105.5);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        assert_eq!(r.reason, ExitReason::Tp);
        assert_eq!(r.exit_price, 105.0);
    }

    #[test]
    fn long_gap_past_stop_uses_open_price() {
        let cfg = base_cfg();
        let mut p = long_pos(100.0);
        // Gap-down: open at 96 (below stop=98). exit at 96.
        let c = bar(96.0, 97.0, 95.5, 96.5);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        assert_eq!(r.reason, ExitReason::Stop);
        assert_eq!(r.exit_price, 96.0);
    }

    #[test]
    fn long_same_bar_ptp_and_stop_stop_wins_without_gap() {
        let mut cfg = base_cfg();
        cfg.partial_take_profit = Some(PartialTakeProfit {
            trigger_pct: 0.02,
            close_fraction: 0.5,
        });
        let mut p = long_pos(100.0);
        // Wick up to PTP at 102, then down to stop at 98. Bar open between PTP and stop.
        let c = bar(101.0, 102.5, 97.5, 98.5);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        // Conservative — STOP wins (priority match TS line ~795).
        assert_eq!(r.reason, ExitReason::Stop);
        // PTP should NOT be triggered because stop hit on this bar.
        assert!(!p.ptp_triggered);
    }

    #[test]
    fn long_ptp_with_gap_past_ptp_fires_then_continues() {
        let mut cfg = base_cfg();
        cfg.partial_take_profit = Some(PartialTakeProfit {
            trigger_pct: 0.02,
            close_fraction: 0.5,
        });
        let mut p = long_pos(100.0);
        // Open at 102.5 (gap past PTP=102), low to 98 (stop). PTP fires first → BE → stop at 100 (BE).
        let c = bar(102.5, 103.0, 98.0, 99.5);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        // PTP triggered + stop moved to BE=100, then stop crossed via candle.low=98 → exit at BE.
        assert!(p.ptp_triggered);
        assert_eq!(p.stop_price, 100.0);
        assert_eq!(r.reason, ExitReason::Stop);
        assert!((r.exit_price - 100.0).abs() < 1e-9);
    }

    #[test]
    fn short_gap_past_tp_uses_open_price() {
        let cfg = base_cfg();
        let mut p = short_pos(100.0);
        // Gap-down: open at 95 (below TP=96).
        let c = bar(95.0, 95.5, 94.0, 94.5);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        assert_eq!(r.reason, ExitReason::Tp);
        assert_eq!(r.exit_price, 95.0);
    }

    #[test]
    fn break_even_shifts_stop() {
        let mut cfg = base_cfg();
        cfg.break_even = Some(BreakEven { threshold: 0.01 });
        let mut p = long_pos(100.0);
        // Close at 101.5 = +1.5% favourable, exceeds threshold → BE triggers.
        // Bar low must stay strictly above the new BE stop (=100) so cross-
        // detection doesn't immediately fire.
        let c = bar(100.5, 101.6, 100.5, 101.5);
        let r = process_position_exit(&mut p, &c, &cfg, None);
        assert!(r.is_none(), "no exit on this bar");
        assert!(p.be_active);
        assert_eq!(p.stop_price, p.entry_price);
    }

    #[test]
    fn chandelier_trails_stop_after_min_move_r() {
        let mut cfg = base_cfg();
        cfg.chandelier_exit = Some(ChandelierExit {
            period: 14,
            mult: 2.0,
            min_move_r: Some(0.5),
        });
        let mut p = long_pos(100.0);
        // High-watermark moves to 103 (= 1.5R move), ATR=0.5 → trail dist 1.0
        // → new stop = 103 - 1.0 = 102. Bar low must stay above the new stop
        // for the trail-up to be observable without firing the cross.
        let c = bar(102.5, 103.0, 102.5, 102.8);
        let r = process_position_exit(&mut p, &c, &cfg, Some(0.5));
        assert!(r.is_none());
        assert_eq!(p.high_watermark, 103.0);
        assert!((p.stop_price - 102.0).abs() < 1e-9);
    }

    #[test]
    fn multi_level_ptp_fires_levels_in_order() {
        let mut cfg = base_cfg();
        cfg.partial_take_profit_levels = Some(vec![
            PartialTakeProfitLevel {
                trigger_pct: 0.01,
                close_fraction: 0.25,
            },
            PartialTakeProfitLevel {
                trigger_pct: 0.02,
                close_fraction: 0.25,
            },
            PartialTakeProfitLevel {
                trigger_pct: 0.03,
                close_fraction: 0.25,
            },
        ]);
        let mut p = long_pos(100.0);
        // Bar runs through levels 1 + 2 (high=102.5) but not 3 (would need 103).
        // R67-r17: after partial realisation the stop is auto-moved to BE
        // (=100), so candle.low must stay STRICTLY above 100 for the bar to
        // not also fire the cross-detection.
        let c = bar(100.5, 102.5, 100.5, 102.0);
        let r = process_position_exit(&mut p, &c, &cfg, None);
        assert!(r.is_none(), "no exit: stop pushed to BE, low strictly > BE");
        assert_eq!(p.ptp_level_idx, 2);
        // 0.25 * 0.01 + 0.25 * 0.02 = 0.0075 realised
        assert!((p.ptp_levels_realized - 0.0075).abs() < 1e-9);
        // R67-r17 invariants: BE auto-shift + chandelier reset.
        assert!(p.be_active, "BE should be activated after partial realise");
        assert_eq!(p.stop_price, 100.0, "stop pushed to BE = entry");
        assert_eq!(
            p.high_watermark, 102.0,
            "highWatermark reset to candle.close"
        );
    }

    #[test]
    fn multi_level_ptp_same_bar_stop_wins_without_gap() {
        // R67-r17 BIT-PRECISE port: if stop also hit on a bar where the
        // wick reached PTP without a gap-past-trigger, stop wins (matches
        // single-tier branch + backtest 4228 conservatism).
        let mut cfg = base_cfg();
        cfg.partial_take_profit_levels = Some(vec![
            PartialTakeProfitLevel {
                trigger_pct: 0.01,
                close_fraction: 0.25,
            },
            PartialTakeProfitLevel {
                trigger_pct: 0.02,
                close_fraction: 0.25,
            },
        ]);
        let mut p = long_pos(100.0);
        // Open between PTP and stop, wick to 102 (lvl 2 trigger), low to 98 (stop).
        let c = bar(100.5, 102.5, 97.5, 98.5);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        assert_eq!(r.reason, ExitReason::Stop);
        assert_eq!(p.ptp_level_idx, 0, "no PTP level realised — stop won");
        assert_eq!(p.ptp_levels_realized, 0.0);
    }

    #[test]
    fn multi_level_ptp_gap_past_trigger_realises_then_be() {
        // Bar gaps past level-1 trigger → that level realises despite stop
        // also being hit. Lvl 2 wick happens but no gap → lvl 2 NOT realised.
        let mut cfg = base_cfg();
        cfg.partial_take_profit_levels = Some(vec![
            PartialTakeProfitLevel {
                trigger_pct: 0.01,
                close_fraction: 0.25,
            },
            PartialTakeProfitLevel {
                trigger_pct: 0.02,
                close_fraction: 0.25,
            },
        ]);
        let mut p = long_pos(100.0);
        // Gap-up open at 101.5 (>101 lvl1 trigger, <102 lvl2 trigger),
        // wick high 102.5 (touches lvl 2 but no gap), low 98 (stop).
        let c = bar(101.5, 102.5, 98.0, 99.0);
        let r = process_position_exit(&mut p, &c, &cfg, None).unwrap();
        // Lvl 1 realises (gap past), lvl 2 blocked by stop-guard.
        assert_eq!(p.ptp_level_idx, 1);
        assert!(
            (p.ptp_levels_realized - 0.0025).abs() < 1e-12,
            "0.25 × 0.01 = 0.0025"
        );
        // BE shift activated → stop now 100. Candle.low=98 → cross fires at BE.
        assert!(p.be_active);
        assert_eq!(p.stop_price, 100.0);
        assert_eq!(r.reason, ExitReason::Stop);
        assert!(
            (r.exit_price - 100.0).abs() < 1e-9,
            "exit at BE, not orig stop"
        );
    }

    /// 2026-05-14 Detector #18 — 3-tier sequence test (state-corruption
    /// safety for the multi-bar path).
    ///
    /// Setup: 3 PTP tiers (1%, 2%, 3%) each closing 0.25, cost_bp=30.
    ///   Bar 1 — high tags tier 1 (≥101), low stays above BE → realise tier 1.
    ///   Bar 2 — high tags tier 2 (≥102), low stays above BE → realise tier 2.
    ///   Bar 3 — low crosses the BE stop → exit at cost-adjusted BE.
    ///
    /// Asserts:
    ///   * `ptp_levels_realized` == sum_{tier∈{1,2}} fraction × (trigger − cost).
    ///   * exit_price == entry × (1 + cost_bp/10_000).
    ///   * tier 3 is left untouched in `ptp_level_idx`.
    #[test]
    fn multi_level_ptp_three_tier_sequence_then_be_stop() {
        use crate::config::AssetConfig;
        let mut cfg = base_cfg();
        // Inject explicit cost_bp on the test symbol so the BE adjustment is
        // observable (raw entry would be 100.0 otherwise).
        cfg.assets = vec![AssetConfig {
            symbol: "BTC-TREND".into(),
            source_symbol: Some("BTCUSDT".into()),
            risk_frac: 0.4,
            cost_bp: Some(30.0),
            ..Default::default()
        }];
        cfg.partial_take_profit = None;
        cfg.partial_take_profit_levels = Some(vec![
            PartialTakeProfitLevel {
                trigger_pct: 0.01,
                close_fraction: 0.25,
            },
            PartialTakeProfitLevel {
                trigger_pct: 0.02,
                close_fraction: 0.25,
            },
            PartialTakeProfitLevel {
                trigger_pct: 0.03,
                close_fraction: 0.25,
            },
        ]);

        let cost = 30.0 / 10_000.0; // = 0.003
        let be_stop = 100.0 * (1.0 + cost); // = 100.30

        let mut p = long_pos(100.0);

        // Bar 1: high 101.2 hits tier 1 (≥101.0), tier 2 (≥102.0) NOT hit.
        // Low must stay above BE (100.30) so no cross on this bar.
        let bar1 = bar(100.5, 101.2, 100.4, 101.0);
        let r1 = process_position_exit(&mut p, &bar1, &cfg, None);
        assert!(r1.is_none(), "bar1 must not exit");
        assert_eq!(p.ptp_level_idx, 1, "tier 1 realised");
        assert!(p.be_active, "BE shift after first realise");
        assert!(
            (p.stop_price - be_stop).abs() < 1e-9,
            "stop pushed to cost-adjusted BE = {be_stop}, got {}",
            p.stop_price
        );

        // Bar 2: high 102.5 hits tier 2 (≥102.0), tier 3 (≥103.0) NOT hit.
        // Low must stay above BE so no cross.
        let bar2 = bar(101.1, 102.5, 100.5, 102.2);
        let r2 = process_position_exit(&mut p, &bar2, &cfg, None);
        assert!(r2.is_none(), "bar2 must not exit");
        assert_eq!(p.ptp_level_idx, 2, "tier 2 realised");
        // tier 1 + tier 2 cost-net sum.
        let expected_realised =
            0.25 * (0.01 - cost) + 0.25 * (0.02 - cost);
        assert!(
            (p.ptp_levels_realized - expected_realised).abs() < 1e-12,
            "ptp_levels_realized = {expected_realised}, got {}",
            p.ptp_levels_realized
        );

        // Bar 3: low 100.20 < BE (100.30) → stop crosses at cost-adjusted BE.
        let bar3 = bar(101.0, 101.5, 100.20, 100.50);
        let r3 = process_position_exit(&mut p, &bar3, &cfg, None).unwrap();
        assert_eq!(r3.reason, ExitReason::Stop);
        assert!(
            (r3.exit_price - be_stop).abs() < 1e-9,
            "exit at cost-adjusted BE = {be_stop}, got {}",
            r3.exit_price
        );
        // Tier 3 must NOT have been touched (bar3 high was 101.5 — below the
        // 103 trigger — and the cross fires before any wick could).
        assert_eq!(p.ptp_level_idx, 2, "tier 3 must remain unrealised");
        assert!(
            (p.ptp_levels_realized - expected_realised).abs() < 1e-12,
            "ptp_levels_realized unchanged on bar 3"
        );
    }

    #[test]
    fn no_movement_returns_none() {
        let cfg = base_cfg();
        let mut p = long_pos(100.0);
        let c = bar(100.0, 100.5, 99.5, 100.0);
        assert!(process_position_exit(&mut p, &c, &cfg, None).is_none());
    }

    // ─── trailingStop port — parity with `ftmoDaytrade24h.ts:4670-4691` ──

    #[test]
    fn trailing_stop_arms_on_activate_pct() {
        // Long: entry=100, activatePct=3%. Bar closes at 103 → trail arms,
        // trail_peak=103, trail_stop = 103 × (1 − 0.005) = 102.485.
        let mut cfg = base_cfg();
        cfg.trailing_stop = Some(TrailingStop {
            activate_pct: 0.03,
            trail_pct: 0.005,
        });
        let mut p = long_pos(100.0);
        // Bar low must stay strictly above the new stop so we observe arming
        // without triggering the cross.
        let c = bar(102.0, 103.5, 102.6, 103.0);
        let r = process_position_exit(&mut p, &c, &cfg, None);
        assert!(r.is_none());
        assert!(p.trail_active);
        assert!((p.trail_peak - 103.0).abs() < 1e-9);
        assert!((p.stop_price - 102.485).abs() < 1e-9);
    }

    #[test]
    fn trailing_stop_does_not_arm_below_threshold() {
        let mut cfg = base_cfg();
        cfg.trailing_stop = Some(TrailingStop {
            activate_pct: 0.03,
            trail_pct: 0.005,
        });
        let mut p = long_pos(100.0);
        // Close at 102 = +2% favourable, below 3% threshold.
        let c = bar(101.5, 102.2, 101.0, 102.0);
        let r = process_position_exit(&mut p, &c, &cfg, None);
        assert!(r.is_none());
        assert!(!p.trail_active);
        assert!((p.stop_price - 98.0).abs() < 1e-9, "stop unchanged");
    }

    #[test]
    fn trailing_stop_only_tightens_long() {
        // After arming at 103, a lower close (102) must NOT lower the stop.
        let mut cfg = base_cfg();
        cfg.trailing_stop = Some(TrailingStop {
            activate_pct: 0.03,
            trail_pct: 0.005,
        });
        let mut p = long_pos(100.0);
        let c1 = bar(102.0, 103.5, 102.6, 103.0);
        process_position_exit(&mut p, &c1, &cfg, None);
        let stop_after_arm = p.stop_price;
        // Subsequent bar: lower close at 102.8. Bar low must stay strictly
        // above the trail-stop (102.485) so cross does not fire.
        let c2 = bar(102.9, 103.2, 102.6, 102.8);
        let r = process_position_exit(&mut p, &c2, &cfg, None);
        assert!(r.is_none());
        assert!(
            (p.trail_peak - 103.0).abs() < 1e-9,
            "peak unchanged on lower close"
        );
        assert!(
            (p.stop_price - stop_after_arm).abs() < 1e-9,
            "stop monotone"
        );
    }

    #[test]
    fn trailing_stop_short_arms_and_tightens() {
        // Short: entry=100, close=97 → unrealised +3%, arms. trail_peak=97,
        // trail_stop = 97 × 1.005 = 97.485.
        let mut cfg = base_cfg();
        cfg.trailing_stop = Some(TrailingStop {
            activate_pct: 0.03,
            trail_pct: 0.005,
        });
        let mut p = short_pos(100.0);
        // Bar high must stay strictly BELOW the new stop so cross doesn't fire.
        let c = bar(98.0, 97.4, 96.5, 97.0);
        let r = process_position_exit(&mut p, &c, &cfg, None);
        assert!(r.is_none());
        assert!(p.trail_active);
        assert!((p.trail_peak - 97.0).abs() < 1e-9);
        assert!((p.stop_price - 97.485).abs() < 1e-9);
    }
}
