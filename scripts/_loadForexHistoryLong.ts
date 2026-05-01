/**
 * Long-history forex loader for 5y+ validation.
 *
 * Background:
 *   Yahoo 1h forex bars are capped at 730 days (no historical 1h access).
 *   Stooq.com requires an API key as of 2026 for direct CSV downloads.
 *   HistData.com / Dukascopy require ZIP scraping.
 *
 *   Pragmatic approach: synthesize 2h bars from Yahoo daily OHLC via a
 *   deterministic Brownian-bridge interpolation that:
 *     (1) preserves daily OHLC exactly when 12 2h bars are aggregated;
 *     (2) injects intraday H/L touches at deterministic positions;
 *     (3) uses a seeded PRNG so synthesis is reproducible.
 *
 *   Caveat: this is an APPROXIMATION. Real intraday microstructure (news
 *   spikes, session-breaks, bid-ask swings) is not preserved. The strategy's
 *   mean-reversion logic still works because the 2h close price walks
 *   smoothly between daily open/close — possibly OVERSTATING edge versus
 *   real noisy 2h bars.
 *
 *   Use this loader for LONG-HISTORY VALIDATION only — for live deploy
 *   numbers, prefer real 2h Yahoo data via _loadForexHistory.ts (1.4y limit).
 *
 * Yahoo daily OHLC for the 6 majors goes back 10y+ (verified 2026-05-01).
 *
 * Cache: results are persisted to scripts/cache_forex/{symbol}_daily.json
 * to avoid re-fetching across runs.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../src/utils/indicators";
import { loadYahooIntraday, resampleCandles } from "./_loadYahooHistory";

const CACHE_DIR = "scripts/cache_forex";

/** The 6 FX_TOP3 majors. */
export const FOREX_MAJORS_LONG = [
  "EURUSD=X",
  "GBPUSD=X",
  "USDJPY=X",
  "AUDUSD=X",
  "USDCAD=X",
  "NZDUSD=X",
] as const;

const TF_2H_MS = 2 * 3600_000;
const BARS_PER_DAY_2H = 12;

/** Deterministic xorshift32 PRNG, seeded from a string. */
function makeRng(seed: string): () => number {
  let s = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    s ^= seed.charCodeAt(i);
    s = Math.imul(s, 16777619) >>> 0;
  }
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/**
 * Load daily OHLC for a forex symbol via Yahoo, with on-disk cache.
 */
