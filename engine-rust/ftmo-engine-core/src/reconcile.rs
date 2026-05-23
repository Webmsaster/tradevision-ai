//! Offline-reconciliation — when the bot crashes/restarts, MT5 is the
//! source-of-truth for what closed during the off-period. The Python
//! executor writes `closed-during-offline.json` (a JSON array of
//! `ClosedTrade`) and the engine ingests it on the next state-load.
//!
//! Mirrors the R57 V4-3 reconcile path in `tools/ftmo_executor.py`.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::pnl::{compute_eff_pnl_with_funding, compute_eff_pnl_with_time};
use crate::position::OpenPosition;
use crate::state::{EngineState, KellyPnl};
use crate::time_util::day_index;
use crate::trade::{ClosedTrade, ExitReason};

const RECONCILE_FILENAME: &str = "closed-during-offline.json";

/// Wire-format entry for a position that closed while the bot was offline.
/// Reads/writes `closed-during-offline.json` produced by the Python
/// executor's `reconcile_missing_positions()`.
///
/// 2026-05-23 Wave1 audit fix (KRIT-1): Python writer uses snake_case keys
/// (`ticket`, `exit_price`, `exit_time_ms`, `reason`) while Rust originally
/// only accepted camelCase. Added serde `alias` so both wire formats parse.
/// Without aliases, every offline-recovered trade was silently lost on load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineClosure {
    /// Stable position id (matches `OpenPosition.ticket_id`).
    #[serde(rename = "ticketId", alias = "ticket")]
    pub ticket_id: String,
    /// Realised exit price from MT5 history.
    #[serde(rename = "exitPrice", alias = "exit_price")]
    pub exit_price: f64,
    /// Bar `openTime` at which MT5 history records the close.
    #[serde(rename = "exitTime", alias = "exit_time_ms", alias = "exit_time")]
    pub exit_time: i64,
    /// Reason inferred by the executor (`tp` / `stop` / `time` / `manual`).
    #[serde(rename = "exitReason", alias = "reason")]
    pub exit_reason: ExitReason,
}

/// 2026-05-23 Wave1 audit fix (KRIT-1): Python writer wraps closures in a
/// `{"trades": [...]}` envelope; Rust originally expected a bare top-level
/// `Vec`. Accept both by trying the wrapper first.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum OfflineClosureWire {
    /// Python-style: `{"trades": [...], "reconciled_at": ..., ...}`
    Envelope { trades: Vec<OfflineClosure> },
    /// Rust-style: bare top-level array
    Bare(Vec<OfflineClosure>),
}

/// Read offline-closures from `<state_dir>/closed-during-offline.json`.
/// Returns an empty vec if the file doesn't exist (normal cold-start case).
pub fn load_offline_closures(state_dir: &Path) -> Result<Vec<OfflineClosure>> {
    let path = state_dir.join(RECONCILE_FILENAME);
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let wire: OfflineClosureWire =
        serde_json::from_slice(&raw).with_context(|| format!("parsing {}", path.display()))?;
    let v = match wire {
        OfflineClosureWire::Envelope { trades } => trades,
        OfflineClosureWire::Bare(v) => v,
    };
    Ok(v)
}

/// Optional funding context for offline reconcile. When provided, the
/// realised-PnL math uses `compute_eff_pnl_with_funding` so the recovered
/// trades pay/receive funding identically to in-flight trades. Without this,
/// an offline-recovered trade silently skips funding-cost deduction — a real
/// parity bug when the bot crashes mid-window on a perp-crypto sweep.
#[derive(Debug, Clone, Copy)]
pub struct OfflineFundingCtx<'a> {
    /// Per-source-symbol forward-filled funding series (same layout as the
    /// in-flight `BarInput::funding_by_source`).
    pub funding_by_source: &'a HashMap<String, Vec<Option<f64>>>,
    /// Map source_symbol → open_time of funding[0] for that symbol.
    pub bar0_open_time_by_source: &'a HashMap<String, i64>,
    /// Bar duration in milliseconds (typically 30min × 60_000).
    pub bar_dur_ms: i64,
}

/// Apply offline-closures: realise PnL, push closed trades, update kelly,
/// remove from open_positions. After ingest the `closed-during-offline.json`
/// file should be unlinked (caller's responsibility — multi-account safety).
///
/// Funding-cost is skipped (legacy behaviour). For the funding-aware path
/// use `ingest_offline_closures_with_funding`.
pub fn ingest_offline_closures(
    state: &mut EngineState,
    cfg: &crate::config::EngineConfig,
    closures: &[OfflineClosure],
) -> usize {
    ingest_offline_closures_inner(state, cfg, closures, None)
}

