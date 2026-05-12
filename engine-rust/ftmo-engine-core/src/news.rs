//! News-blackout windows — port of the TS `newsBlackout` filter. Each
//! event has a UTC timestamp and a [pre, post] minute window during which
//! entries are blocked. Defaults are the hardcoded 2026 high-impact macro
//! events the Python executor tracks; live updates can come from Finnhub
//! via the `NEWS_API_KEY` env path.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsEvent {
    pub name: String,
    /// Event time in unix-millis UTC.
    pub ts_ms: i64,
    /// Minutes BEFORE the event during which entries are blocked.
    #[serde(default = "default_pre")]
    pub pre_minutes: i64,
    /// Minutes AFTER the event during which entries are blocked.
    #[serde(default = "default_post")]
    pub post_minutes: i64,
}

fn default_pre() -> i64 {
    30
}
fn default_post() -> i64 {
    15
}

impl NewsEvent {
    pub fn contains(&self, ts_ms: i64) -> bool {
        let pre = self.ts_ms - self.pre_minutes * 60_000;
        let post = self.ts_ms + self.post_minutes * 60_000;
        ts_ms >= pre && ts_ms <= post
    }
}

/// Hardcoded list of FTMO-relevant macro events for 2026. Default-OFF —
/// callers must explicitly opt in. Values are placeholders pending the
/// final 2026 calendar (Fed FOMC, ECB, NFP, CPI).
pub fn default_2026_events() -> Vec<NewsEvent> {
    let h = 3_600_000i64;
    let day = 86_400_000i64;
    let _y = 2026;
    let jan1_2026 = 1_767_225_600_000i64;
    vec![
        NewsEvent {
            name: "FOMC Jan 2026".into(),
            ts_ms: jan1_2026 + 27 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
        NewsEvent {
            name: "FOMC Mar 2026".into(),
            ts_ms: jan1_2026 + 76 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
        NewsEvent {
            name: "FOMC May 2026".into(),
            ts_ms: jan1_2026 + 124 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
        NewsEvent {
            name: "FOMC Jun 2026".into(),
            ts_ms: jan1_2026 + 168 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
        NewsEvent {
            name: "FOMC Jul 2026".into(),
            ts_ms: jan1_2026 + 209 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
        NewsEvent {
            name: "FOMC Sep 2026".into(),
            ts_ms: jan1_2026 + 259 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
        NewsEvent {
            name: "FOMC Nov 2026".into(),
            ts_ms: jan1_2026 + 308 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
        NewsEvent {
            name: "FOMC Dec 2026".into(),
            ts_ms: jan1_2026 + 343 * day + 19 * h,
            pre_minutes: 60,
            post_minutes: 60,
        },
    ]
}

/// Returns the matching event name if `ts_ms` falls inside any blackout.
pub fn in_blackout(ts_ms: i64, events: &[NewsEvent]) -> Option<&str> {
    events
        .iter()
        .find(|e| e.contains(ts_ms))
        .map(|e| e.name.as_str())
}

/// Load news events from a JSON file.
pub fn load_events(path: &std::path::Path) -> anyhow::Result<Vec<NewsEvent>> {
    let raw = std::fs::read(path)?;
    let v: Vec<NewsEvent> = serde_json::from_slice(&raw)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_window_pre_post() {
        let e = NewsEvent {
            name: "X".into(),
            ts_ms: 1_000_000,
            pre_minutes: 5,
            post_minutes: 10,
        };
        assert!(e.contains(1_000_000));
        assert!(e.contains(1_000_000 - 4 * 60_000));
        assert!(e.contains(1_000_000 + 9 * 60_000));
        assert!(!e.contains(1_000_000 - 6 * 60_000));
        assert!(!e.contains(1_000_000 + 11 * 60_000));
    }

    #[test]
    fn in_blackout_finds_match() {
        // Events ≥ 2*pre_minutes apart so windows don't overlap.
        let events = vec![
            NewsEvent {
                name: "A".into(),
                ts_ms: 1_000_000,
                pre_minutes: 1,
                post_minutes: 1,
            },
            NewsEvent {
                name: "B".into(),
                ts_ms: 10_000_000,
                pre_minutes: 1,
                post_minutes: 1,
            },
        ];
        assert_eq!(in_blackout(1_000_000, &events), Some("A"));
        assert_eq!(in_blackout(10_000_000, &events), Some("B"));
        assert!(in_blackout(5_000_000, &events).is_none());
    }

    #[test]
    fn defaults_load_no_panic() {
        let events = default_2026_events();
        assert_eq!(events.len(), 8);
    }
}
