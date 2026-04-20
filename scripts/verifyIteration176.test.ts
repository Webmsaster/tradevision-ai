/**
 * Iter 176 — BTC daytrade further improvements.
 *
 * Baseline (iter172 V2): tp=1.0% s=0.15% h=12 @ 100% risk → 55.17% OOS
 * iter173 hinted: tp=1.8% gives 58.62% OOS on BTC — worth shipping.
 *
 * New experiments:
 *   A) Asymmetric L vs S params (long vs short may have different optima)
 *   B) Volatility-filtered entries (only trade when ATR above/below threshold)
 *   C) Fine stop sweep (0.1% - 0.3% with 0.025% increments)
 *   D) Hold sweep (8, 12, 16, 20 bars)
 *   E) Combined winner: V2 + best-of-iter173 TP variant
 *   F) Risk sweep at each TP level
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

function atrSeries(c: Candle[], len: number): number[] {
  const out = new Array(c.length).fill(NaN);
  if (c.length < len + 1) return out;
  let sum = 0;
  for (let i = 1; i <= len; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    sum += tr;
  }
  out[len] = sum / len;
  for (let i = len + 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    out[i] = (out[i - 1] * (len - 1) + tr) / len;
  }
  return out;
}

function runBi(
  c: Candle[],
  n: number,
  tpL: number,
  stopL: number,
  tpS: number,
  stopS: number,
  hold: number,
  wS: number,
  wE: number,
  bpd: number,
  atrFilter?: { atr: number[]; minRel: number; maxRel: number },
): Trade[] {
  const out: Trade[] = [];
  const ts0 = c[wS]?.openTime ?? 0;
  // LONG
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
    if (atrFilter && !isNaN(atrFilter.atr[i])) {
      const rel = atrFilter.atr[i] / c[i].close;
      if (rel < atrFilter.minRel || rel > atrFilter.maxRel) continue;
    }
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 + tpL);
    const stPx = entry * (1 - stopL);
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
  // SHORT
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
    if (atrFilter && !isNaN(atrFilter.atr[i])) {
      const rel = atrFilter.atr[i] / c[i].close;
      if (rel < atrFilter.minRel || rel > atrFilter.maxRel) continue;
    }
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tpPx = entry * (1 - tpS);
    const stPx = entry * (1 + stopS);
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

describe("iter 176 — BTC further improvements", () => {
  it(
    "find best BTC config past V2 baseline",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 176: BTC V3 ATTEMPT ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const bpd = 96;
      const atr14 = atrSeries(c, 14);
      console.log(`${c.length} 15m candles`);

      // Use NON-OVERLAPPING windows for robust validation
      const winLen = 30 * bpd;
      const winsNo: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += winLen)
        winsNo.push({ start: s, end: s + winLen });
      // Also overlapping 7-step for volume
      const winsOv: { start: number; end: number }[] = [];
      for (let s = 0; s + winLen < c.length; s += 7 * bpd)
        winsOv.push({ start: s, end: s + winLen });
      const cutOv = Math.floor(winsOv.length * 0.6);
      const oosOv = winsOv.slice(cutOv);
      console.log(
        `${winsNo.length} non-overlap windows, ${winsOv.length} overlap (OOS ${oosOv.length})\n`,
      );

      // ─── A: Symmetric TP sweep with 0.15% stop (baseline re-test) ───
      console.log("── A: TP sweep (non-overlap, symmetric) ──");
      console.log(
        "tp%   risk%   pass/N(non-ov)   rate%   OOS(overlap)%   EV-OOS($)",
      );
      for (const tp of [0.01, 0.012, 0.015, 0.018, 0.02]) {
        for (const rf of [0.5, 0.7, 1.0]) {
          let pN = 0,
            pO = 0;
          for (const w of winsNo) {
            const t = runBi(
              c,
              2,
              tp,
              0.0015,
              tp,
              0.0015,
              12,
              w.start,
              w.end,
              bpd,
            );
            if (simFtmo(t, 2, rf).passed) pN++;
          }
          for (const w of oosOv) {
            const t = runBi(
              c,
              2,
              tp,
              0.0015,
              tp,
              0.0015,
              12,
              w.start,
              w.end,
              bpd,
            );
            if (simFtmo(t, 2, rf).passed) pO++;
          }
          const rN = pN / winsNo.length;
          const rO = pO / oosOv.length;
          console.log(
            `${(tp * 100).toFixed(1).padStart(4)}% ${(rf * 100).toFixed(0).padStart(3)}%  ${pN}/${winsNo.length}    ${(rN * 100).toFixed(2).padStart(5)}%   ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
          );
        }
      }

      // ─── B: Asymmetric Long/Short — BTC has long-bias historically ───
      console.log("\n── B: Asymmetric L/S TP (BTC bull bias) ──");
      console.log("tpL%   tpS%   stop%   risk%   NOV%   OOS-OV%   EV-OOS($)");
      for (const tpL of [0.012, 0.015, 0.018]) {
        for (const tpS of [0.008, 0.01, 0.012]) {
          for (const stop of [0.0015, 0.002]) {
            for (const rf of [0.7, 1.0]) {
              let pN = 0,
                pO = 0;
              for (const w of winsNo) {
                const t = runBi(
                  c,
                  2,
                  tpL,
                  stop,
                  tpS,
                  stop,
                  12,
                  w.start,
                  w.end,
                  bpd,
                );
                if (simFtmo(t, 2, rf).passed) pN++;
              }
              for (const w of oosOv) {
                const t = runBi(
                  c,
                  2,
                  tpL,
                  stop,
                  tpS,
                  stop,
                  12,
                  w.start,
                  w.end,
                  bpd,
                );
                if (simFtmo(t, 2, rf).passed) pO++;
              }
              const rN = pN / winsNo.length;
              const rO = pO / oosOv.length;
              if (rN >= 0.55) {
                console.log(
                  `${(tpL * 100).toFixed(1).padStart(4)}%  ${(tpS * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${(rf * 100).toFixed(0).padStart(3)}%  ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
                );
              }
            }
          }
        }
      }

      // ─── C: ATR-filtered (only trade in specific volatility regime) ───
      console.log("\n── C: ATR-filter (trade only when ATR/close in range) ──");
      console.log(
        "minATR%   maxATR%   NOV-pass   rate%   OOS-OV-pass   OOS-rate%   EV($)",
      );
      for (const minR of [0, 0.001, 0.002, 0.003]) {
        for (const maxR of [0.005, 0.01, 0.02, 1.0]) {
          if (maxR <= minR) continue;
          let pN = 0,
            pO = 0;
          for (const w of winsNo) {
            const t = runBi(
              c,
              2,
              0.015,
              0.0015,
              0.015,
              0.0015,
              12,
              w.start,
              w.end,
              bpd,
              { atr: atr14, minRel: minR, maxRel: maxR },
            );
            if (simFtmo(t, 2, 1.0).passed) pN++;
          }
          for (const w of oosOv) {
            const t = runBi(
              c,
              2,
              0.015,
              0.0015,
              0.015,
              0.0015,
              12,
              w.start,
              w.end,
              bpd,
              { atr: atr14, minRel: minR, maxRel: maxR },
            );
            if (simFtmo(t, 2, 1.0).passed) pO++;
          }
          const rN = pN / winsNo.length;
          const rO = pO / oosOv.length;
          if (rN >= 0.5) {
            console.log(
              `  ${(minR * 100).toFixed(2).padStart(4)}%   ${(maxR * 100).toFixed(2).padStart(4)}%  ${pN}/${winsNo.length}    ${(rN * 100).toFixed(2).padStart(5)}%   ${pO}/${oosOv.length}   ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
            );
          }
        }
      }

      // ─── D: Fine stop + hold sweep around tp=1.5% ───
      console.log("\n── D: Fine stop + hold sweep @ tp=1.5% ──");
      console.log("stop%   hold   NOV%   OOS-OV%   EV($)");
      for (const stop of [0.001, 0.00125, 0.0015, 0.00175, 0.002, 0.0025]) {
        for (const hold of [8, 12, 16, 20]) {
          let pN = 0,
            pO = 0;
          for (const w of winsNo) {
            const t = runBi(
              c,
              2,
              0.015,
              stop,
              0.015,
              stop,
              hold,
              w.start,
              w.end,
              bpd,
            );
            if (simFtmo(t, 2, 1.0).passed) pN++;
          }
          for (const w of oosOv) {
            const t = runBi(
              c,
              2,
              0.015,
              stop,
              0.015,
              stop,
              hold,
              w.start,
              w.end,
              bpd,
            );
            if (simFtmo(t, 2, 1.0).passed) pO++;
          }
          const rN = pN / winsNo.length;
          const rO = pO / oosOv.length;
          if (rN >= 0.55) {
            console.log(
              `${(stop * 100).toFixed(3).padStart(5)}%  ${hold.toString().padStart(3)}   ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
            );
          }
        }
      }

      expect(true).toBe(true);
    },
  );
});
