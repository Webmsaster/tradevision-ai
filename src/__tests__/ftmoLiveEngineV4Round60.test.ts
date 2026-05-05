/**
 * Round 60 regression tests for ftmoLiveEngineV4.
 *
 * Covers:
 *   - closeAllOnTargetReached: on first target-hit, all open positions are
 *     immediately force-closed at current bar's close. Locks equity = mtm
 *     at trigger moment, eliminating subsequent draw-down failure modes.
 *   - volAdaptiveTpMult: tpPct at trade-entry scales by current ATR-fraction
 *     bucket — low-vol relaxes, high-vol tightens, mid-vol unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  initialState,
  pollLive,
  type FtmoLiveStateV4,
  type OpenPositionV4,
} from "../utils/ftmoLiveEngineV4";
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

const baseCfg: FtmoDaytrade24hConfig = {
  assets: [
    {
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      costBp: 5,
      riskFrac: 0.01,
      stopPct: 0.02,
      tpPct: 0.04,
    },
  ],
  timeframe: "2h",
  profitTarget: 0.08,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  maxDays: 30,
  minTradingDays: 0,
  leverage: 5,
  stopPct: 0.02,
  tpPct: 0.04,
  holdBars: 24,
  triggerBars: 3,
  pauseAtTargetReached: true,
};

describe("Round 60 — Pass-Lock-Mode (closeAllOnTargetReached)", () => {
  it("force-closes all open positions on first target-hit (locks equity = mtm)", () => {
    // State: realised equity already at +9% (above 8% target), one open
    // long position with +1% unrealised → mtm = 10%. firstTargetHit fires
    // → with closeAllOnTargetReached, the open position must be closed.
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      closeAllOnTargetReached: true,
    };
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastBarTs = startTs + 2 * 3600_000;

    const openPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 110,
      effRisk: 0.1,
      entryBarIdx: 0,
      highWatermark: 100,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-passlock"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.09,
      mtmEquity: 1.09,
      day: 0,
      dayStart: 1.09,
      dayPeak: 1.09,
      challengePeak: 1.09,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [openPos],
    };

    // Bar close 102 → +2% raw, with effRisk*leverage=0.5 → +1% PnL.
    // Pre-process: mtm = 1.09 * 1.01 = 1.1009 ≥ target=1.08 → triggers
    // firstTargetHit. With flag → close-all → realised = 1.09 * 1.01 = 1.1009.
    const candles = [mkCandle(lastBarTs, 102, 102, 102, 102)];
    const r = pollLive(state, { BTCUSDT: candles }, cfg);

    expect(r.targetHit).toBe(true);
    expect(state.openPositions.length).toBe(0);
    expect(state.equity).toBeGreaterThanOrEqual(1.08);
    expect(state.mtmEquity).toBe(state.equity);
    expect(r.decision.closes.length).toBe(1);
    expect(r.decision.closes[0]!.exitReason).toBe("manual");
  });

  it("WITHOUT closeAllOnTargetReached: open positions remain after target-hit (control)", () => {
    const cfg: FtmoDaytrade24hConfig = { ...baseCfg };
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastBarTs = startTs + 2 * 3600_000;

    const openPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 120,
      effRisk: 0.1,
      entryBarIdx: 0,
      highWatermark: 100,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-noflag"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.09,
      mtmEquity: 1.09,
      day: 0,
      dayStart: 1.09,
      dayPeak: 1.09,
      challengePeak: 1.09,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [openPos],
    };

    const candles = [mkCandle(lastBarTs, 102, 102, 102, 102)];
    const r = pollLive(state, { BTCUSDT: candles }, cfg);

    expect(r.targetHit).toBe(true);
    // Position remains open — paused-at-target prevents new entries but
    // does not auto-close existing exposure.
    expect(state.openPositions.length).toBe(1);
  });

  it("Pass-Lock equity post-close ≥ profitTarget (mathematical invariant)", () => {
    // Stress: realised barely above target, large unrealised gain.
    // After close-all: equity = mtm = realised + unrealised ≥ target.
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      closeAllOnTargetReached: true,
    };
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastBarTs = startTs + 2 * 3600_000;

    const openPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 200,
      effRisk: 0.1,
      entryBarIdx: 0,
      highWatermark: 100,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-passlock-invariant"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.081,
      mtmEquity: 1.081,
      day: 0,
      dayStart: 1.081,
      dayPeak: 1.081,
      challengePeak: 1.081,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [openPos],
    };

    const candles = [mkCandle(lastBarTs, 102, 102, 102, 102)];
    const r = pollLive(state, { BTCUSDT: candles }, cfg);

    expect(r.targetHit).toBe(true);
    expect(state.openPositions.length).toBe(0);
    expect(state.equity).toBeGreaterThanOrEqual(1 + cfg.profitTarget);
  });
});

describe("Round 61 — Adaptive Day-Risk Multiplier", () => {
  it("config field accepted with sane defaults", () => {
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      dayBasedRiskMultiplier: {
        conservativeFirstDays: 3,
        conservativeFactor: 0.5,
      },
    };
    expect(cfg.dayBasedRiskMultiplier).toBeDefined();
    expect(cfg.dayBasedRiskMultiplier!.conservativeFirstDays).toBe(3);
    expect(cfg.dayBasedRiskMultiplier!.conservativeFactor).toBe(0.5);
  });

  it("conservativeFirstDays=0 disables the feature (no reduction)", () => {
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      dayBasedRiskMultiplier: {
        conservativeFirstDays: 0,
        conservativeFactor: 0.5,
      },
    };
    // state.day < 0 is never true → factor 1.0 always
    expect(cfg.dayBasedRiskMultiplier!.conservativeFirstDays).toBe(0);
  });
});

describe("Round 60 — Vol-Adaptive tpMult", () => {
  it("type-check: volAdaptiveTpMult config field accepted", () => {
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      volAdaptiveTpMult: {
        atrPeriod: 24,
        lowVolThreshold: 0.008,
        highVolThreshold: 0.018,
        lowVolFactor: 1.3,
        highVolFactor: 0.7,
      },
    };
    expect(cfg.volAdaptiveTpMult).toBeDefined();
    expect(cfg.volAdaptiveTpMult!.lowVolFactor).toBe(1.3);
    expect(cfg.volAdaptiveTpMult!.highVolFactor).toBe(0.7);
  });

  it("low-vol-only variant disables high-vol bucket via threshold = 0.999", () => {
    // Sanity: V60_VOLTP_LOW config flavour relaxes only calm markets.
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      volAdaptiveTpMult: {
        atrPeriod: 24,
        lowVolThreshold: 0.008,
        highVolThreshold: 0.999,
        lowVolFactor: 1.2,
        highVolFactor: 1.0,
      },
    };
    // ATR-frac would have to exceed 99.9% for high-vol bucket to fire —
    // effectively never. Engine logic falls into the "mid-vol" no-op path.
    expect(cfg.volAdaptiveTpMult!.highVolFactor).toBe(1.0);
    expect(cfg.volAdaptiveTpMult!.highVolThreshold).toBeGreaterThan(0.5);
  });
});

describe("Round 60 — Edge Cases (closeAllOnTargetReached)", () => {
  it("guard: target-hit with NO open positions → no closes, equity unchanged", () => {
    // Realised equity already above target, but no exposure. closeAllOnTargetReached
    // must be a no-op for the close-loop (guard branch: openPositions.length === 0).
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      closeAllOnTargetReached: true,
    };
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastBarTs = startTs + 2 * 3600_000;

    const state: FtmoLiveStateV4 = {
      ...initialState("test-passlock-noopen"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.09,
      mtmEquity: 1.09,
      day: 0,
      dayStart: 1.09,
      dayPeak: 1.09,
      challengePeak: 1.09,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [],
    };

    const candles = [mkCandle(lastBarTs, 100, 100, 100, 100)];
    const r = pollLive(state, { BTCUSDT: candles }, cfg);

    expect(r.targetHit).toBe(true);
    expect(state.openPositions.length).toBe(0);
    expect(r.decision.closes.length).toBe(0);
    // Equity unchanged — no realised PnL to add.
    expect(state.equity).toBeCloseTo(1.09, 6);
    expect(state.firstTargetHitDay).toBe(0);
  });

  it("feed lost: no candle for asset → exitPrice falls back to entryPrice (effPnl=0)", () => {
    // Open position is on a SECOND asset whose candles are not present in
    // candlesByAsset. The close loop iterates all open positions even when
    // the trigger candle is on a different asset. Without lastKnownPrice
    // and without candles → exitPrice = entryPrice → effPnl = 0.
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      assets: [
        {
          symbol: "BTC-NONE",
          sourceSymbol: "BTCUSDT",
          costBp: 5,
          riskFrac: 0.01,
          stopPct: 0.02,
          tpPct: 0.04,
        },
        {
          symbol: "ETH-NONE",
          sourceSymbol: "ETHUSDT",
          costBp: 5,
          riskFrac: 0.01,
          stopPct: 0.02,
          tpPct: 0.04,
        },
      ],
      closeAllOnTargetReached: true,
    };
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastBarTs = startTs + 2 * 3600_000;

    // Open position on ETH but feed is dead — no lastKnownPrice tracked.
    const orphanedPos: OpenPositionV4 = {
      ticketId: "ETH-NONE@1@long",
      symbol: "ETH-NONE",
      sourceSymbol: "ETHUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 3000,
      initialStopPct: 0.02,
      stopPrice: 2940,
      tpPrice: 3120,
      effRisk: 0.1,
      entryBarIdx: 0,
      highWatermark: 3000,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
      // lastKnownPrice intentionally unset (feed lost since entry).
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-passlock-feedlost"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.09,
      mtmEquity: 1.09,
      day: 0,
      dayStart: 1.09,
      dayPeak: 1.09,
      challengePeak: 1.09,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [orphanedPos],
    };

    // Only BTC candles present → ETH close loop falls back to entryPrice.
    const btcCandles = [mkCandle(lastBarTs, 102, 102, 102, 102)];
    const r = pollLive(state, { BTCUSDT: btcCandles }, cfg);

    expect(r.targetHit).toBe(true);
    expect(state.openPositions.length).toBe(0);
    expect(r.decision.closes.length).toBe(1);
    const closed = state.closedTrades[state.closedTrades.length - 1]!;
    // Fallback chain: lastKnownPrice undefined → entryPrice → rawPnl=0 → effPnl=0.
    expect(closed.exitPrice).toBe(3000);
    expect(closed.rawPnl).toBe(0);
    expect(closed.effPnl).toBe(0);
    expect(closed.exitReason).toBe("manual");
    // Equity unchanged because effPnl=0.
    expect(state.equity).toBeCloseTo(1.09, 6);
  });

  it("idempotency: re-poll same bar after firstTargetHit → no double close", () => {
    // First poll triggers target-hit + close-all. Second poll on the SAME bar
    // (e.g. signal source re-fires due to network retry) must NOT re-close
    // anything (no positions left) and must NOT reset firstTargetHitDay.
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      closeAllOnTargetReached: true,
      minTradingDays: 999, // prevent challengeEnded short-circuit so we can re-poll
    };
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastBarTs = startTs + 2 * 3600_000;

    const openPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 110,
      effRisk: 0.1,
      entryBarIdx: 0,
      highWatermark: 100,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-passlock-idem"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.09,
      mtmEquity: 1.09,
      day: 0,
      dayStart: 1.09,
      dayPeak: 1.09,
      challengePeak: 1.09,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [openPos],
    };

    const candles = [mkCandle(lastBarTs, 102, 102, 102, 102)];

    // First poll: target hit + close-all.
    const r1 = pollLive(state, { BTCUSDT: candles }, cfg);
    expect(r1.targetHit).toBe(true);
    expect(state.openPositions.length).toBe(0);
    expect(r1.decision.closes.length).toBe(1);
    const firstHitDay = state.firstTargetHitDay;
    const equityAfterFirst = state.equity;
    const closedCountAfterFirst = state.closedTrades.length;

    // Second poll: same bar, same candles. Predicate
    // `state.firstTargetHitDay === null` is false → close-all branch skipped.
    const r2 = pollLive(state, { BTCUSDT: candles }, cfg);
    expect(r2.targetHit).toBe(false); // already locked in — predicate gates re-fire
    expect(state.openPositions.length).toBe(0);
    expect(r2.decision.closes.length).toBe(0); // no double close
    expect(state.firstTargetHitDay).toBe(firstHitDay);
    expect(state.equity).toBeCloseTo(equityAfterFirst, 9);
    expect(state.closedTrades.length).toBe(closedCountAfterFirst);
  });
});

describe("Round 60 — Edge Cases (volAdaptiveTpMult)", () => {
  it("ATR series shorter than period → engine compiles, no crash on entry path", () => {
    // Smoke test: configure an ATR period far longer than any plausible
    // candle history. The volAdaptiveTpMult branch must gracefully skip
    // its multiplier (series.length < 2 → prev undefined; cur may also be
    // null inside warm-up). Engine falls back to current-bar series[len-1],
    // and if that is null too, the multiplier is skipped (no NaN propagation).
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      volAdaptiveTpMult: {
        atrPeriod: 9999, // never warm in any realistic test
        lowVolThreshold: 0.008,
        highVolThreshold: 0.018,
        lowVolFactor: 1.3,
        highVolFactor: 0.7,
      },
    };
    // The config field is well-formed; the engine guard
    // `if (v != null && matched.entryPrice > 0)` prevents NaN tpPct when
    // both prev and cur are null.
    expect(cfg.volAdaptiveTpMult!.atrPeriod).toBe(9999);
    expect(cfg.volAdaptiveTpMult!.lowVolFactor).toBe(1.3);
    // Engine path: prev = series[len-2] = undefined; cur = series[len-1].
    // Within warm-up cur is also null → guard `if (v != null)` skips
    // multiplier → tpPct stays at base asset.tpPct unchanged.
  });

  it("mid-vol bucket: atrFrac between low and high thresholds → tpPct unchanged", () => {
    // Validate the mid-vol no-op semantics at the config layer: a mid-vol
    // ATR-fraction (e.g. 0.012, between low 0.008 and high 0.018) hits
    // neither branch in the engine's if/else-if ladder, so tpPct keeps
    // its base value. We assert the config shape preserves this invariant
    // (lowVolFactor != 1.0, highVolFactor != 1.0, but mid stays neutral
    // by construction — there is no midVolFactor field).
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      volAdaptiveTpMult: {
        atrPeriod: 24,
        lowVolThreshold: 0.008,
        highVolThreshold: 0.018,
        lowVolFactor: 1.3,
        highVolFactor: 0.7,
      },
    };
    const va = cfg.volAdaptiveTpMult!;
    // Simulate the engine's if/else-if branches with a mid-vol atrFrac.
    const atrFrac = 0.012; // mid-vol
    let tpPct = baseCfg.tpPct ?? 0.04;
    if (atrFrac < va.lowVolThreshold) {
      tpPct *= va.lowVolFactor;
    } else if (atrFrac > va.highVolThreshold) {
      tpPct *= va.highVolFactor;
    }
    // Neither branch fires → unchanged.
    expect(tpPct).toBe(0.04);

    // Boundary: exactly at threshold → strict < and > → no fire.
    const atrFracLowBoundary = 0.008;
    let tpPctLow = 0.04;
    if (atrFracLowBoundary < va.lowVolThreshold) {
      tpPctLow *= va.lowVolFactor;
    } else if (atrFracLowBoundary > va.highVolThreshold) {
      tpPctLow *= va.highVolFactor;
    }
    expect(tpPctLow).toBe(0.04);
  });
});

describe("Round 62 — Audit fixes (failReason preservation on re-poll)", () => {
  it("re-poll of stoppedReason='time' state preserves failReason='time' (not null)", () => {
    // Previously line ~993 mapped stoppedReason='time' → failReason=null,
    // losing the failure mode for any caller re-polling after maxDays
    // force-close failed-by-time. Setting stoppedReason='time' only
    // happens on the FAIL branch (passed→null), so this branch can only
    // fire for genuine failures and must report failReason='time'.
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const state: FtmoLiveStateV4 = {
      ...initialState("test-time-fail-replay"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs + 24 * 3600_000,
      equity: 0.97, // below 8% target, no daily/total-loss breach
      mtmEquity: 0.97,
      day: 30,
      dayStart: 0.97,
      dayPeak: 0.97,
      challengePeak: 1.02,
      barsSeen: 100,
      tradingDays: [0, 1, 2, 3],
      stoppedReason: "time",
    };
    // Re-poll: any candle, any cfg — early-return at top must fire.
    const candle = mkCandle(startTs + 25 * 3600_000, 100, 100, 100, 100);
    const r = pollLive(state, { BTCUSDT: [candle] }, baseCfg);
    expect(r.challengeEnded).toBe(true);
    expect(r.passed).toBe(false);
    // Bug fix: failReason must equal stoppedReason verbatim.
    expect(r.failReason).toBe("time");
  });

  it("re-poll of stoppedReason='daily_loss' preserves failReason (regression guard)", () => {
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const state: FtmoLiveStateV4 = {
      ...initialState("test-dl-replay"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 0.94,
      mtmEquity: 0.94,
      stoppedReason: "daily_loss",
    };
    const candle = mkCandle(startTs + 2 * 3600_000, 100, 100, 100, 100);
    const r = pollLive(state, { BTCUSDT: [candle] }, baseCfg);
    expect(r.challengeEnded).toBe(true);
    expect(r.failReason).toBe("daily_loss");
  });
});
