//! Engine harness — orchestrates one bar's worth of state transitions:
//! day-rollover, MTM update, exits, target/fail checks, then opens.
//!
//! This is a portable subset of `pollLive()` from `ftmoLiveEngineV4.ts`.
//! Signal generation (`detectAsset`) is NOT in scope; callers supply
//! `PollSignal[]` externally — TS detectAsset emits them, Python executor
//! reads them, and the harness drives the rest.
//!
//! Order of operations (matches V4 + R57/R58 fixes):
//!   1. Stopped-state short-circuit
//!   2. Day-rollover (Prague-aware)
//!   3. Force-close on max_days reached
//!   4. MTM update (mutates last_known_price + day/challenge peaks)
//!   5. Exit-check loop on open positions
//!   6. Target / DL / TL fail-check on REALISED equity
//!   7. Pause-after-target latch
//!   8. R60 close-all-on-target latch
//!   9. Open new positions from supplied signals (max_concurrent_trades cap)
//! 10. Bookkeeping: bars_seen, last_bar_open_time, trim_inline

use std::cell::Cell;
use std::collections::HashMap;

use crate::candle::Candle;
use crate::config::EngineConfig;
use chrono::{DateTime, Datelike, Timelike, Utc};

// 2026-05-24 PERF AUDIT: per-bar `step_bar` ends up pushing 0-N `PollSkip`
// entries into `result.skipped`. Each push allocates TWO Strings (asset
// symbol clone + format!-built reason). Profiling showed ~13 push-sites
// fire millions of times during a full ftmo-sweep run, but sweep.rs NEVER
// reads `result.skipped` in production. That's pure waste.
//
// Thread-local flag with `true` default (live-trading callers / tests need
// the diagnostics). Sweep sets `false` per rayon worker before processing,
// so the harness short-circuits the allocation while live callers stay
// unaffected. Bench measured: meanrev 332µs → ~250µs (-25%) per bar.
thread_local! {
    static COLLECT_SKIP_DIAGNOSTICS: Cell<bool> = const { Cell::new(true) };
}

/// Disable PollSkip allocations for THIS thread (call once per rayon
/// worker / per backtest thread). Returns the prior value so callers
/// can restore it. Live-trading and tests don't call this — they read
/// `result.skipped` for operator diagnostics.
pub fn set_collect_skip_diagnostics(value: bool) -> bool {
    COLLECT_SKIP_DIAGNOSTICS.with(|c| {
        let prev = c.get();
        c.set(value);
        prev
    })
}

#[inline]
fn skip_diagnostics_enabled() -> bool {
    COLLECT_SKIP_DIAGNOSTICS.with(|c| c.get())
}

/// Helper for the 12+ `skipped.push` sites in step_bar. Closures defer
/// both the asset-clone AND the format!-reason String construction until
/// AFTER the gate check, so disabled diagnostics path is just a TLS-read
/// + branch — no heap allocation.
#[inline]
fn push_skip_if<A, R>(skipped: &mut Vec<crate::signal::PollSkip>, asset: A, reason: R)
where
    A: FnOnce() -> String,
    R: FnOnce() -> String,
{
    if skip_diagnostics_enabled() {
        skipped.push(crate::signal::PollSkip {
            asset: asset(),
            reason: reason(),
        });
    }
}

use crate::pnl::{
    compute_eff_pnl_with_time, compute_mtm_equity, compute_stress_mtm_equity, trim_inline,
};
use crate::position::OpenPosition;
use crate::signal::{CloseIntent, PollDecision, PollSignal};
use crate::state::{EngineState, KellyPnl, LossStreakEntry, StoppedReason};
use crate::time_util::{day_index, find_candle_at_or_before, find_candle_at_time, ls_key};
use crate::trade::{ClosedTrade, ExitReason};

/// One bar's worth of inputs.
pub struct BarInput<'a> {
    /// Candles per source-symbol, each ending at the same `open_time`.
    pub candles_by_source: &'a HashMap<String, Vec<Candle>>,
    /// Optional ATR series per source-symbol, aligned with `candles_by_source`.
    pub atr_series_by_source: &'a HashMap<String, Vec<Option<f64>>>,
    /// Pre-computed entry signals for this bar (from external detector).
    pub signals: Vec<PollSignal>,
    /// 2026-05-13 Round-2 Audit Fix — Funding-rate series per source-symbol,
    /// aligned with `candles_by_source`. When supplied, `apply_exits` will
    /// deduct funding-cost from raw_pnl over 8h settlement boundaries
    /// crossed during the trade lifetime (TS V4 parity, ftmoDaytrade24h.ts
    /// L4819-4862). When `None`, funding is treated as zero (legacy path).
    /// CLAUDE.md documented this as "Rust-Gap" — closes that gap.
    pub funding_by_source: Option<&'a HashMap<String, Vec<Option<f64>>>>,
}

/// Result of a single `step_bar` call.
#[derive(Debug, Clone)]
pub struct StepResult {
    pub decision: PollDecision,
    pub notes: Vec<String>,
    pub skipped: Vec<crate::signal::PollSkip>,
    pub challenge_ended: bool,
    pub passed: bool,
    pub fail_reason: Option<FailReason>,
    pub target_hit: bool,
}

/// Live-only failure modes. `Time` and `*Loss` are also persisted into
/// `state.stopped_reason` to make repeated polls idempotent (see Round-62
/// audit fix in TS `pollLive`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailReason {
    TotalLoss,
    DailyLoss,
    Time,
    FeedLost,
}

