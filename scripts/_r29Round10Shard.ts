/**
 * R29-R10 generic shard runner — reads asset list from cfg.assets directly
 * (not hardcoded). Replaces _r29Round9TitaniumShard.ts hardcoded 14-asset
 * universe so OBSIDIAN_PASSLOCK (15 assets, +ARB) and any future basket
 * variants run correctly.
 *
 * Usage:
 *   tsx scripts/_r29Round10Shard.ts <CONFIG_NAME> <slug> <shard_idx> <count> [stepDays]
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
const STEP_DAYS = parseInt(process.argv[6] ?? "14", 10);

if (!CONFIG_NAME || !SLUG) {
  console.error("usage: <CONFIG> <slug> <shard_idx> <count> [stepDays]");
  process.exit(2);
}
// Bug-Audit Round 3 (R3 fix 3): NaN/range-guard on shard CLI args + step.
if (
  !Number.isFinite(SHARD_IDX) ||
  !Number.isFinite(SHARD_COUNT) ||
  !Number.isFinite(STEP_DAYS) ||
  SHARD_COUNT < 1 ||
  SHARD_IDX < 0 ||
  SHARD_IDX >= SHARD_COUNT ||
  STEP_DAYS < 1
) {
  console.error(
    `bad shard args: SHARD_IDX=${process.argv[4]} SHARD_COUNT=${process.argv[5]} STEP_DAYS=${process.argv[6]} (need 0 ≤ idx < count, count ≥ 1, step ≥ 1)`,
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

// Bug-Audit Round 3 (R3 fix 4): cfg.assets fallback for configs that don't
// declare an `assets` array (older R28 variants). Without it, the map()
// crashed with `Cannot read properties of undefined (reading 'map')` and
// the shard exited before writing any output.
const FALLBACK_R28_BASKET = [
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
  cfg as { assets?: Array<{ symbol: string; sourceSymbol?: string }> }
).assets;
const SYMBOLS: string[] = cfgAssets
  ? cfgAssets.map((a) => a.sourceSymbol ?? a.symbol.replace("-TREND", "USDT"))
  : FALLBACK_R28_BASKET;

const OUT_FILE = `${CACHE_DIR}/r29_${SLUG}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, "");

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
  for (const s of SYMBOLS) {
    const path = `${CACHE_DIR}/${s}_30m.json`;
    if (!existsSync(path)) {
      console.error(`MISSING candle cache: ${path}`);
      process.exit(3);
    }
    data[s] = JSON.parse(readFileSync(path, "utf-8"));
  }
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
      // No funding data yet — gate inactive for this asset.
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
// Bug-Audit Round 3 (R3 fix 2): 30m-only assertion (cache file _30m.json
// + *48 bars/day). Other TF support requires a parallel _r29Round10MultiTf
// shard.
const r10BarMinutes = (cfg as { barMinutes?: number }).barMinutes;
if (r10BarMinutes !== undefined && r10BarMinutes !== 30) {
  throw new Error(
    `_r29Round10Shard winBars hardcoded *48 (30m); cfg.barMinutes=${r10BarMinutes}`,
  );
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
  // Optional trade dump for Rust↔TS audit. Set TRADES_OUT_FILE env to a path
  // and the closedTrades array gets appended one-per-line with `winIdx`.
  // Optionally narrow with DEBUG_WINDOW=<n> so only that window dumps.
  // Bug-Audit Round 4: per-shard suffix on the output path. Without this,
  // 8 parallel shards all `appendFileSync` to the SAME file. POSIX guarantees
  // atomic writes only up to PIPE_BUF (4096 bytes on Linux); a trade record
  // with timestamps + price fields can exceed that, so concurrent shards
  // would interleave bytes mid-line and corrupt the JSONL. Each shard now
  // writes to `<path>.shard<idx>.jsonl` so aggregators can glob them later.
  const tradesOut = process.env.TRADES_OUT_FILE;
  const debugWindow = process.env.DEBUG_WINDOW
    ? parseInt(process.env.DEBUG_WINDOW, 10)
    : null;
  if (tradesOut && (debugWindow === null || debugWindow === winIdx)) {
    const shardedTradesOut = `${tradesOut}.shard${SHARD_IDX}.jsonl`;
    for (const t of r.trades) {
      appendFileSync(shardedTradesOut, JSON.stringify({ ...t, winIdx }) + "\n");
    }
  }
  winIdx++;
}

console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${SLUG} (${SYMBOLS.length} assets) done in ${(
    (Date.now() - t0) /
    1000
  ).toFixed(0)}s`,
);
