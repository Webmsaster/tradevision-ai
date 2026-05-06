//! Time helpers — port of the small utilities at the top of
//! `src/utils/ftmoLiveEngineV4.ts` (`pragueOffsetMs`, `dayIndex`, `lsKey`,
//! `findCandleAtTime`).

use chrono::{DateTime, Timelike, Utc};
use chrono_tz::Europe::Prague;

use crate::candle::Candle;
use crate::position::PositionSide;

/// Approximate Prague (CET / CEST) offset in milliseconds for a given UTC
/// unix-millis timestamp. Mirrors the JS implementation that uses
/// `Intl.DateTimeFormat` with `timeZone: "Europe/Prague"` and a 12h-wrap
/// guard. Returns +1h fallback if conversion ever errors (matches TS
/// catch branch).
pub fn prague_offset_ms(ts_ms: i64) -> i64 {
    let utc: DateTime<Utc> = match DateTime::from_timestamp_millis(ts_ms) {
        Some(t) => t,
        None => return 3_600_000,
    };
    // Direct hour() reads — no String allocations (was: format("%H").to_string()
    // + parse, two allocs per call).
    let prague_hour = utc.with_timezone(&Prague).hour() as i64;
    let utc_hour = utc.hour() as i64;
    let mut diff = prague_hour - utc_hour;
    if diff > 12 {
        diff -= 24;
    }
    if diff < -12 {
        diff += 24;
    }
    diff * 3_600_000
}

/// Day-of-challenge index, anchored at `challenge_start_ms` and rolled at
/// Prague-midnight. Both sides of the subtraction are shifted to local
/// Prague time so DST changeovers don't drift the index.
///
/// Mirrors `dayIndex(barTs, challengeStart)` in `ftmoLiveEngineV4.ts`.
pub fn day_index(bar_ts_ms: i64, challenge_start_ms: i64) -> i64 {
    if challenge_start_ms <= 0 {
        return 0;
    }
    let bar_local = bar_ts_ms + prague_offset_ms(bar_ts_ms);
    let start_local = challenge_start_ms + prague_offset_ms(challenge_start_ms);
    (bar_local - start_local).div_euclid(24 * 3_600_000)
}

/// Loss-streak hashmap key. Format MUST match the TS implementation
/// (`${symbol}|${direction}`) so persisted state files interop.
pub fn ls_key(symbol: &str, direction: PositionSide) -> String {
    let dir = match direction {
        PositionSide::Long => "long",
        PositionSide::Short => "short",
    };
    format!("{symbol}|{dir}")
}

/// Find the candle in `arr` whose `open_time` exactly equals `target_ms`.
/// Returns None if no exact match. Linear scan from the back because
/// live-feed convention has the target near the end.
pub fn find_candle_at_time(arr: &[Candle], target_ms: i64) -> Option<&Candle> {
    for c in arr.iter().rev() {
        if c.open_time == target_ms {
            return Some(c);
        }
        if c.open_time < target_ms {
            return None;
        }
    }
    None
}

/// Find the most-recent candle at-or-before `target_ms`. Used in V4
/// end-of-window force-close fallback chain.
pub fn find_candle_at_or_before(arr: &[Candle], target_ms: i64) -> Option<&Candle> {
    for c in arr.iter().rev() {
        if c.open_time <= target_ms {
            return Some(c);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build a Unix-millis from a UTC date string.
    fn utc_ms(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn prague_offset_summer_is_plus_two() {
        // 2026-07-15 12:00 UTC — Prague is CEST (+2h).
        let ts = utc_ms("2026-07-15T12:00:00+00:00");
        assert_eq!(prague_offset_ms(ts), 2 * 3_600_000);
    }

    #[test]
    fn prague_offset_winter_is_plus_one() {
        // 2026-01-15 12:00 UTC — Prague is CET (+1h).
        let ts = utc_ms("2026-01-15T12:00:00+00:00");
        assert_eq!(prague_offset_ms(ts), 3_600_000);
    }

    #[test]
    fn day_index_zero_at_start() {
        let start = utc_ms("2026-05-01T00:00:00+00:00");
        assert_eq!(day_index(start, start), 0);
    }

    #[test]
    fn day_index_counts_24h_since_anchor() {
        // Anchor exactly at Prague-midnight (2026-05-01 22:00 UTC = 2026-05-02 00:00 Prague CEST)
        let start = utc_ms("2026-05-01T22:00:00+00:00");
        // 23h later — still day 0.
        let same_day = utc_ms("2026-05-02T20:59:00+00:00");
        assert_eq!(day_index(same_day, start), 0);
        // Next Prague-midnight = +24h-utc.
        let next_day = utc_ms("2026-05-02T22:00:00+00:00");
        assert_eq!(day_index(next_day, start), 1);
        // Two days on.
        let day_two = utc_ms("2026-05-03T22:00:00+00:00");
        assert_eq!(day_index(day_two, start), 2);
    }

    #[test]
    fn day_index_dst_safe_across_transition() {
        // Anchor in CEST (summer +2). DST ends last Sunday of October —
        // 2026-10-25 03:00 Prague rewinds to 02:00 (=01:00 UTC).
        // A bar 24h-utc after the anchor should still flip day correctly
        // because the offset diff (CEST +2 vs CET +1 = -1h) is folded into
        // the locally-shifted subtraction.
        let start = utc_ms("2026-10-24T22:00:00+00:00"); // CEST 00:00 Prague
        // 24h-utc later, but Prague has lost an hour so it's only 23h-Prague.
        // Engine convention: Prague-aware day-counter still ticks at
        // Prague-midnight, so this is day 1 (Prague-wall-clock has rolled).
        let bar = utc_ms("2026-10-25T23:00:00+00:00"); // 00:00 Prague (post DST = CET)
        assert_eq!(day_index(bar, start), 1);
    }

    #[test]
    fn day_index_handles_zero_anchor() {
        assert_eq!(day_index(1_000_000, 0), 0);
        assert_eq!(day_index(1_000_000, -42), 0);
    }

    #[test]
    fn ls_key_matches_ts_format() {
        assert_eq!(ls_key("BTC-TREND", PositionSide::Long), "BTC-TREND|long");
        assert_eq!(ls_key("ETH", PositionSide::Short), "ETH|short");
    }

    #[test]
    fn find_candle_at_time_exact_match_only() {
        let arr = vec![
            Candle::new(100, 1.0, 1.0, 1.0, 1.0, 0.0),
            Candle::new(200, 2.0, 2.0, 2.0, 2.0, 0.0),
            Candle::new(300, 3.0, 3.0, 3.0, 3.0, 0.0),
        ];
        assert!(find_candle_at_time(&arr, 200).is_some());
        assert!(find_candle_at_time(&arr, 250).is_none());
        assert!(find_candle_at_time(&arr, 0).is_none());
        assert!(find_candle_at_time(&arr, 999).is_none());
    }

    #[test]
    fn find_candle_at_or_before_falls_back() {
        let arr = vec![
            Candle::new(100, 1.0, 1.0, 1.0, 1.0, 0.0),
            Candle::new(200, 2.0, 2.0, 2.0, 2.0, 0.0),
            Candle::new(300, 3.0, 3.0, 3.0, 3.0, 0.0),
        ];
        assert_eq!(find_candle_at_or_before(&arr, 250).unwrap().open_time, 200);
        assert_eq!(find_candle_at_or_before(&arr, 100).unwrap().open_time, 100);
        assert!(find_candle_at_or_before(&arr, 50).is_none());
    }
}
