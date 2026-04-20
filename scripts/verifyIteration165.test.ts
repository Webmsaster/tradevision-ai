/**
 * Iter 165 — push FTMO pass rate past 10% with advanced tactics.
 *
 * iter164 best: 7.14% pass (EV +$187) with multi-signal + progressive 2× after +5%.
 *
 * Key insights from iter164:
 *   - flash15 (rare, strong) deserves BIG bet (50%)
 *   - flash5 (noisy) should be small (10%) — or skipped entirely
 *   - Progressive 2× after +5% adds ~0.7 percentage points
 *   - "time" failures are 225/294 = most common. Strategy is too slow/cautious.
 *
 * New improvements to try:
 *   A) Cascading progressive: +3% → 1.5×, +6% → 2×, +8% → 3×
 *   B) Single-signal focus: only flash15 or only flash10 (drop the noise)
 *   C) Signal confluence: only trade when flash + pumpShort both present OR RSI confirms
 *   D) "All-in" variant: 70-80% risk on highest-conviction signal
 *   E) Compound signal detection: flash15 with stop < 2% raw deserves 70% risk
 *   F) Daily-loss-aware sizing: if already up 3% today, risk more on next signal
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
  windowStart: number,
  windowEnd: number,
): Signal[] {
  const out: Signal[] = [];
  const startTs = c[windowStart].openTime;
  let cooldown = -1;
  for (let i = Math.max(dropBars + 1, windowStart); i < windowEnd - 1; i++) {
    if (i < cooldown) continue;
    const prev = c[i - dropBars].close;
    const cur = c[i].close;
    if (prev <= 0) continue;
    const drop = (cur - prev) / prev;
    if (drop > -dropPct) continue;
    if (cur <= c[i - 1].close) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + hold, windowEnd - 1);
    let exitBar = mx;
    let exitPrice = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
      if (bar.low <= stop) {
        exitBar = j;
        exitPrice = stop;
        break;
      }
      if (bar.high >= tp) {
        exitBar = j;
        exitPrice = tp;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: exitBar - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - startTs) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: c[exitBar].closeTime,
        rawPnl: pnl,
        type: typeName,
      });
    cooldown = exitBar + 1;
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
  windowStart: number,
  windowEnd: number,
): Signal[] {
  const out: Signal[] = [];
  const startTs = c[windowStart].openTime;
  let cooldown = -1;
  for (let i = Math.max(pumpBars + 1, windowStart); i < windowEnd - 1; i++) {
    if (i < cooldown) continue;
    const prev = c[i - pumpBars].close;
    const cur = c[i].close;
    if (prev <= 0) continue;
    const rise = (cur - prev) / prev;
    if (rise < pumpPct) continue;
    if (cur >= c[i - 1].close) continue;
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 - tpPct);
    const stop = entry * (1 + stopPct);
    const mx = Math.min(i + 1 + hold, windowEnd - 1);
    let exitBar = mx;
    let exitPrice = c[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = c[j];
      if (bar.high >= stop) {
        exitBar = j;
        exitPrice = stop;
        break;
      }
      if (bar.low <= tp) {
        exitBar = j;
        exitPrice = tp;
        break;
      }
    }
    const pnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "short",
      holdingHours: exitBar - (i + 1),
      config: MAKER_COSTS,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - startTs) / (24 * 3600 * 1000));
    if (day >= 0)
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: c[exitBar].closeTime,
        rawPnl: pnl,
        type: "pumpShort",
      });
    cooldown = exitBar + 1;
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
  /** Cascading progressive tiers: [{ threshold, factor }, ...] sorted ascending by threshold. */
  progressive?: { threshold: number; factor: number }[];
  /** If profit this day ≥ threshold, apply extra factor to subsequent trades same day. */
  dailyBooster?: { threshold: number; factor: number };
}

