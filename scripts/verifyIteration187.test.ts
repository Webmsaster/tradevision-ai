/**
 * Iter 187 — NO-WEEKEND-HOLD Crypto Strategy.
 *
 * User: "ich habe keinen swing plan sondern anderen"
 *
 * Constraint: no overnight holds over weekend (Normal/Aggressive FTMO plans).
 * Strategy: Entry Mon-Thu only, force close by Fri close.
 * Max hold = 4 weekdays.
 *
 * Test on iter186 4-asset 1d setup but with weekend-constraint enforced.
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

function dayOfWeek(ts: number): number {
  return new Date(ts).getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
}

function run(
  c: Candle[],
  sym: string,
  tp: number,
  stop: number,
  maxHoldDays: number,
  wS: number,
  wE: number,
  costBp: number,
  triggerBars = 2,
  noWeekend = true,
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const cost = costBp / 10000;

  for (const dir of ["long", "short"] as const) {
    let cd = -1;
    for (let i = Math.max(triggerBars + 1, wS); i < wE - 1; i++) {
      if (i < cd) continue;

      // Entry day check: only Mon-Thu when noWeekend
      if (noWeekend) {
        const entryDow = dayOfWeek(c[i + 1].openTime);
        if (entryDow < 1 || entryDow > 4) continue; // only Mon(1)-Thu(4)
      }

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
      const mx = Math.min(i + 1 + maxHoldDays, wE - 1);

      let xb = mx;
      let xp = c[mx].close;
      for (let j = i + 2; j <= mx; j++) {
        const bar = c[j];

        // Force close at Friday close if noWeekend
        if (noWeekend) {
          const dow = dayOfWeek(bar.openTime);
          if (dow === 5) {
            // Close on Friday (use close price of Friday)
            xb = j;
            xp = bar.close;
            break;
          }
        }

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

describe("iter 187 — no-weekend-hold crypto", () => {
  it(
    "find best config with weekend constraint",
    { timeout: 1_200_000 },
    async () => {
      console.log("\n=== ITER 187: NO-WEEKEND-HOLD ===");
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"];
      const candles: Record<string, Candle[]> = {};
      for (const s of symbols) {
        candles[s] = await loadBinanceHistory({
          symbol: s as "BTCUSDT",
          timeframe: "1d",
          targetCount: 3000,
          maxPages: 50,
        });
      }
      const minTs = Math.max(...symbols.map((s) => candles[s][0].openTime));
      for (const s of symbols) {
        const idx = candles[s].findIndex((c) => c.openTime >= minTs);
        candles[s] = candles[s].slice(idx);
      }
      const aligned = Math.min(...symbols.map((s) => candles[s].length));
      const winBars = 30;
      const wNO: { start: number; end: number }[] = [];
      for (let s = 0; s + winBars < aligned; s += winBars)
        wNO.push({ start: s, end: s + winBars });
      const cut = Math.floor(wNO.length * 0.6);
      const wOOS = wNO.slice(cut);
      console.log(
        `Aligned ${aligned} days, ${wNO.length} NOV (OOS ${wOOS.length})\n`,
      );

      const cost: Record<string, number> = {
        BTCUSDT: 40,
        ETHUSDT: 30,
        SOLUSDT: 40,
        AVAXUSDT: 45,
      };

      function runW(
        wS: number,
        wE: number,
        tps: Record<string, number>,
        stop: number,
        maxHold: number,
        triggerBars = 2,
        noWknd = true,
      ) {
        const all: Trade[] = [];
        for (const s of symbols) {
          all.push(
            ...run(
              candles[s],
              s,
              tps[s],
              stop,
              maxHold,
              wS,
              wE,
              cost[s],
              triggerBars,
              noWknd,
            ),
          );
        }
        return all;
      }

      // ─── A: Compare iter186 (20d hold, weekend ok) vs no-weekend (4d max) ───
      console.log("── A: Weekend allowed vs no-weekend (4d max hold) ──");
      const tps186 = {
        BTCUSDT: 0.08,
        ETHUSDT: 0.12,
        SOLUSDT: 0.12,
        AVAXUSDT: 0.15,
      };
      for (const [name, noWknd, maxHold] of [
        ["iter186 (20d, weekend ok)", false, 20],
        ["no-weekend (4d max)", true, 4],
        ["no-weekend (3d max)", true, 3],
        ["no-weekend (5d max)", true, 5],
      ] as const) {
        let pN = 0,
          pO = 0;
        for (const w of wNO) {
          if (
            simFtmo(
              runW(w.start, w.end, tps186, 0.02, maxHold, 2, noWknd),
              2,
              0.25,
            ).passed
          )
            pN++;
        }
        for (const w of wOOS) {
          if (
            simFtmo(
              runW(w.start, w.end, tps186, 0.02, maxHold, 2, noWknd),
              2,
              0.25,
            ).passed
          )
            pO++;
        }
        console.log(
          `  ${name.padEnd(30)}  NOV ${((pN / wNO.length) * 100).toFixed(2)}%  OOS ${((pO / wOOS.length) * 100).toFixed(2)}%`,
        );
      }

      // ─── B: Smaller TPs (since hold is shorter) ───
      console.log("\n── B: Smaller TPs for short hold (no-weekend, 4d max) ──");
      for (const [btp, etp] of [
        [0.03, 0.04],
        [0.04, 0.05],
        [0.05, 0.07],
        [0.06, 0.08],
        [0.08, 0.1],
      ] as const) {
        const tps = {
          BTCUSDT: btp,
          ETHUSDT: etp,
          SOLUSDT: etp,
          AVAXUSDT: etp * 1.2,
        };
        let pN = 0,
          pO = 0;
        for (const w of wNO) {
          if (
            simFtmo(runW(w.start, w.end, tps, 0.015, 4, 2, true), 2, 0.25)
              .passed
          )
            pN++;
        }
        for (const w of wOOS) {
          if (
            simFtmo(runW(w.start, w.end, tps, 0.015, 4, 2, true), 2, 0.25)
              .passed
          )
            pO++;
        }
        console.log(
          `  tpB ${(btp * 100).toFixed(1)}%  tpE ${(etp * 100).toFixed(1)}%  NOV ${((pN / wNO.length) * 100).toFixed(2)}%  OOS ${((pO / wOOS.length) * 100).toFixed(2)}%`,
        );
      }

      // ─── C: Risk sweep on best config ───
      console.log(
        "\n── C: Risk sweep (tpB=4% tpE=5% tpS=5% tpA=6% stop 1.5% 4d) ──",
      );
      const tpsC = {
        BTCUSDT: 0.04,
        ETHUSDT: 0.05,
        SOLUSDT: 0.05,
        AVAXUSDT: 0.06,
      };
      for (const rf of [0.2, 0.25, 0.33, 0.5, 0.7, 1.0]) {
        let pN = 0,
          pO = 0;
        for (const w of wNO) {
          if (
            simFtmo(runW(w.start, w.end, tpsC, 0.015, 4, 2, true), 2, rf).passed
          )
            pN++;
        }
        for (const w of wOOS) {
          if (
            simFtmo(runW(w.start, w.end, tpsC, 0.015, 4, 2, true), 2, rf).passed
          )
            pO++;
        }
        console.log(
          `  risk ${(rf * 100).toFixed(0)}%  NOV ${((pN / wNO.length) * 100).toFixed(2)}%  OOS ${((pO / wOOS.length) * 100).toFixed(2)}%  EV +$${((pO / wOOS.length) * 0.5 * 8000 - 99).toFixed(0)}`,
        );
      }

      // ─── D: Single-bar trigger (higher freq) with tight short hold ───
      console.log("\n── D: 1-bar trigger (more signals) no-weekend ──");
      for (const [btp, etp] of [
        [0.02, 0.025],
        [0.03, 0.035],
        [0.04, 0.05],
      ] as const) {
        const tps = {
          BTCUSDT: btp,
          ETHUSDT: etp,
          SOLUSDT: etp,
          AVAXUSDT: etp * 1.2,
        };
        for (const rf of [0.25, 0.5]) {
          let pN = 0,
            pO = 0;
          for (const w of wNO) {
            if (
              simFtmo(runW(w.start, w.end, tps, 0.01, 3, 1, true), 2, rf).passed
            )
              pN++;
          }
          for (const w of wOOS) {
            if (
              simFtmo(runW(w.start, w.end, tps, 0.01, 3, 1, true), 2, rf).passed
            )
              pO++;
          }
          console.log(
            `  1-bar tpB ${(btp * 100).toFixed(1)}% risk ${(rf * 100).toFixed(0)}%  NOV ${((pN / wNO.length) * 100).toFixed(2)}%  OOS ${((pO / wOOS.length) * 100).toFixed(2)}%`,
          );
        }
      }

      expect(true).toBe(true);
    },
  );
});
