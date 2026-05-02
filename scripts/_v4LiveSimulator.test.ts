/**
 * V4 Live Simulator — Replays bar-by-bar with persistent state.
 *
 * This is a minimal V4 implementation as a TEST file (not production).
 * If we measure ≥70% pass-rate matching backtest, V4 architecture is validated
 * and we can extract to ftmoLiveEngineV4.ts (Round 26).
 *
 * Approach:
 * 1. Single state object (equity, day, dayPeak, openPositions, etc.)
 * 2. Walk bars one-by-one
 * 3. At each bar: call detectAsset(slice[0..i+1]) on each asset → raw signals
 * 4. Apply state filters: MCT, pauseAtTarget, dailyPeakTrailingStop
 * 5. Open positions; track exits
 * 6. Measure: passed? at what day?
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_V245,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { atr } from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;

interface OpenPosition {
  symbol: string; // engine-internal "BTC-TREND"
  sourceSymbol: string; // candles key "BTCUSDT"
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  tpPrice: number;
  riskFrac: number;
  effRisk: number;
  entryBarIdx: number;
  highWatermark: number; // for chandelier
  beActive: boolean; // breakEven activated?
  // partialTakeProfit state (engine ftmoDaytrade24h.ts iter261+)
  ptpTriggered: boolean;
  ptpRealizedPct: number; // realized P&L locked from partial close (signed)
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

/**
 * Simulate live-bar-by-bar with persistent state.
 * Returns final state + passed flag.
 */
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

  // Precompute ATR series per asset for proper chandelierExit replication.
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

    // Day rollover
    if (currentDay > state.day) {
      state.day = currentDay;
      state.dayStart = state.equity;
      state.dayPeak = state.equity;
    }
    state.dayPeak = Math.max(state.dayPeak, state.equity);

    // Process exits for open positions
    for (let p = state.openPositions.length - 1; p >= 0; p--) {
      const pos = state.openPositions[p];
      const candle = aligned[pos.sourceSymbol]?.[i];
      if (!candle) continue;

      // Update high-watermark for chandelier
      if (pos.direction === "long") {
        pos.highWatermark = Math.max(pos.highWatermark, candle.high);
      } else {
        pos.highWatermark = Math.min(pos.highWatermark, candle.low);
      }

      // ── partialTakeProfit (PTP) — mirrors engine iter261+ ───────────────
      // When triggerPrice is touched on the favorable side, lock a fraction
      // of (closeFraction * triggerPct) and auto-move stop to BE. Conservative
      // tie-break: if BOTH PTP-trigger and current-stop hit in same bar,
      // assume STOP fires FIRST unless bar.open already past PTP (gap).
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
          // Auto-move stop to break-even (mirrors engine Audit Bug A fix)
          if (pos.direction === "long") {
            if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice;
          } else {
            if (pos.entryPrice < pos.stopPrice) pos.stopPrice = pos.entryPrice;
          }
          pos.beActive = true;
          // Reset chandelier reference to current bar (Audit Bug B)
          pos.highWatermark =
            pos.direction === "long" ? candle.close : candle.close;
        }
      }

      // breakEven: shift stop to entry once price moves +X% in favor
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

      // chandelierExit with proper ATR(period) smoothed series + minMoveR
      // gate (R26 v5 fix). Engine convention: trail only ratchets after move
      // exceeds minMoveR * R (R = original stop distance). Without this gate
      // V4 v4 dropped to 27% — premature exits before trail intent.
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
        // Engine PTP blend: realized partial + (1-closeFraction) * remainder
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

    // Check fail conditions
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

    // Daily peak trailing stop gate
    if (trail !== undefined) {
      const drop =
        (state.dayPeak - state.equity) / Math.max(state.dayPeak, 1e-9);
      if (drop >= trail) continue;
    }

    // MCT gate
    const mct = cfg.maxConcurrentTrades;
    if (mct !== undefined && state.openPositions.length >= mct) continue;

    // Detect signals at current bar
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
      // Find trade with entry-time = current bar.openTime
      const matched = trades.find((t) => t.entryTime === currentBar.openTime);
      if (!matched) continue;

      // Check MCT again before opening
      if (mct !== undefined && state.openPositions.length >= mct) break;

      // Open position
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

  // End of window
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

describe("V4 Live Simulator vs Backtest", { timeout: 60 * 60_000 }, () => {
  it("compare V4-simulated vs runFtmoDaytrade24h pass-rates", async () => {
    for (const [name, CFG] of [
      ["V5_QUARTZ_LITE", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE],
      ["V5_NOVA", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA],
      ["V245", FTMO_DAYTRADE_24H_CONFIG_V245],
    ] as const) {
      console.log(`\n=== ${name} ===`);
      const cfg: FtmoDaytrade24hConfig = {
        ...CFG,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      };
      const symbols = syms(cfg);
      const tf = name === "V5_NOVA" ? "2h" : name === "V245" ? "4h" : "30m";
      const bpd = name === "V5_NOVA" ? 12 : name === "V245" ? 6 : 48;
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
        } catch {}
      }
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
      const winBars = cfg.maxDays * bpd;
      const stepBars = 3 * bpd;

      // Backtest reference
      let btWindows = 0,
        btPasses = 0;
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
        }
      }
      btPassDays.sort((a, b) => a - b);
      console.log(
        `BACKTEST: ${btPasses}/${btWindows} = ${((btPasses / btWindows) * 100).toFixed(2)}% / med=${btPassDays[Math.floor(btPassDays.length / 2)]}d`,
      );

      // V4 simulation
      let v4Windows = 0,
        v4Passes = 0;
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
        }
      }
      v4PassDays.sort((a, b) => a - b);
      console.log(
        `V4 LIVE:  ${v4Passes}/${v4Windows} = ${((v4Passes / v4Windows) * 100).toFixed(2)}% / med=${v4PassDays[Math.floor(v4PassDays.length / 2)]}d`,
      );

      const drift = (v4Passes / v4Windows - btPasses / btWindows) * 100;
      console.log(`Drift: ${drift.toFixed(2)}pp`);
    }
    expect(true).toBe(true);
  });
});
