/**
 * V5 Genetic Algorithm — bot self-improves via evolution.
 * Population of N configs, fitness = pass-rate under live caps.
 * Tournament selection + uniform crossover + mutation.
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

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_GA_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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
  // Core params V5 inherits from V4 — we evolve these
  triggerBars: 1 | 2;
  holdBars: number; // 120-720
  stopPct: number; // 0.03-0.06
  tpPct: number; // 0.04-0.10
  riskFrac: number; // 0.5-1.0
  allowedHours: number[]; // subset of ALL_HOURS
  // Engine extensions
  useAdaptive: boolean;
  adaptiveTopFactor: number; // 0.3-0.6 (size at +8%)
  adaptiveBoostFactor: number; // 1.2-2.0 (size at +3%)
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

function randomGenome(): Genome {
  return {
    triggerBars: pick([1, 2]),
    holdBars: randInt(120, 480),
    stopPct: rand(0.04, 0.06),
    tpPct: rand(0.05, 0.09),
    riskFrac: rand(0.7, 1.2),
    allowedHours: ALL_HOURS.filter(() => Math.random() > 0.2),
    useAdaptive: Math.random() > 0.5,
    adaptiveTopFactor: rand(0.3, 0.6),
    adaptiveBoostFactor: rand(1.2, 2.0),
    useTimeBoost: Math.random() > 0.5,
    timeBoostDay: randInt(3, 10),
    timeBoostFactor: rand(1.5, 3.0),
    useChoppy: Math.random() > 0.6,
    choppyMaxCi: rand(50, 70),
    useVolume: Math.random() > 0.6,
    volumeMinRatio: rand(0.5, 1.5),
    useReEntry: Math.random() > 0.5,
    reEntryMaxRetries: randInt(1, 3),
    reEntryWindow: randInt(3, 12),
  };
}

function genomeToConfig(g: Genome): FtmoDaytrade24hConfig {
  const cfg: FtmoDaytrade24hConfig = {
    ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    liveCaps: LIVE_CAPS,
    triggerBars: g.triggerBars,
    holdBars: g.holdBars,
    allowedHoursUtc: g.allowedHours.length > 0 ? g.allowedHours : ALL_HOURS,
    assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
      ...a,
      triggerBars: g.triggerBars,
      holdBars: g.holdBars,
      stopPct: g.stopPct,
      tpPct: g.tpPct,
      riskFrac: g.riskFrac,
    })),
  };
  if (g.useAdaptive)
    cfg.adaptiveSizing = [
      { equityAbove: 0.03, factor: g.adaptiveBoostFactor },
      { equityAbove: 0.08, factor: g.adaptiveTopFactor },
    ];
  if (g.useTimeBoost)
    cfg.timeBoost = {
      afterDay: g.timeBoostDay,
      equityBelow: 0.04,
      factor: g.timeBoostFactor,
    };
  if (g.useChoppy) cfg.choppinessFilter = { period: 14, maxCi: g.choppyMaxCi };
  if (g.useVolume)
    cfg.volumeFilter = { period: 20, minRatio: g.volumeMinRatio };
  if (g.useReEntry)
    cfg.reEntryAfterStop = {
      maxRetries: g.reEntryMaxRetries,
      windowBars: g.reEntryWindow,
    };
  return cfg;
}

function crossover(a: Genome, b: Genome): Genome {
  const child = {} as Genome;
  for (const key of Object.keys(a) as (keyof Genome)[]) {
    if (key === "allowedHours") {
      // hour-list crossover: union with random pruning
      const set = new Set([...a.allowedHours, ...b.allowedHours]);
      child.allowedHours = ALL_HOURS.filter(
        (h) => set.has(h) && Math.random() > 0.3,
      );
    } else {
      (child as any)[key] = Math.random() > 0.5 ? a[key] : b[key];
    }
  }
  return child;
}

function mutate(g: Genome, rate = 0.2): Genome {
  const m = { ...g };
  if (Math.random() < rate) m.triggerBars = pick([1, 2]);
  if (Math.random() < rate)
    m.holdBars = Math.max(60, Math.min(720, m.holdBars + randInt(-60, 60)));
  if (Math.random() < rate)
    m.stopPct = Math.max(0.03, Math.min(0.06, m.stopPct + rand(-0.01, 0.01)));
  if (Math.random() < rate)
    m.tpPct = Math.max(0.04, Math.min(0.1, m.tpPct + rand(-0.01, 0.01)));
  if (Math.random() < rate)
    m.riskFrac = Math.max(0.5, Math.min(1.5, m.riskFrac + rand(-0.1, 0.1)));
  if (Math.random() < rate)
    m.allowedHours = ALL_HOURS.filter(() => Math.random() > 0.2);
  if (Math.random() < rate) m.useAdaptive = !m.useAdaptive;
  if (Math.random() < rate) m.useTimeBoost = !m.useTimeBoost;
  if (Math.random() < rate) m.useChoppy = !m.useChoppy;
  if (Math.random() < rate) m.useVolume = !m.useVolume;
  if (Math.random() < rate) m.useReEntry = !m.useReEntry;
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

describe("V5 Genetic Algorithm", { timeout: 24 * 3600_000 }, () => {
  it("evolves", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `V5_GA START ${new Date().toISOString()}\n`);

    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES)
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    log(`Data: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    function fitness(g: Genome): number {
      const cfg = genomeToConfig(g);
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 6 * BARS_PER_DAY; // 6d step (faster eval, ~336 windows)
      let p = 0,
        w = 0,
        tl = 0;
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        if (r.passed) p++;
        if (r.reason === "total_loss") tl++;
        w++;
      }
      // Fitness: pass-rate, penalize TL > 5%
      const passRate = p / w;
      const tlRate = tl / w;
      return passRate - Math.max(0, tlRate - 0.05) * 2;
    }

    // V5 baseline fitness
    const baselineGenome: Genome = {
      triggerBars: 1,
      holdBars: 240,
      stopPct: 0.05,
      tpPct: 0.07,
      riskFrac: 1.0,
      allowedHours: ALL_HOURS,
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
    };
    const baselineFit = fitness(baselineGenome);
    log(`V5 baseline fitness: ${(baselineFit * 100).toFixed(2)}%\n`);

    const POP_SIZE = 20;
    const GENERATIONS = 8;
    const MUT_RATE = 0.25;
    const ELITE = 2;

    let pop = Array.from({ length: POP_SIZE }, () => randomGenome());
    let scored = pop.map((g) => ({ g, fitness: fitness(g) }));

    for (let gen = 0; gen < GENERATIONS; gen++) {
      scored.sort((a, b) => b.fitness - a.fitness);
      const best = scored[0];
      const avg = scored.reduce((s, x) => s + x.fitness, 0) / scored.length;
      log(
        `Gen ${gen}: best=${(best.fitness * 100).toFixed(2)}% avg=${(avg * 100).toFixed(2)}% baseline=${(baselineFit * 100).toFixed(2)}%`,
      );

      // New generation
      const newPop: Genome[] = [];
      // Elitism
      for (let i = 0; i < ELITE; i++) newPop.push(scored[i].g);
      // Offspring
      while (newPop.length < POP_SIZE) {
        const p1 = tournament(scored);
        const p2 = tournament(scored);
        let child = crossover(p1, p2);
        child = mutate(child, MUT_RATE);
        newPop.push(child);
      }
      pop = newPop;
      scored = pop.map((g) => ({ g, fitness: fitness(g) }));
    }

    scored.sort((a, b) => b.fitness - a.fitness);
    const winner = scored[0];
    log(`\n========== Final Winner ==========`);
    log(
      `Fitness: ${(winner.fitness * 100).toFixed(2)}% (vs baseline ${(baselineFit * 100).toFixed(2)}%)`,
    );
    log(`Genome: ${JSON.stringify(winner.g, null, 2)}`);

    writeFileSync(
      `${LOG_DIR}/V5_GA_WINNER.json`,
      JSON.stringify(
        { genome: winner.g, fitness: winner.fitness, baseline: baselineFit },
        null,
        2,
      ),
    );

    expect(true).toBe(true);
  });
});
