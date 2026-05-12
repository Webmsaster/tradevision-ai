/**
 * Round 60 — Time-of-Day gate sweep (memory-efficient single-process variant).
 *
 * Loads candle cache ONCE, then simulates ALL variants per window. Avoids
 * the per-shard cache reload that was thrashing swap on a contended box.
 *
 * Args:
 *   process.argv[2] = SHARD_IDX    (0-based, default 0)
 *   process.argv[3] = SHARD_COUNT  (default 1)
 *   process.argv[4] = VARIANTS_CSV (e.g. "V1,V2,V3,V4,V5", default = all)
 *
 * Outputs JSON-line per (variant,window) to
 *   scripts/cache_bakeoff/r28v7_tod_<VARIANT>_shard_<idx>.jsonl
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const VARIANTS_CSV = process.argv[4] ?? "V1,V2,V3,V4,V5";
const VARIANTS = VARIANTS_CSV.split(",").map((s) => s.trim().toUpperCase());

const SYMBOLS = [
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

function loadAligned(): { aligned: Record<string, Candle[]>; minBars: number } {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  }
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

function buildCfg(variant: string): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  const baseHours = base.allowedHoursUtc ?? [];
  switch (variant) {
    case "V0":
      return base;
    case "V1": {
      const allowed = baseHours.filter((h) => h >= 4 && h <= 23);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V2": {
      const allowed = baseHours.filter((h) => h >= 4 && h <= 21);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V3": {
      const allowed = baseHours.filter((h) => h >= 8 && h <= 21);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V4": {
      const allowed = baseHours.filter((h) => h >= 12 && h <= 19);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V5":
      return { ...base, allowedDowsUtc: [1, 2, 3, 4, 5] };
    default:
      throw new Error(`Unknown variant: ${variant}`);
  }
}

const cfgs: Record<string, FtmoDaytrade24hConfig> = {};
for (const v of VARIANTS) cfgs[v] = buildCfg(v);

// Truncate output files for assigned shard
for (const v of VARIANTS) {
  writeFileSync(`${CACHE_DIR}/r28v7_tod_${v}_shard_${SHARD_IDX}.jsonl`, "");
}

console.log(
  `[multi shard ${SHARD_IDX}/${SHARD_COUNT}] variants=${VARIANTS.join(",")}`,
);
for (const v of VARIANTS) {
  console.log(
    `  ${v}: hours=${JSON.stringify(cfgs[v]!.allowedHoursUtc)}  dows=${JSON.stringify(cfgs[v]!.allowedDowsUtc)}`,
  );
}

const { aligned, minBars } = loadAligned();
const cfg0 = cfgs[VARIANTS[0]!]!;
const winBars = cfg0.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

let winIdx = 0;
const t0 = Date.now();
for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  for (const v of VARIANTS) {
    const r = simulate(
      trimmed,
      cfgs[v]!,
      WARMUP,
      WARMUP + winBars,
      `R28V7_TOD_${v}`,
    );
    const out = {
      winIdx,
      passed: r.passed,
      reason: r.reason,
      passDay: r.passDay ?? null,
      finalEquityPct: r.finalEquityPct,
    };
    appendFileSync(
      `${CACHE_DIR}/r28v7_tod_${v}_shard_${SHARD_IDX}.jsonl`,
      JSON.stringify(out) + "\n",
    );
  }
  console.log(
    `[multi shard ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} done all-variants t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[multi shard ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
