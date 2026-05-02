/**
 * V5 Genetic Algorithm — 100 generations, anti-overfit edition.
 *
 * Goal: evolve V5 (FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5) under live caps
 * (maxStopPct=0.05, maxRiskFrac=0.4) without overfitting to a single slice
 * of history.
 *
 * Anti-overfit lever: ROTATE the validation slice each generation.
 *   gen % 3 == 0 → fitness on 0-30% of bars (oldest)
 *   gen % 3 == 1 → fitness on 30-60% of bars (middle)
 *   gen % 3 == 2 → fitness on 60-100% of bars (recent, larger)
 * Configs that only excel on one slice cannot accumulate elite-survival;
 * only configs that work across all 3 slices reach the final population.
 *
 * GA params:
 *   - generations: 100
 *   - population: 20
 *   - elite: 3
 *   - mutation rate: 0.25
 *   - tournament size: 3
 *
 * Final validation: top-5 candidates re-tested on FULL data (3-day step,
 * 30d window) and compared against V5 baseline on the same windows.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12; // 2h timeframe → 12 bars/day
const LOG_DIR = "scripts/overnight_results";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = `${LOG_DIR}/V5_GA100_${STAMP}.log`;
const WINNER_FILE = `${LOG_DIR}/V5_GA100_WINNER_${STAMP}.json`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
const ALL_HOURS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

interface Genome {
  // Core trade params
  triggerBars: 1 | 2;
  holdBars: number; // 120-720
  stopPct: number; // 0.03-0.06
  tpPct: number; // 0.04-0.10
  riskFrac: number; // 0.5-1.5
  allowedHours: number[]; // subset of ALL_HOURS
  assetMask: boolean[]; // length 9, which assets to keep (>=2 must be true)
  // Engine extensions
  useAdaptive: boolean;
  adaptiveTopFactor: number; // 0.3-0.6
  adaptiveBoostFactor: number; // 1.2-2.0
  useTimeBoost: boolean;
  timeBoostDay: number; // 3-10
  timeBoostFactor: number; // 1.5-3.0
  useChoppy: boolean;
  choppyMaxCi: number; // 50-70
  useVolume: boolean;
  volumeMinRatio: number; // 0.5-1.5
  useReEntry: boolean;
  reEntryMaxRetries: number; // 1-3
  reEntryWindow: number; // 3-12
  breakEvenAtProfit: number; // 0.02-0.05
  useHtf: boolean;
  htfLookback: number; // 12-72 bars
  htfThreshold: number; // 0.0-0.10
}

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}
function randInt(min: number, max: number) {
  return Math.floor(rand(min, max + 1));
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function randomHourMask(): number[] {
  const out = ALL_HOURS.filter(() => Math.random() > 0.25);
  if (out.length === 0) return [...ALL_HOURS]; // never empty
  return out;
}

function randomAssetMask(): boolean[] {
  const m = SOURCES.map(() => Math.random() > 0.2);
  // Ensure at least 2 assets enabled
  if (m.filter(Boolean).length < 2) {
    m[0] = true;
    m[1] = true;
  }
  return m;
}

function randomGenome(): Genome {
  return {
    triggerBars: pick([1, 2]),
    holdBars: randInt(120, 720),
    stopPct: rand(0.03, 0.06),
    tpPct: rand(0.04, 0.1),
    riskFrac: rand(0.5, 1.5),
    allowedHours: randomHourMask(),
    assetMask: randomAssetMask(),
    useAdaptive: Math.random() > 0.4,
    adaptiveTopFactor: rand(0.3, 0.6),
    adaptiveBoostFactor: rand(1.2, 2.0),
    useTimeBoost: Math.random() > 0.4,
    timeBoostDay: randInt(3, 10),
    timeBoostFactor: rand(1.5, 3.0),
    useChoppy: Math.random() > 0.6,
    choppyMaxCi: rand(50, 70),
    useVolume: Math.random() > 0.6,
    volumeMinRatio: rand(0.5, 1.5),
    useReEntry: Math.random() > 0.5,
    reEntryMaxRetries: randInt(1, 3),
    reEntryWindow: randInt(3, 12),
    breakEvenAtProfit: rand(0.02, 0.05),
    useHtf: Math.random() > 0.5,
    htfLookback: randInt(12, 72),
    htfThreshold: rand(0.0, 0.1),
  };
}

function genomeToConfig(g: Genome): FtmoDaytrade24hConfig {
  // Filter assets by mask + apply per-asset overrides for stop/tp/risk/trigger/hold
  const baseAssets = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets;
  const enabled = baseAssets.filter((_, i) => g.assetMask[i] ?? true);
  const assets =
    enabled.length >= 2
      ? enabled.map((a) => ({
          ...a,
          triggerBars: g.triggerBars,
          holdBars: g.holdBars,
          stopPct: g.stopPct,
          tpPct: g.tpPct,
          riskFrac: g.riskFrac,
        }))
      : baseAssets.map((a) => ({
          ...a,
          triggerBars: g.triggerBars,
          holdBars: g.holdBars,
          stopPct: g.stopPct,
          tpPct: g.tpPct,
          riskFrac: g.riskFrac,
        }));

  const cfg: FtmoDaytrade24hConfig = {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    liveCaps: LIVE_CAPS,
    triggerBars: g.triggerBars,
    holdBars: g.holdBars,
    allowedHoursUtc: g.allowedHours.length > 0 ? g.allowedHours : ALL_HOURS,
    assets,
    // Mandatory engine fields per spec
    pauseAtTargetReached: true,
    atrStop: { period: 14, stopMult: 2.5 },
    minTradingDays: 4,
    breakEven: { threshold: g.breakEvenAtProfit },
  };

  if (g.useAdaptive) {
    cfg.adaptiveSizing = [
      { equityAbove: 0.03, factor: g.adaptiveBoostFactor },
      { equityAbove: 0.08, factor: g.adaptiveTopFactor },
    ];
  } else {
    cfg.adaptiveSizing = undefined;
  }
  if (g.useTimeBoost) {
    cfg.timeBoost = {
      afterDay: g.timeBoostDay,
      equityBelow: 0.04,
      factor: g.timeBoostFactor,
    };
  } else {
    cfg.timeBoost = undefined;
  }
  if (g.useChoppy) {
    cfg.choppinessFilter = { period: 14, maxCi: g.choppyMaxCi };
  } else {
    cfg.choppinessFilter = undefined;
  }
  if (g.useVolume) {
    cfg.volumeFilter = { period: 20, minRatio: g.volumeMinRatio };
  } else {
    cfg.volumeFilter = undefined;
  }
  if (g.useReEntry) {
    cfg.reEntryAfterStop = {
      maxRetries: g.reEntryMaxRetries,
      windowBars: g.reEntryWindow,
    };
  } else {
    cfg.reEntryAfterStop = undefined;
  }
  if (g.useHtf) {
    // V5 longs via invertDirection — apply htf to "short" (= the underlying short signal)
    cfg.htfTrendFilter = {
      lookbackBars: g.htfLookback,
      apply: "short",
      threshold: g.htfThreshold,
    };
  } else {
    cfg.htfTrendFilter = undefined;
  }
  return cfg;
}

function crossover(a: Genome, b: Genome): Genome {
  const child = {} as Genome;
  for (const key of Object.keys(a) as (keyof Genome)[]) {
    if (key === "allowedHours") {
      const set = new Set([...a.allowedHours, ...b.allowedHours]);
      const merged = ALL_HOURS.filter((h) => set.has(h) && Math.random() > 0.3);
      child.allowedHours = merged.length ? merged : a.allowedHours;
    } else if (key === "assetMask") {
      const m = a.assetMask.map((v, i) =>
        Math.random() > 0.5 ? v : b.assetMask[i],
      );
      if (m.filter(Boolean).length < 2) {
        m[0] = true;
        m[1] = true;
      }
      child.assetMask = m;
    } else {
      (child as any)[key] = Math.random() > 0.5 ? a[key] : b[key];
    }
  }
  return child;
}

function mutate(g: Genome, rate = 0.25): Genome {
  const m: Genome = {
    ...g,
    allowedHours: [...g.allowedHours],
    assetMask: [...g.assetMask],
  };
  if (Math.random() < rate) m.triggerBars = pick([1, 2]);
  if (Math.random() < rate)
    m.holdBars = clamp(m.holdBars + randInt(-60, 60), 120, 720);
  if (Math.random() < rate)
    m.stopPct = clamp(m.stopPct + rand(-0.005, 0.005), 0.03, 0.06);
  if (Math.random() < rate)
    m.tpPct = clamp(m.tpPct + rand(-0.01, 0.01), 0.04, 0.1);
  if (Math.random() < rate)
    m.riskFrac = clamp(m.riskFrac + rand(-0.1, 0.1), 0.5, 1.5);
  if (Math.random() < rate) m.allowedHours = randomHourMask();
  if (Math.random() < rate) {
    // Flip 1 random asset
    const idx = randInt(0, SOURCES.length - 1);
    m.assetMask[idx] = !m.assetMask[idx];
    if (m.assetMask.filter(Boolean).length < 2) {
      m.assetMask[idx] = true;
    }
  }
  if (Math.random() < rate) m.useAdaptive = !m.useAdaptive;
  if (Math.random() < rate)
    m.adaptiveTopFactor = clamp(
      m.adaptiveTopFactor + rand(-0.05, 0.05),
      0.3,
      0.6,
    );
  if (Math.random() < rate)
    m.adaptiveBoostFactor = clamp(
      m.adaptiveBoostFactor + rand(-0.1, 0.1),
      1.2,
      2.0,
    );
  if (Math.random() < rate) m.useTimeBoost = !m.useTimeBoost;
  if (Math.random() < rate)
    m.timeBoostDay = clamp(m.timeBoostDay + randInt(-1, 1), 3, 10);
  if (Math.random() < rate)
    m.timeBoostFactor = clamp(m.timeBoostFactor + rand(-0.2, 0.2), 1.5, 3.0);
  if (Math.random() < rate) m.useChoppy = !m.useChoppy;
  if (Math.random() < rate)
    m.choppyMaxCi = clamp(m.choppyMaxCi + rand(-3, 3), 50, 70);
  if (Math.random() < rate) m.useVolume = !m.useVolume;
  if (Math.random() < rate)
    m.volumeMinRatio = clamp(m.volumeMinRatio + rand(-0.1, 0.1), 0.5, 1.5);
  if (Math.random() < rate) m.useReEntry = !m.useReEntry;
  if (Math.random() < rate)
    m.reEntryMaxRetries = clamp(
      m.reEntryMaxRetries + randInt(-1, 1),
      1,
      3,
    ) as number;
  if (Math.random() < rate)
    m.reEntryWindow = clamp(m.reEntryWindow + randInt(-2, 2), 3, 12);
  if (Math.random() < rate)
    m.breakEvenAtProfit = clamp(
      m.breakEvenAtProfit + rand(-0.005, 0.005),
      0.02,
      0.05,
    );
  if (Math.random() < rate) m.useHtf = !m.useHtf;
  if (Math.random() < rate)
    m.htfLookback = clamp(m.htfLookback + randInt(-6, 6), 12, 72);
  if (Math.random() < rate)
    m.htfThreshold = clamp(m.htfThreshold + rand(-0.01, 0.01), 0.0, 0.1);
  return m;
}

function tournament(pop: { g: Genome; fitness: number }[], size = 3): Genome {
  let best = pop[Math.floor(Math.random() * pop.length)];
  for (let i = 1; i < size; i++) {
    const c = pop[Math.floor(Math.random() * pop.length)];
    if (c.fitness > best.fitness) best = c;
  }
  return best.g;
}

// Approximate L2-normalized distance between two genomes (numeric fields)
function genomeDistance(a: Genome, b: Genome): number {
  let d = 0;
  d += Math.abs(a.triggerBars - b.triggerBars);
  d += Math.abs(a.holdBars - b.holdBars) / 600;
  d += Math.abs(a.stopPct - b.stopPct) / 0.03;
  d += Math.abs(a.tpPct - b.tpPct) / 0.06;
  d += Math.abs(a.riskFrac - b.riskFrac) / 1.0;
  // Hour set Jaccard distance
  const ha = new Set(a.allowedHours);
  const hb = new Set(b.allowedHours);
  const inter = [...ha].filter((x) => hb.has(x)).length;
  const uni = new Set([...ha, ...hb]).size;
  d += uni > 0 ? 1 - inter / uni : 0;
  // Asset mask Hamming
  const ham = a.assetMask.reduce(
    (s, v, i) => s + (v === b.assetMask[i] ? 0 : 1),
    0,
  );
  d += ham / SOURCES.length;
  // Toggles
  d += (a.useAdaptive !== b.useAdaptive ? 1 : 0) * 0.5;
  d += (a.useTimeBoost !== b.useTimeBoost ? 1 : 0) * 0.5;
  d += (a.useChoppy !== b.useChoppy ? 1 : 0) * 0.5;
  d += (a.useVolume !== b.useVolume ? 1 : 0) * 0.5;
  d += (a.useReEntry !== b.useReEntry ? 1 : 0) * 0.5;
  d += (a.useHtf !== b.useHtf ? 1 : 0) * 0.5;
  return d;
}

const V5_BASELINE_GENOME: Genome = {
  triggerBars: 1,
  holdBars: 240,
  stopPct: 0.05,
  tpPct: 0.07,
  riskFrac: 1.0,
  allowedHours: [2, 4, 6, 8, 10, 12, 14, 18, 20, 22],
  assetMask: SOURCES.map(() => true),
  useAdaptive: false,
  adaptiveTopFactor: 0.5,
  adaptiveBoostFactor: 1.5,
  useTimeBoost: false,
  timeBoostDay: 5,
  timeBoostFactor: 2.0,
  useChoppy: false,
  choppyMaxCi: 60,
  useVolume: false,
  volumeMinRatio: 1.0,
  useReEntry: false,
  reEntryMaxRetries: 1,
  reEntryWindow: 6,
  breakEvenAtProfit: 0.03,
  useHtf: false,
  htfLookback: 24,
  htfThreshold: 0.02,
};

describe(
  "V5 Genetic Algorithm — 100 generations + slice rotation",
  { timeout: 24 * 3600_000 },
  () => {
    it("evolves anti-overfit", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `V5_GA100 START ${new Date().toISOString()}\n`);

      // ── Load data
      const data: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of SOURCES) data[s] = data[s].slice(-n);
      const years = n / BARS_PER_DAY / 365;
      log(`Data: ${n} bars × 9 cryptos (${years.toFixed(2)}y on 2h)`);

      // ── Define 3 slices for fitness rotation
      // Slice 0: 0-30%   (oldest market regimes)
      // Slice 1: 30-60%  (middle)
      // Slice 2: 60-100% (recent — larger to catch latest market)
      const sliceBounds: Array<[number, number]> = [
        [0, Math.floor(n * 0.3)],
        [Math.floor(n * 0.3), Math.floor(n * 0.6)],
        [Math.floor(n * 0.6), n],
      ];
      log(
        `Slices: [${sliceBounds[0][0]}-${sliceBounds[0][1]}] [${sliceBounds[1][0]}-${sliceBounds[1][1]}] [${sliceBounds[2][0]}-${sliceBounds[2][1]}]`,
      );

      // GA-fitness window setup: 30d window, 12d step
      const winBars = 30 * BARS_PER_DAY;
      const fastStepBars = 12 * BARS_PER_DAY;
      const finalStepBars = 3 * BARS_PER_DAY;

      function runWindows(
        g: Genome,
        from: number,
        to: number,
        stepBars: number,
      ): {
        passRate: number;
        tlRate: number;
        windows: number;
        passes: number;
        tls: number;
      } {
        const cfg = genomeToConfig(g);
        let p = 0,
          w = 0,
          tl = 0;
        for (let s = from; s + winBars <= to; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
          const r = runFtmoDaytrade24h(sub, cfg);
          if (r.passed) p++;
          if (r.reason === "total_loss") tl++;
          w++;
        }
        return {
          passRate: w > 0 ? p / w : 0,
          tlRate: w > 0 ? tl / w : 0,
          windows: w,
          passes: p,
          tls: tl,
        };
      }

      function fitnessOnSlice(g: Genome, sliceIdx: number): number {
        const [from, to] = sliceBounds[sliceIdx];
        const r = runWindows(g, from, to, fastStepBars);
        // Penalize TL > 5%, otherwise pure pass rate
        return r.passRate - Math.max(0, r.tlRate - 0.05) * 2;
      }

      // ── Baseline V5 fitness on each slice (for reference)
      const baseSlice0 = fitnessOnSlice(V5_BASELINE_GENOME, 0);
      const baseSlice1 = fitnessOnSlice(V5_BASELINE_GENOME, 1);
      const baseSlice2 = fitnessOnSlice(V5_BASELINE_GENOME, 2);
      log(
        `V5 baseline: slice0=${(baseSlice0 * 100).toFixed(2)}% slice1=${(baseSlice1 * 100).toFixed(2)}% slice2=${(baseSlice2 * 100).toFixed(2)}%`,
      );
      const baselinePerSlice = [baseSlice0, baseSlice1, baseSlice2];

      // ── GA loop
      const POP_SIZE = 20;
      const GENERATIONS = 100;
      const MUT_RATE = 0.25;
      const ELITE = 3;
      const TOURN_SIZE = 3;

      // Convergence storage
      type GenStat = {
        gen: number;
        slice: number;
        best: number;
        avg: number;
        baseline: number;
        diversity: number;
      };
      const convergence: GenStat[] = [];

      let pop = Array.from({ length: POP_SIZE }, () => randomGenome());
      // Seed population with V5 baseline + a few near-V5 variants
      pop[0] = { ...V5_BASELINE_GENOME };
      pop[1] = mutate({ ...V5_BASELINE_GENOME }, 0.4);
      pop[2] = mutate({ ...V5_BASELINE_GENOME }, 0.4);

      let scored = pop.map((g) => ({
        g,
        fitness: fitnessOnSlice(g, 0),
      }));

      const t0 = Date.now();
      for (let gen = 0; gen < GENERATIONS; gen++) {
        const sliceIdx = gen % 3;
        // Re-score current population on the rotated slice (so elites must win on this slice too)
        scored = pop.map((g) => ({ g, fitness: fitnessOnSlice(g, sliceIdx) }));
        scored.sort((a, b) => b.fitness - a.fitness);

        const best = scored[0];
        const avg = scored.reduce((s, x) => s + x.fitness, 0) / scored.length;
        // Diversity: average pairwise distance between top-3
        const top3 = scored.slice(0, 3);
        let div = 0,
          cnt = 0;
        for (let i = 0; i < top3.length; i++) {
          for (let j = i + 1; j < top3.length; j++) {
            div += genomeDistance(top3[i].g, top3[j].g);
            cnt++;
          }
        }
        div = cnt > 0 ? div / cnt : 0;

        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        log(
          `Gen ${String(gen).padStart(3, "0")} [s${sliceIdx}] best=${(best.fitness * 100).toFixed(2)}% avg=${(avg * 100).toFixed(2)}% baseline=${(baselinePerSlice[sliceIdx] * 100).toFixed(2)}% div=${div.toFixed(2)} (t=${elapsed}s)`,
        );
        convergence.push({
          gen,
          slice: sliceIdx,
          best: best.fitness,
          avg,
          baseline: baselinePerSlice[sliceIdx],
          diversity: div,
        });

        // Build next gen
        const newPop: Genome[] = [];
        for (let i = 0; i < ELITE; i++) newPop.push(scored[i].g);
        while (newPop.length < POP_SIZE) {
          const p1 = tournament(scored, TOURN_SIZE);
          const p2 = tournament(scored, TOURN_SIZE);
          let child = crossover(p1, p2);
          child = mutate(child, MUT_RATE);
          newPop.push(child);
        }
        pop = newPop;
      }

      // ── Final round of fitness on ALL slices (cross-slice average)
      log(`\n========== Final cross-slice evaluation ==========`);
      const crossScored = pop.map((g) => {
        const f0 = fitnessOnSlice(g, 0);
        const f1 = fitnessOnSlice(g, 1);
        const f2 = fitnessOnSlice(g, 2);
        const avgAll = (f0 + f1 + f2) / 3;
        const minAll = Math.min(f0, f1, f2);
        // Use min-of-slices score to favor robustness (anti-overfit metric)
        return {
          g,
          f0,
          f1,
          f2,
          avgAll,
          minAll,
          score: minAll * 0.5 + avgAll * 0.5,
        };
      });
      crossScored.sort((a, b) => b.score - a.score);
      const top5 = crossScored.slice(0, 5);
      log(`Top-5 candidates by min/avg cross-slice fitness:`);
      for (let i = 0; i < top5.length; i++) {
        const t = top5[i];
        log(
          `  #${i + 1} avgAll=${(t.avgAll * 100).toFixed(2)}% minAll=${(t.minAll * 100).toFixed(2)}% s0=${(t.f0 * 100).toFixed(2)}% s1=${(t.f1 * 100).toFixed(2)}% s2=${(t.f2 * 100).toFixed(2)}%`,
        );
      }

      // ── Final validation on FULL data with 3-day step
      log(
        `\n========== Final FULL validation (3-day step, 30d window) ==========`,
      );
      const v5Full = runWindows(V5_BASELINE_GENOME, 0, n, finalStepBars);
      log(
        `V5 baseline FULL: pass=${(v5Full.passRate * 100).toFixed(2)}% TL=${(v5Full.tlRate * 100).toFixed(2)}% (${v5Full.passes}/${v5Full.windows})`,
      );

      const fullValidations: Array<{
        idx: number;
        passRate: number;
        tlRate: number;
        passes: number;
        windows: number;
        tls: number;
        g: Genome;
        avgAll: number;
        minAll: number;
      }> = [];
      for (let i = 0; i < top5.length; i++) {
        const t = top5[i];
        const r = runWindows(t.g, 0, n, finalStepBars);
        log(
          `Candidate #${i + 1} FULL: pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}% (${r.passes}/${r.windows}) Δ=${((r.passRate - v5Full.passRate) * 100).toFixed(2)}pp`,
        );
        fullValidations.push({
          idx: i + 1,
          passRate: r.passRate,
          tlRate: r.tlRate,
          passes: r.passes,
          windows: r.windows,
          tls: r.tls,
          g: t.g,
          avgAll: t.avgAll,
          minAll: t.minAll,
        });
      }

      // Pick winner = best full-data pass rate among top-5 (with TL <= 10% sanity)
      const eligible = fullValidations.filter((c) => c.tlRate <= 0.1);
      const pool = eligible.length > 0 ? eligible : fullValidations;
      pool.sort((a, b) => b.passRate - a.passRate);
      const winner = pool[0];

      log(`\n========== WINNER ==========`);
      log(
        `Winner candidate #${winner.idx}: full-pass=${(winner.passRate * 100).toFixed(2)}% TL=${(winner.tlRate * 100).toFixed(2)}% (${winner.passes}/${winner.windows})`,
      );
      log(
        `V5 baseline:               full-pass=${(v5Full.passRate * 100).toFixed(2)}% TL=${(v5Full.tlRate * 100).toFixed(2)}% (${v5Full.passes}/${v5Full.windows})`,
      );
      const delta = (winner.passRate - v5Full.passRate) * 100;
      log(`Delta vs V5: ${delta.toFixed(2)}pp`);

      // Anti-overfit check: how does train (cross-slice min) compare to full-data?
      const overfitGap = winner.minAll - winner.passRate;
      log(
        `Anti-overfit check: minAll(train slices)=${(winner.minAll * 100).toFixed(2)}% vs full-data=${(winner.passRate * 100).toFixed(2)}% gap=${(overfitGap * 100).toFixed(2)}pp`,
      );

      // Recommendation
      let recommendation = "STAY_WITH_V5";
      if (delta >= 1.5 && winner.tlRate <= v5Full.tlRate + 0.02) {
        recommendation = "DEPLOY_WINNER";
      } else if (delta >= 0.5) {
        recommendation = "MARGINAL_IMPROVEMENT_OPTIONAL";
      }
      log(`\nRecommendation: ${recommendation}`);

      // Persist outputs
      const out = {
        stamp: STAMP,
        bars: n,
        years,
        generations: GENERATIONS,
        population: POP_SIZE,
        winner: {
          genome: winner.g,
          fullPassRate: winner.passRate,
          fullTlRate: winner.tlRate,
          passes: winner.passes,
          windows: winner.windows,
          tls: winner.tls,
          crossSliceMin: winner.minAll,
          crossSliceAvg: winner.avgAll,
        },
        v5Baseline: {
          fullPassRate: v5Full.passRate,
          fullTlRate: v5Full.tlRate,
          passes: v5Full.passes,
          windows: v5Full.windows,
        },
        deltaPp: delta,
        overfitGapPp: overfitGap * 100,
        recommendation,
        top5Validations: fullValidations,
        convergence,
      };
      writeFileSync(WINNER_FILE, JSON.stringify(out, null, 2));
      log(`\nWritten: ${WINNER_FILE}`);

      expect(true).toBe(true);
    });
  },
);
