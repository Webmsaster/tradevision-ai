/**
 * R9 Spot-Check: Re-run PASSLOCK on a small sample of windows POST-R9 gap-fix
 * and compare against pre-R9 cached results.
 *
 * The R9 fix (commit 46d9bb3) changed src/utils/ftmoLiveEngineV4.ts:871-919:
 * gap-down stop-fills now use bar.open instead of clamping to stopPrice.
 *
 * If gap-bug was OVERSTATING pass-rate (hiding slippage), post-R9 should
 * show MORE failures (lower pass-rate) on windows with gaps.
 *
 * Usage:
 *   node ./node_modules/.bin/tsx scripts/_r9PasslockGapSpotCheck.ts
 */
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";
import { readFileSync, existsSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";

// Windows to spot-check. Mix of pass / fail / borderline from cached PASSLOCK.
// shard0: winIdx 0 (fail-daily), 16 (pass), 24 (pass), 40 (fail-daily)
// shard1: winIdx 1, 17, 25 — pick spread across time.
// We run a focused 8-window sample = ~6 % of full grid.
// Stratified sample: every 6th window across the full 136-grid → ~23 windows.
const SPOT_WINDOWS = Array.from({ length: 23 }, (_, i) => i * 6);

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

function loadCachedPasslock(): Map<
  number,
  { passed: boolean; reason: string; finalEquityPct: number }
> {
  const m = new Map();
  for (let s = 0; s < 8; s++) {
    const f = `${CACHE_DIR}/r28v6_v60_passlock_shard_${s}.jsonl`;
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        m.set(o.winIdx, {
          passed: !!o.passed,
          reason: o.reason ?? "",
          finalEquityPct: o.finalEquityPct,
        });
      } catch {}
    }
  }
  return m;
}

const { aligned, minBars } = loadAligned();
const cfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;
const cached = loadCachedPasslock();

console.log(
  "=== R9 PASSLOCK Spot-Check (POST-R9 gap-fix vs PRE-R9 cache) ===\n",
);
console.log(
  `Engine: src/utils/ftmoLiveEngineV4.ts (R9 patch — gap-fill = bar.open)`,
);
console.log(`Config: R28_V6_PASSLOCK (closeAllOnTargetReached:true)`);
console.log(`Sample: ${SPOT_WINDOWS.length} windows out of 136`);
console.log("");

const headers = [
  "winIdx",
  "PRE-R9 pass",
  "PRE-R9 reason",
  "PRE-R9 eq%",
  "POST-R9 pass",
  "POST-R9 reason",
  "POST-R9 eq%",
  "Δeq%",
  "FLIP",
];
console.log(headers.join("\t"));

let winIdx = 0;
let flipCount = 0;
let passToFailCount = 0;
let failToPassCount = 0;
let totalPreRunPasses = 0;
let totalPostRunPasses = 0;
let totalEqDelta = 0;

for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  if (!SPOT_WINDOWS.includes(winIdx)) {
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
    `R9SPOT_${winIdx}`,
  );
  const pre = cached.get(winIdx);
  if (!pre) {
    console.log(`${winIdx}\tNO_CACHE`);
    winIdx++;
    continue;
  }
  const flip = pre.passed !== r.passed;
  if (flip) {
    flipCount++;
    if (pre.passed && !r.passed) passToFailCount++;
    else failToPassCount++;
  }
  if (pre.passed) totalPreRunPasses++;
  if (r.passed) totalPostRunPasses++;
  const eqDelta = r.finalEquityPct - pre.finalEquityPct;
  totalEqDelta += eqDelta;

  console.log(
    [
      winIdx,
      pre.passed ? "P" : "F",
      pre.reason,
      (pre.finalEquityPct * 100).toFixed(2),
      r.passed ? "P" : "F",
      r.reason,
      (r.finalEquityPct * 100).toFixed(2),
      (eqDelta * 100).toFixed(2),
      flip ? (pre.passed ? "P→F" : "F→P") : "-",
    ].join("\t"),
  );
  winIdx++;
}

const n = SPOT_WINDOWS.length;
const prePassRate = (totalPreRunPasses / n) * 100;
const postPassRate = (totalPostRunPasses / n) * 100;
const swing = postPassRate - prePassRate;
console.log("");
console.log(
  `SAMPLE PASS-RATE PRE-R9:  ${prePassRate.toFixed(2)}% (${totalPreRunPasses}/${n})`,
);
console.log(
  `SAMPLE PASS-RATE POST-R9: ${postPassRate.toFixed(2)}% (${totalPostRunPasses}/${n})`,
);
console.log(`Δ pass-rate sample-swing: ${swing.toFixed(2)}pp`);
console.log(
  `Flips: ${flipCount} (P→F=${passToFailCount}, F→P=${failToPassCount})`,
);
console.log(`Mean equity Δ: ${((totalEqDelta / n) * 100).toFixed(3)}%`);
console.log("");
console.log(`Extrapolated to full 136-window grid:`);
console.log(`  PRE-R9 claim: 63.24% (cached full sweep, May 5 17:00-19:00)`);
console.log(
  `  Estimated post-R9: ${(63.24 + swing).toFixed(2)}% (assuming sample is representative)`,
);
