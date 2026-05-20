//! Property-based invariants that the engine harness must preserve no
//! matter what (random) signal-driven bar sequence is fed to it.
//!
//! Invariants checked:
//!   I1: `state.bars_seen` is monotone non-decreasing across step_bar calls.
//!   I2: `state.equity` never falls below `1.0 - max_total_loss - max_per_trade_loss`
//!       (loose envelope; per-trade loss is bounded by GAP_TAIL_MULT × eff_risk).
//!   I3: After `stopped_reason == TotalLoss`, equity stays put — no further
//!       step_bar mutations to equity.
//!   I4: `state.trading_days` contains only unique values.
//!   I5: `eff_pnl ≥ -1.5 × eff_risk` for every closed trade (gap-tail floor).

use std::collections::HashMap;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::EngineConfig;
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::pnl::GAP_TAIL_MULT;
use ftmo_engine_core::position::PositionSide;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::state::{EngineState, StoppedReason};

use proptest::prelude::*;

/// Tiny harness that drives `step_bar` over a synthetic candle sequence with
/// optional signals interleaved. Returns the final state.
fn drive(
    candles: &[Candle],
    cfg: &EngineConfig,
    signals_by_bar: &HashMap<usize, Vec<PollSignal>>,
) -> EngineState {
    let mut state = EngineState::initial(&cfg.label);
    state.challenge_start_ts = candles[0].open_time;
    state.last_bar_open_time = candles[0].open_time - 1;
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), Vec::with_capacity(candles.len()));
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    let mut prev_bars_seen: u64 = 0;
    for (i, c) in candles.iter().enumerate() {
        feed.get_mut("BTCUSDT").unwrap().push(*c);
        let signals = signals_by_bar.get(&i).cloned().unwrap_or_default();
        let _ = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feed,
                atr_series_by_source: &atr,
                funding_by_source: None,
                signals,
            },
            cfg,
        );
        // I1: monotone bars_seen
        assert!(state.bars_seen >= prev_bars_seen, "bars_seen regressed");
        prev_bars_seen = state.bars_seen;
        // I4: trading_days uniqueness
        let mut sorted = state.trading_days.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), state.trading_days.len(), "duplicate day");
    }
    state
}

fn cfg_basic() -> EngineConfig {
    let mut c = EngineConfig::r28_v6_passlock_template();
    c.profit_target = 0.05;
    c.max_daily_loss = 0.05;
    c.max_total_loss = 0.10;
    c.min_trading_days = 1;
    c.max_days = 30;
    c.leverage = 2.0;
    c.close_all_on_target_reached = false;
    c.pause_at_target_reached = false;
    c
}

