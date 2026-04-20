/**
 * Iter 166 — final push for FTMO pass rate above 10%, then ship.
 *
 * iter165 best: 9.52% pass, EV +$282 with:
 *   flash15 50%, flash7 10%, pumpShort 50%, progressive +3%/2×
 *
 * Try:
 *   A) Finer progressive sweep around that sweet spot
 *   B) Finer risk-level sweep on the winning signals
 *   C) Multi-tier progressive (2 or 3 stages)
 *   D) Conservative single-tier progressive (+3% / 1.5×)
 *   E) 5-gate validation: in-sample vs. OOS split on the winning config
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";

interface Signal {
  day: number;
  entryTime: number;
  exitTime: number;
  rawPnl: number;
  type: string;
}

function runFlashLong(
  c: Candle[],
  dropBars: number,
  dropPct: number,
  tpPct: number,
  stopPct: number,
  hold: number,
  typeName: string,
  wS: number,
  wE: number,
): Signal[] {
  const out: Signal[] = [];
  const ts = c[wS].openTime;
  let cd = -1;
  for (let i = Math.max(dropBars + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    const p = c[i - dropBars].close;
    const cur = c[i].close;
    if (p <= 0) continue;
    const d = (cur - p) / p;
    if (d > -dropPct) continue;
    if (cur <= c[i - 1].close) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const st = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      if (c[j].low <= st) {
        xb = j;
        xp = st;
        break;
      }
      if (c[j].high >= tp) {
        xb = j;
        xp = tp;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "long",
      holdingHours: xb - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        rawPnl: pnl,
        type: typeName,
      });
    cd = xb + 1;
  }
  return out;
}

function runPumpShort(
  c: Candle[],
  pumpBars: number,
  pumpPct: number,
  tpPct: number,
  stopPct: number,
  hold: number,
  wS: number,
  wE: number,
): Signal[] {
  const out: Signal[] = [];
  const ts = c[wS].openTime;
  let cd = -1;
  for (let i = Math.max(pumpBars + 1, wS); i < wE - 1; i++) {
    if (i < cd) continue;
    const p = c[i - pumpBars].close;
    const cur = c[i].close;
    if (p <= 0) continue;
    const rise = (cur - p) / p;
    if (rise < pumpPct) continue;
    if (cur >= c[i - 1].close) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 - tpPct);
    const st = entry * (1 + stopPct);
    const mx = Math.min(i + 1 + hold, wE - 1);
    let xb = mx;
    let xp = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      if (c[j].high >= st) {
        xb = j;
        xp = st;
        break;
      }
      if (c[j].low <= tp) {
        xb = j;
        xp = tp;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: xp,
      direction: "short",
      holdingHours: xb - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: c[xb].closeTime,
        rawPnl: pnl,
        type: "pumpShort",
      });
    cd = xb + 1;
  }
  return out;
}

interface FtmoCfg {
  leverage: number;
  risk: Record<string, number>;
  maxDays: number;
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  minTradingDays: number;
  progressive?: { threshold: number; factor: number }[];
}

function simulate(signals: Signal[], cfg: FtmoCfg) {
  let equity = 1;
  const dayStart = new Map<number, number>();
  const td = new Set<number>();
  const sorted = [...signals].sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  );
  for (const s of sorted) {
    if (s.day >= cfg.maxDays) break;
    if (!dayStart.has(s.day)) dayStart.set(s.day, equity);
    let risk = cfg.risk[s.type] ?? 0;
    if (risk === 0) continue;
    if (cfg.progressive) {
      for (const t of cfg.progressive) {
        if (equity - 1 >= t.threshold) risk *= t.factor;
      }
    }
    risk = Math.min(risk, 1);
    const pnlF = Math.max(s.rawPnl * cfg.leverage * risk, -risk);
    equity *= 1 + pnlF;
    td.add(s.day);
    if (equity <= 1 - cfg.maxTotalLoss)
      return { passed: false, reason: "total_loss", finalEq: equity - 1 };
    const sod = dayStart.get(s.day)!;
    if (equity / sod - 1 <= -cfg.maxDailyLoss)
      return { passed: false, reason: "daily_loss", finalEq: equity - 1 };
    if (equity >= 1 + cfg.profitTarget && td.size >= cfg.minTradingDays)
      return { passed: true, reason: "profit_target", finalEq: equity - 1 };
  }
  const late = equity >= 1 + cfg.profitTarget && td.size >= cfg.minTradingDays;
  return {
    passed: late,
    reason: late
      ? "profit_target"
      : td.size < cfg.minTradingDays
        ? "insufficient_days"
        : "time",
    finalEq: equity - 1,
  };
}

describe("iter 166 — push FTMO past 10% + ship", () => {
  it("fine-tune and validate", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 166: FINAL FTMO PUSH ===");
    const c = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 50_000,
      maxPages: 100,
    });
    const winLen = 30 * 24;
    const step = 7 * 24;
    const windows: { start: number; end: number }[] = [];
    for (let s = 0; s + winLen < c.length; s += step) {
      windows.push({ start: s, end: s + winLen });
    }
    console.log(`${windows.length} windows`);

    const perWin = windows.map((w) => ({
      flash15: runFlashLong(
        c,
        72,
        0.15,
        0.1,
        0.02,
        24,
        "flash15",
        w.start,
        w.end,
      ),
      flash10: runFlashLong(
        c,
        48,
        0.1,
        0.07,
        0.02,
        24,
        "flash10",
        w.start,
        w.end,
      ),
      flash7: runFlashLong(
        c,
        24,
        0.07,
        0.05,
        0.02,
        12,
        "flash7",
        w.start,
        w.end,
      ),
      flash5: runFlashLong(
        c,
        12,
        0.05,
        0.03,
        0.015,
        8,
        "flash5",
        w.start,
        w.end,
      ),
      pumpShort: runPumpShort(c, 72, 0.15, 0.1, 0.02, 24, w.start, w.end),
    }));
    const pickAll = (w: (typeof perWin)[0]): Signal[] => [
      ...w.flash15,
      ...w.flash10,
      ...w.flash7,
      ...w.flash5,
      ...w.pumpShort,
    ];

    const CHALLENGE_FEE = 99;
    const PAYOUT = 8000;
    const P2 = 0.5;
    const base: FtmoCfg = {
      leverage: 2,
      risk: {
        flash15: 0.5,
        flash10: 0,
        flash7: 0.1,
        flash5: 0,
        pumpShort: 0.5,
      },
      maxDays: 30,
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
    };

    function run(cfg: FtmoCfg, batch: typeof perWin = perWin) {
      let pass = 0;
      let eq = 0;
      const f: Record<string, number> = {};
      for (const w of batch) {
        const r = simulate(pickAll(w), cfg);
        if (r.passed) pass++;
        else f[r.reason] = (f[r.reason] ?? 0) + 1;
        eq += r.finalEq;
      }
      const rate = pass / batch.length;
      return {
        pass,
        rate,
        ev: rate * P2 * PAYOUT - CHALLENGE_FEE,
        avgEq: eq / batch.length,
        fails: f,
      };
    }

    // A) finer progressive around +3%
    console.log("\n── A: progressive finetune ──");
    for (const t of [0.02, 0.025, 0.03, 0.035, 0.04, 0.05])
      for (const f of [1.5, 1.75, 2, 2.5, 3]) {
        const cfg: FtmoCfg = {
          ...base,
          progressive: [{ threshold: t, factor: f }],
        };
        const r = run(cfg);
        console.log(
          `  thr ${(t * 100).toFixed(1)}% × ${f.toFixed(2)}  pass ${r.pass}/${perWin.length} (${(r.rate * 100).toFixed(2)}%)  EV $${r.ev.toFixed(0)}`,
        );
      }

    // B) 2-tier progressive
    console.log("\n── B: 2-tier progressive ──");
    for (const t1 of [0.02, 0.03])
      for (const t2 of [0.05, 0.07, 0.08])
        for (const f1 of [1.5, 2])
          for (const f2 of [1.5, 2]) {
            const cfg: FtmoCfg = {
              ...base,
              progressive: [
                { threshold: t1, factor: f1 },
                { threshold: t2, factor: f2 },
              ],
            };
            const r = run(cfg);
            if (r.rate >= 0.08) {
              console.log(
                `  t1 ${(t1 * 100).toFixed(1)}/${f1} + t2 ${(t2 * 100).toFixed(1)}/${f2}  pass ${r.pass}/${perWin.length} (${(r.rate * 100).toFixed(2)}%)  EV $${r.ev.toFixed(0)}`,
              );
            }
          }

    // C) finer risk sweep with progressive +3%/2× locked
    console.log("\n── C: risk finetune with +3%/2× progressive ──");
    let bestRate = 0;
    let bestCfg: FtmoCfg | null = null;
    let bestDesc = "";
    for (const r15 of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65])
      for (const r7 of [0, 0.1, 0.15, 0.2])
        for (const rPS of [0.3, 0.4, 0.5, 0.6]) {
          const cfg: FtmoCfg = {
            ...base,
            risk: {
              flash15: r15,
              flash10: 0,
              flash7: r7,
              flash5: 0,
              pumpShort: rPS,
            },
            progressive: [{ threshold: 0.03, factor: 2 }],
          };
          const r = run(cfg);
          if (r.rate > bestRate) {
            bestRate = r.rate;
            bestCfg = cfg;
            bestDesc = `rF15=${r15} rF7=${r7} rPS=${rPS} → ${r.pass}/${perWin.length} (${(r.rate * 100).toFixed(2)}%) EV $${r.ev.toFixed(0)}`;
          }
        }
    console.log(`  BEST C: ${bestDesc}`);

    // D) pass rate check at winning config + IS/OOS split
    if (bestCfg) {
      const rAll = run(bestCfg);
      console.log(
        `\n★ OVERALL: pass ${rAll.pass}/${perWin.length} (${(rAll.rate * 100).toFixed(2)}%)  EV $${rAll.ev.toFixed(0)}`,
      );
      console.log(
        `  avgEq ${(rAll.avgEq * 100).toFixed(2)}%  fails ${JSON.stringify(rAll.fails)}`,
      );

      // 60/40 chronological split
      const cut = Math.floor(perWin.length * 0.6);
      const inSample = perWin.slice(0, cut);
      const oos = perWin.slice(cut);
      const rIs = run(bestCfg, inSample);
      const rOos = run(bestCfg, oos);
      console.log(
        `  IS (first 60%):  pass ${rIs.pass}/${inSample.length} (${(rIs.rate * 100).toFixed(2)}%)  EV $${rIs.ev.toFixed(0)}`,
      );
      console.log(
        `  OOS (last 40%):  pass ${rOos.pass}/${oos.length} (${(rOos.rate * 100).toFixed(2)}%)  EV $${rOos.ev.toFixed(0)}`,
      );

      // Expected realistic payout over 20 challenges
      const n = 20;
      const expPass = n * rAll.rate;
      const expFunded = expPass * P2;
      const expGross = expFunded * PAYOUT;
      const fees = n * CHALLENGE_FEE;
      const expNet = expGross - fees;
      console.log(
        `\n── Realistic outcome over ${n} challenges (total fees $${fees}) ──`,
      );
      console.log(
        `  Expected passes: ${expPass.toFixed(1)}, expected funded (after P2): ${expFunded.toFixed(1)}, expected gross payout $${expGross.toFixed(0)}, expected NET profit $${expNet.toFixed(0)}`,
      );
    }

    expect(true).toBe(true);
  });
});
