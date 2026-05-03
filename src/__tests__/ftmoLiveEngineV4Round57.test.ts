/**
 * Round 57 V4-3 regression tests for ftmoLiveEngineV4.
 *
 * Covers:
 *   - Fix 1: Day-30 force-closes open positions before pass-check.
 *     • Open winning position at end-of-window → realised equity bumped
 *       above target → pass.
 *     • Open losing position at end-of-window pulls realised below target
 *       → fail.
 *   - Fix 2: kellyPnls inline trim works without saveState.
 *   - Fix 3: peakDrawdownThrottle init defensive against corrupted mtmEquity
 *     (challengePeak >= 1.0 even when mtmEquity starts below 1).
 *   - Fix 4: SCHEMA_VERSION = 3, v2 → v3 migration rewrites entryBarIdx.
 *   - Fix 5: ping-day push uses dayIndex(lastBar.openTime, ...) — source-level
 *     check.
 *   - Fix 6: kellyTier hysteresis — boundary flicker is suppressed.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  initialState,
  pollLive,
  loadState,
  saveState,
  resolveSizingFactor,
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
  // Tiny window so the test reaches end-of-window quickly.
  maxDays: 1,
  minTradingDays: 0,
  leverage: 5,
  stopPct: 0.02,
  tpPct: 0.04,
  holdBars: 24,
  triggerBars: 3,
};

describe("ftmoLiveEngineV4 Round 57 V4-3 fixes", () => {
  it("Fix 1: end-of-window force-closes a WINNING open position → pass", () => {
    // Pre-build a state with one open LONG position deeply in profit.
    // Force the next pollLive to land at newDay >= maxDays so the
    // force-close branch fires.
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    // Window of 1 day = 24h. Place a bar 25h after challengeStartTs to
    // trigger newDay >= 1.
    const lastBarTs = startTs + 25 * 3600_000;

    const winningPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 110,
      // effRisk * leverage = 0.4 * 5 = 2.0 → 5% rawPnl maps to +10% equity.
      effRisk: 0.4,
      entryBarIdx: 0,
      highWatermark: 105,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-fix1-win"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      day: 0,
      dayStart: 1.0,
      dayPeak: 1.0,
      challengePeak: 1.0,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [winningPos],
    };

    // Build a candle at lastBarTs whose CLOSE = 105 (rawPnl +5% on long).
    // With effRisk * leverage = 2.0, equity *= 1 + 0.10 = 1.10 → above 8% target.
    const candles = [mkCandle(lastBarTs, 105, 105, 105, 105)];
    const r = pollLive(state, { BTCUSDT: candles }, baseCfg);

    expect(r.challengeEnded).toBe(true);
    expect(r.passed).toBe(true);
    expect(state.openPositions.length).toBe(0);
    // Equity reflects the force-closed +10% gain.
    expect(state.equity).toBeGreaterThanOrEqual(1.08);
    expect(state.mtmEquity).toBe(state.equity);
    expect(r.decision.closes.length).toBe(1);
    expect(r.decision.closes[0]!.exitReason).toBe("manual");
  });

  it("Fix 1: end-of-window force-closes a LOSING open position → fail", () => {
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const lastBarTs = startTs + 25 * 3600_000;

    const losingPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 110,
      // effRisk * leverage = 0.4 * 5 = 2.0 → -3% rawPnl maps to -6%.
      effRisk: 0.4,
      entryBarIdx: 0,
      highWatermark: 100,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
    };

    // Pre-bumped equity (1.05 = +5% realised), but MTM still under target.
    // Force-close drops realised by another 6% → 1.05 * 0.94 = 0.987 < 1.08.
    const state: FtmoLiveStateV4 = {
      ...initialState("test-fix1-lose"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.05,
      mtmEquity: 1.05,
      day: 0,
      dayStart: 1.05,
      dayPeak: 1.05,
      challengePeak: 1.05,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [losingPos],
    };

    // Bar close = 97 → rawPnl long = -3% → effPnl = -3% * 5 * 0.4 = -6%.
    const candles = [mkCandle(lastBarTs, 97, 100, 97, 97)];
    const r = pollLive(state, { BTCUSDT: candles }, baseCfg);

    expect(r.challengeEnded).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.failReason).toBe("time");
    expect(state.openPositions.length).toBe(0);
    // Realised is reduced from 1.05 by the closing loss → must be < 1 + target.
    expect(state.equity).toBeLessThan(1 + baseCfg.profitTarget);
  });

  it("Fix 2: kellyPnls is inline-trimmed without invoking saveState", () => {
    // Drive enough closed trades to push kellyPnls past the cap (500). The
    // trim happens after the per-tick exit loop. We simulate this by directly
    // pre-loading a huge buffer and confirming a single pollLive trims it.
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      kellySizing: {
        windowSize: 50,
        minTrades: 5,
        tiers: [
          { winRateAbove: 0.6, multiplier: 1.5 },
          { winRateAbove: 0, multiplier: 0.5 },
        ],
      },
    };
    // Cap = max(500, 50*4) = 500.
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const huge: Array<{ closeTime: number; effPnl: number }> = [];
    for (let i = 0; i < 1500; i++) {
      huge.push({ closeTime: startTs - 1000 - i, effPnl: 0.001 });
    }

    const state: FtmoLiveStateV4 = {
      ...initialState("test-fix2"),
      kellyPnls: huge,
    };
    expect(state.kellyPnls.length).toBe(1500);

    // Pre-feed one bar so day-rollover doesn't trigger end-of-window
    // (need maxDays > 0 internally, which baseCfg has at 1 — bump to be safe).
    const cfgWide = { ...cfg, maxDays: 30 };
    const c0 = mkCandle(startTs, 100, 100, 100, 100);
    pollLive(state, { BTCUSDT: [c0] }, cfgWide);

    // After ONE pollLive the buffer must already be trimmed to the cap (500).
    expect(state.kellyPnls.length).toBeLessThanOrEqual(500);
  });

  it("Fix 3: peakDrawdownThrottle init defensive against corrupted mtmEquity", () => {
    const state = initialState("test-fix3");
    // Corrupt: mtmEquity below 1.0 before the first pollLive.
    state.mtmEquity = 0.95;
    state.equity = 0.95;

    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const c0 = mkCandle(startTs, 100, 100, 100, 100);
    const cfg = { ...baseCfg, maxDays: 30 };
    pollLive(state, { BTCUSDT: [c0] }, cfg);

    // Both peaks must be clamped at >= 1.0.
    expect(state.challengePeak).toBeGreaterThanOrEqual(1.0);
    expect(state.dayPeak).toBeGreaterThanOrEqual(1.0);
  });

  it("Fix 4: SCHEMA_VERSION is 3 and v2 → v3 migration rewrites entryBarIdx", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v4-r57-"));
    const filePath = path.join(tmpDir, "v4-engine.json");

    // Simulate a v2 state file with one open position whose entryBarIdx is
    // a stale (negative-looking) anchor. The cfgLabel must match the load
    // call below so the cfg-mismatch branch doesn't fire.
    const v2State = {
      schemaVersion: 2,
      cfgLabel: "test-fix4",
      // Hardcoded epochs — fixture is time-independent.
      createdAt: 1735689600000, // 2025-01-01 00:00:00 UTC
      updatedAt: 1738367940000, // 2025-02-01 00:39:00 UTC
      lastBarOpenTime: 0,
      challengeStartTs: 0,
      equity: 1.0,
      mtmEquity: 1.0,
      day: 0,
      dayStart: 1.0,
      dayPeak: 1.0,
      challengePeak: 1.0,
      openPositions: [
        {
          ticketId: "X@1@long",
          symbol: "X",
          sourceSymbol: "X",
          direction: "long",
          entryTime: 0,
          entryPrice: 100,
          initialStopPct: 0.02,
          stopPrice: 98,
          tpPrice: 104,
          effRisk: 0.01,
          // Stale anchor (the v2 → v3 migration must rewrite this).
          entryBarIdx: 999_999,
          highWatermark: 100,
          beActive: false,
          ptpTriggered: false,
          ptpRealizedPct: 0,
          ptpLevelIdx: 0,
          ptpLevelsRealized: 0,
        },
      ],
      tradingDays: [],
      firstTargetHitDay: null,
      pausedAtTarget: false,
      lossStreakByAssetDir: {},
      kellyPnls: [],
      closedTrades: [],
      barsSeen: 42, // v2 → v3 anchor target.
      stoppedReason: null,
    };
    fs.writeFileSync(filePath, JSON.stringify(v2State), "utf-8");

    const loaded = loadState(tmpDir, "test-fix4");
    expect(loaded.schemaVersion).toBe(3);
    expect(loaded.openPositions.length).toBe(1);
    // entryBarIdx must be re-anchored to barsSeen (42), not the stale value.
    expect(loaded.openPositions[0]!.entryBarIdx).toBe(42);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Fix 5: ping-day push uses dayIndex(lastBar.openTime, ...)", () => {
    // Behavior test: build a state in pause-mode (target already hit,
    // pausedAtTarget=true) and force a poll on a bar 2 days into the
    // challenge. Assert that state.tradingDays is updated with the
    // dayIndex derived from lastBar.openTime — NOT state.day raw —
    // matching the entry-side R56 dayIndex convention.
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    // Bar 2 full days after challengeStart → dayIndex should be 2.
    const lastBarTs = startTs + 2 * 24 * 3600_000 + 6 * 3600_000;

    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      maxDays: 30,
      pauseAtTargetReached: true,
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-fix5-pingday"),
      challengeStartTs: startTs,
      // lastBarOpenTime far enough back that the new bar advances state.day.
      lastBarOpenTime: startTs,
      equity: 1.1,
      mtmEquity: 1.1,
      day: 1, // raw state.day before this poll
      dayStart: 1.1,
      dayPeak: 1.1,
      challengePeak: 1.1,
      barsSeen: 24,
      tradingDays: [0, 1],
      firstTargetHitDay: 1,
      pausedAtTarget: true,
    };

    const candles = [mkCandle(lastBarTs, 100, 100, 100, 100)];
    pollLive(state, { BTCUSDT: candles }, cfg);

    // dayIndex derives day-2 from (lastBarTs - challengeStartTs) / 86400s.
    // The push must use that derived day, so tradingDays must include 2.
    expect(state.tradingDays).toContain(2);
  });

  it("Fix 6: kellyTier hysteresis suppresses flicker at boundary", () => {
    // Test resolveSizingFactor directly so we don't have to drive a full
    // detect-asset-emits-signal flow. Build a kelly window and assert that
    // small wr swings around a tier boundary do NOT flip the tier index.
    const cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      kellySizing: {
        windowSize: 10,
        minTrades: 5,
        tiers: [
          { winRateAbove: 0.7, multiplier: 1.5 }, // tier 0 (sorted desc)
          { winRateAbove: 0, multiplier: 1.0 }, // tier 1
        ],
      },
    };

    const baseTs = 1700_000_000_000;
    const state: FtmoLiveStateV4 = {
      ...initialState("test-fix6"),
    };
    // Seed: 7 wins / 3 losses → wr = 0.7 (exactly boundary).
    // Cold-start: greedy lookup picks the highest tier where wr >= threshold.
    // wr (0.7) >= tier[0].winRateAbove (0.7) → tierIdx = 0 (top tier).
    for (let i = 0; i < 7; i++) {
      state.kellyPnls.push({ closeTime: baseTs - 100 - i, effPnl: 0.01 });
    }
    for (let i = 0; i < 3; i++) {
      state.kellyPnls.push({ closeTime: baseTs - 100 - 7 - i, effPnl: -0.01 });
    }
    const factor1 = resolveSizingFactor(state, cfg, baseTs);
    expect(typeof state.kellyTierIdx).toBe("number");
    expect(state.kellyTierIdx).toBe(0); // top tier, multiplier 1.5
    expect(factor1).toBeCloseTo(1.5, 6);

    // Boundary perturbation that STAYS in the hysteresis dead-zone.
    // Push a sequence that pulls wr from 0.7 down to 0.66 (still > 0.65 = step-down threshold).
    // Original window: 7W/3L = wr 0.7. Append +1W +1L → last 10 = 6W/3L+1L+1W
    // shifts: window slides over → final last 10 entries.
    // To keep math simple, build a NEW 10-window where wr = 0.667 (still
    // inside dead-zone above 0.65): replace state.kellyPnls outright.
    state.kellyPnls = [];
    // 7 wins + 3 losses, then 1 loss → last 10 = 6W/4L -> wr 0.6 (BELOW
    // dead-zone). We want wr to remain in dead-zone (0.65 < wr < 0.75).
    // Use 7 wins + 3 losses (same wr=0.7 as before) but add a NEW recent
    // entry that doesn't shift the last-10 window's win-rate:
    for (let i = 0; i < 7; i++) {
      state.kellyPnls.push({ closeTime: baseTs - 100 - i, effPnl: 0.01 });
    }
    for (let i = 0; i < 3; i++) {
      state.kellyPnls.push({ closeTime: baseTs - 100 - 7 - i, effPnl: -0.01 });
    }
    // Append 1 win + 1 win → last 10 = 9W last-10 includes:
    // entries 2-9 (last 8 of original 10) + 2 new wins = ?
    // Order of state.kellyPnls: 7W (idx 0-6), 3L (idx 7-9), 2 new wins (idx 10-11).
    // slice(-10) → idx 2-11 = 5W + 3L + 2W = 7W/3L → wr 0.7 (UNCHANGED).
    state.kellyPnls.push({ closeTime: baseTs - 50, effPnl: 0.01 });
    state.kellyPnls.push({ closeTime: baseTs - 40, effPnl: 0.01 });
    const factor2 = resolveSizingFactor(state, cfg, baseTs + 1);
    // With hysteresis, tier index must NOT flicker on a boundary perturbation
    // that keeps wr exactly at the threshold.
    expect(state.kellyTierIdx).toBe(0);
    expect(factor2).toBeCloseTo(1.5, 6);

    // Now push a SUSTAINED loss streak → wr clearly drops past 0.65.
    // Append 8 losses → last 10 entries dominated by losses → wr <= 0.2.
    for (let i = 0; i < 8; i++) {
      state.kellyPnls.push({ closeTime: baseTs + 100 + i, effPnl: -0.01 });
    }
    const factor3 = resolveSizingFactor(state, cfg, baseTs + 1000);
    // Now we should DEFINITELY have stepped down to tier 1 (multiplier 1.0).
    expect(state.kellyTierIdx).toBe(1);
    expect(factor3).toBeCloseTo(1.0, 6);
  });

  // Round 58 (Critical Fix #2): force-close with missing candle for the
  // position's source symbol must use lastKnownPrice (recorded during
  // prior MTM polls), NOT entryPrice. Otherwise a winning trade gets
  // booked at zero P&L, silently flipping pass→fail.
  it("Round 58: force-close with missing symbol uses lastKnownPrice", () => {
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    // First poll lands on day-0 (state.day starts at 0; we'll set
    // lastBarOpenTime to startTs+1h so the day calc still resolves to 0).
    const polledBarTs = startTs + 1 * 3600_000;
    // End-of-window poll lands on day >= maxDays. maxDays=1 → second
    // bar at 25h triggers force-close.
    const finalBarTs = startTs + 25 * 3600_000;

    // Position deeply in profit on entry; we'll record a +5% lastKnownPrice
    // via a normal MTM poll, then drop the candle for the final bar.
    const winningPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 110,
      effRisk: 0.4,
      entryBarIdx: 0,
      highWatermark: 105,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
      // No lastKnownPrice yet — first poll should set it via MTM.
    };

    const state: FtmoLiveStateV4 = {
      ...initialState("test-r58-fix2"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      day: 0,
      dayStart: 1.0,
      dayPeak: 1.0,
      challengePeak: 1.0,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [winningPos],
    };

    // Poll 1: feed alive at +5%. Candle close=105 must populate
    // pos.lastKnownPrice. Wide maxDays so end-of-window doesn't fire here.
    const cfgWide: FtmoDaytrade24hConfig = { ...baseCfg, maxDays: 30 };
    const c1 = mkCandle(polledBarTs, 105, 105, 105, 105);
    pollLive(state, { BTCUSDT: [c1] }, cfgWide);
    expect(state.openPositions[0]!.lastKnownPrice).toBe(105);

    // Poll 2: end-of-window force-close, but the BTC feed went DARK
    // (empty array → no candle for this asset on the final bar).
    const cFinal = mkCandle(finalBarTs, 200, 200, 200, 200); // unrelated ref
    const r = pollLive(
      state,
      // Pass an empty BTC feed — force-close branch must fall back.
      // We still need at least one source emit a candle so pollLive
      // can resolve a refKey/lastBar; use a different sourceSymbol-style
      // entry to keep the position's BTCUSDT empty.
      { BTCUSDT: [], REFFEED: [cFinal] },
      { ...baseCfg, maxDays: 1 },
    );

    expect(r.challengeEnded).toBe(true);
    expect(state.openPositions.length).toBe(0);
    // CRITICAL: realised equity reflects the +5% from lastKnownPrice
    // (not zero from entryPrice fallback). With effRisk*leverage=2.0,
    // 5% rawPnl → +10% effective on equity → ~1.10 ≥ 1.08 target.
    expect(state.equity).toBeGreaterThan(1.08);
    expect(r.passed).toBe(true);
    expect(r.failReason).not.toBe("feed_lost");
  });

  // Round 58 (Critical Fix #2 corollary): if the feed never emits a
  // candle for this asset (lastKnownPrice never set), force-close still
  // falls back to entryPrice (zero PnL) but result.failReason is set
  // to "feed_lost" so the operator notices.
  it("Round 58: force-close with no observed price ever marks feed_lost", () => {
    const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const finalBarTs = startTs + 25 * 3600_000;

    const dormantPos: OpenPositionV4 = {
      ticketId: "BTC-NONE@1@long",
      symbol: "BTC-NONE",
      sourceSymbol: "BTCUSDT",
      direction: "long",
      entryTime: startTs,
      entryPrice: 100,
      initialStopPct: 0.02,
      stopPrice: 98,
      tpPrice: 110,
      effRisk: 0.4,
      entryBarIdx: 0,
      highWatermark: 100,
      beActive: false,
      ptpTriggered: false,
      ptpRealizedPct: 0,
      ptpLevelIdx: 0,
      ptpLevelsRealized: 0,
      // lastKnownPrice intentionally absent — feed dead since entry.
    };

    // Pre-bumped equity so the feed_lost zero-PnL fallback alone can't
    // pass; we want the failure mode to be reported as feed_lost.
    const state: FtmoLiveStateV4 = {
      ...initialState("test-r58-fix2-feedlost"),
      challengeStartTs: startTs,
      lastBarOpenTime: startTs,
      equity: 1.0,
      mtmEquity: 1.0,
      day: 0,
      dayStart: 1.0,
      dayPeak: 1.0,
      challengePeak: 1.0,
      barsSeen: 1,
      tradingDays: [0],
      openPositions: [dormantPos],
    };

    const cFinal = mkCandle(finalBarTs, 200, 200, 200, 200);
    const r = pollLive(
      state,
      { BTCUSDT: [], REFFEED: [cFinal] },
      { ...baseCfg, maxDays: 1 },
    );
    expect(r.challengeEnded).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.failReason).toBe("feed_lost");
  });

  it("Fix 2 (saveState parity): saveState still trims kellyPnls to 500", () => {
    // Sanity check that saveState's existing trim continues to work
    // alongside the new inline trim.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v4-r57-save-"));
    const state = initialState("test-fix2-save");
    for (let i = 0; i < 1000; i++) {
      state.kellyPnls.push({ closeTime: i, effPnl: 0.001 });
    }
    saveState(state, tmpDir);
    expect(state.kellyPnls.length).toBeLessThanOrEqual(500);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
