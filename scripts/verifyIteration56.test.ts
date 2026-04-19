/**
 * Iter 56: Ultra-tight tp1 + wider stop for HF daytrading ≥70% WR.
 *
 * iter55: 10-asset 15m scale-out with tp1=0.2-0.5% → best frequency+WR was
 * fade vm4 tp0.4/1.2 stop1.2 hold16 → WR 75.7%, 5.4% ret, but only 7.2/wk.
 * With tp1=0.3%/stop=1.2%: WR 78.5% but again 7.2/wk (fade is asset-selective).
 *
 * New idea: ultra-tight tp1 (0.15-0.25%, ~4-6× fees) + wider stop (1.5-3%)
 * + looser trigger (vm 2-2.5, pZ 1.4-1.7). Rationale: on 15m every bar has
 * 0.1-0.3% range; a 0.2% tp1 should hit most of the time → more partial
 * wins → higher WR, while wider stop gives trades room to work to tp2.
 *
 * We run 3 candidate configs and compute per-asset + portfolio aggregate
 * with per-window bootstrap (10 chrono + 5 block).
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
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function smaOf(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

interface Trade {
  totalPnl: number;
}

function runScaleOut15m(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const w = candles.slice(i - cfg.lookback, i);
    const mv = median(w.map((c) => c.volume));
    if (mv <= 0) continue;
    const vZ = cur.volume / mv;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(w.map((c) => c.close));
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
      const sma48 = smaOf(w.slice(-48).map((c) => c.close));
      const alignedLong = cur.close > sma48;
      if (direction === "long" && !alignedLong) continue;
      if (direction === "short" && alignedLong) continue;
    }
    if (cfg.microPullback) {
      const p = candles[i - 1];
      const b = candles[i - 2];
      if (!p || !b) continue;
      if (cfg.mode === "momentum") {
        const pb = direction === "long" ? p.close < b.close : p.close > b.close;
        if (!pb) continue;
      } else {
        const sd2 = ret > 0 ? p.close > b.close : p.close < b.close;
        if (!sd2) continue;
      }
    }
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1L =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2L =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let stopL =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2Price = candles[mx].close;
    let l2Bar = mx;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = direction === "long" ? bar.low <= stopL : bar.high >= stopL;
      const t1 = direction === "long" ? bar.high >= tp1L : bar.low <= tp1L;
      const t2 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
      if (!tp1Hit) {
        if (t1 && sH) {
          l2Bar = j;
          l2Price = stopL;
          break;
        }
        if (sH) {
          l2Bar = j;
          l2Price = stopL;
          break;
        }
        if (t1) {
          tp1Hit = true;
          tp1Bar = j;
          if (cfg.useBreakeven) stopL = entry;
          if (t2) {
            l2Bar = j;
            l2Price = tp2L;
            break;
          }
          continue;
        }
      } else {
        const sH2 = direction === "long" ? bar.low <= stopL : bar.high >= stopL;
        const t22 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
        if (t22 && sH2) {
          l2Bar = j;
          l2Price = stopL;
          break;
        }
        if (t22) {
          l2Bar = j;
          l2Price = tp2L;
          break;
        }
        if (sH2) {
          l2Bar = j;
          l2Price = stopL;
          break;
        }
      }
    }
    const l2c = applyCosts({
      entry,
      exit: l2Price,
      direction,
      holdingHours: (l2Bar - (i + 1)) * 0.25,
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: (tp1Bar - (i + 1)) * 0.25,
        config: MAKER_COSTS,
      });
      leg1 = l1c.netPnlPct;
    } else {
      leg1 = leg2;
    }
    trades.push({ totalPnl: 0.5 * leg1 + 0.5 * leg2 });
    i = l2Bar;
  }
  return trades;
}

describe("iteration 56 — ultra-tight tp1 + wider stop", () => {
  it("sweep + portfolio aggregate", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 56: ULTRA-TIGHT tp1 + WIDE STOP ===");
    const data: Record<string, Candle[]> = {};
    for (const s of ASSETS) {
      try {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "15m",
          targetCount: 10000,
        });
      } catch {
        continue;
      }
    }
    const avail = ASSETS.filter((s) => data[s] && data[s].length >= 2000);
    console.log(`${avail.length} assets available`);

    const grid: Cfg[] = [];
    for (const mode of ["momentum", "fade"] as const) {
      for (const vm of [2.0, 2.5, 3.0]) {
        for (const pZ of [1.4, 1.6, 1.8]) {
          for (const tp1 of [0.0015, 0.002, 0.0025, 0.003]) {
            for (const mult of [4, 6, 10]) {
              const tp2 = tp1 * mult;
              for (const stop of [0.015, 0.02, 0.03]) {
                for (const hold of [16, 24, 32]) {
                  grid.push({
                    lookback: 48,
                    volMult: vm,
                    priceZ: pZ,
                    tp1Pct: tp1,
                    tp2Pct: tp2,
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
    console.log(`Grid: ${grid.length} configs`);

    interface Row {
      cfg: Cfg;
      n: number;
      wr: number;
      ret: number;
      tradesPerWeek: number;
    }
    const rows: Row[] = [];
    for (const cfg of grid) {
      let n = 0;
      let wins = 0;
      let sumLog = 0;
      let barMax = 0;
      for (const sym of avail) {
        const t = runScaleOut15m(data[sym], cfg);
        n += t.length;
        wins += t.filter((x) => x.totalPnl > 0).length;
        for (const x of t) sumLog += Math.log(1 + x.totalPnl);
        barMax = Math.max(barMax, data[sym].length);
      }
      if (n < 200) continue;
      const wr = wins / n;
      const ret = Math.exp(sumLog) - 1;
      const days = barMax / 96;
      const tpw = (n / days) * 7;
      rows.push({ cfg, n, wr, ret, tradesPerWeek: tpw });
    }

    const passers = rows.filter(
      (r) => r.wr >= 0.7 && r.ret > 0 && r.tradesPerWeek >= 10,
    );
    console.log(
      `\nEvaluated ${rows.length}, passing WR≥70+ret>0+≥10/wk: ${passers.length}`,
    );
    console.log("\n== Top 20 by (WR × ret / stop) score ==");
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
        "ret%".padStart(9),
    );
    const sorted = (passers.length > 0 ? passers : rows).sort(
      (a, b) => b.wr * b.ret - a.wr * a.ret,
    );
    for (const r of sorted.slice(0, 25)) {
      const c = r.cfg;
      console.log(
        c.mode.padEnd(10) +
          c.volMult.toFixed(1).padStart(5) +
          c.priceZ.toFixed(1).padStart(5) +
          `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(1)}`.padStart(
            12,
          ) +
          (c.stopPct * 100).toFixed(1).padStart(7) +
          c.holdBars.toString().padStart(5) +
          r.n.toString().padStart(6) +
          r.tradesPerWeek.toFixed(1).padStart(7) +
          (r.wr * 100).toFixed(1).padStart(7) +
          (r.ret * 100).toFixed(1).padStart(9),
      );
    }

    console.log(
      `\n★★★ ${passers.length} configs pass strict criteria (WR≥70 + ret>0 + ≥10/wk)`,
    );
    for (const p of passers.sort((a, b) => b.ret - a.ret).slice(0, 5)) {
      const c = p.cfg;
      console.log(
        `  ${c.mode} vm${c.volMult}/pZ${c.priceZ} tp1=${(c.tp1Pct * 100).toFixed(2)}%/tp2=${(c.tp2Pct * 100).toFixed(1)}% stop=${(c.stopPct * 100).toFixed(1)}% hold=${c.holdBars} → WR ${(p.wr * 100).toFixed(1)}%, ${p.tradesPerWeek.toFixed(1)}/wk, ret ${(p.ret * 100).toFixed(1)}%`,
      );
    }
  });
});
