/**
 * R29-Track-B1: Generate ML training data — labeled trades from
 * V5_TITANIUM_PASSLOCK over the full available 30m candle history.
 *
 * For each trade emitted by detectAsset, compute features at entry-bar and
 * label win/loss. Output: scripts/cache_bakeoff/ml_training.jsonl
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
 *
 * Label:
 *   - effPnl (signed effective PnL of the trade)
 *   - is_win (effPnl > 0)
 *   - is_full_tp (exitReason == "tp" && rawPnl >= tpPct * 0.99)
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  detectAsset,
  FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK,
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
  raw_pnl: number;
  eff_pnl: number;
  exit_reason: string;
  is_win: number;
  is_full_tp: number;
}

const rows: TrainingRow[] = [];
const seenSyms: string[] = [];

for (const [assetIdx, asset] of (
  FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK.assets as Array<{
    symbol: string;
    sourceSymbol?: string;
    [k: string]: unknown;
  }>
).entries()) {
  const sym = asset.sourceSymbol ?? asset.symbol.replace("-TREND", "USDT");
  console.log(`[ml-data] processing ${sym} (asset_id=${assetIdx})...`);
  seenSyms.push(sym);
  const candles = loadCandles(sym);
  // Pre-compute indicator series.
  const closes = candles.map((c) => c.close);
  const rsi14 = rsiSeries(closes, 14);
  const rsi28 = rsiSeries(closes, 28);
  const adx14 = adxSeries(candles, 14).adx;
  const atr14 = atrSeries(candles, 14);
  const sma20 = smaSeries(closes, 20);
  const sma50 = smaSeries(closes, 50);
  const sma200 = smaSeries(closes, 200);

  // Run detectAsset to get all trades.
  const trades = detectAsset(
    candles,
    asset as Parameters<typeof detectAsset>[1],
    FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK,
  );

  for (const t of trades) {
    const i = candles.findIndex((c) => c.openTime === t.entryTime);
    if (i < 200) continue; // need 200 bars history for sma200 slope
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
    const isWin = t.effPnl > 0 ? 1 : 0;
    // Full TP = tp reason AND raw pnl reached at least 95% of asset.tpPct.
    const tpFrac =
      (asset as { tpPct?: number }).tpPct ??
      FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK.tpPct;
    const isFullTp =
      t.exitReason === "tp" && Math.abs(t.rawPnl) >= tpFrac * 0.95 ? 1 : 0;

    rows.push({
      symbol: sym,
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