/// Drive one bar of engine state. Mutates `state` in-place. Returns the
/// decisions taken (closes from exits, opens from signals).
pub fn step_bar(state: &mut EngineState, input: &BarInput<'_>, cfg: &EngineConfig) -> StepResult {
    let mut result = StepResult {
        decision: PollDecision::default(),
        notes: vec![],
        skipped: vec![],
        challenge_ended: false,
        passed: false,
        fail_reason: None,
        target_hit: false,
    };

    // 1. Stopped-state — preserve verbatim.
    if let Some(reason) = state.stopped_reason {
        result.notes.push(format!("engine stopped: {reason:?}"));
        result.challenge_ended = true;
        result.fail_reason = Some(match reason {
            StoppedReason::TotalLoss => FailReason::TotalLoss,
            StoppedReason::DailyLoss => FailReason::DailyLoss,
            StoppedReason::Time => FailReason::Time,
            // 2026-05-19 Early-Abort surfaces as a benign Time fail so the
            // pass-rate counter classifies it as "did not pass" without
            // pretending it was a margin event.
            StoppedReason::EarlyAbort => FailReason::Time,
        });
        return result;
    }

    // Find the OLDEST common last-bar across asset feeds so the engine
    // never advances past an asset that hasn't ticked yet (matches TS
    // `Math.min(...lastBarTimes)` selection).
    let mut min_last_bar: Option<i64> = None;
    let mut max_last_bar: Option<i64> = None;
    for arr in input.candles_by_source.values() {
        if let Some(last) = arr.last() {
            min_last_bar =
                Some(min_last_bar.map_or(last.open_time, |v: i64| v.min(last.open_time)));
            max_last_bar =
                Some(max_last_bar.map_or(last.open_time, |v: i64| v.max(last.open_time)));
        }
    }
    let Some(last_bar_time) = min_last_bar else {
        result.notes.push("no candles".into());
        return result;
    };
    if let (Some(min), Some(max)) = (min_last_bar, max_last_bar) {
        if min != max {
            result
                .notes
                .push(format!("assets misaligned ({min}…{max}) — using min"));
        }
    }

    // First-call: anchor challenge start.
    if state.challenge_start_ts == 0 {
        state.challenge_start_ts = cfg.challenge_start_ts.unwrap_or(last_bar_time);
        state.last_bar_open_time = last_bar_time;
        state.day_start = state.equity;
        state.day_peak = state.mtm_equity.max(1.0);
        state.challenge_peak = state.mtm_equity.max(1.0);
        // Day-0 BrightFunded floor: no prior EoD yet → anchor to the starting
        // balance/equity, same as the FTMO day-start floor on day 0.
        state.eod_hwm_floor = state.equity.max(state.mtm_equity) - cfg.max_daily_loss;
    }

    // Idempotent retry guard.
    if last_bar_time <= state.last_bar_open_time && state.bars_seen > 0 {
        result.notes.push("bar already processed".into());
        return result;
    }

    // 2. Day-rollover.
    let new_day = day_index(last_bar_time, state.challenge_start_ts);
    let cur_day = state.day as i64;
    if new_day < cur_day {
        result.notes.push(format!(
            "time regression: newDay={new_day} state.day={cur_day} — keeping anchors"
        ));
    } else if new_day > cur_day {
        // 2026-05-29 BrightFunded daily-loss floor (daily_loss_eod_hmw): anchor
        // the next day's floor to the JUST-CLOSED day's high-water-mark =
        // max(EoD balance, EoD equity) − daily_loss_limit. Computed here at the
        // rollover (state.equity / state.mtm_equity still describe the day that
        // ended) and then FROZEN for the whole new day — it does NOT trail
        // intraday highs. The breach itself is still checked intraday (see the
        // daily-loss check below), so this is NOT an "only at EoD" rule; it
        // only differs from FTMO in the floor's anchor (prev-EoD-HWM vs the
        // current day-start). Verbatim BrightFunded help-center: "the minimum
        // level = EOD highest value − loss limit … if balance or equity hits
        // this level at any point during the day, the account is breached."
        if cfg.daily_loss_eod_hwm {
            state.eod_hwm_floor = state.equity.max(state.mtm_equity) - cfg.max_daily_loss;
        }
        state.day = new_day as u32;
        state.day_start = state.equity;
        // 2026-05-24 Wave2 MED FIX (Agent 9): first-call branch L133 anchors
        // day_peak from `state.mtm_equity.max(1.0)`, but day-rollover used
        // `state.equity` (realized-only). When a position is open across the
        // day boundary AND underwater (mtm < equity), day_peak is set above
        // the actual MTM anchor. Subsequent L477 ratchet only fires when
        // mtm > day_peak, so day_peak stays inflated for the rest of the
        // day → `daily_peak_trailing_stop` measures drop from an unrealistic
        // anchor and fires late (or never). Mirror first-call baseline.
        state.day_peak = state.mtm_equity.max(1.0);
        // 2026-05-19 Pattern-D fix — reset consec-stops counter + pause at
        // day boundary so a fresh trading day is unrestricted.
        state.day_consec_stops = 0;
        state.consec_stops_paused = false;
        // 2026-05-29 Release the DailyEquityGuardian soft-stop latch so a fresh
        // trading day starts unrestricted (mirrors consec_stops_paused).
        state.guardian_halted = false;
    }

    // 3. Force-close at max_days.
    if new_day >= cfg.max_days as i64 {
        // R29-R3.E: when paused_at_target is latched (PASSLOCK Pass-Lock
        // mode), the final-bar day must still count toward trading_days so
        // the min_trading_days check below can clear. The mid-bar ping-day
        // push at L350-355 only runs in the NORMAL path; the force-close
        // shortcut returned before stamping today. TS V4 force-close stamps
        // the active day via the same ping-day branch — Rust parity gap.
        //
        // 2026-05-16 Round 9 KRIT FIX (harness step_bar agent): mirror the
        // Codex R3 fix at L420-497 — track if we pushed ping_day, run
        // force_close (which deducts funding via apply_exits), then if
        // funding deduction drops equity below target so passed=false,
        // revert the ping_day push. Otherwise a window that ALMOST hit
        // target but lost to funding-fees on the close-all bar still gets
        // counted as having met min_trading_days via the ping push,
        // inflating soft-pass for any tail check downstream. +2-5pp
        // inflation potential on PASSLOCK configs with min_trading_days=4
        // and exit-day = max_days.
        let mut pushed_force_close_ping = false;
        if state.paused_at_target {
            let ping_day = new_day as u32;
            if !state.trading_days.contains(&ping_day) {
                state.trading_days.push(ping_day);
                pushed_force_close_ping = true;
            }
        }
        // 2026-05-23 Round 11.3 BUG FIX (Wave1 agent #2 BUG-1 HIGH):
        // force_close_all → apply_exits stamps ClosedTrade.day from
        // state.day, but state.day was never advanced for this final bar
        // (the L194 advance is only on the non-force-close path). Result:
        // exit-bar closed-trades were attributed to the PREVIOUS day,
        // under-counting losses for daily aggregation analytics
        // (real_funded_prob.py, monthly-profit aggregators).
        state.day = new_day as u32;
        force_close_all(state, input, cfg, last_bar_time, &mut result);
        result.challenge_ended = true;
        // After force-close: no unrealised PnL → mtm equals realised.
        // TS V4 (ftmoLiveEngineV4.ts:1370-1382): pass requires BOTH realised
        // AND mtm equity to clear the target, plus min_trading_days. R29
        // audit fix: earlier Rust used `first_target_hit_day.is_some()`
        // alone, which let positions that briefly hit target then gave
        // back to 50%-floor still pass. That diverged from TS — which
        // demands the *current* equity be at or above the target on the
        // exit bar — and inflated Rust pass-rate by counting give-back
        // tail events as passes (matches the +10.94pp Hunter drift).
        state.mtm_equity = state.equity;
        let passed = state.equity.is_finite()
            && state.equity >= 1.0 + cfg.profit_target
            && state.mtm_equity >= 1.0 + cfg.profit_target
            && state.trading_days.len() >= cfg.min_trading_days as usize;
        result.passed = passed;
        // 2026-05-16 Round 9 KRIT FIX (continued): if force-close-ping push
        // happened but post-funding check fails, revert the push so any
        // downstream soft-pass tail (sweep.rs:3108) cannot use this ping
        // day to satisfy min_trading_days. Mirrors the Codex R3 revert at
        // L492-496.
        if !passed && pushed_force_close_ping {
            let ping_day = new_day as u32;
            state.trading_days.retain(|&d| d != ping_day);
        }
        if !result.passed && result.fail_reason.is_none() {
            // give_back / time-exhaustion both surface as plain Time at the
            // end-of-window check (mirror SimulateResult mapping in TS).
            result.fail_reason = Some(FailReason::Time);
            state.stopped_reason = Some(StoppedReason::Time);
        }
        bookkeep(state, last_bar_time, cfg);
        return result;
    }

    // Build prices_by_source ONCE — used by guardian, exit-check and
    // post-exit MTM. Matches TS pollLive line 1361-1378 (exact match
    // at last_bar_time, fall back to most-recent-at-or-before).
    let prices_by_source: HashMap<String, f64> = input
        .candles_by_source
        .iter()
        .filter_map(|(k, arr)| {
            let chosen = find_candle_at_time(arr, last_bar_time)
                .or_else(|| find_candle_at_or_before(arr, last_bar_time));
            chosen.map(|c| (k.clone(), c.close))
        })
        .collect();

    // 2026-05-29 Intra-bar (low, high) per source for the optional intra-bar
    // drawdown check. Built only when enabled — close-based runs skip the work.
    let intrabar_by_source: HashMap<String, (f64, f64)> = if cfg.intrabar_dd_check {
        input
            .candles_by_source
            .iter()
            .filter_map(|(k, arr)| {
                let chosen = find_candle_at_time(arr, last_bar_time)
                    .or_else(|| find_candle_at_or_before(arr, last_bar_time));
                chosen.map(|c| (k.clone(), (c.low, c.high)))
            })
            .collect()
    } else {
        HashMap::new()
    };

    // 4a. dailyEquityGuardian (V5R) — checked on a PRE-exit MTM snapshot
    //     because the guard's purpose is to fire while positions are still
    //     open. Computes the snapshot inline so we don't mutate
    //     pos.last_known_price prematurely.
    if let Some(g) = cfg.daily_equity_guardian {
        if state.day_start > 0.0 && !state.open_positions.is_empty() {
            let mut pre_mtm = state.equity;
            for pos in state.open_positions.iter() {
                // R67 audit fix: fall back to last_known_price when current
                // feed is missing. Original code skipped feedless positions
                // entirely, undercounting unrealised loss → guardian could
                // fail to fire when a 30%-underwater position briefly lost
                // its feed. Conservative-bias = false-negative fix.
                let price = match prices_by_source
                    .get(&pos.source_symbol)
                    .copied()
                    .or(pos.last_known_price)
                {
                    Some(p) if p.is_finite() && p > 0.0 => p,
                    _ => continue,
                };
                if !(pos.entry_price.is_finite()) || pos.entry_price <= 0.0 {
                    continue;
                }
                let mut raw_pnl = match pos.direction {
                    crate::position::PositionSide::Long => {
                        (price - pos.entry_price) / pos.entry_price
                    }
                    crate::position::PositionSide::Short => {
                        (pos.entry_price - price) / pos.entry_price
                    }
                };
                // R29-Audit-Round1-A1.2: blend PTP partials into raw_pnl to
                // match `compute_mtm_equity` semantics. Without this, a
                // position with a partial fill at +2% PTP would have its
                // ENTIRE current raw_pnl re-counted in the guardian — but
                // half of that profit is ALREADY locked in via PTP, so the
                // unrealised tail is only the un-closed remainder. The TS
                // engine routes the guardian through `state.mtmEquity`
                // (which `computeMtmEquity` blends correctly), so Rust's
                // inline shortcut was the source of a positive-PnL bias on
                // PTP-active positions = false-negative guardian fires.
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
                // R29-R3.C: defensive eff_risk clamp on the floor (see pnl.rs).
                let risk_for_floor = pos.eff_risk.max(0.0);
                let unrealised = (raw_pnl * cfg.leverage * pos.eff_risk)
                    .max(crate::pnl::GAP_TAIL_MULT * risk_for_floor);
                pre_mtm *= 1.0 + unrealised;
            }
            let day_pnl = (pre_mtm - state.day_start) / state.day_start;
            if day_pnl <= -g.trigger_pct {
                let mut closes: Vec<(usize, crate::exit::ExitOutcome)> = vec![];
                for (idx, pos) in state.open_positions.iter().enumerate() {
                    let exit_price = prices_by_source
                        .get(&pos.source_symbol)
                        .copied()
                        .or(pos.last_known_price)
                        .unwrap_or(pos.entry_price);
                    closes.push((
                        idx,
                        crate::exit::ExitOutcome {
                            exit_price,
                            reason: ExitReason::Manual,
                        },
                    ));
                }
                apply_exits(state, &mut closes, cfg, last_bar_time, &mut result, input);
                // 2026-05-29 Park trading for the rest of the day. The
                // force-close alone only realises the open loss at -trigger_pct;
                // without this latch a fresh signal could re-enter on the next
                // bar and push the account into the -5% hard DailyLoss the
                // guardian exists to avoid. Cleared at the day rollover.
                state.guardian_halted = true;
                result.notes.push(format!(
                    "dailyEquityGuardian fired: day_pnl={:.2}% <= -{:.2}%",
                    day_pnl * 100.0,
                    g.trigger_pct * 100.0
                ));
            }
        }
    }

    // 5. Exit-check loop. Per TS pollLive line 1264-1353 — exits run
    //    BEFORE the per-bar MTM recompute so post-exit state.mtm_equity
    //    accurately reflects only the still-open positions. Earlier Rust
    //    order (MTM → exits) caused mtm/dayPeak/challengePeak to lag
    //    every bar with an exit, accumulating into the w2-style drift.
    let mut exits: Vec<(usize, crate::exit::ExitOutcome)> = vec![];
    for (idx, pos) in state.open_positions.iter_mut().enumerate() {
        let Some(arr) = input.candles_by_source.get(&pos.source_symbol) else {
            continue;
        };
        // Same exact-match-then-fallback as TS pollLive line 1273-1283 —
        // a lagging feed still gets its exit-check on the most-recent
        // available candle.
        let Some(candle) = find_candle_at_time(arr, last_bar_time)
            .or_else(|| find_candle_at_or_before(arr, last_bar_time))
        else {
            continue;
        };
        // R29-R3.A: ATR bar-index must match the CHOSEN candle's open_time
        // (which may lag `last_bar_time` when a feed is delayed), not
        // `last_bar_time` directly. The previous lookup keyed on
        // `last_bar_time` and silently returned None whenever the exact
        // match missed — meaning chandelier/ATR-aware exits NEVER fired on
        // lagging-feed bars, producing a TS↔Rust parity drift on multi-
        // asset windows where one feed gaps a candle.
        let chosen_open_time = candle.open_time;
        let atr_at_bar = input
            .atr_series_by_source
            .get(&pos.source_symbol)
            .and_then(|series| {
                let bar_idx = arr.iter().position(|c| c.open_time == chosen_open_time)?;
                series.get(bar_idx).copied().flatten()
            });
        let candle = *candle;
        let bars_held = state.bars_seen.saturating_sub(pos.entry_bar_idx);
        if let Some(out) =
            crate::exit::process_position_exit_with_held(pos, &candle, cfg, atr_at_bar, bars_held)
        {
            exits.push((idx, out));
        }
    }
    apply_exits(state, &mut exits, cfg, last_bar_time, &mut result, input);

    // 2026-05-23 HYBRID-MUTEX: force-close positions whose direction opposes
    // the current cross-asset trend (e.g. close longs when BNB EMA stack
    // flips bearish). Runs once per bar, AFTER exits/SL/TP but BEFORE MTM
    // recompute so equity reflects forced-closes. Requires both:
    //   - `regime_flip_close_opposite` flag set in cfg
    //   - `cross_asset_filter` configured (uses its symbol + fast/slow periods)
    // Designed for v5_amber_max_passlock_hybrid which doubles the asset
    // basket (AMBER-long + SHORTS-short) and needs true regime-mutex to
    // prevent stale-side accumulation across BNB-trend flips.
    if cfg.regime_flip_close_opposite && !state.open_positions.is_empty() {
        if let Some(filter) = cfg.cross_asset_filter.as_ref() {
            // Same lookahead-safe slice as line 743+: exclude current bar's close.
            let cross_closes: Vec<f64> = input
                .candles_by_source
                .get(&filter.symbol)
                .map(|arr| {
                    let end = arr.len().saturating_sub(1);
                    arr.iter().take(end).map(|c| c.close).collect()
                })
                .unwrap_or_default();
            // Compute 3-way trend (same logic as cross_asset_filter_allows).
            // 2026-05-23 Wave2 fix (BUG-1 HIGH): hoist EMA computation. Previous
            // impl computed EMA twice — once for current-bar `trend` AND again
            // inside `lookback_ok` block (L428-429). 2× allocation per bar AND
            // a code-rot risk (drift between the two calls would silently make
            // `trend` and `trend_b[0]` disagree). Compute ONCE up front.
            let fast_series = crate::indicators::ema(&cross_closes, filter.fast_period as usize);
            let slow_series = crate::indicators::ema(&cross_closes, filter.slow_period as usize);
            let last_fast = fast_series.last().copied().flatten();
            let last_slow = slow_series.last().copied().flatten();
            let last_close = cross_closes.last().copied();
            let trend = match (last_fast, last_slow, last_close) {
                (Some(f), Some(s), Some(c)) if c > f && f > s => {
                    Some(crate::position::PositionSide::Long)
                }
                (Some(f), Some(s), Some(c)) if c < f && f < s => {
                    Some(crate::position::PositionSide::Short)
                }
                _ => None,
            };
            // Only act on clear trends (not neutral) to avoid whipsaws.
            // 2026-05-23 HYSTERESIS: only flip-close if opposite trend has
            // been stable for at least 12 bars (6h on 30m). Prevents
            // whipsaw-kills on bar-level BNB noise.
            //
            // 2026-05-23 Round 11.3 BUG FIX (Wave1 agent #2 BUG-2 HIGH):
            // Reuse the same EMA series computed above — no re-computation.
            if let Some(t) = trend {
                let stable_bars: usize = 12;
                let lookback_ok = cross_closes.len() >= stable_bars + filter.slow_period as usize;
                let mut stable_opposite = lookback_ok;
                if lookback_ok {
                    let n = cross_closes.len();
                    for back in 1..=stable_bars {
                        let idx_back = n - 1 - back;
                        let f_b = fast_series.get(idx_back).copied().flatten();
                        let s_b = slow_series.get(idx_back).copied().flatten();
                        let c_b = cross_closes.get(idx_back).copied();
                        let trend_b = match (f_b, s_b, c_b) {
                            (Some(f), Some(s), Some(c)) if c > f && f > s => {
                                Some(crate::position::PositionSide::Long)
                            }
                            (Some(f), Some(s), Some(c)) if c < f && f < s => {
                                Some(crate::position::PositionSide::Short)
                            }
                            _ => None,
                        };
                        if trend_b != Some(t) {
                            stable_opposite = false;
                            break;
                        }
                    }
                }
                let mut flip_close: Vec<(usize, crate::exit::ExitOutcome)> = vec![];
                for (idx, pos) in state.open_positions.iter().enumerate() {
                    if stable_opposite && pos.direction != t {
                        let exit_price = input
                            .candles_by_source
                            .get(&pos.source_symbol)
                            .and_then(|arr| find_candle_at_or_before(arr, last_bar_time))
                            .map(|c| c.close)
                            .or(pos.last_known_price)
                            .unwrap_or(pos.entry_price);
                        flip_close.push((
                            idx,
                            crate::exit::ExitOutcome {
                                exit_price,
                                reason: ExitReason::Manual,
                            },
                        ));
                    }
                }
                if !flip_close.is_empty() {
                    apply_exits(
                        state,
                        &mut flip_close,
                        cfg,
                        last_bar_time,
                        &mut result,
                        input,
                    );
                }
            }
        }
    }

    // POST-EXIT MTM update — matches TS pollLive line 1361-1382. After
    // exits update state.equity, recompute MTM over the REMAINING open
    // positions and lift dayPeak/challengePeak. With no positions left
    // (e.g. all-TP'd), mtm == equity by construction.
    state.mtm_equity = compute_mtm_equity(state, &prices_by_source, cfg);
    if state.mtm_equity > state.day_peak {
        state.day_peak = state.mtm_equity;
    }
    if state.mtm_equity > state.challenge_peak {
        state.challenge_peak = state.mtm_equity;
    }

    // 6. Target / DL / TL fail-check (realised equity).
    //
    // R29-Audit-Round2.1: TS V4-LIVE at L1535/1545 trips when
    //   `equity <= 1 - maxTotalLoss + 1e-9` (and the daily-loss analogue),
    // meaning the engine FAILS when equity is AT or above the floor by up
    // to one ULP — i.e. the +1e-9 makes fail-detection STRICTER (catches
    // exact-floor + 1 ULP). The earlier Rust round-1 comment got the sign
    // backwards: subtracting 1e-9 from the floor made Rust MORE LENIENT
    // than TS — windows that TS fails at exact-floor (equity = floor) were
    // passing in Rust because `state.equity <= floor - 1e-9` requires
    // equity to fall further than TS demands. This is a candidate driver
    // of the +10.94pp Hunter / Rust→TS drift. Match TS by ADDING the
    // epsilon to the floor (i.e. raise the floor by 1e-9 → fail earlier).
    const FAIL_EPSILON: f64 = 1e-9;
    let total_loss_floor = 1.0 - cfg.max_total_loss + FAIL_EPSILON;
    // R29-R4.1 PARITY FIX: TS L1576-1579 compares the RATIO
    //   (equity - dayStart) / dayStart <= -mdl + 1e-9
    // Algebraically: equity <= dayStart*(1 - mdl) + dayStart*1e-9. The earlier
    // Rust floor added a bare 1e-9 (not dayStart*1e-9), making Rust slightly
    // MORE LENIENT than TS at the daily-loss boundary when day_start > 1
    // (post-profit). With day_start ≈ 1.08 the gap is 0.08e-9 ≈ ULP-scale —
    // microscopic but a real parity drift on f64 boundary equity values.
    // FTMO: floor = day-start × (1 − mdl), re-anchored each day. BrightFunded
    // (daily_loss_eod_hwm): floor = max(prev-EoD balance, equity) − mdl, frozen
    // for the day at the rollover above. BOTH are checked intraday below — the
    // only difference is the anchor.
    let daily_loss_floor = if cfg.daily_loss_eod_hwm {
        state.eod_hwm_floor + FAIL_EPSILON
    } else {
        state.day_start * (1.0 - cfg.max_daily_loss) + state.day_start.max(0.0) * FAIL_EPSILON
    };
    // 2026-05-25 Wave5 KRIT FIX (audit agent #3): use MIN(equity, mtm_equity)
    // for DL/TL checks so unrealised drawdown on still-open positions ALSO
    // triggers a stop-out — matches TS V4 behavior. Was: checked only
    // `state.equity` (realised-only). On a bar with -8% unrealised + 0%
    // realised (DL=5%), the window stayed alive in Rust but FTMO live would
    // close all positions via daily-loss server-side rule. Live-vs-backtest
    // drift = ~2-5pp inflated Rust pass-rate on aggressive templates.
    let mut dd_equity = state.equity.min(state.mtm_equity);
    // 2026-05-29 Intra-bar drawdown: also fold in the worst-case intra-bar MTM
    // (bar low for longs / high for shorts) so a position that pierces a floor
    // mid-bar and recovers by the close is still caught — matching a broker's
    // real-time equity check. Off by default (close-only, FTMO parity); the
    // BrightFunded EoD model enables it so the hard total floor is honest.
    if cfg.intrabar_dd_check {
        dd_equity = dd_equity.min(compute_stress_mtm_equity(state, &intrabar_by_source, cfg));
    }
    if dd_equity <= total_loss_floor {
        state.stopped_reason = Some(StoppedReason::TotalLoss);
        result.fail_reason = Some(FailReason::TotalLoss);
        result.challenge_ended = true;
        bookkeep(state, last_bar_time, cfg);
        return result;
    }
    if dd_equity <= daily_loss_floor {
        state.stopped_reason = Some(StoppedReason::DailyLoss);
        result.fail_reason = Some(FailReason::DailyLoss);
        result.challenge_ended = true;
        bookkeep(state, last_bar_time, cfg);
        return result;
    }
    // 2026-05-29 Trailing max-loss HARD bust (CTI-style): fail the moment dd
    // equity drops `trail` below the challenge peak. Uses `dd_equity` so the
    // intra-bar low counts when `intrabar_dd_check` is on. challenge_peak is the
    // running max close-MTM (≥ closed-balance peak → conservative vs CTI's
    // balance-based peak). Unlike challenge_peak_trailing_stop (entry-block),
    // this terminates the account, matching a real trailing-drawdown firm.
    if let Some(trail) = cfg.trailing_max_loss {
        if dd_equity <= state.challenge_peak * (1.0 - trail) {
            state.stopped_reason = Some(StoppedReason::TotalLoss);
            result.fail_reason = Some(FailReason::TotalLoss);
            result.challenge_ended = true;
            bookkeep(state, last_bar_time, cfg);
            return result;
        }
    }
    // Ping-day bookkeeping (R57 V4-3 Fix 5): after target hits + paused,
    // every new calendar day counts toward minTradingDays. Reuses the
    // day_index already computed above as `new_day` — saves a chrono-tz
    // round-trip per bar in the paused-after-target phase.
    if state.paused_at_target && state.first_target_hit_day.is_some() {
        let ping_day = new_day as u32;
        if !state.trading_days.contains(&ping_day) {
            state.trading_days.push(ping_day);
        }
    }

    // Target-hit detection. TS pollLive line 1414 requires BOTH realised
    // AND mark-to-market equity to clear the target before declaring
    // "first target hit". Rust previously checked only realised, which
    // fired prematurely when a single TP'd trade pushed realised over
    // the threshold while other positions were still underwater. With
    // PASSLOCK, that premature target-hit closed all positions and
    // paused — sometimes locking in a sub-target equity (the w108 bug).
    //
    // 2026-05-13 Codex HIGH FIX: the first_target_hit_day latch was set
    // BEFORE the close_all-on-target apply_exits ran, but apply_exits now
    // deducts funding-cost over crossed 8h settlement boundaries. When
    // funding > 0 and short positions are closed, realized PnL drops below
    // the target → soft-pass tail at sweep.rs:2044 saw the latch and
    // false-passed despite final equity < target. Fix: provisionally engage
    // pause + ping-day, RUN close_all so funding is realized, then RE-CHECK
    // post-funding equity AND mtm BEFORE committing the latch.
    let target_hit_provisional = state.equity >= 1.0 + cfg.profit_target
        && state.mtm_equity >= 1.0 + cfg.profit_target
        && state.first_target_hit_day.is_none();
    if target_hit_provisional {
        // 7. Pause-after-target latch — provisional. Required BEFORE close_all
        // so apply_exits sees paused state and doesn't accidentally re-open
        // anything.
        //
        // R29-Audit-Round2.2: TS V4 L1575-1576 sets
        //   `state.pausedAtTarget = !!pauseAtTarget || !!closeAllOnTarget`
        // — closeAllOnTarget=true ALONE forces pause behaviour, so the
        // ping-day push at L343-348 (TS L1663-1668) keeps satisfying
        // min_trading_days post-target. The earlier Rust gate
        // (`if pause_at_target_reached`) silently dropped the latch when
        // a config used closeAllOnTarget=true + pauseAtTarget=false.
        let prev_paused_at_target = state.paused_at_target;
        if cfg.pause_at_target_reached || cfg.close_all_on_target_reached {
            state.paused_at_target = true;
        }
        // R29-R3.8 fix: TS sets `pausedAtTarget` (line 1575-1576) BEFORE
        // ping-day bookkeeping (line 1663-1668) so the first-target-hit bar
        // counts toward `tradingDays`.
        let mut pushed_ping_day = false;
        if state.paused_at_target {
            let ping_day = new_day as u32;
            if !state.trading_days.contains(&ping_day) {
                state.trading_days.push(ping_day);
                pushed_ping_day = true;
            }
        }
        // 8. R60 close-all-on-target.
        if cfg.close_all_on_target_reached && !state.open_positions.is_empty() {
            // Close every remaining position at last bar's close.
            //
            // R67-rust-Phase-4.2: TS scan-backwards fallback at
            // ftmoLiveEngineV4.ts L1604-1610 was missing here. Earlier code
            // only attempted exact-match (`find_candle_at_time`) and then
            // bailed straight to `last_known_price`, but TS first tries an
            // exact match, and if that misses, scans backwards for the most
            // recent candle ≤ `last_bar_time`. `find_candle_at_or_before`
            // already covers BOTH cases (exact + scan-back) in a single call.
            let mut to_close: Vec<(usize, crate::exit::ExitOutcome)> = vec![];
            for (idx, pos) in state.open_positions.iter().enumerate() {
                let exit_price = input
                    .candles_by_source
                    .get(&pos.source_symbol)
                    .and_then(|arr| find_candle_at_or_before(arr, last_bar_time))
                    .map(|c| c.close)
                    .or(pos.last_known_price)
                    .unwrap_or(pos.entry_price);
                to_close.push((
                    idx,
                    crate::exit::ExitOutcome {
                        exit_price,
                        reason: ExitReason::Manual,
                    },
                ));
            }
            apply_exits(state, &mut to_close, cfg, last_bar_time, &mut result, input);
            // R67 audit fix: refresh mtm_equity to match realised after
            // close-all. Without this, state.mtm_equity retained the stale
            // pre-close value (from step 4) which could diverge from
            // state.equity if close_price ≠ tp_price.
            state.mtm_equity = state.equity;
        }
        // Codex HIGH FIX (continued): post-funding RE-CHECK. Only commit
        // the first_target_hit_day latch if equity AND mtm STILL clear the
        // target after close_all's funding-cost deduction. Otherwise revert
        // the provisional pause/ping-day so the window neither soft-passes
        // nor blocks recovery entries.
        if state.equity >= 1.0 + cfg.profit_target && state.mtm_equity >= 1.0 + cfg.profit_target {
            result.target_hit = true;
            state.first_target_hit_day = Some(state.day);
        } else {
            state.paused_at_target = prev_paused_at_target;
            if pushed_ping_day {
                let ping_day = new_day as u32;
                state.trading_days.retain(|&d| d != ping_day);
            }
        }
        // FTMO pass: target hit AND minTradingDays satisfied.
        //
        // R29-R4.3 PARITY FIX: TS V4 L1708-1719 requires BOTH realised AND
        // mtm equity to STILL clear the target at this gate. Earlier Rust
        // only checked `trading_days.len() >= min_trading_days`, relying on
        // the algebraic equivalence "post-close-all equity == pre-close-all
        // mtm". That equivalence holds when GAP_TAIL did not bind on any
        // closure — but if close_price triggered the floor on a position
        // where unrealised did NOT (different sign-of-floor regimes are
        // possible at the boundary), equity post-close can drop below the
        // target while pre-close mtm cleared it. Defensive parity gate
        // matches TS exactly.
        if state.equity >= 1.0 + cfg.profit_target
            && state.mtm_equity >= 1.0 + cfg.profit_target
            && state.trading_days.len() >= cfg.min_trading_days as usize
        {
            result.passed = true;
            result.challenge_ended = true;
            bookkeep(state, last_bar_time, cfg);
            return result;
        }
    }

    // Standalone pass-check (TS line 1510) — fires every bar so a paused-
    // after-target run can pass once ping-day accumulation catches
    // trading_days up to min_trading_days.
    //
    // 2026-05-16 Round 9 KRIT FIX (harness step_bar agent): require
    // `first_target_hit_day.is_some()` BEFORE this branch fires. Otherwise:
    // T0: provisional target_hit → close_all + funding deduction → re-check
    //     fails → revert paused_at_target + retain ping_day removal (Codex R3 fix).
    // T1: next bar, transient mtm spike pushes both equity AND mtm above target
    //     while trading_days still satisfies min_trading_days from earlier entry
    //     pushes → this standalone branch fires and passes WITHOUT funding
    //     re-check. Soft-pass class that the Codex R3 fix was supposed to
    //     eliminate. Require the committed latch to gate this branch.
    if state.equity >= 1.0 + cfg.profit_target
        && state.mtm_equity >= 1.0 + cfg.profit_target
        && state.trading_days.len() >= cfg.min_trading_days as usize
        && state.first_target_hit_day.is_some()
    {
        result.target_hit = true;
        result.passed = true;
        result.challenge_ended = true;
        state.stopped_reason = None;
        bookkeep(state, last_bar_time, cfg);
        return result;
    }

    // 7. Entry-side gates that block ALL new entries this bar.
    //
    // R29-R3.B: track the precise gate that fired so skip-reasons aren't
    // contaminated by unrelated `notes` pushed earlier in the bar
    // (e.g. "assets misaligned", "time regression"). Previously
    // `result.notes.last()` was used as the reason; if no gate fired but a
    // mismatch note was pushed, the skip-reason would falsely point at the
    // mismatch as the blocker → misleading diagnostics + audit confusion.
    let mut entries_allowed = !state.paused_at_target;
    let mut block_reason: Option<String> = if state.paused_at_target {
        Some("pausedAtTarget".into())
    } else {
        None
    };
    if entries_allowed {
        if let Some(dpts) = cfg.daily_peak_trailing_stop {
            let drop = (state.day_peak - state.mtm_equity) / state.day_peak.max(1e-9);
            if drop >= dpts.trail_distance {
                entries_allowed = false;
                let msg = format!(
                    "dailyPeakTrailingStop: drop {:.2}% >= {:.2}%",
                    drop * 100.0,
                    dpts.trail_distance * 100.0
                );
                result.notes.push(msg.clone());
                block_reason = Some(msg);
            }
        }
    }
    // 2026-05-19 Pattern-D fix — consecutive-stops pause blocks new entries
    // until the next day rollover (where consec_stops_paused is cleared).
    if entries_allowed && state.consec_stops_paused {
        entries_allowed = false;
        let msg = format!(
            "consecStopsPaused: {} consec stops hit threshold {}",
            state.day_consec_stops, cfg.max_consec_stops_per_day
        );
        result.notes.push(msg.clone());
        block_reason = Some(msg);
    }
    // 2026-05-29 DailyEquityGuardian soft-stop — once the guardian force-closed
    // at -trigger_pct today, park new entries until the day rollover clears the
    // latch. This is what turns the guardian from a "realise the loss" into a
    // genuine intraday stop that caps the day's loss below the hard DL limit.
    if entries_allowed && state.guardian_halted {
        entries_allowed = false;
        let msg = "dailyEquityGuardian: halted for day".to_string();
        result.notes.push(msg.clone());
        block_reason = Some(msg);
    }
    if entries_allowed {
        if let Some(cpts) = cfg.challenge_peak_trailing_stop {
            let drop = (state.challenge_peak - state.mtm_equity) / state.challenge_peak.max(1e-9);
            if drop >= cpts.trail_distance {
                entries_allowed = false;
                let msg = format!("challengePeakTrailingStop: drop {:.2}%", drop * 100.0);
                result.notes.push(msg.clone());
                block_reason = Some(msg);
            }
        }
    }
    if entries_allowed {
        if let Some(idl) = cfg.intraday_daily_loss_throttle {
            if state.day_start > 0.0 {
                let day_pnl = (state.equity - state.day_start) / state.day_start;
                if day_pnl <= -idl.hard_loss_threshold {
                    entries_allowed = false;
                    let msg = format!("intradayDailyLossThrottle hard: {:.2}%", day_pnl * 100.0);
                    result.notes.push(msg.clone());
                    block_reason = Some(msg);
                }
            }
        }
    }

    // 7b. Bar-level time gates (allowed hours / dows).
    //
    // 2026-05-13 Codex Round 8 RE-FIX: previous R29 audit fix added
    // `+ bar_minutes` to last_bar_time, claiming "signals fire on close of
    // bar i, entries execute on i+1's open". But in Rust detector convention
    // (signals_r28v6.rs:230-236 + sweep.rs:1817 push-loop), `last_bar_time`
    // ALREADY equals `candles[i].open_time` = entry-bar's open_time (the
    // detector sets `entry_time: last.open_time` and signal-bar is
    // `trigger_idx = i-1`). The R29 fix mis-attributed the convention and
    // shifted the gate by one EXTRA bar forward. TS V4-Sim
    // `ftmoDaytrade24h.ts:4156` checks `candles[i+1].openTime.hour` where
    // TS's `i` is the signal-bar = Rust's `i-1`. So TS's `i+1` = Rust's `i`
    // = `last_bar_time` directly. Two independent audit agents flagged this
    // simultaneously in Round 8.
    let entry_bar_time = last_bar_time;
    if entries_allowed {
        if let Some(hours) = cfg.allowed_hours_utc.as_ref() {
            if let Some(dt) = DateTime::<Utc>::from_timestamp_millis(entry_bar_time) {
                if !hours.contains(&dt.hour()) {
                    entries_allowed = false;
                    let msg = format!("hour-gate: {} not in allowed_hours_utc", dt.hour());
                    result.notes.push(msg.clone());
                    block_reason = Some(msg);
                }
            }
        }
    }
    if entries_allowed {
        // 2026-05-13 Bug-Audit Round 2 — Bug E DOC: `allowed_dows_utc` uses
        // `num_days_from_sunday()` semantics → **Sunday=0, Monday=1, …,
        // Saturday=6**. This matches JS `Date.getUTCDay()` and TS V4-Sim.
        // DO NOT confuse with chrono's `num_days_from_monday()` (Mo=0).
        // Common config: `[1,2,3,4,5]` = Monday-Friday (skip weekends).
        if let Some(dows) = cfg.allowed_dows_utc.as_ref() {
            if let Some(dt) = DateTime::<Utc>::from_timestamp_millis(entry_bar_time) {
                let dow = dt.weekday().num_days_from_sunday();
                if !dows.contains(&dow) {
                    entries_allowed = false;
                    let msg = format!("dow-gate: {dow} not in allowed_dows_utc");
                    result.notes.push(msg.clone());
                    block_reason = Some(msg);
                }
            }
        }
    }

    // 9. Open new positions from supplied signals. When `entries_allowed` is
    //    false (set by bar-level gates above), record EACH offered signal as
    //    a skip so diagnostics see exactly why drops happened — previously
    //    these were silently dropped, masking the gate that fired.
    if !entries_allowed {
        for sig in &input.signals {
            push_skip_if(
                &mut result.skipped,
                || sig.symbol.clone(),
                || {
                    let reason = block_reason
                        .clone()
                        .unwrap_or_else(|| "entries_allowed=false".into());
                    format!("bar-gate: {reason}")
                },
            );
        }
    }
    if entries_allowed {
        let max_concurrent = cfg.max_concurrent_trades.unwrap_or(u32::MAX) as usize;
        // 2026-05-24 — per-asset hour-of-day gate. Cached current UTC hour
        // so we don't recompute DateTime::from_timestamp_millis per signal.
        let current_utc_hour: Option<u32> =
            DateTime::<Utc>::from_timestamp_millis(entry_bar_time).map(|dt| dt.hour());
        for sig in &input.signals {
            // Per-asset activation gates.
            if let Some(asset_cfg) = cfg.assets.iter().find(|a| a.symbol == sig.symbol) {
                // 2026-05-24 per-asset allowed_hours_utc: when Some, only
                // entries during the listed UTC hours pass. Enables disjoint
                // time-scheduling between asset-clones (e.g. AMBER even
                // hours, SHORT odd hours) without needing mutex_long_short.
                if let Some(hours) = asset_cfg.allowed_hours_utc.as_ref() {
                    if let Some(h) = current_utc_hour {
                        if !hours.contains(&h) {
                            push_skip_if(
                                &mut result.skipped,
                                || sig.symbol.clone(),
                                || format!("asset_hours: {h} not in {hours:?}"),
                            );
                            continue;
                        }
                    }
                }
                if let Some(after) = asset_cfg.activate_after_day {
                    if state.day < after {
                        push_skip_if(
                            &mut result.skipped,
                            || sig.symbol.clone(),
                            || format!("activate_after_day: day {} < {}", state.day, after),
                        );
                        continue;
                    }
                }
                let eq_pct = state.equity - 1.0;
                if let Some(min_g) = asset_cfg.min_equity_gain {
                    if eq_pct < min_g {
                        push_skip_if(
                            &mut result.skipped,
                            || sig.symbol.clone(),
                            || format!("min_equity_gain {min_g:.4} > {eq_pct:.4}"),
                        );
                        continue;
                    }
                }
                if let Some(max_g) = asset_cfg.max_equity_gain {
                    if eq_pct > max_g {
                        push_skip_if(
                            &mut result.skipped,
                            || sig.symbol.clone(),
                            || format!("max_equity_gain {max_g:.4} < {eq_pct:.4}"),
                        );
                        continue;
                    }
                }
            }
            // 2026-05-23 MUTEX LONG/SHORT — true position-level mutex. If any
            // open position has the opposite direction, block this entry.
            // Forces sequential 1-side-at-a-time trading across all assets.
            if cfg.mutex_long_short && !state.open_positions.is_empty() {
                let has_opposite = state
                    .open_positions
                    .iter()
                    .any(|p| p.direction != sig.direction);
                if has_opposite {
                    push_skip_if(
                        &mut result.skipped,
                        || sig.symbol.clone(),
                        || {
                            format!(
                                "mutex_long_short: {:?} blocked (opposite position open)",
                                sig.direction
                            )
                        },
                    );
                    continue;
                }
            }
            // CrossAssetFilter — only allow when reference symbol's trend matches.
            // 2026-05-13 Codex Round 7 #B2 FIX: slice cross_closes to EXCLUDE
            // the current bar's close (mirror sweep.rs:1739 Codex Fix 4).
            // Detector path already excludes; harness was re-running the
            // filter with the full feed → lookahead on this gate. The
            // saturating_sub(1) handles the empty-feed warmup edge.
            if let Some(filter) = cfg.cross_asset_filter.as_ref() {
                let cross_closes: Vec<f64> = input
                    .candles_by_source
                    .get(&filter.symbol)
                    .map(|arr| {
                        let end = arr.len().saturating_sub(1);
                        arr.iter().take(end).map(|c| c.close).collect()
                    })
                    .unwrap_or_default();
                if !crate::detector_filters::cross_asset_filter_allows(
                    filter,
                    sig.direction,
                    &cross_closes,
                ) {
                    push_skip_if(
                        &mut result.skipped,
                        || sig.symbol.clone(),
                        || {
                            format!(
                                "crossAssetFilter[{}] blocks {:?}",
                                filter.symbol, sig.direction
                            )
                        },
                    );
                    continue;
                }
            }
            if let Some(extra) = cfg.cross_asset_filters_extra.as_ref() {
                let mut blocked = false;
                for filter in extra {
                    let cross_closes: Vec<f64> = input
                        .candles_by_source
                        .get(&filter.symbol)
                        .map(|arr| {
                            let end = arr.len().saturating_sub(1);
                            arr.iter().take(end).map(|c| c.close).collect()
                        })
                        .unwrap_or_default();
                    if !crate::detector_filters::cross_asset_filter_allows(
                        filter,
                        sig.direction,
                        &cross_closes,
                    ) {
                        push_skip_if(
                            &mut result.skipped,
                            || sig.symbol.clone(),
                            || {
                                format!(
                                    "crossAssetFiltersExtra[{}] blocks {:?}",
                                    filter.symbol, sig.direction
                                )
                            },
                        );
                        blocked = true;
                        break;
                    }
                }
                if blocked {
                    continue;
                }
            }

            // R29-Bug-Audit-2026-05-09: per-asset+direction trade-exclusivity gate.
            // Mirror of `detectAsset` internal cooldown at
            // `ftmoDaytrade24h.ts:4987-4998` (`cooldown = exitBar + 1`). TS
            // detector advances `i` past every trade's exit bar, preventing a
            // second long/short on the same asset until after the previous
            // trade exits. The Rust port had no such gate, so the entry-loop
            // would happily open a second BTC-long while the first was still
            // open — producing duplicate positions on the same asset+direction
            // that PASSLOCK then closed in bulk. On 9-asset DROPONLY this
            // inflated pass-rate by ~+8pp vs the TS V4-LIVE shadow (per win=1
            // diff: Rust 9 trades pass +8.29% / TS 6 trades daily_loss -7.19%).
            // The TS gate is direction-specific (long has its own cooldown,
            // short has its own — both can run simultaneously per asset).
            // 2026-05-24 — Pyramid exception: if cfg.allow_pyramid_after_profit_pct
            // is set AND the existing position is in profit by that pct,
            // allow a SECOND entry. Otherwise enforce trade-exclusivity as before.
            // Pyramid_active tracked here so the eff_risk sizing below can scale.
            let mut pyramid_scale: Option<f64> = None;
            let existing_pos = state
                .open_positions
                .iter()
                .find(|p| p.symbol == sig.symbol && p.direction == sig.direction);
            if let Some(pos) = existing_pos {
                let allow_pct = cfg.allow_pyramid_after_profit_pct.unwrap_or(0.0);
                if allow_pct > 0.0 {
                    // Compute unrealized PnL %.
                    // Long: (last_known - entry) / entry; Short: (entry - last_known) / entry.
                    let last_price = pos.last_known_price.unwrap_or(pos.entry_price);
                    let unr_pnl = if pos.direction == crate::position::PositionSide::Long {
                        (last_price - pos.entry_price) / pos.entry_price
                    } else {
                        (pos.entry_price - last_price) / pos.entry_price
                    };
                    if unr_pnl >= allow_pct {
                        pyramid_scale = Some(cfg.pyramid_size_mult);
                    }
                }
                if pyramid_scale.is_none() {
                    push_skip_if(
                        &mut result.skipped,
                        || sig.symbol.clone(),
                        || "trade-exclusivity: same asset+direction already open".into(),
                    );
                    continue;
                }
            }

            // R29-Drift-Audit-2026-05-12 (REVERTED): the post-exit 1-bar
            // cooldown patch was a misinterpretation. TS detectAsset's
            // internal cooldown only affects WHICH trades the detector
            // produces in its full-history pass; TS V4-Sim then filters
            // by `entryTime === lastBar.openTime`, so the cooldown only
            // matters for back-to-back same-bar+1 entries — which the
            // existing open-position trade-exclusivity gate already
            // covers because the prior trade is still open until end-of-
            // bar in TS too. Adding bars_seen-based gating dropped
            // 5 windows on the 38-window step=14 spot-check (10/38 vs
            // 13/38 baseline). Reverted to baseline; the residual ~2.6pp
            // drift is exit-handler-path divergence (atrStop/chandelier/
            // trailingStop precedence, not signal generation).

            // V5R reentryAfterStop — slot present + within window?
            let key = ls_key(&sig.symbol, sig.direction);
            let mut reentry_scale: Option<f64> = None;
            if let (Some(reentry_cfg), Some(slot)) =
                (cfg.reentry_after_stop, state.pending_reentries.get(&key))
            {
                if state.bars_seen <= slot.bars_seen_at_stop + reentry_cfg.within_bars {
                    reentry_scale = Some(reentry_cfg.size_mult);
                }
            }

            // Loss-streak cooldown gate — bypass if we're consuming a re-entry slot.
            if reentry_scale.is_none() {
                if let Some(ls) = state.loss_streak_by_asset_dir.get(&key) {
                    if state.bars_seen < ls.cd_until_bars_seen {
                        push_skip_if(
                            &mut result.skipped,
                            || sig.symbol.clone(),
                            || {
                                format!(
                                    "lossStreakCooldown until barsSeen={}",
                                    ls.cd_until_bars_seen
                                )
                            },
                        );
                        continue;
                    }
                }
            }
            // CorrelationFilter — count open same-direction.
            if let Some(corr) = cfg.correlation_filter {
                let same_dir = state
                    .open_positions
                    .iter()
                    .filter(|p| p.direction == sig.direction)
                    .count();
                if same_dir >= corr.max_open_same_direction as usize {
                    push_skip_if(
                        &mut result.skipped,
                        || sig.symbol.clone(),
                        || format!("correlationFilter {same_dir} same-dir open"),
                    );
                    continue;
                }
            }
            // MaxConcurrentTrades cap (re-checked per signal so mid-bar opens
            // correctly bump the count for subsequent matches).
            //
            // R29-Audit-Round1.6: when MCT trips, ALL remaining signals on
            // this bar are blocked (the open count won't shrink until next
            // bar). TS V4-LIVE simulate uses `mctBreakOuter = true; break`.
            // Earlier `continue` here let downstream signals run through
            // every per-asset/cross-asset/LSC/correlation gate uselessly,
            // emitting bogus skip-reasons.
            if state.open_positions.len() >= max_concurrent {
                push_skip_if(
                    &mut result.skipped,
                    || sig.symbol.clone(),
                    || "MCT cap mid-bar".into(),
                );
                break;
            }
            // 2026-05-13 Codex Round 7 #B5 FIX: reentry size_mult could push
            // eff_risk ABOVE the caps the detector already applied. Re-apply
            // the centralized caps after the multiplication so reentry never
            // exceeds maxRiskFrac or LIVE_LOSS_CAP.
            // 2026-05-24 Pyramid: same caps logic as reentry. Pyramid takes
            // precedence over reentry if both happen on the same signal
            // (rare — both are exception paths to trade-exclusivity).
            let effective_scale = pyramid_scale.or(reentry_scale);
            let final_eff_risk = match effective_scale {
                Some(m) => crate::sizing::apply_post_factor_caps(
                    cfg,
                    state,
                    sig.eff_risk * m,
                    sig.stop_pct,
                ),
                None => sig.eff_risk,
            };
            if final_eff_risk <= 0.0 {
                push_skip_if(
                    &mut result.skipped,
                    || sig.symbol.clone(),
                    || "reentry eff_risk ≤ 0 after caps".into(),
                );
                continue;
            }
            // 2026-05-16 Round 9 KRIT FIX (detector enter agent): trading_days
            // push was BEFORE the reentry eff_risk validation above. If
            // apply_post_factor_caps clamped eff_risk to 0 (e.g. maxStopPct
            // cap on wide ATR-stop), the signal would skip via `continue`
            // but trading_day was already committed. False min_trading_days
            // counter — +0.5-1.5pp inflation on reentry-heavy configs.
            // Moved push AFTER the validation so only actually-entering
            // signals stamp the day.
            if !state.trading_days.contains(&state.day) {
                state.trading_days.push(state.day);
            }
            // Consume the re-entry slot now that we're opening.
            if reentry_scale.is_some() {
                state.pending_reentries.remove(&key);
            }
            // 2026-05-13 Codex Round 5 MED FIX (#9): ticket-id ordinal
            // suffix to resolve same-bar same-symbol same-direction
            // collisions. Count existing matching open positions for the
            // ordinal — first ticket gets the legacy 3-token form, 2nd+
            // get @1, @2, … suffixes. Matches TS V4 emission at
            // ftmoLiveEngineV4.ts:2115.
            let same_key_open = state
                .open_positions
                .iter()
                .filter(|p| {
                    p.symbol == sig.symbol
                        && p.entry_time == sig.entry_time
                        && p.direction == sig.direction
                })
                .count();
            let pos = OpenPosition {
                ticket_id: OpenPosition::make_ticket_id_with_ordinal(
                    sig.entry_time,
                    &sig.symbol,
                    sig.direction,
                    same_key_open,
                ),
                symbol: sig.symbol.clone(),
                source_symbol: sig.source_symbol.clone(),
                direction: sig.direction,
                entry_time: sig.entry_time,
                entry_price: sig.entry_price,
                initial_stop_pct: sig.stop_pct,
                stop_price: sig.stop_price,
                tp_price: sig.tp_price,
                eff_risk: final_eff_risk,
                entry_bar_idx: state.bars_seen,
                high_watermark: sig.entry_price,
                be_active: false,
                ptp_triggered: false,
                ptp_realized_pct: 0.0,
                ptp_level_idx: 0,
                ptp_levels_realized: 0.0,
                last_known_price: Some(sig.entry_price),
                trail_active: false,
                trail_peak: sig.entry_price,
            };
            result.decision.opens.push(sig.clone());
            state.open_positions.push(pos);
        }
    }

    // 10. Bookkeeping.
    bookkeep(state, last_bar_time, cfg);
    result
}

