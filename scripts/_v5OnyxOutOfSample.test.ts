/**
 * V5_ONYX Out-Of-Sample Validation.
 *
 * The 70.11% step=3d claim was measured on the FULL 1103-window range
 * (2023-03 through 2026-04). To detect overfitting from the 32 sweep phases,
 * split the data:
 *
 *   - TRAIN (oldest 70%): first 770 windows  (the sweep saw this period)
 *   - TEST (newest 30%):  last 333 windows   (NEVER seen during tuning)
 *
 * Compare V5_ONYX pass-rate on TRAIN vs TEST. If TEST << TRAIN → overfit.
 *
 * Also bootstrap-resample 1000 times to get a confidence interval.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}
function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

function evaluateRange(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  startBar: number,
  endBar: number,
  stepDays: number,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
    totalT = 0,
    totalW = 0;
  const days: number[] = [];
  const passVec: number[] = [];

  for (let start = startBar; start + winBars <= endBar; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    passVec.push(res.passed ? 1 : 0);
    if (res.passed) {
      passes++;
      days.push(res.passDay ?? 0);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
    for (const t of res.trades) {
      totalT++;
      if (t.effPnl > 0) totalW++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passes,
    passRate: passes / windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalT > 0 ? totalW / totalT : 0,
    passVec,
  };
}

// Mulberry32 RNG for bootstrap
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(
  passVec: number[],
  B: number,
  seed: number,
): { lo: number; hi: number; mean: number } {
  const rand = rng(seed);
  const means: number[] = [];
  const n = passVec.length;
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += passVec[Math.floor(rand() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(B * 0.025)],
    hi: means[Math.floor(B * 0.975)],
    mean: means.reduce((a, b) => a + b, 0) / means.length,
  };
}

describe(
  "V5_ONYX Out-Of-Sample + Bootstrap validation",
  { timeout: 30 * 60_000 },
  () => {
    it("TRAIN/TEST split + bootstrap CI for V5_ONYX vs V5 baseline", async () => {
      const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX);
      console.log(`\nLoading 30m: ${symbols.length} symbols`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        const raw = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 100000,
          maxPages: 120,
        });
        data[s] = raw.filter((c) => c.isFinal);
      }
      const aligned = alignCommon(data, symbols);
      const n = Math.min(...symbols.map((s) => aligned[s].length));
      const SPLIT = Math.floor(n * 0.7);
      console.log(`Total bars: ${n}, train: 0..${SPLIT}, test: ${SPLIT}..${n}`);

      for (const stepDays of [1, 3]) {
        console.log(`\n=== step=${stepDays}d ===`);
        const onyxFull = evaluateRange(
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX,
          data,
          0,
          n,
          stepDays,
        );
        const onyxTrain = evaluateRange(
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX,
          data,
          0,
          SPLIT,
          stepDays,
        );
        const onyxTest = evaluateRange(
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX,
          data,
          SPLIT,
          n,
          stepDays,
        );

        console.log(
          `V5_ONYX full:  ${(onyxFull.passRate * 100).toFixed(2)}% (${onyxFull.passes}/${onyxFull.windows}) wr=${(onyxFull.winrate * 100).toFixed(2)}% TL=${onyxFull.tl} DL=${onyxFull.dl} med=${onyxFull.med}d p90=${onyxFull.p90}d`,
        );
        console.log(
          `V5_ONYX TRAIN: ${(onyxTrain.passRate * 100).toFixed(2)}% (${onyxTrain.passes}/${onyxTrain.windows}) wr=${(onyxTrain.winrate * 100).toFixed(2)}% TL=${onyxTrain.tl} DL=${onyxTrain.dl}`,
        );
        console.log(
          `V5_ONYX TEST:  ${(onyxTest.passRate * 100).toFixed(2)}% (${onyxTest.passes}/${onyxTest.windows}) wr=${(onyxTest.winrate * 100).toFixed(2)}% TL=${onyxTest.tl} DL=${onyxTest.dl}`,
        );
        const overfitGap = (onyxTrain.passRate - onyxTest.passRate) * 100;
        console.log(
          `Overfit gap (TRAIN - TEST): ${overfitGap >= 0 ? "+" : ""}${overfitGap.toFixed(2)}pp`,
        );

        // Bootstrap CI on full
        const bs = bootstrap(onyxFull.passVec, 1000, 20260429 + stepDays);
        console.log(
          `Bootstrap 95% CI (1000 samples): [${(bs.lo * 100).toFixed(2)}%, ${(bs.hi * 100).toFixed(2)}%] mean ${(bs.mean * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
