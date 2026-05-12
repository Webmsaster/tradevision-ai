/**
 * R29 Round 7 — funding-rate-filter shard runner.
 *
 * Loads candles + Binance Futures funding-rate history, aligns funding
 * forward-fill to each candle's openTime, then runs simulate() with the
 * per-asset funding map so detectAsset's fundingRateFilter logic gates
 * entries when funding is extreme (crowded long/short).
 *
 * Usage: same args as _r29GenericShard.ts.
 */
import * as cfgModule from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const CONFIG_NAME = process.argv[2] ?? "";
const SLUG = process.argv[3] ?? "";
const SHARD_IDX = parseInt(process.argv[4] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[5] ?? "1", 10);
// Bug-Audit Round 3 (R3 fix 3): NaN/range-guard on shard CLI args.
if (
  !Number.isFinite(SHARD_IDX) ||
  !Number.isFinite(SHARD_COUNT) ||
  SHARD_COUNT < 1 ||
  SHARD_IDX < 0 ||
  SHARD_IDX >= SHARD_COUNT
) {
  console.error(
    `bad shard args: SHARD_IDX=${process.argv[4]} SHARD_COUNT=${process.argv[5]} (need 0 ≤ idx < count, count ≥ 1)`,
  );
  process.exit(2);
}

if (!CONFIG_NAME || !SLUG) {
  console.error("usage: <CONFIG_NAME> <slug> <shard_idx> <shard_count>");
  process.exit(2);
}

const cfg = (cfgModule as Record<string, unknown>)[CONFIG_NAME] as
  | (typeof cfgModule)["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK"]
  | undefined;
if (!cfg) {
  console.error(`config ${CONFIG_NAME} not found in ftmoDaytrade24h`);
  process.exit(2);
}

const OUT_FILE = `${CACHE_DIR}/r29_${SLUG}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, "");

// Bug-Audit Round 1: derive SYMBOLS from cfg.assets, not hardcoded.
const HARDCODED_FALLBACK = [
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
const cfgAssets = (
  cfg as { assets?: Array<{ sourceSymbol?: string; symbol: string }> }
).assets;
const SYMBOLS: string[] =
  cfgAssets && cfgAssets.length > 0
    ? [
        ...new Set(
          cfgAssets.map(
            (a) => a.sourceSymbol ?? a.symbol.replace(/-TREND$/, "USDT"),
          ),
        ),
      ]
    : HARDCODED_FALLBACK;
console.error(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${SLUG} using ${SYMBOLS.length} symbols: ${SYMBOLS.join(",")}`,
);

interface FundingPt {
  t: number;
  r: number;
}

/**
 * Forward-fill funding rate onto a candle openTime sequence.
 * For each candle at time c.openTime, find the largest fundingTime ≤ openTime
 * — that's the funding-rate active during the candle (paid every 8h cycle).
 * Returns null for candles before the first funding event.
 */
function alignFunding(
  candles: Candle[],
  funding: FundingPt[],
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length);
  let fIdx = 0;
  let cur: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i]!.openTime;
    while (fIdx < funding.length && funding[fIdx]!.t <= t) {
      cur = funding[fIdx]!.r;
      fIdx++;
    }
    out[i] = cur;
  }
  return out;
}

function loadAligned() {
  const data: Record<string, Candle[]> = {};
  const fundingByAsset: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS) {
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  }
  // Align candles across symbols on common openTimes.
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  // Load + align funding (after candle alignment so indices match the engine view).
  // Bug-Audit Round 1: tolerate missing funding cache (gate inactive instead of crashing).
  for (const s of SYMBOLS) {
    const fpath = `${CACHE_DIR}/${s}_funding.json`;
    if (existsSync(fpath)) {
      const funding: FundingPt[] = JSON.parse(readFileSync(fpath, "utf-8"));
      fundingByAsset[s] = alignFunding(aligned[s]!, funding);
    } else {
      console.error(
        `[shard ${SHARD_IDX}] WARN: no funding cache for ${s} — gate disabled`,
      );
      fundingByAsset[s] = new Array(aligned[s]!.length).fill(null);
    }
  }
  return {
    aligned,
    fundingByAsset,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

const { aligned, fundingByAsset, minBars } = loadAligned();
// Bug-Audit Round 3 (R3 fix 2): assert 30m (cache file + *48 hardcoded).
const r7BarMinutes = (cfg as { barMinutes?: number }).barMinutes;
if (r7BarMinutes !== undefined && r7BarMinutes !== 30) {
  throw new Error(
    `_r29Round7Shard winBars hardcoded *48 (30m); cfg.barMinutes=${r7BarMinutes}`,
  );
}
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
  const trimmedFunding: Record<string, (number | null)[]> = {};
  for (const k of Object.keys(aligned)) {
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    trimmedFunding[k] = fundingByAsset[k]!.slice(
      start - WARMUP,
      start + winBars,
    );
  }
  const r = simulate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    SLUG,
    trimmedFunding,
  );
  appendFileSync(
    OUT_FILE,
    JSON.stringify({
      winIdx,
      passed: r.passed,
      reason: r.reason,
      passDay: r.passDay ?? null,
      finalEquityPct: r.finalEquityPct,
    }) + "\n",
  );
  winIdx++;
}

console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${SLUG} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
