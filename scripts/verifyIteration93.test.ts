/**
 * Iter 93: Multi-period BTC validation.
 *
 * Test top iter92 configs in disjoint ~20-day windows (5 windows × 20 days)
 * to see if edge is consistent month-over-month, not just cherry-picked by
 * full-history aggregation.
 *
 * Pass criteria per config:
 *   - ≥80% of windows have ret > 0 (profitable)
 *   - min WR across windows ≥ 75%
 *   - avg trades ≥ 0.7/day across windows
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  name: string;
  lookback: number;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
}

const CANDIDATES: Cfg[] = [
  {
    name: "HIGH-WR: fade 1.0/0.8 tp0.10/0.80 s2.0 h24",
    lookback: 48,
    volMult: 1.0,
    priceZ: 0.8,
    tp1Pct: 0.001,
    tp2Pct: 0.008,
    stopPct: 0.02,
    holdBars: 24,
    mode: "fade",
  },
  {
    name: "MAX-RET: fade 1.0/0.8 tp0.20/1.60 s2.0 h24",
    lookback: 48,
    volMult: 1.0,
    priceZ: 0.8,
    tp1Pct: 0.002,
    tp2Pct: 0.016,
    stopPct: 0.02,
    holdBars: 24,
    mode: "fade",
  },
  {
    name: "BALANCE: fade 1.0/1.2 tp0.20/1.60 s2.0 h24",
    lookback: 48,
    volMult: 1.0,
    priceZ: 1.2,
    tp1Pct: 0.002,
    tp2Pct: 0.016,
    stopPct: 0.02,
    holdBars: 24,
    mode: "fade",
  },
  {
    name: "OLD-BTC: fade 2.0/1.8 tp0.15/1.20 s2.0 h24 (iter91 baseline)",
    lookback: 48,
    volMult: 2.0,
    priceZ: 1.8,
    tp1Pct: 0.0015,
    tp2Pct: 0.012,
    stopPct: 0.02,
    holdBars: 24,
    mode: "fade",
  },
];

function median(a: number[]) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function stdReturns(c: number[]) {
  if (c.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] <= 0) continue;
    r.push((c[i] - c[i - 1]) / c[i - 1]);
  }
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function smaLast(v: number[], n: number) {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

interface Trade {
  pnl: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
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
    const sma48 = smaLast(
      w.slice(-48).map((c) => c.close),
      48,
    );
    const aligned = cur.close > sma48;
    if (direction === "long" && !aligned) continue;
    if (direction === "short" && aligned) continue;
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) continue;
    const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
    if (!sameDir) continue;
    if (new Date(cur.openTime).getUTCHours() === 0) continue;
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
    let sL =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = direction === "long" ? bar.low <= sL : bar.high >= sL;
      const t1 = direction === "long" ? bar.high >= tp1L : bar.low <= tp1L;
      const t2 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
      if (!tp1Hit) {
        if ((t1 && sH) || sH) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (t1) {
          tp1Hit = true;
          tp1Bar = j;
          sL = entry;
          if (t2) {
            l2B = j;
            l2P = tp2L;
            break;
          }
          continue;
        }
      } else {
        const s2 = direction === "long" ? bar.low <= sL : bar.high >= sL;
        const t22 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
        if ((t22 && s2) || s2) {
          l2B = j;
          l2P = sL;
          break;
        }
        if (t22) {
          l2B = j;
          l2P = tp2L;
          break;
        }
      }
    }
    const l2c = applyCosts({
      entry,
      exit: l2P,
      direction,
      holdingHours: (l2B - (i + 1)) * 0.25,
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
    trades.push({ pnl: 0.5 * leg1 + 0.5 * leg2 });
    i = l2B;
  }
  return trades;
}

describe("iter 93 — BTC multi-period validation", () => {
  it(
    "split into disjoint 20-day windows, measure per-window consistency",
    { timeout: 300_000 },
    async () => {
      console.log("\n=== ITER 93: BTC multi-period validation ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 10000,
      });
      const barsPerWindow = 20 * 96; // 20 days
      const numWindows = Math.floor(btc.length / barsPerWindow);
      console.log(
        `BTC: ${btc.length} bars = ${numWindows} disjoint ${barsPerWindow}-bar windows (${(barsPerWindow / 96).toFixed(0)} days each)`,
      );

      for (const cfg of CANDIDATES) {
        console.log(`\n── ${cfg.name} ──`);
        console.log(
          "window".padEnd(8) +
            "trades".padStart(8) +
            "tpd".padStart(6) +
            "WR%".padStart(7) +
            "ret%".padStart(9),
        );
        interface Rec {
          trades: number;
          wr: number;
          ret: number;
        }
        const recs: Rec[] = [];
        for (let w = 0; w < numWindows; w++) {
          const start = w * barsPerWindow;
          const slice = btc.slice(start, start + barsPerWindow);
          const r = run(slice, cfg);
          const wins = r.filter((t) => t.pnl > 0).length;
          const wr = r.length > 0 ? wins / r.length : 0;
          const ret = r.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
          recs.push({ trades: r.length, wr, ret });
          console.log(
            `w${w}`.padEnd(8) +
              r.length.toString().padStart(8) +
              (r.length / 20).toFixed(2).padStart(6) +
              (wr * 100).toFixed(1).padStart(7) +
              (ret * 100).toFixed(1).padStart(9),
          );
        }
        const wrs = recs.filter((r) => r.trades > 0).map((r) => r.wr);
        const rets = recs.map((r) => r.ret);
        const minWR = wrs.length > 0 ? Math.min(...wrs) : 0;
        const medWR =
          wrs.length > 0 ? [...wrs].sort()[Math.floor(wrs.length / 2)] : 0;
        const pctProf = rets.filter((r) => r > 0).length / rets.length;
        const avgTrades = recs.reduce((s, r) => s + r.trades, 0) / recs.length;
        const avgTpd = avgTrades / 20;
        console.log(
          `Summary: medWR=${(medWR * 100).toFixed(1)}% minWR=${(minWR * 100).toFixed(1)}% pctProf=${(pctProf * 100).toFixed(0)}% avgTrades=${avgTrades.toFixed(1)} avgTpd=${avgTpd.toFixed(2)}`,
        );
        const passes =
          medWR >= 0.8 && minWR >= 0.75 && pctProf >= 0.8 && avgTpd >= 0.7;
        console.log(
          `${passes ? "★ PASSES" : "drops"} (medWR≥80, minWR≥75, pctProf≥80, tpd≥0.7)`,
        );
      }
    },
  );
});
