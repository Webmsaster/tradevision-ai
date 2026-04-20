/**
 * Iter 168 — show the FULL daytrade frontier on BTC 15m.
 *
 * iter167: 0/672 triggers hit BOTH freq ≥ 2/day AND raw mean ≥ 0.08%.
 *
 * This iter loosens filters to map reality:
 *   A) Best raw mean at freq ≥ 2/day (what frequency-at-cost-of-mean looks like)
 *   B) Best freq at raw mean ≥ 0.05% (mean-at-cost-of-freq)
 *   C) Full distribution: 2D frequency × mean histogram
 *   D) Best FTMO pass rate regardless of freq/mean constraints
 *
 * Goal: show honestly what's achievable — maybe ~1/day is the realistic ceiling
 * for positive-mean BTC daytrade, not 2-3/day.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let g = 0,
    l = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l += -d;
  }
  g /= len;
  l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gi = d > 0 ? d : 0;
    const li = d < 0 ? -d : 0;
    g = (g * (len - 1) + gi) / len;
    l = (l * (len - 1) + li) / len;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function emaSeries(closes: number[], len: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < len) return out;
  const k = 2 / (len + 1);
  let ema = closes.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[len - 1] = ema;
  for (let i = len; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

type Kind =
  | "brk_hi"
  | "brk_lo_S"
  | "pullback"
  | "nDown"
  | "nUp_S"
  | "rsi_os"
  | "rsi_ob_S";
interface Cfg {
  kind: Kind;
  p1: number;
  p2: number;
  tp: number;
  stop: number;
  hold: number;
  dir: "long" | "short";
}

function fires(
  c: Candle[],
  closes: number[],
  rsi: number[],
  ema50: number[],
  i: number,
  cfg: Cfg,
): boolean {
  switch (cfg.kind) {
    case "rsi_os":
      return rsi[i] <= cfg.p2;
    case "rsi_ob_S":
      return rsi[i] >= cfg.p2;
    case "brk_hi": {
      if (i < cfg.p1) return false;
      let hi = -Infinity;
      for (let k = i - cfg.p1; k < i; k++) if (c[k].high > hi) hi = c[k].high;
      return c[i].close > hi;
    }
    case "brk_lo_S": {
      if (i < cfg.p1) return false;
      let lo = Infinity;
      for (let k = i - cfg.p1; k < i; k++) if (c[k].low < lo) lo = c[k].low;
      return c[i].close < lo;
    }
    case "pullback": {
      if (isNaN(ema50[i]) || isNaN(ema50[i - 5])) return false;
      if (ema50[i] <= ema50[i - 5]) return false;
      return rsi[i - 1] < cfg.p2 && rsi[i] >= cfg.p2;
    }
    case "nDown": {
      if (i < cfg.p1 + 1) return false;
      for (let k = 0; k < cfg.p1; k++)
        if (closes[i - k] >= closes[i - k - 1]) return false;
      return true;
    }
    case "nUp_S": {
      if (i < cfg.p1 + 1) return false;
      for (let k = 0; k < cfg.p1; k++)
        if (closes[i - k] <= closes[i - k - 1]) return false;
      return true;
    }
  }
}

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
}

function runOn(
  c: Candle[],
  cfg: Cfg,
  ctx: { closes: number[]; rsi: number[]; ema50: number[] },
  startIdx: number,
  endIdx: number,
  barsPerDay: number,
): Trade[] {
  const t: Trade[] = [];
  let cd = -1;
  const ts0 = c[startIdx]?.openTime ?? 0;
  for (let i = Math.max(50, startIdx); i < endIdx - 1; i++) {
    if (i < cd) continue;
    if (!fires(c, ctx.closes, ctx.rsi, ctx.ema50, i, cfg)) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = cfg.dir === "long" ? entry * (1 + cfg.tp) : entry * (1 - cfg.tp);
    const stop =
      cfg.dir === "long" ? entry * (1 - cfg.stop) : entry * (1 + cfg.stop);
    const mx = Math.min(i + 1 + cfg.hold, endIdx - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
      if (cfg.dir === "long") {
        if (bar.low <= stop) {
          xb = j;
          xp = stop;
          break;
        }
        if (bar.high >= tp) {
          xb = j;
          xp = tp;
          break;
        }
      } else {
        if (bar.high >= stop) {
          xb = j;
          xp = stop;
          break;
        }
        if (bar.low <= tp) {
          xb = j;
          xp = tp;
          break;
        }
      }
    }
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: cfg.dir,
      holdingHours: (xb - (i + 1)) / (barsPerDay / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      t.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
      });
    cd = xb + 1;
  }
  return t;
}

describe("iter 168 — map the true BTC 15m daytrade frontier", () => {
  it(
    "show pareto frontier of (freq, rawMean) + best FTMO sim",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 168: FRONTIER MAP ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const barsPerDay = 96;
      const days = c.length / barsPerDay;
      console.log(`${c.length} 15m candles (${days.toFixed(0)} days)`);

      const closes = c.map((x) => x.close);
      const rsi14 = rsiSeries(closes, 14);
      const rsi7 = rsiSeries(closes, 7);
      const ema50 = emaSeries(closes, 50);

      const cfgs: { name: string; cfg: Cfg; ctx: typeof ctxR14 }[] = [];
      const ctxR14 = { closes, rsi: rsi14, ema50 };
      const ctxR7 = { closes, rsi: rsi7, ema50 };

      // Breakouts
      for (const lb of [6, 10, 20, 40])
        for (const tp of [0.003, 0.005, 0.008, 0.012])
          for (const stop of [0.002, 0.003, 0.005])
            for (const hold of [4, 8, 16]) {
              cfgs.push({
                name: `brk${lb}_tp${(tp * 100).toFixed(1)}%_s${(stop * 100).toFixed(1)}%_h${hold}`,
                cfg: {
                  kind: "brk_hi",
                  p1: lb,
                  p2: 0,
                  tp,
                  stop,
                  hold,
                  dir: "long",
                },
                ctx: ctxR14,
              });
              cfgs.push({
                name: `brkS${lb}_tp${(tp * 100).toFixed(1)}%_s${(stop * 100).toFixed(1)}%_h${hold}`,
                cfg: {
                  kind: "brk_lo_S",
                  p1: lb,
                  p2: 0,
                  tp,
                  stop,
                  hold,
                  dir: "short",
                },
                ctx: ctxR14,
              });
            }
      // Pullback
      for (const th of [30, 35, 40, 45, 50])
        for (const tp of [0.005, 0.008, 0.012])
          for (const stop of [0.002, 0.003, 0.005])
            for (const hold of [8, 16, 32]) {
              cfgs.push({
                name: `pb${th}_tp${(tp * 100).toFixed(1)}%_s${(stop * 100).toFixed(1)}%_h${hold}`,
                cfg: {
                  kind: "pullback",
                  p1: 0,
                  p2: th,
                  tp,
                  stop,
                  hold,
                  dir: "long",
                },
                ctx: ctxR14,
              });
            }
      // nDown/nUp
      for (const n of [3, 4, 5])
        for (const tp of [0.003, 0.005, 0.008])
          for (const stop of [0.002, 0.003, 0.005])
            for (const hold of [4, 8]) {
              cfgs.push({
                name: `${n}dn_tp${(tp * 100).toFixed(1)}%_s${(stop * 100).toFixed(1)}%_h${hold}`,
                cfg: {
                  kind: "nDown",
                  p1: n,
                  p2: 0,
                  tp,
                  stop,
                  hold,
                  dir: "long",
                },
                ctx: ctxR14,
              });
            }

      console.log(`Scanning ${cfgs.length} configs...`);
      interface R {
        name: string;
        cfg: Cfg;
        ctx: typeof ctxR14;
        n: number;
        perDay: number;
        wr: number;
        rawMean: number;
      }
      const results: R[] = [];
      for (const { name, cfg, ctx } of cfgs) {
        const t = runOn(c, cfg, ctx, 50, c.length, barsPerDay);
        if (t.length < 200) continue;
        const pnls = t.map((x) => x.rawPnl);
        const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const wr = pnls.filter((p) => p > 0).length / pnls.length;
        results.push({
          name,
          cfg,
          ctx,
          n: t.length,
          perDay: t.length / days,
          wr,
          rawMean: m,
        });
      }
      console.log(`${results.length} configs with n ≥ 200\n`);

      // Highest rawMean at various freq thresholds
      for (const minFreq of [0.5, 1, 1.5, 2, 3]) {
        const filt = results
          .filter((r) => r.perDay >= minFreq && r.rawMean > 0)
          .sort((a, b) => b.rawMean - a.rawMean);
        console.log(
          `── Best rawMean at freq ≥ ${minFreq}/day (${filt.length} configs) ──`,
        );
        for (const r of filt.slice(0, 3)) {
          console.log(
            `  ${r.name.padEnd(36)}  n=${r.n} ${r.perDay.toFixed(2)}/d WR=${(r.wr * 100).toFixed(0)}% rawMean=${(r.rawMean * 100).toFixed(3)}%`,
          );
        }
      }

      // Highest freq at various rawMean thresholds
      console.log("");
      for (const minMean of [0.02, 0.05, 0.08, 0.12, 0.2].map((x) => x / 100)) {
        const filt = results
          .filter((r) => r.rawMean >= minMean)
          .sort((a, b) => b.perDay - a.perDay);
        console.log(
          `── Best freq at rawMean ≥ ${(minMean * 100).toFixed(2)}% (${filt.length} configs) ──`,
        );
        for (const r of filt.slice(0, 3)) {
          console.log(
            `  ${r.name.padEnd(36)}  n=${r.n} ${r.perDay.toFixed(2)}/d WR=${(r.wr * 100).toFixed(0)}% rawMean=${(r.rawMean * 100).toFixed(3)}%`,
          );
        }
      }

      // Pareto frontier: select top 5 triggers with best rawMean×perDay product
      const pareto = [...results]
        .filter((r) => r.rawMean > 0)
        .sort((a, b) => b.rawMean * b.perDay - a.rawMean * a.perDay);
      console.log("\n── Top 5 by rawMean × perDay (raw throughput) ──");
      for (const r of pareto.slice(0, 5)) {
        console.log(
          `  ${r.name.padEnd(36)}  ${r.perDay.toFixed(2)}/d × ${(r.rawMean * 100).toFixed(3)}% = ${(r.perDay * r.rawMean * 100).toFixed(3)}%/d`,
        );
      }

      // FTMO sim on top 10 throughput configs
      console.log("\n── FTMO sim on top 10 throughput configs ──");
      const winLen = 30 * barsPerDay;
      const step = 7 * barsPerDay;
      const windows: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += step) {
        windows.push({ start: s, end: s + winLen });
      }
      console.log(`${windows.length} windows\n`);

      function simFtmo(trades: Trade[], riskFrac: number) {
        let eq = 1;
        const ds = new Map<number, number>();
        const td = new Set<number>();
        for (const t of trades.sort(
          (a, b) => a.day - b.day || a.entryTime - b.entryTime,
        )) {
          if (t.day >= 30) break;
          if (!ds.has(t.day)) ds.set(t.day, eq);
          const pnlF = Math.max(t.rawPnl * 2 * riskFrac, -riskFrac);
          eq *= 1 + pnlF;
          td.add(t.day);
          if (eq <= 0.9) return { passed: false, reason: "total_loss" };
          const sod = ds.get(t.day)!;
          if (eq / sod - 1 <= -0.05)
            return { passed: false, reason: "daily_loss" };
          if (eq >= 1.1 && td.size >= 4)
            return { passed: true, reason: "profit_target" };
        }
        return {
          passed: eq >= 1.1 && td.size >= 4,
          reason:
            eq >= 1.1
              ? "profit_target"
              : td.size < 4
                ? "insufficient_days"
                : "time",
        };
      }

      interface Best {
        name: string;
        risk: number;
        pass: number;
        rate: number;
        ev: number;
      }
      const bests: Best[] = [];
      for (const r of pareto.slice(0, 10)) {
        const perWin = windows.map((w) =>
          runOn(c, r.cfg, r.ctx, w.start, w.end, barsPerDay),
        );
        let best: Best = { name: r.name, risk: 0, pass: 0, rate: 0, ev: -99 };
        for (const rf of [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0]) {
          let pass = 0;
          for (const t of perWin) {
            const s = simFtmo(t, rf);
            if (s.passed) pass++;
          }
          const rate = pass / perWin.length;
          const ev = rate * 0.5 * 8000 - 99;
          if (ev > best.ev) best = { name: r.name, risk: rf, pass, rate, ev };
        }
        bests.push(best);
      }
      bests.sort((a, b) => b.ev - a.ev);
      console.log(
        "Trigger                              bestRisk  pass/294  rate%   EV($)",
      );
      for (const b of bests.slice(0, 10)) {
        console.log(
          `${b.name.padEnd(36)}  ${(b.risk * 100).toFixed(0)}%     ${b.pass}/${windows.length}   ${(b.rate * 100).toFixed(2)}%  ${b.ev > 0 ? "+" : ""}$${b.ev.toFixed(0)}`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
