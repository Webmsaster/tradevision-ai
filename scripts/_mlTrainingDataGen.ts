/**
 * R29-Track-B1: Generate ML training data — labeled trades from
 * V5_TITANIUM_PASSLOCK over the full available 30m candle history.
 *
 * R29-R2.4 fix: training distribution comes from `runFtmoDaytrade24h`
 * (the same harness used live), NOT raw `detectAsset` output. Earlier
 * versions trained on every signal `detectAsset` emitted; the live
 * harness drops trades for `maxConcurrentTrades`, `allowedHoursUtc`,
 * `intradayDailyLossThrottle`, etc. — so the model saw ~20-40% MORE
 * trades than would ever fire live, and learned splits on a biased
 * feature distribution. This generator now disables the FTMO challenge
 * pass-condition (profit target = ∞, maxDays = ∞) and returns every
 * `executed` trade across the full candle history.
 *
 * Features per entry:
 *   - rsi14, rsi28
 *   - adx14
 *   - atr14_pct (atr / price)
 *   - sma20_slope, sma50_slope, sma200_slope (% change over period)
 *   - hour (0..23), dow (0..6)
 *   - bar_color_run (last N bars same colour)
 *   - prior_5bar_return, prior_20bar_return
 *   - asset_id (one-hot index in V5_TITANIUM basket)
 *   - direction_long (0|1)
 *   - funding_rate (R29-R2.5; perpetual carry at last 8h event ≤ entry)
 *
 * Label:
 *   - effPnl (signed effective PnL of the trade)
 *   - is_win (effPnl > 0)
 *   - is_full_tp (exitReason == "tp" && rawPnl >= tpPct * 0.99)
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import {
  rsi as rsiSeries,
  adx as adxSeries,
  atr as atrSeries,
  sma as smaSeries,
} from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const OUT_FILE = `${CACHE_DIR}/ml_training.jsonl`;

const SYMBOLS = (
  FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK.assets as Array<{
    symbol: string;
    sourceSymbol?: string;
  }>
).map((a) => a.sourceSymbol ?? a.symbol.replace("-TREND", "USDT"));

console.log(
  `[ml-data] generating training set across ${SYMBOLS.length} assets`,
);

function loadCandles(sym: string): Candle[] {
  const p = `${CACHE_DIR}/${sym}_30m.json`;
  if (!existsSync(p)) {
    console.error(`MISSING ${p}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

interface FundingBar {
  t: number; // funding timestamp ms (8h-aligned for perp futures)
  r: number; // signed rate; long pays positive
}

/**
 * R29-R2.5: load and forward-fill the funding-rate series. File schema is
 * `[{t, r}, ...]` from Binance perp endpoint. Returned vector aligned with
 * candle bar-indices via `findFundingAt(idx)`.
 */
function loadFunding(sym: string): FundingBar[] {
  const p = `${CACHE_DIR}/${sym}_funding.json`;
  if (!existsSync(p)) {
    return [];
  }
  return JSON.parse(readFileSync(p, "utf-8")) as FundingBar[];
}

function findFundingAt(funding: FundingBar[], tsMs: number): number | null {
  if (funding.length === 0) return null;
  // binary search: latest bar with t <= tsMs
  let lo = 0;
  let hi = funding.length - 1;
  if (funding[0]!.t > tsMs) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (funding[mid]!.t <= tsMs) lo = mid;
    else hi = mid - 1;
  }
  return funding[lo]!.r;
}

interface TrainingRow {
  symbol: string;
  asset_id: number;
  direction_long: number;
  entry_time: number;
  exit_time: number;
  rsi14: number | null;
  rsi28: number | null;
  adx14: number | null;
  atr14_pct: number | null;
  sma20_slope: number | null;
  sma50_slope: number | null;
  sma200_slope: number | null;
  hour: number;
  dow: number;
  prior5_return: number | null;
  prior20_return: number | null;
  /**
   * R29-R2.5 — funding rate at the latest 8h-funding event ≤ entry bar
   * (perpetual-futures cost-of-carry signal). Long positions pay a positive
   * funding rate, short positions earn it. Typical magnitude 5–30bp per
   * trade across the V5_TITANIUM/PASSLOCK basket; sign flips intraday on
   * trending/ranging regimes. Null only when no funding bar precedes the
   * entry (cold-start window). Aligned with `_r29ForwardFillFunding.ts`.
   */
  funding_rate: number | null;
  raw_pnl: number;
  eff_pnl: number;
  exit_reason: string;
  is_win: number;
  is_full_tp: number;
}

