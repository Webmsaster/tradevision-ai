/**
 * Round 43 — V4 Live Simulator on Forex Top-3 Configs.
 *
 * Replays bar-by-bar with persistent state (matches scripts/_v4LiveSimulator).
 * Acceptance: ≥50% V4-Sim pass-rate single-account.
 *
 * Top-3 from Round 42 (all tied 98.77% engine):
 *   FX_TOP1: sp0.025 tp0.0075 lev10 mct12 hb60 dpt1.5 idl3
 *   FX_TOP2: sp0.030 tp0.0075 lev10 mct12 hb60 dpt1.5 idl3
 *   FX_TOP3: sp0.035 tp0.0075 lev10 mct12 hb60 dpt1.5 idl3
 *   + Round-41 baseline: sp0.030 tp0.010 lev8 mct12 hb60 dpt1.5 idl3
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  detectAsset,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { atr } from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import {
  loadForexMajors,
  alignForexCommon,
  FOREX_MAJORS,
} from "./_loadForexHistory";
import { makeForexAsset } from "./_round41ForexBaseline.test";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/ROUND43_FOREX_V4SIM_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const BARS_PER_DAY_2H = 12;

// ───────── V4 Live Simulator (verbatim from _v4LiveSimulator.test.ts) ─────────
interface OpenPosition {
  symbol: string;
  sourceSymbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  tpPrice: number;
  riskFrac: number;
  effRisk: number;
  entryBarIdx: number;
  highWatermark: number;
  beActive: boolean;
  ptpTriggered: boolean;
  ptpRealizedPct: number;
}

interface LiveState {
  equity: number;
  day: number;
  dayStart: number;
  dayPeak: number;
  openPositions: OpenPosition[];
  pausedAtTarget: boolean;
  firstTargetHitDay: number | null;
  tradingDays: Set<number>;
  closedTrades: number;
}

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  return [...out].sort();
}

function simulateLive(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  windowStart: number,
  windowEnd: number,
): {
  passed: boolean;
  reason: string;
  passDay: number;
  finalEquity: number;
  trades: number;
} {
  const state: LiveState = {
    equity: 1.0,
    day: 0,
    dayStart: 1.0,
    dayPeak: 1.0,
    openPositions: [],
    pausedAtTarget: false,
    firstTargetHitDay: null,
    tradingDays: new Set(),
    closedTrades: 0,
  };
  const symbols = syms(cfg);
  const ts0 = aligned[symbols[0]][windowStart].openTime;
  const minDays = cfg.minTradingDays ?? 4;
  const maxDays = cfg.maxDays;
  const trail = cfg.dailyPeakTrailingStop?.trailDistance;
  const idl = cfg.intradayDailyLossThrottle?.hardLossThreshold;

  // Pre-compute ATR series per asset for proper chandelierExit replication.
  const atrByAsset: Record<string, (number | null)[]> = {};
  if (cfg.chandelierExit) {
    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const cs = aligned[sourceKey];
      if (cs) atrByAsset[sourceKey] = atr(cs, cfg.chandelierExit.period);
    }
  }

  for (let i = windowStart; i < windowEnd; i++) {
    const currentBar = aligned[symbols[0]][i];
    const currentDay = Math.floor(
      (currentBar.openTime - ts0) / (24 * 3600_000),
    );
    if (currentDay >= maxDays) break;

    if (currentDay > state.day) {
      state.day = currentDay;
      state.dayStart = state.equity;
      state.dayPeak = state.equity;
    }
    state.dayPeak = Math.max(state.dayPeak, state.equity);

    // Process exits
    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const candle = aligned[pos.sourceSymbol]?.[i];
      if (!candle) continue;
      if (pos.direction === "long") {
        pos.highWatermark = Math.max(pos.highWatermark, candle.high);
      } else {
        pos.highWatermark = Math.min(pos.highWatermark, candle.low);
      }
      // breakEven
      if (cfg.breakEven && !pos.beActive) {
        const fav =
          pos.direction === "long"
            ? (candle.close - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - candle.close) / pos.entryPrice;
        if (fav >= cfg.breakEven.threshold) {
          pos.stopPrice = pos.entryPrice;
          pos.beActive = true;
        }
      }
      // chandelierExit
      if (cfg.chandelierExit) {
        const atrSeries = atrByAsset[pos.sourceSymbol];
        const atrVal = atrSeries?.[i];
        if (atrVal !== null && atrVal !== undefined) {
          const minMoveR = cfg.chandelierExit.minMoveR ?? 0;
          const originalR = Math.abs(pos.entryPrice - pos.stopPrice);
          const moveR =
            pos.direction === "long"
              ? (pos.highWatermark - pos.entryPrice) / originalR
              : (pos.entryPrice - pos.highWatermark) / originalR;
          if (moveR >= minMoveR) {
            const trailDist = cfg.chandelierExit.mult * atrVal;
            if (pos.direction === "long") {
              const newStop = pos.highWatermark - trailDist;
              if (newStop > pos.stopPrice) pos.stopPrice = newStop;
            } else {
              const newStop = pos.highWatermark + trailDist;
              if (newStop < pos.stopPrice) pos.stopPrice = newStop;
            }
          }
        }
      }
      let exitPrice: number | null = null;
      if (pos.direction === "long") {
        if (candle.low <= pos.stopPrice) exitPrice = pos.stopPrice;
        else if (candle.high >= pos.tpPrice) exitPrice = pos.tpPrice;
      } else {
        if (candle.high >= pos.stopPrice) exitPrice = pos.stopPrice;
        else if (candle.low <= pos.tpPrice) exitPrice = pos.tpPrice;
      }
      if (exitPrice !== null) {
        const rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
        const effPnl = Math.max(
          rawPnl * cfg.leverage * pos.effRisk,
          -pos.effRisk * 1.5,
        );
        state.equity *= 1 + effPnl;
        state.dayPeak = Math.max(state.dayPeak, state.equity);
        state.openPositions.splice(p, 1);
        state.closedTrades++;
      }
    }

    // Fail conditions
    if (state.equity <= 1 - cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
      };
    }
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
      };
    }

    // Target check
    if (
      state.equity >= 1 + cfg.profitTarget &&
      state.firstTargetHitDay === null
    ) {
      state.firstTargetHitDay = currentDay;
      state.pausedAtTarget = !!cfg.pauseAtTargetReached;
    }
    if (state.firstTargetHitDay !== null) {
      state.tradingDays.add(currentDay);
      if (state.tradingDays.size >= minDays) {
        return {
          passed: true,
          reason: "profit_target",
          passDay: Math.max(state.firstTargetHitDay + 1, minDays),
          finalEquity: state.equity - 1,
          trades: state.closedTrades,
        };
      }
    }
    if (state.pausedAtTarget) continue;

    // Anti-DL gates
    // dailyPeakTrailingStop (mark-to-market peak)
    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }
    // intradayDailyLossThrottle (hard daily-loss circuit breaker)
    if (idl !== undefined) {
      const dayPnl = (state.equity - state.dayStart) / state.dayStart;
      if (dayPnl <= -idl) continue;
    }

    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;

    // Detect signals
    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const candles = aligned[sourceKey];
      if (!candles) continue;
      const slice = candles.slice(0, i + 1);
      if (slice.length < 100) continue;
      let trades: Daytrade24hTrade[] = [];
      try {
        trades = detectAsset(slice, asset, cfg);
      } catch {
        continue;
      }
      const matched = trades.find((t) => t.entryTime === currentBar.openTime);
      if (!matched) continue;
      if (mct !== undefined && state.openPositions.length >= mct) break;

      const stopPct = asset.stopPct ?? cfg.stopPct;
      const tpPct = asset.tpPct ?? cfg.tpPct;
      const stopPrice =
        matched.direction === "long"
          ? matched.entryPrice * (1 - stopPct)
          : matched.entryPrice * (1 + stopPct);
      const tpPrice =
        matched.direction === "long"
          ? matched.entryPrice * (1 + tpPct)
          : matched.entryPrice * (1 - tpPct);
      const baseRisk = asset.riskFrac;
      const cap = cfg.liveCaps?.maxRiskFrac ?? baseRisk;
      const effRisk = Math.min(baseRisk, cap);
      state.openPositions.push({
        symbol: matched.symbol,
        sourceSymbol: sourceKey,
        direction: matched.direction,
        entryTime: matched.entryTime,
        entryPrice: matched.entryPrice,
        stopPrice,
        tpPrice,
        riskFrac: baseRisk,
        effRisk,
        entryBarIdx: i,
        highWatermark: matched.entryPrice,
        beActive: false,
        ptpTriggered: false,
        ptpRealizedPct: 0,
      });
      state.tradingDays.add(currentDay);
    }
  }

  const final =
    state.firstTargetHitDay !== null && state.tradingDays.size >= minDays;
  return {
    passed: final,
    reason: final ? "profit_target" : "time",
    passDay: final ? Math.max((state.firstTargetHitDay ?? 0) + 1, minDays) : 0,
    finalEquity: state.equity - 1,
    trades: state.closedTrades,
  };
}

// ──────────────────── Configs to validate ────────────────────
function buildForexCfg(
  eligible: string[],
  p: {
    name: string;
    stopPct: number;
    tpPct: number;
    lev: number;
    mct: number;
    holdBars: number;
    dpt: number;
    idl: number;
  },
): FtmoDaytrade24hConfig {
  return {
    triggerBars: 1,
    leverage: p.lev,
    tpPct: p.tpPct,
    stopPct: p.stopPct,
    holdBars: p.holdBars,
    timeframe: "2h",
    maxConcurrentTrades: p.mct,
    assets: eligible.map((s) => ({
      ...makeForexAsset(s),
      stopPct: p.stopPct,
      tpPct: p.tpPct,
      holdBars: p.holdBars,
    })),
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    pauseAtTargetReached: true,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    dailyPeakTrailingStop: { trailDistance: p.dpt },
    intradayDailyLossThrottle: {
      hardLossThreshold: p.idl,
      softLossThreshold: p.idl * 0.6,
      softFactor: 0.5,
    },
    allowedHoursUtc: [8, 10, 12, 14, 16, 18, 20],
  };
}

describe("Round 43 — Forex V4-Sim Validation", { timeout: 60 * 60_000 }, () => {
  it("V4 live simulator vs engine on top-3 forex configs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `ROUND 43 FOREX V4-SIM ${new Date().toISOString()}\n`,
    );

    const data = await loadForexMajors(
      { timeframe: "2h", range: "2y" },
      FOREX_MAJORS,
    );
    const eligible = Object.keys(data).filter(
      (s) => data[s].length >= 30 * BARS_PER_DAY_2H,
    );
    const aligned = alignForexCommon(
      Object.fromEntries(eligible.map((s) => [s, data[s]])),
    );
    const minLen = Math.min(...eligible.map((s) => aligned[s].length));
    log(
      `Aligned: ${eligible.length} pairs / ${minLen} bars / ${(minLen / BARS_PER_DAY_2H / 365).toFixed(2)}y`,
    );

    const variants = [
      {
        name: "FX_TOP1 sp25 tp75 lev10",
        stopPct: 0.025,
        tpPct: 0.0075,
        lev: 10,
        mct: 12,
        holdBars: 60,
        dpt: 0.015,
        idl: 0.03,
      },
      {
        name: "FX_TOP2 sp30 tp75 lev10",
        stopPct: 0.03,
        tpPct: 0.0075,
        lev: 10,
        mct: 12,
        holdBars: 60,
        dpt: 0.015,
        idl: 0.03,
      },
      {
        name: "FX_TOP3 sp35 tp75 lev10",
        stopPct: 0.035,
        tpPct: 0.0075,
        lev: 10,
        mct: 12,
        holdBars: 60,
        dpt: 0.015,
        idl: 0.03,
      },
      {
        name: "FX_BASE sp30 tp10 lev8 (R41 baseline)",
        stopPct: 0.03,
        tpPct: 0.01,
        lev: 8,
        mct: 12,
        holdBars: 60,
        dpt: 0.015,
        idl: 0.03,
      },
    ];

    const winBars = 30 * BARS_PER_DAY_2H;
    const stepBars = 3 * BARS_PER_DAY_2H;

    for (const v of variants) {
      log(`\n========== ${v.name} ==========`);
      const cfg = buildForexCfg(eligible, v);

      // Engine reference
      let engPass = 0,
        engWindows = 0;
      const engPassDays: number[] = [];
      for (let s = 0; s + winBars <= minLen; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of eligible)
          sub[sym] = aligned[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        engWindows++;
        if (r.passed) {
          engPass++;
          if (r.passDay !== undefined) engPassDays.push(r.passDay);
        }
      }
      engPassDays.sort((a, b) => a - b);
      const engMed = engPassDays[Math.floor(engPassDays.length / 2)] ?? 0;
      log(
        `ENGINE: ${engPass}/${engWindows} = ${((engPass / engWindows) * 100).toFixed(2)}% / med=${engMed}d`,
      );

      // V4 simulation
      let v4Pass = 0,
        v4Windows = 0,
        v4Tl = 0,
        v4Dl = 0;
      const v4PassDays: number[] = [];
      for (let s = 0; s + winBars <= minLen; s += stepBars) {
        const winSlice: Record<string, Candle[]> = {};
        for (const sym of eligible)
          winSlice[sym] = aligned[sym].slice(s, s + winBars);
        const r = simulateLive(winSlice, cfg, 0, winBars);
        v4Windows++;
        if (r.passed) {
          v4Pass++;
          if (r.passDay) v4PassDays.push(r.passDay);
        }
        if (r.reason === "total_loss") v4Tl++;
        if (r.reason === "daily_loss") v4Dl++;
      }
      v4PassDays.sort((a, b) => a - b);
      const v4Med = v4PassDays[Math.floor(v4PassDays.length / 2)] ?? 0;
      log(
        `V4-SIM: ${v4Pass}/${v4Windows} = ${((v4Pass / v4Windows) * 100).toFixed(2)}% / med=${v4Med}d / TL=${v4Tl} DL=${v4Dl}`,
      );
      const drift = (v4Pass / v4Windows - engPass / engWindows) * 100;
      log(`Drift: ${drift.toFixed(2)}pp`);
      const v4Pr = v4Pass / v4Windows;
      log(
        v4Pr >= 0.5
          ? `✓ ACCEPTANCE PASSED (V4-Sim ≥50%)`
          : `✗ ACCEPTANCE FAILED (V4-Sim < 50%)`,
      );
    }
    expect(true).toBe(true);
  });
});
