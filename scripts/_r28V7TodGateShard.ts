/**
 * Round 60 — Time-of-Day entry-gate sweep on R28_V6 base.
 *
 * Tests whether filtering low-liquidity UTC hours improves pass-rate from
 * the R28_V6 baseline 56.62% (5.55y / 136 windows / V4-Engine).
 *
 * Variants (allowedHoursUtc applied as INTERSECTION with R28_V6 base
 * [4,6,8,10,14,18,22]; allowedDowsUtc replaces the unset baseline):
 *   V0 = baseline (no override) — must reproduce 56.62%
 *   V1 = skip 00-04 UTC (Asia early)        → kept: 4,6,8,10,14,18,22
 *   V2 = skip 22-04 UTC (Asia all night)    → kept: 6,8,10,14,18
 *   V3 = only 08-22 UTC (London + NY)       → kept: 8,10,14,18
 *   V4 = only 12-20 UTC (NY core)           → kept: 14,18
 *   V5 = only Mon-Fri (DOW gate, hours unchanged)
 *
 * NOTE: V0/V1 are EQUIVALENT (R28_V6 base already drops 0-3). Kept for
 * audit-trail parity with the brief.
 *
 * Args:
 *   process.argv[2] = VARIANT      (V0..V5)
 *   process.argv[3] = SHARD_IDX    (0-based)
 *   process.argv[4] = SHARD_COUNT
 *
 * Outputs JSON-line per window to stdout AND
 * scripts/cache_bakeoff/r28v7_tod_<VARIANT>_shard_<idx>.jsonl.
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const VARIANT = (process.argv[2] ?? "V0").toUpperCase();
const SHARD_IDX = parseInt(process.argv[3] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[4] ?? "1", 10);
const OUT_FILE = `${CACHE_DIR}/r28v7_tod_${VARIANT}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, ""); // truncate

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

// Build cfg per variant — R28_V6 base allowedHoursUtc = [4,6,8,10,14,18,22].
function buildCfg(): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  const baseHours = base.allowedHoursUtc ?? [];
  // Intersect with desired band(s) — keeps strategy-equivalent semantics.
  switch (VARIANT) {
    case "V0":
      return base;
    case "V1": {
      // skip 00-04 (kept range = 4..23). 4 is on boundary; "skip 00-04"
      // typically reads as drop 0,1,2,3,4 — be conservative and drop 0-3
      // INCLUSIVE of 03 only (i.e. allow >=4). Matches user spec
      // "00:00-04:00 UTC" → 0,1,2,3 are inside that window, 04:00 starts
      // the boundary so kept.
      const allowed = baseHours.filter((h) => h >= 4 && h <= 23);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V2": {
      // skip 22-04 (drops 22,23,0,1,2,3 — 04:00 boundary kept)
      const allowed = baseHours.filter((h) => h >= 4 && h <= 21);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V3": {
      // only 08-22 UTC (London + NY; 22:00 boundary excluded → 8..21)
      const allowed = baseHours.filter((h) => h >= 8 && h <= 21);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V4": {
      // only 12-20 UTC (NY core; 20:00 boundary excluded → 12..19)
      const allowed = baseHours.filter((h) => h >= 12 && h <= 19);
      return { ...base, allowedHoursUtc: allowed };
    }
    case "V5": {
      // Mon-Fri only (1..5). Hours unchanged.
      return { ...base, allowedDowsUtc: [1, 2, 3, 4, 5] };
    }
    default:
      throw new Error(`Unknown variant: ${VARIANT}`);
  }
}

const cfg = buildCfg();
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] VARIANT=${VARIANT}  hours=${JSON.stringify(cfg.allowedHoursUtc)}  dows=${JSON.stringify(cfg.allowedDowsUtc)}`,
);

const { aligned, minBars } = loadAligned();
const winBars = cfg.maxDays * 48;
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
  const r = simulate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    `R28V7_TOD_${VARIANT}`,
  );
  const out = {
    winIdx,
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
  };
  appendFileSync(OUT_FILE, JSON.stringify(out) + "\n");
  console.log(
    `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${VARIANT} win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${VARIANT} DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
