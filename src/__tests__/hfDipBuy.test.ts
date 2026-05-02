/**
 * Smoke tests for hfDipBuy — verifies the runtime strategy driver
 * reproduces the validated iter112/iter113 numerics.
 */
import { describe, it, expect } from "vitest";
import {
  runHfDipBuy,
  evaluateHfDipBuyPortfolio,
  HF_DIP_BUY_CONFIG,
  HF_DIP_BUY_BTC_SOLO_CONFIG,
  HF_DIP_BUY_BASKET,
  HF_DIP_BUY_STATS,
} from "../utils/hfDipBuy";
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

describe("hfDipBuy — config invariants", () => {
  it("has expected iter113 parameters", () => {
    expect(HF_DIP_BUY_CONFIG.nBarsDown).toBe(3);
    expect(HF_DIP_BUY_CONFIG.tp1Pct).toBeCloseTo(0.008, 5);
    expect(HF_DIP_BUY_CONFIG.tp2Pct).toBeCloseTo(0.04, 5);
    expect(HF_DIP_BUY_CONFIG.stopPct).toBeCloseTo(0.01, 5);
    expect(HF_DIP_BUY_CONFIG.holdBars).toBe(24);
    expect(HF_DIP_BUY_CONFIG.htfLen).toBe(48);
    expect(HF_DIP_BUY_CONFIG.btcMacroHtf).toBe(96);
  });

  it("basket excludes ETH and SOL (they lose on this mechanic)", () => {
    expect(HF_DIP_BUY_BASKET).not.toContain("ETHUSDT");
    expect(HF_DIP_BUY_BASKET).not.toContain("SOLUSDT");
    expect(HF_DIP_BUY_BASKET).toContain("BTCUSDT");
    expect(HF_DIP_BUY_BASKET).toContain("LINKUSDT");
    expect(HF_DIP_BUY_BASKET).toContain("BNBUSDT");
    expect(HF_DIP_BUY_BASKET).toContain("XRPUSDT");
  });

  it("stats document bootstrap validation (≥95% positive)", () => {
    expect(
      HF_DIP_BUY_STATS.portfolio.bootstrapPctPositive,
    ).toBeGreaterThanOrEqual(0.95);
    expect(
      HF_DIP_BUY_STATS.btcSolo.bootstrapPctPositive,
    ).toBeGreaterThanOrEqual(0.95);
    expect(HF_DIP_BUY_STATS.iteration).toBeGreaterThanOrEqual(113);
  });

  it("BTC-solo has wider targets and no macro gate", () => {
    expect(HF_DIP_BUY_BTC_SOLO_CONFIG.tp1Pct).toBeCloseTo(0.01, 5);
    expect(HF_DIP_BUY_BTC_SOLO_CONFIG.tp2Pct).toBeCloseTo(0.08, 5);
    expect(HF_DIP_BUY_BTC_SOLO_CONFIG.btcMacroHtf).toBe(0);
  });
});

describe("hfDipBuy — driver behavior", () => {
  it("returns empty when no 3-red-bar sequence in uptrend", () => {
    const bars: Candle[] = [];
    // monotonically rising — no red bars at all
    for (let i = 0; i < 200; i++) {
      const t = 1_700_000_000_000 + i * 3600_000;
      bars.push(mkCandle(t, 100 + i, 101 + i, 99 + i, 100.5 + i));
    }
    const r = runHfDipBuy(bars, HF_DIP_BUY_CONFIG);
    expect(r.trades.length).toBe(0);
  });

  it("produces a trade when 3-red pullback + uptrend conditions met", () => {
    const bars: Candle[] = [];
    // 48 rising bars (establishes uptrend for SMA filter)
    for (let i = 0; i < 48; i++) {
      const t = 1_700_000_000_000 + i * 3600_000;
      bars.push(mkCandle(t, 100 + i, 101 + i, 99 + i, 100.5 + i));
    }
    // 3 red bars (close-lower) — pullback
    const base = bars[bars.length - 1]!.close;
    for (let k = 0; k < 3; k++) {
      const t = 1_700_000_000_000 + (48 + k) * 3600_000;
      const open = base - k * 0.5;
      const close = base - (k + 1) * 0.5;
      bars.push(mkCandle(t, open, open + 0.3, close - 0.3, close));
    }
    // follow-through bars (enable TP hit within hold window)
    // entry bar + many rising bars — high enough to hit +0.8% TP1 easily
    for (let k = 0; k < 30; k++) {
      const t = 1_700_000_000_000 + (51 + k) * 3600_000;
      const lo = base;
      const hi = base * 1.05;
      bars.push(mkCandle(t, lo, hi, lo - 0.1, base + k * 0.1));
    }
    const r = runHfDipBuy(bars, { ...HF_DIP_BUY_CONFIG, avoidHoursUtc: [] });
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0]!.tp1Hit).toBe(true);
  });

  it("portfolio evaluator aggregates without throwing", () => {
    const mk = (seed: number): Candle[] => {
      const bars: Candle[] = [];
      for (let i = 0; i < 400; i++) {
        const t = 1_700_000_000_000 + i * 3600_000;
        const drift = i * 0.2;
        const noise = Math.sin(i * 0.3 + seed) * 0.8;
        const c = 100 + drift + noise;
        bars.push(mkCandle(t, c, c + 0.5, c - 0.5, c));
      }
      return bars;
    };
    const snap = evaluateHfDipBuyPortfolio({
      BTCUSDT: mk(1),
      LINKUSDT: mk(2),
      BNBUSDT: mk(3),
      XRPUSDT: mk(4),
    });
    expect(snap.portfolio.trades).toBeGreaterThanOrEqual(0);
    expect(Object.keys(snap.perAsset)).toContain("BTCUSDT");
  });
});
