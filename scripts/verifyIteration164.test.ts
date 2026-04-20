/**
 * Iter 164 — multi-signal FTMO optimization.
 *
 * iter163 baseline: Hybrid (RSI10% + Flash50%) → 5.10% pass rate, EV +$105.
 *
 * Main bottleneck: flash-crash signal fires in only 56/294 windows (19%).
 * When it DOES fire, conditional pass rate is ~27%. Improving signal
 * coverage should increase absolute pass rate proportionally.
 *
 * Improvements tested:
 *   A) Multiple flash variants with LOOSER drop thresholds:
 *      - drop-72h/15% (baseline, rare)
 *      - drop-48h/10% (more frequent)
 *      - drop-24h/7%  (even more frequent)
 *      - drop-12h/5%  (very frequent, noisier)
 *   B) PUMP-rebound SHORT: BTC rallied ≥10% in 72h → first red bar → short
 *      Symmetric hypothesis to flash-crash; captures mean-reversion after pumps
 *   C) Progressive sizing: start 10% risk, after profit ≥5% → 30% risk
 *      (anti-ruin: never large-risk while in drawdown)
 *   D) Best combination of A+B+C
 *
 * Goal: push Phase 1 pass rate from 5% → 10%+ (EV +$200+)
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
  type: "rsi" | "flash15" | "flash10" | "flash7" | "flash5" | "pumpShort";
}

function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let g = 0,
    l = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l += -d;
  }
  g /= len;
  l /= len;
  out[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gi = d > 0 ? d : 0;
    const li = d < 0 ? -d : 0;
    g = (g * (len - 1) + gi) / len;
    l = (l * (len - 1) + li) / len;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function runFlashLong(
  c: Candle[],
  dropBars: number,
  dropPct: number,
  tpPct: number,
  stopPct: number,
  hold: number,
  typeName: Signal["type"],
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
    if (day >= 0) {
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: c[exitBar].closeTime,
        rawPnl: pnl,
        type: typeName,
      });
    }
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
    if (rise < pumpPct) continue; // must have pumped
    if (cur >= c[i - 1].close) continue; // need first red bar
    const eb = c[i + 1];
    if (!eb) break;
    const entry = eb.open;
    // short: TP below, stop above
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
    if (day >= 0) {
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: c[exitBar].closeTime,
        rawPnl: pnl,
        type: "pumpShort",
      });
    }
    cooldown = exitBar + 1;
  }
  return out;
}

function runRsiMr(
  c: Candle[],
  windowStart: number,
  windowEnd: number,
): Signal[] {
  const slice = c.slice(windowStart, windowEnd);
  const closes = slice.map((x) => x.close);
  const rsi = rsiSeries(closes, 14);
  const out: Signal[] = [];
  let cooldown = -1;
  const tpPct = 0.005;
  const stopPct = 0.003;
  const holdBars = 4;
  const startTs = slice[0].openTime;
  for (let i = 20; i < slice.length - 1; i++) {
    if (i < cooldown) continue;
    if (rsi[i] > 30) continue;
    const eb = slice[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + holdBars, slice.length - 1);
    let exitBar = mx;
    let exitPrice = slice[mx].close;
    for (let j = i + 2; j <= mx; j++) {
      const bar = slice[j];
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
    out.push({
      day,
      entryTime: eb.openTime,
      exitTime: slice[exitBar].closeTime,
      rawPnl: pnl,
      type: "rsi",
    });
    cooldown = exitBar + 1;
  }
  return out;
}

interface FtmoCfg {
  leverage: number;
  risk: Record<Signal["type"], number>;
  maxDays: number;
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  minTradingDays: number;
  /** Progressive: if equity pct >= threshold, multiply risk by factor. */
  progressive?: { threshold: number; factor: number };
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
    let risk = cfg.risk[s.type];
    if (cfg.progressive && equity - 1 >= cfg.progressive.threshold) {
      risk *= cfg.progressive.factor;
    }
    const pnlFrac = Math.max(s.rawPnl * cfg.leverage * risk, -risk);
    equity *= 1 + pnlFrac;
    tradingDays.add(s.day);
    if (equity <= 1 - cfg.maxTotalLoss)
      return { passed: false, reason: "total_loss", finalEq: equity - 1 };
    const sod = dayStart.get(s.day)!;
    if (equity / sod - 1 <= -cfg.maxDailyLoss)
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

