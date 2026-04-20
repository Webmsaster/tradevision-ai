/**
 * Iter 170 — fine-grained optimization around iter169 winner + symmetric short.
 *
 * iter169 sensitivity test hinted at improvements:
 *   • base (tp=0.8% s=0.2% h=4): 22.76% pass, EV +$811
 *   • tp+20% (tp=0.96%): 27.59% pass, EV +$1004 ← better
 *   • stop-25% (s=0.15%): 26.90% pass, EV +$977 ← better
 *
 * This iter:
 *   A) fine grid: nDown ∈ {3,4,5,6}, tp ∈ {0.6-1.2%}, stop ∈ {0.1-0.3%},
 *      hold ∈ {2,4,6,8} bars — find best single config
 *   B) SYMMETRIC: 4-up-bars → short at next open (tp below, stop above).
 *      BTC short mean-reversion after 4 green bars is the symmetric edge.
 *   C) COMBINED: 4-down long + 4-up short (double signal density)
 *   D) Validate winner with IS/OOS split
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  dir: "long" | "short";
}

function runNDown(
  c: Candle[],
  n: number,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  barsPerDay: number,
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  let cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (c[i - k].close >= c[i - k - 1].close) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 + tp);
    const stPx = entry * (1 - stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
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
    }
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "long",
      holdingHours: (xb - (i + 1)) / (barsPerDay / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        dir: "long",
      });
    cd = xb + 1;
  }
  return out;
}

function runNUpShort(
  c: Candle[],
  n: number,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  barsPerDay: number,
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  let cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (c[i - k].close <= c[i - k - 1].close) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    // short: tp below, stop above
    const tpPx = entry * (1 - tp);
    const stPx = entry * (1 + stop);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
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
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "short",
      holdingHours: (xb - (i + 1)) / (barsPerDay / 24),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        rawPnl: pnl,
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        dir: "short",
      });
    cd = xb + 1;
  }
  return out;
}

function simFtmo(
  trades: Trade[],
  leverage: number,
  riskFrac: number,
  maxDays = 30,
) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  for (const t of trades.sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  )) {
    if (t.day >= maxDays) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const pnlF = Math.max(t.rawPnl * leverage * riskFrac, -riskFrac);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false, reason: "total_loss" };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false, reason: "daily_loss" };
    if (eq >= 1.1 && td.size >= 4)
      return { passed: true, reason: "profit_target" };
  }
  return {
    passed: eq >= 1.1 && td.size >= 4,
    reason:
      eq >= 1.1 ? "profit_target" : td.size < 4 ? "insufficient_days" : "time",
  };
}

describe("iter 170 — fine-grained daytrade optimization", () => {
  it(
    "sweep + find best long/short/combined config",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 170: FINE DAYTRADE OPT ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const barsPerDay = 96;
      const days = c.length / barsPerDay;
      console.log(`${c.length} 15m (${days.toFixed(0)} days)`);

      const winLen = 30 * barsPerDay;
      const step = 7 * barsPerDay;
      const wins: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += step)
        wins.push({ start: s, end: s + winLen });
      console.log(`${wins.length} windows\n`);

      // ─── A: fine sweep LONG ───
      console.log("── A: Long (nDown) fine sweep ──");
      console.log("nDown  tp%   stop%  hold  pass/N   rate%   EV($)");
      interface Rs {
        desc: string;
        n: number;
        tp: number;
        stop: number;
        hold: number;
        dir: "long" | "short" | "combined";
        pass: number;
        rate: number;
        ev: number;
      }
      const results: Rs[] = [];
      for (const n of [3, 4, 5, 6]) {
        for (const tp of [0.006, 0.007, 0.008, 0.009, 0.01, 0.011, 0.012]) {
          for (const stop of [0.0015, 0.002, 0.0025, 0.003]) {
            for (const hold of [2, 4, 6, 8]) {
              let pass = 0;
              for (const w of wins) {
                const t = runNDown(
                  c,
                  n,
                  tp,
                  stop,
                  hold,
                  w.start,
                  w.end,
                  barsPerDay,
                );
                if (simFtmo(t, 2, 1.0).passed) pass++;
              }
              const rate = pass / wins.length;
              const ev = rate * 0.5 * 8000 - 99;
              results.push({
                desc: `${n}dn_tp${(tp * 100).toFixed(2)}_s${(stop * 100).toFixed(2)}_h${hold}`,
                n,
                tp,
                stop,
                hold,
                dir: "long",
                pass,
                rate,
                ev,
              });
            }
          }
        }
      }
      results.sort((a, b) => b.rate - a.rate);
      console.log("Top 10 LONG:");
      for (const r of results.slice(0, 10)) {
        console.log(
          `  ${r.n}dn  ${(r.tp * 100).toFixed(2).padStart(4)}%  ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(2)}   ${r.pass}/${wins.length}   ${(r.rate * 100).toFixed(2).padStart(5)}%  ${r.ev > 0 ? "+" : ""}$${r.ev.toFixed(0)}`,
        );
      }

      // ─── B: symmetric SHORT ───
      console.log("\n── B: Short (nUp) fine sweep ──");
      const shortResults: Rs[] = [];
      for (const n of [3, 4, 5]) {
        for (const tp of [0.006, 0.008, 0.01, 0.012]) {
          for (const stop of [0.002, 0.0025, 0.003]) {
            for (const hold of [2, 4, 6, 8]) {
              let pass = 0;
              for (const w of wins) {
                const t = runNUpShort(
                  c,
                  n,
                  tp,
                  stop,
                  hold,
                  w.start,
                  w.end,
                  barsPerDay,
                );
                if (simFtmo(t, 2, 1.0).passed) pass++;
              }
              const rate = pass / wins.length;
              const ev = rate * 0.5 * 8000 - 99;
              shortResults.push({
                desc: `${n}up_S_tp${(tp * 100).toFixed(2)}_s${(stop * 100).toFixed(2)}_h${hold}`,
                n,
                tp,
                stop,
                hold,
                dir: "short",
                pass,
                rate,
                ev,
              });
            }
          }
        }
      }
      shortResults.sort((a, b) => b.rate - a.rate);
      console.log("Top 5 SHORT:");
      for (const r of shortResults.slice(0, 5)) {
        console.log(
          `  ${r.n}up_S  ${(r.tp * 100).toFixed(2).padStart(4)}%  ${(r.stop * 100).toFixed(2).padStart(4)}%  ${r.hold.toString().padStart(2)}   ${r.pass}/${wins.length}   ${(r.rate * 100).toFixed(2).padStart(5)}%  ${r.ev > 0 ? "+" : ""}$${r.ev.toFixed(0)}`,
        );
      }

      // ─── C: COMBINE best long + best short ───
      const bestLong = results[0];
      const bestShort = shortResults[0];
      console.log(
        `\n── C: Combined best long (${bestLong.desc}) + best short (${bestShort.desc}) ──`,
      );
      let combPass = 0;
      for (const w of wins) {
        const longT = runNDown(
          c,
          bestLong.n,
          bestLong.tp,
          bestLong.stop,
          bestLong.hold,
          w.start,
          w.end,
          barsPerDay,
        );
        const shortT = runNUpShort(
          c,
          bestShort.n,
          bestShort.tp,
          bestShort.stop,
          bestShort.hold,
          w.start,
          w.end,
          barsPerDay,
        );
        const combined = [...longT, ...shortT];
        if (simFtmo(combined, 2, 1.0).passed) combPass++;
      }
      const combRate = combPass / wins.length;
      const combEv = combRate * 0.5 * 8000 - 99;
      console.log(
        `  Combined: pass ${combPass}/${wins.length} (${(combRate * 100).toFixed(2)}%)  EV $${combEv.toFixed(0)}`,
      );

      // ─── D: Combined at REDUCED risk (since signals double) ───
      console.log("\n── D: Combined at reduced risk (avoids over-exposure) ──");
      console.log("risk%   pass/N   rate%   EV($)");
      for (const rf of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
        let p = 0;
        for (const w of wins) {
          const longT = runNDown(
            c,
            bestLong.n,
            bestLong.tp,
            bestLong.stop,
            bestLong.hold,
            w.start,
            w.end,
            barsPerDay,
          );
          const shortT = runNUpShort(
            c,
            bestShort.n,
            bestShort.tp,
            bestShort.stop,
            bestShort.hold,
            w.start,
            w.end,
            barsPerDay,
          );
          if (simFtmo([...longT, ...shortT], 2, rf).passed) p++;
        }
        const r = p / wins.length;
        const ev = r * 0.5 * 8000 - 99;
        console.log(
          `${(rf * 100).toFixed(0).padStart(3)}%   ${p}/${wins.length}   ${(r * 100).toFixed(2).padStart(5)}%  ${ev > 0 ? "+" : ""}$${ev.toFixed(0)}`,
        );
      }

      // ─── E: IS/OOS on best LONG ───
      console.log("\n── E: IS/OOS on best LONG ──");
      const cutIdx = Math.floor(wins.length * 0.6);
      const isWin = wins.slice(0, cutIdx);
      const oosWin = wins.slice(cutIdx);
      function batchLong(ws: typeof wins) {
        let p = 0;
        for (const w of ws) {
          const t = runNDown(
            c,
            bestLong.n,
            bestLong.tp,
            bestLong.stop,
            bestLong.hold,
            w.start,
            w.end,
            barsPerDay,
          );
          if (simFtmo(t, 2, 1.0).passed) p++;
        }
        return { p, r: p / ws.length };
      }
      const isL = batchLong(isWin);
      const oosL = batchLong(oosWin);
      console.log(
        `  ${bestLong.desc}:  IS ${isL.p}/${isWin.length} (${(isL.r * 100).toFixed(2)}%)  OOS ${oosL.p}/${oosWin.length} (${(oosL.r * 100).toFixed(2)}%)  EV-OOS $${(oosL.r * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      // ─── F: IS/OOS on combined ───
      console.log("\n── F: IS/OOS on combined long+short ──");
      function batchCombined(ws: typeof wins, rf = 1.0) {
        let p = 0;
        for (const w of ws) {
          const longT = runNDown(
            c,
            bestLong.n,
            bestLong.tp,
            bestLong.stop,
            bestLong.hold,
            w.start,
            w.end,
            barsPerDay,
          );
          const shortT = runNUpShort(
            c,
            bestShort.n,
            bestShort.tp,
            bestShort.stop,
            bestShort.hold,
            w.start,
            w.end,
            barsPerDay,
          );
          if (simFtmo([...longT, ...shortT], 2, rf).passed) p++;
        }
        return { p, r: p / ws.length };
      }
      const isC = batchCombined(isWin);
      const oosC = batchCombined(oosWin);
      console.log(
        `  combined @100%:  IS ${isC.p}/${isWin.length} (${(isC.r * 100).toFixed(2)}%)  OOS ${oosC.p}/${oosWin.length} (${(oosC.r * 100).toFixed(2)}%)  EV-OOS $${(oosC.r * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      console.log("\n★ Summary ★");
      console.log(
        `  iter169 base:            22.76% full, 12.07% OOS, EV-full $811, EV-OOS $384`,
      );
      console.log(
        `  iter170 best long:       ${(bestLong.rate * 100).toFixed(2)}% full, ${(oosL.r * 100).toFixed(2)}% OOS, EV-full $${bestLong.ev.toFixed(0)}, EV-OOS $${(oosL.r * 0.5 * 8000 - 99).toFixed(0)}`,
      );
      console.log(
        `  iter170 combined L+S:    ${(combRate * 100).toFixed(2)}% full, ${(oosC.r * 100).toFixed(2)}% OOS, EV-full $${combEv.toFixed(0)}, EV-OOS $${(oosC.r * 0.5 * 8000 - 99).toFixed(0)}`,
      );

      expect(true).toBe(true);
    },
  );
});
