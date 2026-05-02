/**
 * Round 28 — V5_QUARTZ_LITE Asset Drop Test (2026-04-30)
 *
 * Goal: Find the asset subset where V4-live pass-rate >= 70%.
 *
 * Per-asset drift analysis (Agent 3) showed:
 *   - AAVE alone = 28.5% of total -30pp drift
 *   - Top-3 (AAVE, LTC, XRP) = 62% of drift
 *   - AAVE V4-live winrate 67.6% with NEGATIVE PnL while backtest WR 80.6%
 *
 * Test 3 variants:
 *   a) NO_AAVE: Drop AAVE only (8 assets)
 *   b) TOP6:    Drop AAVE+LTC+XRP (6 assets)
 *   c) HIGH_MOMENTUM: Keep only BTC, ETH, BNB, BCH (4 assets, drift-immune)
 *
 * For each variant: run BOTH backtest engine and V4 live simulator.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { atr } from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";

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
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
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

  const ts0 = aligned[Object.keys(aligned)[0]][windowStart].openTime;
  const symbols = syms(cfg);
  const ethKey = symbols.find((s) => s === "ETHUSDT") ?? symbols[0];
  const crossKey = cfg.crossAssetFilter?.symbol;

  const minDays = cfg.minTradingDays ?? 4;
  const maxDays = cfg.maxDays;
  const trail = cfg.dailyPeakTrailingStop?.trailDistance;

  const atrByAsset: Record<string, (number | null)[]> = {};
  if (cfg.chandelierExit) {
    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const cs = aligned[sourceKey];
      if (cs) atrByAsset[sourceKey] = atr(cs, cfg.chandelierExit.period);
    }
  }

  for (let i = windowStart; i < windowEnd; i++) {
    const currentBar = aligned[ethKey][i];
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

    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const candle = aligned[pos.sourceSymbol]?.[i];
      if (!candle) continue;

      if (pos.direction === "long") {
        pos.highWatermark = Math.max(pos.highWatermark, candle.high);
      } else {
        pos.highWatermark = Math.min(pos.highWatermark, candle.low);
      }

      const ptp = cfg.partialTakeProfit;
      if (ptp && !pos.ptpTriggered) {
        const triggerPrice =
          pos.direction === "long"
            ? pos.entryPrice * (1 + ptp.triggerPct)
            : pos.entryPrice * (1 - ptp.triggerPct);
        const ptpHit =
          pos.direction === "long"
            ? candle.high >= triggerPrice
            : candle.low <= triggerPrice;
        const stopHit =
          pos.direction === "long"
            ? candle.low <= pos.stopPrice
            : candle.high >= pos.stopPrice;
        const gapPastPtp =
          pos.direction === "long"
            ? candle.open >= triggerPrice
            : candle.open <= triggerPrice;
        if (ptpHit && (!stopHit || gapPastPtp)) {
          pos.ptpTriggered = true;
          pos.ptpRealizedPct = ptp.closeFraction * ptp.triggerPct;
          if (pos.direction === "long") {
            if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice;
          } else {
            if (pos.entryPrice < pos.stopPrice) pos.stopPrice = pos.entryPrice;
          }
          pos.beActive = true;
          pos.highWatermark = candle.close;
        }
      }

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
      let exitReason = "";
      if (pos.direction === "long") {
        if (candle.low <= pos.stopPrice) {
          exitPrice = pos.stopPrice;
          exitReason = "sl";
        } else if (candle.high >= pos.tpPrice) {
          exitPrice = pos.tpPrice;
          exitReason = "tp";
        }
      } else {
        if (candle.high >= pos.stopPrice) {
          exitPrice = pos.stopPrice;
          exitReason = "sl";
        } else if (candle.low <= pos.tpPrice) {
          exitPrice = pos.tpPrice;
          exitReason = "tp";
        }
      }
      if (exitPrice !== null) {
        let rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
        if (pos.ptpTriggered && ptp) {
          rawPnl = pos.ptpRealizedPct + (1 - ptp.closeFraction) * rawPnl;
        }
        const effPnl = Math.max(
          rawPnl * cfg.leverage * pos.effRisk,
          -pos.effRisk * 1.5,
        );
        state.equity *= 1 + effPnl;
        state.dayPeak = Math.max(state.dayPeak, state.equity);
        state.openPositions.splice(p, 1);
        state.closedTrades++;
        void exitReason;
      }
    }

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

    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }

    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;

    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const candles = aligned[sourceKey];
      if (!candles) continue;
      const slice = candles.slice(0, i + 1);
      if (slice.length < 100) continue;
      const cross = crossKey ? aligned[crossKey]?.slice(0, i + 1) : undefined;
      let trades: Daytrade24hTrade[] = [];
      try {
        trades = detectAsset(slice, asset, cfg, cross);
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
      void stopPct;
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

/**
 * Build a variant of V5_QUARTZ_LITE keeping only the listed asset symbols.
 * Deep-copies via spread; only `assets` is filtered. All other engine fields
 * (maxConcurrentTrades, dailyPeakTrailingStop, pauseAtTargetReached, atrStop,
 * chandelierExit, breakEven, hours, etc.) remain identical.
 */
function buildVariant(
  keepSymbols: string[],
  liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 },
): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
  return {
    ...base,
    assets: base.assets.filter((a) => keepSymbols.includes(a.symbol)),
    liveCaps,
  };
}

