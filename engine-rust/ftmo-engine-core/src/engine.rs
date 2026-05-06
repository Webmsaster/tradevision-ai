//! Phase 0/1 skeleton — `run_window` is the placeholder backtest entry-point.
//! The real port of `simulate()` from `ftmoLiveEngineV4.ts` walks
//! `pollLive()` bar-by-bar across an aligned candle window. That logic
//! depends on `detectAsset` (in `ftmoDaytrade24h.ts`, ~9.5kLOC) which has
//! not yet been ported — so for now we ship the data-types + helpers and
//! return `insufficient_days` until pollLive lands.

use std::collections::BTreeMap;

use crate::{Candle, EngineConfig, EngineState, FailReason, WindowResult};

pub struct WindowInput<'a> {
    pub config: &'a EngineConfig,
    pub bars_by_symbol: BTreeMap<String, Vec<Candle>>,
}

pub fn run_window(input: WindowInput<'_>) -> WindowResult {
    let mut state = EngineState::initial(&input.config.label);
    state.equity = 1.0;
    state.mtm_equity = 1.0;

    let total_bars: usize = input.bars_by_symbol.values().map(|v| v.len()).sum();
    if total_bars == 0 {
        return WindowResult {
            passed: false,
            fail_reason: Some(FailReason::InsufficientDays),
            final_equity_pct: 0.0,
            max_drawdown_pct: 0.0,
            days_to_pass: None,
            trades_taken: 0,
            max_single_loss_pct: 0.0,
        };
    }

    WindowResult {
        passed: false,
        fail_reason: Some(FailReason::InsufficientDays),
        final_equity_pct: state.equity_pct(),
        max_drawdown_pct: state.drawdown_from_peak(),
        days_to_pass: None,
        trades_taken: 0,
        max_single_loss_pct: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    #[test]
    fn empty_input_yields_insufficient_days() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        let r = run_window(WindowInput {
            config: &cfg,
            bars_by_symbol: BTreeMap::new(),
        });
        assert!(!r.passed);
        assert_eq!(r.fail_reason, Some(FailReason::InsufficientDays));
    }

    #[test]
    fn single_bar_input_does_not_pass() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        let mut bars = BTreeMap::new();
        let ts = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap().timestamp_millis();
        bars.insert(
            "BTCUSDT".to_string(),
            vec![Candle::new(ts, 100.0, 101.0, 99.0, 100.5, 1000.0)],
        );
        let r = run_window(WindowInput { config: &cfg, bars_by_symbol: bars });
        assert!(!r.passed);
    }
}
