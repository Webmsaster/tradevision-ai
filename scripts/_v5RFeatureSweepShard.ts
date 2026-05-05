/**
 * V5R Engine — combined feature sweep on R28_V6 base.
 *
 * Tests V5R features individually + combos:
 *   - VARIANT=guardian30: just dailyEquityGuardian (already running separately)
 *   - VARIANT=adaptive: bypassLiveCaps + dayProgressiveSizing
 *   - VARIANT=reentry: reentryAfterStop {sizeMult: 0.5, withinBars: 4}
 *   - VARIANT=mr: meanReversionSource {period:14, oversold:25, overbought:75}
 *   - VARIANT=combo_g30_re: guardian + reentry
 *   - VARIANT=combo_all: guardian + adaptive + reentry + mr
 *
 * Args: SHARD_IDX, SHARD_COUNT, VARIANT
 */
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV5R";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const VARIANT = process.argv[4] ?? "adaptive";
const OUT_FILE = `${CACHE_DIR}/r28v6_v5rfeat_${VARIANT}_shard_${SHARD_IDX}.jsonl`;
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

function buildCfg(variant: string): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  const adaptive = {
    bypassLiveCaps: true,
    dayProgressiveSizing: [
      { dayAtLeast: 0, factor: 1.0 },
      { dayAtLeast: 7, factor: 1.5 },
      { dayAtLeast: 14, factor: 1.25 },
      { dayAtLeast: 21, factor: 0.8 },
    ],
  };
  const reentry = {
    reentryAfterStop: { sizeMult: 0.5, withinBars: 4 },
  };
  const mr = {
    meanReversionSource: {
      period: 14,
      oversold: 25,
      overbought: 75,
      cooldownBars: 8,
      sizeMult: 0.5,
    },
  };
  const guardian = {
    dailyEquityGuardian: { triggerPct: 0.03 },
  };
  switch (variant) {
    case "adaptive":
      return { ...base, ...adaptive };
    case "reentry":
      return { ...base, ...reentry };
    case "mr":
      return { ...base, ...mr };
    case "guardian30":
      return { ...base, ...guardian };
    case "combo_g30_re":
      return { ...base, ...guardian, ...reentry };
    case "combo_all":
      return { ...base, ...guardian, ...adaptive, ...reentry, ...mr };
    default:
      throw new Error(`unknown variant: ${variant}`);
  }
}

const cfg = buildCfg(VARIANT);
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
  const r = simulate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    `R28_V6_V5RFEAT_${VARIANT}`,
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
    `[v5rfeat ${VARIANT} ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[v5rfeat ${VARIANT} ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
