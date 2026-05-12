/**
 * R29 Round 8 — stacking shard runner.
 *
 * Loads candles + funding-rate, builds cross-sectional momentum + regime
 * masks (HMM-light), AND-combines, runs simulate() with both funding and
 * the combined entry-allowed mask piped through.
 *
 * Mask configuration is hardcoded per slug (different slugs produce
 * different filter combinations) so the shard runner doesn't depend
 * on the slow ftmoDaytrade24h.ts re-import for thresholds.
 *
 * Usage: <CONFIG_NAME> <slug> <shard_idx> <shard_count> <mask_mode> [stepDays]
 *   mask_mode: "crossmom" | "regime" | "stacked" | "none"
 *   stepDays: window step in days, default 14. Set to 28 for fast iteration
 *   (halves window count 136→68, halves sweep wall-clock).
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
import {
  buildCrossMomentumMask,
  buildRegimeMask,
  andMasks,
} from "./_r29MaskBuilders";

const CACHE_DIR = "scripts/cache_bakeoff";
const CONFIG_NAME = process.argv[2] ?? "";
const SLUG = process.argv[3] ?? "";
const SHARD_IDX = parseInt(process.argv[4] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[5] ?? "1", 10);
const MASK_MODE = process.argv[6] ?? "stacked";
const STEP_DAYS = parseInt(process.argv[7] ?? "14", 10);

if (!CONFIG_NAME || !SLUG) {
  console.error(
    "usage: <CONFIG_NAME> <slug> <shard_idx> <shard_count> <mask_mode>",
  );
  process.exit(2);
}

const cfg = (cfgModule as Record<string, unknown>)[CONFIG_NAME] as
  | (typeof cfgModule)["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK"]
  | undefined;
if (!cfg) {
  console.error(`config ${CONFIG_NAME} not found`);
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
  for (const s of SYMBOLS)
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  const fundingByAsset: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS) {
    const fp = `${CACHE_DIR}/${s}_funding.json`;
    if (existsSync(fp)) {
      const f: FundingPt[] = JSON.parse(readFileSync(fp, "utf-8"));
      fundingByAsset[s] = alignFunding(aligned[s]!, f);
    } else {
      console.error(`[shard ${SHARD_IDX}] WARN: no funding cache for ${s}`);
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

// Build masks based on mode.
let entryAllowed: Record<string, (boolean | null)[]> | undefined;
if (MASK_MODE === "crossmom") {
  // 7d return on 30m candles = 7*48 = 336 bars. Top-3/bottom-3 of 9 assets.
  entryAllowed = buildCrossMomentumMask(aligned, 336, 3);
} else if (MASK_MODE === "regime") {
  entryAllowed = buildRegimeMask(aligned, {
    volLookback: 48, // 24h vol
    percentileWindow: 480, // 10d rolling rank
    minPct: 25,
    maxPct: 80,
  });
} else if (MASK_MODE === "stacked") {
  const cm = buildCrossMomentumMask(aligned, 336, 3);
  const rg = buildRegimeMask(aligned, {
    volLookback: 48,
    percentileWindow: 480,
    minPct: 25,
    maxPct: 80,
  });
  entryAllowed = andMasks(cm, rg);
}

const winBars = cfg.maxDays * 48;
const stepBars = STEP_DAYS * 48;
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
  const trimmedAllowed: Record<string, (boolean | null)[]> = {};
  for (const k of Object.keys(aligned)) {
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    trimmedFunding[k] = fundingByAsset[k]!.slice(
      start - WARMUP,
      start + winBars,
    );
    if (entryAllowed)
      trimmedAllowed[k] = entryAllowed[k]!.slice(
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
    entryAllowed ? trimmedAllowed : undefined,
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
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${SLUG}/${MASK_MODE} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