fn bookkeep(state: &mut EngineState, last_bar_time: i64, cfg: &EngineConfig) {
    state.bars_seen += 1;
    state.last_bar_open_time = last_bar_time;
    trim_inline(state, cfg);
}

fn apply_exits(
    state: &mut EngineState,
    exits: &mut Vec<(usize, crate::exit::ExitOutcome)>,
    cfg: &EngineConfig,
    last_bar_time: i64,
    result: &mut StepResult,
    input: &BarInput<'_>,
) {
    // Process highest-index first so removals don't shift indices for later
    // entries.
    exits.sort_by_key(|e| std::cmp::Reverse(e.0));
    for (idx, out) in exits.drain(..) {
        let pos = state.open_positions.remove(idx);
        // 2026-05-13 Round-2 Audit Fix — funding-cost-deduction. When BarInput
        // carries funding_by_source, walk every 8h settlement boundary within
        // the trade lifetime and deduct (long) / receive (short) the funding
        // rate. Without this the engine was applying funding-RATE entry-gate
        // but never paying the cost (R56 TS audit fix that hadn't been ported).
        let pnl = if let Some(fmap) = input.funding_by_source {
            let funding_series = fmap.get(&pos.source_symbol).map(|v| v.as_slice());
            let bar_dur_ms = (cfg.bar_minutes as i64).saturating_mul(60_000);
            // bar_open_time_0 = open_time of feed[0] for this source.
            let bar0 = input
                .candles_by_source
                .get(&pos.source_symbol)
                .and_then(|v| v.first())
                .map(|c| c.open_time)
                .unwrap_or(0);
            crate::pnl::compute_eff_pnl_with_funding(
                &pos,
                out.exit_price,
                cfg,
                Some(last_bar_time),
                funding_series,
                bar0,
                bar_dur_ms,
            )
        } else {
            compute_eff_pnl_with_time(&pos, out.exit_price, cfg, Some(last_bar_time))
        };
        // Compound realised equity.
        state.equity *= 1.0 + pnl.eff_pnl;
        let trade = ClosedTrade {
            ticket_id: pos.ticket_id.clone(),
            symbol: pos.symbol.clone(),
            direction: pos.direction,
            entry_time: pos.entry_time,
            exit_time: last_bar_time,
            entry_price: pos.entry_price,
            exit_price: out.exit_price,
            raw_pnl: pnl.raw_pnl,
            eff_pnl: pnl.eff_pnl,
            exit_reason: out.reason,
            day: state.day,
            entry_day: day_index(pos.entry_time, state.challenge_start_ts) as u32,
        };
        // Loss-streak tracking — winners reset; losers increment + maybe set cooldown.
        let key = ls_key(&pos.symbol, pos.direction);
        let entry = state
            .loss_streak_by_asset_dir
            .entry(key.clone())
            .or_insert(LossStreakEntry {
                streak: 0,
                cd_until_bars_seen: 0,
            });
        if pnl.eff_pnl > 0.0 {
            entry.streak = 0;
            // Winning trade clears any pending re-entry slot for this key.
            state.pending_reentries.remove(&key);
        } else {
            entry.streak += 1;
            if let Some(cd) = cfg.loss_streak_cooldown {
                if entry.streak >= cd.after_losses {
                    entry.cd_until_bars_seen = state.bars_seen + cd.cooldown_bars;
                }
            }
            // V5R reentryAfterStop — install slot for the next signal.
            if cfg.reentry_after_stop.is_some() && out.reason == ExitReason::Stop {
                state.pending_reentries.insert(
                    key,
                    crate::state::ReentryState {
                        bars_seen_at_stop: state.bars_seen,
                        original_eff_risk: pos.eff_risk,
                    },
                );
            }
        }
        // Kelly buffer is only populated when kellySizing is configured —
        // matches TS gating at line ~1349.
        if cfg.kelly_sizing.is_some() {
            state.kelly_pnls.push(KellyPnl {
                close_time: last_bar_time,
                eff_pnl: pnl.eff_pnl,
            });
        }
        state.closed_trades.push(trade.clone());
        result.decision.closes.push(CloseIntent {
            ticket_id: pos.ticket_id,
            exit_price: out.exit_price,
            exit_reason: out.reason,
        });
        // 2026-05-19 Pattern-D fix — track consecutive stop-loss exits per day.
        // Reset on any non-Stop exit; increment on Stop; arm pause when threshold hit.
        if out.reason == ExitReason::Stop {
            state.day_consec_stops = state.day_consec_stops.saturating_add(1);
            if cfg.max_consec_stops_per_day > 0
                && state.day_consec_stops >= cfg.max_consec_stops_per_day
            {
                state.consec_stops_paused = true;
            }
        } else {
            state.day_consec_stops = 0;
        }
        // 2026-05-19 Pattern-C fix — trailing-DD-lock tracking on realized
        // equity (NOT mtm — avoids anti-reversal-style fighting PASSLOCK).
        if cfg.trail_dd_lock_trigger > 0.0 {
            if !state.trail_dd_armed && state.equity >= 1.0 + cfg.trail_dd_lock_trigger {
                state.trail_dd_armed = true;
                state.trail_dd_peak = state.equity;
            }
            if state.trail_dd_armed && state.equity > state.trail_dd_peak {
                state.trail_dd_peak = state.equity;
            }
            if state.trail_dd_armed && state.equity < state.trail_dd_peak - cfg.trail_dd_lock_floor
            {
                // Mirror PASSLOCK's paused-at-target latch — blocks new
                // entries and lets the bar's existing apply_exits flow
                // close remaining positions naturally on next step.
                state.paused_at_target = true;
            }
        }
    }
}

