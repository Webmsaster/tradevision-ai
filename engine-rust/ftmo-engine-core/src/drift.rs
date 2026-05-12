//! Drift-Dashboard Snapshot — emits the JSON shape consumed by
//! `/api/drift-data` so the Next.js dashboard can monitor a Rust engine
//! exactly like the TS engine.

use serde::Serialize;

use crate::position::OpenPosition;
use crate::state::EngineState;
use crate::trade::ClosedTrade;

#[derive(Debug, Clone, Serialize)]
pub struct DriftSnapshot {
    pub label: String,
    pub ts: i64,
    pub equity: f64,
    #[serde(rename = "mtmEquity")]
    pub mtm_equity: f64,
    pub day: u32,
    #[serde(rename = "dayPeak")]
    pub day_peak: f64,
    #[serde(rename = "challengePeak")]
    pub challenge_peak: f64,
    #[serde(rename = "dayPnlPct")]
    pub day_pnl_pct: f64,
    #[serde(rename = "totalPnlPct")]
    pub total_pnl_pct: f64,
    #[serde(rename = "tradingDays")]
    pub trading_days: usize,
    #[serde(rename = "openPositions")]
    pub open_positions: Vec<OpenPosition>,
    /// Last 50 closed trades (truncated for dashboard payload size).
    #[serde(rename = "recentTrades")]
    pub recent_trades: Vec<ClosedTrade>,
    #[serde(rename = "stoppedReason")]
    pub stopped_reason: Option<String>,
}

impl DriftSnapshot {
    pub fn from_state(state: &EngineState) -> Self {
        let recent_trades = if state.closed_trades.len() > 50 {
            state.closed_trades[state.closed_trades.len() - 50..].to_vec()
        } else {
            state.closed_trades.clone()
        };
        Self {
            label: state.cfg_label.clone(),
            ts: chrono::Utc::now().timestamp_millis(),
            equity: state.equity,
            mtm_equity: state.mtm_equity,
            day: state.day,
            day_peak: state.day_peak,
            challenge_peak: state.challenge_peak,
            day_pnl_pct: state.intraday_pnl_pct(),
            total_pnl_pct: state.equity_pct(),
            trading_days: state.trading_days.len(),
            open_positions: state.open_positions.clone(),
            recent_trades,
            stopped_reason: state.stopped_reason.map(|r| format!("{r:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_from_initial_state() {
        let s = EngineState::initial("X");
        let snap = DriftSnapshot::from_state(&s);
        assert_eq!(snap.label, "X");
        assert_eq!(snap.equity, 1.0);
        assert_eq!(snap.day_pnl_pct, 0.0);
        assert!(snap.recent_trades.is_empty());
        assert!(snap.stopped_reason.is_none());
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"mtmEquity\""));
        assert!(json.contains("\"dayPnlPct\""));
    }

    #[test]
    fn truncates_recent_trades_to_50() {
        let mut s = EngineState::initial("X");
        for i in 0..200 {
            s.closed_trades.push(crate::trade::ClosedTrade {
                ticket_id: format!("t{i}"),
                symbol: "BTC".into(),
                direction: crate::position::PositionSide::Long,
                entry_time: i,
                exit_time: i + 1,
                entry_price: 100.0,
                exit_price: 101.0,
                raw_pnl: 0.01,
                eff_pnl: 0.008,
                exit_reason: crate::trade::ExitReason::Tp,
                day: 0,
                entry_day: 0,
            });
        }
        let snap = DriftSnapshot::from_state(&s);
        assert_eq!(snap.recent_trades.len(), 50);
        assert_eq!(snap.recent_trades[0].ticket_id, "t150");
    }
}
