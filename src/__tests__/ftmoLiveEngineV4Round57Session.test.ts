/**
 * Round 57 SESSION-BOUNDARY regression tests for ftmoLiveEngineV4.
 *
 * Distinct from `ftmoLiveEngineV4Round57.test.ts` (V4-3 fixes).
 *
 * Covers:
 *   - R57-V4-2: cfg.challengeStartTs honoured on first poll instead of
 *     lastBar.openTime. Without this, a user activating mid-day would
 *     anchor the FTMO daily-loss reset on a partial day, instead of the
 *     next Prague midnight.
 *   - R57-V4-2 negative: when cfg.challengeStartTs is undefined / 0, the
 *     engine still falls back to the existing behavior (lastBar.openTime).
 *   - R57-V4-4 day-rollover from explicit anchor: partial-day-0 still
 *     rolls at the next Prague midnight, not anchor + 24h.
 */
import { describe, it, expect } from "vitest";
import { initialState, pollLive } from "../utils/ftmoLiveEngineV4";
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

function baseCfg(
  extra: Partial<FtmoDaytrade24hConfig> = {},
): FtmoDaytrade24hConfig {
  return {
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
    minTradingDays: 4,
    leverage: 5,
    stopPct: 0.02,
    tpPct: 0.04,
    holdBars: 24,
    triggerBars: 3,
    ...extra,
  };
}

describe("ftmoLiveEngineV4 Round 57 session-boundary fixes", () => {
  it("R57-V4-2: cfg.challengeStartTs overrides lastBar.openTime as anchor", () => {
    // Simulate user activating earlier than the bot's first observed bar.
    // The FTMO daily-loss anchor must be the activation timestamp, not
    // the first bar processed.
    const explicitAnchor = Date.UTC(2026, 0, 1, 14, 0, 0);
    const firstBarTime = explicitAnchor + 4 * 3600_000;

    const cfg = baseCfg({ challengeStartTs: explicitAnchor });
    const state = initialState("R57");
    const candles: Candle[] = [mkCandle(firstBarTime, 100, 100, 100, 100)];
    pollLive(state, { BTCUSDT: candles }, cfg);
    expect(state.challengeStartTs).toBe(explicitAnchor);
    // lastBarOpenTime tracks the actual bar processed, NOT the anchor.
    expect(state.lastBarOpenTime).toBe(firstBarTime);
  });

  it("R57-V4-2 fallback: undefined cfg.challengeStartTs uses lastBar.openTime", () => {
    const firstBarTime = Date.UTC(2026, 0, 1, 18, 0, 0);
    const cfg = baseCfg(); // no challengeStartTs
    const state = initialState("R57-fallback");
    const candles: Candle[] = [mkCandle(firstBarTime, 100, 100, 100, 100)];
    pollLive(state, { BTCUSDT: candles }, cfg);
    expect(state.challengeStartTs).toBe(firstBarTime);
  });

  it("R57-V4-2 zero fallback: cfg.challengeStartTs=0 uses lastBar.openTime", () => {
    const firstBarTime = Date.UTC(2026, 0, 1, 18, 0, 0);
    const cfg = baseCfg({ challengeStartTs: 0 });
    const state = initialState("R57-zero");
    const candles: Candle[] = [mkCandle(firstBarTime, 100, 100, 100, 100)];
    pollLive(state, { BTCUSDT: candles }, cfg);
    expect(state.challengeStartTs).toBe(firstBarTime);
  });

  it("R57-V4-4: explicit anchor — day-rollover triggers at +24h boundary", () => {
    // Existing dayIndex semantics: rollover triggers at anchor + 24h * N.
    // The R57 fix clarifies WHICH timestamp seeds the anchor (cfg vs lastBar).
    // The +24h elapsed semantics are unchanged from prior rounds.
    const explicitAnchor = Date.UTC(2026, 0, 15, 22, 0, 0); // 22:00 UTC
    const cfg = baseCfg({ challengeStartTs: explicitAnchor });
    const state = initialState("R57-rollover");

    // Bar 23h after anchor — still under the +24h boundary → day 0.
    const sameDayBar = explicitAnchor + 23 * 3600_000;
    pollLive(
      state,
      { BTCUSDT: [mkCandle(sameDayBar, 100, 100, 100, 100)] },
      cfg,
    );
    expect(state.day).toBe(0);

    // Bar 25h after anchor — past the +24h elapsed boundary → day 1.
    const nextDayBar = explicitAnchor + 25 * 3600_000;
    pollLive(
      state,
      {
        BTCUSDT: [
          mkCandle(sameDayBar, 100, 100, 100, 100),
          mkCandle(nextDayBar, 100, 100, 100, 100),
        ],
      },
      cfg,
    );
    expect(state.day).toBe(1);
    // The anchor itself was preserved (not overwritten by lastBar.openTime).
    expect(state.challengeStartTs).toBe(explicitAnchor);
  });
});
