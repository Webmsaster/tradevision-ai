/**
 * EXPERIMENT: 4h Trend-Following with positive R:R.
 *
 * MR-shorts have structurally inverted R:R (TP=2.5%, Stop=5% → R:R 0.5:1).
 * That requires win-rate >67% for breakeven. Crypto MR delivers 55-65%.
 *
 * Trend-following can have R:R 2:1 or 3:1 (small Stop, large TP, ride momentum).
 * Lower win-rate (40-50%) is sufficient. Different edge characteristic.
 *
 * Setup: 4h, triggerBars=1-2, invertDirection=true (greens → LONG),
 * disableShort=true. Sweep TP/Stop combinations.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 4;
const BARS_PER_DAY = 6;
const CHALLENGE_DAYS = 30;
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
) {
  const winBars = CHALLENGE_DAYS * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  let totalTrades = 0;
  for (const r of out) {
    totalTrades += r.trades.length;
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p25Days: pick(0.25),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    totalTrades,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: ReturnType<typeof runWalkForward>) {
  return `${label.padEnd(38)} ${r.passes.toString().padStart(3)}/${r.windows} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  trades=${r.totalTrades}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

function makeTrendAsset(
  sym: string,
  source: string,
  opts: {
    triggerBars: number;
    stopPct: number;
    tpPct: number;
    holdBars?: number;
    minEqGain?: number;
  },
): Daytrade24hAssetCfg {
  return {
    symbol: `${sym}-TREND`,
    sourceSymbol: source,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: opts.triggerBars,
    invertDirection: true, // greens → long
    disableShort: true,
    disableLong: false,
    stopPct: opts.stopPct,
    tpPct: opts.tpPct,
    holdBars: opts.holdBars,
    minEquityGain: opts.minEqGain,
  };
}

const ASSETS = [
  { sym: "ETH", source: "ETHUSDT" },
  { sym: "BTC", source: "BTCUSDT" },
  { sym: "SOL", source: "SOLUSDT" },
  { sym: "BNB", source: "BNBUSDT" },
  { sym: "ADA", source: "ADAUSDT" },
];

describe("4h Trend-Following Exploration", { timeout: 1800_000 }, () => {
  it("sweeps R:R, triggers, and asset-mix", async () => {
    const candles: Record<string, Candle[]> = {};
    for (const a of ASSETS) {
      candles[a.source] = await loadBinanceHistory({
        symbol: a.source,
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
      console.log(`  ${a.source}: ${candles[a.source].length} bars`);
    }
    const n = Math.min(...Object.values(candles).map((c) => c.length));
    const data: Record<string, Candle[]> = {};
    for (const a of ASSETS) data[a.source] = candles[a.source].slice(-n);
    console.log(`\nAligned: ${n} bars (${(n / 6 / 365).toFixed(2)}y)\n`);

    const baseCfg: FtmoDaytrade24hConfig = {
      triggerBars: 1,
      leverage: 2,
      tpPct: 0.06,
      stopPct: 0.025,
      holdBars: 30, // 5 days
      timeframe: "4h",
      assets: ASSETS.map((a) =>
        makeTrendAsset(a.sym, a.source, {
          triggerBars: 1,
          stopPct: 0.025,
          tpPct: 0.06,
          holdBars: 30,
          minEqGain: 0,
        }),
      ),
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      maxDays: 30,
      pauseAtTargetReached: true,
      liveCaps: LIVE_CAPS,
    };

    console.log(`--- R0: baseline (1-bar trigger, R:R 2.4:1) ---`);
    const baseR = runWalkForward(data, baseCfg);
    console.log(fmt("BASELINE 5-asset all-trend", baseR));

    // R1: triggerBars sweep
    console.log(`\n--- R1: triggerBars ---`);
    let r1Best = { cfg: baseCfg, r: baseR };
    for (const tb of [1, 2, 3]) {
      const cfg = {
        ...baseCfg,
        assets: baseCfg.assets.map((a) => ({ ...a, triggerBars: tb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, r1Best.r) < 0) {
        r1Best = { cfg, r };
        console.log(fmt(`  tb=${tb}`, r));
      }
    }
    let cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: stopPct × tpPct grid (positive R:R focus)
    console.log(`\n--- R2: stopPct × tpPct (R:R focus) ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const sp of [0.015, 0.02, 0.025, 0.03, 0.04]) {
      for (const tp of [0.03, 0.05, 0.07, 0.1, 0.15]) {
        if (tp <= sp * 1.2) continue; // must have positive R:R
        const cfg = {
          ...cur,
          assets: cur.assets.map((a) => ({ ...a, stopPct: sp, tpPct: tp })),
        };
        const r = runWalkForward(data, cfg);
        if (score(r, r2Best.r) < 0) {
          r2Best = { cfg, r };
          console.log(
            fmt(`  sp=${sp} tp=${tp} (rr=${(tp / sp).toFixed(1)})`, r),
          );
        }
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: holdBars
    console.log(`\n--- R3: holdBars ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const hb of [12, 24, 30, 60, 90, 120, 180]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) => ({ ...a, holdBars: hb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        console.log(fmt(`  hb=${hb}`, r));
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: BTC-trend cross-asset filter (only LONG when BTC up)
    console.log(`\n--- R4: BTC-trend filter for longs ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const lb of [10, 20, 50, 100]) {
      for (const thr of [-0.1, -0.05, 0, 0.02, 0.05]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          // Use htfTrendFilter with apply: "long" — block longs if BTC fell
          htfTrendFilter: { lookbackBars: lb, apply: "long", threshold: thr },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, r4Best.r) < 0) {
          r4Best = { cfg, r };
          console.log(fmt(`  HTF lb=${lb} thr=${thr}`, r));
        }
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    // R5: drop bad-performing assets
    console.log(`\n--- R5: per-asset removal (greedy) ---`);
    let r5Best = { cfg: cur, r: r4Best.r };
    let assetsLeft = [...cur.assets];
    while (assetsLeft.length > 1) {
      let stepBest: {
        cfg: FtmoDaytrade24hConfig;
        r: any;
        removed: string;
      } | null = null;
      for (const removeMe of assetsLeft) {
        const trial = {
          ...r5Best.cfg,
          assets: assetsLeft.filter((a) => a.symbol !== removeMe.symbol),
        };
        const r = runWalkForward(data, trial);
        if (score(r, r5Best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0) {
            stepBest = { cfg: trial, r, removed: removeMe.symbol };
          }
        }
      }
      if (stepBest === null) break;
      r5Best = { cfg: stepBest.cfg, r: stepBest.r };
      assetsLeft = stepBest.cfg.assets;
      console.log(fmt(`  −${stepBest.removed}`, stepBest.r));
    }
    cur = r5Best.cfg;
    console.log(fmt("R5 winner", r5Best.r));

    console.log(`\n========== TREND-4H FINAL ==========`);
    console.log(fmt("Baseline   ", baseR));
    console.log(fmt("R1 trigger ", r1Best.r));
    console.log(fmt("R2 R:R     ", r2Best.r));
    console.log(fmt("R3 holdBars", r3Best.r));
    console.log(fmt("R4 BTC HTF ", r4Best.r));
    console.log(fmt("R5 assets  ", r5Best.r));
    console.log(
      `\nFinal asset list: ${cur.assets.map((a) => a.symbol).join(", ")}`,
    );
    console.log(
      `Final R:R: stop ${(cur.assets[0].stopPct ?? cur.stopPct) * 100}% / tp ${(cur.assets[0].tpPct ?? cur.tpPct) * 100}%`,
    );
    expect(r5Best.r.windows).toBeGreaterThan(50);
  });
});
