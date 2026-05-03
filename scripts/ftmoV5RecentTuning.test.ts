/**
 * V5 RECENT-REGIME TUNING — push V5 from 46.7% toward 50% by focusing on
 * the LAST ~3y of crypto market regime instead of full 5.6y average.
 *
 * Hypothesis: 2024-2026 crypto microstructure is its own regime; a V5-variant
 * tuned on it should outperform on the live challenge. Defends against
 * overfit via strict Train → Validation → Hold-Out walk-forward.
 *
 * Splits (newest data on the right):
 *   Hold-Out:    last 30 days (2h ≈ 360 bars)        — sacred, never tuned on
 *   Validation:  last 0.5y excl Hold-Out (~2190 bars rolling)
 *   Train:       2.5y → 0.5y ago (~10950 bars)
 *   OOS-5.6y:    full history (sanity at the end)
 *
 * Random-search 500 trials on TRAIN, top-10 promoted to VALIDATION,
 * winner stress-tested on HOLD-OUT and full 5.6y.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     --config vitest.scripts.config.ts scripts/ftmoV5RecentTuning.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const LOG_PATH = "/tmp/v5_recent_tuning_progress.log";
fs.writeFileSync(LOG_PATH, "");
function log(...args: unknown[]) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  fs.appendFileSync(LOG_PATH, line + "\n");
  // also try console.log so vitest --reporter shows it
  // eslint-disable-next-line no-console
  console.log(line);
}

const TF_HOURS = 2;
const BARS_PER_DAY = 12;
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

// 9 cryptos = V5 baseline asset set (no SOL — V4 dropped it; V5 didn't re-add)
// User mentioned "9 cryptos" — V5 currently uses ETH/BTC/BNB/ADA/DOGE/AVAX/LTC/BCH/LINK
const POOL = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
  "DOGEUSDT",
];

interface BatchResult {
  passes: number;
  windows: number;
  passRate: number;
  medianDays: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  ev: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
): BatchResult {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    passes,
    windows: out.length,
    passRate: out.length > 0 ? passes / out.length : 0,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    ev: (out.length > 0 ? passes / out.length : 0) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(45)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

// Seeded RNG for reproducible random search
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// V5 + atrStop {p:14, m:2.5} — baseline reference
function v5WithAtrStop(): FtmoDaytrade24hConfig {
  return {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    atrStop: { period: 14, stopMult: 2.5 },
    liveCaps: LIVE_CAPS,
    profitTarget: 0.08,
  };
}

interface Trial {
  htfLb: number;
  htfThr: number;
  adxPeriod: number;
  adxMin: number;
  chandPeriod: number;
  chandMult: number;
  breakEven: number;
  hoursDrop: number[]; // hours to DROP from V5's [2,4,6,8,10,12,14,18,20,22]
}

const V5_HOURS = [2, 4, 6, 8, 10, 12, 14, 18, 20, 22];

function trialToCfg(t: Trial): FtmoDaytrade24hConfig {
  const allowedHoursUtc = V5_HOURS.filter((h) => !t.hoursDrop.includes(h));
  return {
    ...v5WithAtrStop(),
    htfTrendFilter: {
      lookbackBars: t.htfLb,
      apply: "long",
      threshold: t.htfThr,
    },
    adxFilter: { period: t.adxPeriod, minAdx: t.adxMin },
    chandelierExit: { period: t.chandPeriod, mult: t.chandMult, minMoveR: 0.5 },
    breakEven: { threshold: t.breakEven },
    allowedHoursUtc,
  };
}

function trialKey(t: Trial): string {
  return `htf${t.htfLb}/${t.htfThr}|adx${t.adxPeriod}/${t.adxMin}|chand${t.chandPeriod}/${t.chandMult}|be${t.breakEven}|drop[${[...t.hoursDrop].sort((a, b) => a - b).join(",")}]`;
}

function trialDesc(t: Trial): string {
  const allowed = V5_HOURS.filter((h) => !t.hoursDrop.includes(h));
  return `htfLb=${t.htfLb} htfThr=${t.htfThr} adx=${t.adxPeriod}/${t.adxMin} chand=${t.chandPeriod}/${t.chandMult} be=${t.breakEven} hours=[${allowed.join(",")}]`;
}

describe(
  "V5 Recent-Regime Tuning (Train → Validation → Hold-Out)",
  { timeout: 24 * 3600_000 },
  () => {
    it("optimises V5 on last 2.5y, validates on 0.5y, holds out 30d", async () => {
      // --- 1. LOAD DATA: 30 000 bars 2h × 9 cryptos ---
      log(`\n=== 1. DATA LOAD ===`);
      const fullData: Record<string, Candle[]> = {};
      for (const s of POOL) {
        fullData[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        log(
          `  ${s}: ${fullData[s].length} bars (${(fullData[s].length / BARS_PER_DAY / 365).toFixed(2)}y)`,
        );
      }
      const n = Math.min(...Object.values(fullData).map((c) => c.length));
      for (const s of POOL) fullData[s] = fullData[s].slice(-n);
      log(
        `\nAligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) / ${POOL.length} assets`,
      );

      // --- 2. SPLIT: Train (2.5y → 0.5y) | Validation (0.5y excl 30d) | Hold-Out (last 30d) ---
      const holdoutBars = 30 * BARS_PER_DAY; // 360
      const valBars = Math.round(0.5 * 365 * BARS_PER_DAY); // ~2190
      const trainBars = Math.round(2.0 * 365 * BARS_PER_DAY); // ~8760

      const holdoutStart = n - holdoutBars;
      const valEnd = holdoutStart;
      const valStart = Math.max(0, valEnd - valBars);
      const trainEnd = valStart;
      const trainStart = Math.max(0, trainEnd - trainBars);

      const trainData: Record<string, Candle[]> = {};
      const valData: Record<string, Candle[]> = {};
      const holdoutData: Record<string, Candle[]> = {};
      for (const s of POOL) {
        trainData[s] = fullData[s].slice(trainStart, trainEnd);
        valData[s] = fullData[s].slice(valStart, valEnd);
        holdoutData[s] = fullData[s].slice(holdoutStart);
      }
      const trainBarsActual = trainEnd - trainStart;
      const valBarsActual = valEnd - valStart;
      log(
        `\nSplit (newest data right):\n` +
          `  Train     : ${trainBarsActual} bars (${(trainBarsActual / BARS_PER_DAY).toFixed(0)}d / ${(trainBarsActual / BARS_PER_DAY / 365).toFixed(2)}y)\n` +
          `  Validation: ${valBarsActual} bars (${(valBarsActual / BARS_PER_DAY).toFixed(0)}d / ${(valBarsActual / BARS_PER_DAY / 365).toFixed(2)}y)\n` +
          `  Hold-Out  : ${holdoutBars} bars (30d)\n` +
          `  Full OOS  : ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) — sanity check at end`,
      );

      // --- 3. BASELINE: V5+atrStop on each split ---
      log(`\n=== 3. BASELINE V5+atrStop ===`);
      const baseline = v5WithAtrStop();
      const blTrain = runWalkForward(trainData, baseline);
      const blVal = runWalkForward(valData, baseline);
      const blHold = runWalkForward(holdoutData, baseline, 1);
      const blFull = runWalkForward(fullData, baseline);
      log(fmt("V5+atrStop on TRAIN     ", blTrain));
      log(fmt("V5+atrStop on VALIDATION", blVal));
      log(fmt("V5+atrStop on HOLD-OUT  ", blHold));
      log(fmt("V5+atrStop on FULL 5.6y ", blFull));

      // --- 4. RANDOM SEARCH 500 trials on TRAIN ---
      log(`\n=== 4. RANDOM SEARCH (500 trials on TRAIN) ===`);
      const HTF_LB = [12, 18, 24, 36, 48];
      const HTF_THR = [0.005, 0.01, 0.015, 0.02, 0.03];
      const ADX_P = [14, 20, 28];
      const ADX_M = [3, 5, 7, 10, 15];
      const CHAND_P = [40, 56, 80];
      const CHAND_M = [1.0, 1.5, 2.0];
      const BE = [0.02, 0.03, 0.05];
      const HOURS_OPT = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

      const rng = mulberry32(20260427);
      const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
      const pickHoursDrop = () => {
        // Drop random subset of V5_HOURS (keep at least 5 hours active)
        const dropCount = Math.floor(rng() * 5); // 0..4 hours dropped
        const shuffled = [...V5_HOURS].sort(() => rng() - 0.5);
        return shuffled.slice(0, dropCount);
      };

      const seen = new Set<string>();
      const trials: Array<{ trial: Trial; r: BatchResult }> = [];
      let attempts = 0;
      const TARGET = 500;
      const MAX_ATTEMPTS = TARGET * 3;
      const t0 = Date.now();
      while (trials.length < TARGET && attempts < MAX_ATTEMPTS) {
        attempts++;
        const trial: Trial = {
          htfLb: pick(HTF_LB),
          htfThr: pick(HTF_THR),
          adxPeriod: pick(ADX_P),
          adxMin: pick(ADX_M),
          chandPeriod: pick(CHAND_P),
          chandMult: pick(CHAND_M),
          breakEven: pick(BE),
          hoursDrop: pickHoursDrop(),
        };
        const key = trialKey(trial);
        if (seen.has(key)) continue;
        seen.add(key);
        const cfg = trialToCfg(trial);
        const r = runWalkForward(trainData, cfg);
        trials.push({ trial, r });
        if (trials.length % 50 === 0) {
          const dt = (Date.now() - t0) / 1000;
          const eta = (dt / trials.length) * (TARGET - trials.length);
          const top = trials.reduce((a, b) =>
            b.r.passRate > a.r.passRate ? b : a,
          );
          log(
            `  trial ${trials.length}/${TARGET} (${dt.toFixed(0)}s, ETA ${eta.toFixed(0)}s)  best so far: ${(top.r.passRate * 100).toFixed(2)}% — ${trialDesc(top.trial)}`,
          );
        }
      }
      log(
        `\n  Completed ${trials.length} unique trials in ${((Date.now() - t0) / 1000).toFixed(0)}s.`,
      );

      // --- 5. TOP-10 ON VALIDATION ---
      log(`\n=== 5. TOP-10 ON VALIDATION ===`);
      trials.sort((a, b) => {
        const dPass = b.r.passRate - a.r.passRate;
        if (Math.abs(dPass) > 1e-9) return dPass;
        return a.r.p90Days - b.r.p90Days;
      });
      const top10 = trials.slice(0, 10);
      log(`Top-10 from TRAIN:`);
      for (let i = 0; i < top10.length; i++) {
        log(
          `  #${i + 1} TRAIN: ${(top10[i].r.passRate * 100).toFixed(2)}% — ${trialDesc(top10[i].trial)}`,
        );
      }

      log(`\nValidation results:`);
      const valScores: Array<{
        trial: Trial;
        train: BatchResult;
        val: BatchResult;
      }> = [];
      for (let i = 0; i < top10.length; i++) {
        const t = top10[i].trial;
        const cfg = trialToCfg(t);
        const valR = runWalkForward(valData, cfg);
        valScores.push({ trial: t, train: top10[i].r, val: valR });
        log(
          fmt(
            `  #${i + 1} VAL  (train=${(top10[i].r.passRate * 100).toFixed(1)}%)`,
            valR,
          ),
        );
      }

      // Pick the validation winner — best validation pass-rate, ties → best train
      valScores.sort((a, b) => {
        const d = b.val.passRate - a.val.passRate;
        if (Math.abs(d) > 1e-9) return d;
        return b.train.passRate - a.train.passRate;
      });
      const winner = valScores[0];
      log(
        `\n  WINNER on VALIDATION: ${(winner.val.passRate * 100).toFixed(2)}%`,
      );
      log(`  Config: ${trialDesc(winner.trial)}`);

      // --- 6. HOLD-OUT ---
      log(`\n=== 6. HOLD-OUT (last 30d, single window) ===`);
      const winnerCfg = trialToCfg(winner.trial);
      const holdR = runWalkForward(holdoutData, winnerCfg, 1);
      log(fmt("Winner on HOLD-OUT", holdR));

      // --- 7. FULL 5.6y OOS ---
      log(`\n=== 7. FULL 5.6y OOS SANITY CHECK ===`);
      const fullR = runWalkForward(fullData, winnerCfg);
      log(fmt("Winner on FULL 5.6y", fullR));

      // --- 8. DIAGNOSIS ---
      log(`\n========== FINAL REPORT ==========`);
      log(fmt("V5+atrStop TRAIN  ", blTrain));
      log(fmt("V5+atrStop VAL    ", blVal));
      log(fmt("V5+atrStop HOLD   ", blHold));
      log(fmt("V5+atrStop FULL   ", blFull));
      log(`---`);
      log(fmt("Recent TRAIN      ", winner.train));
      log(fmt("Recent VAL        ", winner.val));
      log(fmt("Recent HOLD-OUT   ", holdR));
      log(fmt("Recent FULL 5.6y  ", fullR));
      log(`---`);
      log(
        `Δ Recent vs V5 on VAL : +${((winner.val.passRate - blVal.passRate) * 100).toFixed(2)}pp`,
      );
      log(
        `Δ Recent vs V5 on HOLD: +${((holdR.passRate - blHold.passRate) * 100).toFixed(2)}pp`,
      );
      log(
        `Δ Recent vs V5 on 5.6y: ${((fullR.passRate - blFull.passRate) * 100).toFixed(2)}pp`,
      );
      log(
        `HOLD vs VAL drift     : ${((holdR.passRate - winner.val.passRate) * 100).toFixed(2)}pp (overfit if << 0)`,
      );

      const valOk = winner.val.passRate >= 0.5;
      const driftOk = winner.val.passRate - holdR.passRate < 0.03;
      const fullOk = fullR.passRate >= 0.42;
      const beatsV5OnRecent = winner.val.passRate > blVal.passRate;

      log(`\nGate check:`);
      log(
        `  [${valOk ? "PASS" : "FAIL"}] Validation ≥ 50%        : ${(winner.val.passRate * 100).toFixed(2)}%`,
      );
      log(
        `  [${driftOk ? "PASS" : "FAIL"}] Hold-Out drift < 3pp    : ${((winner.val.passRate - holdR.passRate) * 100).toFixed(2)}pp`,
      );
      log(
        `  [${fullOk ? "PASS" : "FAIL"}] Full-5.6y ≥ 42%         : ${(fullR.passRate * 100).toFixed(2)}%`,
      );
      log(
        `  [${beatsV5OnRecent ? "YES" : "NO "}] Beats V5 on recent VAL : ${((winner.val.passRate - blVal.passRate) * 100).toFixed(2)}pp`,
      );

      const allPass = valOk && driftOk && fullOk && beatsV5OnRecent;
      log(
        `\nVerdict: ${allPass ? "DEPLOY → V5_RECENT_2026" : "DO NOT DEPLOY — recent-regime tuning has no defendable edge or is overfit."}`,
      );

      // Code snippet
      const allowedHoursUtc = V5_HOURS.filter(
        (h) => !winner.trial.hoursDrop.includes(h),
      );
      log(`\n--- Suggested export (only paste if verdict = DEPLOY) ---`);
      log(
        `export const FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT_2026: FtmoDaytrade24hConfig = {`,
      );
      log(`  ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,`);
      log(`  atrStop: { period: 14, stopMult: 2.5 },`);
      log(
        `  htfTrendFilter: { lookbackBars: ${winner.trial.htfLb}, apply: "long", threshold: ${winner.trial.htfThr} },`,
      );
      log(
        `  adxFilter: { period: ${winner.trial.adxPeriod}, minAdx: ${winner.trial.adxMin} },`,
      );
      log(
        `  chandelierExit: { period: ${winner.trial.chandPeriod}, mult: ${winner.trial.chandMult}, minMoveR: 0.5 },`,
      );
      log(`  breakEven: { threshold: ${winner.trial.breakEven} },`);
      log(`  allowedHoursUtc: [${allowedHoursUtc.join(", ")}],`);
      log(`};`);

      expect(trials.length).toBeGreaterThan(100);
      expect(holdR.windows).toBeGreaterThan(0);
    });
  },
);
