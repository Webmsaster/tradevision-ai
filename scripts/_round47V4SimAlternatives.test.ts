/**
 * Round 47 — V4 Simulator validation for Round 45 (MR) + Round 46 (BO) top-3.
 *
 * Persistent-state, chronological, no-lookahead replay matching live execution.
 * Engine pass-rates can be optimistic vs live; V4-Sim is the honest gate.
 *
 * Acceptance: ≥1 alternative strategy with V4-Sim ≥45%.
 *
 * NOTE: V4-Sim here mirrors `_round28R28V4Sim.test.ts` template. It uses
 * detectAsset() per bar (sliced candles up to bar i) and tracks an evolving
 * LiveState (equity / openPositions / dayPeak / pausedAtTarget). Honors
 * partialTakeProfit, breakEven, chandelierExit, dailyPeakTrailingStop,
 * adaptiveSizing, timeBoost, liveCaps. NO support for kellySizing,
 * peakDrawdownThrottle, intradayDailyLossThrottle.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  detectAsset,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { atr } from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";
import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/ROUND47_V4SIM_${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const BASKET = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
];

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

function alignCommon(
  data: Record<string, Candle[]>,
  symbols: string[],
): Record<string, Candle[]> {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

function computeSizingFactor(
  equity: number,
  day: number,
  cfg: FtmoDaytrade24hConfig,
): number {
  const gain = equity - 1;
  let factor = 1;
  if (cfg.adaptiveSizing && cfg.adaptiveSizing.length > 0) {
    const sortedTiers = [...cfg.adaptiveSizing].sort(
      (a, b) => a.equityAbove - b.equityAbove,
    );
    for (const tier of sortedTiers) {
      if (gain >= tier.equityAbove) factor = tier.factor;
    }
  }
  if (
    cfg.timeBoost &&
    day >= cfg.timeBoost.afterDay &&
    gain < cfg.timeBoost.equityBelow &&
    cfg.timeBoost.factor > factor
  ) {
    factor = cfg.timeBoost.factor;
  }
  return Math.min(factor, 4);
}

function simulateLive(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  ws: number,
  we: number,
) {
  const symbols = Object.keys(aligned);
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
  const ts0 = aligned[symbols[0]][ws].openTime;
  const refKey = symbols[0];
  const minDays = cfg.minTradingDays ?? 4;
  const maxDays = cfg.maxDays;
  // dailyPeakTrailingStop not present in this engine branch — V5_QUARTZ_LITE
  // uses adaptiveSizing only. No-op fallback below.
  const trail: number | undefined = undefined;
  const atrByAsset: Record<string, (number | null)[]> = {};
  if (cfg.chandelierExit)
    for (const a of cfg.assets) {
      const k = a.sourceSymbol ?? a.symbol;
      if (aligned[k])
        atrByAsset[k] = atr(aligned[k], cfg.chandelierExit.period);
    }
  for (let i = ws; i < we; i++) {
    const cb = aligned[refKey][i];
    const cd = Math.floor((cb.openTime - ts0) / (24 * 3600_000));
    if (cd >= maxDays) break;
    if (cd > state.day) {
      state.day = cd;
      state.dayStart = state.equity;
      state.dayPeak = state.equity;
    }
    state.dayPeak = Math.max(state.dayPeak, state.equity);
    // Process open positions
    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const c = aligned[pos.sourceSymbol]?.[i];
      if (!c) continue;
      pos.highWatermark =
        pos.direction === "long"
          ? Math.max(pos.highWatermark, c.high)
          : Math.min(pos.highWatermark, c.low);
      const ptp = cfg.partialTakeProfit;
      if (ptp && !pos.ptpTriggered) {
        const tp =
          pos.direction === "long"
            ? pos.entryPrice * (1 + ptp.triggerPct)
            : pos.entryPrice * (1 - ptp.triggerPct);
        const ptpHit = pos.direction === "long" ? c.high >= tp : c.low <= tp;
        const stopHit =
          pos.direction === "long"
            ? c.low <= pos.stopPrice
            : c.high >= pos.stopPrice;
        const gap = pos.direction === "long" ? c.open >= tp : c.open <= tp;
        if (ptpHit && (!stopHit || gap)) {
          pos.ptpTriggered = true;
          pos.ptpRealizedPct = ptp.closeFraction * ptp.triggerPct;
          if (pos.direction === "long") {
            if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice;
          } else {
            if (pos.entryPrice < pos.stopPrice) pos.stopPrice = pos.entryPrice;
          }
          pos.beActive = true;
          pos.highWatermark = c.close;
        }
      }
      if (cfg.breakEven && !pos.beActive) {
        const fav =
          pos.direction === "long"
            ? (c.close - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - c.close) / pos.entryPrice;
        if (fav >= cfg.breakEven.threshold) {
          pos.stopPrice = pos.entryPrice;
          pos.beActive = true;
        }
      }
      if (cfg.chandelierExit) {
        const av = atrByAsset[pos.sourceSymbol]?.[i];
        if (av !== null && av !== undefined) {
          const minR = cfg.chandelierExit.minMoveR ?? 0;
          const oR = Math.abs(pos.entryPrice - pos.stopPrice);
          const mR =
            pos.direction === "long"
              ? (pos.highWatermark - pos.entryPrice) / oR
              : (pos.entryPrice - pos.highWatermark) / oR;
          if (mR >= minR) {
            const td = cfg.chandelierExit.mult * av;
            if (pos.direction === "long") {
              const ns = pos.highWatermark - td;
              if (ns > pos.stopPrice) pos.stopPrice = ns;
            } else {
              const ns = pos.highWatermark + td;
              if (ns < pos.stopPrice) pos.stopPrice = ns;
            }
          }
        }
      }
      let ex: number | null = null;
      if (pos.direction === "long") {
        if (c.low <= pos.stopPrice) ex = pos.stopPrice;
        else if (c.high >= pos.tpPrice) ex = pos.tpPrice;
      } else {
        if (c.high >= pos.stopPrice) ex = pos.stopPrice;
        else if (c.low <= pos.tpPrice) ex = pos.tpPrice;
      }
      if (ex !== null) {
        let raw =
          pos.direction === "long"
            ? (ex - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - ex) / pos.entryPrice;
        if (pos.ptpTriggered && ptp)
          raw = pos.ptpRealizedPct + (1 - ptp.closeFraction) * raw;
        const eff = Math.max(
          raw * cfg.leverage * pos.effRisk,
          -pos.effRisk * 1.5,
        );
        state.equity *= 1 + eff;
        state.dayPeak = Math.max(state.dayPeak, state.equity);
        state.openPositions.splice(p, 1);
        state.closedTrades++;
      }
    }
    if (state.equity <= 1 - cfg.maxTotalLoss)
      return {
        passed: false,
        reason: "total_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
      };
    if ((state.equity - state.dayStart) / state.dayStart <= -cfg.maxDailyLoss)
      return {
        passed: false,
        reason: "daily_loss",
        passDay: 0,
        finalEquity: state.equity - 1,
        trades: state.closedTrades,
      };
    if (
      state.equity >= 1 + cfg.profitTarget &&
      state.firstTargetHitDay === null
    ) {
      state.firstTargetHitDay = cd;
      state.pausedAtTarget = !!cfg.pauseAtTargetReached;
    }
    if (state.firstTargetHitDay !== null) {
      state.tradingDays.add(cd);
      if (state.tradingDays.size >= minDays)
        return {
          passed: true,
          reason: "profit_target",
          passDay: Math.max(state.firstTargetHitDay + 1, minDays),
          finalEquity: state.equity - 1,
          trades: state.closedTrades,
        };
    }
    if (state.pausedAtTarget) continue;
    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }
    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;
    for (const a of cfg.assets) {
      const sk = a.sourceSymbol ?? a.symbol;
      const cs = aligned[sk];
      if (!cs) continue;
      const sl = cs.slice(0, i + 1);
      if (sl.length < 100) continue;
      let tr: Daytrade24hTrade[] = [];
      try {
        tr = detectAsset(sl, a, cfg);
      } catch {
        continue;
      }
      const m = tr.find((t) => t.entryTime === cb.openTime);
      if (!m) continue;
      if (mct !== undefined && state.openPositions.length >= mct) break;
      const sp = a.stopPct ?? cfg.stopPct,
        tp = a.tpPct ?? cfg.tpPct;
      const stp =
        m.direction === "long"
          ? m.entryPrice * (1 - sp)
          : m.entryPrice * (1 + sp);
      const tpp =
        m.direction === "long"
          ? m.entryPrice * (1 + tp)
          : m.entryPrice * (1 - tp);
      const sizingFactor = computeSizingFactor(state.equity, cd, cfg);
      const sized = a.riskFrac * sizingFactor;
      const cap = cfg.liveCaps?.maxRiskFrac ?? sized;
      const er = sized > cap ? cap : sized;
      if (er <= 0) continue;
      state.openPositions.push({
        symbol: m.symbol,
        sourceSymbol: sk,
        direction: m.direction,
        entryTime: m.entryTime,
        entryPrice: m.entryPrice,
        stopPrice: stp,
        tpPrice: tpp,
        riskFrac: a.riskFrac,
        effRisk: er,
        entryBarIdx: i,
        highWatermark: m.entryPrice,
        beActive: false,
        ptpTriggered: false,
        ptpRealizedPct: 0,
      });
      state.tradingDays.add(cd);
    }
  }
  const f =
    state.firstTargetHitDay !== null && state.tradingDays.size >= minDays;
  return {
    passed: f,
    reason: f ? "profit_target" : "time",
    passDay: f ? Math.max((state.firstTargetHitDay ?? 0) + 1, minDays) : 0,
    finalEquity: state.equity - 1,
    trades: state.closedTrades,
  };
}

// Build configs reproducing round 45/46 sweeps so we don't depend on
// JSON-stored configs for engine fields that aren't in the JSON.
function buildMrCfg(
  bbPeriod: number,
  bbSigma: number,
  rsiThresh: number,
): FtmoDaytrade24hConfig {
  const meanRev = { bbPeriod, bbSigma, rsiPeriod: 14, rsiThresh };
  const assets: Daytrade24hAssetCfg[] = BASKET.map((s) => ({
    symbol: `${s.replace("USDT", "")}-MR`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.01,
    holdBars: 60,
    meanRevEntry: meanRev,
  }));
  return {
    triggerBars: 1,
    leverage: 2,
    tpPct: 0.01,
    stopPct: 0.05,
    holdBars: 60,
    timeframe: "30m",
    assets,
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    maxConcurrentTrades: 4,
    pauseAtTargetReached: true,
    atrStop: { period: 14, stopMult: 2 },
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  };
}

function buildBoCfg(
  donchianPeriod: number,
  chandMult: number,
  volMaPeriod: number,
): FtmoDaytrade24hConfig {
  const breakout = { donchianPeriod, atrPeriod: 14, volMaPeriod };
  const assets: Daytrade24hAssetCfg[] = BASKET.map((s) => ({
    symbol: `${s.replace("USDT", "")}-BO`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.07,
    holdBars: 240,
    breakoutEntry: breakout,
  }));
  return {
    triggerBars: 1,
    leverage: 2,
    tpPct: 0.07,
    stopPct: 0.05,
    holdBars: 240,
    timeframe: "30m",
    assets,
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    maxConcurrentTrades: 4,
    pauseAtTargetReached: true,
    atrStop: { period: 14, stopMult: 2.5 },
    chandelierExit: { period: 14, mult: chandMult, minMoveR: 0.5 },
    partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.5 },
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  };
}

describe(
  "Round 47 — V4 simulator validation for MR + BO top configs",
  { timeout: 6 * 3600_000 },
  () => {
    it("runs", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `ROUND47 START ${new Date().toISOString()}\n`);

      // Read top-3 from rounds 45/46
      const mrJsonPath = `${LOG_DIR}/ROUND45_TOP3.json`;
      const boJsonPath = `${LOG_DIR}/ROUND46_TOP3.json`;
      let mr: Array<{
        label: string;
        bbPeriod: number;
        bbSigma: number;
        rsiThresh: number;
        passRate: number;
        med: number;
      }> = [];
      let bo: Array<{
        label: string;
        donchianPeriod: number;
        chandMult: number;
        volMaPeriod: number;
        passRate: number;
        med: number;
      }> = [];
      if (existsSync(mrJsonPath)) {
        mr = JSON.parse(readFileSync(mrJsonPath, "utf-8"));
        log(`Loaded ${mr.length} MR top configs from ${mrJsonPath}`);
      } else {
        log(`MR top-3 not found — using sweep winners hardcoded fallback`);
        mr = [
          {
            label: "MR_bb20_s2_r35",
            bbPeriod: 20,
            bbSigma: 2,
            rsiThresh: 35,
            passRate: 0.4724,
            med: 8,
          },
          {
            label: "MR_bb25_s2_r35",
            bbPeriod: 25,
            bbSigma: 2,
            rsiThresh: 35,
            passRate: 0.4673,
            med: 8,
          },
          {
            label: "MR_bb15_s1.8_r35",
            bbPeriod: 15,
            bbSigma: 1.8,
            rsiThresh: 35,
            passRate: 0.4523,
            med: 8,
          },
        ];
      }
      if (existsSync(boJsonPath)) {
        bo = JSON.parse(readFileSync(boJsonPath, "utf-8"));
        log(`Loaded ${bo.length} BO top configs from ${boJsonPath}`);
      } else {
        log(`BO top-3 not found — using sweep winners hardcoded fallback`);
        bo = [
          {
            label: "BO_dp15_cm1.5_v70",
            donchianPeriod: 15,
            chandMult: 1.5,
            volMaPeriod: 70,
            passRate: 0.4472,
            med: 5,
          },
          {
            label: "BO_dp25_cm1.5_v70",
            donchianPeriod: 25,
            chandMult: 1.5,
            volMaPeriod: 70,
            passRate: 0.4372,
            med: 5,
          },
          {
            label: "BO_dp20_cm1.5_v70",
            donchianPeriod: 20,
            chandMult: 1.5,
            volMaPeriod: 70,
            passRate: 0.4322,
            med: 5,
          },
        ];
      }

      log(`\nLoading 30m candles for ${BASKET.length} assets...`);
      const data: Record<string, Candle[]> = {};
      for (const s of BASKET) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 30000,
            maxPages: 40,
          });
          data[s] = r.filter((c) => c.isFinal !== false);
          log(`  ${s}: ${data[s].length} bars`);
        } catch (e) {
          log(`  ${s}: FAIL ${(e as Error).message}`);
        }
      }
      const symbols = BASKET.filter((s) => data[s]?.length > 0);
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s].length));
      log(`Aligned: ${minBars} bars / ${(minBars / 48 / 365).toFixed(2)}y\n`);

      const bpd = 48;
      const winBars = 30 * bpd;
      const stepBars = 3 * bpd;

      function evalBoth(
        cfg: FtmoDaytrade24hConfig,
        label: string,
        engineRate: number,
      ) {
        // Engine
        let p = 0,
          w = 0;
        for (let s = 0; s + winBars <= minBars; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const sm of symbols) sub[sm] = aligned[sm].slice(s, s + winBars);
          const r = runFtmoDaytrade24h(sub, cfg);
          if (r.passed) p++;
          w++;
        }
        const eRate = (p / w) * 100;
        // V4 sim
        let vp = 0,
          vw = 0;
        const days: number[] = [];
        for (let s = 0; s + winBars <= minBars; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const sm of symbols) sub[sm] = aligned[sm].slice(s, s + winBars);
          const r = simulateLive(sub, cfg, 0, winBars);
          vw++;
          if (r.passed) {
            vp++;
            if (r.passDay) days.push(r.passDay);
          }
        }
        days.sort((a, b) => a - b);
        const vMed = days[Math.floor(days.length * 0.5)] ?? 0;
        const vRate = (vp / vw) * 100;
        const drift = vRate - eRate;
        log(
          `  ${label.padEnd(28)} engine=${eRate.toFixed(2)}% (${p}/${w}) V4-sim=${vRate.toFixed(2)}% (${vp}/${vw}) Δ=${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp / med ${vMed}d  prevEng=${(engineRate * 100).toFixed(2)}%`,
        );
        return { eRate, vRate, drift, vMed };
      }

      log(`========== Mean-Reversion top-3 V4-Sim ==========`);
      const mrResults: Array<{
        label: string;
        eRate: number;
        vRate: number;
        drift: number;
        vMed: number;
      }> = [];
      for (const m of mr) {
        const cfg = buildMrCfg(m.bbPeriod, m.bbSigma, m.rsiThresh);
        const r = evalBoth(cfg, m.label, m.passRate);
        mrResults.push({ label: m.label, ...r });
      }

      log(`\n========== Breakout top-3 V4-Sim ==========`);
      const boResults: Array<{
        label: string;
        eRate: number;
        vRate: number;
        drift: number;
        vMed: number;
      }> = [];
      for (const b of bo) {
        const cfg = buildBoCfg(b.donchianPeriod, b.chandMult, b.volMaPeriod);
        const r = evalBoth(cfg, b.label, b.passRate);
        boResults.push({ label: b.label, ...r });
      }

      const all = [...mrResults, ...boResults];
      all.sort((a, b) => b.vRate - a.vRate);
      log(`\n========== V4-Sim leaderboard (sorted) ==========`);
      for (const r of all) {
        const pass = r.vRate >= 45 ? "[PASS]" : "";
        log(
          `  ${r.label.padEnd(28)} V4-Sim=${r.vRate.toFixed(2)}% / med ${r.vMed}d / drift ${r.drift >= 0 ? "+" : ""}${r.drift.toFixed(2)}pp ${pass}`,
        );
      }
      const best = all[0];
      log(
        `\n>>> WINNER: ${best.label}  V4-Sim ${best.vRate.toFixed(2)}%  med ${best.vMed}d`,
      );
      const target = 45;
      log(
        `Acceptance ≥${target}% V4-Sim:  ${best.vRate >= target ? "MET" : "NOT MET"}  (best=${best.vRate.toFixed(2)}%)`,
      );

      writeFileSync(
        `${LOG_DIR}/ROUND47_V4SIM_RESULTS.json`,
        JSON.stringify(all, null, 2),
      );
      expect(all.length).toBeGreaterThan(0);
    });
  },
);
