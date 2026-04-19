/**
 * Iter 94: BTC Ultra-High-WR sweep — target WR ≥ 97%.
 *
 * User wants "fast keine losses". Math: with tp1 = 5-15bps and stop =
 * 200-400bps, ratio 1:20-80, stops are rarely hit. If win rate at tp1
 * is 97%+, users see almost no negative trades.
 *
 * Trade-off: profits per trade are tiny (10-30bps avg), but trades
 * compound. Must check multi-period: does ultra-tight tp1 still
 * stay profitable across disjoint windows after costs?
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
    returns.push(0.5 * leg1 + 0.5 * leg2);
    i = l2B;
  }
  const n = returns.length;
  const wins = returns.filter((r) => r > 0).length;
  const wr = n > 0 ? wins / n : 0;
  const ret = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  return { n, wr, ret };
}

describe("iter 94 — BTC ultra-high-WR sweep", () => {
  it(
    "find configs with WR ≥ 97% + positive multi-period ret",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 94: BTC ultra-high-WR sweep ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 10000,
      });
      const days = btc.length / 96;
      const barsPerWindow = 20 * 96;
      const numWindows = Math.floor(btc.length / barsPerWindow);
      console.log(
        `BTC: ${btc.length} bars, ${days.toFixed(0)} days, ${numWindows} × 20-day windows`,
      );

      const grid: Cfg[] = [];
      for (const mode of ["fade", "momentum"] as const) {
        for (const vm of [1.5, 2.0, 2.5, 3.0]) {
          for (const pZ of [1.0, 1.5, 2.0]) {
            for (const tp1 of [0.0005, 0.0008, 0.001, 0.0012, 0.0015]) {
              for (const tp2Mult of [5, 8, 12, 20]) {
                for (const stop of [0.02, 0.03, 0.04]) {
                  for (const hold of [16, 24]) {
                    grid.push({
                      lookback: 48,
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
      console.log(`Grid: ${grid.length}`);

      interface Row {
        cfg: Cfg;
        r: RR;
        tpd: number;
        // per-window results
        perWin: Array<{ trades: number; wr: number; ret: number }>;
        pctProf: number;
        minWinRet: number;
        medWR: number;
      }
      const rows: Row[] = [];
      for (const cfg of grid) {
        const r = run(btc, cfg);
        if (r.wr < 0.97) continue;
        if (r.n < 30) continue;
        if (r.ret < 0.005) continue;
        // multi-period
        const perWin: Row["perWin"] = [];
        for (let w = 0; w < numWindows; w++) {
          const start = w * barsPerWindow;
          const slice = btc.slice(start, start + barsPerWindow);
          const rr = run(slice, cfg);
          const wr = rr.n > 0 ? rr.wr : 0;
          perWin.push({ trades: rr.n, wr, ret: rr.ret });
        }
        const pctProf = perWin.filter((x) => x.ret > 0).length / perWin.length;
        const minWinRet = Math.min(...perWin.map((x) => x.ret));
        const wrs = perWin
          .filter((x) => x.trades > 0)
          .map((x) => x.wr)
          .sort();
        const medWR = wrs.length > 0 ? wrs[Math.floor(wrs.length / 2)] : 0;
        rows.push({
          cfg,
          r,
          tpd: r.n / days,
          perWin,
          pctProf,
          minWinRet,
          medWR,
        });
      }
      console.log(
        `\n${rows.length} configs with WR≥97 (full-hist) + ret≥0.5% + n≥30`,
      );

      const passing = rows.filter((r) => r.pctProf >= 0.8 && r.medWR >= 0.95);
      console.log(
        `${passing.length} also pass multi-period (pctProf≥80 AND medWR≥95 per window)`,
      );

      console.log(
        "\n── Top by (WR × pctProf × ret × sqrt(n)) ──\n" +
          "mode".padEnd(10) +
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
          "%prof".padStart(7) +
          "minRet".padStart(8),
      );
      const sorted = (passing.length > 0 ? passing : rows).sort(
        (a, b) =>
          b.r.wr * b.pctProf * b.r.ret * Math.sqrt(b.r.n) -
          a.r.wr * a.pctProf * a.r.ret * Math.sqrt(a.r.n),
      );
      for (const row of sorted.slice(0, 20)) {
        const c = row.cfg;
        const r = row.r;
        console.log(
          c.mode.padEnd(10) +
            c.volMult.toFixed(1).padStart(5) +
            c.priceZ.toFixed(1).padStart(5) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              14,
            ) +
            (c.stopPct * 100).toFixed(1).padStart(6) +
            c.holdBars.toString().padStart(4) +
            r.n.toString().padStart(5) +
            row.tpd.toFixed(2).padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(8) +
            (row.medWR * 100).toFixed(1).padStart(7) +
            (row.pctProf * 100).toFixed(0).padStart(7) +
            (row.minWinRet * 100).toFixed(1).padStart(8),
        );
      }
    },
  );
});
