/**
 * Iter 188 — REAL DAYTRADE for FTMO Normal Plan (24h max hold).
 *
 * User constraint (critical):
 *   • FTMO Normal Plan (not Swing)
 *   • Max 24h hold — overnight fees apply
 *   • Crypto 1:2 leverage
 *   • 40 bp BTC / 30 bp ETH / 40 bp SOL / 45 bp AVAX realistic spread
 *
 * Challenge: 40bp cost requires raw mean > 40bp to break even. Daytrade
 * 15m bars (iter180) had raw mean ~1-2bp → 0% pass. Need WIDE targets
 * but short hold.
 *
 * Test matrix:
 *   A) 1h bars, TP 1-5%, stop 0.3-1%, hold ≤ 24 bars (24h)
 *   B) 4h bars, TP 2-8%, stop 0.5-1.5%, hold ≤ 6 bars (24h)
 *   C) Multi-asset portfolio on 1h and 4h
 *   D) 15m bars last-ditch (big TP only)
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface Trade {
  rawPnl: number;
  day: number;
  entryTime: number;
  exitTime: number;
  symbol: string;
}

function run(
  c: Candle[],
  sym: string,
  tp: number,
  stop: number,
  holdBars: number,
  wS: number,
  wE: number,
  costBp: number,
  triggerBars: number,
  bpd: number,
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const cost = costBp / 10000;

  for (const dir of ["long", "short"] as const) {
    let cd = -1;
    for (let i = Math.max(triggerBars + 1, wS); i < wE - 1; i++) {
      if (i < cd) continue;
      let ok = true;
      for (let k = 0; k < triggerBars; k++) {
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
      const entryEff =
        dir === "long" ? entry * (1 + cost / 2) : entry * (1 - cost / 2);
      const tpPx = dir === "long" ? entry * (1 + tp) : entry * (1 - tp);
      const stPx = dir === "long" ? entry * (1 - stop) : entry * (1 + stop);
      const mx = Math.min(i + 1 + holdBars, wE - 1);
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
        dir === "long" ? xp * (1 - cost / 2) : xp * (1 + cost / 2);
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
          symbol: sym,
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

describe("iter 188 — 24h max hold daytrade", () => {
  it(
    "find best intraday @ realistic costs",
    { timeout: 1_200_000 },
    async () => {
      console.log("\n=== ITER 188: 24H HOLD DAYTRADE ===");
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"];
      const c1h: Record<string, Candle[]> = {};
      const c4h: Record<string, Candle[]> = {};
      for (const s of symbols) {
        c1h[s] = await loadBinanceHistory({
          symbol: s as "BTCUSDT",
          timeframe: "1h",
          targetCount: 50_000,
          maxPages: 200,
        });
        c4h[s] = await loadBinanceHistory({
          symbol: s as "BTCUSDT",
          timeframe: "4h",
          targetCount: 20_000,
          maxPages: 100,
        });
      }
      // Align
      const align1h = Math.min(...symbols.map((s) => c1h[s].length));
      const align4h = Math.min(...symbols.map((s) => c4h[s].length));
      for (const s of symbols) {
        c1h[s] = c1h[s].slice(c1h[s].length - align1h);
        c4h[s] = c4h[s].slice(c4h[s].length - align4h);
      }
      console.log(`Aligned: 1h=${align1h}, 4h=${align4h}\n`);

      const cost: Record<string, number> = {
        BTCUSDT: 40,
        ETHUSDT: 30,
        SOLUSDT: 40,
        AVAXUSDT: 45,
      };

      function mkWins(len: number, winBars: number) {
        const ws: { start: number; end: number }[] = [];
        for (let s = 0; s + winBars < len; s += winBars)
          ws.push({ start: s, end: s + winBars });
        return ws;
      }
      const bpd1h = 24;
      const bpd4h = 6;
      const w1h = mkWins(align1h, 30 * bpd1h);
      const w4h = mkWins(align4h, 30 * bpd4h);
      const cut1 = Math.floor(w1h.length * 0.6);
      const cut4 = Math.floor(w4h.length * 0.6);
      const oos1h = w1h.slice(cut1);
      const oos4h = w4h.slice(cut4);

      // ─── A: 1h bars sweep ───
      console.log(
        `── A: 1h bars (hold ≤ 24h), ${w1h.length} NOV, ${oos1h.length} OOS ──`,
      );
      console.log("tp%   stop%   hold   triggers  NOV%   OOS%   EV-OOS($)");
      for (const tp of [0.02, 0.03, 0.05, 0.08]) {
        for (const stop of [0.005, 0.01, 0.015]) {
          for (const hold of [12, 18, 24]) {
            for (const trig of [2, 3]) {
              let pN = 0,
                pO = 0;
              for (const w of w1h) {
                const all: Trade[] = [];
                for (const s of symbols) {
                  all.push(
                    ...run(
                      c1h[s],
                      s,
                      tp,
                      stop,
                      hold,
                      w.start,
                      w.end,
                      cost[s],
                      trig,
                      bpd1h,
                    ),
                  );
                }
                if (simFtmo(all, 2, 0.25).passed) pN++;
              }
              for (const w of oos1h) {
                const all: Trade[] = [];
                for (const s of symbols) {
                  all.push(
                    ...run(
                      c1h[s],
                      s,
                      tp,
                      stop,
                      hold,
                      w.start,
                      w.end,
                      cost[s],
                      trig,
                      bpd1h,
                    ),
                  );
                }
                if (simFtmo(all, 2, 0.25).passed) pO++;
              }
              const rN = pN / w1h.length;
              const rO = pO / oos1h.length;
              if (rN >= 0.25) {
                console.log(
                  `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(2)}h    ${trig}        ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
                );
              }
            }
          }
        }
      }

      // ─── B: 4h bars sweep ───
      console.log(
        `\n── B: 4h bars (hold ≤ 24h = 6 bars), ${w4h.length} NOV, ${oos4h.length} OOS ──`,
      );
      console.log("tp%   stop%   hold   triggers  NOV%   OOS%   EV-OOS($)");
      for (const tp of [0.02, 0.03, 0.05, 0.08, 0.1]) {
        for (const stop of [0.005, 0.01, 0.015, 0.02]) {
          for (const hold of [3, 4, 6]) {
            for (const trig of [2, 3]) {
              let pN = 0,
                pO = 0;
              for (const w of w4h) {
                const all: Trade[] = [];
                for (const s of symbols) {
                  all.push(
                    ...run(
                      c4h[s],
                      s,
                      tp,
                      stop,
                      hold,
                      w.start,
                      w.end,
                      cost[s],
                      trig,
                      bpd4h,
                    ),
                  );
                }
                if (simFtmo(all, 2, 0.25).passed) pN++;
              }
              for (const w of oos4h) {
                const all: Trade[] = [];
                for (const s of symbols) {
                  all.push(
                    ...run(
                      c4h[s],
                      s,
                      tp,
                      stop,
                      hold,
                      w.start,
                      w.end,
                      cost[s],
                      trig,
                      bpd4h,
                    ),
                  );
                }
                if (simFtmo(all, 2, 0.25).passed) pO++;
              }
              const rN = pN / w4h.length;
              const rO = pO / oos4h.length;
              if (rN >= 0.25) {
                console.log(
                  `${(tp * 100).toFixed(1).padStart(4)}%  ${(stop * 100).toFixed(2).padStart(4)}%  ${hold.toString().padStart(2)}    ${trig}        ${(rN * 100).toFixed(2).padStart(5)}%  ${(rO * 100).toFixed(2).padStart(5)}%   +$${(rO * 0.5 * 8000 - 99).toFixed(0)}`,
                );
              }
            }
          }
        }
      }

      // ─── C: Best combinations — risk sweep ───
      console.log("\n── C: Promising setups risk sweep ──");
      // Top from A/B probably tp=3-5% stop=1% hold~18h on 1h bars
      for (const rf of [0.2, 0.25, 0.33, 0.5, 0.7, 1.0]) {
        let pN = 0,
          pO = 0;
        for (const w of w1h) {
          const all: Trade[] = [];
          for (const s of symbols) {
            all.push(
              ...run(
                c1h[s],
                s,
                0.03,
                0.01,
                18,
                w.start,
                w.end,
                cost[s],
                2,
                bpd1h,
              ),
            );
          }
          if (simFtmo(all, 2, rf).passed) pN++;
        }
        for (const w of oos1h) {
          const all: Trade[] = [];
          for (const s of symbols) {
            all.push(
              ...run(
                c1h[s],
                s,
                0.03,
                0.01,
                18,
                w.start,
                w.end,
                cost[s],
                2,
                bpd1h,
              ),
            );
          }
          if (simFtmo(all, 2, rf).passed) pO++;
        }
        console.log(
          `  1h tp3% s1% h18 risk ${(rf * 100).toFixed(0)}%:  NOV ${((pN / w1h.length) * 100).toFixed(2)}%  OOS ${((pO / oos1h.length) * 100).toFixed(2)}%`,
        );
      }

      expect(true).toBe(true);
    },
  );
});