const rows: TrainingRow[] = [];
const seenSyms: string[] = [];

// R29-R2.4: load every asset's candles + funding once. Pre-compute indicator
// series per symbol so trade-level feature lookups stay O(1).
const candlesBySymbol: Record<string, Candle[]> = {};
const fundingBySymbol: Record<string, (number | null)[]> = {};
const fundingRawBySymbol: Record<string, FundingBar[]> = {};
const indicatorsBySymbol: Record<
  string,
  {
    closes: number[];
    rsi14: (number | null)[];
    rsi28: (number | null)[];
    adx14: (number | null)[];
    atr14: (number | null)[];
    sma20: (number | null)[];
    sma50: (number | null)[];
    sma200: (number | null)[];
  }
> = {};
const symToAssetIdx: Record<string, number> = {};

for (const [assetIdx, asset] of (
  FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK.assets as Array<{
    symbol: string;
    sourceSymbol?: string;
    [k: string]: unknown;
  }>
).entries()) {
  const sym = asset.sourceSymbol ?? asset.symbol.replace("-TREND", "USDT");
  console.log(`[ml-data] loading ${sym} (asset_id=${assetIdx})...`);
  seenSyms.push(sym);
  const candles = loadCandles(sym);
  const fundingRaw = loadFunding(sym);
  if (fundingRaw.length === 0) {
    console.warn(`[ml-data] no funding file for ${sym} — funding_rate=null`);
  }
  candlesBySymbol[sym] = candles;
  fundingRawBySymbol[sym] = fundingRaw;
  symToAssetIdx[sym] = assetIdx;
  // Forward-fill funding to candle alignment for runFtmoDaytrade24h.
  fundingBySymbol[sym] = candles.map((c) =>
    findFundingAt(fundingRaw, c.openTime),
  );
  const closes = candles.map((c) => c.close);
  indicatorsBySymbol[sym] = {
    closes,
    rsi14: rsiSeries(closes, 14),
    rsi28: rsiSeries(closes, 28),
    adx14: adxSeries(candles, 14).adx,
    atr14: atrSeries(candles, 14),
    sma20: smaSeries(closes, 20),
    sma50: smaSeries(closes, 50),
    sma200: smaSeries(closes, 200),
  };
}

// R29-R2.4: drive trade generation through the live harness so the train
// distribution matches the runtime distribution. Disable the FTMO challenge
// stop conditions (target / maxDays) by overriding a deep-copied cfg — the
// asset list / liveCaps / per-asset overrides stay intact.
const trainCfg = JSON.parse(
  JSON.stringify(FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK),
) as typeof FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK;
trainCfg.profitTarget = 9999; // unreachable → engine never pauses or finishes
trainCfg.maxDays = 99999; // covers full multi-year candle history
trainCfg.minTradingDays = 0;
// Disable PASSLOCK so close-all-on-target doesn't truncate the trade stream.
trainCfg.closeAllOnTargetReached = false;
trainCfg.pauseAtTargetReached = false;

console.log(
  `[ml-data] running runFtmoDaytrade24h across ${seenSyms.length} symbols (target/maxDays disabled for training)...`,
);
const result = runFtmoDaytrade24h(candlesBySymbol, trainCfg, fundingBySymbol);
console.log(
  `[ml-data] harness emitted ${result.trades.length} executed trades (post-gating).`,
);

