/**
 * R29 multi-timeframe shard runner. Auto-derives symbols + auto-loads cache
 * by config.timeframe field. Supports 30m, 1h, 2h, 4h, 5m, 15m.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/_r29MultiTfShard.ts \
 *     FTMO_DAYTRADE_24H_CONFIG_MR_2H mr2h $i 8
 *
 * Bars-per-day adjusts automatically: 24h × 60min / tf-min.
 * Skips assets whose `_<tf>.json` cache is missing (logs warning).
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

if (!CONFIG_NAME || !SLUG) {
  console.error("usage: <CONFIG_NAME> <slug> <shard_idx> <shard_count>");
  process.exit(2);
}

const cfg = (cfgModule as Record<string, unknown>)[CONFIG_NAME] as
  | (typeof cfgModule)["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK"]
  | undefined;
if (!cfg) {
  console.error(`config ${CONFIG_NAME} not found`);
  process.exit(2);
}

const TF = (cfg.timeframe as string) || "30m";
// Bars per day: 24h × 60min / minutes-per-bar
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

const requested = (cfg.assets as Array<{ sourceSymbol: string }>).map(
  (a) => a.sourceSymbol,
);
const SYMBOLS = [...new Set(requested)].filter((s) => {
  const ok = existsSync(`${CACHE_DIR}/${s}_${TF}.json`);
  if (!ok)
    console.error(
      `[shard ${SHARD_IDX}] WARN: missing ${s}_${TF}.json — skipping`,
    );
  return ok;
});

if (SYMBOLS.length === 0) {
  console.error(
    `no cache for any of ${requested.length} requested symbols at ${TF}`,
  );
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
const winBars = (cfg.maxDays as number) * BARS_PER_DAY;
const stepBars = 14 * BARS_PER_DAY; // 14-day step
// Scale warmup to give enough bars for indicators at any tf:
//   30m → 5000 bars, 2h → 1250, 4h → 625
const WARMUP = Math.max(500, Math.round((5000 * 30) / TF_MIN));
let winIdx = 0;
const t0 = Date.now();

console.error(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] ${SLUG} tf=${TF} bpd=${BARS_PER_DAY} winBars=${winBars} stepBars=${stepBars} warmup=${WARMUP} symbols=${SYMBOLS.length}/${requested.length}`,
);

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