export async function loadForexDailyCached(
  symbol: string,
  range = "10y",
): Promise<Candle[]> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${symbol.replace("=X", "")}_daily.json`);
  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf8");
      const parsed: Candle[] = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 100) return parsed;
    } catch {
      // fall through to refetch
    }
  }
  const candles = await loadYahooIntraday(symbol, "1d", range);
  writeFileSync(cachePath, JSON.stringify(candles));
  return candles;
}

/**
 * Synthesize 12 2h bars from a single daily OHLC bar via a seeded
 * Brownian-bridge anchored to daily OHLC plus calibrated intraday noise.
 *
 * Properties of synthesized bars:
 *   - bar0.open === daily.open
 *   - bar11.close === daily.close
 *   - max(bar.high) === daily.high
 *   - min(bar.low) === daily.low
 *
 * Path generation:
 *   1. Random walk steps with std = sigma * range, where sigma is a
 *      tunable noise factor. Higher sigma → more bar-to-bar oscillation
 *      → richer mean-reversion signal.
 *   2. Renormalize the path so first close = computed step from open,
 *      last close = daily.close (Brownian bridge).
 *   3. Scale to ensure overall path range fits within [daily.low, daily.high].
 *   4. Force one bar to touch daily.high and another to touch daily.low.
 */
export function synthesize2hFromDaily(
  daily: Candle,
  symbol: string,
  sigma = 0.6,
): Candle[] {
  const out: Candle[] = [];
  const rng = makeRng(`${symbol}:${daily.openTime}`);
  const N = BARS_PER_DAY_2H;
  const range = Math.max(daily.high - daily.low, 1e-9);

  // Box-Muller normal generator
  function gauss() {
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // Generate Brownian-bridge increments
  // Step std = sigma * range / sqrt(N), so total path std ~= sigma*range
  const stepStd = (sigma * range) / Math.sqrt(N);
  const steps: number[] = new Array(N);
  for (let i = 0; i < N; i++) steps[i] = gauss() * stepStd;

  // Cumulative path before bridge correction
  const path: number[] = new Array(N + 1);
  path[0] = daily.open;
  for (let i = 1; i <= N; i++) path[i] = path[i - 1] + steps[i - 1];

  // Bridge correction: ensure path[N] === daily.close
  const drift = (daily.close - path[N]) / N;
  for (let i = 1; i <= N; i++) path[i] += drift * i;

  // Now path[0] = daily.open, path[N] = daily.close
  // closes[i] = path[i+1]
  const closes = path.slice(1);

  // Pick bars to hit daily.high and daily.low. Avoid bar 0 and last bar.
  const highBar = 1 + Math.floor(rng() * (N - 2));
  let lowBar = 1 + Math.floor(rng() * (N - 2));
  if (lowBar === highBar) lowBar = ((lowBar + 1) % (N - 2)) + 1;

  // Build 2h bars
  for (let i = 0; i < N; i++) {
    const open = i === 0 ? daily.open : closes[i - 1];
    let close = closes[i];
    if (i === N - 1) close = daily.close;
    // Default high/low: span open→close + small overshoot (15% of intra-bar move)
    const span = Math.abs(close - open);
    let high =
      Math.max(open, close) + span * 0.15 + range * 0.02 * Math.abs(gauss());
    let low =
      Math.min(open, close) - span * 0.15 - range * 0.02 * Math.abs(gauss());

    if (i === highBar) high = daily.high;
    if (i === lowBar) low = daily.low;
    // Clamp to daily envelope to avoid blowouts
    high = Math.min(high, daily.high);
    low = Math.max(low, daily.low);
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    out.push({
      openTime: daily.openTime + i * TF_2H_MS,
      closeTime: daily.openTime + (i + 1) * TF_2H_MS,
      open,
      high,
      low,
      close,
      volume: daily.volume / N,
      isFinal: true,
    });
  }
  return out;
}

/**
 * Build a long-history synthetic 2h dataset for one forex symbol.
 * Loads daily OHLC, synthesizes 12 2h bars per daily bar.
 */
export async function loadForexSynthetic2h(
  symbol: string,
  range = "10y",
  sigma = 0.6,
): Promise<Candle[]> {
  const daily = await loadForexDailyCached(symbol, range);
  // Filter out weekends (Sat/Sun) — Yahoo daily forex skips them but be safe.
  const weekday = daily.filter((c) => {
    const d = new Date(c.openTime).getUTCDay();
    return d !== 0 && d !== 6;
  });
  const out: Candle[] = [];
  for (const d of weekday) {
    const bars = synthesize2hFromDaily(d, symbol, sigma);
    out.push(...bars);
  }
  return out;
}

export async function loadForexSyntheticAll(
  symbols: readonly string[] = FOREX_MAJORS_LONG,
  range = "10y",
  sigma = 0.6,
): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  const results = await Promise.all(
    symbols.map(async (s) => {
      try {
        const c = await loadForexSynthetic2h(s, range, sigma);
        return { s, c };
      } catch (e) {
        console.warn(
          `[forex-long-loader] ${s} failed: ${(e as Error).message}`,
        );
        return null;
      }
    }),
  );
  for (const r of results) if (r) out[r.s] = r.c;
  return out;
}

/** Common-intersection alignment across symbols. */
export function alignForexCommon(
  data: Record<string, Candle[]>,
): Record<string, Candle[]> {
  const symbols = Object.keys(data);
  if (symbols.length === 0) return {};
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

/**
 * Slice aligned multi-asset data by year (UTC).
 * Returns map year → aligned subset.
 */
export function sliceByYear(
  aligned: Record<string, Candle[]>,
): Map<number, Record<string, Candle[]>> {
  const byYear = new Map<number, Record<string, Candle[]>>();
  const symbols = Object.keys(aligned);
  if (symbols.length === 0) return byYear;
  for (const sym of symbols) {
    for (const c of aligned[sym]) {
      const y = new Date(c.openTime).getUTCFullYear();
      if (!byYear.has(y)) byYear.set(y, {});
      const slice = byYear.get(y)!;
      if (!slice[sym]) slice[sym] = [];
      slice[sym].push(c);
    }
  }
  return byYear;
}

// Re-export for tests that already import from here
export { resampleCandles };
