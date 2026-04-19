/**
 * Iter 55: High-frequency daytrading sweep on 15m bars.
 *
 * User wants "mehrere Trades pro Tag" with ≥70% WR. iter43 showed on 15m
 * bars no pure TP/Stop config hits 60% WR, but iter53 showed scale-out +
 * BE-stop + HTF filter CAN on 1h bars.
 *
 * Try same mechanic on 15m across 10 alts. Target:
 *   - portfolio ≥5 trades/day (35/week)
 *   - minWR ≥70% on bootstrap
 *   - positive net return
 *
 * Sweep grid:
 *   - timeframe 15m (96 bars per day on 15m? no — 96 bars/day on 15m bars)
 *     actually 24h × 4 = 96 bars per day
 *   - lookback = 48 (12h)
 *   - volMult in {2.5, 3, 4}, priceZ in {1.7, 2.0}
 *   - tp1 in {0.002, 0.003, 0.004, 0.005}, tp2 = 4× tp1
 *   - stopPct in {0.006, 0.008, 0.012}
 *   - holdBars in {8, 16} (2h, 4h)
 *   - htf+micro filter ON (from iter53 learning)
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { applyCosts } from "../src/utils/costModel";
import type { Candle } from "../src/utils/indicators";

const ASSETS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "AVAXUSDT",
  "SUIUSDT",
  "APTUSDT",
  "INJUSDT",
  "NEARUSDT",
  "OPUSDT",
  "LINKUSDT",
];

interface Cfg {
  lookback: number;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
  htfTrend: boolean;
  microPullback: boolean;
  useBreakeven: boolean;
  avoidHours?: number[];
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function sma(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

interface TradeRec {
  totalPnl: number;
  entryTime: number;
}
interface RunResult {
  trades: TradeRec[];
  wr: number;
  ret: number;
}

function runScaleOut(candles: Candle[], cfg: Cfg): RunResult {
  const trades: TradeRec[] = [];
  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const window = candles.slice(i - cfg.lookback, i);
    const medVol = median(window.map((c) => c.volume));
    if (medVol <= 0) continue;
    const vZ = cur.volume / medVol;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(window.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;

    const direction: "long" | "short" =
      cfg.mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";

    if (cfg.htfTrend) {
      const sma24 = sma(window.slice(-48).map((c) => c.close));
      const alignedLong = cur.close > sma24;
      if (direction === "long" && !alignedLong) continue;
      if (direction === "short" && alignedLong) continue;
    }
    if (cfg.microPullback) {
      const penult = candles[i - 1];
      const before = candles[i - 2];
      if (!penult || !before) continue;
      if (cfg.mode === "momentum") {
        const pullback =
          direction === "long"
            ? penult.close < before.close
            : penult.close > before.close;
        if (!pullback) continue;
      } else {
        const sameDir =
          ret > 0 ? penult.close > before.close : penult.close < before.close;
        if (!sameDir) continue;
      }
    }
    if (cfg.avoidHours?.length) {
      const h = new Date(cur.openTime).getUTCHours();
      if (cfg.avoidHours.includes(h)) continue;
    }

    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const entry = entryBar.open;
    const tp1Level =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2Level =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);

    const maxExit = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1HitBar = -1;
    let leg2ExitPrice = candles[maxExit].close;
    let leg2ExitBar = maxExit;

    for (let j = i + 2; j <= maxExit; j++) {
      const bar = candles[j];
      const stopHit =
        direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
      const tp1R =
        direction === "long" ? bar.high >= tp1Level : bar.low <= tp1Level;
      const tp2R =
        direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;
      if (!tp1Hit) {
        if (tp1R && stopHit) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
        if (stopHit) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
        if (tp1R) {
          tp1Hit = true;
          tp1HitBar = j;
          if (cfg.useBreakeven) stopLevel = entry;
          if (tp2R) {
            leg2ExitBar = j;
            leg2ExitPrice = tp2Level;
            break;
          }
          continue;
        }
      } else {
        const sH =
          direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
        const t2R =
          direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;
        if (t2R && sH) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
        if (t2R) {
          leg2ExitBar = j;
          leg2ExitPrice = tp2Level;
          break;
        }
        if (sH) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          break;
        }
      }
    }
    const leg2Cost = applyCosts({
      entry,
      exit: leg2ExitPrice,
      direction,
      holdingHours: (leg2ExitBar - (i + 1)) * 0.25, // 15m bars
      config: MAKER_COSTS,
    });
    const leg2 = leg2Cost.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const leg1Cost = applyCosts({
        entry,
        exit: tp1Level,
        direction,
        holdingHours: (tp1HitBar - (i + 1)) * 0.25,
        config: MAKER_COSTS,
      });
      leg1 = leg1Cost.netPnlPct;
    } else {
      leg1 = leg2;
    }
    const total = 0.5 * leg1 + 0.5 * leg2;
    trades.push({ totalPnl: total, entryTime: entryBar.openTime });
    i = leg2ExitBar;
  }
  const wins = trades.filter((t) => t.totalPnl > 0).length;
  const wr = trades.length > 0 ? wins / trades.length : 0;
  const ret =
    trades.length > 0
      ? trades.reduce((a, t) => a * (1 + t.totalPnl), 1) - 1
      : 0;
  return { trades, wr, ret };
}

describe("iteration 55 — 15m Multi-Asset scale-out sweep", () => {
  it("find best portfolio config", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 55: 15m MULTI-ASSET SCALE-OUT ===");
    const data: Record<string, Candle[]> = {};
    for (const s of ASSETS) {
      try {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "15m",
          targetCount: 10000,
        });
        console.log(
          `  ${s}: ${data[s].length} bars (${(data[s].length / 96).toFixed(0)} days)`,
        );
      } catch (err) {
        console.log(`  ${s}: fetch failed - skip`);
      }
    }
    const avail = ASSETS.filter((s) => data[s] && data[s].length >= 2000);
    console.log(`\n${avail.length}/${ASSETS.length} assets available`);

    // Grid
    const grid: Cfg[] = [];
    for (const mode of ["momentum", "fade"] as const) {
      for (const vm of [2.5, 3, 4]) {
        for (const pZ of [1.7, 2.0]) {
          for (const tp1 of [0.002, 0.003, 0.004, 0.005]) {
            for (const tp2Mult of [3, 5]) {
              for (const stop of [0.006, 0.008, 0.012]) {
                for (const hold of [8, 16]) {
                  grid.push({
                    lookback: 48,
                    volMult: vm,
                    priceZ: pZ,
                    tp1Pct: tp1,
                    tp2Pct: tp1 * tp2Mult,
                    stopPct: stop,
                    holdBars: hold,
                    mode,
                    htfTrend: true,
                    microPullback: true,
                    useBreakeven: true,
                  });
                }
              }
            }
          }
        }
      }
    }
    console.log(`Grid size: ${grid.length} configs`);

    interface PortRow {
      cfgIdx: number;
      mode: string;
      vm: number;
      pZ: number;
      tp1: number;
      tp2: number;
      stop: number;
      hold: number;
      totalTrades: number;
      tradesPerWeek: number;
      wr: number;
      ret: number;
    }
    const rows: PortRow[] = [];

    for (let i = 0; i < grid.length; i++) {
      const cfg = grid[i];
      // Aggregate across all available assets
      let totalTrades = 0;
      let totalWins = 0;
      let sumLogRet = 0;
      let totalBars = 0;
      for (const sym of avail) {
        const r = runScaleOut(data[sym], cfg);
        totalTrades += r.trades.length;
        totalWins += r.trades.filter((t) => t.totalPnl > 0).length;
        for (const t of r.trades) sumLogRet += Math.log(1 + t.totalPnl);
        totalBars = Math.max(totalBars, data[sym].length);
      }
      const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
      const ret = Math.exp(sumLogRet) - 1;
      const daysTotal = totalBars / 96;
      const tradesPerWeek = (totalTrades / daysTotal) * 7;
      if (totalTrades < 100) continue; // need enough data
      rows.push({
        cfgIdx: i,
        mode: cfg.mode,
        vm: cfg.volMult,
        pZ: cfg.priceZ,
        tp1: cfg.tp1Pct,
        tp2: cfg.tp2Pct,
        stop: cfg.stopPct,
        hold: cfg.holdBars,
        totalTrades,
        tradesPerWeek,
        wr,
        ret,
      });
    }

    // Filter: WR >= 70, ret > 0, tradesPerWeek >= 10 (user wants mehrere/day)
    const winners = rows.filter(
      (r) => r.wr >= 0.7 && r.ret > 0 && r.tradesPerWeek >= 10,
    );
    console.log(
      `\n=> ${rows.length} evaluated, ${winners.length} pass WR≥70 + ret>0 + ≥10trades/week`,
    );

    console.log("\n== Top 20 by WR (with min trades/week ≥ 10 preferred) ==");
    console.log(
      "mode".padEnd(10) +
        "vm".padStart(5) +
        "pZ".padStart(5) +
        "tp1/tp2".padStart(12) +
        "stop".padStart(7) +
        "hold".padStart(5) +
        "n".padStart(6) +
        "tr/wk".padStart(7) +
        "WR%".padStart(7) +
        "ret%".padStart(8),
    );
    const display = winners.length > 0 ? winners : rows;
    for (const r of display
      .sort((a, b) => b.wr * b.ret - a.wr * a.ret)
      .slice(0, 30)) {
      console.log(
        r.mode.padEnd(10) +
          r.vm.toFixed(1).padStart(5) +
          r.pZ.toFixed(1).padStart(5) +
          `${(r.tp1 * 100).toFixed(2)}/${(r.tp2 * 100).toFixed(1)}`.padStart(
            12,
          ) +
          (r.stop * 100).toFixed(2).padStart(7) +
          r.hold.toString().padStart(5) +
          r.totalTrades.toString().padStart(6) +
          r.tradesPerWeek.toFixed(1).padStart(7) +
          (r.wr * 100).toFixed(1).padStart(7) +
          (r.ret * 100).toFixed(1).padStart(8),
      );
    }

    console.log(`\n★ ${winners.length} candidates. Top 5 details:`);
    for (const w of winners.sort((a, b) => b.ret - a.ret).slice(0, 5)) {
      console.log(
        `  ${w.mode} vm${w.vm}/pZ${w.pZ} tp1=${(w.tp1 * 100).toFixed(2)}%/tp2=${(w.tp2 * 100).toFixed(1)}% stop=${(w.stop * 100).toFixed(2)}% hold=${w.hold} → WR ${(w.wr * 100).toFixed(1)}%, ${w.tradesPerWeek.toFixed(1)}trade/wk, ret ${(w.ret * 100).toFixed(1)}%, n=${w.totalTrades}`,
      );
    }
  });
});
