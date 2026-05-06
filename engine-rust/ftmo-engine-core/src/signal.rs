//! Signal types — port of `PollSignal` / `PollSkip` / `PollDecision` from
//! `ftmoLiveEngineV4.ts`. Signals are emitted by the per-asset detector
//! (`detectAsset` in `ftmoDaytrade24h.ts`) which is NOT yet ported. Until
//! it is, callers must produce signals externally — JSON-deserialise them
//! and feed `step_bar()` from `harness.rs`.

use serde::{Deserialize, Serialize};

use crate::position::PositionSide;

/// New entry candidate for the current bar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollSignal {
    pub symbol: String,
    #[serde(rename = "sourceSymbol")]
    pub source_symbol: String,
    pub direction: PositionSide,
    /// Bar's `openTime` in unix-millis.
    #[serde(rename = "entryTime")]
    pub entry_time: i64,
    #[serde(rename = "entryPrice")]
    pub entry_price: f64,
    #[serde(rename = "stopPrice")]
    pub stop_price: f64,
    #[serde(rename = "tpPrice")]
    pub tp_price: f64,
    #[serde(rename = "stopPct")]
    pub stop_pct: f64,
    #[serde(rename = "tpPct")]
    pub tp_pct: f64,
    #[serde(rename = "effRisk")]
    pub eff_risk: f64,
    #[serde(default, rename = "chandelierAtrAtEntry", skip_serializing_if = "Option::is_none")]
    pub chandelier_atr_at_entry: Option<f64>,
}

/// Asset-level skip note (informational — surface in logs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollSkip {
    pub asset: String,
    pub reason: String,
}

/// Bar-level close intent — used by harness consumers (e.g. live executor)
/// to translate engine decisions into broker actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseIntent {
    #[serde(rename = "ticketId")]
    pub ticket_id: String,
    #[serde(rename = "exitPrice")]
    pub exit_price: f64,
    #[serde(rename = "exitReason")]
    pub exit_reason: crate::trade::ExitReason,
}

/// Aggregated decisions for one bar.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PollDecision {
    pub closes: Vec<CloseIntent>,
    pub opens: Vec<PollSignal>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_round_trips() {
        let s = PollSignal {
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Long,
            entry_time: 1_700_000_000_000,
            entry_price: 100.0,
            stop_price: 98.0,
            tp_price: 104.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: Some(1.5),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"sourceSymbol\""));
        assert!(json.contains("\"chandelierAtrAtEntry\""));
        let back: PollSignal = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entry_price, s.entry_price);
        assert_eq!(back.direction, PositionSide::Long);
    }

    #[test]
    fn decision_omits_optional_atr() {
        let s = PollSignal {
            symbol: "BTC".into(),
            source_symbol: "BTCUSDT".into(),
            direction: PositionSide::Short,
            entry_time: 1,
            entry_price: 100.0,
            stop_price: 102.0,
            tp_price: 96.0,
            stop_pct: 0.02,
            tp_pct: 0.04,
            eff_risk: 0.4,
            chandelier_atr_at_entry: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("chandelierAtrAtEntry"));
    }
}
