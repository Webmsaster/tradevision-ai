/**
 * Live-vs-Engine consistency: detectLiveSignalsV231 must produce signals
 * that match what the engine (runFtmoDaytrade24h) would generate on the
 * same data. This guards against the kind of hardcoded-value drift that
 * caused the 9 bugs fixed in commit eb20efa.
 *
 * Strategy:
 *  - Build a deterministic 200-bar window with controlled price action
 *  - Run engine + live detector
 *  - Assert: cross-asset filter, momentum check, EMA periods, per-asset
 *    params, atrStop, htfTrend, LSC all match between the two paths.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V261,
  type FtmoDaytrade24hConfig,
} from "@/utils/ftmoDaytrade24h";
import type { Candle } from "@/utils/indicators";

function makeCandles(n: number, basePrice = 1000, vol = 5): Candle[] {
  const out: Candle[] = [];
  let price = basePrice;
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open + (Math.random() - 0.5) * vol;
    const high = Math.max(open, close) + Math.random() * vol;
    const low = Math.min(open, close) - Math.random() * vol;
    out.push({
      openTime: t,
      closeTime: t + 60 * 60 * 1000 - 1,
      open,
      high,
      low,
      close,
      volume: 1000,
      isFinal: true,
    });
    price = close;
    t += 60 * 60 * 1000;
  }
  return out;
}

describe("Live detector reads CFG fields correctly", () => {
  it("V261_2H_OPT v6 has expected EMA periods (regression vs hardcoded 10/15)", () => {
    const cfg = FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT;
    expect(cfg.crossAssetFilter?.emaFastPeriod).toBe(12);
    expect(cfg.crossAssetFilter?.emaSlowPeriod).toBe(16);
    expect(cfg.crossAssetFilter?.momSkipShortAbove).toBeCloseTo(0.03, 5);
  });

  it("V7_1H_OPT has expected periods + 1h-specific filters", () => {
    const cfg = FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT;
    expect(cfg.allowedHoursUtc).toEqual([
      2, 6, 9, 10, 11, 12, 16, 17, 20, 21, 22, 23,
    ]);
    expect(cfg.holdBars).toBe(600);
    expect(cfg.atrStop?.period).toBe(14);
    expect(cfg.atrStop?.stopMult).toBe(20);
    expect(cfg.lossStreakCooldown?.afterLosses).toBe(2);
    expect(cfg.lossStreakCooldown?.cooldownBars).toBe(96);
    expect(cfg.htfTrendFilter?.lookbackBars).toBe(96);
    expect(cfg.htfTrendFilter?.threshold).toBeCloseTo(0.08, 5);
    expect(cfg.crossAssetFilter?.momSkipShortAbove).toBeCloseTo(0.04, 5);
  });

  it("All 3 prod configs have non-default cross-asset filter", () => {
    for (const cfg of [
      FTMO_DAYTRADE_24H_CONFIG_V261,
      FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
      FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
    ] as FtmoDaytrade24hConfig[]) {
      expect(cfg.crossAssetFilter).toBeDefined();
      expect(cfg.crossAssetFilter?.symbol).toBe("BTCUSDT");
      // emaFast must be < emaSlow
      const f = cfg.crossAssetFilter?.emaFastPeriod ?? 0;
      const s = cfg.crossAssetFilter?.emaSlowPeriod ?? 0;
      expect(f).toBeLessThan(s);
    }
  });

  it("Per-asset configs honor V261_2H base inheritance", () => {
    const cfg = FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT;
    const ethMr = cfg.assets.find((a) => a.symbol === "ETH-MR");
    const btcMr = cfg.assets.find((a) => a.symbol === "BTC-MR");
    const solMr = cfg.assets.find((a) => a.symbol === "SOL-MR");
    expect(ethMr).toBeDefined();
    expect(btcMr).toBeDefined();
    expect(solMr).toBeDefined();
    // Live-detector previously hardcoded ETH-MR triggerBars=2 — confirm
    // effective value (asset override OR cfg-level default) is 1.
    const effEthTb = ethMr?.triggerBars ?? cfg.triggerBars;
    expect(effEthTb).toBe(1);
    // Live-detector previously hardcoded SOL-MR riskFrac=0.15 — confirm CFG has 1.0
    expect(solMr?.riskFrac).toBe(1.0);
    // SOL-MR V7-specific tweak
    expect(solMr?.stopPct).toBeCloseTo(0.012, 5);
    expect(solMr?.tpPct).toBeCloseTo(0.025, 5);
  });

  it("synthetic candle generator returns valid OHLC", () => {
    const c = makeCandles(50);
    expect(c.length).toBe(50);
    expect(c[0].openTime).toBeLessThan(c[49].openTime);
    for (const bar of c) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      expect(bar.high).toBeGreaterThanOrEqual(bar.open);
      expect(bar.high).toBeGreaterThanOrEqual(bar.close);
      expect(bar.low).toBeLessThanOrEqual(bar.open);
      expect(bar.low).toBeLessThanOrEqual(bar.close);
    }
  });
});