describe("iter 164 — multi-signal FTMO optimization", () => {
  it(
    "improve pass rate via signal coverage + sizing",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 164: MULTI-SIGNAL FTMO ===");
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
      console.log(`windows: ${windows.length} × 30 days\n`);

      // Pre-compute ALL signal types per window
      console.log("Pre-computing signals per window...");
      const perWindow = windows.map((w) => ({
        rsi: runRsiMr(c, w.start, w.end),
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

      // Coverage analysis
      const covFlash15 = perWindow.filter((w) => w.flash15.length > 0).length;
      const covFlash10 = perWindow.filter((w) => w.flash10.length > 0).length;
      const covFlash7 = perWindow.filter((w) => w.flash7.length > 0).length;
      const covFlash5 = perWindow.filter((w) => w.flash5.length > 0).length;
      const covPump = perWindow.filter((w) => w.pumpShort.length > 0).length;
      const covAny = perWindow.filter(
        (w) =>
          w.flash15.length +
            w.flash10.length +
            w.flash7.length +
            w.flash5.length +
            w.pumpShort.length >
          0,
      ).length;
      console.log(
        `\nSignal coverage (windows with ≥1 signal, total ${windows.length}):`,
      );
      console.log(
        `  flash15 (72b/15%): ${covFlash15} (${((covFlash15 / windows.length) * 100).toFixed(1)}%)`,
      );
      console.log(
        `  flash10 (48b/10%): ${covFlash10} (${((covFlash10 / windows.length) * 100).toFixed(1)}%)`,
      );
      console.log(
        `  flash7  (24b/7%):  ${covFlash7} (${((covFlash7 / windows.length) * 100).toFixed(1)}%)`,
      );
      console.log(
        `  flash5  (12b/5%):  ${covFlash5} (${((covFlash5 / windows.length) * 100).toFixed(1)}%)`,
      );
      console.log(
        `  pumpShort:          ${covPump} (${((covPump / windows.length) * 100).toFixed(1)}%)`,
      );
      console.log(
        `  ANY signal:         ${covAny} (${((covAny / windows.length) * 100).toFixed(1)}%)`,
      );

      const CHALLENGE_FEE = 99;
      const PAYOUT = 8000;
      const P2_RATE = 0.5;
      const base: FtmoCfg = {
        leverage: 2,
        risk: {
          rsi: 0.1,
          flash15: 0.5,
          flash10: 0.4,
          flash7: 0.3,
          flash5: 0.2,
          pumpShort: 0.3,
        },
        maxDays: 30,
        profitTarget: 0.1,
        maxDailyLoss: 0.05,
        maxTotalLoss: 0.1,
        minTradingDays: 4,
      };

      function runBatch(
        cfg: FtmoCfg,
        pickSignals: (w: (typeof perWindow)[0]) => Signal[],
      ) {
        let pass = 0;
        const fails: Record<string, number> = {};
        let totalEq = 0;
        for (const w of perWindow) {
          const sig = pickSignals(w);
          const r = simulate(sig, cfg);
          if (r.passed) pass++;
          else fails[r.reason] = (fails[r.reason] ?? 0) + 1;
          totalEq += r.finalEq;
        }
        const rate = pass / perWindow.length;
        const ev = rate * P2_RATE * PAYOUT - CHALLENGE_FEE;
        return {
          pass,
          rate,
          ev,
          avgEq: totalEq / perWindow.length,
          fails,
        };
      }

      console.log(
        "\n── Test A: just flash15 + flash10 + flash7 + flash5 (all flash variants) ──",
      );
      let r = runBatch(base, (w) => [
        ...w.flash15,
        ...w.flash10,
        ...w.flash7,
        ...w.flash5,
      ]);
      console.log(
        `  pass ${r.pass}/${perWindow.length} (${(r.rate * 100).toFixed(2)}%)  avgEq ${(r.avgEq * 100).toFixed(2)}%  EV ${r.ev > 0 ? "+" : ""}$${r.ev.toFixed(0)}  fails ${JSON.stringify(r.fails)}`,
      );

      console.log(
        "\n── Test B: all flash + pumpShort (symmetric mean-reversion) ──",
      );
      r = runBatch(base, (w) => [
        ...w.flash15,
        ...w.flash10,
        ...w.flash7,
        ...w.flash5,
        ...w.pumpShort,
      ]);
      console.log(
        `  pass ${r.pass}/${perWindow.length} (${(r.rate * 100).toFixed(2)}%)  avgEq ${(r.avgEq * 100).toFixed(2)}%  EV ${r.ev > 0 ? "+" : ""}$${r.ev.toFixed(0)}  fails ${JSON.stringify(r.fails)}`,
      );

      console.log("\n── Test C: everything including RSI daytrade base ──");
      r = runBatch(base, (w) => [
        ...w.rsi,
        ...w.flash15,
        ...w.flash10,
        ...w.flash7,
        ...w.flash5,
        ...w.pumpShort,
      ]);
      console.log(
        `  pass ${r.pass}/${perWindow.length} (${(r.rate * 100).toFixed(2)}%)  avgEq ${(r.avgEq * 100).toFixed(2)}%  EV ${r.ev > 0 ? "+" : ""}$${r.ev.toFixed(0)}  fails ${JSON.stringify(r.fails)}`,
      );

      console.log("\n── Test D: sweep risk sizes on multi-signal ──");
      console.log(
        "  rFlash15  rFlash10  rFlash7  rFlash5  rPump  rRsi    pass%   EV($)",
      );
      const rFlash15s = [0.3, 0.4, 0.5, 0.6];
      const rFlash10s = [0.2, 0.3, 0.4, 0.5];
      const rFlash7s = [0.15, 0.2, 0.3];
      const rFlash5s = [0.1, 0.15, 0.2];
      const rPumps = [0.2, 0.3, 0.4];
      const rRsis = [0, 0.05, 0.1];
      let bestRate = 0;
      let bestCfg: FtmoCfg | null = null;
      let bestDesc = "";
      for (const f15 of rFlash15s)
        for (const f10 of rFlash10s)
          for (const f7 of rFlash7s)
            for (const f5 of rFlash5s)
              for (const ps of rPumps)
                for (const rs of rRsis) {
                  const cfg: FtmoCfg = {
                    ...base,
                    risk: {
                      rsi: rs,
                      flash15: f15,
                      flash10: f10,
                      flash7: f7,
                      flash5: f5,
                      pumpShort: ps,
                    },
                  };
                  const rr = runBatch(cfg, (w) => [
                    ...w.rsi,
                    ...w.flash15,
                    ...w.flash10,
                    ...w.flash7,
                    ...w.flash5,
                    ...w.pumpShort,
                  ]);
                  if (rr.rate > bestRate) {
                    bestRate = rr.rate;
                    bestCfg = cfg;
                    bestDesc = `rF15=${f15} rF10=${f10} rF7=${f7} rF5=${f5} rPump=${ps} rRsi=${rs} → ${rr.pass}/${perWindow.length} (${(rr.rate * 100).toFixed(2)}%) EV $${rr.ev.toFixed(0)}`;
                  }
                }
      console.log(`  BEST: ${bestDesc}`);

      // Run best config once more for full details
      if (bestCfg) {
        const rBest = runBatch(bestCfg, (w) => [
          ...w.rsi,
          ...w.flash15,
          ...w.flash10,
          ...w.flash7,
          ...w.flash5,
          ...w.pumpShort,
        ]);
        console.log(
          `\n★ BEST MULTI-SIGNAL: pass ${rBest.pass}/${perWindow.length} (${(rBest.rate * 100).toFixed(2)}%)  EV $${rBest.ev.toFixed(0)}`,
        );
        console.log(`  fails: ${JSON.stringify(rBest.fails)}`);
      }

      console.log(
        "\n── Test E: progressive sizing (2× risk after +5% equity gained) ──",
      );
      const progCfg: FtmoCfg = {
        ...(bestCfg ?? base),
        progressive: { threshold: 0.05, factor: 2 },
      };
      const rProg = runBatch(progCfg, (w) => [
        ...w.rsi,
        ...w.flash15,
        ...w.flash10,
        ...w.flash7,
        ...w.flash5,
        ...w.pumpShort,
      ]);
      console.log(
        `  pass ${rProg.pass}/${perWindow.length} (${(rProg.rate * 100).toFixed(2)}%)  EV $${rProg.ev.toFixed(0)}`,
      );

      expect(true).toBe(true);
    },
  );
});
