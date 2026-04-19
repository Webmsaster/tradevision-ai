/**
 * Iter 106: BTC-only 1000-day massive sweep.
 *
 * Focus: find ANY config that's profitable on BTC over 2.7+ years
 * with high trade frequency. Relaxed criteria:
 *   - cumRet > 0
 *   - full-hist WR ≥ 75%
 *   - ≥ 50% of 10 disjoint 100-day windows profitable
 *   - ≥ 0.5 trades/day (some daytrading frequency)
 *
 * Bigger grid: vm 1.2-3.5, pZ 0.8-2.5, tp1 0.0008-0.005, stop 0.008-0.05.
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
  htfTrendEnabled: boolean;
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
    if (cfg.htfTrendEnabled) {
      const sma48 = smaLast(
        w.map((c) => c.close),
        Math.min(48, w.length),
      );
      const aligned = cur.close > sma48;
      if (direction === "long" && !aligned) continue;
      if (direction === "short" && aligned) continue;
    }
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

describe("iter 106 — BTC 1000-day massive search", () => {
  it(
    "find any BTC config profitable over 1000+ days with daytrading freq",
    { timeout: 1_800_000 },
    async () => {
      console.log("\n=== ITER 106: BTC 1000-day massive search ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 24000,
      });
      const days = btc.length / 24;
      const barsPerWindow = Math.floor(btc.length / 10);
      console.log(`BTC: ${btc.length} bars = ${days.toFixed(0)} days`);

      const grid: Cfg[] = [];
      for (const mode of ["fade", "momentum"] as const) {
        for (const vm of [1.2, 1.5, 2.0, 2.5, 3.0]) {
          for (const pZ of [0.8, 1.2, 1.5, 2.0]) {
            for (const tp1 of [0.001, 0.0015, 0.002, 0.003, 0.005]) {
              for (const tp2Mult of [3, 6, 12]) {
                for (const stop of [0.01, 0.02, 0.03, 0.05]) {
                  for (const hold of [6, 12, 24]) {
                    for (const htfTrend of [true, false]) {
                      grid.push({
                        lookback: 48,
                        volMult: vm,
                        priceZ: pZ,
                        tp1Pct: tp1,
                        tp2Pct: tp1 * tp2Mult,
                        stopPct: stop,
                        holdBars: hold,
                        mode,
                        htfTrendEnabled: htfTrend,
                      });
                    }
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
        tpd: number;
        pctProf: number;
        minRet: number;
        medWR: number;
      }
      const results: Row[] = [];
      for (const cfg of grid) {
        const trades = run(btc, cfg);
        const n = trades.length;
        if (n < 100) continue;
        const w = trades.filter((t) => t.pnl > 0).length;
        const wr = w / n;
        const ret = trades.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
        const tpd = n / days;
        if (wr < 0.75 || ret <= 0 || tpd < 0.5) continue;
        // multi-period
        const perWR: number[] = [];
        const perRet: number[] = [];
        for (let win = 0; win < 10; win++) {
          const start = win * barsPerWindow;
          const slice = btc.slice(start, start + barsPerWindow);
          const t = run(slice, cfg);
          if (t.length > 0)
            perWR.push(t.filter((x) => x.pnl > 0).length / t.length);
          perRet.push(t.reduce((a, x) => a * (1 + x.pnl), 1) - 1);
        }
        const pctProf = perRet.filter((r) => r > 0).length / perRet.length;
        if (pctProf < 0.5) continue;
        const minRet = Math.min(...perRet);
        const sortedWR = [...perWR].sort();
        const medWR = sortedWR[Math.floor(sortedWR.length / 2)] ?? 0;
        results.push({ cfg, n, wr, ret, tpd, pctProf, minRet, medWR });
      }
      console.log(
        `\n${results.length} BTC configs pass (ret>0, WR≥75, pctProf≥50, tpd≥0.5)`,
      );
      if (results.length === 0) {
        console.log(
          "\n✗ NO BTC config survives 1000-day multi-period validation\n" +
            "  with daytrading frequency + positive expectancy.",
        );
        return;
      }
      console.log(
        "\n── Top 20 by (ret × pctProf × sqrt(tpd)) ──\n" +
          "mode".padEnd(10) +
          "vm".padStart(5) +
          "pZ".padStart(5) +
          "tp1/tp2".padStart(14) +
          "stop".padStart(6) +
          "h".padStart(4) +
          "htf".padStart(4) +
          "n".padStart(6) +
          "tpd".padStart(6) +
          "WR%".padStart(7) +
          "ret%".padStart(9) +
          "medWR".padStart(7) +
          "%prof".padStart(7) +
          "minRet".padStart(8),
      );
      const sorted = results.sort(
        (a, b) =>
          b.ret * b.pctProf * Math.sqrt(b.tpd) -
          a.ret * a.pctProf * Math.sqrt(a.tpd),
      );
      for (const r of sorted.slice(0, 20)) {
        const c = r.cfg;
        console.log(
          c.mode.padEnd(10) +
            c.volMult.toFixed(1).padStart(5) +
            c.priceZ.toFixed(1).padStart(5) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              14,
            ) +
            (c.stopPct * 100).toFixed(1).padStart(6) +
            c.holdBars.toString().padStart(4) +
            (c.htfTrendEnabled ? "Y" : "N").padStart(4) +
            r.n.toString().padStart(6) +
            r.tpd.toFixed(2).padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(9) +
            (r.medWR * 100).toFixed(1).padStart(7) +
            (r.pctProf * 100).toFixed(0).padStart(7) +
            (r.minRet * 100).toFixed(1).padStart(8),
        );
      }
    },
  );
});
