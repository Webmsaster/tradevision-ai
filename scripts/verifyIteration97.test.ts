/**
 * Iter 97: BTC 5m signal with 15m trend-filter (multi-TF).
 *
 * 5m bars give ~4x more potential signals than 15m. If we gate 5m signals
 * through a 15m trend filter (only trade when 15m is aligned against SMA
 * in trade direction), quality might hold up while frequency explodes.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Cfg {
  lookback: number;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number; // on 5m
}
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

function findContaining(bar5m: Candle, candles15m: Candle[]): Candle | null {
  for (let i = candles15m.length - 1; i >= 0; i--) {
    const c = candles15m[i];
    if (c.openTime <= bar5m.openTime && bar5m.openTime <= c.closeTime) return c;
  }
  return null;
}

interface Trade {
  pnl: number;
}

function run(candles5m: Candle[], candles15m: Candle[], cfg: Cfg): Trade[] {
  const trades: Trade[] = [];
  for (let i = cfg.lookback; i < candles5m.length - cfg.holdBars - 1; i++) {
    const cur = candles5m[i];
    const prev = candles5m[i - 1];
    if (prev.close <= 0) continue;
    const w = candles5m.slice(i - cfg.lookback, i);
    const mv = median(w.map((c) => c.volume));
    if (mv <= 0) continue;
    const vZ = cur.volume / mv;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(w.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;
    const direction: "long" | "short" = ret > 0 ? "short" : "long"; // fade
    // 15m trend filter: 15m bar containing this 5m bar must be aligned
    const bar15m = findContaining(cur, candles15m);
    if (!bar15m) continue;
    const idx15 = candles15m.indexOf(bar15m);
    if (idx15 < 48) continue;
    const sma15 = smaLast(
      candles15m.slice(idx15 - 48, idx15).map((c) => c.close),
      48,
    );
    const aligned15 = bar15m.close > sma15;
    if (direction === "long" && !aligned15) continue;
    if (direction === "short" && aligned15) continue;
    // 5m micro-exhaustion
    const p = candles5m[i - 1];
    const b = candles5m[i - 2];
    if (!p || !b) continue;
    const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
    if (!sameDir) continue;
    if (new Date(cur.openTime).getUTCHours() === 0) continue;
    const eb = candles5m[i + 1];
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
    const mx = Math.min(i + 1 + cfg.holdBars, candles5m.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles5m[mx].close;
    let l2B = mx;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles5m[j];
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
      holdingHours: (l2B - (i + 1)) / 12, // 5m bars → /12 for hours
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: (tp1Bar - (i + 1)) / 12,
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

describe("iter 97 — BTC 5m + 15m filter", () => {
  it("multi-TF BTC sweep", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 97: BTC 5m + 15m filter ===");
    const btc5m = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "5m",
      targetCount: 10000,
    });
    const btc15m = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 4000,
    });
    const days = btc5m.length / 288;
    const barsPerWindow = 20 * 288;
    const numWin = Math.floor(btc5m.length / barsPerWindow);
    console.log(
      `BTC 5m: ${btc5m.length} bars, ${days.toFixed(0)} days, ${numWin} windows`,
    );

    const grid: Cfg[] = [];
    for (const lb of [48, 96]) {
      for (const vm of [2.0, 2.5, 3.0]) {
        for (const pZ of [1.5, 2.0]) {
          for (const tp1 of [0.001, 0.0015, 0.002]) {
            for (const tp2Mult of [6, 10]) {
              for (const stop of [0.02, 0.03]) {
                for (const hold of [24, 48, 72]) {
                  grid.push({
                    lookback: lb,
                    volMult: vm,
                    priceZ: pZ,
                    tp1Pct: tp1,
                    tp2Pct: tp1 * tp2Mult,
                    stopPct: stop,
                    holdBars: hold,
                  });
                }
              }
            }
          }
        }
      }
    }
    console.log(`Grid: ${grid.length}`);

    interface Row {
      cfg: Cfg;
      n: number;
      wr: number;
      ret: number;
      tpd: number;
      medWR: number;
      minWR: number;
      pctProf: number;
      minRet: number;
    }
    const rows: Row[] = [];
    for (const cfg of grid) {
      const trades = run(btc5m, btc15m, cfg);
      const n = trades.length;
      if (n < 30) continue;
      const wr = trades.filter((t) => t.pnl > 0).length / n;
      if (wr < 0.95) continue;
      const ret = trades.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
      if (ret < 0.03) continue;
      const tpd = n / days;
      // per-window
      const perWR: number[] = [];
      const perRet: number[] = [];
      for (let w = 0; w < numWin; w++) {
        const start = w * barsPerWindow;
        const slice5 = btc5m.slice(start, start + barsPerWindow);
        const slice15Start = Math.floor(start / 3);
        const slice15End = Math.floor((start + barsPerWindow) / 3);
        const slice15 = btc15m.slice(slice15Start, slice15End);
        const r = run(slice5, slice15, cfg);
        if (r.length > 0)
          perWR.push(r.filter((t) => t.pnl > 0).length / r.length);
        perRet.push(r.reduce((a, t) => a * (1 + t.pnl), 1) - 1);
      }
      const sortedWR = [...perWR].sort();
      const medWR = sortedWR[Math.floor(sortedWR.length / 2)] ?? 0;
      const minWR = sortedWR[0] ?? 0;
      const pctProf = perRet.filter((r) => r > 0).length / perRet.length;
      const minRet = Math.min(...perRet);
      rows.push({ cfg, n, wr, ret, tpd, medWR, minWR, pctProf, minRet });
    }
    console.log(`${rows.length} configs pass initial (WR≥95, ret≥3%, n≥30)`);

    const strict = rows.filter(
      (r) => r.pctProf >= 1.0 && r.medWR >= 0.95 && r.minWR >= 0.9,
    );
    console.log(
      `${strict.length} pass strict (pctProf=100, medWR≥95, minWR≥90)`,
    );

    console.log(
      "\n── Top picks ──\n" +
        "lb".padStart(4) +
        "vm".padStart(5) +
        "pZ".padStart(5) +
        "tp1/tp2".padStart(14) +
        "stop".padStart(6) +
        "h".padStart(4) +
        "n".padStart(5) +
        "tpd".padStart(6) +
        "WR%".padStart(7) +
        "ret%".padStart(8) +
        "medWR".padStart(7) +
        "minWR".padStart(7) +
        "%prof".padStart(7),
    );
    const sorted = (strict.length > 0 ? strict : rows).sort(
      (a, b) =>
        b.wr * b.pctProf * b.ret * Math.sqrt(b.tpd) -
        a.wr * a.pctProf * a.ret * Math.sqrt(a.tpd),
    );
    for (const r of sorted.slice(0, 20)) {
      const c = r.cfg;
      console.log(
        c.lookback.toString().padStart(4) +
          c.volMult.toFixed(1).padStart(5) +
          c.priceZ.toFixed(1).padStart(5) +
          `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
            14,
          ) +
          (c.stopPct * 100).toFixed(1).padStart(6) +
          c.holdBars.toString().padStart(4) +
          r.n.toString().padStart(5) +
          r.tpd.toFixed(2).padStart(6) +
          (r.wr * 100).toFixed(1).padStart(7) +
          (r.ret * 100).toFixed(1).padStart(8) +
          (r.medWR * 100).toFixed(1).padStart(7) +
          (r.minWR * 100).toFixed(1).padStart(7) +
          (r.pctProf * 100).toFixed(0).padStart(7),
      );
    }
  });
});