/// Public wrapper around the internal `force_close_all` used by sweep-level
/// abort rules (e.g. `--early-abort-after-losses`). Closes every open
/// position at the current bar's close (or the most-recent-at-or-before
/// candle when feed gaps) using `ExitReason::Manual`. Mirrors the engine's
/// internal max-days force-close path. Returns a `StepResult` so the caller
/// can inspect any feed-loss fail surfaced during close.
pub fn force_close_all_external(
    state: &mut EngineState,
    input: &BarInput<'_>,
    cfg: &EngineConfig,
    last_bar_time: i64,
) -> StepResult {
    let mut result = StepResult {
        decision: PollDecision::default(),
        notes: vec![],
        skipped: vec![],
        challenge_ended: true,
        passed: false,
        fail_reason: None,
        target_hit: false,
    };
    force_close_all(state, input, cfg, last_bar_time, &mut result);
    // After all positions close, realised equity has caught up to MTM.
    state.mtm_equity = state.equity;
    result
}

fn force_close_all(
    state: &mut EngineState,
    input: &BarInput<'_>,
    cfg: &EngineConfig,
    last_bar_time: i64,
    result: &mut StepResult,
) {
    let mut closes: Vec<(usize, crate::exit::ExitOutcome)> = vec![];
    for (idx, pos) in state.open_positions.iter().enumerate() {
        let arr = input.candles_by_source.get(&pos.source_symbol);
        let exit_price = arr
            .and_then(|a| find_candle_at_time(a, last_bar_time).map(|c| c.close))
            .or_else(|| {
                arr.and_then(|a| find_candle_at_or_before(a, last_bar_time).map(|c| c.close))
            })
            .or(pos.last_known_price)
            .unwrap_or_else(|| {
                if result.fail_reason.is_none() {
                    result.fail_reason = Some(FailReason::FeedLost);
                }
                pos.entry_price
            });
        closes.push((
            idx,
            crate::exit::ExitOutcome {
                exit_price,
                reason: ExitReason::Manual,
            },
        ));
    }
    apply_exits(state, &mut closes, cfg, last_bar_time, result, input);
}

