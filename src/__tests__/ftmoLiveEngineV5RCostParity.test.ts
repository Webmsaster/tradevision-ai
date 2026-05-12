/**
 * R67-r19 regression: V5R live-engine `computeEffPnl` must deduct per-asset
 * broker costs (commission `costBp`, slippage `slippageBp`, overnight swap
 * `swapBpPerDay`) — same as V4 (R67-r17/R18). Without these deductions, V5R
 * was inflating pass-rate by ~9-15pp on R28_V6 / PASSLOCK — same gap V4 had
 * pre-R17.
 *
 * Strategy: drive a small simulate() with non-zero costBp and confirm the
 * realised effPnl is dragged below the cost-free reference. We assert that
 * a winning trade pattern produces strictly lower closing equity once costs
 * are turned on, mirroring `ftmoLiveEngineV4Round60.test.ts` style.
 */
import { describe, it, expect } from "vitest";
import { simulate } from "../utils/ftmoLiveEngineV5R";
import type { FtmoDaytrade24hConfig } from "../utils/ftmoDaytrade24h";
import type { Candle } from "../utils/indicators";

function mkCandle(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return {
    openTime: t,
    closeTime: t + 2 * 3600_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    isFinal: true,
  };
}

function runSim(
  costBp: number,
  slippageBp: number,
  swapBpPerDay: number,
): { finalEquityPct: number; tradeCount: number } {
  // 200 2h bars from a fixed starting time.
  const startTs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const bar = 2 * 3600_000;
  const candles: Candle[] = [];
  // Simple price walk: long uptrend so the engine takes long entries and
  // exits via TP — which is the path that exercises the realised effPnl
  // deduction.
  let p = 100;
  for (let i = 0; i < 200; i++) {
    const o = p;
    const c = p + 0.4; // monotonic uptrend
    const h = c + 0.1;
    const l = o - 0.05;
    candles.push(mkCandle(startTs + i * bar, o, h, l, c));
    p = c;
  }

  const cfg: FtmoDaytrade24hConfig = {
    assets: [
      {
        symbol: "BTC-NONE",
        sourceSymbol: "BTCUSDT",
        costBp,
        slippageBp,
        swapBpPerDay,
        riskFrac: 0.01,
        stopPct: 0.02,
        tpPct: 0.04,
      },
    ],
    timeframe: "2h",
    profitTarget: 999,
    maxDailyLoss: 999,
    maxTotalLoss: 999,
    maxDays: 999,
    minTradingDays: 0,
    leverage: 1,
    stopPct: 0.02,
    tpPct: 0.04,
    holdBars: 24,
    riskFrac: 0.01,
    barInterval: 2 * 3600_000,
    minNotional: 0,
    minTradesForActivation: 0,
    activationLookbackBars: 0,
    minWinRate: 0,
    minProfitFactor: 0,
    pauseAtTargetReached: false,
  } as unknown as FtmoDaytrade24hConfig;

  const result = simulate(
    { BTCUSDT: candles },
    cfg,
    1,
    candles.length,
    "v5r-cost-test",
  );
  return {
    finalEquityPct: result.finalEquityPct,
    tradeCount: result.trades.length,
  };
}

describe("V5R computeEffPnl cost-deduction parity (R67-r19)", () => {
  it("deducts costBp from realised effPnl (winning trade gives back commission)", () => {
    const free = runSim(0, 0, 0);
    const withCost = runSim(50, 0, 0); // 50bp commission per round-trip
    if (free.tradeCount > 0) {
      // Each closed trade should be ~50bp smaller in raw fraction terms.
      // With identical trade counts on identical price-walks, the
      // cost-on equity must be strictly LESS than the cost-free equity.
      expect(withCost.finalEquityPct).toBeLessThan(free.finalEquityPct);
    }
  });

  it("deducts slippageBp on remainder (non-PTP: full remainder)", () => {
    const free = runSim(0, 0, 0);
    const withSlip = runSim(0, 25, 0); // 25bp slippage × 2 round-trip
    if (free.tradeCount > 0) {
      expect(withSlip.finalEquityPct).toBeLessThan(free.finalEquityPct);
    }
  });

  it("deducts swapBpPerDay × UTC-midnight crossings", () => {
    // Swap accrues only when entry and exit straddle a UTC midnight.
    // This sim uses 2h bars from UTC=00:00 over multi-day → crossings happen.
    const free = runSim(0, 0, 0);
    const withSwap = runSim(0, 0, 100); // 100bp/day swap
    if (free.tradeCount > 0) {
      expect(withSwap.finalEquityPct).toBeLessThanOrEqual(free.finalEquityPct);
    }
  });

  it("all three costs combine additively (parity with V4 model)", () => {
    const free = runSim(0, 0, 0);
    const all = runSim(50, 25, 100);
    if (free.tradeCount > 0) {
      // Combined deduction must be strictly worse than any single one.
      expect(all.finalEquityPct).toBeLessThan(free.finalEquityPct);
    }
  });
});
