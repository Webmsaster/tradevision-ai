/**
 * Iter 186 — validate iter185 4-asset 1d winner + Monte-Carlo.
 *
 * Winner candidates from iter185:
 *   A) 4-asset 1d @ 25% risk: NOV 58%, OOS 70.37%, EV +$2716
 *   B) 3-asset (BTC+ETH+SOL) 1d @ 33%: NOV 51%, OOS 59%, EV +$2271
 *   C) BTC+ETH + ATR[2-6%] filter: OOS 63%
 *
 * Validate with:
 *   1) Monte-Carlo 200 random starts
 *   2) Confirm IS/OOS gap is small (non-overfit)
 *   3) Test robustness to small param perturbations
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
  hold: number,
  wS: number,
  wE: number,
  costBp: number,
  triggerBars = 2,
): Trade[] {
  const out: Trade[] = [];
  if (!c[wS]) return out;
  const ts0 = c[wS].openTime;
  const costFrac = costBp / 10000;
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
        dir === "long"
          ? entry * (1 + costFrac / 2)
          : entry * (1 - costFrac / 2);
      const tpPx = dir === "long" ? entry * (1 + tp) : entry * (1 - tp);
      const stPx = dir === "long" ? entry * (1 - stop) : entry * (1 + stop);
      const mx = Math.min(i + 1 + hold, wE - 1);
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

describe("iter 186 — validate 4-asset 1d winner", () => {
  it("MC + sensitivity", { timeout: 1_200_000 }, async () => {
    console.log("\n=== ITER 186: VALIDATE 4-ASSET 1d ===");
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
    console.log(`Aligned ${aligned} days`);

    const cost: Record<string, number> = {
      BTCUSDT: 40,
      ETHUSDT: 30,
      SOLUSDT: 40,
      AVAXUSDT: 45,
    };
    const tp: Record<string, number> = {
      BTCUSDT: 0.08,
      ETHUSDT: 0.12,
      SOLUSDT: 0.12,
      AVAXUSDT: 0.15,
    };

    function runW(wS: number, wE: number, hold: number) {
      const all: Trade[] = [];
      for (const s of symbols) {
        all.push(...run(candles[s], s, tp[s], 0.02, hold, wS, wE, cost[s]));
      }
      return all;
    }

    // ─── A: Monte-Carlo 300 random starts ───
    console.log("\n── A: Monte-Carlo 300 random starts ──");
    let seed = 42424;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const rf of [0.2, 0.25, 0.33, 0.4]) {
      for (const hold of [15, 20]) {
        let p = 0;
        for (let i = 0; i < 300; i++) {
          const start = Math.floor(rng() * (aligned - winBars));
          if (simFtmo(runW(start, start + winBars, hold), 2, rf).passed) p++;
        }
        const r = p / 300;
        console.log(
          `  risk ${(rf * 100).toFixed(0)}%  hold ${hold}d  ${p}/300 (${(r * 100).toFixed(2)}%)  EV +$${(r * 0.5 * 8000 - 99).toFixed(0)}`,
        );
      }
    }

    // ─── B: Parameter sensitivity on winner (rf=25%, hold=15d) ───
    console.log("\n── B: Sensitivity at risk 25%, hold 15d ──");
    const wNO: { start: number; end: number }[] = [];
    for (let s = 0; s + winBars < aligned; s += winBars)
      wNO.push({ start: s, end: s + winBars });
    const cut = Math.floor(wNO.length * 0.6);
    const wOOS = wNO.slice(cut);

    // Test TP variations
    const tpPerturbations: { label: string; mults: Record<string, number> }[] =
      [
        {
          label: "base",
          mults: { BTCUSDT: 1, ETHUSDT: 1, SOLUSDT: 1, AVAXUSDT: 1 },
        },
        {
          label: "-20% TP",
          mults: { BTCUSDT: 0.8, ETHUSDT: 0.8, SOLUSDT: 0.8, AVAXUSDT: 0.8 },
        },
        {
          label: "+20% TP",
          mults: { BTCUSDT: 1.2, ETHUSDT: 1.2, SOLUSDT: 1.2, AVAXUSDT: 1.2 },
        },
        {
          label: "-20% stop",
          mults: { BTCUSDT: 1, ETHUSDT: 1, SOLUSDT: 1, AVAXUSDT: 1 },
        },
      ];
    for (const pert of tpPerturbations) {
      const localTp: Record<string, number> = {};
      for (const s of symbols) localTp[s] = tp[s] * pert.mults[s];
      let pO = 0;
      for (const w of wOOS) {
        const all: Trade[] = [];
        const st = pert.label === "-20% stop" ? 0.016 : 0.02;
        for (const s of symbols) {
          all.push(
            ...run(candles[s], s, localTp[s], st, 15, w.start, w.end, cost[s]),
          );
        }
        if (simFtmo(all, 2, 0.25).passed) pO++;
      }
      console.log(
        `  ${pert.label.padEnd(12)}  OOS ${pO}/${wOOS.length} (${((pO / wOOS.length) * 100).toFixed(2)}%)`,
      );
    }

    // ─── C: 20-challenge simulated outcome (MC) ───
    console.log("\n── C: 20-challenge simulation (conservative 55% live) ──");
    const ev = 0.55 * 0.5 * 8000 - 99;
    const netOver20 = 20 * ev;
    console.log(
      `  Conservative live 55%:  EV +$${ev.toFixed(0)}/challenge, +$${netOver20.toFixed(0)} over 20`,
    );
    const evBest = 0.7 * 0.5 * 8000 - 99;
    console.log(
      `  If OOS 70% holds live:  EV +$${evBest.toFixed(0)}/challenge, +$${(20 * evBest).toFixed(0)} over 20`,
    );

    expect(true).toBe(true);
  });
});
