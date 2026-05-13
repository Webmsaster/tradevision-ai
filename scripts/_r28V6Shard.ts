/**
 * Sharded R28_V6 V4-Sim revalidation — runs only windows where
 * windowIdx % SHARD_COUNT === SHARD_IDX. Used to parallelize the slow
 * single-threaded reval across multiple cores.
 *
 * Args:
 *   process.argv[2] = SHARD_IDX  (0-based)
 *   process.argv[3] = SHARD_COUNT
 *
 * Outputs JSON-line per window to stdout AND
 * scripts/cache_bakeoff/r28v6_shard_<idx>.jsonl.
 *
 * A separate aggregator (`_r28V6Aggregate.ts`) merges shard outputs.
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
// Bug-Audit Round 3 (R3 fix 3): finite + range guard. parseInt("abc") → NaN
// passed silently meant every window did `winIdx % NaN === NaN`, never true,
// so the shard would simply produce an empty output file.
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
if (
  !Number.isFinite(SHARD_IDX) ||
  !Number.isFinite(SHARD_COUNT) ||
  SHARD_COUNT < 1 ||
  SHARD_IDX < 0 ||
  SHARD_IDX >= SHARD_COUNT
) {
  console.error(
    `bad shard args: SHARD_IDX=${process.argv[2]} SHARD_COUNT=${process.argv[3]} (need 0 ≤ idx < count, count ≥ 1)`,
  );
  process.exit(2);
}
const OUT_FILE = `${CACHE_DIR}/r28v6_shard_${SHARD_IDX}.jsonl`;
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

const cfg: FtmoDaytrade24hConfig =
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
const { aligned, minBars } = loadAligned();
// Bug-Audit Round 3 (R3 fix 2): hardcoded `*48` bars/day + `_30m.json`
// cache name only work for 30m timeframes. Assert so a future 1h or 5m
// config crashes loudly instead of silently producing nonsense window
// sizes.
const barMinutes = (cfg as { barMinutes?: number }).barMinutes;
if (barMinutes !== undefined && barMinutes !== 30) {
  throw new Error(
    `_r28V6Shard winBars=${cfg.maxDays}*48 and cache file _30m.json hardcoded for 30m; cfg.barMinutes=${barMinutes}`,
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
  // 2026-05-13 Codex Round 6 HIGH FIX (#SH3): wrap simulate() per window.
  // Previously one bad window (OOM, candle anomaly, infinite loop guard
  // panic) killed the shard and left a gap that the aggregator silently
  // tolerated. Now: emit an error-row so the aggregator's gap-check
  // catches it AND the surviving windows still complete.
  let out: {
    winIdx: number;
    passed: boolean;
    reason: string;
    passDay: number | null;
    finalEquityPct: number;
    error?: string;
  };
  try {
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, "R28_V6_REVAL");
    out = {
      winIdx,
      passed: r.passed,
      reason: r.reason,
      passDay: r.passDay ?? null,
      finalEquityPct: r.finalEquityPct,
    };
    console.log(
      `[shard ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out = {
      winIdx,
      passed: false,
      reason: "error",
      passDay: null,
      finalEquityPct: 0,
      error: msg.slice(0, 500),
    };
    console.log(
      `[shard ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} ERROR: ${msg.slice(0, 200)}`,
    );
  }
  appendFileSync(OUT_FILE, JSON.stringify(out) + "\n");
  winIdx++;
}
console.log(
  `[shard ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
