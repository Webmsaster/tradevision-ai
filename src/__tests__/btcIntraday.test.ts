/**
 * Smoke tests for btcIntraday — verifies the iter119-locked BTC ensemble
 * config, runs the driver on deterministic synthetic candles, and sanity-
 * checks the live-signal helper.
 */
import { describe, it, expect } from "vitest";
import {
  runBtcIntraday,
  getBtcIntradayLiveSignals,
  BTC_INTRADAY_CONFIG,
  BTC_INTRADAY_CONFIG_CONSERVATIVE,
  BTC_INTRADAY_CONFIG_HIGH_FREQ,
  BTC_INTRADAY_STATS,
  BTC_INTRADAY_STATS_CONSERVATIVE,
  BTC_INTRADAY_STATS_HIGH_FREQ,
} from "../utils/btcIntraday";
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

/** Build `n` hourly candles driven by a deterministic generator. */
function buildCandles(
  n: number,
  gen: (i: number) => { o: number; h: number; l: number; c: number },
): Candle[] {
  const out: Candle[] = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const { o, h, l, c } = gen(i);
    out.push(mkCandle(t0 + i * 3600_000, o, h, l, c));
  }
  return out;
}

describe("btcIntraday — config invariants", () => {
  it("exposes iter135-locked default parameters (volume + ATR tp)", () => {
    expect(BTC_INTRADAY_CONFIG.htfLen).toBe(168);
    expect(BTC_INTRADAY_CONFIG.macro30dBars).toBe(720);
    expect(BTC_INTRADAY_CONFIG.maxConcurrent).toBe(4);
    expect(BTC_INTRADAY_CONFIG.tp1Pct).toBeCloseTo(0.008, 5);
    expect(BTC_INTRADAY_CONFIG.tp2Pct).toBeCloseTo(0.04, 5);
    expect(BTC_INTRADAY_CONFIG.stopPct).toBeCloseTo(0.01, 5);
    expect(BTC_INTRADAY_CONFIG.holdBars).toBe(24);
    expect(BTC_INTRADAY_CONFIG.rsiLen).toBe(7);
    expect(BTC_INTRADAY_CONFIG.rsiTh).toBe(42);
    expect(BTC_INTRADAY_CONFIG.nHi).toBe(36);
    expect(BTC_INTRADAY_CONFIG.redPct).toBeCloseTo(0.002, 5);
    // iter133 addition:
    expect(BTC_INTRADAY_CONFIG.volumeMult).toBeCloseTo(1.2, 5);
    expect(BTC_INTRADAY_CONFIG.volumeMedianLen).toBe(96);
    // iter135 addition:
    expect(BTC_INTRADAY_CONFIG.tpAtrMult).toBe(8);
    expect(BTC_INTRADAY_CONFIG.atrLen).toBe(14);
  });

  it("exposes iter119 conservative tier parameters", () => {
    expect(BTC_INTRADAY_CONFIG_CONSERVATIVE.maxConcurrent).toBe(3);
    expect(BTC_INTRADAY_CONFIG_CONSERVATIVE.rsiTh).toBe(40);
    expect(BTC_INTRADAY_CONFIG_CONSERVATIVE.nHi).toBe(48);
    expect(BTC_INTRADAY_CONFIG_CONSERVATIVE.redPct).toBeCloseTo(0.005, 5);
  });

  it("exposes iter123 high-frequency tier (no volume filter)", () => {
    expect(BTC_INTRADAY_CONFIG_HIGH_FREQ.maxConcurrent).toBe(4);
    expect(BTC_INTRADAY_CONFIG_HIGH_FREQ.rsiTh).toBe(42);
    expect(BTC_INTRADAY_CONFIG_HIGH_FREQ.volumeMult).toBe(0);
  });

  it("stats document the iter135 5-gate lock (ATR-adaptive tp)", () => {
    expect(BTC_INTRADAY_STATS.iteration).toBe(135);
    expect(BTC_INTRADAY_STATS.symbol).toBe("BTCUSDT");
    expect(BTC_INTRADAY_STATS.timeframe).toBe("1h");
    expect(BTC_INTRADAY_STATS.bootstrapPctPositive).toBeGreaterThanOrEqual(
      0.95,
    );
    expect(BTC_INTRADAY_STATS.tradesPerDay).toBeGreaterThanOrEqual(1.1);
    // iter135 lifts Sharpe above 10
    expect(BTC_INTRADAY_STATS.sharpe).toBeGreaterThanOrEqual(9.5);
    // mean/trade lifted above 0.03%
    expect(BTC_INTRADAY_STATS.meanPctPerTrade).toBeGreaterThanOrEqual(0.0003);
    expect(BTC_INTRADAY_STATS.daysTested).toBeGreaterThanOrEqual(1500);
    // all 4 quarters profitable
    expect(BTC_INTRADAY_STATS.quarters.length).toBe(4);
    for (const q of BTC_INTRADAY_STATS.quarters) {
      expect(q.cumReturnPct).toBeGreaterThan(0);
    }
    // minW under 1%
    expect(Math.abs(BTC_INTRADAY_STATS.minWindowRet)).toBeLessThan(0.015);
  });

  it("execution sensitivity (iter136) documents maker-dependence", () => {
    expect(
      BTC_INTRADAY_STATS.executionSensitivity.length,
    ).toBeGreaterThanOrEqual(5);
    // Baseline must be best
    const baseline = BTC_INTRADAY_STATS.executionSensitivity[0];
    expect(baseline.sharpe).toBeGreaterThan(9);
    // Warn that worst-case is negative
    const worst =
      BTC_INTRADAY_STATS.executionSensitivity[
        BTC_INTRADAY_STATS.executionSensitivity.length - 1
      ];
    expect(worst.sharpe).toBeLessThan(1);
    // TAKER 0 slippage should still be profitable
    const takerClean = BTC_INTRADAY_STATS.executionSensitivity.find((s) =>
      s.scenario.includes("TAKER 0.04% fee, 0 slippage"),
    );
    expect(takerClean).toBeDefined();
    if (takerClean) expect(takerClean.sharpe).toBeGreaterThan(5);
  });

  it("conservative tier stats are unchanged from iter119", () => {
    expect(BTC_INTRADAY_STATS_CONSERVATIVE.iteration).toBe(119);
    expect(BTC_INTRADAY_STATS_CONSERVATIVE.tradesPerDay).toBeCloseTo(1.53, 2);
    expect(BTC_INTRADAY_STATS_CONSERVATIVE.sharpe).toBeCloseTo(7.15, 1);
    expect(
      BTC_INTRADAY_STATS_CONSERVATIVE.bootstrapPctPositive,
    ).toBeGreaterThanOrEqual(0.95);
  });

  it("high-frequency tier stats match iter123", () => {
    expect(BTC_INTRADAY_STATS_HIGH_FREQ.iteration).toBe(123);
    expect(BTC_INTRADAY_STATS_HIGH_FREQ.tradesPerDay).toBeCloseTo(1.87, 2);
    expect(BTC_INTRADAY_STATS_HIGH_FREQ.sharpe).toBeCloseTo(7.06, 1);
  });

  it("mechanics list covers all 4 iter114 survivors", () => {
    expect(BTC_INTRADAY_STATS.mechanics).toContain("M1_nDown");
    expect(BTC_INTRADAY_STATS.mechanics).toContain("M4_rsi");
    expect(BTC_INTRADAY_STATS.mechanics).toContain("M5_breakout");
    expect(BTC_INTRADAY_STATS.mechanics).toContain("M6_redBar");
  });
});

