/**
 * Synthetic high-impact USD macro events for backtest.
 * Generated programmatically from known release patterns.
 *
 * Sources:
 *   - FOMC: 8 meetings/year, every ~6 weeks, Wed 18:00 UTC release
 *   - CPI:  Monthly, ~10-15th, 12:30 UTC
 *   - NFP:  Monthly, 1st Friday, 12:30 UTC
 *   - PPI:  Monthly, ~12-15th (day after CPI usually), 12:30 UTC
 */
import type { NewsEvent } from "../src/utils/forexFactoryNews";

// Approximate FOMC meeting dates 2020-2026 (Wed 18:00 UTC = release time)
// Sources: federalreserve.gov calendar (publicly scheduled)
const FOMC_DATES = [
  // 2020
  "2020-01-29",
  "2020-03-15",
  "2020-04-29",
  "2020-06-10",
  "2020-07-29",
  "2020-09-16",
  "2020-11-05",
  "2020-12-16",
  // 2021
  "2021-01-27",
  "2021-03-17",
  "2021-04-28",
  "2021-06-16",
  "2021-07-28",
  "2021-09-22",
  "2021-11-03",
  "2021-12-15",
  // 2022
  "2022-01-26",
  "2022-03-16",
  "2022-05-04",
  "2022-06-15",
  "2022-07-27",
  "2022-09-21",
  "2022-11-02",
  "2022-12-14",
  // 2023
  "2023-02-01",
  "2023-03-22",
  "2023-05-03",
  "2023-06-14",
  "2023-07-26",
  "2023-09-20",
  "2023-11-01",
  "2023-12-13",
  // 2024
  "2024-01-31",
  "2024-03-20",
  "2024-05-01",
  "2024-06-12",
  "2024-07-31",
  "2024-09-18",
  "2024-11-07",
  "2024-12-18",
  // 2025
  "2025-01-29",
  "2025-03-19",
  "2025-05-07",
  "2025-06-18",
  "2025-07-30",
  "2025-09-17",
  "2025-11-05",
  "2025-12-17",
  // 2026
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
];

/**
 * Generate monthly CPI release dates (US BLS pattern: ~10-15th of month, 12:30 UTC).
 * Approximated as 2nd Tuesday of each month.
 */
function generateMonthlyEvent(
  yearStart: number,
  yearEnd: number,
  dayOfMonth: number,
  hourUTC: number,
  minuteUTC: number,
): string[] {
  const out: string[] = [];
  for (let y = yearStart; y <= yearEnd; y++) {
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(y, m, dayOfMonth, hourUTC, minuteUTC));
      out.push(d.toISOString());
    }
  }
  return out;
}

/** First Friday of each month (NFP release). */
function firstFridayUTC(yearStart: number, yearEnd: number): string[] {
  const out: string[] = [];
  for (let y = yearStart; y <= yearEnd; y++) {
    for (let m = 0; m < 12; m++) {
      // find first Friday
      for (let d = 1; d <= 7; d++) {
        const date = new Date(Date.UTC(y, m, d, 12, 30));
        if (date.getUTCDay() === 5) {
          out.push(date.toISOString());
          break;
        }
      }
    }
  }
  return out;
}

export function getMacroEvents(): NewsEvent[] {
  const out: NewsEvent[] = [];
  for (const d of FOMC_DATES) {
    out.push({
      timestamp: new Date(d + "T18:00:00Z").getTime(),
      impact: "High",
      currency: "USD",
      title: "FOMC Rate Decision",
    });
    // Powell press conference 30 min later
    out.push({
      timestamp: new Date(d + "T18:30:00Z").getTime(),
      impact: "High",
      currency: "USD",
      title: "FOMC Press Conference",
    });
  }
  for (const d of generateMonthlyEvent(2020, 2026, 12, 12, 30)) {
    out.push({
      timestamp: new Date(d).getTime(),
      impact: "High",
      currency: "USD",
      title: "CPI",
    });
  }
  for (const d of generateMonthlyEvent(2020, 2026, 13, 12, 30)) {
    out.push({
      timestamp: new Date(d).getTime(),
      impact: "High",
      currency: "USD",
      title: "PPI",
    });
  }
  for (const d of firstFridayUTC(2020, 2026)) {
    out.push({
      timestamp: new Date(d).getTime(),
      impact: "High",
      currency: "USD",
      title: "NFP",
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
