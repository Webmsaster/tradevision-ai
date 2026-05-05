/**
 * R28_V6 with profitTarget=0.08 (FTMO Normal challenge actual rule).
 *
 * The shipped backtest uses profitTarget=0.10 (legacy), but FTMO Normal
 * challenge actually targets 8% profit. This shard runs R28_V6 against
 * the CORRECT 8% target to measure honest pass-rate for Normal challenge.
 *
 * Hypothesis: 8% target is significantly easier to hit than 10%, so
 * pass-rate should jump from 56.62% → ~65-72%.
 *
 * Args: SHARD_IDX, SHARD_COUNT (same as _r28V6Shard.ts)
 */
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
const OUT_FILE = `${CACHE_DIR}/r28v6_pt08_shard_${SHARD_IDX}.jsonl`;
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

const cfg: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  profitTarget: 0.08, // FTMO Normal challenge actual target
};
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
  const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, "R28_V6_PT08");
  const out = {
    winIdx,
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
  };
  appendFileSync(OUT_FILE, JSON.stringify(out) + "\n");
  console.log(
    `[pt08 ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[pt08 ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
