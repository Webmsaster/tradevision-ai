/**
 * R29 generic shard runner. Pass config name + slug + shard-idx + count.
 *
 * Usage:
 *   for i in 0 1 2 3 4 5 6 7; do
 *     node ./node_modules/tsx/dist/cli.mjs scripts/_r29GenericShard.ts \
 *       FTMO_DAYTRADE_24H_R28_V6_PT08_TIGHTTP iterD_pt08_tighttp $i 8 &
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

const cfg = (cfgModule as Record<string, unknown>)[CONFIG_NAME] as
  | (typeof cfgModule)["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK"]
  | undefined;
if (!cfg) {
  console.error(`config ${CONFIG_NAME} not found in ftmoDaytrade24h`);
  process.exit(2);
}

const OUT_FILE = `${CACHE_DIR}/r29_${SLUG}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, "");

// Bug-Audit Round 1: derive SYMBOLS from cfg.assets, NOT hardcoded list.
// Hardcoded 9-symbol list silently dropped SOL etc. in V12_30M_OPT_STOCK
// and the resulting "77.14% pass-rate" was a debunked 3-asset measurement.
// Fall back to baseline 9-asset universe only if cfg has no assets.
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