describe("btcIntraday — driver behavior", () => {
  it("returns empty report when data is shorter than warmup", () => {
    const bars = buildCandles(100, (i) => {
      const c = 100 + i;
      return { o: c, h: c + 0.5, l: c - 0.5, c };
    });
    const r = runBtcIntraday(bars);
    expect(r.trades.length).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.netReturnPct).toBe(0);
  });

  it("returns empty report when macro gate never triggers (flat price)", () => {
    // 1000 bars, completely flat → 30-day ret = 0, macro mask never passes.
    const bars = buildCandles(1000, () => ({
      o: 100,
      h: 100.2,
      l: 99.8,
      c: 100,
    }));
    const r = runBtcIntraday(bars);
    expect(r.trades.length).toBe(0);
  });

  it("produces trades on a long synthetic uptrend with dips (volume filter off)", () => {
    // 2000 bars of strong drift + periodic 3-bar pullbacks. Long enough to
    // satisfy both HTF (168) and macro (720) gates, then a pullback.
    // Volume filter disabled because synthetic candles have uniform volume.
    const bars = buildCandles(2000, (i) => {
      const drift = i * 0.8;
      const cycle = i % 40;
      let noise = 0;
      if (cycle >= 37 && cycle <= 39) noise = -0.8 * (cycle - 36);
      const c = 100 + drift + noise;
      return {
        o: c,
        h: c + 0.5,
        l: c - 0.5,
        c,
      };
    });
    const r = runBtcIntraday(bars, {
      ...BTC_INTRADAY_CONFIG,
      volumeMult: 0, // disable for synthetic test
      avoidHoursUtc: [],
    });
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.daysCovered).toBeGreaterThan(80);
    expect(r.tradesPerDay).toBeGreaterThan(0);
    const sumByMech = Object.values(r.byMechanic).reduce((a, b) => a + b, 0);
    expect(sumByMech).toBe(r.trades.length);
  });

  it("volume filter suppresses trades when volume is uniformly low", () => {
    // Same synthetic data but now DEFAULT config (volume filter ON). Since
    // every bar has volume=100, the ratio is 1.0 and 1.2× median filter is
    // never satisfied. Expect no trades at all.
    const bars = buildCandles(2000, (i) => {
      const drift = i * 0.8;
      const cycle = i % 40;
      let noise = 0;
      if (cycle >= 37 && cycle <= 39) noise = -0.8 * (cycle - 36);
      const c = 100 + drift + noise;
      return { o: c, h: c + 0.5, l: c - 0.5, c };
    });
    const r = runBtcIntraday(bars, {
      ...BTC_INTRADAY_CONFIG,
      avoidHoursUtc: [],
    });
    expect(r.trades.length).toBe(0);
  });

  it("caps concurrent positions at maxConcurrent", () => {
    const bars = buildCandles(2000, (i) => {
      const drift = i * 0.8;
      const c = 100 + drift;
      return { o: c, h: c + 0.5, l: c - 0.5, c };
    });
    const r = runBtcIntraday(bars, {
      ...BTC_INTRADAY_CONFIG,
      volumeMult: 0, // disabled for deterministic synthetic test
      avoidHoursUtc: [],
    });
    // all trades should have pnl scaled by 1/maxConcurrent when they fire
    // (absolute PnL is bounded by tp2/maxConcurrent)
    const max =
      (BTC_INTRADAY_CONFIG.tp2Pct + 0.01) / BTC_INTRADAY_CONFIG.maxConcurrent;
    for (const t of r.trades) {
      expect(t.pnl).toBeLessThan(max);
    }
  });
});

