/**
 * Iter 175 — ETH sanity-check + ship multi-asset flagship.
 *
 * iter174 reported 100% OOS pass rate on ETH tp=1.0% @ 50-70% risk. Red flag:
 * overlapping 7-day-stepped windows inflate pass rate (correlated trials).
 *
 * Sanity check:
 *   A) NON-OVERLAPPING 30-day windows (step=30) → independent trials
 *   B) Monte-Carlo random window starts (100 random 30-day picks)
 *   C) Longer OOS window (last 25% instead of 40%)
 *   D) Walk-forward: train config IS, evaluate OOS with locked params
 *
 * If the adjusted OOS pass rate is still ≥ 50%, ship ETH as flagship.
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

function runBi(
  c: Candle[],
  n: number,
  tp: number,
  stop: number,
  hold: number,
  wS: number,
  wE: number,
  bpd: number,
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  let cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let okDn = true;
    for (let k = 0; k < n; k++)
      if (c[i - k].close >= c[i - k - 1].close) {
        okDn = false;
        break;
      }
    if (!okDn) continue;
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
      holdingHours: (xb - (i + 1)) / (bpd / 24),
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
  cd = -1;
  for (let i = Math.max(n + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    let okUp = true;
    for (let k = 0; k < n; k++)
      if (c[i - k].close <= c[i - k - 1].close) {
        okUp = false;
        break;
      }
    if (!okUp) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
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
      holdingHours: (xb - (i + 1)) / (bpd / 24),
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

function simFtmo(trades: Trade[], leverage: number, riskFrac: number) {
  let eq = 1;
  const ds = new Map<number, number>();
  const td = new Set<number>();
  const sorted = [...trades].sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  );
  for (const t of sorted) {
    if (t.day >= 30) break;
    if (!ds.has(t.day)) ds.set(t.day, eq);
    const pnlF = Math.max(t.rawPnl * leverage * riskFrac, -riskFrac);
    eq *= 1 + pnlF;
    td.add(t.day);
    if (eq <= 0.9) return { passed: false };
    const sod = ds.get(t.day)!;
    if (eq / sod - 1 <= -0.05) return { passed: false };
    if (eq >= 1.1 && td.size >= 4) return { passed: true };
  }
  return { passed: eq >= 1.1 && td.size >= 4 };
}

describe("iter 175 — ETH sanity check", () => {
  it(
    "non-overlapping windows + Monte-Carlo",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 175: ETH SANITY ===");
      const ceth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const bpd = 96;
      const days = ceth.length / bpd;
      console.log(`ETH 15m: ${ceth.length} candles (${days.toFixed(0)} days)`);

      // ─── A: non-overlapping 30-day windows ───
      const winLen = 30 * bpd;
      const windowsNonOv: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < ceth.length; s += winLen) {
        windowsNonOv.push({ start: s, end: s + winLen });
      }
      console.log(
        `\n── A: NON-OVERLAPPING 30-day windows (${windowsNonOv.length}) ──`,
      );
      console.log("tp%    risk%   pass/N   rate%   EV($)");
      for (const tp of [0.008, 0.01, 0.012, 0.015]) {
        for (const rf of [0.5, 0.7, 1.0]) {
          let p = 0;
          for (const w of windowsNonOv) {
            const t = runBi(ceth, 2, tp, 0.0015, 12, w.start, w.end, bpd);
            if (simFtmo(t, 2, rf).passed) p++;
          }
          const r = p / windowsNonOv.length;
          const ev = r * 0.5 * 8000 - 99;
          console.log(
            `${(tp * 100).toFixed(1).padStart(4)}%  ${(rf * 100).toFixed(0).padStart(3)}%  ${p}/${windowsNonOv.length}    ${(r * 100).toFixed(2).padStart(5)}%   +$${ev.toFixed(0)}`,
          );
        }
      }

      // ─── B: Monte-Carlo 100 random start indexes ───
      console.log("\n── B: Monte-Carlo 200 random window starts ──");
      console.log("tp%    risk%   pass/200   rate%   EV($)");
      let seed = 9999;
      const rng = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (const tp of [0.008, 0.01, 0.012]) {
        for (const rf of [0.5, 0.7, 1.0]) {
          let p = 0;
          for (let i = 0; i < 200; i++) {
            const start = Math.floor(rng() * (ceth.length - winLen));
            const t = runBi(
              ceth,
              2,
              tp,
              0.0015,
              12,
              start,
              start + winLen,
              bpd,
            );
            if (simFtmo(t, 2, rf).passed) p++;
          }
          const r = p / 200;
          const ev = r * 0.5 * 8000 - 99;
          console.log(
            `${(tp * 100).toFixed(1).padStart(4)}%  ${(rf * 100).toFixed(0).padStart(3)}%  ${p}/200    ${(r * 100).toFixed(2).padStart(5)}%   +$${ev.toFixed(0)}`,
          );
        }
      }

      // ─── C: Walk-forward: train IS (first 60%), eval OOS (last 40%) ───
      console.log("\n── C: Walk-forward with locked params ──");
      const cut = Math.floor(ceth.length * 0.6);
      const isEnd = cut;
      const winsIs: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < isEnd; s += winLen)
        winsIs.push({ start: s, end: s + winLen });
      const winsOos: { start: number; end: number }[] = [];
      for (let s = cut; s + winLen < ceth.length; s += winLen)
        winsOos.push({ start: s, end: s + winLen });
      console.log(
        `  IS: ${winsIs.length} non-overlapping, OOS: ${winsOos.length}`,
      );
      for (const tp of [0.008, 0.01, 0.012]) {
        for (const rf of [0.5, 0.7, 1.0]) {
          let pI = 0,
            pO = 0;
          for (const w of winsIs) {
            const t = runBi(ceth, 2, tp, 0.0015, 12, w.start, w.end, bpd);
            if (simFtmo(t, 2, rf).passed) pI++;
          }
          for (const w of winsOos) {
            const t = runBi(ceth, 2, tp, 0.0015, 12, w.start, w.end, bpd);
            if (simFtmo(t, 2, rf).passed) pO++;
          }
          console.log(
            `  tp ${(tp * 100).toFixed(1)}%  risk ${(rf * 100).toFixed(0)}%:  IS ${pI}/${winsIs.length} (${((pI / winsIs.length) * 100).toFixed(0)}%)  OOS ${pO}/${winsOos.length} (${((pO / winsOos.length) * 100).toFixed(0)}%)`,
          );
        }
      }

      expect(true).toBe(true);
    },
  );
});
