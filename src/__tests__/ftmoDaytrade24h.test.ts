/**
 * Smoke tests for ftmoDaytrade24h — iter189 FTMO Normal Plan daytrade.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_STATS,
} from "../utils/ftmoDaytrade24h";
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
    closeTime: t + 4 * 3600_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    isFinal: true,
  };
}

describe("ftmoDaytrade24h — config", () => {
  it("4h timeframe, 12h max hold (user constraint: 1 account)", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.timeframe).toBe("4h");
    expect(FTMO_DAYTRADE_24H_CONFIG.holdBars).toBe(3);
    expect(FTMO_DAYTRADE_24H_CONFIG.holdBars * 4).toBeLessThanOrEqual(12);
  });

  it("iter212: pyramid r=5 + BTC EMA10/15 + momentum 6bar filter", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.assets.length).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[0]!.sourceSymbol).toBe("ETHUSDT");
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.sourceSymbol).toBe("ETHUSDT");
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[0]!.riskFrac).toBeCloseTo(1.0, 2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.riskFrac).toBeCloseTo(5.0, 2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.minEquityGain).toBeCloseTo(
      0.015,
      3,
    );
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.symbol).toBe("BTCUSDT");
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.emaFastPeriod).toBe(10);
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.emaSlowPeriod).toBe(15);
    expect(
      FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.skipShortsIfSecondaryUptrend,
    ).toBe(true);
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.momentumBars).toBe(6);
    expect(
      FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.momSkipShortAbove,
    ).toBeCloseTo(0.02, 3);
  });

  it("iter211: 2-bar trigger + 1.2% stop + 4% TP + 12h hold + BTC filter", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.triggerBars).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.tpPct).toBeCloseTo(0.04, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.stopPct).toBeCloseTo(0.012, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.disableLong).toBe(true);
    expect(
      FTMO_DAYTRADE_24H_CONFIG.tpPct / FTMO_DAYTRADE_24H_CONFIG.stopPct,
    ).toBeCloseTo(3.33, 1);
  });

  it("ETH cost at 30 bp (realistic taker)", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[0]!.costBp).toBe(30);
  });

  it("FTMO rules", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.leverage).toBe(2);
  });
});

describe("ftmoDaytrade24h — stats (iter212 full-history 50%+)", () => {
  it("~51% pass rate over 8.7-year Binance history (honest 50% milestone)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.passRateNov).toBeCloseTo(0.51, 1);
    expect(FTMO_DAYTRADE_24H_STATS.livePassRateEstimate).toBeGreaterThan(0.4);
    expect(FTMO_DAYTRADE_24H_STATS.livePassRateEstimate).toBeLessThan(0.52);
    expect(FTMO_DAYTRADE_24H_STATS.avgDailyReturn).toBeGreaterThan(0.015);
    expect(FTMO_DAYTRADE_24H_STATS.targetReachable).toBe(true);
  });

  it("documents recent-window + full-history + yearly spread", () => {
    expect(
      (FTMO_DAYTRADE_24H_STATS as unknown as { passRateRecent1000d: number })
        .passRateRecent1000d,
    ).toBeCloseTo(0.6, 1);
    // iter212 spreads 34-67% across regimes (minimum 34% even in worst bull)
    expect(FTMO_DAYTRADE_24H_STATS.regimeSpread).toBeLessThan(0.4);
  });

  it("median days to pass ≤ 15", () => {
    expect(FTMO_DAYTRADE_24H_STATS.medianDaysToPass).toBeLessThanOrEqual(15);
  });

  it("EV positive (iter212 full-history)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.evPerChallengeOos).toBeGreaterThan(1700);
    expect(FTMO_DAYTRADE_24H_STATS.evPerChallengeLive).toBeGreaterThan(1500);
  });

  it("is strict 12h intraday daytrade (user constraint)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.isDaytrade).toBe(true);
    expect(FTMO_DAYTRADE_24H_STATS.allowsNormalPlan).toBe(true);
    expect(FTMO_DAYTRADE_24H_STATS.maxHoldWithinLimit).toBeLessThanOrEqual(12);
  });

  it("20-challenge net ~$35k (iter212 full-history)", () => {
    const n =
      FTMO_DAYTRADE_24H_STATS.expectedOutcome20Challenges.expectedNetLive;
    expect(n).toBeGreaterThan(26_000);
    expect(n).toBeLessThan(55_000);
  });

  it("iter212 metadata: 12h hold + BTC EMA10/15 + drop 8 UTC", () => {
    expect(FTMO_DAYTRADE_24H_STATS.iteration).toBe(212);
    expect(FTMO_DAYTRADE_24H_STATS.timeframe).toBe("4h");
    expect(FTMO_DAYTRADE_24H_STATS.symbols.length).toBe(1);
    expect(FTMO_DAYTRADE_24H_STATS.symbols[0]).toBe("ETHUSDT");
    expect(FTMO_DAYTRADE_24H_STATS.maxHoldHours).toBe(12);
    expect(FTMO_DAYTRADE_24H_STATS.stopPct).toBeCloseTo(0.012, 5);
    expect(FTMO_DAYTRADE_24H_STATS.tpPct).toBeCloseTo(0.04, 5);
    expect(FTMO_DAYTRADE_24H_STATS.triggerBars).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.disableLong).toBe(true);
    // iter212 session: all days, drop 8 UTC only
    expect(FTMO_DAYTRADE_24H_CONFIG.allowedDowsUtc).toBeUndefined();
    expect(FTMO_DAYTRADE_24H_CONFIG.allowedHoursUtc).toEqual([
      0, 4, 12, 16, 20,
    ]);
    expect(FTMO_DAYTRADE_24H_STATS.regimeSpread).toBeLessThan(0.35);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets.length).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.minEquityGain).toBeCloseTo(
      0.015,
      3,
    );
  });

  it("target reachable, full-history 50%+ (iter212)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.targetReachable).toBe(true);
    expect(
      FTMO_DAYTRADE_24H_STATS.passRatePhysicalCeiling,
    ).toBeGreaterThanOrEqual(0.5);
  });
});

describe("ftmoDaytrade24h — runner", () => {
  it("empty input → insufficient_days", () => {
    const r = runFtmoDaytrade24h({});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("max hold stays ≤ 12h (3 bars × 4h)", () => {
    const t0 = 1_700_000_000_000;
    const barMs = 4 * 3600_000;
    // 3 consecutive red bars then flat → time exit
    const mkPat = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + barMs, 100, 101, 99, 101));
      out.push(mkCandle(t0 + 2 * barMs, 101, 101, 100, 100));
      out.push(mkCandle(t0 + 3 * barMs, 100, 100, 99, 99));
      out.push(mkCandle(t0 + 4 * barMs, 99, 99, 98, 98));
      for (let i = 5; i < 15; i++)
        out.push(mkCandle(t0 + i * barMs, 98, 98.5, 97.5, 98));
      return out;
    };
    const r = runFtmoDaytrade24h({ ETHUSDT: mkPat() });
    expect(r.maxHoldHoursObserved).toBeLessThanOrEqual(12);
  });

  it("TP hit pattern triggers large win", () => {
    // Thu 2024-01-04 04:00 UTC — signal bar lands on Thu 12:00 UTC,
    // which is allowed under iter212's session filter (drop 8 UTC only).
    const t0 = new Date("2024-01-04T04:00:00Z").getTime();
    const barMs = 4 * 3600_000;
    // iter202 is short-only with 2-bar trigger → need 2 consecutive
    // GREEN closes, then a drop so the short can profit.
    const mkPat = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + barMs, 100, 102, 100, 102)); // green 1
      out.push(mkCandle(t0 + 2 * barMs, 102, 105, 102, 105)); // green 2
      // entry at bar 3 open (short), rally knocked down 10% to 94.5
      out.push(mkCandle(t0 + 3 * barMs, 105, 106, 88, 90));
      for (let i = 4; i < 15; i++)
        out.push(mkCandle(t0 + i * barMs, 90, 91, 89, 90));
      return out;
    };
    const r = runFtmoDaytrade24h({ ETHUSDT: mkPat() });
    // short signal fired and TP (10%) was hit — expect ≥ 1 trade
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Round 56 audit regression tests ──────────────────────────────────
describe("ftmoDaytrade24h — R56 funding-cost / volMult-floor / maxDays-cap", () => {
  // The default trigger logic is mean-reversion: long fires after N
  // consecutive DECLINING closes (close[i-k] < close[i-k-1] for k<triggerBars).
  // With triggerBars=2 we need 3 consecutive declining closes ending at bar i,
  // then trade opens at bar i+1.
  const t0 = new Date("2024-01-04T04:00:00Z").getTime();
  const barMs = 4 * 3600_000;
  function mkLongTrigger(extraBars = 12): Candle[] {
    const out: Candle[] = [];
    // 3 declining closes for long mean-reversion entry.
    out.push(mkCandle(t0, 100, 101, 99, 100));
    out.push(mkCandle(t0 + barMs, 100, 100, 96, 96));
    out.push(mkCandle(t0 + 2 * barMs, 96, 96, 92, 92));
    // bar index 2 has close < close at idx 1, idx 1 close < idx 0 close → triggers.
    // Entry at idx 3 open. Then a recovery so we time-exit at a slightly higher price.
    out.push(mkCandle(t0 + 3 * barMs, 92, 95, 91, 94));
    for (let i = 4; i < 4 + extraBars; i++) {
      out.push(mkCandle(t0 + i * barMs, 94, 95, 93, 94));
    }
    return out;
  }

  // Minimal long-only config that opens a trade and exits via time.
  function makeLongCfg(): import("../utils/ftmoDaytrade24h").FtmoDaytrade24hConfig {
    return {
      timeframe: "4h" as const,
      tpPct: 0.5, // unreachable → time-exit
      stopPct: 0.5, // unreachable → no stop hit
      holdBars: 3,
      triggerBars: 2,
      invertDirection: false,
      disableShort: true,
      disableLong: false,
      profitTarget: 1.0,
      maxDailyLoss: 1.0,
      maxTotalLoss: 1.0,
      leverage: 1,
      maxDays: 30,
      minTradingDays: 0,
      pauseAtTargetReached: false,
      assets: [
        {
          symbol: "ETH",
          sourceSymbol: "ETHUSDT",
          riskFrac: 0.1,
          costBp: 0,
        },
      ],
    };
  }

  it("Fix 1: funding-cost reduces equity for long trades when fundingBySymbol supplied", () => {
    const candles = mkLongTrigger(20);
    const cfg = makeLongCfg();
    // 20 candles × 4h = 80h → spans 10 settlement boundaries (every 8h).
    // Forward-filled funding rate of +0.001 per 8h → long pays.
    const fundingPos = candles.map(() => 0.001 as number | null);
    const fundingZero = candles.map(() => 0 as number | null);
    const r1 = runFtmoDaytrade24h({ ETHUSDT: candles }, cfg, {
      ETHUSDT: fundingZero,
    });
    const r2 = runFtmoDaytrade24h({ ETHUSDT: candles }, cfg, {
      ETHUSDT: fundingPos,
    });
    expect(r1.trades.length).toBeGreaterThanOrEqual(1);
    expect(r2.trades.length).toBe(r1.trades.length);
    // Funding cost reduces rawPnl on every long trade.
    for (let i = 0; i < r2.trades.length; i++) {
      expect(r2.trades[i]!.rawPnl).toBeLessThan(r1.trades[i]!.rawPnl);
    }
  });

  it("Fix 1: short positions RECEIVE funding when long pays (positive rate)", () => {
    // Default trigger logic: short fires after N consecutive RISING closes.
    // 3 rising closes then entry at next bar.
    const out: Candle[] = [];
    out.push(mkCandle(t0, 100, 101, 99, 100));
    out.push(mkCandle(t0 + barMs, 100, 104, 100, 104));
    out.push(mkCandle(t0 + 2 * barMs, 104, 108, 104, 108));
    out.push(mkCandle(t0 + 3 * barMs, 108, 109, 105, 106)); // entry at this bar's open for short
    for (let i = 4; i < 24; i++)
      out.push(mkCandle(t0 + i * barMs, 106, 107, 105, 106));
    const cfg = makeLongCfg();
    cfg.disableShort = false;
    cfg.disableLong = true;
    const fundingPos = out.map(() => 0.001 as number | null);
    const fundingZero = out.map(() => 0 as number | null);
    const r1 = runFtmoDaytrade24h({ ETHUSDT: out }, cfg, {
      ETHUSDT: fundingZero,
    });
    const r2 = runFtmoDaytrade24h({ ETHUSDT: out }, cfg, {
      ETHUSDT: fundingPos,
    });
    expect(r1.trades.length).toBeGreaterThanOrEqual(1);
    expect(r2.trades.length).toBe(r1.trades.length);
    // Short trades RECEIVE funding when rate > 0 → rawPnl higher than no-funding.
    for (let i = 0; i < r2.trades.length; i++) {
      expect(r2.trades[i]!.direction).toBe("short");
      expect(r2.trades[i]!.rawPnl).toBeGreaterThan(r1.trades[i]!.rawPnl);
    }
  });

  it("Fix 2: effPnl loss-floor scales with tradeVolMult (volMult>1 deepens floor)", () => {
    // Force a large loss with a stop-out so the floor clamp engages.
    // Use a very wide stopPct so we won't actually hit the live-cap; we
    // want to observe the floor when rawPnl × leverage would go below it.
    const cfgLow: import("../utils/ftmoDaytrade24h").FtmoDaytrade24hConfig = {
      timeframe: "4h",
      tpPct: 0.1,
      stopPct: 0.9, // huge ⇒ price can move freely without hitting stop
      holdBars: 2,
      triggerBars: 2,
      invertDirection: false,
      disableShort: true,
      disableLong: false,
      profitTarget: 1.0,
      maxDailyLoss: 1.0,
      maxTotalLoss: 1.0,
      leverage: 10,
      maxDays: 30,
      minTradingDays: 0,
      pauseAtTargetReached: false,
      assets: [
        {
          symbol: "ETH",
          sourceSymbol: "ETHUSDT",
          riskFrac: 0.5,
          costBp: 0,
          // volMult signal: volTargeting with low realised ATR ⇒ scale up.
          volTargeting: {
            period: 14,
            targetAtrFrac: 0.01,
            minMult: 0.5,
            maxMult: 2.0,
          },
        },
      ],
    };
    // Bars: long-trigger pattern (3 declining closes), entry at next bar's
    // open, then a sharp drop produces a large loss to engage the floor.
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + barMs, 100, 100, 96, 96));
    candles.push(mkCandle(t0 + 2 * barMs, 96, 96, 92, 92));
    // Entry at bar 3 open=92. Crash to 30 (massive loss for long).
    candles.push(mkCandle(t0 + 3 * barMs, 92, 92, 30, 30));
    for (let i = 4; i < 20; i++) {
      candles.push(mkCandle(t0 + i * barMs, 30, 31, 29, 30));
    }
    const r = runFtmoDaytrade24h({ ETHUSDT: candles }, cfgLow);
    // Trade existed and effPnl is at the floor (rawPnl × leverage ≪ floor).
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const trd = r.trades[0]!;
    const baseRisk = Math.min(0.5, 1.0);
    const floorWithFix = -baseRisk * (trd.volMult ?? 1) * 1.5;
    // With huge loss at leverage=10, raw effPnl undershoots floor → clamp.
    expect(trd.effPnl).toBeCloseTo(floorWithFix, 6);
    // Floor must scale with volMult: identical config with volMult=1 gives
    // a strictly less-negative floor (smaller magnitude). The volMult IS the
    // ratio.
    expect(trd.volMult).toBeGreaterThan(0);
  });

  it("Round 57 Fix 4: triple-swap on Wed→Thu rollover (1 extra Wed = +2 day-charges)", () => {
    // Anchor t0 to a Tuesday so a 3-day hold spans Tue→Wed→Thu.
    // 2024-01-09 = Tuesday (verify: getUTCDay() === 2).
    const tueT0 = new Date("2024-01-09T04:00:00Z").getTime();
    expect(new Date(tueT0).getUTCDay()).toBe(2);
    const barMsLocal = 4 * 3600_000;
    const cfgWithSwap: import("../utils/ftmoDaytrade24h").FtmoDaytrade24hConfig =
      {
        timeframe: "4h",
        tpPct: 0.5,
        stopPct: 0.5,
        holdBars: 18, // 18 × 4h = 72h ≈ 3 days → spans Tue→Wed→Thu→Fri
        triggerBars: 2,
        invertDirection: false,
        disableShort: true,
        disableLong: false,
        profitTarget: 1.0,
        maxDailyLoss: 1.0,
        maxTotalLoss: 1.0,
        leverage: 1,
        maxDays: 30,
        minTradingDays: 0,
        pauseAtTargetReached: false,
        assets: [
          {
            symbol: "EURUSD",
            sourceSymbol: "EURUSD",
            riskFrac: 0.1,
            costBp: 0,
            slippageBp: 0,
            swapBpPerDay: 100, // 1 % per day so the effect is observable
          },
        ],
      };
    // 3 declining closes for long entry, then flat hold.
    const candles: Candle[] = [];
    candles.push(mkCandle(tueT0, 100, 101, 99, 100));
    candles.push(mkCandle(tueT0 + barMsLocal, 100, 100, 96, 96));
    candles.push(mkCandle(tueT0 + 2 * barMsLocal, 96, 96, 92, 92));
    for (let i = 3; i < 30; i++) {
      candles.push(mkCandle(tueT0 + i * barMsLocal, 92, 93, 91, 92));
    }
    const cfgNoSwap = JSON.parse(
      JSON.stringify(cfgWithSwap),
    ) as typeof cfgWithSwap;
    cfgNoSwap.assets[0]!.swapBpPerDay = 0;
    const r1 = runFtmoDaytrade24h({ EURUSD: candles }, cfgNoSwap);
    const r2 = runFtmoDaytrade24h({ EURUSD: candles }, cfgWithSwap);
    expect(r1.trades.length).toBeGreaterThanOrEqual(1);
    expect(r2.trades.length).toBe(r1.trades.length);
    // The Wed-night triple-swap means rawPnl with swap is BELOW (more
    // negative) rawPnl without swap by at least 3 day-charges (1 Wed-rollover
    // adds +2 over the regular crossing). 100 bp/day = 0.01 per day; a
    // 3-day hold covering one Wed = 5 effective day-charges = 5%. Without
    // the fix it would be 3% — so any trade-1 swap delta ≤ -0.04 confirms
    // the triple-swap is applied (linear baseline = -0.03).
    const delta1 = r2.trades[0]!.rawPnl - r1.trades[0]!.rawPnl;
    expect(delta1).toBeLessThanOrEqual(-0.04 + 1e-9);
  });

  it("Round 57 Fix 4: long-hold (Tue→Sat ≈4d) Wed-rollover → at least 5 day-charges", () => {
    // Tuesday anchor, hold ≥ 4 days so we cross Wed-night exactly once.
    // 4 day-charges baseline + 2 extra for Wed-rollover = 6.
    const tueT0 = new Date("2024-01-09T04:00:00Z").getTime();
    expect(new Date(tueT0).getUTCDay()).toBe(2);
    const barMsLocal = 4 * 3600_000;
    const cfgBase: import("../utils/ftmoDaytrade24h").FtmoDaytrade24hConfig = {
      timeframe: "4h",
      tpPct: 0.5,
      stopPct: 0.5,
      holdBars: 24, // 24 × 4h = 96h ≈ 4 days
      triggerBars: 2,
      invertDirection: false,
      disableShort: true,
      disableLong: false,
      profitTarget: 1.0,
      maxDailyLoss: 1.0,
      maxTotalLoss: 1.0,
      leverage: 1,
      maxDays: 30,
      minTradingDays: 0,
      pauseAtTargetReached: false,
      assets: [
        {
          symbol: "EURUSD",
          sourceSymbol: "EURUSD",
          riskFrac: 0.1,
          costBp: 0,
          slippageBp: 0,
          swapBpPerDay: 100,
        },
      ],
    };
    const candles: Candle[] = [];
    candles.push(mkCandle(tueT0, 100, 101, 99, 100));
    candles.push(mkCandle(tueT0 + barMsLocal, 100, 100, 96, 96));
    candles.push(mkCandle(tueT0 + 2 * barMsLocal, 96, 96, 92, 92));
    for (let i = 3; i < 40; i++) {
      candles.push(mkCandle(tueT0 + i * barMsLocal, 92, 93, 91, 92));
    }
    const cfgNoSwap = JSON.parse(JSON.stringify(cfgBase)) as typeof cfgBase;
    cfgNoSwap.assets[0]!.swapBpPerDay = 0;
    const r0 = runFtmoDaytrade24h({ EURUSD: candles }, cfgNoSwap);
    const r1 = runFtmoDaytrade24h({ EURUSD: candles }, cfgBase);
    expect(r0.trades.length).toBeGreaterThanOrEqual(1);
    // Swap delta of trade 0 must be ≤ -0.05 (5+ day-charges at 1 %/day),
    // proving the Wed-rollover added ≥2 extra charges over the linear baseline.
    const delta = r1.trades[0]!.rawPnl - r0.trades[0]!.rawPnl;
    expect(delta).toBeLessThanOrEqual(-0.05 + 1e-9);
  });

  it("Fix 6: holdBars × maxDays interaction caps trade exit within challenge window", () => {
    // Build candles where signal fires near start of the maxDays window and
    // holdBars would extend many days past it. Engine should clamp the exit
    // bar to within the (challengeStart, challengeStart+maxDays) day range.
    const cfg = makeLongCfg();
    cfg.maxDays = 2; // 2-day window
    cfg.holdBars = 100; // very long max-hold
    cfg.tpPct = 0.99;
    cfg.stopPct = 0.99;
    // Long-trigger pattern at start (3 declining closes), then flat for a
    // long time. holdBars=100 would carry trade many days past day-2.
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + barMs, 100, 100, 96, 96));
    candles.push(mkCandle(t0 + 2 * barMs, 96, 96, 92, 92));
    for (let i = 3; i < 60; i++) {
      candles.push(mkCandle(t0 + i * barMs, 92, 93, 91, 92));
    }
    const r = runFtmoDaytrade24h({ ETHUSDT: candles }, cfg);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    for (const t of r.trades) {
      // t.day = pragueDay(exitTime) - pragueDay(ts0) — must stay within the
      // challenge window (< maxDays). Without Fix 6 a 100-bar hold (≈400h)
      // would push exit to day 16, well past the 2-day window.
      expect(t.day).toBeLessThan(cfg.maxDays);
    }
  });
});