/// 2026-05-14 Detector #11 Phase-0 — funding-aware variant. Uses
/// `compute_eff_pnl_with_funding` when the closure's `source_symbol` has a
/// funding series in `ctx`. Falls back to `compute_eff_pnl_with_time`
/// per-trade when the symbol is missing from the funding map.
pub fn ingest_offline_closures_with_funding(
    state: &mut EngineState,
    cfg: &crate::config::EngineConfig,
    closures: &[OfflineClosure],
    ctx: OfflineFundingCtx<'_>,
) -> usize {
    ingest_offline_closures_inner(state, cfg, closures, Some(ctx))
}

fn ingest_offline_closures_inner(
    state: &mut EngineState,
    cfg: &crate::config::EngineConfig,
    closures: &[OfflineClosure],
    funding_ctx: Option<OfflineFundingCtx<'_>>,
) -> usize {
    let mut applied = 0usize;
    for c in closures {
        let Some(pos_idx) = state
            .open_positions
            .iter()
            .position(|p| p.ticket_id == c.ticket_id)
        else {
            continue;
        };
        let pos: OpenPosition = state.open_positions.remove(pos_idx);
        // 2026-05-14 Detector #11 Phase-0 FIX: when caller supplies funding
        // context, use the funding-aware PnL path so offline-recovered
        // trades pay funding identically to in-flight trades. Without this
        // the offline-reconcile silently dropped funding charges.
        let pnl = match funding_ctx {
            Some(ctx) => {
                let funding_series = ctx
                    .funding_by_source
                    .get(&pos.source_symbol)
                    .map(|v| v.as_slice());
                let bar0 = ctx
                    .bar0_open_time_by_source
                    .get(&pos.source_symbol)
                    .copied()
                    .unwrap_or(0);
                compute_eff_pnl_with_funding(
                    &pos,
                    c.exit_price,
                    cfg,
                    Some(c.exit_time),
                    funding_series,
                    bar0,
                    ctx.bar_dur_ms,
                )
            }
            None => compute_eff_pnl_with_time(&pos, c.exit_price, cfg, Some(c.exit_time)),
        };
        state.equity *= 1.0 + pnl.eff_pnl;
        // R29-R4.2 PARITY FIX: entry_day was hardcoded to 0, which corrupts
        // any downstream analytics that bucket trades by entry-day. We
        // already have entry_time + challenge_start_ts, so compute it
        // exactly like apply_exits does in harness.rs (Prague-aware day).
        // exit day was also wrong: state.day reflects the LIVE poll day at
        // the time of reconcile, NOT the day the trade exited. Use the
        // offline-closure's exit_time via day_index for accuracy.
        let entry_day_idx = if state.challenge_start_ts > 0 {
            day_index(pos.entry_time, state.challenge_start_ts).max(0) as u32
        } else {
            0
        };
        let exit_day_idx = if state.challenge_start_ts > 0 {
            day_index(c.exit_time, state.challenge_start_ts).max(0) as u32
        } else {
            state.day
        };
        let trade = ClosedTrade {
            ticket_id: pos.ticket_id.clone(),
            symbol: pos.symbol.clone(),
            direction: pos.direction,
            entry_time: pos.entry_time,
            exit_time: c.exit_time,
            entry_price: pos.entry_price,
            exit_price: c.exit_price,
            raw_pnl: pnl.raw_pnl,
            eff_pnl: pnl.eff_pnl,
            exit_reason: c.exit_reason,
            day: exit_day_idx,
            entry_day: entry_day_idx,
        };
        if cfg.kelly_sizing.is_some() {
            state.kelly_pnls.push(KellyPnl {
                close_time: c.exit_time,
                eff_pnl: pnl.eff_pnl,
            });
        }
        state.closed_trades.push(trade);
        applied += 1;
    }
    state.mtm_equity = state.equity; // re-MTM after force-realisations
    applied
}

