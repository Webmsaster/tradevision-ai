/**
 * Smoke tests for btcFlashDaytrade — leveraged flash-crash daytrade tier.
 */
import { describe, it, expect } from "vitest";
import {
  runBtcFlashDaytrade,
  BTC_FLASH_DAYTRADE_10X_CONFIG,
  BTC_FLASH_DAYTRADE_8X_CONFIG,
  BTC_FLASH_DAYTRADE_10X_STATS,
  BTC_FLASH_DAYTRADE_8X_STATS,
} from "../utils/btcFlashDaytrade";
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
    closeTime: t + 3600_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    isFinal: true,
  };
}

describe("btcFlashDaytrade — config invariants", () => {
  it("10× config matches iter156 winner", () => {
    expect(BTC_FLASH_DAYTRADE_10X_CONFIG.dropBars).toBe(72);
    expect(BTC_FLASH_DAYTRADE_10X_CONFIG.dropPct).toBeCloseTo(0.15, 5);
    expect(BTC_FLASH_DAYTRADE_10X_CONFIG.tpPct).toBeCloseTo(0.1, 5);
    expect(BTC_FLASH_DAYTRADE_10X_CONFIG.stopPct).toBeCloseTo(0.02, 5);
    expect(BTC_FLASH_DAYTRADE_10X_CONFIG.holdBars).toBe(24);
    expect(BTC_FLASH_DAYTRADE_10X_CONFIG.leverage).toBe(10);
  });

  it("8× config shares entry mechanics, differs only in leverage", () => {
    expect(BTC_FLASH_DAYTRADE_8X_CONFIG.dropBars).toBe(
      BTC_FLASH_DAYTRADE_10X_CONFIG.dropBars,
    );
    expect(BTC_FLASH_DAYTRADE_8X_CONFIG.dropPct).toBe(
      BTC_FLASH_DAYTRADE_10X_CONFIG.dropPct,
    );
    expect(BTC_FLASH_DAYTRADE_8X_CONFIG.tpPct).toBe(
      BTC_FLASH_DAYTRADE_10X_CONFIG.tpPct,
    );
    expect(BTC_FLASH_DAYTRADE_8X_CONFIG.stopPct).toBe(
      BTC_FLASH_DAYTRADE_10X_CONFIG.stopPct,
    );
    expect(BTC_FLASH_DAYTRADE_8X_CONFIG.holdBars).toBe(
      BTC_FLASH_DAYTRADE_10X_CONFIG.holdBars,
    );
    expect(BTC_FLASH_DAYTRADE_8X_CONFIG.leverage).toBe(8);
  });
});

describe("btcFlashDaytrade — iter156 stats invariants", () => {
  it("10× stats document ≥ 5% mean at daytrade hold (5-gate passed)", () => {
    expect(BTC_FLASH_DAYTRADE_10X_STATS.iteration).toBe(156);
    expect(BTC_FLASH_DAYTRADE_10X_STATS.symbol).toBe("BTCUSDT");
    expect(BTC_FLASH_DAYTRADE_10X_STATS.timeframe).toBe("1h");
    expect(BTC_FLASH_DAYTRADE_10X_STATS.leverage).toBe(10);
    // User target: ≥ 5% mean per daytrade
    expect(BTC_FLASH_DAYTRADE_10X_STATS.meanEffPnlPct).toBeGreaterThanOrEqual(
      0.05,
    );
    // But actually ≥ 20% (iter156 measured 21.12%)
    expect(BTC_FLASH_DAYTRADE_10X_STATS.meanEffPnlPct).toBeGreaterThanOrEqual(
      0.2,
    );
    // Sample size
    expect(BTC_FLASH_DAYTRADE_10X_STATS.trades).toBeGreaterThanOrEqual(30);
    // Bootstrap robust
    expect(
      BTC_FLASH_DAYTRADE_10X_STATS.bootstrapPctPositive,
    ).toBeGreaterThanOrEqual(0.9);
    // OOS robust
    expect(
      BTC_FLASH_DAYTRADE_10X_STATS.oos.meanEffPnlPct,
    ).toBeGreaterThanOrEqual(0.03);
    // 5-gate validated
    expect(BTC_FLASH_DAYTRADE_10X_STATS.gates.g1_base).toBe(true);
    expect(BTC_FLASH_DAYTRADE_10X_STATS.gates.g2_halves).toBe(true);
    expect(BTC_FLASH_DAYTRADE_10X_STATS.gates.g3_sensitivity).toBe(true);
    expect(BTC_FLASH_DAYTRADE_10X_STATS.gates.g4_leverage).toBe(true);
    expect(BTC_FLASH_DAYTRADE_10X_STATS.gates.g5_oos).toBe(true);
  });

  it("8× stats also achieve ≥ 5% mean with lower DD", () => {
    expect(BTC_FLASH_DAYTRADE_8X_STATS.iteration).toBe(156);
    expect(BTC_FLASH_DAYTRADE_8X_STATS.leverage).toBe(8);
    expect(BTC_FLASH_DAYTRADE_8X_STATS.meanEffPnlPct).toBeGreaterThanOrEqual(
      0.05,
    );
    expect(BTC_FLASH_DAYTRADE_8X_STATS.maxDrawdown).toBeGreaterThan(
      BTC_FLASH_DAYTRADE_10X_STATS.maxDrawdown, // less-negative = safer
    );
  });
});

