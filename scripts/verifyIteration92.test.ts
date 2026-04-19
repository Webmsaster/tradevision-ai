/**
 * Iter 92: BTC frequency boost — looser triggers, tighter TPs.
 *
 * iter91 BTC config (vm 2.0 / pZ 1.8 / tp 0.15/1.2 / stop 2%) gives
 * only 33 trades in 104 days = 2.2/week. User wants more trades/day.
 *
 * Loosen: vm 1.0-1.8, pZ 0.8-1.5. Tighten tps: tp1 0.05-0.15%.
 * Target: ≥0.7 trades/day (~70+ trades total) with WR ≥80% + ret ≥2%.
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
  pf: number;
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
  const wr = n > 0 ? wins / n : 0;
  const ret = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const grossW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : n > 0 ? 999 : 0;
  return { n, wr, ret, pf };
}

describe("iter 92 — BTC loose-sweep for higher frequency", () => {
  it(
    "find config with ≥0.7 trades/day + WR≥80",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 92: BTC loose-sweep ===");
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 10000,
      });
      const days = btc.length / 96;
      console.log(`BTC: ${btc.length} bars, ${days.toFixed(0)} days`);

      const grid: Cfg[] = [];
      for (const mode of ["fade", "momentum"] as const) {
        for (const vm of [1.0, 1.2, 1.5, 1.8]) {
          for (const pZ of [0.8, 1.0, 1.2, 1.5]) {
            for (const tp1 of [0.0005, 0.001, 0.0015, 0.002]) {
              for (const tp2Mult of [5, 8, 12]) {
                for (const stop of [0.005, 0.008, 0.012, 0.02]) {
                  for (const hold of [8, 16, 24]) {
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
        tradesPerDay: number;
      }
      const rows: Row[] = [];
      for (const cfg of grid) {
        const r = run(btc, cfg);
        const tpd = r.n / days;
        if (tpd < 0.7) continue;
        if (r.wr < 0.8) continue;
        if (r.ret < 0.02) continue;
        rows.push({ cfg, r, tradesPerDay: tpd });
      }
      console.log(
        `${rows.length} configs pass (≥0.7 trades/day + WR≥80 + ret≥+2%)`,
      );

      console.log(
        "\n── Top 25 by (WR × ret × sqrt(n)) — quality+frequency balance ──\n" +
          "mode".padEnd(10) +
          "vm".padStart(5) +
          "pZ".padStart(5) +
          "tp1/tp2".padStart(12) +
          "stop%".padStart(7) +
          "hold".padStart(5) +
          "n".padStart(5) +
          "tpd".padStart(6) +
          "WR%".padStart(7) +
          "ret%".padStart(9) +
          "PF".padStart(6),
      );
      const sorted = rows.sort(
        (a, b) =>
          b.r.wr * b.r.ret * Math.sqrt(b.r.n) -
          a.r.wr * a.r.ret * Math.sqrt(a.r.n),
      );
      for (const row of sorted.slice(0, 25)) {
        const c = row.cfg;
        const r = row.r;
        console.log(
          c.mode.padEnd(10) +
            c.volMult.toFixed(1).padStart(5) +
            c.priceZ.toFixed(1).padStart(5) +
            `${(c.tp1Pct * 100).toFixed(2)}/${(c.tp2Pct * 100).toFixed(2)}`.padStart(
              12,
            ) +
            (c.stopPct * 100).toFixed(2).padStart(7) +
            c.holdBars.toString().padStart(5) +
            r.n.toString().padStart(5) +
            row.tradesPerDay.toFixed(2).padStart(6) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.ret * 100).toFixed(1).padStart(9) +
            r.pf.toFixed(2).padStart(6),
        );
      }
    },
  );
});
