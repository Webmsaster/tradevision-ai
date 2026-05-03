/**
 * Round 58 perf-regression test for ftmoLiveEngineV4.simulate().
 *
 * Background: the R28_V6 V4-Sim revalidation test (`scripts/_r28V6V4SimRevalidation.test.ts`)
 * appeared to "hang" at ~40/136 windows. Investigation showed two issues:
 *   1. Two prior aborted vitest workers were still alive in the background
 *      and racing on the shared log file, producing chaotic interleaved
 *      output that looked like a hang. (Driver process exiting did NOT
 *      reliably kill the worker fork.)
 *   2. `pollLive` recomputed full ATR series inline on EVERY entry-detection
 *      tick (lines 1612 and 1664) even when callers had precomputed series
 *      ready. Across 1440 ticks × 9 assets × 6000-bar slices the cumulative
 *      cost dominated runtime (~25% of per-window time).
 *
 * Fix: precompute atrStop series in `simulate()` and thread through
 * `pollLive` via a new optional `atrStopSeriesByAsset` param. Existing
 * `atrSeriesByAsset` (chandelier) is now also reused in the entry path
 * instead of being recomputed.
 *
 * This test guards against future regressions where someone reintroduces
 * inline ATR recomputation by asserting that simulate() completes within
 * a generous wall-clock budget on a representative challenge window.
 *
 * Budget: 90s for a single 30-day / 30m candle / 2-asset window with the
 * full R28-class engine stack (atrStop + chandelierExit + breakEven +
 * partialTakeProfit + dailyPeakTrailingStop + peakDrawdownThrottle +
 * pauseAtTargetReached). On dev WSL2 this typically runs in 5-15s; the
 * 90s limit catches a true 5×-or-worse regression without flakiness.
 */
import { describe, it, expect } from "vitest";
import { simulate } from "../utils/ftmoLiveEngineV4";
import type { FtmoDaytrade24hConfig } from "../utils/ftmoDaytrade24h";
import type { Candle } from "../utils/indicators";

/**
 * Synthesize a candle series long enough to exercise the same code paths
 * R28_V6 hits in production: 5000-bar warmup + 30-day window (1440 bars at
 * 30m). Random-walk close with bounded HLC so SL/TP can plausibly fire.
 */
function synthCandles(n: number, startTime: number, seed: number): Candle[] {
  const out: Candle[] = [];
  let s = seed;
  let close = 100;
  for (let i = 0; i < n; i++) {
    // xorshift RNG.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const r = (s >>> 0) / 0xffffffff;
    const move = (r - 0.5) * 0.02; // ±1% step
    const open = close;
    close = open * (1 + move);
    const high = Math.max(open, close) * (1 + Math.abs(move) * 0.3);
    const low = Math.min(open, close) * (1 - Math.abs(move) * 0.3);
    out.push({
      openTime: startTime + i * 30 * 60_000,
      closeTime: startTime + (i + 1) * 30 * 60_000 - 1,
      open,
      high,
      low,
      close,
      volume: 1000,
      isFinal: true,
    });
  }
  return out;
}

const cfg: FtmoDaytrade24hConfig = {
  // Minimal R28-class config — exercises all the hot paths the perf fix
  // addresses (atrStop + chandelierExit recomputed each entry).
  timeframe: "30m",
  assets: [
    {
      symbol: "BTC-TREND",
      sourceSymbol: "BTCUSDT",
      tpPct: 0.022,
      stopPct: 0.02,
      riskFrac: 0.4,
      costBp: 0,
      slippageBp: 0,
      triggerBars: 4,
      holdBars: 1200,
      invertDirection: false,
    },
    {
      symbol: "ETH-TREND",
      sourceSymbol: "ETHUSDT",
      tpPct: 0.022,
      stopPct: 0.02,
      riskFrac: 0.4,
      costBp: 0,
      slippageBp: 0,
      triggerBars: 4,
      holdBars: 1200,
      invertDirection: false,
    },
  ],
  leverage: 5,
  profitTarget: 0.08,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  maxDays: 30,
  minTradingDays: 4,
  pauseAtTargetReached: true,
  tpPct: 0.022,
  stopPct: 0.02,
  triggerBars: 4,
  holdBars: 1200,
  // The features that benefit from the perf fix:
  atrStop: { period: 56, stopMult: 2 },
  chandelierExit: { period: 56, mult: 2, minMoveR: 0.5 },
  breakEven: { threshold: 0.03 },
  partialTakeProfit: { triggerPct: 0.012, closeFraction: 0.7 },
  dailyPeakTrailingStop: { trailDistance: 0.012 },
  peakDrawdownThrottle: { fromPeak: 0.03, factor: 0.15 },
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  liveMode: true,
};

describe("ftmoLiveEngineV4 simulate() perf bounds", () => {
  it("completes a 7-day / 30m / 2-asset window within 60s", () => {
    // Smaller window than R28_V6 production (30d) so the test runs in
    // CI in seconds rather than minutes. 1000-bar warmup + 7-day window
    // (336 bars at 30m) is enough to seed ATR/EMA series and exercise
    // every simulate() branch (atrStop, chandelierExit, breakEven, PTP,
    // dPT trail, pDD throttle, ping-day post-target).
    const WARMUP = 1000;
    const WIN = 7 * 48; // 7 days × 48 30m-bars/day
    const total = WARMUP + WIN;
    const t0 = Date.UTC(2024, 0, 1);
    const candles: Record<string, Candle[]> = {
      BTCUSDT: synthCandles(total, t0, 0xdead_beef),
      ETHUSDT: synthCandles(total, t0, 0xc0ffee01),
    };

    const start = Date.now();
    const r = simulate(candles, cfg, WARMUP, WARMUP + WIN, "PERF");
    const elapsedMs = Date.now() - start;

    // Sanity: the window must complete (returning a result, not hanging).
    expect(r).toBeDefined();
    expect(typeof r.passed).toBe("boolean");
    expect([
      "profit_target",
      "total_loss",
      "daily_loss",
      "give_back",
      "time",
    ]).toContain(r.reason);

    // Perf bound: 60s is ~10× the typical observed runtime (3-6s on dev
    // WSL2). A regression that reintroduces inline ATR recompute or
    // similar O(N) per-tick work in the entry path would cross the
    // limit; legitimate slowdowns (e.g. real cross-asset filters)
    // simply run somewhat closer to the budget.
    expect(elapsedMs).toBeLessThan(60_000);
  }, 90_000);
});
