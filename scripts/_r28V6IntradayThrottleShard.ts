/**
 * R28_V6 + intradayDailyLossThrottle (R28 family disabled it; this re-enables).
 *
 * Hypothesis: 30.88% of R28_V6 failures are daily_loss (intraday -5%).
 * Adding a soft -2.5% / hard -3.5% throttle preserves 1.5% buffer to the
 * 5% DL limit, expected to convert ~30-50% of DL fails into total_loss
 * or pass instead.
 *
 * Effective conversion math: if 30.88% fails are DL and we save 40%:
 * +12.4pp pass-rate boost (conservative estimate). 56.62% → 69%.
 *
 * Caveat: requires Python executor to replicate intraday throttle for
 * live deployment. Currently disabled because R28 is "Live-Safe" but
 * Python tracks daily PnL anyway, so re-implementation is feasible.
 *
 * Args: SHARD_IDX, SHARD_COUNT
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
const VARIANT = process.argv[4] ?? "soft25_hard35";
const OUT_FILE = `${CACHE_DIR}/r28v6_throttle_${VARIANT}_shard_${SHARD_IDX}.jsonl`;
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

const variants: Record<
  string,
  { softLossThreshold: number; hardLossThreshold: number; softFactor: number }
> = {
  soft25_hard35: {
    softLossThreshold: 0.025,
    hardLossThreshold: 0.035,
    softFactor: 0.5,
  },
  soft20_hard30: {
    softLossThreshold: 0.02,
    hardLossThreshold: 0.03,
    softFactor: 0.5,
  },
  soft30_hard40: {
    softLossThreshold: 0.03,
    hardLossThreshold: 0.04,
    softFactor: 0.5,
  },
  soft20_hard35: {
    softLossThreshold: 0.02,
    hardLossThreshold: 0.035,
    softFactor: 0.4,
  },
};

const cfg: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  intradayDailyLossThrottle: variants[VARIANT]!,
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
  const r = simulate(
    trimmed,
    cfg,
    WARMUP,
    WARMUP + winBars,
    `R28_V6_${VARIANT}`,
  );
  const out = {
    winIdx,
    passed: r.passed,
    reason: r.reason,
    passDay: r.passDay ?? null,
    finalEquityPct: r.finalEquityPct,
  };
  appendFileSync(OUT_FILE, JSON.stringify(out) + "\n");
  console.log(
    `[throttle ${VARIANT} ${SHARD_IDX}/${SHARD_COUNT}] win=${winIdx} passed=${r.passed} reason=${r.reason} eq=${r.finalEquityPct.toFixed(4)} t+${Math.round((Date.now() - t0) / 1000)}s`,
  );
  winIdx++;
}
console.log(
  `[throttle ${VARIANT} ${SHARD_IDX}/${SHARD_COUNT}] DONE in ${Math.round((Date.now() - t0) / 1000)}s`,
);
