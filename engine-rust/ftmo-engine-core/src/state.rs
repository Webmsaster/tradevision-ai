//! V4 engine state — port of `FtmoLiveStateV4` from `ftmoLiveEngineV4.ts`.
//!
//! State is intentionally serialisable with camelCase field names so the
//! Rust engine can read / write the same `v4-engine.json` files the
//! TypeScript engine produces. (2026-05-16 Round 9-Final FIX: Python
//! executor does NOT consume `v4-engine.json` — that was a stale comment.
//! Python ↔ TS bridges via `open-positions.json`, `pending-signals.json`,
//! `executed-signals.json`, `challenge-peak.json`, `pause-state.json` —
//! each owned by separate writer/reader pairs.)
//!
//! Schema version 3 (Round 57 V4-3):
//! - v1 → v2: `lossStreakByAssetDir.cdUntilBarIdx` → `cdUntilBarsSeen` rename
//! - v2 → v3: `entryBarIdx` rebased on monotonic `bars_seen` instead of
//!            `refCandles.length-1` (which shifted on refKey changes).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::position::OpenPosition;
use crate::trade::ClosedTrade;

pub const SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoppedReason {
    TotalLoss,
    DailyLoss,
    Time,
    /// 2026-05-19 Damage-Limitation Early-Abort: window aborted by the
    /// `--early-abort-after-losses N` or `--early-abort-after-trades N
    /// --early-abort-min-cum X` CLI rules. Surfaces as a normal stop so the
    /// pass-rate counter treats the window as a fail, but every remaining
    /// open position is force-closed so the equity tail no longer accrues
    /// further losses (motivation: 0/31 = 0% pass-rate on windows with 2
    /// initial losers — saving the give-back is pure equity preservation).
    EarlyAbort,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LossStreakEntry {
    pub streak: u32,
    #[serde(rename = "cdUntilBarsSeen")]
    pub cd_until_bars_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KellyPnl {
    #[serde(rename = "closeTime")]
    pub close_time: i64,
    #[serde(rename = "effPnl")]
    pub eff_pnl: f64,
}

/// Re-entry slot opened by a stop-loss exit. Consumed by the next matching
/// signal within `within_bars`. Tracks original sizing so the re-entry can
/// scale it by `cfg.reentry_after_stop.size_mult`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReentryState {
    #[serde(rename = "barsSeenAtStop")]
    pub bars_seen_at_stop: u64,
    #[serde(rename = "originalEffRisk")]
    pub original_eff_risk: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineState {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "cfgLabel")]
    pub cfg_label: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    /// `openTime` of the latest bar processed.
    #[serde(rename = "lastBarOpenTime")]
    pub last_bar_open_time: i64,
    /// `openTime` of the FIRST bar processed in this challenge.
    #[serde(rename = "challengeStartTs")]
    pub challenge_start_ts: i64,
    /// Realised-only equity (compounded close PnLs).
    pub equity: f64,
    /// MTM equity = realised + Σ unrealised at last bar.
    #[serde(rename = "mtmEquity")]
    pub mtm_equity: f64,
    /// Current challenge day (0-based, derived from challengeStartTs in Prague TZ).
    pub day: u32,
    /// Realised equity at start of current day (used for daily-loss check).
    #[serde(rename = "dayStart")]
    pub day_start: f64,
    /// Intraday MTM peak.
    #[serde(rename = "dayPeak")]
    pub day_peak: f64,
    /// All-time MTM peak.
    #[serde(rename = "challengePeak")]
    pub challenge_peak: f64,
    #[serde(rename = "openPositions")]
    pub open_positions: Vec<OpenPosition>,
    /// Set of unique entry-days (FTMO minTradingDays counter).
    #[serde(rename = "tradingDays")]
    pub trading_days: Vec<u32>,
    #[serde(rename = "firstTargetHitDay")]
    pub first_target_hit_day: Option<u32>,
    #[serde(rename = "pausedAtTarget")]
    pub paused_at_target: bool,
    #[serde(rename = "lossStreakByAssetDir", default)]
    pub loss_streak_by_asset_dir: HashMap<String, LossStreakEntry>,
    #[serde(rename = "kellyPnls", default)]
    pub kelly_pnls: Vec<KellyPnl>,
    #[serde(
        rename = "kellyTierIdx",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub kelly_tier_idx: Option<usize>,
    /// Detector #49 — persisted Sharpe-tier index for hysteresis (HYST=0.05).
    /// Mirrors `kelly_tier_idx`: `None` = cold start (greedy lookup), `Some(i)`
    /// = last-chosen tier in the descending-`sharpe_above` order. Skipped
    /// during serialization when `None` to keep state-blob small for
    /// pre-Sharpe configs.
    #[serde(
        rename = "sharpeTierIdx",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sharpe_tier_idx: Option<usize>,
    #[serde(rename = "closedTrades", default)]
    pub closed_trades: Vec<ClosedTrade>,
    #[serde(rename = "barsSeen", default)]
    pub bars_seen: u64,
    #[serde(rename = "stoppedReason", default)]
    pub stopped_reason: Option<StoppedReason>,
    /// V5R re-entry slots, keyed by `ls_key(symbol, direction)`.
    #[serde(rename = "pendingReentries", default)]
    pub pending_reentries: HashMap<String, ReentryState>,
    /// 2026-05-19 Pattern-D fix — consecutive stop-loss counter (resets at
    /// day boundary OR after a non-stop exit). When ≥ cfg.max_consec_stops_per_day,
    /// `consec_stops_paused` is set, blocking new entries until next day.
    #[serde(rename = "dayConsecStops", default)]
    pub day_consec_stops: u32,
    #[serde(rename = "consecStopsPaused", default)]
    pub consec_stops_paused: bool,
    /// 2026-05-19 Pattern-C fix — trailing-DD-lock state. Armed when
    /// realized equity reaches `cfg.trail_dd_lock_trigger`. Tracks peak
    /// realized equity post-arm. If equity drops by `trail_dd_lock_floor`
    /// from peak → force-close + halt.
    #[serde(rename = "trailDdArmed", default)]
    pub trail_dd_armed: bool,
    #[serde(rename = "trailDdPeak", default)]
    pub trail_dd_peak: f64,
    /// 2026-05-20 Intra-Window Kill-Switch (Agent 6 design). One-shot flag: set
    /// `true` once the kill-switch hour boundary has been evaluated for this
    /// window so the predicate cannot re-fire on subsequent bars. AND'd
    /// predicate at first bar where `(state.last_bar_open_time -
    /// state.challenge_start_ts) / 3_600_000 >= kill_switch_hour`:
    ///   closed_trades.len() < kill_switch_min_trades
    ///   AND
    ///   (state.equity - 1.0) < kill_switch_min_equity
    /// → force_close_all_external + StoppedReason::EarlyAbort.
    #[serde(rename = "killSwitchEvaluated", default)]
    pub kill_switch_evaluated: bool,
    /// 2026-05-29 DailyEquityGuardian halt latch. Set `true` when the guardian
    /// force-closes all positions at -trigger_pct intraday MTM; blocks NEW
    /// entries until the next day rollover (cleared alongside
    /// `consec_stops_paused`). Without this latch the guardian only converts
    /// the unrealised drawdown into a realised one and lets fresh signals
    /// re-open the same day — so the account can still drift into the -5% hard
    /// DailyLoss the soft-stop was meant to prevent. The latch makes the
    /// guardian an actual intraday soft-stop: once today's loss reaches the
    /// trigger, trading is parked for the rest of the day.
    #[serde(rename = "guardianHalted", default)]
    pub guardian_halted: bool,
}

