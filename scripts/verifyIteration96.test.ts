/**
 * Iter 96: BTC fine-sweep between iter91 (conservative, 0.30 tpd) and
 * iter94 (balanced, 0.45 tpd) — target 1-2 trades/day at WR ≥ 95% with
 * multi-period pctProf ≥ 80%.
 *
 * Expanded grid: shorter lookback, both modes, tighter stop options,
 * more tp ratios.
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
  holdBars: number;
  mode: "fade" | "momentum";
}
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
interface RR {
  n: number;
  wr: number;
  ret: number;
}
function run(candles: Candle[], cfg: Cfg): RR {
  const returns: number[] = [];
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
      w.slice(-Math.min(48, w.length)).map((c) => c.close),
      Math.min(48, w.length),
    );
    const aligned = cur.close > sma48;
    if (direction === "long" && !aligned) continue;
    if (direction === "short" && aligned) continue;
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) continue;
    if (cfg.mode === "momentum") {
      const pb = direction === "long" ? p.close < b.close : p.close > b.close;
      if (!pb) continue;
    } else {
      const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
      if (!sameDir) continue;
    }
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
    returns.push(0.5 * leg1 + 0.5 * leg2);
    i = l2B;
  }
  const n = returns.length;
  const wins = returns.filter((r) => r > 0).length;
  return {
    n,
    wr: n > 0 ? wins / n : 0,
    ret: returns.reduce((a, r) => a * (1 + r), 1) - 1,
  };
}

describe("iter 96 — BTC fine-sweep (1-2 tpd, WR≥95, multi-period)", () => {
  it("find balanced BTC config", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 96: BTC fine-sweep ===");
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 10000,
    });
    const days = btc.length / 96;
    const barsPerWindow = 20 * 96;
    const numWin = Math.floor(btc.length / barsPerWindow);
    console.log(`BTC: ${days.toFixed(0)} days, ${numWin} × 20d windows`);

    const grid: Cfg[] = [];
    for (const mode of ["fade", "momentum"] as const) {
      for (const lb of [24, 48]) {
        for (const vm of [1.8, 2.0, 2.2, 2.5, 2.8]) {
          for (const pZ of [1.0, 1.2, 1.5]) {
            for (const tp1 of [0.001, 0.0012, 0.0015, 0.002]) {
              for (const tp2Mult of [6, 10, 15]) {
                for (const stop of [0.025, 0.03, 0.04]) {
                  for (const hold of [12, 16, 24]) {
                    grid.push({
                      lookback: lb,
                      volMult: vm,
                      priceZ: pZ,
                      tp1Pct: tp1,
                      tp2Pct: tp1 * tp2Mult,
                      stopPct: stop,
                      holdBars: hold,
                      mode,
                    });
                  }
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
      const r = run(btc, cfg);
      const tpd = r.n / days;
      if (tpd < 0.8 || tpd > 3) continue; // focus on 1-3 tpd
      if (r.wr < 0.95) continue;
      if (r.ret < 0.03) continue;
      // per-window
      const perWR: number[] = [];
      const perRet: number[] = [];
      for (let w = 0; w < numWin; w++) {
        const start = w * barsPerWindow;
        const slice = btc.slice(start, start + barsPerWindow);
        const rr = run(slice, cfg);
        if (rr.n > 0) perWR.push(rr.wr);
        perRet.push(rr.ret);
      }
      const sortedWR = [...perWR].sort();
      const medWR = sortedWR[Math.floor(sortedWR.length / 2)] ?? 0;
      const minWR = sortedWR[0] ?? 0;
      const pctProf = perRet.filter((r) => r > 0).length / perRet.length;
      const minRet = Math.min(...perRet);
      rows.push({ cfg, ...r, tpd, medWR, minWR, pctProf, minRet });
    }
    console.log(
      `${rows.length} configs pass initial (WR≥95, ret≥3%, 0.8-3 tpd)`,
    );

    const strict = rows.filter(
      (r) => r.pctProf >= 0.8 && r.medWR >= 0.95 && r.minWR >= 0.9,
    );
    console.log(
      `${strict.length} pass strict (pctProf≥80, medWR≥95, minWR≥90)`,
    );

    console.log(
      "\n── Top by (WR × pctProf × ret × sqrt(tpd)) ──\n" +
        "mode".padEnd(10) +
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
        "%prof".padStart(7) +
        "minRet".padStart(8),
    );
    const sorted = (strict.length > 0 ? strict : rows).sort(
      (a, b) =>
        b.wr * b.pctProf * b.ret * Math.sqrt(b.tpd) -
        a.wr * a.pctProf * a.ret * Math.sqrt(a.tpd),
    );
    for (const r of sorted.slice(0, 25)) {
      const c = r.cfg;
      console.log(
        c.mode.padEnd(10) +
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
          (r.pctProf * 100).toFixed(0).padStart(7) +
          (r.minRet * 100).toFixed(1).padStart(8),
      );
    }
  });
});
