/**
 * R29 14-asset shard runner for V5_AMBER family configs.
 *
 *   for i in 0 1 2 3 4 5 6 7; do
 *     node ./node_modules/tsx/dist/cli.mjs scripts/_r29Asset14Shard.ts \
 *       FTMO_DAYTRADE_24H_V5_AMBER_PT08 iterAMBER_pt08 $i 8 &
 *   done; wait
 */
import * as cfgModule from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const CONFIG_NAME = process.argv[2] ?? "";
const SLUG = process.argv[3] ?? "";
const SHARD_IDX = parseInt(process.argv[4] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[5] ?? "1", 10);

if (!CONFIG_NAME || !SLUG) {
  console.error("usage: <CONFIG_NAME> <slug> <shard_idx> <shard_count>");
  process.exit(2);
}
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

const cfg = (cfgModule as Record<string, unknown>)[CONFIG_NAME] as
  | (typeof cfgModule)["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK"]
  | undefined;
if (!cfg) {
  console.error(`config ${CONFIG_NAME} not found`);
  process.exit(2);
}

// R29-iter (auto): derive symbols from the config's asset list rather
// than a hardcoded list — supports AMBER (15), TITANIUM (14, RUNE), TOPAZ
// (14), RUBIN (14) etc. each with their own basket.
const SYMBOLS = (cfg.assets as Array<{ sourceSymbol: string }>).map(
  (a) => a.sourceSymbol,
);

const OUT_FILE = `${CACHE_DIR}/r29_${SLUG}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, "");

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
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

const { aligned, minBars } = loadAligned();
// Bug-Audit Round 3 (R3 fix 2): assert 30m (cache file + *48 hardcoded).
const a14BarMinutes = (cfg as { barMinutes?: number }).barMinutes;
if (a14BarMinutes !== undefined && a14BarMinutes !== 30) {
  throw new Error(
    `_r29Asset14Shard winBars hardcoded *48 (30m); cfg.barMinutes=${a14BarMinutes}`,
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
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, SLUG);
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