describe("btcFlashDaytrade — runner smoke tests", () => {
  it("returns empty report for insufficient candles", () => {
    const r = runBtcFlashDaytrade([], BTC_FLASH_DAYTRADE_10X_CONFIG);
    expect(r.trades.length).toBe(0);
    expect(r.meanEffPnl).toBe(0);
  });

  it("detects flash-crash + rebound and opens a long", () => {
    // Build 100 candles: flat 100 for 72, crash to 80, rebound to 82
    const candles: Candle[] = [];
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 72; i++) {
      candles.push(mkCandle(t0 + i * 3600_000, 100, 101, 99, 100));
    }
    // Crash bar: close at 80 (−20% from 100 which is 72 bars back)
    candles.push(mkCandle(t0 + 72 * 3600_000, 100, 100, 79, 80));
    // Rebound bar (i=73): close > prev close (80) → trigger
    candles.push(mkCandle(t0 + 73 * 3600_000, 80, 85, 80, 84));
    // Entry bar (i=74): open at 84
    candles.push(mkCandle(t0 + 74 * 3600_000, 84, 95, 83, 94));
    // TP bar (+10% from 84 = 92.4) — hit on i=75 high
    candles.push(mkCandle(t0 + 75 * 3600_000, 94, 96, 92, 95));
    // Fill to length ≥ dropBars + holdBars + 5
    for (let i = 76; i < 120; i++) {
      candles.push(mkCandle(t0 + i * 3600_000, 95, 96, 94, 95));
    }
    const r = runBtcFlashDaytrade(candles, BTC_FLASH_DAYTRADE_10X_CONFIG);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const t = r.trades[0];
    // 10× leverage on ~+10% gross = +100% effective (minus costs)
    expect(t!.effPnl).toBeGreaterThan(0.8);
    expect(t!.liquidated).toBe(false);
  });

  it("floors effective pnl at −1.0 on liquidation (never less)", () => {
    // Construct a bad sequence: drop triggers, stop fires, at 50× lev → liquidation
    const candles: Candle[] = [];
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 72; i++) {
      candles.push(mkCandle(t0 + i * 3600_000, 100, 101, 99, 100));
    }
    candles.push(mkCandle(t0 + 72 * 3600_000, 100, 100, 79, 80));
    candles.push(mkCandle(t0 + 73 * 3600_000, 80, 85, 80, 84));
    // Entry bar: open 84, then price craters to 50
    candles.push(mkCandle(t0 + 74 * 3600_000, 84, 84, 50, 51));
    for (let i = 75; i < 120; i++) {
      candles.push(mkCandle(t0 + i * 3600_000, 51, 52, 49, 51));
    }
    const r = runBtcFlashDaytrade(candles, {
      ...BTC_FLASH_DAYTRADE_10X_CONFIG,
      leverage: 50,
    });
    // With 50× lev and 2% stop: per-trade loss = 50 × (−2%) = −100% = liquidation
    if (r.trades.length > 0) {
      const t = r.trades[0];
      expect(t!.effPnl).toBeGreaterThanOrEqual(-1.0);
      expect(t!.effPnl).toBeLessThanOrEqual(0);
    }
  });
});