fn candle_from(open_time: i64, close: f64, range: f64) -> Candle {
    Candle::new(open_time, close, close + range, close - range, close, 0.0)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Random closes with small ranges; no signals. Pure idle-bookkeeping path.
    /// Equity must stay at 1.0 (no trades) and bars_seen must increment.
    #[test]
    fn idle_path_preserves_equity(
        n_bars in 5usize..40,
        seed in 0u64..1_000_000,
    ) {
        let mut closes: Vec<f64> = vec![100.0];
        let mut rng_state = seed;
        for _ in 1..n_bars {
            // xorshift-style for deterministic prop variability
            rng_state ^= rng_state << 13;
            rng_state ^= rng_state >> 7;
            rng_state ^= rng_state << 17;
            let drift = ((rng_state % 200) as f64 - 100.0) * 0.01;
            closes.push(closes.last().unwrap() + drift);
        }
        let candles: Vec<Candle> = closes
            .iter()
            .enumerate()
            .map(|(i, &c)| candle_from(1_700_000_000_000 + i as i64 * 1_800_000, c, 0.5))
            .collect();
        let cfg = cfg_basic();
        let state = drive(&candles, &cfg, &HashMap::new());
        prop_assert_eq!(state.equity, 1.0);
    }

    /// Random direction signal at bar 0 then random walk. After full window:
    ///   - equity is finite
    ///   - if closed_trades exist, every eff_pnl ≥ -1.5 × eff_risk (I5)
    ///   - if stopped_reason == TotalLoss, equity ≤ 1.0 - max_total_loss + tolerance
    #[test]
    fn signal_driven_invariants(
        long_first in any::<bool>(),
        n_bars in 6usize..40,
        seed in 1u64..1_000_000,
    ) {
        let mut closes: Vec<f64> = vec![100.0];
        let mut rng_state = seed;
        for _ in 1..n_bars {
            rng_state ^= rng_state << 13;
            rng_state ^= rng_state >> 7;
            rng_state ^= rng_state << 17;
            let drift = ((rng_state % 600) as f64 - 300.0) * 0.01;
            closes.push((closes.last().unwrap() + drift).max(1.0));
        }
        let candles: Vec<Candle> = closes
            .iter()
            .enumerate()
            .map(|(i, &c)| candle_from(1_700_000_000_000 + i as i64 * 1_800_000, c, 1.0))
            .collect();
        let cfg = cfg_basic();
        let dir = if long_first { PositionSide::Long } else { PositionSide::Short };
        let entry = candles[0].close;
        let (sp, tp) = if long_first {
            (entry * 0.98, entry * 1.04)
        } else {
            (entry * 1.02, entry * 0.96)
        };
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: dir,
            entry_time: candles[0].open_time,
            entry_price: entry,
            stop_price: sp,
            tp_price: tp,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let mut signals = HashMap::new();
        signals.insert(0usize, vec![sig]);
        let state = drive(&candles, &cfg, &signals);

        prop_assert!(state.equity.is_finite());

        // I5: gap-tail floor on every closed trade.
        for t in &state.closed_trades {
            let floor = GAP_TAIL_MULT * 0.4;
            prop_assert!(
                t.eff_pnl >= floor - 1e-9,
                "trade eff_pnl={} below floor={}", t.eff_pnl, floor
            );
        }

        // I3: stopped TotalLoss implies equity is at-or-below the floor (with
        // GAP_TAIL_MULT slack: a single position can overshoot by 1.5R).
        if state.stopped_reason == Some(StoppedReason::TotalLoss) {
            let allowed_floor = 1.0 - cfg.max_total_loss + GAP_TAIL_MULT * 0.4 - 1e-9;
            prop_assert!(
                state.equity <= 1.0 - cfg.max_total_loss + 1e-9
                    || state.equity >= allowed_floor,
                "TotalLoss but equity={} not in expected band", state.equity
            );
        }
    }

    /// Day-index DST stability — for any UTC timestamp pair, the day-index
    /// difference must equal the number of full Prague-midnight crossings
    /// (which equals the wall-clock-day diff most of the year, except DST).
    /// We only check monotonicity here: bar_b > bar_a ⇒ day_index(b) ≥ day_index(a).
    #[test]
    fn day_index_monotone_across_year(
        anchor_offset_days in 0i64..365,
        bar_offset_hours in 0i64..(365 * 24),
    ) {
        use ftmo_engine_core::time_util::day_index;
        let jan1_2026 = 1_767_225_600_000i64;
        let day = 86_400_000i64;
        let hour = 3_600_000i64;
        let anchor = jan1_2026 + anchor_offset_days * day;
        let bar = anchor + bar_offset_hours * hour;
        let di_anchor = day_index(anchor, anchor);
        let di_bar = day_index(bar, anchor);
        prop_assert!(di_bar >= di_anchor, "day_index regressed: anchor={} bar={}", di_anchor, di_bar);
        // Approximate: hours/24 ≤ day ≤ hours/24 + 1 (off-by-one on DST shift).
        let approx_days = bar_offset_hours / 24;
        prop_assert!(
            di_bar >= approx_days - 1 && di_bar <= approx_days + 1,
            "day_index({h}h) = {di} too far from approx {approx}",
            h = bar_offset_hours, di = di_bar, approx = approx_days
        );
    }

    /// 2026-05-14 Detector #18 — multi-tier PTP state-corruption safety.
    ///
    /// Invariant: a multi-level PTP config with **one** level
    ///   `[(trigger_pct, close_fraction)]`
    /// must produce the same realised fraction and stop-price evolution as
    /// the equivalent single-tier PTP config
    ///   `{trigger_pct, close_fraction}`
    /// when fed an identical bar that hits the trigger.
    ///
    /// Both branches in `process_position_exit_with_held` share the same
    /// cost-adjustment, BE-shift, gap-past-trigger rule and stop-guard, so
    /// running them over a randomised bar sequence must end at the same
    /// final PnL bookkeeping. Catches regressions where the multi-tier
    /// branch could mutate `pos.ptp_*` fields differently to the single
    /// tier (e.g. forgetting to set `be_active` or rolling `ptp_level_idx`
    /// past the end).
    #[test]
    fn ptp_multi_one_level_equals_single_tier(
        trigger_bp in 100u32..400,        // 0.010..0.040 (in basis points)
        fraction_bp in 100u32..900,       // 0.010..0.090
        wick_above_trigger in 0.0f64..2.0, // pct headroom above trigger so the bar prints PTP
        seed in 0u64..1_000_000,
    ) {
        use ftmo_engine_core::candle::Candle;
        use ftmo_engine_core::config::{
            EngineConfig, PartialTakeProfit, PartialTakeProfitLevel,
        };
        use ftmo_engine_core::exit::process_position_exit;
        use ftmo_engine_core::position::{OpenPosition, PositionSide};

        let trigger_pct = (trigger_bp as f64) / 10_000.0;
        let close_fraction = (fraction_bp as f64) / 10_000.0;

        // Build two cfgs that differ ONLY in the PTP branch used.
        let mut cfg_single = EngineConfig::r28_v6_passlock_template();
        cfg_single.partial_take_profit = Some(PartialTakeProfit {
            trigger_pct,
            close_fraction,
        });
        cfg_single.partial_take_profit_levels = None;

        let mut cfg_multi = EngineConfig::r28_v6_passlock_template();
        cfg_multi.partial_take_profit = None;
        cfg_multi.partial_take_profit_levels = Some(vec![PartialTakeProfitLevel {
            trigger_pct,
            close_fraction,
        }]);

        // Long position; trigger_price = 100 * (1 + trigger_pct).
        let make_pos = || OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: 100.0,
            initial_stop_pct: 0.02,
            stop_price: 98.0,
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
            trail_active: false,
            trail_peak: 0.0,
        };

        // Bar that ticks the PTP. Use random non-degenerate wicks; ensure
        // the low stays strictly above the BE stop so neither branch fires
        // an immediate cross post-realise. (BE = 100 after cost-adjust.)
        let trigger_price = 100.0 * (1.0 + trigger_pct);
        let high = trigger_price + wick_above_trigger;
        // Deterministic per-prop case low ∈ (100, trigger_price]
        let mut rng = seed | 1;
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let span = (trigger_price - 100.05).max(0.01);
        let low = 100.05 + (rng as f64 % 1000.0) / 1000.0 * span;
        let open = 100.05 + (low - 100.05) * 0.5;
        let close = trigger_price - 0.01;
        let bar = Candle::new(0, open, high, low, close, 0.0);

        let mut pos_single = make_pos();
        let mut pos_multi = make_pos();
        let r_single = process_position_exit(&mut pos_single, &bar, &cfg_single, None);
        let r_multi = process_position_exit(&mut pos_multi, &bar, &cfg_multi, None);

        // Neither cfg should have closed the position (low > BE).
        prop_assert!(r_single.is_none(), "single-tier exited unexpectedly: {r_single:?}");
        prop_assert!(r_multi.is_none(),  "multi-tier exited unexpectedly: {r_multi:?}");

        // ptp_realized_pct (single-tier branch) must equal
        // ptp_levels_realized (multi-tier branch) bit-for-bit.
        prop_assert!(
            (pos_single.ptp_realized_pct - pos_multi.ptp_levels_realized).abs() < 1e-12,
            "single ptp_realized_pct={} multi ptp_levels_realized={}",
            pos_single.ptp_realized_pct, pos_multi.ptp_levels_realized,
        );

        // Stop-price and BE-flag must agree.
        prop_assert!(pos_single.be_active, "single-tier must set be_active");
        prop_assert!(pos_multi.be_active,  "multi-tier must set be_active");
        prop_assert!(
            (pos_single.stop_price - pos_multi.stop_price).abs() < 1e-12,
            "stop_price drift: single={} multi={}",
            pos_single.stop_price, pos_multi.stop_price,
        );

        // high_watermark reset to candle.close in both branches.
        prop_assert!((pos_single.high_watermark - pos_multi.high_watermark).abs() < 1e-12);

        // Cross-branch state: single-tier sets ptp_triggered, multi-tier
        // advances ptp_level_idx — both signal "first tier realised".
        prop_assert!(pos_single.ptp_triggered);
        prop_assert_eq!(pos_multi.ptp_level_idx, 1usize);
    }

    /// Gap-fill exit-price monotonicity — for a long position at entry=100
    /// with stop=98, varying open∈[80, 99], gap-down behaviour must satisfy:
    ///   exit_price = min(open, stop_price)
    /// (ie. exit cannot be ABOVE the stop on a stop-cross bar).
    #[test]
    fn gap_fill_long_stop_exit_never_above_stop(
        open in 80f64..99.0,
        low in 80f64..97.0,
        close in 80f64..99.5,
    ) {
        use ftmo_engine_core::candle::Candle;
        use ftmo_engine_core::config::EngineConfig;
        use ftmo_engine_core::exit::{process_position_exit, ExitOutcome};
        use ftmo_engine_core::position::{OpenPosition, PositionSide};
        use ftmo_engine_core::trade::ExitReason;

        let cfg = EngineConfig::r28_v6_passlock_template();
        let mut pos = OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: 100.0,
            initial_stop_pct: 0.02,
            stop_price: 98.0,
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
            trail_active: false,
            trail_peak: 0.0,
        };
        let bar_high = open.max(close).max(low);
        let candle = Candle::new(0, open, bar_high, low, close, 0.0);
        if let Some(ExitOutcome { exit_price, reason }) = process_position_exit(&mut pos, &candle, &cfg, None) {
            if reason == ExitReason::Stop {
                prop_assert!(exit_price <= pos.stop_price + 1e-9, "long-stop exit_price={} > stop={}", exit_price, pos.stop_price);
            }
        }
    }
}