#[allow(unused)]
fn _ignore<T>(_: T) {} // silence unused warnings during incremental porting

#[cfg(test)]
mod tests {
    use super::*;
    use crate::position::PositionSide;

    fn cfg_basic() -> EngineConfig {
        let mut c = EngineConfig::r28_v6_passlock_template();
        c.profit_target = 0.05;
        c.max_daily_loss = 0.03;
        c.max_total_loss = 0.06;
        c.min_trading_days = 1;
        c.max_days = 5;
        c.close_all_on_target_reached = false;
        c.pause_at_target_reached = false;
        c
    }

    fn make_candle(open_time: i64, open: f64, high: f64, low: f64, close: f64) -> Candle {
        Candle::new(open_time, open, high, low, close, 0.0)
    }

    fn make_input<'a>(
        candles: &'a HashMap<String, Vec<Candle>>,
        atr: &'a HashMap<String, Vec<Option<f64>>>,
        signals: Vec<PollSignal>,
    ) -> BarInput<'a> {
        BarInput {
            candles_by_source: candles,
            atr_series_by_source: atr,
            funding_by_source: None,
            signals,
        }
    }

    // A plain BTCUSDT long that just floats with the feed price: stop far below
    // and TP far above so the only thing that moves equity is mark-to-market.
    fn floating_long(entry_price: f64, eff_risk: f64) -> OpenPosition {
        OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price,
            initial_stop_pct: 0.20,
            stop_price: 1.0,
            tp_price: 1.0e9,
            eff_risk,
            entry_bar_idx: 0,
            high_watermark: entry_price,
            be_active: false,
            ptp_triggered: false,
            ptp_realized_pct: 0.0,
            ptp_level_idx: 0,
            ptp_levels_realized: 0.0,
            last_known_price: None,
            trail_active: false,
            trail_peak: 0.0,
        }
    }

    #[test]
    fn empty_input_returns_no_candles_note() {
        let cfg = cfg_basic();
        let mut state = EngineState::initial("x");
        let candles = HashMap::new();
        let atr = HashMap::new();
        let input = make_input(&candles, &atr, vec![]);
        let r = step_bar(&mut state, &input, &cfg);
        assert!(!r.challenge_ended);
        assert!(r.notes.iter().any(|n| n.contains("no candles")));
    }

    #[test]
    fn idempotent_retry_on_same_bar() {
        let cfg = cfg_basic();
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".to_string(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();

        // First poll — accepted.
        let r1 = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert!(!r1.challenge_ended);
        assert_eq!(state.bars_seen, 1);

        // Same bar again — should be idempotent.
        let r2 = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert!(r2.notes.iter().any(|n| n.contains("already processed")));
        assert_eq!(state.bars_seen, 1);
    }

    #[test]
    fn signal_opens_position() {
        let cfg = cfg_basic();
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert_eq!(r.decision.opens.len(), 1);
        assert_eq!(state.open_positions.len(), 1);
        assert_eq!(state.trading_days, vec![0]);
    }

    #[test]
    fn position_exits_on_tp_hit_next_bar() {
        let cfg = cfg_basic();
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        // Bar 1 — opens.
        step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert_eq!(state.open_positions.len(), 1);

        // Bar 2 — TP hit.
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 100.5, 105.0, 100.0, 104.5));
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert_eq!(state.open_positions.len(), 0);
        assert_eq!(state.closed_trades.len(), 1);
        assert_eq!(state.closed_trades[0].exit_reason, ExitReason::Tp);
        assert!(state.equity > 1.0);
        // Target may or may not be hit depending on sizing — we set risk=0.4
        // and lev=2 → eff = 0.04 × 2 × 0.4 = 0.032. profit_target=0.05 → not yet.
        assert!(!r.target_hit);
    }

    #[test]
    fn total_loss_short_circuits() {
        let mut cfg = cfg_basic();
        cfg.max_total_loss = 0.02;
        let mut state = EngineState::initial("x");
        state.equity = 0.97; // already past floor
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert!(r.challenge_ended);
        assert_eq!(r.fail_reason, Some(FailReason::TotalLoss));
        assert_eq!(state.stopped_reason, Some(StoppedReason::TotalLoss));
    }

    #[test]
    fn loss_streak_cooldown_blocks_subsequent_signal() {
        let mut cfg = cfg_basic();
        cfg.loss_streak_cooldown = Some(crate::config::LossStreakCooldown {
            after_losses: 1,
            cooldown_bars: 5,
        });
        let mut state = EngineState::initial("x");
        // Pre-seed a stop-loss outcome via direct state mutation: the position
        // closed as a loser, so loss-streak entry was created. Anchors are set
        // so the first-call branch is skipped — otherwise it overwrites
        // last_bar_open_time and the idempotent guard fires immediately.
        state.challenge_start_ts = 1; // non-zero — skip anchor block
        state.last_bar_open_time = 0; // < signal time
        state.loss_streak_by_asset_dir.insert(
            ls_key("BTC-TREND", PositionSide::Long),
            crate::state::LossStreakEntry {
                streak: 1,
                cd_until_bars_seen: 100,
            },
        );
        state.bars_seen = 50; // still within cooldown window

        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        // Signal blocked by cooldown — no position opened.
        assert_eq!(state.open_positions.len(), 0);
        assert!(r
            .skipped
            .iter()
            .any(|s| s.reason.contains("lossStreakCooldown")));
    }

    #[test]
    fn hour_gate_blocks_outside_window() {
        let mut cfg = cfg_basic();
        cfg.allowed_hours_utc = Some(vec![10, 11, 12]); // bar at 1000ms is hour 0
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert_eq!(state.open_positions.len(), 0);
        assert!(r.notes.iter().any(|n| n.contains("hour-gate")));
    }

    #[test]
    fn activate_after_day_blocks_early_entry() {
        let mut cfg = cfg_basic();
        cfg.assets = vec![crate::config::AssetConfig {
            symbol: "BTC-TREND".into(),
            source_symbol: Some("BTCUSDT".into()),
            tp_pct: None,
            stop_pct: None,
            risk_frac: 0.4,
            activate_after_day: Some(3),
            min_equity_gain: None,
            max_equity_gain: None,
            hold_bars: None,
            invert_direction: false,
            ..Default::default()
        }];
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        state.day = 1; // < 3
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert_eq!(state.open_positions.len(), 0);
        assert!(r
            .skipped
            .iter()
            .any(|s| s.reason.contains("activate_after_day")));
    }

    #[test]
    fn daily_peak_trailing_stop_blocks_entries() {
        let mut cfg = cfg_basic();
        cfg.daily_peak_trailing_stop = Some(crate::config::PeakTrailingStop {
            trail_distance: 0.02,
        });
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        // dayPeak=1.05, mtm will compute to 1.0 → drop=4.76% > 2% threshold.
        state.day_peak = 1.05;
        state.mtm_equity = 1.0;
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 100.5, 99.5, 100.0)],
        );
        let atr = HashMap::new();
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert_eq!(state.open_positions.len(), 0);
        assert!(r.notes.iter().any(|n| n.contains("dailyPeakTrailingStop")));
    }

    #[test]
    fn correlation_filter_blocks_third_long_when_cap_is_two() {
        let mut cfg = cfg_basic();
        cfg.correlation_filter = Some(crate::config::CorrelationFilter {
            max_open_same_direction: 2,
        });
        let mut state = EngineState::initial("x");
        // Pre-load two open longs.
        for n in 0..2 {
            state.open_positions.push(OpenPosition {
                ticket_id: format!("t{n}"),
                symbol: format!("ASSET-{n}"),
                source_symbol: format!("ASSET{n}USDT"),
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
            });
        }
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert_eq!(state.open_positions.len(), 2, "third long blocked");
        assert!(r
            .skipped
            .iter()
            .any(|s| s.reason.contains("correlationFilter")));
    }

    #[test]
    fn daily_equity_guardian_force_closes_at_trigger() {
        let mut cfg = cfg_basic();
        cfg.daily_equity_guardian = Some(crate::config::DailyEquityGuardian { trigger_pct: 0.02 });
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        state.day_start = 1.0;
        // Open a long position that will be deeply underwater (raw -10% × 2 lev × 0.4 = -0.08 unrealised).
        state.open_positions.push(OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: 100.0,
            initial_stop_pct: 0.05,
            stop_price: 95.0, // wide enough so SL doesn't fire on the test bar
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
        });
        let mut candles = HashMap::new();
        // Close at 96 → unrealised raw=-4%, eff=-0.032 → MTM = 0.968 → day_pnl=-3.2% < -2%.
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 97.0, 97.5, 95.5, 96.0)],
        );
        let atr = HashMap::new();
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert!(
            state.open_positions.is_empty(),
            "guardian should force-close"
        );
        assert!(r.notes.iter().any(|n| n.contains("dailyEquityGuardian")));
        // Equity must be below 1.0 (loss locked in).
        assert!(state.equity < 1.0);
    }

    #[test]
    fn daily_equity_guardian_halts_new_entries_then_clears_at_rollover() {
        let mut cfg = cfg_basic();
        // Give DL headroom so the guardian's realised -2.4% close survives the
        // hard floor, and silence the other entry gates so the only blocker we
        // assert on is the guardian latch.
        cfg.max_daily_loss = 0.05;
        cfg.daily_peak_trailing_stop = None;
        cfg.challenge_peak_trailing_stop = None;
        cfg.intraday_daily_loss_throttle = None;
        cfg.daily_equity_guardian = Some(crate::config::DailyEquityGuardian { trigger_pct: 0.02 });
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        state.day_start = 1.0;
        // Underwater long → -2.4% MTM (raw -3% × lev2 × risk0.4) → guardian
        // fires (<= -2%) but realises ABOVE the -5% hard DL floor.
        state.open_positions.push(OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
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
            trail_active: false,
            trail_peak: 0.0,
        });
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 98.0, 98.5, 96.5, 97.0)],
        );
        let atr = HashMap::new();
        // Fresh buy signal arriving on the SAME bar the guardian fires — must be
        // parked, not opened, because the soft-stop halts the rest of the day.
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 97.0,
            stop_price: 95.0,
            tp_price: 101.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert!(
            state.guardian_halted,
            "latch should arm when guardian fires"
        );
        assert!(
            state.open_positions.is_empty(),
            "force-close closed the old long AND blocked the new entry"
        );
        assert!(
            r.skipped
                .iter()
                .any(|s| s.reason.contains("dailyEquityGuardian: halted for day")),
            "new entry must be skipped with the halt reason"
        );

        // Next trading day → rollover clears the latch.
        let next_day_ts = 1_000 + 2 * 86_400_000_i64;
        let mut candles2 = HashMap::new();
        candles2.insert(
            "BTCUSDT".into(),
            vec![make_candle(next_day_ts, 100.0, 101.0, 99.0, 100.0)],
        );
        let r2 = step_bar(&mut state, &make_input(&candles2, &atr, vec![]), &cfg);
        assert!(
            !state.guardian_halted,
            "day rollover must release the soft-stop latch"
        );
        assert!(
            !r2.skipped
                .iter()
                .any(|s| s.reason.contains("dailyEquityGuardian")),
            "no halt block on the fresh day"
        );
    }

    // ─── BrightFunded daily-loss floor (daily_loss_eod_hwm) ──────────────
    // mtm = 1 + (price/100 - 1) * leverage(2) * eff_risk(0.4) = 1 + dpct*0.8.
    // The floor is the prev-EoD HWM − mdl, FROZEN for the day but checked
    // INTRADAY (verified against BrightFunded's help-center — NOT an EoD-only
    // rule). max_total_loss 0.80 keeps the TL backstop out of the way.
    fn eod_cfg() -> EngineConfig {
        let mut cfg = cfg_basic();
        cfg.daily_loss_eod_hwm = true;
        cfg.max_daily_loss = 0.05;
        cfg.max_total_loss = 0.80;
        cfg.max_days = 30;
        cfg.daily_peak_trailing_stop = None;
        cfg.challenge_peak_trailing_stop = None;
        cfg.intraday_daily_loss_throttle = None;
        cfg.daily_equity_guardian = None;
        cfg
    }

    fn eod_state() -> EngineState {
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        state.day_start = 1.0;
        state.eod_hwm_floor = 0.95; // day-0 floor = HWM(1.0) − 0.05
        state.open_positions.push(floating_long(100.0, 0.4));
        state
    }

    #[test]
    fn daily_loss_eod_hwm_busts_intraday_below_frozen_floor() {
        // The frozen floor is 0.95. A mid-bar dip to 90 (mtm 0.92 ≤ 0.95) must
        // bust INTRADAY — BrightFunded checks the breach in real time, it is not
        // deferred to the close. (This is exactly what the earlier EoD-only
        // model got wrong and why it overstated the funded rate.)
        let cfg = eod_cfg();
        let mut state = eod_state();
        let atr = HashMap::new();
        let mut c = HashMap::new();
        c.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 99.0, 99.0, 90.0, 90.0)],
        );
        let r = step_bar(&mut state, &make_input(&c, &atr, vec![]), &cfg);
        assert!(
            r.challenge_ended,
            "intraday breach of the frozen floor must bust"
        );
        assert_eq!(state.stopped_reason, Some(StoppedReason::DailyLoss));
    }

    #[test]
    fn daily_loss_eod_hwm_floor_anchors_to_prev_eod_high_water_mark() {
        // Day 0 closes with the long UP at 110 → EoD equity 1.08, realised 1.0.
        // At the day-1 rollover the floor must anchor to max(1.0, 1.08) − 0.05
        // = 1.03 (includes the open profit), NOT the day-start × 0.95 = 0.95
        // that FTMO would use. Demonstrates the HWM anchor.
        let cfg = eod_cfg();
        let mut state = eod_state();
        let atr = HashMap::new();
        let mut c0 = HashMap::new();
        c0.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 110.0, 100.0, 110.0)],
        );
        let r0 = step_bar(&mut state, &make_input(&c0, &atr, vec![]), &cfg);
        assert!(!r0.challenge_ended);
        let mut c1 = HashMap::new();
        c1.insert(
            "BTCUSDT".into(),
            vec![make_candle(
                1_000 + 2 * 86_400_000,
                110.0,
                111.0,
                110.0,
                110.0,
            )],
        );
        let _ = step_bar(&mut state, &make_input(&c1, &atr, vec![]), &cfg);
        assert!(
            (state.eod_hwm_floor - 1.03).abs() < 1e-9,
            "floor anchors to prev-EoD HWM, got {}",
            state.eod_hwm_floor
        );
    }

    #[test]
    fn ftmo_intraday_mode_busts_on_dip_unchanged() {
        // Default (no daily_loss_eod_hwm) keeps FTMO's day-start floor, checked
        // intraday — the same -5% dip busts on the bar it happens.
        let mut cfg = eod_cfg();
        cfg.daily_loss_eod_hwm = false;
        let mut state = eod_state();
        let atr = HashMap::new();
        let mut c1 = HashMap::new();
        c1.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 99.0, 99.0, 90.0, 90.0)],
        );
        let r1 = step_bar(&mut state, &make_input(&c1, &atr, vec![]), &cfg);
        assert!(
            r1.challenge_ended,
            "FTMO intraday mode busts on the dip bar"
        );
        assert_eq!(state.stopped_reason, Some(StoppedReason::DailyLoss));
    }

    // ─── Intra-bar drawdown check (intrabar_dd_check) ────────────────────
    #[test]
    fn intrabar_dd_check_busts_on_intra_bar_low_through_total_floor() {
        // TL floor 0.90. A bar dips to 85 intra-bar (stress mtm ~0.88 < 0.90)
        // but closes at 95 (mtm ~0.96 > 0.90). Close-only would survive; the
        // intra-bar check must bust on the low.
        let mut cfg = cfg_basic();
        cfg.intrabar_dd_check = true;
        cfg.max_total_loss = 0.10;
        cfg.max_daily_loss = 0.50; // keep the daily rule out of the way
        cfg.daily_peak_trailing_stop = None;
        cfg.challenge_peak_trailing_stop = None;
        cfg.intraday_daily_loss_throttle = None;
        cfg.daily_equity_guardian = None;
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        state.day_start = 1.0;
        state.open_positions.push(floating_long(100.0, 0.4));
        let atr = HashMap::new();
        let mut c = HashMap::new();
        c.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 95.0, 96.0, 85.0, 95.0)],
        );
        let r = step_bar(&mut state, &make_input(&c, &atr, vec![]), &cfg);
        assert!(
            r.challenge_ended,
            "intra-bar low through the total floor must bust"
        );
        assert_eq!(state.stopped_reason, Some(StoppedReason::TotalLoss));
    }

    #[test]
    fn close_only_dd_survives_intra_bar_low_when_flag_off() {
        // Same bar, default (intrabar_dd_check = false): close-based check only
        // → survives. Documents that the fix is opt-in and FTMO parity holds.
        let mut cfg = cfg_basic();
        cfg.intrabar_dd_check = false;
        cfg.max_total_loss = 0.10;
        cfg.max_daily_loss = 0.50;
        cfg.daily_peak_trailing_stop = None;
        cfg.challenge_peak_trailing_stop = None;
        cfg.intraday_daily_loss_throttle = None;
        cfg.daily_equity_guardian = None;
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        state.day_start = 1.0;
        state.open_positions.push(floating_long(100.0, 0.4));
        let atr = HashMap::new();
        let mut c = HashMap::new();
        c.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 95.0, 96.0, 85.0, 95.0)],
        );
        let r = step_bar(&mut state, &make_input(&c, &atr, vec![]), &cfg);
        assert!(
            !r.challenge_ended,
            "close-only mode survives the intra-bar dip"
        );
    }

    #[test]
    fn reentry_after_stop_bypasses_cooldown_and_scales_size() {
        let mut cfg = cfg_basic();
        cfg.loss_streak_cooldown = Some(crate::config::LossStreakCooldown {
            after_losses: 1,
            cooldown_bars: 100,
        });
        cfg.reentry_after_stop = Some(crate::config::ReentryAfterStop {
            size_mult: 0.5,
            within_bars: 5,
        });
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        // Pre-load: position exits as stop on bar 1 → reentry slot installed,
        // cooldown armed.
        state.open_positions.push(OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
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
            trail_active: false,
            trail_peak: 0.0,
        });
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 99.5, 99.9, 98.5, 98.7)],
        ); // stop crosses
        let atr = HashMap::new();
        let _ = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert_eq!(state.closed_trades.len(), 1);
        assert_eq!(state.closed_trades[0].exit_reason, ExitReason::Stop);
        let key = ls_key("BTC-TREND", PositionSide::Long);
        assert!(state.pending_reentries.contains_key(&key));
        assert!(
            state
                .loss_streak_by_asset_dir
                .get(&key)
                .unwrap()
                .cd_until_bars_seen
                > state.bars_seen
        );

        // Bar 2 — fresh signal arrives. Cooldown active but reentry slot present.
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 99.0, 100.0, 98.0, 99.5));
        let sig = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_001,
            entry_price: 99.5,
            stop_price: 97.5,
            tp_price: 103.5,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let _ = step_bar(&mut state, &make_input(&candles, &atr, vec![sig]), &cfg);
        assert_eq!(
            state.open_positions.len(),
            1,
            "reentry should bypass cooldown"
        );
        // eff_risk scaled: 0.4 × 0.5 = 0.2.
        assert!((state.open_positions[0].eff_risk - 0.2).abs() < 1e-9);
        // Slot consumed.
        assert!(!state.pending_reentries.contains_key(&key));
    }

    #[test]
    fn passlock_force_closes_all_on_target_hit() {
        let mut cfg = cfg_basic();
        cfg.profit_target = 0.02;
        cfg.close_all_on_target_reached = true;
        cfg.min_trading_days = 1;
        let mut state = EngineState::initial("x");
        state.trading_days.push(0); // day 0 already counted

        // Open a profitable long position manually.
        state.open_positions.push(OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: 100.0,
            initial_stop_pct: 0.02,
            stop_price: 98.0,
            tp_price: 110.0, // far away — won't fire in exit-check
            eff_risk: 0.5,
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
        });
        // Equity already at exactly target after the position closes: realised=1.0,
        // unrealised at +3% gives MTM = 1.03 (won't trigger realised target, but
        // we manually set state.equity below the threshold so target only trips
        // after force-close gives realised PnL).
        state.equity = 1.0;
        // Bar shows price at 103 (3% gain) — neither stop nor TP cross.
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 102.5, 103.5, 102.0, 103.0)],
        );
        let atr = HashMap::new();
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        // No exit from process_position_exit (no SL/TP cross), so target check
        // operates on REALISED equity 1.0 < 1.02. Not yet hit.
        assert!(!r.target_hit);
        // Now manually move price past TP path to validate force-close behaviour
        // by setting target lower: re-run with profit_target ≤ 0.
        let mut cfg2 = cfg.clone();
        cfg2.profit_target = -0.10; // already past
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 103.0, 103.5, 102.5, 103.0));
        let r2 = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg2);
        assert!(r2.target_hit);
        assert!(r2.passed);
        // PASSLOCK closed the open position.
        assert!(state.open_positions.is_empty());
    }

    // ========================================================================
    // 2026-05-23 Wave2 behavior tests for regime_flip_close_opposite +
    // mutex_long_short. Audit a6e53c2 found ZERO behavioral coverage — only
    // 2 "defaults-off" tests existed. These six tests cover the core
    // contracts so a future template re-enabling either flag has guard rails.
    // ========================================================================

    fn cfg_with_cross_asset(symbol: &str) -> EngineConfig {
        let mut c = cfg_basic();
        c.cross_asset_filter = Some(crate::config::CrossAssetFilter {
            symbol: symbol.into(),
            direction: "any".into(),
            fast_period: 3,
            slow_period: 6,
            skip_longs_if_secondary_downtrend: false,
            skip_shorts_if_secondary_uptrend: false,
            inverse_correlation: false,
        });
        c
    }

    fn long_sig() -> PollSignal {
        PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.1,
            chandelier_atr_at_entry: None,
        }
    }

    fn short_sig() -> PollSignal {
        PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Short,
            entry_time: 1_000,
            entry_price: 100.0,
            stop_price: 102.0,
            tp_price: 96.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.1,
            chandelier_atr_at_entry: None,
        }
    }

    /// Build a long-stable cross-asset feed: monotone-up closes with enough
    /// history that the fast/slow EMAs are warmed AND `c > f > s` holds for
    /// the lookback window.
    fn build_uptrend_feed(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let p = 100.0 + i as f64 * 1.0;
                make_candle(1_000 + i as i64, p, p + 0.5, p - 0.5, p)
            })
            .collect()
    }

    fn build_downtrend_feed(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let p = 200.0 - i as f64 * 1.0;
                make_candle(1_000 + i as i64, p, p + 0.5, p - 0.5, p)
            })
            .collect()
    }

    #[test]
    fn regime_flip_flag_defaults_off_is_noop() {
        // Even with positions open and a clear opposite trend, no flip-close
        // should fire because cfg.regime_flip_close_opposite defaults to false.
        // Open the position via a normal signal then advance bars with an
        // opposite cross-asset trend — defaults-off must keep position alive.
        let mut cfg = cfg_with_cross_asset("DXY");
        cfg.max_concurrent_trades = Some(5);
        assert!(!cfg.regime_flip_close_opposite);
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        // Bar 1 — open the long.
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        candles.insert("DXY".into(), build_uptrend_feed(40));
        let atr = HashMap::new();
        step_bar(
            &mut state,
            &make_input(&candles, &atr, vec![long_sig()]),
            &cfg,
        );
        assert_eq!(state.open_positions.len(), 1);
        // Bar 2 — DXY flips to clear downtrend.
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 100.0, 101.0, 99.0, 100.0));
        candles.insert("DXY".into(), build_downtrend_feed(40));
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert_eq!(
            state.open_positions.len(),
            1,
            "flag off → position kept across trend flip"
        );
        assert!(!r.challenge_ended);
    }

    #[test]
    fn mutex_long_short_flag_defaults_off_allows_opposite() {
        // With mutex off + long open, a short entry MUST still be allowed.
        let cfg = cfg_basic();
        assert!(!cfg.mutex_long_short);
        let mut state = EngineState::initial("x");
        // Open a long position first via signal.
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        step_bar(
            &mut state,
            &make_input(&candles, &atr, vec![long_sig()]),
            &cfg,
        );
        assert_eq!(state.open_positions.len(), 1);
        // Bar 2 — fire a short signal.
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 100.0, 101.0, 99.0, 100.0));
        let mut short = short_sig();
        short.entry_time = 1_001;
        let r2 = step_bar(&mut state, &make_input(&candles, &atr, vec![short]), &cfg);
        assert_eq!(
            r2.decision.opens.len(),
            1,
            "mutex off → opposite-side entry allowed"
        );
        assert_eq!(state.open_positions.len(), 2);
    }

    #[test]
    fn mutex_blocks_opposite_direction_entry() {
        let mut cfg = cfg_basic();
        cfg.mutex_long_short = true;
        cfg.max_concurrent_trades = Some(5);
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        // Bar 1 — open long.
        step_bar(
            &mut state,
            &make_input(&candles, &atr, vec![long_sig()]),
            &cfg,
        );
        assert_eq!(state.open_positions.len(), 1);
        // Bar 2 — short signal must be BLOCKED.
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 100.0, 101.0, 99.0, 100.0));
        let mut short = short_sig();
        short.entry_time = 1_001;
        let r2 = step_bar(&mut state, &make_input(&candles, &atr, vec![short]), &cfg);
        assert_eq!(
            r2.decision.opens.len(),
            0,
            "mutex on → short blocked while long open"
        );
        assert_eq!(state.open_positions.len(), 1);
        // Skip surfaces on result.skipped (BarStepResult.skipped, not PollDecision).
        let skipped_for_mutex = r2.skipped.iter().any(|s| s.reason.contains("mutex"));
        assert!(
            skipped_for_mutex,
            "skip reason should mention mutex: {:?}",
            r2.skipped
        );
    }

    #[test]
    fn mutex_allows_same_direction_different_asset() {
        // Mutex must NOT block a SECOND long on a DIFFERENT asset while
        // the first long is open (engine separately enforces same-asset
        // trade-exclusivity, so we test mutex-vs-multi-asset here).
        let mut cfg = cfg_basic();
        cfg.mutex_long_short = true;
        cfg.max_concurrent_trades = Some(5);
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        candles.insert(
            "ETHUSDT".into(),
            vec![make_candle(1_000, 200.0, 202.0, 198.0, 200.0)],
        );
        let atr = HashMap::new();
        // Bar 1 — open long BTC.
        step_bar(
            &mut state,
            &make_input(&candles, &atr, vec![long_sig()]),
            &cfg,
        );
        assert_eq!(state.open_positions.len(), 1);
        // Bar 2 — long ETH signal must fire (same direction, different asset).
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 100.0, 101.0, 99.0, 100.0));
        candles
            .get_mut("ETHUSDT")
            .unwrap()
            .push(make_candle(1_001, 200.0, 202.0, 198.0, 200.0));
        let eth_long = PollSignal {
            symbol: "ETH-TREND".into(),
            source_symbol: "ETHUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_001,
            entry_price: 200.0,
            stop_price: 196.0,
            tp_price: 208.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.1,
            chandelier_atr_at_entry: None,
        };
        let r2 = step_bar(
            &mut state,
            &make_input(&candles, &atr, vec![eth_long]),
            &cfg,
        );
        assert_eq!(
            r2.decision.opens.len(),
            1,
            "mutex must NOT block same-direction on different asset"
        );
        assert_eq!(state.open_positions.len(), 2);
    }

    #[test]
    fn mutex_unblocks_after_position_closes() {
        let mut cfg = cfg_basic();
        cfg.mutex_long_short = true;
        cfg.max_concurrent_trades = Some(5);
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        // Bar 1 — open long.
        step_bar(
            &mut state,
            &make_input(&candles, &atr, vec![long_sig()]),
            &cfg,
        );
        // Bar 2 — long stops out (price gap-down through 98 stop).
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 100.0, 100.5, 97.0, 97.5));
        step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert_eq!(state.open_positions.len(), 0, "long stopped");
        // Bar 3 — short signal must NOW be allowed.
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_002, 97.5, 98.0, 96.5, 97.0));
        let mut short = short_sig();
        short.entry_time = 1_002;
        short.entry_price = 97.0;
        short.stop_price = 99.0;
        short.tp_price = 93.0;
        let r3 = step_bar(&mut state, &make_input(&candles, &atr, vec![short]), &cfg);
        assert_eq!(
            r3.decision.opens.len(),
            1,
            "mutex re-allows opposite after close"
        );
        assert_eq!(state.open_positions.len(), 1);
    }

    #[test]
    fn regime_flip_and_mutex_are_orthogonal_when_both_off() {
        // Sanity: both flags default off + position open + opposite signal →
        // signal is allowed, position is kept. Both branches must be dormant.
        let cfg = cfg_basic();
        assert!(!cfg.regime_flip_close_opposite);
        assert!(!cfg.mutex_long_short);
        let mut state = EngineState::initial("x");
        let mut candles = HashMap::new();
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)],
        );
        let atr = HashMap::new();
        step_bar(
            &mut state,
            &make_input(&candles, &atr, vec![long_sig()]),
            &cfg,
        );
        candles
            .get_mut("BTCUSDT")
            .unwrap()
            .push(make_candle(1_001, 100.0, 101.0, 99.0, 100.0));
        let mut short = short_sig();
        short.entry_time = 1_001;
        let r2 = step_bar(&mut state, &make_input(&candles, &atr, vec![short]), &cfg);
        // Long kept (no flip-close) AND short allowed (no mutex).
        assert_eq!(state.open_positions.len(), 2);
        assert_eq!(r2.decision.opens.len(), 1);
    }
}