for (const t of result.trades) {
  const sym =
    (t as Daytrade24hTrade & { sourceSymbol?: string }).sourceSymbol ??
    t.symbol;
  const lookupKey = candlesBySymbol[sym] ? sym : t.symbol;
  const candles = candlesBySymbol[lookupKey];
  const ind = indicatorsBySymbol[lookupKey];
  const fundingRaw = fundingRawBySymbol[lookupKey];
  const assetIdx = symToAssetIdx[lookupKey];
  if (!candles || !ind || assetIdx === undefined) {
    console.warn(`[ml-data] orphan trade for symbol ${t.symbol} — skipping`);
    continue;
  }
  const { rsi14, rsi28, adx14, atr14, sma20, sma50, sma200 } = ind;
  {
    const entryIdx = candles.findIndex((c) => c.openTime === t.entryTime);
    if (entryIdx < 201) continue; // need 200 bars history for sma200 slope
    // R29-Audit-2026-05-10: CRITICAL FIX. Entry happens at candles[entryIdx].open.
    // At decision time (bar entryIdx's open_time), bars [0..entryIdx-1] are
    // fully known but bar `entryIdx` is JUST STARTING — its close/high/low
    // are FUTURE. Compute all features at bar i = entryIdx-1 (last fully
    // closed bar). Otherwise the model sees the entry bar's complete
    // movement and gets a free look at the trade's first-bar direction.
    const i = entryIdx - 1;
    const px = candles[i]!.close;
    const px5 = candles[i - 5]?.close ?? px;
    const px20 = candles[i - 20]?.close ?? px;
    const sma20_lookback = sma20[Math.max(0, i - 20)] ?? sma20[i] ?? null;
    const sma50_lookback = sma50[Math.max(0, i - 50)] ?? sma50[i] ?? null;
    const sma200_lookback = sma200[Math.max(0, i - 200)] ?? sma200[i] ?? null;
    const sma20_slope =
      sma20[i] !== null && sma20_lookback !== null
        ? (sma20[i]! - sma20_lookback) / sma20_lookback
        : null;
    const sma50_slope =
      sma50[i] !== null && sma50_lookback !== null
        ? (sma50[i]! - sma50_lookback) / sma50_lookback
        : null;
    const sma200_slope =
      sma200[i] !== null && sma200_lookback !== null
        ? (sma200[i]! - sma200_lookback) / sma200_lookback
        : null;
    const dt = new Date(t.entryTime);
    const hour = dt.getUTCHours();
    const dow = dt.getUTCDay();
    const atrPct = atr14[i] !== null ? atr14[i]! / px : null;
    // R29-R2.5: funding rate at last 8h event ≤ candle[i].openTime. Use the
    // last-fully-closed bar's open timestamp so the model never peeks at a
    // funding bar published after entry.
    const fundingAt = findFundingAt(fundingRaw, candles[i]!.openTime);
    const isWin = t.effPnl > 0 ? 1 : 0;
    // Full TP = tp reason AND raw pnl reached at least 95% of asset.tpPct.
    const assetCfg = (
      FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK.assets as Array<{
        symbol: string;
        sourceSymbol?: string;
        tpPct?: number;
      }>
    ).find(
      (a) =>
        (a.sourceSymbol ?? a.symbol.replace("-TREND", "USDT")) === lookupKey,
    );
    const tpFrac =
      assetCfg?.tpPct ?? FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK.tpPct;
    const isFullTp =
      t.exitReason === "tp" && Math.abs(t.rawPnl) >= tpFrac * 0.95 ? 1 : 0;

    rows.push({
      symbol: lookupKey,
      asset_id: assetIdx,
      direction_long: t.direction === "long" ? 1 : 0,
      entry_time: t.entryTime,
      exit_time: t.exitTime,
      rsi14: rsi14[i],
      rsi28: rsi28[i],
      adx14: adx14[i],
      atr14_pct: atrPct,
      sma20_slope,
      sma50_slope,
      sma200_slope,
      hour,
      dow,
      prior5_return: (px - px5) / px5,
      prior20_return: (px - px20) / px20,
      funding_rate: fundingAt,
      raw_pnl: t.rawPnl,
      eff_pnl: t.effPnl,
      exit_reason: t.exitReason,
      is_win: isWin,
      is_full_tp: isFullTp,
    });
  }
}

writeFileSync(OUT_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const wins = rows.filter((r) => r.is_win).length;
const tps = rows.filter((r) => r.is_full_tp).length;
console.log(
  `[ml-data] DONE: ${rows.length} trades / wins=${wins} (${(
    (100 * wins) /
    rows.length
  ).toFixed(1)}%) / fullTPs=${tps} → ${OUT_FILE}`,
);
