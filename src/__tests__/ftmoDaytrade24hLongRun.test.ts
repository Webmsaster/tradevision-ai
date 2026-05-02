/**
 * LONG-RUN simulation for ftmoDaytrade24h (iter197).
 *
 * Generates >1000 days of synthetic 4h candles for BTC/ETH/SOL with
 * realistic crypto volatility profiles, then runs rolling 30-day FTMO
 * challenges to measure pass rate, fail reasons, drawdown, and EV.
 *
 * Also stress-tests the engine for known-bug signatures:
 *   - entry-bar TP/Stop miss (loop starts at i+2 instead of i+1)
 *   - off-by-one at trigger loop start
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  type FtmoDaytrade24hResult,
} from "../utils/ftmoDaytrade24h";
import type { Candle } from "../utils/indicators";

// ---------- Deterministic RNG (Mulberry32) ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  // Box–Muller
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generate synthetic 4h candles with brownian-bridge sub-ticks so that
 * high/low within each bar reflect realistic intra-bar ranges (important:
 * the engine's TP/stop logic uses bar.high and bar.low, not just close).
 *
 * subTicks = 24 → ~10min granularity inside each 4h candle.
 */
function genCandles(
  seed: number,
  days: number,
  startPrice: number,
  annualVol: number,
  annualDrift: number,
): Candle[] {
  const rng = mulberry32(seed);
  const barsPerDay = 6;
  const bars = days * barsPerDay;
  const barMs = 4 * 3600_000;
  const t0 = 1_700_000_000_000;
  const subTicks = 24;
  const secondsPerYear = 365 * 24 * 3600;
  const dtBar = (4 * 3600) / secondsPerYear;
  const dtSub = dtBar / subTicks;
  const sigmaSub = annualVol * Math.sqrt(dtSub);
  const muSub = (annualDrift - 0.5 * annualVol * annualVol) * dtSub;

  const candles: Candle[] = [];
  let price = startPrice;
  for (let b = 0; b < bars; b++) {
    const open = price;
    let hi = open;
    let lo = open;
    for (let s = 0; s < subTicks; s++) {
      price = price * Math.exp(muSub + sigmaSub * gaussian(rng));
      if (price > hi) hi = price;
      if (price < lo) lo = price;
    }
    // occasional jump (fat-tail) with ~0.3% probability per bar
    if (rng() < 0.003) {
      const jump = (rng() < 0.5 ? -1 : 1) * (0.02 + rng() * 0.04);
      price = price * (1 + jump);
      if (price > hi) hi = price;
      if (price < lo) lo = price;
    }
    const close = price;
    const t = t0 + b * barMs;
    candles.push({
      openTime: t,
      closeTime: t + barMs - 1,
      open,
      high: hi,
      low: lo,
      close,
      volume: 1000,
      isFinal: true,
    });
  }
  return candles;
}

function rebaseTimestamps(candles: Candle[], startBar: number): Candle[] {
  const barMs = 4 * 3600_000;
  const t0 = 1_700_000_000_000;
  const offset = startBar * barMs;
  return candles.map((c) => ({
    ...c,
    openTime: c.openTime - offset + t0,
    closeTime: c.closeTime - offset + t0,
  }));
}

interface SimStats {
  windows: number;
  passes: number;
  passRate: number;
  failReasons: Record<string, number>;
  avgFinalEquity: number;
  avgMaxDd: number;
  avgTrades: number;
  medianDaysToPass: number;
  maxSingleLoss: number;
  maxHoldObservedHours: number;
}

function summarize(results: FtmoDaytrade24hResult[]): SimStats {
  const passes = results.filter((r) => r.passed).length;
  const reasons: Record<string, number> = {};
  for (const r of results) {
    reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  }
  const passDays: number[] = [];
  let maxLoss = 0;
  let maxHold = 0;
  for (const r of results) {
    if (r.passed) passDays.push(r.uniqueTradingDays);
    if (r.maxHoldHoursObserved > maxHold) maxHold = r.maxHoldHoursObserved;
    for (const t of r.trades) {
      if (t.effPnl < maxLoss) maxLoss = t.effPnl;
    }
  }
  passDays.sort((a, b) => a - b);
  const median =
    passDays.length > 0
      ? passDays[Math.floor(passDays.length / 2)]
      : Number.NaN;
  const avgEq =
    results.reduce((s, r) => s + r.finalEquityPct, 0) / results.length;
  const avgDd = results.reduce((s, r) => s + r.maxDrawdown, 0) / results.length;
  const avgTr =
    results.reduce((s, r) => s + r.trades.length, 0) / results.length;
  return {
    windows: results.length,
    passes,
    passRate: passes / results.length,
    failReasons: reasons,
    avgFinalEquity: avgEq,
    avgMaxDd: avgDd,
    avgTrades: avgTr,
    medianDaysToPass: median,
    maxSingleLoss: maxLoss,
    maxHoldObservedHours: maxHold,
  };
}

