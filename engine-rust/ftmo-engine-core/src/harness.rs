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

use std::collections::HashMap;

use crate::candle::Candle;
use crate::config::EngineConfig;
use chrono::{DateTime, Datelike, Timelike, Utc};
use smallvec::SmallVec;

use crate::pnl::{compute_eff_pnl, compute_mtm_equity, trim_inline};
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
pub fn step_bar(
    state: &mut EngineState,
    input: &BarInput<'_>,
    cfg: &EngineConfig,
) -> StepResult {
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
            min_last_bar = Some(min_last_bar.map_or(last.open_time, |v: i64| v.min(last.open_time)));
            max_last_bar = Some(max_last_bar.map_or(last.open_time, |v: i64| v.max(last.open_time)));
        }
    }
    let Some(last_bar_time) = min_last_bar else {
        result.notes.push("no candles".into());
        return result;
    };
    if let (Some(min), Some(max)) = (min_last_bar, max_last_bar) {
        if min != max {
            result.notes.push(format!("assets misaligned ({min}…{max}) — using min"));
        }
    }

    // First-call: anchor challenge start.
    if state.challenge_start_ts == 0 {
        state.challenge_start_ts = cfg.challenge_start_ts.unwrap_or(last_bar_time);
        state.last_bar_open_time = last_bar_time;
        state.day_start = state.equity;
        state.day_peak = state.mtm_equity.max(1.0);
        state.challenge_peak = state.mtm_equity.max(1.0);
    }

    // Idempotent retry guard.
    if last_bar_time <= state.last_bar_open_time && state.bars_seen > 0 {
        result.notes.push("bar already processed".into());
        return result;
    }

    // 2. Day-rollover.
    let new_day = day_index(last_bar_time, state.challenge_start_ts) as i64;
    let cur_day = state.day as i64;
    if new_day < cur_day {
        result
            .notes
            .push(format!("time regression: newDay={new_day} state.day={cur_day} — keeping anchors"));
    } else if new_day > cur_day {
        state.day = new_day as u32;
        state.day_start = state.equity;
        state.day_peak = state.equity;
    }

    // 3. Force-close at max_days.
    if new_day >= cfg.max_days as i64 {
        force_close_all(state, input, cfg, last_bar_time, &mut result);
        result.challenge_ended = true;
        let target_hit = state.first_target_hit_day.is_some()
            && state.trading_days.len() >= cfg.min_trading_days as usize;
        let final_equity_floor = 1.0 + cfg.profit_target * 0.5;
        let give_back_too_far =
            target_hit && state.equity.is_finite() && state.equity < final_equity_floor;
        result.passed = target_hit && !give_back_too_far;
        if !result.passed && result.fail_reason.is_none() {
            // give_back surfaces as plain Time at the end-of-window check
            // (mirror SimulateResult mapping in the TS engine).
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
                let raw_pnl = match pos.direction {
                    crate::position::PositionSide::Long => (price - pos.entry_price) / pos.entry_price,
                    crate::position::PositionSide::Short => (pos.entry_price - price) / pos.entry_price,
                };
                let unrealised = (raw_pnl * cfg.leverage * pos.eff_risk)
                    .max(crate::pnl::GAP_TAIL_MULT * pos.eff_risk);
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
                        crate::exit::ExitOutcome { exit_price, reason: ExitReason::Manual },
                    ));
                }
                apply_exits(state, &mut closes, cfg, last_bar_time, &mut result);
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
        let atr_at_bar = input
            .atr_series_by_source
            .get(&pos.source_symbol)
            .and_then(|series| {
                let bar_idx = arr.iter().position(|c| c.open_time == last_bar_time)?;
                series.get(bar_idx).copied().flatten()
            });
        let candle = *candle;
        let bars_held = state.bars_seen.saturating_sub(pos.entry_bar_idx);
        if let Some(out) = crate::exit::process_position_exit_with_held(
            pos, &candle, cfg, atr_at_bar, bars_held,
        ) {
            exits.push((idx, out));
        }
    }
    apply_exits(state, &mut exits, cfg, last_bar_time, &mut result);

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
    let total_loss_floor = 1.0 - cfg.max_total_loss;
    let daily_loss_floor = state.day_start * (1.0 - cfg.max_daily_loss);
    if state.equity <= total_loss_floor {
        state.stopped_reason = Some(StoppedReason::TotalLoss);
        result.fail_reason = Some(FailReason::TotalLoss);
        result.challenge_ended = true;
        bookkeep(state, last_bar_time, cfg);
        return result;
    }
    if state.equity <= daily_loss_floor {
        state.stopped_reason = Some(StoppedReason::DailyLoss);
        result.fail_reason = Some(FailReason::DailyLoss);
        result.challenge_ended = true;
        bookkeep(state, last_bar_time, cfg);
        return result;
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
    if state.equity >= 1.0 + cfg.profit_target
        && state.mtm_equity >= 1.0 + cfg.profit_target
        && state.first_target_hit_day.is_none()
    {
        result.target_hit = true;
        state.first_target_hit_day = Some(state.day);
        // 7. Pause-after-target latch.
        if cfg.pause_at_target_reached {
            state.paused_at_target = true;
        }
        // 8. R60 close-all-on-target.
        if cfg.close_all_on_target_reached && !state.open_positions.is_empty() {
            // Close every remaining position at last bar's close.
            let mut to_close: Vec<(usize, crate::exit::ExitOutcome)> = vec![];
            for (idx, pos) in state.open_positions.iter().enumerate() {
                let exit_price = input
                    .candles_by_source
                    .get(&pos.source_symbol)
                    .and_then(|arr| find_candle_at_time(arr, last_bar_time))
                    .map(|c| c.close)
                    .or(pos.last_known_price)
                    .unwrap_or(pos.entry_price);
                to_close.push((
                    idx,
                    crate::exit::ExitOutcome { exit_price, reason: ExitReason::Manual },
                ));
            }
            apply_exits(state, &mut to_close, cfg, last_bar_time, &mut result);
            // R67 audit fix: refresh mtm_equity to match realised after
            // close-all. Without this, state.mtm_equity retained the stale
            // pre-close value (from step 4) which could diverge from
            // state.equity if close_price ≠ tp_price. Subsequent same-bar
            // standalone-pass-checks reading mtm_equity would be wrong.
            state.mtm_equity = state.equity;
        }
        // FTMO pass: target hit AND minTradingDays satisfied.
        if state.trading_days.len() >= cfg.min_trading_days as usize {
            result.passed = true;
            result.challenge_ended = true;
            bookkeep(state, last_bar_time, cfg);
            return result;
        }
    }

    // Standalone pass-check (TS line 1510) — fires every bar so a paused-
    // after-target run can pass once ping-day accumulation catches
    // trading_days up to min_trading_days.
    if state.equity >= 1.0 + cfg.profit_target
        && state.mtm_equity >= 1.0 + cfg.profit_target
        && state.trading_days.len() >= cfg.min_trading_days as usize
    {
        result.target_hit = true;
        result.passed = true;
        result.challenge_ended = true;
        state.stopped_reason = None;
        bookkeep(state, last_bar_time, cfg);
        return result;
    }

    // 7. Entry-side gates that block ALL new entries this bar.
    let mut entries_allowed = !state.paused_at_target;
    if entries_allowed {
        if let Some(dpts) = cfg.daily_peak_trailing_stop {
            let drop = (state.day_peak - state.mtm_equity) / state.day_peak.max(1e-9);
            if drop >= dpts.trail_distance {
                entries_allowed = false;
                result.notes.push(format!(
                    "dailyPeakTrailingStop: drop {:.2}% >= {:.2}%",
                    drop * 100.0,
                    dpts.trail_distance * 100.0
                ));
            }
        }
    }
    if entries_allowed {
        if let Some(cpts) = cfg.challenge_peak_trailing_stop {
            let drop = (state.challenge_peak - state.mtm_equity)
                / state.challenge_peak.max(1e-9);
            if drop >= cpts.trail_distance {
                entries_allowed = false;
                result
                    .notes
                    .push(format!("challengePeakTrailingStop: drop {:.2}%", drop * 100.0));
            }
        }
    }
    if entries_allowed {
        if let Some(idl) = cfg.intraday_daily_loss_throttle {
            if state.day_start > 0.0 {
                let day_pnl = (state.equity - state.day_start) / state.day_start;
                if day_pnl <= -idl.hard_loss_threshold {
                    entries_allowed = false;
                    result.notes.push(format!(
                        "intradayDailyLossThrottle hard: {:.2}%",
                        day_pnl * 100.0
                    ));
                }
            }
        }
    }

    // 7b. Bar-level time gates (allowed hours / dows).
    if entries_allowed {
        if let Some(hours) = cfg.allowed_hours_utc.as_ref() {
            if let Some(dt) = DateTime::<Utc>::from_timestamp_millis(last_bar_time) {
                if !hours.contains(&dt.hour()) {
                    entries_allowed = false;
                    result.notes.push(format!("hour-gate: {} not in allowed_hours_utc", dt.hour()));
                }
            }
        }
    }
    if entries_allowed {
        if let Some(dows) = cfg.allowed_dows_utc.as_ref() {
            if let Some(dt) = DateTime::<Utc>::from_timestamp_millis(last_bar_time) {
                let dow = dt.weekday().num_days_from_sunday();
                if !dows.contains(&dow) {
                    entries_allowed = false;
                    result.notes.push(format!("dow-gate: {dow} not in allowed_dows_utc"));
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
            // Determine which gate caused the block. The most recent note tells us.
            let reason = result
                .notes
                .last()
                .cloned()
                .unwrap_or_else(|| "entries_allowed=false".into());
            result.skipped.push(crate::signal::PollSkip {
                asset: sig.symbol.clone(),
                reason: format!("bar-gate: {reason}"),
            });
        }
    }
    if entries_allowed {
        let max_concurrent = cfg.max_concurrent_trades.unwrap_or(u32::MAX) as usize;
        for sig in &input.signals {
            // Per-asset activation gates.
            if let Some(asset_cfg) = cfg.assets.iter().find(|a| a.symbol == sig.symbol) {
                if let Some(after) = asset_cfg.activate_after_day {
                    if state.day < after {
                        result.skipped.push(crate::signal::PollSkip {
                            asset: sig.symbol.clone(),
                            reason: format!("activate_after_day: day {} < {}", state.day, after),
                        });
                        continue;
                    }
                }
                let eq_pct = state.equity - 1.0;
                if let Some(min_g) = asset_cfg.min_equity_gain {
                    if eq_pct < min_g {
                        result.skipped.push(crate::signal::PollSkip {
                            asset: sig.symbol.clone(),
                            reason: format!("min_equity_gain {min_g:.4} > {eq_pct:.4}"),
                        });
                        continue;
                    }
                }
                if let Some(max_g) = asset_cfg.max_equity_gain {
                    if eq_pct > max_g {
                        result.skipped.push(crate::signal::PollSkip {
                            asset: sig.symbol.clone(),
                            reason: format!("max_equity_gain {max_g:.4} < {eq_pct:.4}"),
                        });
                        continue;
                    }
                }
            }
            // CrossAssetFilter — only allow when reference symbol's trend matches.
            if let Some(filter) = cfg.cross_asset_filter.as_ref() {
                let cross_closes: Vec<f64> = input
                    .candles_by_source
                    .get(&filter.symbol)
                    .map(|arr| arr.iter().map(|c| c.close).collect())
                    .unwrap_or_default();
                if !crate::detector_filters::cross_asset_filter_allows(
                    filter,
                    sig.direction,
                    &cross_closes,
                ) {
                    result.skipped.push(crate::signal::PollSkip {
                        asset: sig.symbol.clone(),
                        reason: format!("crossAssetFilter[{}] blocks {:?}", filter.symbol, sig.direction),
                    });
                    continue;
                }
            }
            if let Some(extra) = cfg.cross_asset_filters_extra.as_ref() {
                let mut blocked = false;
                for filter in extra {
                    let cross_closes: Vec<f64> = input
                        .candles_by_source
                        .get(&filter.symbol)
                        .map(|arr| arr.iter().map(|c| c.close).collect())
                        .unwrap_or_default();
                    if !crate::detector_filters::cross_asset_filter_allows(
                        filter,
                        sig.direction,
                        &cross_closes,
                    ) {
                        result.skipped.push(crate::signal::PollSkip {
                            asset: sig.symbol.clone(),
                            reason: format!(
                                "crossAssetFiltersExtra[{}] blocks {:?}",
                                filter.symbol, sig.direction
                            ),
                        });
                        blocked = true;
                        break;
                    }
                }
                if blocked {
                    continue;
                }
            }

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
                        result.skipped.push(crate::signal::PollSkip {
                            asset: sig.symbol.clone(),
                            reason: format!(
                                "lossStreakCooldown until barsSeen={}",
                                ls.cd_until_bars_seen
                            ),
                        });
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
                    result.skipped.push(crate::signal::PollSkip {
                        asset: sig.symbol.clone(),
                        reason: format!("correlationFilter {same_dir} same-dir open"),
                    });
                    continue;
                }
            }
            // MaxConcurrentTrades cap (re-checked per signal so mid-bar opens
            // correctly bump the count for subsequent matches).
            if state.open_positions.len() >= max_concurrent {
                result.skipped.push(crate::signal::PollSkip {
                    asset: sig.symbol.clone(),
                    reason: "MCT cap mid-bar".into(),
                });
                continue;
            }
            // Day-tracking — entry date counts toward minTradingDays.
            if !state.trading_days.contains(&state.day) {
                state.trading_days.push(state.day);
            }
            let final_eff_risk = match reentry_scale {
                Some(m) => sig.eff_risk * m,
                None => sig.eff_risk,
            };
            // Consume the re-entry slot now that we're opening.
            if reentry_scale.is_some() {
                state.pending_reentries.remove(&key);
            }
            let pos = OpenPosition {
                ticket_id: OpenPosition::make_ticket_id(sig.entry_time, &sig.symbol),
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
) {
    // Process highest-index first so removals don't shift indices for later
    // entries.
    exits.sort_by(|a, b| b.0.cmp(&a.0));
    for (idx, out) in exits.drain(..) {
        let pos = state.open_positions.remove(idx);
        let pnl = compute_eff_pnl(&pos, out.exit_price, cfg);
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
            .or_insert(LossStreakEntry { streak: 0, cd_until_bars_seen: 0 });
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
            state.kelly_pnls.push(KellyPnl { close_time: last_bar_time, eff_pnl: pnl.eff_pnl });
        }
        state.closed_trades.push(trade.clone());
        result.decision.closes.push(CloseIntent {
            ticket_id: pos.ticket_id,
            exit_price: out.exit_price,
            exit_reason: out.reason,
        });
    }
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
            crate::exit::ExitOutcome { exit_price, reason: ExitReason::Manual },
        ));
    }
    apply_exits(state, &mut closes, cfg, last_bar_time, result);
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
            signals,
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
        candles.insert("BTCUSDT".to_string(), vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)]);
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
        candles.insert("BTCUSDT".into(), vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)]);
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
        candles.insert("BTCUSDT".into(), vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)]);
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
            crate::state::LossStreakEntry { streak: 1, cd_until_bars_seen: 100 },
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
        assert!(r.skipped.iter().any(|s| s.reason.contains("lossStreakCooldown")));
    }

    #[test]
    fn hour_gate_blocks_outside_window() {
        let mut cfg = cfg_basic();
        cfg.allowed_hours_utc = Some(vec![10, 11, 12]); // bar at 1000ms is hour 0
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        let mut candles = HashMap::new();
        candles.insert("BTCUSDT".into(), vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)]);
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
        }];
        let mut state = EngineState::initial("x");
        state.challenge_start_ts = 1;
        state.last_bar_open_time = 0;
        state.day = 1; // < 3
        let mut candles = HashMap::new();
        candles.insert("BTCUSDT".into(), vec![make_candle(1_000, 100.0, 101.0, 99.0, 100.0)]);
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
        assert!(r.skipped.iter().any(|s| s.reason.contains("activate_after_day")));
    }

    #[test]
    fn daily_peak_trailing_stop_blocks_entries() {
        let mut cfg = cfg_basic();
        cfg.daily_peak_trailing_stop = Some(crate::config::PeakTrailingStop { trail_distance: 0.02 });
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
        assert!(r.skipped.iter().any(|s| s.reason.contains("correlationFilter")));
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
        });
        let mut candles = HashMap::new();
        // Close at 96 → unrealised raw=-4%, eff=-0.032 → MTM = 0.968 → day_pnl=-3.2% < -2%.
        candles.insert(
            "BTCUSDT".into(),
            vec![make_candle(1_000, 97.0, 97.5, 95.5, 96.0)],
        );
        let atr = HashMap::new();
        let r = step_bar(&mut state, &make_input(&candles, &atr, vec![]), &cfg);
        assert!(state.open_positions.is_empty(), "guardian should force-close");
        assert!(r.notes.iter().any(|n| n.contains("dailyEquityGuardian")));
        // Equity must be below 1.0 (loss locked in).
        assert!(state.equity < 1.0);
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
        assert!(state.loss_streak_by_asset_dir.get(&key).unwrap().cd_until_bars_seen > state.bars_seen);

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
        assert_eq!(state.open_positions.len(), 1, "reentry should bypass cooldown");
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
}