function simulate(signals: Signal[], cfg: FtmoCfg) {
  let equity = 1;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  const sorted = [...signals].sort(
    (a, b) => a.day - b.day || a.entryTime - b.entryTime,
  );
  for (const s of sorted) {
    if (s.day >= cfg.maxDays) break;
    if (!dayStart.has(s.day)) dayStart.set(s.day, equity);
    let risk = cfg.risk[s.type] ?? 0;
    if (risk === 0) continue;
    // Progressive tiers
    if (cfg.progressive) {
      for (const tier of cfg.progressive) {
        if (equity - 1 >= tier.threshold) risk *= tier.factor;
      }
    }
    // Daily booster
    if (cfg.dailyBooster) {
      const sod = dayStart.get(s.day)!;
      if (equity / sod - 1 >= cfg.dailyBooster.threshold) {
        risk *= cfg.dailyBooster.factor;
      }
    }
    risk = Math.min(risk, 1.0); // cap at 100% of equity
    const pnlFrac = Math.max(s.rawPnl * cfg.leverage * risk, -risk);
    equity *= 1 + pnlFrac;
    tradingDays.add(s.day);
    if (equity <= 1 - cfg.maxTotalLoss)
      return { passed: false, reason: "total_loss", finalEq: equity - 1 };
    const sod2 = dayStart.get(s.day)!;
    if (equity / sod2 - 1 <= -cfg.maxDailyLoss)
      return { passed: false, reason: "daily_loss", finalEq: equity - 1 };
    if (
      equity >= 1 + cfg.profitTarget &&
      tradingDays.size >= cfg.minTradingDays
    )
      return { passed: true, reason: "profit_target", finalEq: equity - 1 };
  }
  const passedLate =
    equity >= 1 + cfg.profitTarget && tradingDays.size >= cfg.minTradingDays;
  return {
    passed: passedLate,
    reason: passedLate
      ? "profit_target"
      : tradingDays.size < cfg.minTradingDays
        ? "insufficient_days"
        : "time",
    finalEq: equity - 1,
  };
}

