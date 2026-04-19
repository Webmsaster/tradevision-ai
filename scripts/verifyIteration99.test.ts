/**
 * Iter 99: BTC trend-strength regime filter.
 *
 * iter98 exposed that BTC fade-mode loses money in strongly-trending
 * windows (w1/w5/w7 were clearly trending periods). Fade only works in
 * range-bound/mean-reverting regimes.
 *
 * Solution: add a regime filter. Compute rolling trend strength
 * (normalized slope of 240-bar close SMA). Only trade when strength
 * below threshold. Two variants:
 *   - Hard gate: skip if |slope| > X
 *   - Direction-conditional: allow short in downtrend, long in uptrend
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
  trendLookback: number; // bars for trend-strength
  maxAbsSlopeBps: number; // max slope (bps per bar) to allow trade, 0 = disable
}

const CANDIDATES: Cfg[] = [
  {
    name: "baseline (no trend filter)",
    lookback: 48,
    volMult: 2.5,
    priceZ: 1.0,
    tp1Pct: 0.0015,
    tp2Pct: 0.018,
    stopPct: 0.03,
    holdBars: 6,
    mode: "fade",
    trendLookback: 0,
    maxAbsSlopeBps: 0,
  },
  {
    name: "strong-trend filter: |slope|<5bps/bar (range-only)",
    lookback: 48,
    volMult: 2.5,
    priceZ: 1.0,
    tp1Pct: 0.0015,
    tp2Pct: 0.018,
    stopPct: 0.03,
    holdBars: 6,
    mode: "fade",
    trendLookback: 240, // 10 days on 1h
    maxAbsSlopeBps: 5,
  },
  {
    name: "medium trend filter: |slope|<10bps/bar",
    lookback: 48,
    volMult: 2.5,
    priceZ: 1.0,
    tp1Pct: 0.0015,
    tp2Pct: 0.018,
    stopPct: 0.03,
    holdBars: 6,
    mode: "fade",
    trendLookback: 240,
    maxAbsSlopeBps: 10,
  },
  {
    name: "loose trend filter: |slope|<15bps/bar",
    lookback: 48,
    volMult: 2.5,
    priceZ: 1.0,
    tp1Pct: 0.0015,
    tp2Pct: 0.018,
    stopPct: 0.03,
    holdBars: 6,
    mode: "fade",
    trendLookback: 240,
    maxAbsSlopeBps: 15,
  },
  {
    name: "shorter trend lookback 120: |slope|<10bps",
    lookback: 48,
    volMult: 2.5,
    priceZ: 1.0,
    tp1Pct: 0.0015,
    tp2Pct: 0.018,
    stopPct: 0.03,
    holdBars: 6,
    mode: "fade",
    trendLookback: 120,
    maxAbsSlopeBps: 10,
  },
];

function median(a: number[]) {
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

/** Linear regression slope per bar, normalized by mean price (bps/bar). */
function trendStrengthBps(closes: number[]): number {
  const n = closes.length;
  if (n < 10) return 0;
  const meanP = closes.reduce((s, v) => s + v, 0) / n;
  const meanX = (n - 1) / 2;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (closes[i] - meanP);
    den += (i - meanX) * (i - meanX);
  }
  return (num / den / meanP) * 10000; // bps per bar
}

interface Trade {
  pnl: number;
}

function run(candles: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  for (
    let i = Math.max(cfg.lookback, cfg.trendLookback);
    i < candles.length - cfg.holdBars - 1;
    i++
  ) {
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

    // Trend-strength filter
    if (cfg.maxAbsSlopeBps > 0 && cfg.trendLookback > 0) {
      const tClose = candles
        .slice(i - cfg.trendLookback, i)
        .map((c) => c.close);
      const strength = Math.abs(trendStrengthBps(tClose));
      if (strength > cfg.maxAbsSlopeBps) continue;
    }

    const sma48 = smaLast(
      w.map((c) => c.close),
      Math.min(48, w.length),
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
      holdingHours: l2B - (i + 1),
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: tp1Bar - (i + 1),
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

describe("iter 99 — trend-strength filter on BTC multi-year", () => {
  it(
    "test 5 trend-filter variants on 3.4y BTC",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 99: BTC trend-strength filter ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 30000,
      });
      const days = btc.length / 24;
      console.log(
        `BTC 1h: ${days.toFixed(0)} days = ${(days / 365).toFixed(2)} years`,
      );

      const barsPerWindow = Math.floor(btc.length / 8);

      for (const cfg of CANDIDATES) {
        console.log(`\n── ${cfg.name} ──`);
        const full = run(btc, cfg);
        const fullW = full.filter((t) => t.pnl > 0).length;
        const fullRet = full.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
        console.log(
          `full: n=${full.length} WR=${((fullW / Math.max(1, full.length)) * 100).toFixed(1)}% cumRet=${(fullRet * 100).toFixed(1)}%`,
        );
        const recs: Array<{ wr: number; ret: number }> = [];
        for (let w = 0; w < 8; w++) {
          const start = w * barsPerWindow;
          const slice = btc.slice(start, start + barsPerWindow);
          const r = run(slice, cfg);
          const wr =
            r.length > 0 ? r.filter((t) => t.pnl > 0).length / r.length : 0;
          const ret = r.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
          recs.push({ wr, ret });
        }
        const wrs = recs
          .filter((r) => r.wr > 0)
          .map((r) => r.wr)
          .sort();
        const medWR = wrs[Math.floor(wrs.length / 2)] ?? 0;
        const minWR = wrs[0] ?? 0;
        const pctProf = recs.filter((r) => r.ret > 0).length / recs.length;
        const minRet = Math.min(...recs.map((r) => r.ret));
        console.log(
          `Summary: medWR=${(medWR * 100).toFixed(1)}% minWR=${(minWR * 100).toFixed(1)}% pctProf=${(pctProf * 100).toFixed(0)}% minRet=${(minRet * 100).toFixed(1)}%`,
        );
      }
    },
  );
});
