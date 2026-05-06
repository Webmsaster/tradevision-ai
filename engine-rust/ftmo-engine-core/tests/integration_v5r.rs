//! End-to-end V5R-mode lifecycle: mean-rev signal opens position, gain
//! progresses, then a sharp adverse move triggers the dailyEquityGuardian
//! force-close. Verifies the full V5R-specific path through `step_bar`.

use std::collections::HashMap;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::{DailyEquityGuardian, EngineConfig};
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::position::{OpenPosition, PositionSide};
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::state::EngineState;
use ftmo_engine_core::v5r::is_v5r_mode;

const HOUR: i64 = 3_600_000;

#[test]
fn v5r_guardian_closes_on_intraday_drawdown() {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.profit_target = 0.10;
    cfg.max_total_loss = 0.10;
    cfg.max_daily_loss = 0.05;
    cfg.min_trading_days = 1;
    cfg.max_days = 5;
    cfg.daily_equity_guardian = Some(DailyEquityGuardian { trigger_pct: 0.02 });
    assert!(is_v5r_mode(&cfg));

    let start = 1_700_000_000_000i64;
    let mut state = EngineState::initial(&cfg.label);
    state.challenge_start_ts = start;
    state.last_bar_open_time = start - 1;
    state.day_start = 1.0;

    // Pre-load a long position with wide stop so it stays open.
    state.open_positions.push(OpenPosition {
        ticket_id: "v5r-1".into(),
        symbol: "BTC-TREND".into(),
        source_symbol: "BTCUSDT".into(),
        direction: PositionSide::Long,
        entry_time: start,
        entry_price: 100.0,
        initial_stop_pct: 0.05,
        stop_price: 95.0,
        tp_price: 110.0,
        eff_risk: 0.4,
        entry_bar_idx: 0,
        high_watermark: 100.0,
        be_active: false,
        ptp_triggered: false,
        ptp_realized_pct: 0.0,
        ptp_level_idx: 0,
        ptp_levels_realized: 0.0,
        last_known_price: None,
    });

    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![]);
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

    // Bar 0: small drift — guardian shouldn't fire.
    feed.get_mut("BTCUSDT").unwrap().push(Candle::new(start, 99.5, 100.0, 99.0, 99.0, 0.0));
    let r0 = step_bar(
        &mut state,
        &BarInput {
            candles_by_source: &feed,
            atr_series_by_source: &atr,
            signals: vec![],
        },
        &cfg,
    );
    assert!(!r0.notes.iter().any(|n| n.contains("dailyEquityGuardian")));
    assert_eq!(state.open_positions.len(), 1);

    // Bar 1: deep drop to 96 (mtm = 1.0 * (1 - 0.04*2*0.4) = 0.968 → -3.2% intraday).
    feed.get_mut("BTCUSDT").unwrap().push(Candle::new(
        start + HOUR,
        97.0,
        97.5,
        95.5,
        96.0,
        0.0,
    ));
    let r1 = step_bar(
        &mut state,
        &BarInput {
            candles_by_source: &feed,
            atr_series_by_source: &atr,
            signals: vec![],
        },
        &cfg,
    );
    assert!(
        r1.notes.iter().any(|n| n.contains("dailyEquityGuardian")),
        "guardian must fire — notes: {:?}", r1.notes
    );
    assert!(state.open_positions.is_empty());
    assert!(state.equity < 1.0);
    assert_eq!(state.closed_trades.len(), 1);
}

#[test]
fn v5r_reentry_after_stop_with_mean_rev_size_mult() {
    let mut cfg = ftmo_engine_core::v5r::v5r_baseline_template();
    cfg.profit_target = 0.10;
    cfg.max_total_loss = 0.20;
    cfg.max_daily_loss = 0.10;
    cfg.min_trading_days = 1;
    cfg.max_days = 5;
    cfg.daily_equity_guardian = None; // disable guardian for this test
    cfg.loss_streak_cooldown = Some(ftmo_engine_core::config::LossStreakCooldown {
        after_losses: 1,
        cooldown_bars: 100,
    });
    cfg.reentry_after_stop = Some(ftmo_engine_core::config::ReentryAfterStop {
        size_mult: 0.5,
        within_bars: 5,
    });

    let start = 1_700_000_000_000i64;
    let mut state = EngineState::initial(&cfg.label);
    state.challenge_start_ts = start;
    state.last_bar_open_time = start - 1;

    // Open a long that hits stop on bar 0.
    state.open_positions.push(OpenPosition {
        ticket_id: "rt-1".into(),
        symbol: "BTC-TREND".into(),
        source_symbol: "BTCUSDT".into(),
        direction: PositionSide::Long,
        entry_time: start,
        entry_price: 100.0,
        initial_stop_pct: 0.02,
        stop_price: 99.0,
        tp_price: 104.0,
        eff_risk: 0.4,
        entry_bar_idx: 0,
        high_watermark: 100.0,
        be_active: false,
        ptp_triggered: false,
        ptp_realized_pct: 0.0,
        ptp_level_idx: 0,
        ptp_levels_realized: 0.0,
        last_known_price: None,
    });

    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![]);
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

    feed.get_mut("BTCUSDT").unwrap().push(Candle::new(start, 99.5, 99.9, 98.0, 98.5, 0.0));
    let _ = step_bar(
        &mut state,
        &BarInput {
            candles_by_source: &feed,
            atr_series_by_source: &atr,
            signals: vec![],
        },
        &cfg,
    );
    assert_eq!(state.closed_trades.len(), 1);
    assert!(!state.pending_reentries.is_empty());

    // Bar 1: re-entry signal arrives despite cooldown — reentry slot bypasses.
    feed.get_mut("BTCUSDT").unwrap().push(Candle::new(start + HOUR, 99.0, 100.0, 98.0, 99.5, 0.0));
    let sig = PollSignal {
        symbol: "BTC-TREND".into(),
        source_symbol: "BTCUSDT".into(),
        direction: PositionSide::Long,
        entry_time: start + HOUR,
        entry_price: 99.5,
        stop_price: 97.5,
        tp_price: 103.5,
        stop_pct: 0.02,
        tp_pct: 0.04,
        eff_risk: 0.4,
        chandelier_atr_at_entry: None,
    };
    let _ = step_bar(
        &mut state,
        &BarInput {
            candles_by_source: &feed,
            atr_series_by_source: &atr,
            signals: vec![sig],
        },
        &cfg,
    );
    assert_eq!(state.open_positions.len(), 1);
    // sizeMult = 0.5 → eff_risk halved to 0.2.
    assert!((state.open_positions[0].eff_risk - 0.2).abs() < 1e-9);
    assert!(state.pending_reentries.is_empty(), "slot consumed");
}
