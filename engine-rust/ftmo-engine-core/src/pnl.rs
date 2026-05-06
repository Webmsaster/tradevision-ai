//! PnL math — port of `computeEffPnl` and `computeMtmEquity` from
//! `ftmoLiveEngineV4.ts`.
//!
//! GAP_TAIL_MULT (-1.5) is the realised-loss floor that absorbs slippage
//! through the stop on weekend gaps. Without it the engine clamps every
//! loss to exactly -stopPct → gap-tail realism is silently disabled and
//! pass-rate over-stated. Same rule applies to unrealised PnL in
//! `computeMtmEquity` so dailyPeakTrailingStop / pDD math sees the same
//! floor mid-trade.

use std::collections::HashMap;

use crate::config::EngineConfig;
use crate::position::{OpenPosition, PositionSide};
use crate::state::EngineState;

/// -1.5R floor on losses (absorbs gap-through-stop slippage).
pub const GAP_TAIL_MULT: f64 = -1.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffPnl {
    pub raw_pnl: f64,
    pub eff_pnl: f64,
}

/// Compute realised effPnl for a position closing at `exit_price`. Includes
/// PTP partial-realised blend.
pub fn compute_eff_pnl(pos: &OpenPosition, exit_price: f64, cfg: &EngineConfig) -> EffPnl {
    // R67 audit fix: guard against entry_price ≤ 0 / non-finite. Without this,
    // a corrupted state file or a synthetic-test 0-priced asset produces NaN,
    // which propagates into state.equity and silently disables all failure
    // checks (NaN comparisons return false → challenge never ends).
    if !(pos.entry_price.is_finite()) || pos.entry_price <= 0.0 {
        return EffPnl { raw_pnl: 0.0, eff_pnl: 0.0 };
    }
    let mut raw_pnl = match pos.direction {
        PositionSide::Long => (exit_price - pos.entry_price) / pos.entry_price,
        PositionSide::Short => (pos.entry_price - exit_price) / pos.entry_price,
    };
    if pos.ptp_triggered {
        if let Some(ptp) = cfg.partial_take_profit {
            let cf = ptp.close_fraction;
            raw_pnl = pos.ptp_realized_pct + (1.0 - cf) * raw_pnl;
        }
    } else if pos.ptp_levels_realized > 0.0 {
        if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
            let total_closed: f64 = levels
                .iter()
                .take(pos.ptp_level_idx)
                .map(|l| l.close_fraction)
                .sum();
            raw_pnl = pos.ptp_levels_realized + (1.0 - total_closed) * raw_pnl;
        }
    }
    let eff_pnl = (raw_pnl * cfg.leverage * pos.eff_risk).max(GAP_TAIL_MULT * pos.eff_risk);
    EffPnl { raw_pnl, eff_pnl }
}

/// Mark-to-market equity = realised + Σ unrealised at the current bar.
/// Mutates `pos.last_known_price` for every position whose source symbol
/// has a price — Round 58 fix: gives a non-entryPrice fallback for
/// end-of-window force-close on broken feeds.
pub fn compute_mtm_equity(
    state: &mut EngineState,
    prices_by_source: &HashMap<String, f64>,
    cfg: &EngineConfig,
) -> f64 {
    let mut mtm = state.equity;
    for pos in state.open_positions.iter_mut() {
        // R67 audit: fall back to last_known_price when current feed missing.
        // Original code skipped feedless positions entirely, undercounting
        // unrealised loss → DailyEquityGuardian could fail to fire when a
        // 30%-underwater position briefly loses its feed.
        let price = match prices_by_source
            .get(&pos.source_symbol)
            .copied()
            .or(pos.last_known_price)
        {
            Some(p) if p.is_finite() && p > 0.0 => p,
            _ => continue, // truly no price known and no fallback
        };
        if prices_by_source.contains_key(&pos.source_symbol) {
            pos.last_known_price = Some(price);
        }
        // R67 audit fix: guard against entry_price ≤ 0 / non-finite (NaN
        // poisoning of state.equity, see compute_eff_pnl).
        if !(pos.entry_price.is_finite()) || pos.entry_price <= 0.0 {
            continue;
        }
        let mut raw_pnl = match pos.direction {
            PositionSide::Long => (price - pos.entry_price) / pos.entry_price,
            PositionSide::Short => (pos.entry_price - price) / pos.entry_price,
        };
        if pos.ptp_triggered {
            if let Some(ptp) = cfg.partial_take_profit {
                let close_frac = ptp.close_fraction;
                raw_pnl = pos.ptp_realized_pct + (1.0 - close_frac) * raw_pnl;
            }
        } else if pos.ptp_levels_realized > 0.0 {
            if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
                let total_closed: f64 = levels
                    .iter()
                    .take(pos.ptp_level_idx)
                    .map(|l| l.close_fraction)
                    .sum();
                raw_pnl = pos.ptp_levels_realized + (1.0 - total_closed) * raw_pnl;
            }
        }
        let unrealised =
            (raw_pnl * cfg.leverage * pos.eff_risk).max(GAP_TAIL_MULT * pos.eff_risk);
        mtm *= 1.0 + unrealised;
    }
    mtm
}