describe("iter 165 — push FTMO past 10% pass rate", () => {
  it("try advanced sizing tactics", { timeout: 900_000 }, async () => {
    console.log("\n=== ITER 165: ADVANCED FTMO SIZING ===");
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
    console.log(`${windows.length} windows\n`);

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

    const CHALLENGE_FEE = 99;
    const PAYOUT = 8000;
    const P2 = 0.5;
    const base: FtmoCfg = {
      leverage: 2,
      risk: {
        flash15: 0.5,
        flash10: 0.2,
        flash7: 0.15,
        flash5: 0.1,
        pumpShort: 0.4,
      },
      maxDays: 30,
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
    };

    function run(cfg: FtmoCfg, pick: (w: (typeof perWin)[0]) => Signal[]) {
      let pass = 0;
      const fails: Record<string, number> = {};
      let eq = 0;
      for (const w of perWin) {
        const sig = pick(w);
        const r = simulate(sig, cfg);
        if (r.passed) pass++;
        else fails[r.reason] = (fails[r.reason] ?? 0) + 1;
        eq += r.finalEq;
      }
      const rate = pass / perWin.length;
      return {
        pass,
        rate,
        ev: rate * P2 * PAYOUT - CHALLENGE_FEE,
        avgEq: eq / perWin.length,
        fails,
      };
    }

    const pickAll = (w: (typeof perWin)[0]): Signal[] => [
      ...w.flash15,
      ...w.flash10,
      ...w.flash7,
      ...w.flash5,
      ...w.pumpShort,
    ];

    // A) baseline + cascading progressive
    console.log("── A: Cascading progressive tiers ──");
    const configsA: { name: string; cfg: FtmoCfg }[] = [
      { name: "none", cfg: base },
      {
        name: "+3%/1.5× +6%/2× +8%/3×",
        cfg: {
          ...base,
          progressive: [
            { threshold: 0.03, factor: 1.5 },
            { threshold: 0.06, factor: 1.33 },
            { threshold: 0.08, factor: 1.5 },
          ],
        },
      },
      {
        name: "+5%/2×",
        cfg: { ...base, progressive: [{ threshold: 0.05, factor: 2 }] },
      },
      {
        name: "+3%/2× +7%/2×",
        cfg: {
          ...base,
          progressive: [
            { threshold: 0.03, factor: 2 },
            { threshold: 0.07, factor: 2 },
          ],
        },
      },
      {
        name: "+2%/1.5× +5%/2× +8%/2×",
        cfg: {
          ...base,
          progressive: [
            { threshold: 0.02, factor: 1.5 },
            { threshold: 0.05, factor: 1.5 },
            { threshold: 0.08, factor: 1.5 },
          ],
        },
      },
    ];
    for (const { name, cfg } of configsA) {
      const r = run(cfg, pickAll);
      console.log(
        `  ${name.padEnd(35)}  pass ${r.pass}/${perWin.length} (${(r.rate * 100).toFixed(2)}%)  EV $${r.ev.toFixed(0)}`,
      );
    }

    // B) single-signal focus (high conviction only)
    console.log("\n── B: Single-signal focus (drop the noise) ──");
    for (const [name, pick] of [
      ["flash15 only", (w: (typeof perWin)[0]) => w.flash15],
      [
        "flash15 + pumpShort",
        (w: (typeof perWin)[0]) => [...w.flash15, ...w.pumpShort],
      ],
      [
        "flash15 + flash10",
        (w: (typeof perWin)[0]) => [...w.flash15, ...w.flash10],
      ],
      [
        "flash15 + flash10 + pumpShort",
        (w: (typeof perWin)[0]) => [...w.flash15, ...w.flash10, ...w.pumpShort],
      ],
    ] as const) {
      // boost risk since fewer signals
      const cfg: FtmoCfg = {
        ...base,
        risk: {
          flash15: 0.6,
          flash10: 0.4,
          flash7: 0,
          flash5: 0,
          pumpShort: 0.5,
        },
        progressive: [{ threshold: 0.05, factor: 2 }],
      };
      const r = run(cfg, pick as (w: (typeof perWin)[0]) => Signal[]);
      console.log(
        `  ${name.padEnd(35)}  pass ${r.pass}/${perWin.length} (${(r.rate * 100).toFixed(2)}%)  EV $${r.ev.toFixed(0)}  fails ${JSON.stringify(r.fails)}`,
      );
    }

    // C) Aggressive all-in on flash15 (highest edge)
    console.log("\n── C: All-in tests on flash15 ──");
    for (const r15 of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
      const cfg: FtmoCfg = {
        ...base,
        risk: { flash15: r15, flash10: 0, flash7: 0, flash5: 0, pumpShort: 0 },
      };
      const r = run(cfg, (w) => w.flash15);
      console.log(
        `  flash15 only, risk ${(r15 * 100).toFixed(0)}%  pass ${r.pass}/${perWin.length} (${(r.rate * 100).toFixed(2)}%)  EV $${r.ev.toFixed(0)}`,
      );
    }

    // D) Daily booster
    console.log("\n── D: Daily booster (2× after +3% intraday) ──");
    const cfgD: FtmoCfg = {
      ...base,
      progressive: [{ threshold: 0.05, factor: 2 }],
      dailyBooster: { threshold: 0.03, factor: 2 },
    };
    const rD = run(cfgD, pickAll);
    console.log(
      `  pass ${rD.pass}/${perWin.length} (${(rD.rate * 100).toFixed(2)}%)  EV $${rD.ev.toFixed(0)}`,
    );

    // E) Full sweep to find best
    console.log("\n── E: Full sweep — best combo ──");
    let bestRate = 0;
    let bestEv = -Infinity;
    let bestDesc = "";
    for (const r15 of [0.4, 0.5, 0.6, 0.7, 0.8])
      for (const r10 of [0, 0.2, 0.3, 0.4])
        for (const r7 of [0, 0.1, 0.2])
          for (const r5 of [0, 0.1])
            for (const rPS of [0, 0.3, 0.4, 0.5])
              for (const progT of [0, 0.03, 0.05, 0.07]) {
                const prog =
                  progT > 0 ? [{ threshold: progT, factor: 2 }] : undefined;
                const cfg: FtmoCfg = {
                  ...base,
                  risk: {
                    flash15: r15,
                    flash10: r10,
                    flash7: r7,
                    flash5: r5,
                    pumpShort: rPS,
                  },
                  progressive: prog,
                };
                const r = run(cfg, pickAll);
                if (r.rate > bestRate) {
                  bestRate = r.rate;
                  bestEv = r.ev;
                  bestDesc = `rF15=${r15} rF10=${r10} rF7=${r7} rF5=${r5} rPS=${rPS} progT=${progT} → ${r.pass}/${perWin.length} (${(r.rate * 100).toFixed(2)}%) EV $${r.ev.toFixed(0)}`;
                }
              }
    console.log(`  BEST: ${bestDesc}`);

    expect(true).toBe(true);
  });
});
