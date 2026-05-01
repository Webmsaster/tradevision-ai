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
  // Phase 32 (Re-Audit FF Bug 8+9): manual AbortController instead of
  // AbortSignal.any (Node 20.0-20.2 doesn't have it). Plus streaming reader
  // with hard 5MB cut — was loading entire response into memory before
  // checking the cap → OOM-killable by malicious upstream.
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new Error("FF timeout")), 10_000);
  const onUserAbort = () => ac.abort(signal?.reason);
  if (signal) signal.addEventListener("abort", onUserAbort);
  const MAX_BYTES = 5_000_000;
  let res: Response;
  try {
    res = await fetch(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      {
        signal: ac.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
      },
    );
  } finally {
    if (signal) signal.removeEventListener("abort", onUserAbort);
  }
  if (!res.ok) {
    clearTimeout(timeout);
    throw new Error(`ForexFactory fetch ${res.status}`);
  }
  // Streaming read with size cap — never accumulate >5MB.
  const reader = res.body?.getReader();
  if (!reader) {
    clearTimeout(timeout);
    throw new Error("ForexFactory: no response body");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error(`ForexFactory response too large: >${MAX_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const txt = new TextDecoder().decode(buf);
  const raw = JSON.parse(txt) as FFEntry[];
  const out: NewsEvent[] = [];
  for (const e of raw) {
    const ts = parseFFDate(e.date);
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

/**
 * Parse a ForexFactory date string. The feed normally returns full ISO
 * with offset (e.g. "2024-04-29T08:30:00-04:00") which is unambiguous.
 *
 * BUGFIX 2026-04-28 (Round 36 Bug 4): if the feed ever drops the offset
 * (older formats, regression on FF's side), `new Date()` would interpret
 * the string in the Node process's LOCAL timezone — on a Windows VPS
 * not set to UTC, every news event shifts by hours and the news
 * blackout fires at the wrong time. Refuse such ambiguous strings
 * rather than silently misalign — caller will skip + log.
 */
function parseFFDate(s: string): number {
  if (!s || typeof s !== "string") return NaN;
  // Accept ISO with explicit zone (Z or ±HH:MM) only.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());
  if (!hasZone) {
    console.warn(
      `[forexFactoryNews] timezone-naive date "${s}" — refusing to parse (would shift on non-UTC hosts)`,
    );
    return NaN;
  }
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : NaN;
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