/// Convenience: load + apply + remove the file.
///
/// 2026-05-23 Wave1 audit (KRIT-4): function is currently NOT called from
/// the Rust sweep/backtest binary because sweep runs synthetic windows and
/// has no concept of "offline-closure recovery." It's intended for a Rust
/// LIVE engine path that doesn't yet exist; live trading runs through
/// Python `tools/ftmo_executor.py` which has its own reconcile logic
/// (`reconcile_missing_positions()`). Schema is now Python-compatible (R11
/// + Wave1 serde aliases) so when a Rust live path is added, this function
/// can be wired without further changes.
pub fn reconcile_offline(
    state: &mut EngineState,
    cfg: &crate::config::EngineConfig,
    state_dir: &Path,
) -> Result<usize> {
    let closures = load_offline_closures(state_dir)?;
    let applied = ingest_offline_closures(state, cfg, &closures);
    let path = state_dir.join(RECONCILE_FILENAME);
    if path.exists() {
        // Move to archive instead of delete — operator forensics.
        let archived = path.with_extension(format!(
            "json.archived.{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::rename(&path, &archived).ok();
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::EngineConfig;
    use crate::position::PositionSide;

    #[test]
    fn ingest_stop_close() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        let mut state = EngineState::initial("x");
        state.open_positions.push(OpenPosition {
            ticket_id: "t1".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
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
        let closures = vec![OfflineClosure {
            ticket_id: "t1".into(),
            exit_price: 98.0,
            exit_time: 2_000,
            exit_reason: ExitReason::Stop,
        }];
        let n = ingest_offline_closures(&mut state, &cfg, &closures);
        assert_eq!(n, 1);
        assert!(state.open_positions.is_empty());
        assert_eq!(state.closed_trades.len(), 1);
        // -2% raw × 2 lev × 0.4 risk = -0.016 → equity = 0.984
        assert!((state.equity - 0.984).abs() < 1e-9);
    }

    #[test]
    fn ingest_skips_unknown_ticket() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        let mut state = EngineState::initial("x");
        let closures = vec![OfflineClosure {
            ticket_id: "ghost".into(),
            exit_price: 100.0,
            exit_time: 0,
            exit_reason: ExitReason::Stop,
        }];
        assert_eq!(ingest_offline_closures(&mut state, &cfg, &closures), 0);
        assert_eq!(state.equity, 1.0);
    }

    #[test]
    fn ingest_with_funding_charges_long_position() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        let mut state = EngineState::initial("x");
        const EIGHT_H: i64 = 8 * 3_600_000;
        const BAR_DUR: i64 = 30 * 60_000;
        let bar0_open = (1_700_000_000_000_i64 / EIGHT_H) * EIGHT_H;
        let entry_time = bar0_open + 60_000;
        let exit_time = bar0_open + 2 * EIGHT_H + 60_000;
        state.open_positions.push(OpenPosition {
            ticket_id: "tA".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time,
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
        let mut funding = vec![Some(0.0_f64); 100];
        funding[16] = Some(0.0001);
        funding[32] = Some(0.0002);
        let mut fund_by_sym = HashMap::new();
        fund_by_sym.insert("BTCUSDT".to_string(), funding);
        let mut bar0_by_sym = HashMap::new();
        bar0_by_sym.insert("BTCUSDT".to_string(), bar0_open);
        let ctx = OfflineFundingCtx {
            funding_by_source: &fund_by_sym,
            bar0_open_time_by_source: &bar0_by_sym,
            bar_dur_ms: BAR_DUR,
        };
        let closures = vec![OfflineClosure {
            ticket_id: "tA".into(),
            exit_price: 104.0,
            exit_time,
            exit_reason: ExitReason::Tp,
        }];
        let n = ingest_offline_closures_with_funding(&mut state, &cfg, &closures, ctx);
        assert_eq!(n, 1);
        // raw = 0.04 - (0.0001 + 0.0002) = 0.0397; eff = 0.0397 * 2 * 0.4 = 0.03176
        assert!(
            (state.equity - 1.03176).abs() < 1e-9,
            "equity={}, expected 1.03176",
            state.equity
        );
    }

    #[test]
    fn ingest_funding_path_matches_with_time_when_symbol_absent() {
        let cfg = EngineConfig::r28_v6_passlock_template();
        let mut state_a = EngineState::initial("x");
        state_a.open_positions.push(OpenPosition {
            ticket_id: "tB".into(),
            symbol: "EUR-MR".into(),
            source_symbol: "EURUSD".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            initial_stop_pct: 0.02,
            stop_price: 98.0,
            tp_price: 102.0,
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
        let closures = vec![OfflineClosure {
            ticket_id: "tB".into(),
            exit_price: 102.0,
            exit_time: 2_000,
            exit_reason: ExitReason::Tp,
        }];
        ingest_offline_closures(&mut state_a, &cfg, &closures);
        let mut state_b = EngineState::initial("x");
        state_b.open_positions.push(OpenPosition {
            ticket_id: "tB".into(),
            symbol: "EUR-MR".into(),
            source_symbol: "EURUSD".into(),
            direction: PositionSide::Long,
            entry_time: 1_000,
            entry_price: 100.0,
            initial_stop_pct: 0.02,
            stop_price: 98.0,
            tp_price: 102.0,
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
        let fund_by_sym: HashMap<String, Vec<Option<f64>>> = HashMap::new();
        let bar0_by_sym: HashMap<String, i64> = HashMap::new();
        let ctx = OfflineFundingCtx {
            funding_by_source: &fund_by_sym,
            bar0_open_time_by_source: &bar0_by_sym,
            bar_dur_ms: 30 * 60_000,
        };
        ingest_offline_closures_with_funding(&mut state_b, &cfg, &closures, ctx);
        assert!(
            (state_a.equity - state_b.equity).abs() < 1e-15,
            "legacy={} funding-aware-empty={}",
            state_a.equity,
            state_b.equity
        );
    }
}