/// Inline trim — bound `kelly_pnls` and `closed_trades` between saves.
/// Mirrors `trimInline()` in the TS engine.
pub fn trim_inline(state: &mut EngineState, cfg: &EngineConfig) {
    let kelly_window = cfg.kelly_sizing.as_ref().map(|k| k.window_size).unwrap_or(100);
    let kelly_cap = (kelly_window as usize * 4).max(500);
    if state.kelly_pnls.len() > kelly_cap {
        let drop = state.kelly_pnls.len() - kelly_cap;
        state.kelly_pnls.drain(..drop);
    }
    if state.closed_trades.len() > 200 {
        let drop = state.closed_trades.len() - 200;
        state.closed_trades.drain(..drop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EngineConfig, PartialTakeProfit};
    use crate::position::{OpenPosition, PositionSide};

    fn base_cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }

    fn make_pos(direction: PositionSide, entry: f64) -> OpenPosition {
        OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction,
            entry_time: 0,
            entry_price: entry,
            initial_stop_pct: 0.02,
            stop_price: if direction == PositionSide::Long { entry * 0.98 } else { entry * 1.02 },
            tp_price: if direction == PositionSide::Long { entry * 1.04 } else { entry * 0.96 },
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

    #[test]
    fn eff_pnl_long_winner() {
        let cfg = base_cfg();
        let pos = make_pos(PositionSide::Long, 100.0);
        // +4% raw → 0.04 × 2 (lev) × 0.4 (risk) = 0.032 effPnl
        let r = compute_eff_pnl(&pos, 104.0, &cfg);
        assert!((r.raw_pnl - 0.04).abs() < 1e-12);
        assert!((r.eff_pnl - 0.032).abs() < 1e-12);
    }

    #[test]
    fn eff_pnl_short_winner() {
        let cfg = base_cfg();
        let pos = make_pos(PositionSide::Short, 100.0);
        // Short from 100, exit at 96 → +4% raw → 0.032 effPnl
        let r = compute_eff_pnl(&pos, 96.0, &cfg);
        assert!((r.raw_pnl - 0.04).abs() < 1e-12);
        assert!((r.eff_pnl - 0.032).abs() < 1e-12);
    }

    #[test]
    fn eff_pnl_clamped_at_gap_tail() {
        let cfg = base_cfg();
        let pos = make_pos(PositionSide::Long, 100.0);
        // -10% raw move → -0.10 * 2 * 0.4 = -0.08 — but floor is -1.5 * 0.4 = -0.6
        // So actual loss = -0.08 (within floor).
        let r = compute_eff_pnl(&pos, 90.0, &cfg);
        assert!((r.eff_pnl - -0.08).abs() < 1e-12);
        // -100% raw → -0.4 * 2 = -0.8 raw eff, but floor at -0.6.
        let r = compute_eff_pnl(&pos, 25.0, &cfg);
        assert!((r.eff_pnl - GAP_TAIL_MULT * pos.eff_risk).abs() < 1e-9);
    }

    #[test]
    fn eff_pnl_blends_ptp_partial() {
        let mut cfg = base_cfg();
        cfg.partial_take_profit = Some(PartialTakeProfit {
            trigger_pct: 0.02,
            close_fraction: 0.5,
        });
        let mut pos = make_pos(PositionSide::Long, 100.0);
        pos.ptp_triggered = true;
        pos.ptp_realized_pct = 0.5 * 0.02; // 50% closed at +2%
        // Remainder runs to 104 → raw remainder 4% × 50% = 0.02; total = 0.01 + 0.02 = 0.03
        let r = compute_eff_pnl(&pos, 104.0, &cfg);
        assert!((r.raw_pnl - 0.03).abs() < 1e-9);
        // effPnl = 0.03 × 2 × 0.4 = 0.024
        assert!((r.eff_pnl - 0.024).abs() < 1e-9);
    }

    #[test]
    fn mtm_equity_zero_positions_returns_realised() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        state.equity = 1.05;
        let prices = HashMap::new();
        assert_eq!(compute_mtm_equity(&mut state, &prices, &cfg), 1.05);
    }

    #[test]
    fn mtm_equity_blends_unrealised_long() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        let pos = make_pos(PositionSide::Long, 100.0);
        state.open_positions.push(pos);
        let mut prices = HashMap::new();
        prices.insert("BTCUSDT".into(), 102.0);
        let mtm = compute_mtm_equity(&mut state, &prices, &cfg);
        // raw=0.02, eff=0.02*2*0.4=0.016 → mtm = 1.0 * 1.016 = 1.016
        assert!((mtm - 1.016).abs() < 1e-9);
        // last_known_price was tracked
        assert_eq!(state.open_positions[0].last_known_price, Some(102.0));
    }

    #[test]
    fn mtm_equity_skips_when_no_price_for_symbol() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        state.open_positions.push(make_pos(PositionSide::Long, 100.0));
        let prices = HashMap::new(); // no price for BTCUSDT
        assert_eq!(compute_mtm_equity(&mut state, &prices, &cfg), state.equity);
    }

    #[test]
    fn trim_inline_caps_buffers() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        for i in 0..1000 {
            state.kelly_pnls.push(crate::state::KellyPnl {
                close_time: i,
                eff_pnl: 0.0,
            });
        }
        // No kelly_sizing → cap = max(500, 100×4) = 500
        trim_inline(&mut state, &cfg);
        assert_eq!(state.kelly_pnls.len(), 500);
        // Oldest should be dropped — kept the LAST 500 (close_time 500..999)
        assert_eq!(state.kelly_pnls[0].close_time, 500);
    }
}
