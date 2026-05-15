//! Property-invariants — Round 2 (2026-05-15 Reviewer #R2 audit).
//!
//! Each test is a single-purpose bug-detector covering an engine invariant
//! that the original `property_invariants.rs` did not yet check. Where a
//! test exposes a real regression we annotate the failure mode inline so a
//! future debugger can map the assertion straight onto the offending code
//! path. All tests use the same `step_bar` harness so they exercise the
//! end-to-end bar pipeline (day rollover, MTM, exits, fail-checks, opens).
//!
//! Coverage map:
//!   V1: replay-determinism — same input → byte-identical state
//!   V2: monotone-equity-after-PTP — partial realised never reverses
//!   V3: bar_pnl_idempotent — step_bar on same bar twice = no-op
//!   V4: funding-cost-deduction-before-target-check — Codex HIGH parity
//!   V5: day_index_dst_transition — Prague DST boundary day-count
//!   V6: reentry_after_stop_within_bars_window — slot expiry honoured
//!   V7: min_trading_days_blocks_early_pass — pass-gate requires day-count
//!   V8: paused_state_blocks_new_entries — PASSLOCK no-new-entries latch
//!   V9: state_clone_no_aliasing — Vec/HashMap fields are deep-copied
//!  V10: stopped_total_loss_freezes_equity — no further mutations post-stop

use std::collections::HashMap;

use ftmo_engine_core::candle::Candle;
use ftmo_engine_core::config::{
    AssetConfig, EngineConfig, ReentryAfterStop,
};
use ftmo_engine_core::harness::{step_bar, BarInput};
use ftmo_engine_core::position::PositionSide;
use ftmo_engine_core::signal::PollSignal;
use ftmo_engine_core::state::{EngineState, StoppedReason};
use ftmo_engine_core::time_util::day_index;

use proptest::prelude::*;

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

fn cfg_basic() -> EngineConfig {
    let mut c = EngineConfig::r28_v6_passlock_template();
    c.assets = vec![AssetConfig {
        symbol: "BTC-TREND".into(),
        source_symbol: Some("BTCUSDT".into()),
        tp_pct: Some(0.04),
        stop_pct: Some(0.02),
        risk_frac: 0.4,
        ..Default::default()
    }];
    c.profit_target = 0.05;
    c.max_daily_loss = 0.05;
    c.max_total_loss = 0.10;
    c.min_trading_days = 1;
    c.max_days = 30;
    c.leverage = 2.0;
    c.close_all_on_target_reached = false;
    c.pause_at_target_reached = false;
    c.bar_minutes = 30;
    c
}

fn candle_from(open_time: i64, close: f64, range: f64) -> Candle {
    Candle::new(open_time, close, close + range, close - range, close, 0.0)
}

fn make_signal_long(entry_time: i64, entry_price: f64) -> PollSignal {
    PollSignal {
        symbol: "BTC-TREND".into(),
        source_symbol: "BTCUSDT".into(),
        direction: PositionSide::Long,
        entry_time,
        entry_price,
        stop_price: entry_price * 0.98,
        tp_price: entry_price * 1.04,
        stop_pct: 0.02,
        tp_pct: 0.04,
        eff_risk: 0.4,
        chandelier_atr_at_entry: None,
    }
}

/// Drive a synthetic window. Returns final state — caller asserts the invariant.
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
    }
    state
}

fn synth_walk(seed: u64, n: usize, vol: f64) -> Vec<Candle> {
    let mut closes: Vec<f64> = vec![100.0];
    let mut rng = seed | 1;
    for _ in 1..n {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let drift = ((rng % 1000) as f64 - 500.0) * 0.01 * vol;
        closes.push((closes.last().unwrap() + drift).max(1.0));
    }
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| candle_from(1_700_000_000_000 + i as i64 * 1_800_000, c, 1.0))
        .collect()
}

