/**
 * ForexFactory news calendar loader.
 *
 * Free public JSON feed, no API key required. Provides the current
 * week's economic events with timestamp + impact level.
 *
 * Feed URL: https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *
 * Used by ftmoDaytrade24h's newsFilter to skip trade entries within
 * ±N minutes of a high-impact news release (FTMO rule: no trades
 * within 2 minutes before/after scheduled high-impact news).
 */

export interface NewsEvent {
  /** Unix ms timestamp */
  timestamp: number;
  impact: "Low" | "Medium" | "High" | "Holiday";
  currency: string;
  title: string;
}

interface FFEntry {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast?: string;
  previous?: string;
}

/**
 * Fetch this week's economic calendar from ForexFactory.
 * Returns entries with ISO-8601 timestamps parsed to epoch millis.
 */
export async function loadForexFactoryNews(
  signal?: AbortSignal,
): Promise<NewsEvent[]> {
  const res = await fetch(
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    {
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
    },
  );
  if (!res.ok) throw new Error(`ForexFactory fetch ${res.status}`);
  const raw = (await res.json()) as FFEntry[];
  const out: NewsEvent[] = [];
  for (const e of raw) {
    const ts = new Date(e.date).getTime();
    if (!Number.isFinite(ts)) continue;
    const impact = normalizeImpact(e.impact);
    if (!impact) continue;
    out.push({
      timestamp: ts,
      impact,
      currency: e.country,
      title: e.title,
    });
  }
  return out;
}

function normalizeImpact(raw: string): NewsEvent["impact"] | null {
  const s = raw.toLowerCase().trim();
  if (s === "low") return "Low";
  if (s === "medium") return "Medium";
  if (s === "high") return "High";
  if (s === "holiday") return "Holiday";
  return null;
}

/**
 * Filter events by impact level and currency set.
 * Default: High-impact only, USD + EUR + GBP (most likely to move crypto).
 */
export function filterNewsEvents(
  events: NewsEvent[],
  opts: {
    impacts?: Array<NewsEvent["impact"]>;
    currencies?: string[];
  } = {},
): NewsEvent[] {
  const impacts = new Set(opts.impacts ?? ["High"]);
  const currencies = new Set(opts.currencies ?? ["USD", "EUR", "GBP"]);
  return events.filter(
    (e) => impacts.has(e.impact) && currencies.has(e.currency),
  );
}

/**
 * Is `ts` within ±bufferMinutes of any event in `events`?
 * Used at the trade-entry check to implement FTMO's news-buffer rule.
 */
export function isNewsBlackout(
  ts: number,
  events: NewsEvent[],
  bufferMinutes: number,
): boolean {
  const bufferMs = bufferMinutes * 60_000;
  for (const e of events) {
    if (Math.abs(ts - e.timestamp) <= bufferMs) return true;
  }
  return false;
}
