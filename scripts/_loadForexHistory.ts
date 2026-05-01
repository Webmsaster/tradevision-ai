/**
 * Forex history loader (Yahoo Finance v8 chart API).
 *
 * Yahoo intraday range limits per interval:
 *   1m/2m/5m: 7 days
 *   15m/30m: 60 days   (too short for 30d-window FTMO sweeps with multi-year data)
 *   60m/1h:  730 days  (~2 years — primary intraday source)
 *   4h:      730 days
 *   1d:      max (10y+)
 *
 * Strategy:
 *   - For 1h/2h backtests: pull 1h with range=2y, resample to 2h via the
 *     existing resampleCandles helper from _loadYahooHistory.ts.
 *   - For long-history sanity validation: pull 1d.
 *
 * Forex pairs use Yahoo "=X" suffix:
 *   EURUSD=X, GBPUSD=X, USDJPY=X, AUDUSD=X, USDCAD=X, NZDUSD=X, USDCHF=X.
 *
 * The Yahoo 1h forex feed reflects spot OTC mid-prices (volume column is
 * always 0 in forex). Volume is filled with a constant 1,000,000 placeholder
 * downstream so that ATR/percentile calculations don't divide by zero.
 */
import type { Candle } from "../src/utils/indicators";
import { loadYahooIntraday, resampleCandles } from "./_loadYahooHistory";

export const FOREX_MAJORS = [
  "EURUSD=X",
  "GBPUSD=X",
  "USDJPY=X",
  "AUDUSD=X",
  "USDCAD=X",
  "NZDUSD=X",
] as const;

export type ForexSymbol = (typeof FOREX_MAJORS)[number];

export interface ForexLoadOptions {
  /** Engine timeframe to deliver. Yahoo natively supports 1h; we resample
   *  to 2h via openTime bucketing. 30m is NOT recommended (60d limit). */
  timeframe: "1h" | "2h" | "4h" | "1d";
  /** Yahoo range string. Use "2y" for max-1h history, "max" for 1d. */
  range?: string;
}

const TF_MS: Record<string, number> = {
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/**
 * Load a single forex symbol at the requested engine timeframe.
 * 2h is built by resampling 1h (Yahoo doesn't support 2h natively).
 */
export async function loadForexSymbol(
  symbol: string,
  opts: ForexLoadOptions,
): Promise<Candle[]> {
  const { timeframe } = opts;
  if (timeframe === "1h") {
    const range = opts.range ?? "2y";
    return loadYahooIntraday(symbol, "1h", range);
  }
  if (timeframe === "2h") {
    const range = opts.range ?? "2y";
    const hourly = await loadYahooIntraday(symbol, "1h", range);
    return resampleCandles(hourly, TF_MS["2h"]);
  }
  if (timeframe === "4h") {
    const range = opts.range ?? "2y";
    return loadYahooIntraday(symbol, "4h", range);
  }
  if (timeframe === "1d") {
    const range = opts.range ?? "max";
    return loadYahooIntraday(symbol, "1d", range);
  }
  throw new Error(`Unsupported forex timeframe: ${timeframe}`);
}

/**
 * Load all forex majors in parallel. Returns map symbol -> Candle[].
 * Symbols that fail are omitted from the result (with a warning log).
 */
export async function loadForexMajors(
  opts: ForexLoadOptions,
  symbols: readonly string[] = FOREX_MAJORS,
): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  const results = await Promise.all(
    symbols.map(async (s) => {
      try {
        const c = await loadForexSymbol(s, opts);
        return { s, c };
      } catch (e) {
        console.warn(`[forex-loader] ${s} failed: ${(e as Error).message}`);
        return null;
      }
    }),
  );
  for (const r of results) if (r) out[r.s] = r.c;
  return out;
}

/**
 * Align all symbols to the common-intersection of openTime values.
 * Required for FTMO walk-forward windows where all assets must share bars.
 */
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
