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
 *
 * Round 57 Fix 2 (2026-05-03): the live `thisweek` feed only covers a
 * 7-day window — useless for backtests spanning months/years. Use
 * `loadForexFactoryArchive(path)` to load a static archive JSON for
 * historical periods. The live `loadForexFactoryNews()` adds a 6h
 * disk cache to avoid re-fetching during repeated polls (the JSDoc
 * comment elsewhere claims "6h cached" but the cache was missing).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

const CACHE_PATH =
  process.env.FF_NEWS_CACHE ?? "scripts/cache_forex_2h/ff_news_cache.json";
const CACHE_TTL_MS = 6 * 3600_000;

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
 * Read the on-disk cache if fresh (TTL 6h). Returns null when missing
 * or stale, so the caller falls through to a network fetch.
 *
 * Phase R57 (Round 57 Forex Fix 2): without disk cache, every backtest
 * tick / poll re-fetches the live feed even though the comment claims
 * "6h cached". This wasted bandwidth and risked rate-limiting.
 */
function readCachedNews(): NewsEvent[] | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const stat = statSync(CACHE_PATH);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as NewsEvent[];
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedNews(events: NewsEvent[]): void {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(events), "utf-8");
  } catch {
    // Cache is best-effort — never fail the live load on cache-write
    // errors (e.g. read-only FS).
  }
}

/**
 * Load a static ForexFactory archive JSON from disk. Used by backtests
 * spanning periods longer than the live `thisweek` feed (~7 days).
 *
 * The archive must be an array of `NewsEvent` objects (timestamp in
 * epoch-ms, plus impact/currency/title). Generate it offline by
 * concatenating successive `thisweek` snapshots, or scrape from
 * forexfactory.com directly.
 *
 * Phase R57 (Round 57 Forex Fix 2): without an archive, a 1.4y forex
 * backtest had news data for ~7 of ~510 days — the news-blackout
 * filter had effectively zero effect on historical periods, so
 * backtest pass-rates were artificially inflated.
 */
export function loadForexFactoryArchive(path: string): NewsEvent[] {
  if (!existsSync(path)) {
    console.warn(
      `[forexFactoryNews] archive ${path} missing — backtest news-filter disabled`,
    );
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as NewsEvent[];
    if (!Array.isArray(parsed)) {
      console.warn(
        `[forexFactoryNews] archive ${path} is not a JSON array — disabling`,
      );
      return [];
    }
    return parsed;
  } catch (e) {
    console.warn(`[forexFactoryNews] archive ${path} parse-error: ${e}`);
    return [];
  }
}

/**
 * Fetch this week's economic calendar from ForexFactory. Returns
 * entries with ISO-8601 timestamps parsed to epoch millis.
 *
 * Disk-cached for 6h (TTL via {@link CACHE_TTL_MS}). Multiple imports
 * within the same 6h window dedup to a single network call.
 */
export async function loadForexFactoryNews(
  signal?: AbortSignal,
): Promise<NewsEvent[]> {
  // Disk cache short-circuit (Phase R57 Fix 2).
  const cached = readCachedNews();
  if (cached) return cached;

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
  // Persist to disk cache (best-effort) so subsequent imports within
  // the 6h TTL skip the network call.
  writeCachedNews(out);
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
 * Map a forex pair symbol to the two currencies that affect it.
 * Yahoo-style suffixes (`=X`) and lowercase are tolerated.
 *
 * Examples:
 *   "EURUSD=X" → ["EUR", "USD"]
 *   "USDJPY=X" → ["USD", "JPY"]
 *   "GBPUSD"   → ["GBP", "USD"]
 *
 * Returns an empty array for inputs that are not 6-letter pair stems
 * (e.g. crypto tickers, indices) so callers can safely union the
 * results across mixed baskets.
 *
 * Phase R57 (Round 57 Forex Fix 3): previously {@link filterNewsEvents}
 * accepted only a flat `currencies` list, so callers had to union
 * pair-sides manually — and most forgot the second side, e.g. only
 * "USD" was passed for a USDJPY-heavy basket so JPY-impact events
 * were silently ignored.
 */
export function pairToCurrencies(symbol: string): string[] {
  const stem = symbol.replace(/=X$/i, "").toUpperCase();
  if (stem.length !== 6) return [];
  return [stem.slice(0, 3), stem.slice(3, 6)];
}

/**
 * Filter events by impact level and currency set.
 * Default: High-impact only, USD + EUR + GBP (most likely to move crypto).
 *
 * Pass `affectedPairs` to derive the currency set from forex symbols
 * automatically (handles both pair-sides via {@link pairToCurrencies}).
 * If both `currencies` and `affectedPairs` are supplied they are
 * unioned.
 */
export function filterNewsEvents(
  events: NewsEvent[],
  opts: {
    impacts?: Array<NewsEvent["impact"]>;
    currencies?: string[];
    affectedPairs?: string[];
  } = {},
): NewsEvent[] {
  const impacts = new Set(opts.impacts ?? ["High"]);
  let currencies: Set<string>;
  if (opts.affectedPairs && opts.affectedPairs.length > 0) {
    currencies = new Set(opts.currencies ?? []);
    for (const sym of opts.affectedPairs) {
      for (const c of pairToCurrencies(sym)) currencies.add(c);
    }
  } else {
    currencies = new Set(opts.currencies ?? ["USD", "EUR", "GBP"]);
  }
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
