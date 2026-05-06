//! Candle / OHLCV bar — mirrors `src/utils/indicators.ts:Candle`.
//!
//! `open_time` is the UTC unix-millis at bar-open. For 30m bars: 0/30 minute
//! marks. `close_time` is the timestamp when the bar finalised (open_time +
//! bar_interval - 1ms in Binance feed convention). `is_final` matches the
//! Binance kline `x` field — true once the bar has closed and won't tick
//! again.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Candle {
    #[serde(rename = "openTime")]
    pub open_time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    #[serde(default)]
    pub volume: f64,
    #[serde(default, rename = "closeTime")]
    pub close_time: i64,
    #[serde(default = "default_is_final", rename = "isFinal")]
    pub is_final: bool,
}

fn default_is_final() -> bool {
    true
}

impl Candle {
    pub fn new(open_time: i64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Self {
        Self {
            open_time,
            open,
            high,
            low,
            close,
            volume,
            close_time: 0,
            is_final: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_serde() {
        let c = Candle::new(1_700_000_000_000, 100.0, 101.0, 99.0, 100.5, 1234.0);
        let s = serde_json::to_string(&c).unwrap();
        let back: Candle = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn deserialise_minimum_payload() {
        let s = r#"{"openTime":1700000000000,"open":100,"high":101,"low":99,"close":100.5}"#;
        let c: Candle = serde_json::from_str(s).unwrap();
        assert_eq!(c.open, 100.0);
        assert!(c.is_final);
        assert_eq!(c.volume, 0.0);
    }
}
