/**
 * Round 67 R28_V6_PASSLOCK +DOGE +AVAX TS V4-Sim verification.
 *
 * Builds two configs:
 *   1. R28_V6_PASSLOCK baseline (9 assets)
 *   2. R28_V6_PASSLOCK + DOGE-TREND + AVAX-TREND (11 assets)
 *
 * Runs both over 137 windows (5.55y / 30m candles) sharded × 8.
 * Output JSONL row: { win_idx, baseline_passed, plus2_passed, ... }
 *
 * Usage: npx tsx scripts/_r28V6Plus2Shard.ts [shard] [shardCount]
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
const OUT = `${CACHE_DIR}/r28v6_plus2_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT, "");

const BASE_SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
];
const PLUS_SYMBOLS = [...BASE_SYMBOLS, "DOGEUSDT", "AVAXUSDT"];

function loadAligned(symbols: string[]) {
  const data: Record<string, Candle[]> = {};
  for (const s of symbols)
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
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

const baselineCfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
const baselineAssets: Daytrade24hAssetCfg[] = [...(baselineCfg.assets ?? [])];

// DOGE-TREND + AVAX-TREND specs cloned from V5_QUARTZ TREND family.
// FIX (Bug-Audit Round 67): tpPct uses mid-TP base (0.025) ×0.55 = 0.01375
// to match the AAVE cluster within R28_V6 family. Original 0.07 × 0.55 = 0.0385
// was a constructional bug — 0.07 is the V5_QUARTZ stop-pct base, not the
// R28_V6 per-asset TP magnitude. Existing R28_V6 cohort: 0.00825 / 0.011 /
// 0.01375 / 0.0165 / 0.01925 — DOGE/AVAX should be in mid-TP range.
const doge: Daytrade24hAssetCfg = {
  symbol: "DOGE-TREND",
  sourceSymbol: "DOGEUSDT",
  costBp: 30,
  slippageBp: 8,
  swapBpPerDay: 4,
  riskFrac: 1.0,
  triggerBars: 3,
  invertDirection: true,
  disableShort: true,
  stopPct: 0.05,
  tpPct: 0.025 * 0.55,
  holdBars: 180,
};
const avax: Daytrade24hAssetCfg = {
  symbol: "AVAX-TREND",
  sourceSymbol: "AVAXUSDT",
  costBp: 30,
  slippageBp: 8,
  swapBpPerDay: 4,
  riskFrac: 1.0,
  triggerBars: 3,
  invertDirection: true,
  disableShort: true,
  stopPct: 0.05,
  tpPct: 0.025 * 0.55,
  holdBars: 180,
};

const plus2Cfg: FtmoDaytrade24hConfig = {
  ...baselineCfg,
  assets: [...baselineAssets, doge, avax],
};

// FIX (Bug-Audit Round 67): Use SAME alignment basis (PLUS_SYMBOLS) for both
// configs so window time-ranges are identical. Original code used separate
// BASE_SYMBOLS / PLUS_SYMBOLS alignments → different timestamp intersections
// → different absolute start-times for "same winIdx" → not apples-to-apples.
const plusAlign = loadAligned(PLUS_SYMBOLS);
const aligned = plusAlign.aligned; // common-timestamps across all 11 assets

const winBars = baselineCfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

console.log(
  `[r28v6+2 ${SHARD_IDX}/${SHARD_COUNT}] aligned across ${PLUS_SYMBOLS.length} assets / ${plusAlign.minBars} bars (shared time-range)`,
);

let winIdx = 0;
const t0 = Date.now();

for (
  let start = WARMUP;
  start + winBars <= plusAlign.minBars;
  start += stepBars
) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  // Baseline (9 assets) — slice from common-aligned set
  const baseTrim: Record<string, Candle[]> = {};
  for (const k of BASE_SYMBOLS)
    baseTrim[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  const rb = simulate(baseTrim, baselineCfg, WARMUP, WARMUP + winBars, "BASE");

  // Plus-2 (11 assets) — same time-range
  const plusTrim: Record<string, Candle[]> = {};
  for (const k of PLUS_SYMBOLS)
    plusTrim[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  const rp = simulate(plusTrim, plus2Cfg, WARMUP, WARMUP + winBars, "PLUS2");

  appendFileSync(
    OUT,
    JSON.stringify({
      win_idx: winIdx,
      baseline_passed: rb.passed,
      baseline_eq: rb.finalEquityPct,
      baseline_reason: rb.reason,
      plus2_passed: rp.passed,
      plus2_eq: rp.finalEquityPct,
      plus2_reason: rp.reason,
    }) + "\n",
  );

  if (winIdx % 5 === 0) {
    const t = Math.round((Date.now() - t0) / 1000);
    console.log(
      `  win ${winIdx}: base=${rb.passed ? "✓" : "✗"} plus=${rp.passed ? "✓" : "✗"} t+${t}s`,
    );
  }
  winIdx++;
}

console.log(`[r28v6+2 ${SHARD_IDX}/${SHARD_COUNT}] DONE → ${OUT}`);
