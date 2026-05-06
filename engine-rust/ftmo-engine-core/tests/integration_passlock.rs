//! End-to-end integration: drive a multi-day mock challenge through the
//! harness and verify R28_V6_PASSLOCK semantics.
//!
//! Hits multiple paths simultaneously:
//!   - day-rollover (Prague-aware)
//!   - signal → position open
//!   - SL/TP exit
//!   - target detection on REALISED equity
//!   - PASSLOCK close-all on target
//!   - minTradingDays satisfaction → passed=true

use std::collections::HashMap;

use ftmo_engine_core::config::EngineConfig;
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::position::PositionSide;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::state::EngineState;
use ftmo_engine_core::Candle;

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
const HALF_HOUR_MS: i64 = 30 * 60 * 1_000;

fn candle(open_time: i64, open: f64, high: f64, low: f64, close: f64) -> Candle {
    Candle::new(open_time, open, high, low, close, 0.0)
}

fn input<'a>(
    candles_by_source: &'a HashMap<String, Vec<Candle>>,
    atr: &'a HashMap<String, Vec<Option<f64>>>,
    signals: Vec<PollSignal>,
) -> BarInput<'a> {
    BarInput {
        candles_by_source,
        atr_series_by_source: atr,
        signals,
    }
}

#[test]
fn passlock_closes_on_target_after_min_days() {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.profit_target = 0.04;
    cfg.max_total_loss = 0.10;
    cfg.max_daily_loss = 0.05;
    cfg.min_trading_days = 1;
    cfg.max_days = 10;
    cfg.leverage = 2.0;
    cfg.close_all_on_target_reached = true;

    // Anchor at Prague midnight so day_index ticks predictably.
    let start = chrono::DateTime::parse_from_rfc3339("2026-05-01T22:00:00+00:00")
        .unwrap()
        .timestamp_millis();

    let mut state = EngineState::initial(&cfg.label);
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    let atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![]);

    // ── Day 0 bar 0 ─────────────────────────────────────────────────────
    feed.get_mut("BTCUSDT").unwrap().push(candle(start, 100.0, 100.5, 99.5, 100.0));
    let entry_sig = PollSignal {
        symbol: "BTC-TREND".into(),
        source_symbol: "BTCUSDT".into(),
        direction: PositionSide::Long,
        entry_time: start,
        entry_price: 100.0,
        stop_price: 98.0,
        tp_price: 105.0,
        stop_pct: 0.02,
        tp_pct: 0.05,
        eff_risk: 0.4,
        chandelier_atr_at_entry: None,
    };
    let r0 = step_bar(&mut state, &input(&feed, &atr_feed, vec![entry_sig]), &cfg);
    assert_eq!(r0.decision.opens.len(), 1);
    assert_eq!(state.open_positions.len(), 1);
    assert_eq!(state.trading_days, vec![0]);

    // ── Day 0 bar 1 — small drift, no exit ───────────────────────────────
    feed.get_mut("BTCUSDT").unwrap().push(candle(
        start + HALF_HOUR_MS,
        100.0,
        100.6,
        99.7,
        100.2,
    ));
    let r1 = step_bar(&mut state, &input(&feed, &atr_feed, vec![]), &cfg);
    assert!(!r1.challenge_ended);
    assert_eq!(state.open_positions.len(), 1);

    // ── Day 1 bar — TP hit, realised equity should rise.
    // 5% raw × 2 lev × 0.4 risk = 0.04 = target hit exactly.
    feed.get_mut("BTCUSDT").unwrap().push(candle(
        start + DAY_MS,
        100.5,
        106.0,
        100.0,
        105.5,
    ));
    let r2 = step_bar(&mut state, &input(&feed, &atr_feed, vec![]), &cfg);
    // TP cross: exitPrice = tpPrice 105 → raw=0.05, eff=0.04. equity = 1.04.
    assert!((state.equity - 1.04).abs() < 1e-9, "equity={}", state.equity);
    // tradingDays remains [0] — entry-days only count, not exit-days.
    assert_eq!(state.trading_days, vec![0]);
    assert!(state.closed_trades.len() == 1);
    // Target hit AND minTradingDays=1 satisfied → passed.
    assert!(r2.target_hit);
    assert!(r2.passed);
    assert!(r2.challenge_ended);
}

#[test]
fn total_loss_breach_terminates_challenge() {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.max_total_loss = 0.05;
    cfg.max_daily_loss = 0.04;
    cfg.profit_target = 0.10;
    cfg.min_trading_days = 1;
    cfg.max_days = 30;
    cfg.leverage = 2.0;
    cfg.close_all_on_target_reached = false;

    let start = 1_700_000_000_000;
    let mut state = EngineState::initial(&cfg.label);
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    let atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![]);

    // Bar 0 — open with very wide stop so a single losing move blows past TL.
    feed.get_mut("BTCUSDT").unwrap().push(candle(start, 100.0, 100.5, 99.5, 100.0));
    let sig = PollSignal {
        symbol: "BTC-TREND".into(),
        source_symbol: "BTCUSDT".into(),
        direction: PositionSide::Long,
        entry_time: start,
        entry_price: 100.0,
        stop_price: 95.0,
        tp_price: 110.0,
        stop_pct: 0.05,
        tp_pct: 0.10,
        eff_risk: 0.6,
        chandelier_atr_at_entry: None,
    };
    let _ = step_bar(&mut state, &input(&feed, &atr_feed, vec![sig]), &cfg);
    assert_eq!(state.open_positions.len(), 1);

    // Bar 1 — gap-down through stop. Open=92, stop=95. exit at open=92 → raw=-0.08,
    // capped by GAP_TAIL_MULT (-1.5R). risk=0.6 → eff floor = -0.9. raw eff = -0.08*2*0.6 = -0.096.
    // Equity = 1.0 * (1-0.096) = 0.904 → past TL floor 0.95.
    feed.get_mut("BTCUSDT").unwrap().push(candle(
        start + HALF_HOUR_MS,
        92.0,
        93.0,
        91.0,
        92.5,
    ));
    let r = step_bar(&mut state, &input(&feed, &atr_feed, vec![]), &cfg);
    assert!(r.challenge_ended);
    assert_eq!(
        r.fail_reason,
        Some(ftmo_engine_core::harness::FailReason::TotalLoss)
    );
    assert!(state.equity < 0.95);
}

#[test]
fn idempotent_no_op_on_repeated_bar() {
    let cfg = EngineConfig::r28_v6_passlock_template();
    let mut state = EngineState::initial(&cfg.label);
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    let atr_feed: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    feed.insert(
        "BTCUSDT".into(),
        vec![candle(1_000, 100.0, 101.0, 99.0, 100.5)],
    );
    let _ = step_bar(&mut state, &input(&feed, &atr_feed, vec![]), &cfg);
    assert_eq!(state.bars_seen, 1);
    let r2 = step_bar(&mut state, &input(&feed, &atr_feed, vec![]), &cfg);
    assert!(r2.notes.iter().any(|n| n.contains("already processed")));
    assert_eq!(state.bars_seen, 1);
}