impl EngineState {
    pub fn initial(cfg_label: impl Into<String>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            cfg_label: cfg_label.into(),
            created_at: 0,
            updated_at: 0,
            last_bar_open_time: 0,
            challenge_start_ts: 0,
            equity: 1.0,
            mtm_equity: 1.0,
            day: 0,
            day_start: 1.0,
            day_peak: 1.0,
            challenge_peak: 1.0,
            open_positions: vec![],
            trading_days: vec![],
            first_target_hit_day: None,
            paused_at_target: false,
            loss_streak_by_asset_dir: HashMap::new(),
            kelly_pnls: vec![],
            kelly_tier_idx: None,
            sharpe_tier_idx: None,
            closed_trades: vec![],
            bars_seen: 0,
            stopped_reason: None,
            pending_reentries: HashMap::new(),
            day_consec_stops: 0,
            consec_stops_paused: false,
            trail_dd_armed: false,
            trail_dd_peak: 0.0,
            kill_switch_evaluated: false,
            guardian_halted: false,
        }
    }

    pub fn equity_pct(&self) -> f64 {
        self.equity - 1.0
    }

    pub fn mtm_pct(&self) -> f64 {
        self.mtm_equity - 1.0
    }

    pub fn drawdown_from_peak(&self) -> f64 {
        if self.challenge_peak <= 0.0 {
            0.0
        } else {
            (self.challenge_peak - self.mtm_equity) / self.challenge_peak
        }
    }

    pub fn intraday_pnl_pct(&self) -> f64 {
        if self.day_start <= 0.0 {
            0.0
        } else {
            (self.equity - self.day_start) / self.day_start
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_state_normalised_to_one() {
        let s = EngineState::initial("R28_V6_PASSLOCK");
        assert_eq!(s.equity, 1.0);
        assert_eq!(s.mtm_equity, 1.0);
        assert_eq!(s.equity_pct(), 0.0);
        assert_eq!(s.bars_seen, 0);
        assert!(s.stopped_reason.is_none());
        assert_eq!(s.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn drawdown_from_peak_handles_zero_peak() {
        let mut s = EngineState::initial("x");
        s.challenge_peak = 0.0;
        assert_eq!(s.drawdown_from_peak(), 0.0);
    }

    #[test]
    fn round_trips_through_camel_json() {
        let s = EngineState::initial("R28_V6_PASSLOCK");
        let payload = serde_json::to_string(&s).unwrap();
        assert!(payload.contains("\"schemaVersion\""));
        assert!(payload.contains("\"challengeStartTs\""));
        assert!(payload.contains("\"openPositions\""));
        let back: EngineState = serde_json::from_str(&payload).unwrap();
        assert_eq!(back.schema_version, SCHEMA_VERSION);
        assert_eq!(back.cfg_label, "R28_V6_PASSLOCK");
    }
}
