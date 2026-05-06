//! Offline-reconciliation — when the bot crashes/restarts, MT5 is the
//! source-of-truth for what closed during the off-period. The Python
//! executor writes `closed-during-offline.json` (a JSON array of
//! `ClosedTrade`) and the engine ingests it on the next state-load.
//!
//! Mirrors the R57 V4-3 reconcile path in `tools/ftmo_executor.py`.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::pnl::compute_eff_pnl;
use crate::position::OpenPosition;
use crate::state::{EngineState, KellyPnl};
use crate::trade::{ClosedTrade, ExitReason};

const RECONCILE_FILENAME: &str = "closed-during-offline.json";

/// Wire-format entry for a position that closed while the bot was offline.
/// Reads/writes `closed-during-offline.json` produced by the Python
/// executor's `reconcile_missing_positions()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineClosure {
    /// Stable position id (matches `OpenPosition.ticket_id`).
    #[serde(rename = "ticketId")]
    pub ticket_id: String,
    /// Realised exit price from MT5 history.
    #[serde(rename = "exitPrice")]
    pub exit_price: f64,
    /// Bar `openTime` at which MT5 history records the close.
    #[serde(rename = "exitTime")]
    pub exit_time: i64,
    /// Reason inferred by the executor (`tp` / `stop` / `time` / `manual`).
    #[serde(rename = "exitReason")]
    pub exit_reason: ExitReason,
}

/// Read offline-closures from `<state_dir>/closed-during-offline.json`.
/// Returns an empty vec if the file doesn't exist (normal cold-start case).
pub fn load_offline_closures(state_dir: &Path) -> Result<Vec<OfflineClosure>> {
    let path = state_dir.join(RECONCILE_FILENAME);
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let v: Vec<OfflineClosure> = serde_json::from_slice(&raw)
        .with_context(|| format!("parsing {}", path.display()))?;
    Ok(v)
}

/// Apply offline-closures: realise PnL, push closed trades, update kelly,
/// remove from open_positions. After ingest the `closed-during-offline.json`
/// file should be unlinked (caller's responsibility — multi-account safety).
pub fn ingest_offline_closures(
    state: &mut EngineState,
    cfg: &crate::config::EngineConfig,
    closures: &[OfflineClosure],
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
        let pnl = compute_eff_pnl(&pos, c.exit_price, cfg);
        state.equity *= 1.0 + pnl.eff_pnl;
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
            day: state.day,
            entry_day: 0, // unknown without full bar context — caller can backfill if needed
        };
        if cfg.kelly_sizing.is_some() {
            state
                .kelly_pnls
                .push(KellyPnl { close_time: c.exit_time, eff_pnl: pnl.eff_pnl });
        }
        state.closed_trades.push(trade);
        applied += 1;
    }
    state.mtm_equity = state.equity; // re-MTM after force-realisations
    applied
}

/// Convenience: load + apply + remove the file.
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
}
