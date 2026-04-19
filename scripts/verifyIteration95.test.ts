/**
 * Iter 95: Ultra-high-WR across full 16-asset portfolio.
 *
 * iter94 found BTC config with WR 97.9% + 100% monthly profitable via
 * tight tp1 + wide stop. Does the same idea scale to the full basket?
 *
 * Test: tp1 0.1-0.2%, stop 3-4%, strict trigger vm 2.0-3.0, pZ 1.0-1.8.
 * Portfolio aggregate WR + per-month multi-period check.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { HF_DAYTRADING_ASSETS } from "../src/utils/hfDaytrading";
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

describe("iter 95 — portfolio ultra-high-WR sweep", () => {
  it(
    "find config with WR ≥ 97% across 16-asset portfolio + multi-period",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 95: portfolio ultra-high-WR ===");
      const data: Record<string, Candle[]> = {};
      const avail: string[] = [];
      for (const s of HF_DAYTRADING_ASSETS) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "15m",
            targetCount: 10000,
          });
          if (data[s].length >= 2000) avail.push(s);
        } catch {
          // skip
        }
      }
      const barMax = Math.max(...avail.map((s) => data[s].length));
      const days = barMax / 96;
      const barsPerWindow = 20 * 96;
      const numWin = Math.floor(barMax / barsPerWindow);
      console.log(
        `${avail.length} assets, ${days.toFixed(0)} days, ${numWin} × 20d windows`,
      );

      // Candidate configs that scored ≥97% WR on BTC in iter94
      const grid: Cfg[] = [];
      for (const vm of [2.0, 2.5, 3.0]) {
        for (const pZ of [1.0, 1.5, 1.8]) {
          for (const tp1 of [0.001, 0.0015, 0.002]) {
            for (const tp2Mult of [6, 10]) {
              for (const stop of [0.025, 0.03, 0.04]) {
                for (const hold of [16, 24]) {
                  grid.push({
                    lookback: 48,
                    volMult: vm,
                    priceZ: pZ,
                    tp1Pct: tp1,
                    tp2Pct: tp1 * tp2Mult,
                    stopPct: stop,
                    holdBars: hold,
                    mode: "fade",
                  });
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
        pctProf: number;
        minWR: number;
        minRet: number;
      }
      const rows: Row[] = [];
      for (const cfg of grid) {
        // Full portfolio aggregate
        let n = 0,
          w = 0,
          sl = 0;
        for (const s of avail) {
          const r = run(data[s], cfg);
          n += r.length;
          w += r.filter((t) => t.pnl > 0).length;
          for (const t of r) sl += Math.log(1 + t.pnl);
        }
        const wr = n > 0 ? w / n : 0;
        const ret = Math.exp(sl) - 1;
        if (wr < 0.95 || n < 100 || ret < 0.05) continue;
        // Multi-period
        const perWR: number[] = [];
        const perRet: number[] = [];
        for (let idx = 0; idx < numWin; idx++) {
          const start = idx * barsPerWindow;
          let wn = 0,
            ww = 0,
            wsl = 0;
          for (const s of avail) {
            const slice = data[s].slice(start, start + barsPerWindow);
            if (slice.length < 100) continue;
            const r = run(slice, cfg);
            wn += r.length;
            ww += r.filter((t) => t.pnl > 0).length;
            for (const t of r) wsl += Math.log(1 + t.pnl);
          }
          if (wn > 0) perWR.push(ww / wn);
          perRet.push(Math.exp(wsl) - 1);
        }
        const sortedWR = [...perWR].sort((a, b) => a - b);
        const medWR = sortedWR[Math.floor(sortedWR.length / 2)] ?? 0;
        const minWR = sortedWR[0] ?? 0;
        const pctProf = perRet.filter((r) => r > 0).length / perRet.length;
        const minRet = Math.min(...perRet);
        rows.push({
          cfg,
          n,
          wr,
          ret,
          tpd: n / days,
          medWR,
          pctProf,
          minWR,
          minRet,
        });
      }
      console.log(
        `${rows.length} configs passed initial (WR≥95, n≥100, ret≥5%)`,
      );

      const strict = rows.filter(
        (r) => r.pctProf >= 1.0 && r.medWR >= 0.95 && r.minWR >= 0.9,
      );
      console.log(
        `${strict.length} also pass strict (pctProf=100, medWR≥95, minWR≥90)`,
      );

      console.log(
        "\n── Top by (WR × pctProf × ret × sqrt(n)) ──\n" +
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
          b.wr * b.pctProf * b.ret * Math.sqrt(b.n) -
          a.wr * a.pctProf * a.ret * Math.sqrt(a.n),
      );
      for (const row of sorted.slice(0, 20)) {
        const c = row.cfg;
        console.log(
          c.volMult.toFixed(1).padStart(5) +
            c.priceZ.toFixed(1).padStart(5) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              14,
            ) +
            (c.stopPct * 100).toFixed(1).padStart(6) +
            c.holdBars.toString().padStart(4) +
            row.n.toString().padStart(5) +
            row.tpd.toFixed(2).padStart(6) +
            (row.wr * 100).toFixed(1).padStart(7) +
            (row.ret * 100).toFixed(1).padStart(8) +
            (row.medWR * 100).toFixed(1).padStart(7) +
            (row.minWR * 100).toFixed(1).padStart(7) +
            (row.pctProf * 100).toFixed(0).padStart(7) +
            (row.minRet * 100).toFixed(1).padStart(8),
        );
      }
    },
  );
});
