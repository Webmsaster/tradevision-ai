//! Exit logic — port of `processPositionExit` from `ftmoLiveEngineV4.ts`.
//!
//! Fires PTP / BE / chandelier mutation in-order, then resolves SL/TP at the
//! current bar with the same gap-fill semantics as the backtest engine
//! `runFtmoDaytrade24h` (R54 `R54-V4-3` parity tie-breaks for same-bar
//! PTP+stop, weekend-gap exit prices). Returns `Some(ExitOutcome)` if the
//! position closed at this bar, `None` otherwise.

use crate::candle::Candle;
use crate::config::EngineConfig;
use crate::position::{OpenPosition, PositionSide};
use crate::trade::ExitReason;

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

    // 2. PartialTakeProfit (single-tier).
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
                pos.ptp_realized_pct = ptp.close_fraction * ptp.trigger_pct;
                // Auto-BE.
                match pos.direction {
                    PositionSide::Long => {
                        if pos.entry_price > pos.stop_price {
                            pos.stop_price = pos.entry_price;
                        }
                    }
                    PositionSide::Short => {
                        if pos.entry_price < pos.stop_price {
                            pos.stop_price = pos.entry_price;
                        }
                    }
                }
                pos.be_active = true;
                pos.high_watermark = candle.close;
            }
        }
    }

    // 2b. Multi-level PTP.
    if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
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
            pos.ptp_levels_realized += lvl.close_fraction * lvl.trigger_pct;
            pos.ptp_level_idx += 1;
        }
    }

    // 3. BreakEven shift.
    if let Some(be) = cfg.break_even {
        if !pos.be_active {
            let fav = match pos.direction {
                PositionSide::Long => (candle.close - pos.entry_price) / pos.entry_price,
                PositionSide::Short => (pos.entry_price - candle.close) / pos.entry_price,
            };
            if fav >= be.threshold {
                pos.stop_price = pos.entry_price;
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

    // 5. SL/TP cross-detection with weekend-gap parity.
    match pos.direction {
        PositionSide::Long => {
            let stop_hit = candle.low <= pos.stop_price;
            let tp_hit = candle.high >= pos.tp_price;
            let gap_past_tp = candle.open >= pos.tp_price;
            if tp_hit && gap_past_tp {
                return Some(ExitOutcome { exit_price: candle.open, reason: ExitReason::Tp });
            }
            if stop_hit {
                let exit_price = if candle.open < pos.stop_price {
                    candle.open
                } else {
                    pos.stop_price
                };
                return Some(ExitOutcome { exit_price, reason: ExitReason::Stop });
            }
            if tp_hit {
                return Some(ExitOutcome { exit_price: pos.tp_price, reason: ExitReason::Tp });
            }
        }
        PositionSide::Short => {
            let stop_hit = candle.high >= pos.stop_price;
            let tp_hit = candle.low <= pos.tp_price;
            let gap_past_tp = candle.open <= pos.tp_price;
            if tp_hit && gap_past_tp {
                return Some(ExitOutcome { exit_price: candle.open, reason: ExitReason::Tp });
            }
            if stop_hit {
                let exit_price = if candle.open > pos.stop_price {
                    candle.open
                } else {
                    pos.stop_price
                };
                return Some(ExitOutcome { exit_price, reason: ExitReason::Stop });
            }
            if tp_hit {
                return Some(ExitOutcome { exit_price: pos.tp_price, reason: ExitReason::Tp });
            }
        }
    }

    // 6. Optional time-exit. V4-Sim disables this for parity; V5R/Backtest engines
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
            return Some(ExitOutcome { exit_price: candle.close, reason: ExitReason::Time });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        BreakEven, ChandelierExit, EngineConfig, PartialTakeProfit, PartialTakeProfitLevel,
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
        cfg.partial_take_profit = Some(PartialTakeProfit { trigger_pct: 0.02, close_fraction: 0.5 });
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
        cfg.partial_take_profit = Some(PartialTakeProfit { trigger_pct: 0.02, close_fraction: 0.5 });
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
        cfg.chandelier_exit = Some(ChandelierExit { period: 14, mult: 2.0, min_move_r: Some(0.5) });
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
            PartialTakeProfitLevel { trigger_pct: 0.01, close_fraction: 0.25 },
            PartialTakeProfitLevel { trigger_pct: 0.02, close_fraction: 0.25 },
            PartialTakeProfitLevel { trigger_pct: 0.03, close_fraction: 0.25 },
        ]);
        let mut p = long_pos(100.0);
        // Bar runs through levels 1 + 2 (high=102.5) but not 3 (would need 103).
        let c = bar(100.5, 102.5, 100.0, 102.0);
        let r = process_position_exit(&mut p, &c, &cfg, None);
        assert!(r.is_none());
        assert_eq!(p.ptp_level_idx, 2);
        // 0.25 * 0.01 + 0.25 * 0.02 = 0.0075 realised
        assert!((p.ptp_levels_realized - 0.0075).abs() < 1e-9);
    }

    #[test]
    fn no_movement_returns_none() {
        let cfg = base_cfg();
        let mut p = long_pos(100.0);
        let c = bar(100.0, 100.5, 99.5, 100.0);
        assert!(process_position_exit(&mut p, &c, &cfg, None).is_none());
    }
}
