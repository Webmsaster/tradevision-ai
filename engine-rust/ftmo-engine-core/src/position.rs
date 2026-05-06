//! Open position — ports `OpenPositionV4` from `ftmoLiveEngineV4.ts`.
//!
//! Field names use snake_case Rust convention but serde-rename to camelCase
//! to round-trip with persisted `v4-engine.json` state files written by the
//! TS engine and read by the Python executor.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PositionSide {
    Long,
    Short,
}

impl PositionSide {
    pub fn opposite(self) -> Self {
        match self {
            PositionSide::Long => PositionSide::Short,
            PositionSide::Short => PositionSide::Long,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenPosition {
    /// Stable position id — `${entryTime}-${symbol}` used for ticket idempotency.
    #[serde(rename = "ticketId")]
    pub ticket_id: String,
    /// Logical engine symbol (e.g. "BTC-TREND").
    pub symbol: String,
    /// Candle source key (e.g. "BTCUSDT").
    #[serde(rename = "sourceSymbol")]
    pub source_symbol: String,
    pub direction: PositionSide,
    /// Entry bar `openTime` in unix-millis.
    #[serde(rename = "entryTime")]
    pub entry_time: i64,
    #[serde(rename = "entryPrice")]
    pub entry_price: f64,
    /// Initial stop-distance fraction (used for chandelier minMoveR).
    #[serde(rename = "initialStopPct")]
    pub initial_stop_pct: f64,
    #[serde(rename = "stopPrice")]
    pub stop_price: f64,
    #[serde(rename = "tpPrice")]
    pub tp_price: f64,
    /// Engine-units risk fraction at entry (post sizing factor + caps).
    #[serde(rename = "effRisk")]
    pub eff_risk: f64,
    /// Monotonic bar index at entry — tracks `state.bars_seen`.
    #[serde(rename = "entryBarIdx")]
    pub entry_bar_idx: u64,
    /// Long: highest high since entry. Short: lowest low since entry.
    #[serde(rename = "highWatermark")]
    pub high_watermark: f64,
    #[serde(default, rename = "beActive")]
    pub be_active: bool,
    #[serde(default, rename = "ptpTriggered")]
    pub ptp_triggered: bool,
    #[serde(default, rename = "ptpRealizedPct")]
    pub ptp_realized_pct: f64,
    #[serde(default, rename = "ptpLevelIdx")]
    pub ptp_level_idx: usize,
    #[serde(default, rename = "ptpLevelsRealized")]
    pub ptp_levels_realized: f64,
    /// Round 58 (Critical Fix #2): most-recent close observed for this asset.
    /// Used as a safe fallback in end-of-window force-close when no candle
    /// is available on the final bar.
    #[serde(default, rename = "lastKnownPrice", skip_serializing_if = "Option::is_none")]
    pub last_known_price: Option<f64>,
}

impl OpenPosition {
    /// Compose ticket id from entry time + symbol — must match the TS
    /// implementation so persisted state files are interoperable.
    pub fn make_ticket_id(entry_time: i64, symbol: &str) -> String {
        format!("{entry_time}-{symbol}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_long() -> OpenPosition {
        OpenPosition {
            ticket_id: OpenPosition::make_ticket_id(1_700_000_000_000, "BTC-TREND"),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_700_000_000_000,
            entry_price: 100.0,
            initial_stop_pct: 0.02,
            stop_price: 98.0,
            tp_price: 104.0,
            eff_risk: 0.4,
            entry_bar_idx: 42,
            high_watermark: 100.0,
            be_active: false,
            ptp_triggered: false,
            ptp_realized_pct: 0.0,
            ptp_level_idx: 0,
            ptp_levels_realized: 0.0,
            last_known_price: None,
        }
    }

    #[test]
    fn ticket_id_is_stable() {
        let p = sample_long();
        assert_eq!(p.ticket_id, "1700000000000-BTC-TREND");
    }

    #[test]
    fn round_trip_serde_renames_to_camel() {
        let p = sample_long();
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"ticketId\""));
        assert!(s.contains("\"sourceSymbol\""));
        assert!(s.contains("\"entryPrice\""));
        let back: OpenPosition = serde_json::from_str(&s).unwrap();
        assert_eq!(back.entry_price, p.entry_price);
        assert_eq!(back.direction, PositionSide::Long);
    }
}