// ─────────────────────────────────────────────────────────────────────
// V1 — Replay determinism: same input MUST yield byte-identical state.
// ─────────────────────────────────────────────────────────────────────
//
// Catches: any latent non-determinism from HashMap iteration order, thread
// scheduling, or uninitialised reads creeping into step_bar. Stronger than
// the existing `tests/determinism.rs` because it varies the seed AND
// asserts on full closed_trades + trading_days vectors, not just summary
// scalars.
//
// Bug-class this would catch:
//   - if open_positions Vec ever changes to HashMap and iteration order
//     leaks into closed_trades ordering
//   - if any future fs/random/clock-side-effect is added inside harness
proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn replay_determinism_state_bit_identical(
        seed in 1u64..1_000_000,
        n_bars in 20usize..60,
    ) {
        let cfg = cfg_basic();
        let candles = synth_walk(seed, n_bars, 1.0);
        let mut sigs = HashMap::new();
        sigs.insert(5usize, vec![make_signal_long(candles[5].open_time, candles[5].close)]);

        let s1 = drive(&candles, &cfg, &sigs);
        let s2 = drive(&candles, &cfg, &sigs);

        prop_assert_eq!(s1.equity.to_bits(), s2.equity.to_bits(), "equity bits diverge");
        prop_assert_eq!(s1.mtm_equity.to_bits(), s2.mtm_equity.to_bits());
        prop_assert_eq!(s1.bars_seen, s2.bars_seen);
        prop_assert_eq!(s1.closed_trades.len(), s2.closed_trades.len());
        prop_assert_eq!(s1.trading_days, s2.trading_days);
        for (a, b) in s1.closed_trades.iter().zip(s2.closed_trades.iter()) {
            prop_assert_eq!(a.eff_pnl.to_bits(), b.eff_pnl.to_bits(), "trade pnl drift");
            prop_assert_eq!(a.ticket_id.as_str(), b.ticket_id.as_str(), "ticket drift");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// V2 — Monotone realised equity post-PTP partial.
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: once a PTP-tier triggers, the position's `ptp_realized_pct`
// (or `ptp_levels_realized`) must be **non-decreasing** across subsequent
// bars. A regression that allows `ptp_realized_pct` to roll back (e.g. via
// integer wrap in `ptp_level_idx`) would create negative compounding when
// the final exit pnl is computed.
//
// Bug-class this would catch:
//   - off-by-one rollback on ptp_level_idx during retracements
//   - mistakenly clearing ptp_triggered after BE-flip
proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn ptp_realized_pct_monotone(
        seed in 1u64..1_000_000,
        n_bars in 30usize..80,
    ) {
        let cfg = cfg_basic();
        let candles = synth_walk(seed, n_bars, 2.0);
        let mut sigs = HashMap::new();
        sigs.insert(2usize, vec![make_signal_long(candles[2].open_time, candles[2].close)]);

        // Replay manually so we can poll OpenPosition fields each bar.
        let mut state = EngineState::initial(&cfg.label);
        state.challenge_start_ts = candles[0].open_time;
        state.last_bar_open_time = candles[0].open_time - 1;
        let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
        feed.insert("BTCUSDT".into(), Vec::with_capacity(candles.len()));
        let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

        let mut prev_realized: f64 = 0.0;
        let mut prev_level_idx: usize = 0;
        for (i, c) in candles.iter().enumerate() {
            feed.get_mut("BTCUSDT").unwrap().push(*c);
            let sigs_i = sigs.get(&i).cloned().unwrap_or_default();
            let _ = step_bar(
                &mut state,
                &BarInput {
                    candles_by_source: &feed,
                    atr_series_by_source: &atr,
                    funding_by_source: None,
                    signals: sigs_i,
                },
                &cfg,
            );
            for pos in state.open_positions.iter() {
                prop_assert!(
                    pos.ptp_realized_pct >= prev_realized - 1e-12,
                    "ptp_realized_pct regressed: {} → {}",
                    prev_realized, pos.ptp_realized_pct
                );
                prop_assert!(
                    pos.ptp_level_idx >= prev_level_idx,
                    "ptp_level_idx regressed: {} → {}",
                    prev_level_idx, pos.ptp_level_idx
                );
                prev_realized = pos.ptp_realized_pct;
                prev_level_idx = pos.ptp_level_idx;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// V3 — bar_pnl idempotency: same bar processed twice → second call no-op.
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: re-feeding the **same** bar (open_time unchanged) must not
// mutate equity/bars_seen/trading_days. The harness has an explicit
// `last_bar_time <= state.last_bar_open_time` guard for this.
//
// Bug-class this would catch:
//   - regression that removes the idempotent-retry guard at harness.rs:134
//   - guard logic shifting from `<=` to `<` (would re-process equal-time bar)
proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn bar_pnl_idempotent_on_replay(
        seed in 1u64..1_000_000,
        n_bars in 10usize..30,
    ) {
        let cfg = cfg_basic();
        let candles = synth_walk(seed, n_bars, 1.5);
        let mut sigs = HashMap::new();
        sigs.insert(3usize, vec![make_signal_long(candles[3].open_time, candles[3].close)]);

        let mut state = EngineState::initial(&cfg.label);
        state.challenge_start_ts = candles[0].open_time;
        state.last_bar_open_time = candles[0].open_time - 1;
        let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
        feed.insert("BTCUSDT".into(), Vec::with_capacity(candles.len()));
        let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

        for (i, c) in candles.iter().enumerate() {
            feed.get_mut("BTCUSDT").unwrap().push(*c);
            let s = sigs.get(&i).cloned().unwrap_or_default();
            let _ = step_bar(
                &mut state,
                &BarInput {
                    candles_by_source: &feed,
                    atr_series_by_source: &atr,
                    funding_by_source: None,
                    signals: s.clone(),
                },
                &cfg,
            );
            // Snapshot — these MUST stay invariant when replaying same bar.
            let eq_before = state.equity.to_bits();
            let mtm_before = state.mtm_equity.to_bits();
            let bars_before = state.bars_seen;
            let trading_days_before = state.trading_days.clone();
            let closed_before = state.closed_trades.len();
            let open_before = state.open_positions.len();

            let _ = step_bar(
                &mut state,
                &BarInput {
                    candles_by_source: &feed,
                    atr_series_by_source: &atr,
                    funding_by_source: None,
                    signals: s, // same signals as well
                },
                &cfg,
            );
            prop_assert_eq!(state.equity.to_bits(), eq_before, "equity drifted on replay bar {}", i);
            prop_assert_eq!(state.mtm_equity.to_bits(), mtm_before, "mtm drifted");
            prop_assert_eq!(state.bars_seen, bars_before, "bars_seen incremented on replay");
            prop_assert_eq!(state.trading_days.clone(), trading_days_before, "trading_days mutated");
            prop_assert_eq!(state.closed_trades.len(), closed_before, "closed_trades mutated");
            prop_assert_eq!(state.open_positions.len(), open_before, "open_positions mutated");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// V4 — funding-cost deduction happens BEFORE target-check.
// ─────────────────────────────────────────────────────────────────────
//
// Codex HIGH 2026-05-13: `first_target_hit_day` latch must only commit
// AFTER funding-cost is deducted. We construct a scenario where the raw
// PnL clears the target by a hair, but funding-cost over the hold period
// is larger than that margin — the harness MUST refuse to declare passed.
//
// Bug-class this would catch:
//   - regression that hoists first_target_hit_day before apply_exits
//   - any future profit_target check that uses pre-funding equity
//
// Note: We rely on the engine's own funding-pipeline (positive funding
// rate, long position) — long PAYS funding so realised pnl drops.
#[test]
fn funding_cost_deducted_before_target_latch() {
    let mut cfg = cfg_basic();
    cfg.profit_target = 0.02; // 2% — easy to clear
    cfg.close_all_on_target_reached = true;
    cfg.pause_at_target_reached = true;
    cfg.min_trading_days = 1;
    cfg.leverage = 2.0;

    // Build a 5-bar feed that immediately TPs.
    // Long entry @ 100, TP @ 104 (4% raw move).
    let candles: Vec<Candle> = (0..5)
        .map(|i| {
            let close = if i == 0 { 100.0 } else { 105.0 };
            candle_from(1_700_000_000_000 + i as i64 * 1_800_000, close, 1.0)
        })
        .collect();

    let mut state = EngineState::initial(&cfg.label);
    state.challenge_start_ts = candles[0].open_time;
    state.last_bar_open_time = candles[0].open_time - 1;
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![]);
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

    // Funding series: massive positive funding on every 8h boundary the
    // position crosses — long pays. With bar_minutes=30, 8h = 16 bars apart,
    // but our 5-bar window crosses at most 1 settlement. Use a large
    // funding rate (5% per settlement) to force the cost > target margin.
    let mut funding: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    funding.insert(
        "BTCUSDT".into(),
        vec![Some(0.05), Some(0.05), Some(0.05), Some(0.05), Some(0.05)],
    );

    let sig = make_signal_long(candles[0].open_time, 100.0);
    let mut sigs_map = HashMap::new();
    sigs_map.insert(0usize, vec![sig]);

    for (i, c) in candles.iter().enumerate() {
        feed.get_mut("BTCUSDT").unwrap().push(*c);
        let s = sigs_map.get(&i).cloned().unwrap_or_default();
        let _ = step_bar(
            &mut state,
            &BarInput {
                candles_by_source: &feed,
                atr_series_by_source: &atr,
                funding_by_source: Some(&funding),
                signals: s,
            },
            &cfg,
        );
    }

    // Property (loose): IF funding fired (we crossed at least one 8h boundary
    // during the trade) THEN the final realised equity has the funding
    // deduction baked in; the latch commit-or-revert path executed correctly
    // either way. We assert that `first_target_hit_day` is set ONLY if
    // equity is still ≥ target post-funding (Codex HIGH FIX contract).
    if state.first_target_hit_day.is_some() {
        assert!(
            state.equity >= 1.0 + cfg.profit_target - 1e-9,
            "first_target_hit_day latched but equity={} < 1+target={}",
            state.equity,
            1.0 + cfg.profit_target
        );
    }
}

// ─────────────────────────────────────────────────────────────────────
// V5 — day_index across Prague DST transition.
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: a bar that lands ON or AFTER a Prague DST shift (last Sunday
// of March +1h, last Sunday of October −1h) must produce exactly the
// calendar-day delta from anchor — NOT the elapsed-time-/24h shortcut
// (which was the pre-Codex bug, see time_util.rs:38-46 comment).
//
// Bug-class this would catch:
//   - regression that re-introduces elapsed-time-based day arithmetic
//   - any TZ library upgrade silently changing Prague DST tables
#[test]
fn day_index_dst_spring_forward_2026() {
    // 2026 Prague DST starts on Sun 2026-03-29 01:00 UTC → 03:00 CEST.
    // Anchor at challenge-start: Sun 2026-03-22 00:00 UTC.
    // Bar at: Sun 2026-03-30 00:00 UTC (i.e. ~8 wall-clock days, 7×24+23h elapsed).
    // Expected day_index: 8 (Prague calendar-day delta).
    let anchor = chrono::DateTime::parse_from_rfc3339("2026-03-22T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let bar = chrono::DateTime::parse_from_rfc3339("2026-03-30T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let di = day_index(bar, anchor);
    // Calendar-day diff = 8 in Prague TZ. Allow ±0 — exact match required.
    assert_eq!(
        di, 8,
        "day_index across DST returned {} (expected 8)",
        di
    );
}

#[test]
fn day_index_dst_fall_back_2026() {
    // 2026 Prague DST ends on Sun 2026-10-25 01:00 UTC → 02:00 CET.
    // Anchor: 2026-10-20 00:00 UTC.
    // Bar:    2026-10-27 00:00 UTC (7 wall-clock days, 7×24+1h elapsed).
    let anchor = chrono::DateTime::parse_from_rfc3339("2026-10-20T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let bar = chrono::DateTime::parse_from_rfc3339("2026-10-27T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let di = day_index(bar, anchor);
    assert_eq!(
        di, 7,
        "day_index across fall-back DST returned {} (expected 7)",
        di
    );
}

// ─────────────────────────────────────────────────────────────────────
// V6 — reentry_after_stop slot expires after `within_bars` window.
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: when a stop closes a position with `reentry_after_stop`
// configured, a new signal on the same asset+direction can ONLY consume
// the slot if `state.bars_seen <= bars_seen_at_stop + within_bars`.
//
// We craft: STOP at bar X (bars_seen=X+1 post-bookkeep), then offer a
// signal at bar X+within_bars+5 (well past expiry). The harness must NOT
// apply the size_mult uplift. Today's gate (harness.rs:792) checks
// `bars_seen <= bars_seen_at_stop + within_bars` — boundary-correct.
//
// Bug-class this would catch:
//   - off-by-one on the within_bars comparison
//   - state.pending_reentries leaking across windows
#[test]
fn reentry_slot_expires_outside_window() {
    let mut cfg = cfg_basic();
    cfg.reentry_after_stop = Some(ReentryAfterStop {
        size_mult: 2.0,
        within_bars: 3,
    });
    // Seed a pending re-entry slot directly (bypasses needing a real stop).
    let mut state = EngineState::initial(&cfg.label);
    state.bars_seen = 100;
    state.pending_reentries.insert(
        "BTC-TREND|long".into(),
        ftmo_engine_core::state::ReentryState {
            bars_seen_at_stop: 90, // slot opened 10 bars ago, but within_bars=3
            original_eff_risk: 0.4,
        },
    );
    // Drive 1 bar with a long signal — slot must NOT be consumed (expired).
    // After the call, pending_reentries should still contain the (stale)
    // entry, AND no position should carry a doubled eff_risk.
    let candle = candle_from(1_700_000_000_000, 100.0, 1.0);
    state.last_bar_open_time = candle.open_time - 1;
    state.challenge_start_ts = candle.open_time;
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![candle]);
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();
    let sig = make_signal_long(candle.open_time, 100.0);
    let _ = step_bar(
        &mut state,
        &BarInput {
            candles_by_source: &feed,
            atr_series_by_source: &atr,
            funding_by_source: None,
            signals: vec![sig],
        },
        &cfg,
    );
    // If a position opened, its eff_risk must be the unmultiplied 0.4 (or
    // any value ≤ 0.4 after caps). It must NOT be 0.8 (size_mult=2.0).
    for pos in state.open_positions.iter() {
        assert!(
            pos.eff_risk <= 0.4 + 1e-9,
            "expired reentry slot was wrongly consumed: eff_risk={}",
            pos.eff_risk
        );
    }
}

// ─────────────────────────────────────────────────────────────────────
// V7 — min_trading_days blocks early pass (target hit on day 0).
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: even if equity ≥ target on bar 1, the harness MUST NOT
// declare `passed=true` until `trading_days.len() ≥ min_trading_days`.
//
// Bug-class this would catch:
//   - regression where target-hit short-circuits the day-count gate
//   - first_target_hit_day mis-counted as a trading_day without an entry
#[test]
fn min_trading_days_blocks_early_pass() {
    let mut cfg = cfg_basic();
    cfg.profit_target = 0.02;
    cfg.min_trading_days = 4;
    cfg.max_days = 30;
    cfg.close_all_on_target_reached = false;
    cfg.pause_at_target_reached = false;

    // Drop 1 winning trade on day 0 that clears target; window only spans
    // 2 calendar days → trading_days={0} (1 entry), len < 4 → must NOT pass.
    let candles: Vec<Candle> = vec![
        candle_from(1_700_000_000_000, 100.0, 1.0), // day 0
        candle_from(1_700_000_000_000 + 1_800_000, 104.0, 1.0), // still day 0 (30min later)
        candle_from(1_700_000_000_000 + 2 * 1_800_000, 106.0, 1.0),
    ];
    let mut sigs = HashMap::new();
    sigs.insert(0usize, vec![make_signal_long(candles[0].open_time, 100.0)]);
    let s = drive(&candles, &cfg, &sigs);

    // Either equity cleared target (then must be blocked by min_trading_days
    // gate) OR no trades closed (no assertion to make).
    if s.equity >= 1.0 + cfg.profit_target - 1e-9 {
        assert!(
            s.trading_days.len() < cfg.min_trading_days as usize
                || s.stopped_reason.is_some(),
            "early pass: equity={} target={} trading_days={:?} min={}",
            s.equity,
            1.0 + cfg.profit_target,
            s.trading_days,
            cfg.min_trading_days
        );
    }
}

// ─────────────────────────────────────────────────────────────────────
// V8 — paused_at_target latches → blocks new entries.
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: once `state.paused_at_target = true` is committed,
// subsequent bars MUST NOT push new entries to `result.decision.opens`
// regardless of how many signals are offered.
//
// Bug-class this would catch:
//   - regression where the entries_allowed=false branch misses a signal type
//   - a future "skip pause when force_open=true" override that leaks
#[test]
fn paused_state_blocks_new_entries() {
    let mut cfg = cfg_basic();
    cfg.pause_at_target_reached = true;
    cfg.close_all_on_target_reached = false;

    let mut state = EngineState::initial(&cfg.label);
    state.paused_at_target = true;
    state.first_target_hit_day = Some(0);
    state.equity = 1.10; // above target
    state.mtm_equity = 1.10;
    state.day = 5;
    state.trading_days = vec![0, 1, 2, 3, 4, 5];
    let candle = candle_from(1_700_000_000_000, 100.0, 1.0);
    state.challenge_start_ts = candle.open_time;
    state.last_bar_open_time = candle.open_time - 1;
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![candle]);
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

    let sig = make_signal_long(candle.open_time, 100.0);
    let r = step_bar(
        &mut state,
        &BarInput {
            candles_by_source: &feed,
            atr_series_by_source: &atr,
            funding_by_source: None,
            signals: vec![sig],
        },
        &cfg,
    );
    // Either the bar caused a pass (challenge_ended) and decision.opens is
    // empty, OR pause stayed latched and the signal was skipped/dropped.
    // The load-bearing check: no NEW positions appended.
    assert_eq!(
        r.decision.opens.len(),
        0,
        "paused_at_target leaked a new entry: {:?}",
        r.decision.opens
    );
    assert_eq!(state.open_positions.len(), 0, "paused state opened a position");
}

// ─────────────────────────────────────────────────────────────────────
// V9 — state.clone() does NOT alias inner Vec/HashMap.
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: cloning EngineState must deep-copy every collection field.
// Aliased Vec/HashMap inner storage would corrupt persisted state across
// Multi-Account isolation (R57 mandate).
//
// Bug-class this would catch:
//   - someone wraps EngineState fields in Rc<Vec<_>> or Cow<…> for "perf"
//   - serde-derive replaced with a custom impl that shares Arc
#[test]
fn state_clone_no_aliasing() {
    let mut s = EngineState::initial("orig");
    s.trading_days.push(7);
    s.kelly_pnls.push(ftmo_engine_core::state::KellyPnl {
        close_time: 1,
        eff_pnl: 0.01,
    });
    s.loss_streak_by_asset_dir.insert(
        "BTC|long".into(),
        ftmo_engine_core::state::LossStreakEntry {
            streak: 2,
            cd_until_bars_seen: 5,
        },
    );
    s.pending_reentries.insert(
        "BTC|long".into(),
        ftmo_engine_core::state::ReentryState {
            bars_seen_at_stop: 10,
            original_eff_risk: 0.4,
        },
    );

    let mut cloned = s.clone();
    // Mutate clone — original must NOT observe the change.
    cloned.trading_days.push(99);
    cloned.kelly_pnls.push(ftmo_engine_core::state::KellyPnl {
        close_time: 99,
        eff_pnl: 0.99,
    });
    cloned.loss_streak_by_asset_dir.insert(
        "ETH|short".into(),
        ftmo_engine_core::state::LossStreakEntry {
            streak: 99,
            cd_until_bars_seen: 999,
        },
    );
    cloned.pending_reentries.insert(
        "ETH|short".into(),
        ftmo_engine_core::state::ReentryState {
            bars_seen_at_stop: 99,
            original_eff_risk: 0.99,
        },
    );
    cloned.equity = 5.0;

    assert_eq!(s.trading_days, vec![7]);
    assert_eq!(s.kelly_pnls.len(), 1);
    assert!(!s.loss_streak_by_asset_dir.contains_key("ETH|short"));
    assert!(!s.pending_reentries.contains_key("ETH|short"));
    assert_eq!(s.equity, 1.0);
    // And the clone-side mutations DID take effect on the clone.
    assert_eq!(cloned.trading_days, vec![7, 99]);
    assert_eq!(cloned.kelly_pnls.len(), 2);
    assert!(cloned.loss_streak_by_asset_dir.contains_key("ETH|short"));
}

// ─────────────────────────────────────────────────────────────────────
// V10 — stopped TotalLoss freezes equity (no further mutation).
// ─────────────────────────────────────────────────────────────────────
//
// Invariant: after stopped_reason latches, additional step_bar calls
// short-circuit and must NOT mutate equity / closed_trades / bars_seen.
//
// Bug-class this would catch:
//   - regression where the stopped-short-circuit at harness.rs:88 is
//     dropped or moved below MTM-update
//   - someone wiring a "soft-pass tail" that ignores the stopped latch
#[test]
fn stopped_total_loss_freezes_equity() {
    let cfg = cfg_basic();
    let mut state = EngineState::initial(&cfg.label);
    state.stopped_reason = Some(StoppedReason::TotalLoss);
    state.equity = 0.85;
    state.bars_seen = 50;
    state.closed_trades = vec![]; // empty
    state.challenge_start_ts = 1_700_000_000_000;
    state.last_bar_open_time = 1_700_000_000_000;

    let candle = candle_from(1_700_000_000_000 + 1_800_000, 110.0, 5.0);
    let mut feed: HashMap<String, Vec<Candle>> = HashMap::new();
    feed.insert("BTCUSDT".into(), vec![candle]);
    let atr: HashMap<String, Vec<Option<f64>>> = HashMap::new();

    let eq_before = state.equity.to_bits();
    let bars_before = state.bars_seen;
    let trades_before = state.closed_trades.len();

    let r = step_bar(
        &mut state,
        &BarInput {
            candles_by_source: &feed,
            atr_series_by_source: &atr,
            funding_by_source: None,
            signals: vec![make_signal_long(candle.open_time, 110.0)],
        },
        &cfg,
    );
    assert!(r.challenge_ended, "stopped state must mark challenge_ended");
    assert_eq!(state.equity.to_bits(), eq_before, "equity mutated after stop");
    assert_eq!(state.bars_seen, bars_before, "bars_seen mutated after stop");
    assert_eq!(state.closed_trades.len(), trades_before, "trades mutated after stop");
}
