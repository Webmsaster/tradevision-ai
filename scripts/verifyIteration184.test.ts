/**
 * Iter 184 — final push: long-bias + ATR stops + stacked triggers.
 *
 * iter183 baseline: BTC+ETH 1d combined → 55% OOS, +$2101 EV.
 *
 * Three unexplored angles:
 *   A) LONG-ONLY bias: Crypto has historical long bias (BTC +12000% since
 *      2015). Shorts often underperform. Test long-only on BTC+ETH 1d.
 *   B) ATR-based stops: instead of fixed 2%, use 1.5× ATR. Adapts to regime.
 *   C) Stacked triggers: 2-down + 3-down + 4-down all fire, different TPs.
 *   D) Combine A+B+C if each adds value.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
}

function atrRel(c: Candle[], len: number): number[] {
  const out = new Array(c.length).fill(NaN);
  if (c.length < len + 1) return out;
  let sum = 0;
  for (let i = 1; i <= len; i++) {
    sum += Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
  }
  out[len] = sum / len / c[len].close;
  for (let i = len + 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    const atr = (out[i - 1] * c[i - 1].close * (len - 1) + tr) / len;
    out[i] = atr / c[i].close;
  }
  return out;
}

interface RunOpts {
  tp: number;
  stopFixed?: number;
  stopAtrMult?: number;
  hold: number;
  triggerBars: number;
  costBp: number;
  longOnly: boolean;
  atrRel?: number[];
}

function run(c: Candle[], wS: number, wE: number, opts: RunOpts): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const costFrac = opts.costBp / 10000;

  const dirs: ("long" | "short")[] = opts.longOnly
    ? ["long"]
    : ["long", "short"];

  for (const dir of dirs) {
    let cd = -1;
    for (let i = Math.max(opts.triggerBars + 1, wS); i < wE - 1; i++) {
      if (i < cd) continue;
      let ok = true;
      for (let k = 0; k < opts.triggerBars; k++) {
        const cmp =
          dir === "long"
            ? c[i - k].close >= c[i - k - 1].close
            : c[i - k].close <= c[i - k - 1].close;
        if (cmp) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const eb = c[i + 1];
      if (!eb) break;
      const entry = eb.open;

      // Dynamic stop
      let stopPct: number;
      if (opts.stopAtrMult && opts.atrRel) {
        const a = opts.atrRel[i];
        if (isNaN(a)) continue;
        stopPct = Math.max(0.005, Math.min(0.05, a * opts.stopAtrMult));
      } else {
        stopPct = opts.stopFixed ?? 0.02;
      }

      const entryEff =
        dir === "long"
          ? entry * (1 + costFrac / 2)
          : entry * (1 - costFrac / 2);
      const tpPx =
        dir === "long" ? entry * (1 + opts.tp) : entry * (1 - opts.tp);
      const stPx =
        dir === "long" ? entry * (1 - stopPct) : entry * (1 + stopPct);
      const mx = Math.min(i + 1 + opts.hold, wE - 1);
      let xb = mx;
      let xp = c[mx].close;
      for (let j = i + 2; j <= mx; j++) {
        const bar = c[j];
        if (dir === "long") {
          if (bar.low <= stPx) {
            xb = j;
            xp = stPx;
            break;
          }
          if (bar.high >= tpPx) {
            xb = j;
            xp = tpPx;
            break;
          }
        } else {
          if (bar.high >= stPx) {
            xb = j;
            xp = stPx;
            break;
          }
          if (bar.low <= tpPx) {
            xb = j;
            xp = tpPx;
            break;
          }
        }
      }
      const exitEff =
        dir === "long" ? xp * (1 - costFrac / 2) : xp * (1 + costFrac / 2);
      const pnl =
        dir === "long"
          ? (exitEff - entryEff) / entryEff
          : (entryEff - exitEff) / entryEff;
      const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
      if (day >= 0)
        out.push({
          rawPnl: pnl,
          day,
          entryTime: eb.openTime,
          exitTime: c[xb].closeTime,
        });
      cd = xb + 1;
    }
  }
  return out;
}

function simFtmo(trades: Trade[], leverage: number, risk: number) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const pnlF = Math.max(t.rawPnl * leverage * risk, -risk);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false };
    if (eq >= 1.1 && td.size >= 4) return { passed: true };
  }
  return { passed: eq >= 1.1 && td.size >= 4 };
}

describe("iter 184 — long-bias + ATR + stacked", () => {
  it(
    "test each angle separately + combined",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 184: FINAL PUSH ===");
      const cbtc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 50,
      });
      const ceth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 50,
      });
      const aligned = Math.min(cbtc.length, ceth.length);
      const atrBtc = atrRel(cbtc, 14);
      const atrEth = atrRel(ceth, 14);

      const winBars = 30;
      const winsNO: { start: number; end: number }[] = [];
      for (let s = 0; s + winBars < aligned; s += winBars)
        winsNO.push({ start: s, end: s + winBars });
      const cut = Math.floor(winsNO.length * 0.6);
      const winsIS = winsNO.slice(0, cut);
      const winsOOS = winsNO.slice(cut);
      console.log(
        `BTC+ETH aligned ${aligned}, ${winsNO.length} NOV (IS ${winsIS.length}, OOS ${winsOOS.length})\n`,
      );

      // Helper: run combined test
      function testCombined(
        tpB: number,
        tpE: number,
        opts: {
          stopFixed?: number;
          stopAtrMult?: number;
          hold: number;
          triggerBars: number;
          longOnly: boolean;
        },
      ) {
        let pI = 0,
          pO = 0,
          pN = 0;
        const runW = (w: { start: number; end: number }) => {
          const tB = run(cbtc, w.start, w.end, {
            ...opts,
            tp: tpB,
            costBp: 40,
            atrRel: atrBtc,
          });
          const tE = run(ceth, w.start, w.end, {
            ...opts,
            tp: tpE,
            costBp: 30,
            atrRel: atrEth,
          });
          return [...tB, ...tE];
        };
        for (const w of winsNO) if (simFtmo(runW(w), 2, 0.5).passed) pN++;
        for (const w of winsIS) if (simFtmo(runW(w), 2, 0.5).passed) pI++;
        for (const w of winsOOS) if (simFtmo(runW(w), 2, 0.5).passed) pO++;
        return {
          nov: pN / winsNO.length,
          is: pI / winsIS.length,
          oos: pO / winsOOS.length,
        };
      }

      // ─── A: Long-only bias test ───
      console.log(
        "── A: Long-only vs Bidirectional (iter183 baseline tp 8/12 stop 2% h 20) ──",
      );
      const bidirBase = testCombined(0.08, 0.12, {
        stopFixed: 0.02,
        hold: 20,
        triggerBars: 2,
        longOnly: false,
      });
      const longOnlyBase = testCombined(0.08, 0.12, {
        stopFixed: 0.02,
        hold: 20,
        triggerBars: 2,
        longOnly: true,
      });
      console.log(
        `  Bidir baseline:   NOV ${(bidirBase.nov * 100).toFixed(2)}%  IS ${(bidirBase.is * 100).toFixed(2)}%  OOS ${(bidirBase.oos * 100).toFixed(2)}%`,
      );
      console.log(
        `  Long-only:        NOV ${(longOnlyBase.nov * 100).toFixed(2)}%  IS ${(longOnlyBase.is * 100).toFixed(2)}%  OOS ${(longOnlyBase.oos * 100).toFixed(2)}%`,
      );

      // ─── B: ATR-based stop (with bidirectional) ───
      console.log("\n── B: ATR-based stop sweep ──");
      for (const atrMult of [1.0, 1.5, 2.0, 2.5, 3.0]) {
        const r = testCombined(0.08, 0.12, {
          stopAtrMult: atrMult,
          hold: 20,
          triggerBars: 2,
          longOnly: false,
        });
        console.log(
          `  ATR × ${atrMult}  NOV ${(r.nov * 100).toFixed(2)}%  IS ${(r.is * 100).toFixed(2)}%  OOS ${(r.oos * 100).toFixed(2)}%`,
        );
      }

      // ─── C: Stacked triggers (2d + 3d + 4d) with different TPs ───
      console.log("\n── C: Stacked 2d/3d/4d ──");
      function testStacked(longOnly: boolean) {
        let pN = 0,
          pI = 0,
          pO = 0;
        const runW = (w: { start: number; end: number }) => {
          const all: Trade[] = [];
          // 2-bar: small TP
          for (const c of [cbtc, ceth]) {
            const cost = c === cbtc ? 40 : 30;
            const tp = c === cbtc ? 0.08 : 0.12;
            all.push(
              ...run(c, w.start, w.end, {
                tp,
                stopFixed: 0.02,
                hold: 20,
                triggerBars: 2,
                longOnly,
                costBp: cost,
              }),
            );
            all.push(
              ...run(c, w.start, w.end, {
                tp: tp * 1.5,
                stopFixed: 0.025,
                hold: 20,
                triggerBars: 3,
                longOnly,
                costBp: cost,
              }),
            );
            all.push(
              ...run(c, w.start, w.end, {
                tp: tp * 2,
                stopFixed: 0.03,
                hold: 20,
                triggerBars: 4,
                longOnly,
                costBp: cost,
              }),
            );
          }
          return all;
        };
        for (const w of winsNO) if (simFtmo(runW(w), 2, 0.35).passed) pN++;
        for (const w of winsIS) if (simFtmo(runW(w), 2, 0.35).passed) pI++;
        for (const w of winsOOS) if (simFtmo(runW(w), 2, 0.35).passed) pO++;
        return {
          nov: pN / winsNO.length,
          is: pI / winsIS.length,
          oos: pO / winsOOS.length,
        };
      }
      const stackBidir = testStacked(false);
      const stackLong = testStacked(true);
      console.log(
        `  Stacked bidirect: NOV ${(stackBidir.nov * 100).toFixed(2)}%  IS ${(stackBidir.is * 100).toFixed(2)}%  OOS ${(stackBidir.oos * 100).toFixed(2)}%`,
      );
      console.log(
        `  Stacked long-only: NOV ${(stackLong.nov * 100).toFixed(2)}%  IS ${(stackLong.is * 100).toFixed(2)}%  OOS ${(stackLong.oos * 100).toFixed(2)}%`,
      );

      // ─── D: Long-only + ATR stop combined ───
      console.log("\n── D: Long-only + ATR-stop combined ──");
      for (const atrMult of [1.5, 2.0, 2.5]) {
        const r = testCombined(0.08, 0.12, {
          stopAtrMult: atrMult,
          hold: 20,
          triggerBars: 2,
          longOnly: true,
        });
        console.log(
          `  L-only ATR × ${atrMult}  NOV ${(r.nov * 100).toFixed(2)}%  OOS ${(r.oos * 100).toFixed(2)}%`,
        );
      }

      // ─── E: Hold sweep with long-only + fixed stop ───
      console.log("\n── E: Long-only hold sweep (tp 8/12 stop 2%) ──");
      for (const hold of [10, 15, 20, 25, 30]) {
        const r = testCombined(0.08, 0.12, {
          stopFixed: 0.02,
          hold,
          triggerBars: 2,
          longOnly: true,
        });
        console.log(
          `  hold ${hold}d:  NOV ${(r.nov * 100).toFixed(2)}%  OOS ${(r.oos * 100).toFixed(2)}%`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
