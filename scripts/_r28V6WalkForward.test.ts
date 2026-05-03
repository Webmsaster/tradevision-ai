/**
 * R28_V6 Walk-Forward Validation (Round 58 sister test).
 *
 * Splits the 5.55y / 136 windows into TRAIN (first 50%) + TEST (second 50%).
 * Compares pass-rate on each half.
 *
 * Hypothesis: if R28_V6 is robust (not overfit), TRAIN and TEST should
 * differ by < 5pp. R28_V5 history showed ±0.5pp drift. R28_V4 showed
 * +1.5pp test>train (slight tailwind).
 *
 * Why this matters: backtest claimed 60.29% pre-R56. Real 56.62% post-R56.
 * The walk-forward gap tells us how much of the 56.62% is forward-stable
 * vs sample-noise.
 *
 * Run via:
 *   for i in 0 1 2 3 4 5 6 7; do
 *     node --import tsx scripts/_r28V6Shard.ts $i 8 --out=walkforward-$i.json &
 *   done; wait
 *   node --import tsx scripts/_r28V6WalkForward.test.ts  # aggregates
 *
 * Or single-thread (slow, ~80min):
 *   node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *     scripts/_r28V6WalkForward.test.ts
 */
import { describe, it } from "vitest";
import { FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6 } from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const LOG_FILE = "scripts/cache_bakeoff/r28v6_walkforward.log";
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);

function plog(s: string) {
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${s}\n`);
  console.log(s);
}

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

interface SplitResult {
  label: string;
  windowsRange: [number, number];
  passes: number;
  windows: number;
  rate: number;
  medianPassDay: number;
}

function runSplit(
  label: string,
  aligned: Record<string, Candle[]>,
  startBar: number,
  endBarExclusive: number,
): SplitResult {
  const cfg = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
  const winBars = cfg.maxDays * 48;
  const stepBars = 14 * 48;
  const WARMUP = 5000;
  let passes = 0,
    windows = 0;
  const passDays: number[] = [];
  const t0 = Date.now();
  let firstStart = -1,
    lastStart = -1;

  for (
    let start = startBar;
    start + winBars <= endBarExclusive;
    start += stepBars
  ) {
    if (start < WARMUP) continue;
    if (firstStart === -1) firstStart = start;
    lastStart = start;
    windows++;
    const trimmed: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned)) {
      trimmed[k] = aligned[k]!.slice(start - WARMUP, start + winBars);
    }
    const r = simulate(trimmed, cfg, WARMUP, WARMUP + winBars, label);
    if (r.passed) {
      passes++;
      if (r.passDay) passDays.push(r.passDay);
    }
    if (windows % 10 === 0) {
      plog(
        `[${label}] ${windows} windows / ${passes} passes (${((passes / windows) * 100).toFixed(2)}%) / ${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
  }
  passDays.sort((a, b) => a - b);
  const med =
    passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
  const rate = (passes / windows) * 100;
  plog(
    `[done ${label}] ${passes}/${windows} = ${rate.toFixed(2)}% / med=${med}d / range bars [${firstStart},${lastStart}] / ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  return {
    label,
    windowsRange: [firstStart, lastStart],
    passes,
    windows,
    rate,
    medianPassDay: med,
  };
}

describe("R28_V6 Walk-Forward", { timeout: 180 * 60_000 }, () => {
  it("compares TRAIN (first half) vs TEST (second half) pass-rate", () => {
    const { aligned, minBars } = loadAligned();
    plog(`[setup] ${SYMBOLS.length} syms, ${minBars} bars (= 5.55y at 30m)`);
    plog(`[setup] config = R28_V6 (uniform tpMult=0.55, ptp=0.012)`);
    plog(
      `[setup] expected: TRAIN ≈ TEST ± 5pp (R28 family historically robust)`,
    );

    const halfBar = Math.floor(minBars / 2);
    plog(`[setup] split at bar ${halfBar} (= ~2.77y / 2.77y)`);

    plog("\n--- TRAIN HALF ---");
    const train = runSplit("TRAIN", aligned, 0, halfBar);

    plog("\n--- TEST HALF ---");
    const test = runSplit("TEST", aligned, halfBar, minBars);

    const drift = test.rate - train.rate;

    plog("\n=== R28_V6 WALK-FORWARD RESULTS ===");
    plog(
      `TRAIN: ${train.passes}/${train.windows} = ${train.rate.toFixed(2)}% / med=${train.medianPassDay}d`,
    );
    plog(
      `TEST:  ${test.passes}/${test.windows} = ${test.rate.toFixed(2)}% / med=${test.medianPassDay}d`,
    );
    plog(`Drift: ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp (TEST - TRAIN)`);
    plog(
      `Combined: ${train.passes + test.passes}/${train.windows + test.windows} = ${(((train.passes + test.passes) / (train.windows + test.windows)) * 100).toFixed(2)}%`,
    );

    if (Math.abs(drift) <= 5) {
      plog(`✓ ROBUST — drift ${drift.toFixed(2)}pp within ±5pp`);
    } else if (drift > 5) {
      plog(
        `⚠ TAILWIND — TEST ${drift.toFixed(2)}pp BETTER than TRAIN; market got easier`,
      );
    } else {
      plog(
        `⚠ HEADWIND — TEST ${Math.abs(drift).toFixed(2)}pp WORSE than TRAIN; potential overfit`,
      );
    }
    plog(`\nLog: ${LOG_FILE}`);
  });
});
