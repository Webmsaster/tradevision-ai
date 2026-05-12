//! Closed trade — port of `ClosedTradeV4` from `ftmoLiveEngineV4.ts`.

use serde::{Deserialize, Serialize};

use crate::position::PositionSide;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExitReason {
    Tp,
    Stop,
    Time,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosedTrade {
    #[serde(rename = "ticketId")]
    pub ticket_id: String,
    pub symbol: String,
    pub direction: PositionSide,
    #[serde(rename = "entryTime")]
    pub entry_time: i64,
    #[serde(rename = "exitTime")]
    pub exit_time: i64,
    #[serde(rename = "entryPrice")]
    pub entry_price: f64,
    #[serde(rename = "exitPrice")]
    pub exit_price: f64,
    #[serde(rename = "rawPnl")]
    pub raw_pnl: f64,
    #[serde(rename = "effPnl")]
    pub eff_pnl: f64,
    #[serde(rename = "exitReason")]
    pub exit_reason: ExitReason,
    /// Day-of-challenge at exit.
    pub day: u32,
    #[serde(rename = "entryDay")]
    pub entry_day: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_camel_renames() {
        let t = ClosedTrade {
            ticket_id: "1-BTC".into(),
            symbol: "BTC-TREND".into(),
            direction: PositionSide::Long,
            entry_time: 1,
            exit_time: 2,
            entry_price: 100.0,
            exit_price: 104.0,
            raw_pnl: 0.04,
            eff_pnl: 0.032,
            exit_reason: ExitReason::Tp,
            day: 0,
            entry_day: 0,
        };
        let s = serde_json::to_string(&t).unwrap();
        assert!(s.contains("\"exitReason\":\"tp\""));
        assert!(s.contains("\"effPnl\""));
        let back: ClosedTrade = serde_json::from_str(&s).unwrap();
        assert_eq!(back.exit_price, 104.0);
    }
}
