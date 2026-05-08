/**
 * R29 SMC engine shard runner. Uses ftmoSmcEngine.runSmcEngine() with
 * walk-forward windowing.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/_r29SmcShard.ts \
 *     FTMO_SMC_CONFIG_BASE smcBase $i 8
 */
import { runSmcEngine, FTMO_SMC_CONFIG_BASE } from "../src/utils/ftmoSmcEngine";
import type { Candle } from "../src/utils/indicators";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const CONFIG_NAME = process.argv[2] ?? "FTMO_SMC_CONFIG_BASE";
const SLUG = process.argv[3] ?? "smcBase";
const SHARD_IDX = parseInt(process.argv[4] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[5] ?? "1", 10);

const cfgs: Record<string, typeof FTMO_SMC_CONFIG_BASE> = {
  FTMO_SMC_CONFIG_BASE,
};
const cfg = cfgs[CONFIG_NAME];
if (!cfg) {
  console.error(`SMC config ${CONFIG_NAME} not found`);
  process.exit(2);
}

const TF = cfg.timeframe;
const TF_MIN_MAP: Record<string, number> = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
};
const TF_MIN = TF_MIN_MAP[TF];
if (!TF_MIN) {
  console.error(`unsupported timeframe ${TF}`);
  process.exit(2);
}
const BARS_PER_DAY = (24 * 60) / TF_MIN;

const requested = cfg.assets.map((a) => a.sourceSymbol);
const SYMBOLS = [...new Set(requested)].filter((s) =>
  existsSync(`${CACHE_DIR}/${s}_${TF}.json`),
);
if (SYMBOLS.length === 0) {
  console.error(`no cache for ${TF}`);
  process.exit(2);
}

const OUT_FILE = `${CACHE_DIR}/r29_${SLUG}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, "");

function loadAligned() {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_${TF}.json`, "utf-8"));
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
const winBars = cfg.maxDays * BARS_PER_DAY;
const stepBars = 14 * BARS_PER_DAY;
const WARMUP = Math.max(500, Math.round((5000 * 30) / TF_MIN));

let winIdx = 0;
const t0 = Date.now();

console.error(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${SLUG} tf=${TF} winBars=${winBars} stepBars=${stepBars} warmup=${WARMUP} symbols=${SYMBOLS.length}/${requested.length}`,
);

for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  const trimmed: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
  // SMC engine doesn't take a window-range — feed only the window slice
  // (no warmup-in-engine; it computes its own indicators from start).
  const r = runSmcEngine(trimmed, cfg);
  appendFileSync(
    OUT_FILE,
    JSON.stringify({
      winIdx,
      passed: r.passed,
      reason: r.reason,
      passDay: null,
      finalEquityPct: r.finalEquityPct,
    }) + "\n",
  );
  winIdx++;
}

console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${SLUG} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
