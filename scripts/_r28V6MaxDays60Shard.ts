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
const MAXDAYS = parseInt(process.argv[4] ?? "60", 10);
// Bug-Audit Round 3 (R3 fix 3): NaN/range-guard on shard CLI args.
if (
  !Number.isFinite(SHARD_IDX) ||
  !Number.isFinite(SHARD_COUNT) ||
  !Number.isFinite(MAXDAYS) ||
  SHARD_COUNT < 1 ||
  SHARD_IDX < 0 ||
  SHARD_IDX >= SHARD_COUNT ||
  MAXDAYS < 1
) {
  console.error(
    `bad shard args: SHARD_IDX=${process.argv[2]} SHARD_COUNT=${process.argv[3]} MAXDAYS=${process.argv[4]} (need 0 ≤ idx < count, count ≥ 1, maxDays ≥ 1)`,
  );
  process.exit(2);
}
const OUT_FILE = `${CACHE_DIR}/r28v6_maxd${MAXDAYS}_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT_FILE, "");
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
const cfg: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  maxDays: MAXDAYS,
};
const { aligned, minBars } = loadAligned();
// Bug-Audit Round 3 (R3 fix 2): assert 30m (cache file + *48 hardcoded).
const md60BarMinutes = (cfg as { barMinutes?: number }).barMinutes;
if (md60BarMinutes !== undefined && md60BarMinutes !== 30) {
  throw new Error(
    `_r28V6MaxDays60Shard winBars hardcoded *48 (30m); cfg.barMinutes=${md60BarMinutes}`,
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
  const r = simulate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    `R28_V6_MAXD${MAXDAYS}`,
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
  console.log(
    `[maxd${MAXDAYS} ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[maxd${MAXDAYS} ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
