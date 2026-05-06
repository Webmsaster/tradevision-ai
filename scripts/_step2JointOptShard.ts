/**
 * Step-2 Joint-Optimization sweep — measure joint Step-1 + Step-2 pass-rate.
 *
 * Memory says Round 65 (Step-2 joint-opt) is deferred-forever until live-stable.
 * This sweep is the offline groundwork: when Step-1 (PASSLOCK) passes, the
 * account moves to Step-2 with a different config (5% target, 60d, top-6
 * asset filter). The sweep measures:
 *
 *   - Step-1 pass-rate (baseline 63%)
 *   - For each Step-1-passed window: simulate Step-2 from start.
 *   - Step-2 pass-rate conditional on Step-1 passed.
 *   - Joint pass-rate = step1_pass_rate × step2_conditional_pass_rate.
 *
 * Plus a small grid sweep over Step-2 tp_pct multiplier ∈ {0.55, 0.60, 0.65}
 * to find the local optimum.
 *
 * Usage: npx tsx scripts/_step2JointOptShard.ts [shard] [shardCount]
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_STEP2,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const SHARD_IDX = parseInt(process.argv[2] ?? "0", 10);
const SHARD_COUNT = parseInt(process.argv[3] ?? "1", 10);
const OUT = `${CACHE_DIR}/step2_joint_shard_${SHARD_IDX}.jsonl`;
writeFileSync(OUT, "");

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

const { aligned, minBars } = loadAligned();
const STEP1_DAYS = 30; // FTMO Step-1 max
const STEP2_DAYS = 60; // FTMO Step-2 max
const stepBars = 14 * 48;
const WARMUP = 5000;

function step2Cfg(tpMultiplier: number): FtmoDaytrade24hConfig {
  // Apply tp_mult to each asset on the Step-2 base config.
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_STEP2;
  const assets: Daytrade24hAssetCfg[] = (base.assets ?? []).map((a) => ({
    ...a,
    tpPct: a.tpPct ? a.tpPct * tpMultiplier : a.tpPct,
  }));
  return { ...base, assets };
}

console.log(
  `[step2-joint ${SHARD_IDX}/${SHARD_COUNT}] joint Step-1 → Step-2 sweep, tp_mult ∈ {0.55, 0.60, 0.65}`,
);

const TP_MULTS = [0.55, 0.6, 0.65];
const stats: Record<
  number,
  {
    step1_pass: number;
    step2_pass_conditional: number;
    step2_total: number;
    step1_total: number;
    joint_pass: number;
  }
> = {};
for (const m of TP_MULTS) {
  stats[m] = {
    step1_pass: 0,
    step2_pass_conditional: 0,
    step2_total: 0,
    step1_total: 0,
    joint_pass: 0,
  };
}

let winIdx = 0;
const step1WinBars = STEP1_DAYS * 48;
const step2WinBars = STEP2_DAYS * 48;

for (
  let start = WARMUP;
  start + step1WinBars + step2WinBars <= minBars;
  start += stepBars
) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }
  // Step-1 simulation: PASSLOCK with 30 days.
  const trimmed1: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed1[k] = aligned[k]!.slice(start - WARMUP, start + step1WinBars);
  const r1 = simulate(
    trimmed1,
    FTMO_DAYTRADE_24H_R28_V6_PASSLOCK,
    WARMUP,
    WARMUP + step1WinBars,
    "STEP1",
  );

  for (const m of TP_MULTS) {
    stats[m]!.step1_total++;
    if (r1.passed) {
      stats[m]!.step1_pass++;
      // Step-2 starts immediately after Step-1's pass-day (use start+pass_bar).
      // For simplicity: start Step-2 at the bar Step-1 ended its window at.
      const step2_start = start + step1WinBars;
      if (step2_start + step2WinBars > minBars) continue;
      const trimmed2: Record<string, Candle[]> = {};
      for (const k of Object.keys(aligned))
        trimmed2[k] = aligned[k]!.slice(
          step2_start - WARMUP,
          step2_start + step2WinBars,
        );
      const cfg2 = step2Cfg(m);
      const r2 = simulate(
        trimmed2,
        cfg2,
        WARMUP,
        WARMUP + step2WinBars,
        `STEP2_${m}`,
      );
      stats[m]!.step2_total++;
      if (r2.passed) {
        stats[m]!.step2_pass_conditional++;
        stats[m]!.joint_pass++;
      }
      appendFileSync(
        OUT,
        JSON.stringify({
          win_idx: winIdx,
          tp_mult: m,
          step1_passed: r1.passed,
          step1_eq: r1.finalEquityPct,
          step2_passed: r2.passed,
          step2_eq: r2.finalEquityPct,
          step2_reason: r2.reason,
          joint_pass: r1.passed && r2.passed,
        }) + "\n",
      );
    }
  }
  if (winIdx % 5 === 0) {
    console.log(
      `  win ${winIdx}: step1_passed=${r1.passed} eq=${r1.finalEquityPct.toFixed(4)}`,
    );
  }
  winIdx++;
}

console.log("\n=== Step-2 Joint-Opt Sweep Results ===");
for (const m of TP_MULTS) {
  const s = stats[m]!;
  const step1Rate = s.step1_total ? s.step1_pass / s.step1_total : 0;
  const step2Cond = s.step2_total
    ? s.step2_pass_conditional / s.step2_total
    : 0;
  const jointRate = s.step1_total ? s.joint_pass / s.step1_total : 0;
  console.log(
    `  tp_mult=${m}: Step-1 ${s.step1_pass}/${s.step1_total} = ${(step1Rate * 100).toFixed(2)}% | ` +
      `Step-2|S1pass ${s.step2_pass_conditional}/${s.step2_total} = ${(step2Cond * 100).toFixed(2)}% | ` +
      `JOINT ${s.joint_pass}/${s.step1_total} = ${(jointRate * 100).toFixed(2)}%`,
  );
  appendFileSync(
    OUT,
    JSON.stringify({
      marker: "summary",
      tp_mult: m,
      step1_pass_rate: step1Rate,
      step2_conditional_pass_rate: step2Cond,
      joint_pass_rate: jointRate,
    }) + "\n",
  );
}
console.log(`\n[step2-joint ${SHARD_IDX}/${SHARD_COUNT}] DONE → ${OUT}`);