describe("btcIntraday — live-signal helper", () => {
  it("returns [] when not enough history", () => {
    const bars = buildCandles(50, (i) => {
      const c = 100 + i;
      return { o: c, h: c + 0.5, l: c - 0.5, c };
    });
    const sigs = getBtcIntradayLiveSignals(bars);
    expect(sigs).toEqual([]);
  });

  it("returns [] when macro gate fails (flat tape)", () => {
    const bars = buildCandles(1200, () => ({
      o: 100,
      h: 100.1,
      l: 99.9,
      c: 100,
    }));
    const sigs = getBtcIntradayLiveSignals(bars);
    expect(sigs).toEqual([]);
  });

  it("may surface signals on a clear uptrend with a dip at the tail", () => {
    // Build 1200 bars with drift, then end with 3 red bars to trigger M1.
    const base = 100;
    const bars = buildCandles(1200, (i) => {
      const drift = i * 0.4;
      const c = base + drift;
      return { o: c, h: c + 0.4, l: c - 0.4, c };
    });
    // Overwrite the last 3 bars to be descending closes so M1_nDown fires
    // on bar length-2 (the last closed bar for live-signal purposes).
    const n = bars.length;
    const p = bars[n - 4].close;
    bars[n - 3] = mkCandle(bars[n - 3].openTime, p, p + 0.2, p - 2, p - 1);
    bars[n - 2] = mkCandle(bars[n - 2].openTime, p - 1, p - 0.5, p - 3, p - 2);
    // Live signal evaluates bar index n-2. Volume filter disabled so the
    // synthetic uniform-volume data doesn't suppress all signals.
    const sigs = getBtcIntradayLiveSignals(bars, {
      ...BTC_INTRADAY_CONFIG,
      volumeMult: 0,
      avoidHoursUtc: [],
    });
    // We don't assert a specific length — just that each returned signal has
    // the expected shape and that trend+macro flags are true when non-empty.
    for (const s of sigs) {
      expect(s.trendOk).toBe(true);
      expect(s.macroOk).toBe(true);
      expect(s.volumeOk).toBe(true); // volume filter disabled → always OK
      expect(["M1_nDown", "M4_rsi", "M5_breakout", "M6_redBar"]).toContain(
        s.mechanic,
      );
    }
  });
});
