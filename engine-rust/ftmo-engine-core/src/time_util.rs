//! Time helpers — port of the small utilities at the top of
//! `src/utils/ftmoLiveEngineV4.ts` (`pragueOffsetMs`, `dayIndex`, `lsKey`,
//! `findCandleAtTime`).

use chrono::{DateTime, Datelike, Timelike, Utc};
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
/// Prague-midnight.
///
/// 2026-05-13 Codex Audit Round 4 — Fix 2: previous implementation
/// computed `(bar_local - start_local) / 24h` which is *elapsed local
/// time*, NOT calendar-day arithmetic. Two failure modes:
///   1. For non-midnight `challenge_start_ms`, the rollover happened
///      24h-from-start-time instead of at the next Prague midnight.
///   2. On DST transitions, the dual-offset shift compensated for the
///      hour gain/loss INSIDE the elapsed window, but failed at the
///      boundary when the start anchor's offset and the bar's offset
///      differed by ±1 hour with bars near the rollover.
///
/// Mirrors TS `pragueDay(ms)` at `ftmoDaytrade24h.ts:3581`: take each
/// timestamp's calendar date in Europe/Prague and diff the days.
pub fn day_index(bar_ts_ms: i64, challenge_start_ms: i64) -> i64 {
    if challenge_start_ms <= 0 {
        return 0;
    }
    let bar_utc = match DateTime::from_timestamp_millis(bar_ts_ms) {
        Some(t) => t,
        None => return 0,
    };
    let start_utc = match DateTime::from_timestamp_millis(challenge_start_ms) {
        Some(t) => t,
        None => return 0,
    };
    let bar_day = bar_utc
        .with_timezone(&Prague)
        .date_naive()
        .num_days_from_ce();
    let start_day = start_utc
        .with_timezone(&Prague)
        .date_naive()
        .num_days_from_ce();
    (bar_day - start_day) as i64
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
    arr.iter()
        .rev()
        .find(|&c| c.open_time <= target_ms)
        .map(|v| v as _)
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
    fn day_index_non_midnight_start_rolls_at_prague_midnight() {
        // 2026-05-13 Codex Fix 2 regression: challenge_start = 10:00 Prague
        // (mid-day) — TS `pragueDay()` returns the calendar day, so a bar
        // at 23:59 Prague on the SAME day must be day 0, and the very next
        // bar at 00:00 Prague next day MUST be day 1 (NOT 24h after start).
        let start = utc_ms("2026-05-13T08:00:00+00:00"); // 10:00 Prague CEST
        let same_day_evening = utc_ms("2026-05-13T21:59:00+00:00"); // 23:59 Prague
        assert_eq!(day_index(same_day_evening, start), 0);
        let next_midnight_prague = utc_ms("2026-05-13T22:00:00+00:00"); // 00:00 Prague next day
        assert_eq!(day_index(next_midnight_prague, start), 1);
        // 24h-elapsed-from-start (10:00 Prague next day) should ALSO be day 1
        // — same calendar day as the prior 00:00 rollover.
        let twenty_four_h_later = utc_ms("2026-05-14T08:00:00+00:00");
        assert_eq!(day_index(twenty_four_h_later, start), 1);
    }

    #[test]
    fn day_index_dst_spring_forward_boundary() {
        // 2026-03-29 spring DST (last Sun of March): 02:00 CET → 03:00 CEST.
        // Anchor 2026-03-28 23:00 UTC = 2026-03-29 00:00 Prague (CET pre-DST).
        // The "next Prague-midnight" is 2026-03-29 22:00 UTC = 2026-03-30
        // 00:00 Prague (CEST, +2h post-DST). That's 23h-UTC after anchor.
        let start = utc_ms("2026-03-28T23:00:00+00:00");
        let just_before = utc_ms("2026-03-29T21:59:00+00:00"); // 23:59 Prague day-of
        assert_eq!(day_index(just_before, start), 0);
        let next_midnight = utc_ms("2026-03-29T22:00:00+00:00"); // 00:00 Prague next-day
        assert_eq!(day_index(next_midnight, start), 1);
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