describe(
  "V5_QUARTZ_LITE Asset Drop Test — find ≥70% live subset",
  { timeout: 60 * 60_000 },
  () => {
    it("compare backtest vs V4-live on 3 reduced-asset variants", async () => {
      const variants: Array<{ name: string; keep: string[] }> = [
        {
          name: "NO_AAVE (8 assets)",
          keep: [
            "BTC-TREND",
            "ETH-TREND",
            "BNB-TREND",
            "ADA-TREND",
            "LTC-TREND",
            "BCH-TREND",
            "ETC-TREND",
            "XRP-TREND",
          ],
        },
        {
          name: "TOP6 (drop AAVE+LTC+XRP, 6 assets)",
          keep: [
            "BTC-TREND",
            "ETH-TREND",
            "BNB-TREND",
            "ADA-TREND",
            "BCH-TREND",
            "ETC-TREND",
          ],
        },
        {
          name: "HIGH_MOMENTUM (BTC/ETH/BNB/BCH, 4 assets)",
          keep: ["BTC-TREND", "ETH-TREND", "BNB-TREND", "BCH-TREND"],
        },
      ];

      // 30m timeframe (V5_QUARTZ_LITE base)
      const tf = "30m";
      const bpd = 48;

      const summary: Array<{
        name: string;
        bt: { passes: number; windows: number; medDay: number };
        v4: { passes: number; windows: number; medDay: number };
      }> = [];

      for (const variant of variants) {
        console.log(`\n========== ${variant.name} ==========`);
        const cfg = buildVariant(variant.keep);
        const symbols = syms(cfg);
        console.log(`Assets: ${cfg.assets.map((a) => a.symbol).join(", ")}`);
        console.log(`Sources: ${symbols.join(", ")}`);

        const data: Record<string, Candle[]> = {};
        for (const s of symbols) {
          try {
            const r = await loadBinanceHistory({
              symbol: s,
              timeframe: tf,
              targetCount: 100000,
              maxPages: 120,
            });
            data[s] = r.filter((c) => c.isFinal);
          } catch (e) {
            console.log(`  WARN: load failed for ${s}: ${e}`);
          }
        }
        const aligned = alignCommon(data, symbols);
        const minBars = Math.min(
          ...symbols.map((s) => aligned[s]?.length ?? 0),
        );
        const winBars = cfg.maxDays * bpd;
        const stepBars = 3 * bpd;
        console.log(
          `Aligned bars: ${minBars} (${(minBars / bpd / 365).toFixed(2)}y)`,
        );

        // Backtest
        let btWindows = 0;
        let btPasses = 0;
        let btTL = 0;
        let btDL = 0;
        const btPassDays: number[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of symbols)
            slice[s] = aligned[s].slice(start, start + winBars);
          const res = runFtmoDaytrade24h(slice, cfg);
          btWindows++;
          if (res.passed) {
            btPasses++;
            if (res.passDay) btPassDays.push(res.passDay);
          } else if (res.reason === "total_loss") btTL++;
          else if (res.reason === "daily_loss") btDL++;
        }
        btPassDays.sort((a, b) => a - b);
        const btPct = (btPasses / btWindows) * 100;
        const btMed = btPassDays[Math.floor(btPassDays.length / 2)] ?? 0;
        console.log(
          `BACKTEST: ${btPasses}/${btWindows} = ${btPct.toFixed(2)}% | med=${btMed}d | TL=${((btTL / btWindows) * 100).toFixed(1)}% | DL=${((btDL / btWindows) * 100).toFixed(1)}%`,
        );

        // V4 live simulation
        let v4Windows = 0;
        let v4Passes = 0;
        let v4TL = 0;
        let v4DL = 0;
        const v4PassDays: number[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const winSlice: Record<string, Candle[]> = {};
          for (const s of symbols)
            winSlice[s] = aligned[s].slice(start, start + winBars);
          const res = simulateLive(winSlice, cfg, 0, winBars);
          v4Windows++;
          if (res.passed) {
            v4Passes++;
            if (res.passDay) v4PassDays.push(res.passDay);
          } else if (res.reason === "total_loss") v4TL++;
          else if (res.reason === "daily_loss") v4DL++;
        }
        v4PassDays.sort((a, b) => a - b);
        const v4Pct = (v4Passes / v4Windows) * 100;
        const v4Med = v4PassDays[Math.floor(v4PassDays.length / 2)] ?? 0;
        console.log(
          `V4 LIVE:  ${v4Passes}/${v4Windows} = ${v4Pct.toFixed(2)}% | med=${v4Med}d | TL=${((v4TL / v4Windows) * 100).toFixed(1)}% | DL=${((v4DL / v4Windows) * 100).toFixed(1)}%`,
        );

        const drift = v4Pct - btPct;
        console.log(
          `DRIFT:    ${drift > 0 ? "+" : ""}${drift.toFixed(2)}pp (V4 - backtest)`,
        );

        summary.push({
          name: variant.name,
          bt: { passes: btPasses, windows: btWindows, medDay: btMed },
          v4: { passes: v4Passes, windows: v4Windows, medDay: v4Med },
        });
      }

      console.log("\n\n========== SUMMARY TABLE ==========");
      console.log(
        "Variant".padEnd(40) +
          "Backtest".padStart(15) +
          "V4 Live".padStart(15) +
          "Drift".padStart(12),
      );
      for (const s of summary) {
        const btPct = (s.bt.passes / s.bt.windows) * 100;
        const v4Pct = (s.v4.passes / s.v4.windows) * 100;
        const drift = v4Pct - btPct;
        console.log(
          s.name.padEnd(40) +
            `${btPct.toFixed(2)}%`.padStart(15) +
            `${v4Pct.toFixed(2)}%`.padStart(15) +
            `${drift > 0 ? "+" : ""}${drift.toFixed(2)}pp`.padStart(12),
        );
      }

      expect(true).toBe(true);
    });
  },
);
