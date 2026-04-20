/**
 * Iter 178 — more trades per day.
 *
 * User: "ich will mehr trades pro tag".
 *
 * Current (BTC V3 / ETH V3): 2-bar trigger on 15m bars fires ~2-4 signals/day.
 *
 * Three density-boost approaches:
 *   A) 1-bar trigger: any single red/green bar triggers. Far more signals,
 *      but noisier — does OOS hold?
 *   B) 5m bars with 2-bar trigger: 4× more bars, more chances per day
 *   C) Multi-asset BTC+ETH parallel (each at 50% risk for max exposure)
 *   D) 2-bar + 3-bar trigger stacked (more coverage)
 *
 * Metric: trades/day AND pass rate. Need positive EV while boosting density.
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
  symbol: string;
  kind: string;
}

function runBi(
  c: Candle[],
  symbol: string,
  kind: string,
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
        symbol,
        kind,
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
        symbol,
        kind,
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

describe("iter 178 — more trades per day", () => {
  it(
    "1-bar + 5m + multi-asset density push",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 178: SIGNAL DENSITY ===");
      const cbtc15 = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const ceth15 = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "15m",
        targetCount: 100_000,
        maxPages: 200,
      });
      const cbtc5 = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "5m",
        targetCount: 100_000,
        maxPages: 400,
      });
      const bpd15 = 96;
      const bpd5 = 288;

      function mkWins(len: number, winLen: number, step: number) {
        const ws: { start: number; end: number }[] = [];
        for (let s = 0; s + winLen < len; s += step)
          ws.push({ start: s, end: s + winLen });
        return ws;
      }

      const wins15NO = mkWins(cbtc15.length, 30 * bpd15, 30 * bpd15);
      const wins15OV = mkWins(cbtc15.length, 30 * bpd15, 7 * bpd15);
      const cut15 = Math.floor(wins15OV.length * 0.6);
      const oos15 = wins15OV.slice(cut15);

      const wins5NO = mkWins(cbtc5.length, 30 * bpd5, 30 * bpd5);
      console.log(
        `BTC 15m: ${wins15NO.length} NOV, ${wins15OV.length} OV (OOS ${oos15.length})`,
      );
      console.log(`BTC 5m: ${wins5NO.length} NOV`);

      // ─── A: 1-bar trigger on BTC 15m ───
      console.log("\n── A: 1-bar trigger BTC 15m (massive density) ──");
      console.log(
        "tp%    stop%   risk%   trades/day   NOV%   OOS-OV%   EV-OOS($)",
      );
      for (const tp of [0.005, 0.008, 0.01, 0.012, 0.015]) {
        for (const stop of [0.0005, 0.001, 0.0015]) {
          for (const rf of [0.5, 0.7, 1.0]) {
            let pN = 0,
              pO = 0,
              totTrades = 0,
              totDays = 0;
            for (const w of wins15NO) {
              const t = runBi(
                cbtc15,
                "BTC",
                "1b",
                1,
                tp,
                stop,
                12,
                w.start,
                w.end,
                bpd15,
              );
              totTrades += t.length;
              totDays += 30;
              if (simFtmo(t, 2, rf).passed) pN++;
            }
            for (const w of oos15) {
              const t = runBi(
                cbtc15,
                "BTC",
                "1b",
                1,
                tp,
                stop,
                12,
                w.start,
                w.end,
                bpd15,
              );
              if (simFtmo(t, 2, rf).passed) pO++;
            }
            const rN = pN / wins15NO.length;
            const rO = pO / oos15.length;
            const tpd = totTrades / totDays;
            if (rN >= 0.5) {
              console.log(
                `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${(rf * 100).toFixed(0).padStart(3)}%   ${tpd.toFixed(1).padStart(5)}    ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
              );
            }
          }
        }
      }

      // ─── B: 5m bars with 2-bar trigger ───
      console.log("\n── B: 5m bars + 2-bar trigger ──");
      console.log(
        "tp%    stop%   hold(5m)   risk%   trades/day   NOV%   EV-NOV($)",
      );
      for (const tp of [0.008, 0.01, 0.012]) {
        for (const stop of [0.001, 0.0015]) {
          for (const hold of [24, 36, 48]) {
            for (const rf of [0.7, 1.0]) {
              let p = 0,
                totTrades = 0,
                totDays = 0;
              for (const w of wins5NO) {
                const t = runBi(
                  cbtc5,
                  "BTC",
                  "5m2b",
                  2,
                  tp,
                  stop,
                  hold,
                  w.start,
                  w.end,
                  bpd5,
                );
                totTrades += t.length;
                totDays += 30;
                if (simFtmo(t, 2, rf).passed) p++;
              }
              const r = p / wins5NO.length;
              const tpd = totTrades / totDays;
              if (r >= 0.5) {
                console.log(
                  `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(3)}b     ${(rf * 100).toFixed(0).padStart(3)}%   ${tpd.toFixed(1).padStart(5)}    ${(r * 100).toFixed(2).padStart(5)}%   +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
                );
              }
            }
          }
        }
      }

      // ─── C: Multi-asset BTC+ETH parallel (both V3 configs) ───
      console.log(
        "\n── C: BTC V3 + ETH V3 parallel (each asset with own params) ──",
      );
      console.log("risk-each%   trades/day   NOV%   OOS-OV%   EV-OOS($)");
      for (const rf of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
        let pN = 0,
          pO = 0,
          totTrades = 0,
          totDays = 0;
        for (const w of wins15NO) {
          const btcT = runBi(
            cbtc15,
            "BTC",
            "2b",
            2,
            0.012,
            0.001,
            12,
            w.start,
            w.end,
            bpd15,
          );
          const ethT = runBi(
            ceth15,
            "ETH",
            "2b",
            2,
            0.01,
            0.0015,
            12,
            w.start,
            w.end,
            bpd15,
          );
          const combined = [...btcT, ...ethT];
          totTrades += combined.length;
          totDays += 30;
          if (simFtmo(combined, 2, rf).passed) pN++;
        }
        for (const w of oos15) {
          const btcT = runBi(
            cbtc15,
            "BTC",
            "2b",
            2,
            0.012,
            0.001,
            12,
            w.start,
            w.end,
            bpd15,
          );
          const ethT = runBi(
            ceth15,
            "ETH",
            "2b",
            2,
            0.01,
            0.0015,
            12,
            w.start,
            w.end,
            bpd15,
          );
          if (simFtmo([...btcT, ...ethT], 2, rf).passed) pO++;
        }
        const rN = pN / wins15NO.length;
        const rO = pO / oos15.length;
        const tpd = totTrades / totDays;
        console.log(
          `  ${(rf * 100).toFixed(0).padStart(3)}%        ${tpd.toFixed(1).padStart(5)}    ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
        );
      }

      // ─── D: 2-bar + 3-bar stacked on BTC 15m ───
      console.log("\n── D: 2-bar + 3-bar stacked on BTC 15m ──");
      console.log("risk%   trades/day   NOV%   OOS-OV%   EV-OOS($)");
      for (const rf of [0.4, 0.5, 0.6, 0.7, 0.8]) {
        let pN = 0,
          pO = 0,
          totTrades = 0,
          totDays = 0;
        for (const w of wins15NO) {
          const t2 = runBi(
            cbtc15,
            "BTC",
            "2b",
            2,
            0.012,
            0.001,
            12,
            w.start,
            w.end,
            bpd15,
          );
          const t3 = runBi(
            cbtc15,
            "BTC",
            "3b",
            3,
            0.015,
            0.0015,
            16,
            w.start,
            w.end,
            bpd15,
          );
          const combined = [...t2, ...t3];
          totTrades += combined.length;
          totDays += 30;
          if (simFtmo(combined, 2, rf).passed) pN++;
        }
        for (const w of oos15) {
          const t2 = runBi(
            cbtc15,
            "BTC",
            "2b",
            2,
            0.012,
            0.001,
            12,
            w.start,
            w.end,
            bpd15,
          );
          const t3 = runBi(
            cbtc15,
            "BTC",
            "3b",
            3,
            0.015,
            0.0015,
            16,
            w.start,
            w.end,
            bpd15,
          );
          if (simFtmo([...t2, ...t3], 2, rf).passed) pO++;
        }
        const rN = pN / wins15NO.length;
        const rO = pO / oos15.length;
        const tpd = totTrades / totDays;
        console.log(
          `${(rf * 100).toFixed(0).padStart(3)}%   ${tpd.toFixed(1).padStart(5)}    ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