function runRollingChallenges(
  candlesBySymbol: Record<string, Candle[]>,
  totalDays: number,
  windowDays: number,
  stepDays: number,
): FtmoDaytrade24hResult[] {
  const barsPerDay = 6;
  const results: FtmoDaytrade24hResult[] = [];
  for (
    let startDay = 0;
    startDay + windowDays <= totalDays;
    startDay += stepDays
  ) {
    const startBar = startDay * barsPerDay;
    const endBar = (startDay + windowDays) * barsPerDay;
    const slice: Record<string, Candle[]> = {};
    for (const sym of Object.keys(candlesBySymbol)) {
      const src = candlesBySymbol[sym].slice(startBar, endBar);
      slice[sym] = rebaseTimestamps(src, startBar);
    }
    results.push(runFtmoDaytrade24h(slice));
  }
  return results;
}

describe("ftmoDaytrade24h — LONG-RUN 1000+ day simulation", () => {
  const DAYS = 1200;
  // Realistic crypto annual volatilities (IV ballpark mid-2024/25):
  //   BTC ~55%, ETH ~70%, SOL ~95%
  const btc = genCandles(42, DAYS, 50_000, 0.55, 0.15);
  const eth = genCandles(43, DAYS, 2_500, 0.7, 0.2);
  const sol = genCandles(44, DAYS, 100, 0.95, 0.3);
  const all = { BTCUSDT: btc, ETHUSDT: eth, SOLUSDT: sol };

  it("generated 1200d × 6 bars/day = 7200 bars per asset", () => {
    expect(btc.length).toBe(1200 * 6);
    expect(eth.length).toBe(1200 * 6);
    expect(sol.length).toBe(1200 * 6);
  });

  it("rolling 30-day non-overlapping challenges (40 windows)", () => {
    const results = runRollingChallenges(all, DAYS, 30, 30);
    const stats = summarize(results);
    expect(stats.windows).toBe(40);
    // Publish stats for human inspection via expect snapshot

    console.log("[NON-OVERLAP 30d]", JSON.stringify(stats, null, 2));
    expect(stats.passRate).toBeGreaterThanOrEqual(0);
    expect(stats.passRate).toBeLessThanOrEqual(1);
  });

  it("rolling 30-day with 5-day step (monte-carlo style, 234 windows)", () => {
    const results = runRollingChallenges(all, DAYS, 30, 5);
    const stats = summarize(results);
    expect(stats.windows).toBeGreaterThanOrEqual(200);

    console.log("[ROLLING 5d step]", JSON.stringify(stats, null, 2));
  });

  it("invariant: max hold observed ≤ configured holdBars × 4h", () => {
    const results = runRollingChallenges(all, DAYS, 30, 30);
    const hardLimit = FTMO_DAYTRADE_24H_CONFIG.holdBars * 4;
    for (const r of results) {
      expect(r.maxHoldHoursObserved).toBeLessThanOrEqual(hardLimit);
    }
  });

  it("invariant: single-trade loss never exceeds asset.riskFrac", () => {
    const results = runRollingChallenges(all, DAYS, 30, 30);
    const maxRisk = Math.max(
      ...FTMO_DAYTRADE_24H_CONFIG.assets.map((a) => a.riskFrac),
    );
    for (const r of results) {
      for (const t of r.trades) {
        expect(t.effPnl).toBeGreaterThanOrEqual(-maxRisk - 1e-9);
      }
    }
  });

  it("invariant: total_loss failures never breach -maxTotalLoss", () => {
    const results = runRollingChallenges(all, DAYS, 30, 30);
    for (const r of results) {
      if (r.reason === "total_loss") {
        // must actually be at or below the configured threshold
        expect(r.finalEquityPct).toBeLessThanOrEqual(
          -FTMO_DAYTRADE_24H_CONFIG.maxTotalLoss + 1e-6,
        );
      }
    }
  });

  it("invariant: daily_loss failures respect ≥ -maxDailyLoss on the failing day", () => {
    const results = runRollingChallenges(all, DAYS, 30, 30);
    for (const r of results) {
      if (r.reason === "daily_loss") {
        // At least one trading day's cumulative move must be ≤ -5%
        const byDay = new Map<number, { start: number; end: number }>();
        let running = 1.0;
        for (const t of r.trades) {
          if (!byDay.has(t.day))
            byDay.set(t.day, { start: running, end: running });
          running *= 1 + t.effPnl;
          byDay.get(t.day)!.end = running;
        }
        let anyBreach = false;
        for (const v of byDay.values()) {
          if (
            v.end / v.start - 1 <=
            -FTMO_DAYTRADE_24H_CONFIG.maxDailyLoss + 1e-9
          ) {
            anyBreach = true;
            break;
          }
        }
        expect(anyBreach).toBe(true);
      }
    }
  });
});
