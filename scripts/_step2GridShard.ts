/**
 * Step-2 Grid-Sweep — Round 65 expansion.
 *
 * 3D parameter sweep over Step-2 config:
 *   tp_mult        ∈ {0.55, 0.60, 0.65, 0.70}
 *   dpt_distance   ∈ {0.010, 0.012, 0.015, 0.018}
 *   profit_target  ∈ {0.05, 0.06}
 *
 * Total: 4 × 4 × 2 = 32 configs per window. With ~40 windows that's
 * 1280 simulations — sharded × 8 ≈ 4-6 hours wall-clock.
 *
 * Output JSONL row per (window, tp_mult, dpt, target):
 *   { win_idx, tp_mult, dpt, target, step1_passed, step2_passed,
 *     joint_pass, step2_eq }
 *
 * Run after the basic _step2JointOptShard.ts identifies the tp_mult
 * neighbourhood. Use the aggregator to find the global optimum.
 *
 * Usage: npx tsx scripts/_step2GridShard.ts [shard] [shardCount]
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
const OUT = `${CACHE_DIR}/step2_grid_shard_${SHARD_IDX}.jsonl`;
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

const TP_MULTS = [0.55, 0.6, 0.65, 0.7];
const DPT_DISTS = [0.01, 0.012, 0.015, 0.018];
const PROFIT_TARGETS = [0.05, 0.06];

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

function step2Cfg(
  tpMult: number,
  dpt: number,
  target: number,
): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_STEP2;
  const assets: Daytrade24hAssetCfg[] = (base.assets ?? []).map((a) => ({
    ...a,
    tpPct: a.tpPct ? a.tpPct * tpMult : a.tpPct,
  }));
  return {
    ...base,
    assets,
    profitTarget: target,
    dailyPeakTrailingStop: { trailDistance: dpt },
  };
}

const { aligned, minBars } = loadAligned();
const STEP1_DAYS = 30;
const STEP2_DAYS = 60;
const stepBars = 14 * 48;
const WARMUP = 5000;
const step1WinBars = STEP1_DAYS * 48;
const step2WinBars = STEP2_DAYS * 48;

console.log(
  `[step2-grid ${SHARD_IDX}/${SHARD_COUNT}] sweeping ${TP_MULTS.length}×${DPT_DISTS.length}×${PROFIT_TARGETS.length} = ${TP_MULTS.length * DPT_DISTS.length * PROFIT_TARGETS.length} configs per window`,
);

let winIdx = 0;
const t0 = Date.now();

for (
  let start = WARMUP;
  start + step1WinBars + step2WinBars <= minBars;
  start += stepBars
) {
  if (winIdx % SHARD_COUNT !== SHARD_IDX) {
    winIdx++;
    continue;
  }

  // Step-1 once per window (PASSLOCK is fixed).
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

  if (!r1.passed) {
    appendFileSync(
      OUT,
      JSON.stringify({ win_idx: winIdx, step1_passed: false }) + "\n",
    );
    winIdx++;
    continue;
  }

  // Step-2 grid sweep
  const step2_start = start + step1WinBars;
  if (step2_start + step2WinBars > minBars) {
    winIdx++;
    continue;
  }
  const trimmed2: Record<string, Candle[]> = {};
  for (const k of Object.keys(aligned))
    trimmed2[k] = aligned[k]!.slice(
      step2_start - WARMUP,
      step2_start + step2WinBars,
    );

  for (const tpM of TP_MULTS) {
    for (const dpt of DPT_DISTS) {
      for (const tgt of PROFIT_TARGETS) {
        const cfg = step2Cfg(tpM, dpt, tgt);
        const r2 = simulate(
          trimmed2,
          cfg,
          WARMUP,
          WARMUP + step2WinBars,
          `S2_${tpM}_${dpt}_${tgt}`,
        );
        appendFileSync(
          OUT,
          JSON.stringify({
            win_idx: winIdx,
            tp_mult: tpM,
            dpt,
            target: tgt,
            step1_passed: true,
            step2_passed: r2.passed,
            step2_eq: r2.finalEquityPct,
            step2_reason: r2.reason,
            joint_pass: r2.passed,
          }) + "\n",
        );
      }
    }
  }
  if (winIdx % 5 === 0) {
    const t = Math.round((Date.now() - t0) / 1000);
    console.log(
      `  win ${winIdx}: step1=passed, ran 32 step-2 configs, t+${t}s`,
    );
  }
  winIdx++;
}

console.log(`[step2-grid ${SHARD_IDX}/${SHARD_COUNT}] DONE → ${OUT}`);
