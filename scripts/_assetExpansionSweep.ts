/**
 * Asset-Erweiterung sweep — measure pass-rate as basket size grows.
 *
 * Greedy single-add on top of V5_TITANIUM (14 assets):
 *   1. Baseline = V5_TITANIUM 14 assets.
 *   2. Try each cached candidate not yet in the basket; rank by Δ pass-rate.
 *   3. Add the top candidate; repeat until 20 assets (or no candidate
 *      delivers ≥ +0.5pp).
 *
 * Output JSONL: one line per (basket_size, asset_added, pass_rate, win_rate, max_dd).
 *
 * Usage: npx tsx scripts/_assetExpansionSweep.ts [shard] [shardCount]
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const OUT = `${CACHE_DIR}/asset_expansion_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT, "");

// Asset baskets — base = V5_TITANIUM (14), candidates = 10 additional cached.
const BASE_BASKET = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "ETCUSDT",
  "XRPUSDT",
  "AAVEUSDT",
  "SOLUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "RUNEUSDT",
];
const CANDIDATES = [
  "INJUSDT",
  "SANDUSDT",
  "ATOMUSDT",
  "DOTUSDT",
  "ARBUSDT",
  "ALGOUSDT",
  "NEARUSDT",
  "STXUSDT",
  "TRXUSDT",
  "UNIUSDT",
];

function loadAligned(symbols: string[]) {
  const data: Record<string, Candle[]> = {};
  for (const s of symbols) {
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  }
  const sets = symbols.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...symbols.map((s) => aligned[s]!.length)),
  };
}

function buildAssetsForBasket(basket: string[]): Daytrade24hAssetCfg[] {
  // Mirror R28_V6 cohort tp_pct overrides on the V5_QUARTZ baseline.
  // For new candidates we use the V5_DIAMOND default 0.04 × 0.55 = 0.022.
  const TP_BY_SYMBOL: Record<string, number> = {
    BTCUSDT: 0.00825,
    BNBUSDT: 0.00825,
    ADAUSDT: 0.00825,
    BCHUSDT: 0.00825,
    ETCUSDT: 0.00825,
    ETHUSDT: 0.011,
    AAVEUSDT: 0.01375,
    XRPUSDT: 0.0165,
    LTCUSDT: 0.01925,
  };
  return basket.map((src) => ({
    symbol: `${src.replace("USDT", "")}-TREND`,
    sourceSymbol: src,
    tpPct: TP_BY_SYMBOL[src] ?? 0.022,
    stopPct: 0.05,
    riskFrac: 0.4,
  }));
}

function runBasket(basket: string[], label: string) {
  const { aligned, minBars } = loadAligned(basket);
  const cfg: FtmoDaytrade24hConfig = {
    ...FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
    assets: buildAssetsForBasket(basket),
  };
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let pass = 0,
    total = 0;
  let winSum = 0,
    winCount = 0;
  const equityFinals: number[] = [];
  for (
    let start = WARMUP, idx = 0;
    start + winBars <= minBars;
    start += stepBars, idx++
  ) {
    if (idx % SHARD_COUNT !== SHARD_IDX) continue;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned)) {
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    }
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, label);
    if (r.passed) pass++;
    total++;
    equityFinals.push(r.finalEquityPct);
    if (r.trades) {
      const wins = r.trades.filter((t) => t.effPnl > 0).length;
      winSum += wins;
      winCount += r.trades.length;
    }
  }
  return {
    label,
    basket_size: basket.length,
    pass_count: pass,
    total,
    pass_rate: total ? pass / total : 0,
    win_rate: winCount ? winSum / winCount : 0,
    median_eq: median(equityFinals),
    p10_eq: quantile(equityFinals, 0.1),
    p90_eq: quantile(equityFinals, 0.9),
  };
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.max(0, Math.floor(s.length * q));
  return s[Math.min(i, s.length - 1)]!;
}

console.log(
  `[expansion ${SHARD_IDX}/${SHARD_COUNT}] baseline 14 + greedy add up to 20`,
);

// Greedy single-add: start from base, add one at a time.
let basket = [...BASE_BASKET];
const remaining = [...CANDIDATES];
const baseline = runBasket(basket, "V5_TITANIUM_14");
appendFileSync(OUT, JSON.stringify(baseline) + "\n");
console.log(
  `  base ${basket.length}: pass=${baseline.pass_count}/${baseline.total} = ${(baseline.pass_rate * 100).toFixed(2)}% wr=${(baseline.win_rate * 100).toFixed(1)}%`,
);

while (basket.length < 20 && remaining.length > 0) {
  let bestPass = baseline.pass_rate,
    bestAsset: string | null = null,
    bestRow: typeof baseline | null = null;
  for (const cand of remaining) {
    const trial = [...basket, cand];
    const row = runBasket(trial, `V5_TITANIUM_${trial.length}_${cand}`);
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    if (row.pass_rate > bestPass) {
      bestPass = row.pass_rate;
      bestAsset = cand;
      bestRow = row;
    }
  }
  if (!bestAsset || !bestRow) {
    console.log(
      `  no candidate improved pass-rate; stopping greedy at ${basket.length}`,
    );
    break;
  }
  basket.push(bestAsset);
  remaining.splice(remaining.indexOf(bestAsset), 1);
  console.log(
    `  +${bestAsset} → basket=${basket.length} pass=${bestRow.pass_count}/${bestRow.total} = ${(bestRow.pass_rate * 100).toFixed(2)}%`,
  );
  appendFileSync(
    OUT,
    JSON.stringify({
      marker: "greedy_pick",
      basket_size: basket.length,
      asset: bestAsset,
      pass_rate: bestRow.pass_rate,
    }) + "\n",
  );
}

console.log(`[expansion ${SHARD_IDX}/${SHARD_COUNT}] DONE → ${OUT}`);
