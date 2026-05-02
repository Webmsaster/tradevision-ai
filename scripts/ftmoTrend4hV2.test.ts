/**
 * V2 push for the 4h Trend-Following champion (29.93%).
 *
 * Add more crypto assets, fine-tune R:R, add timeBoost, drop bad assets.
 * Goal: push toward 50%+ pass-rate while keeping the 1d/1d speed.
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
  return `${label.padEnd(38)} ${r.passes.toString().padStart(3)}/${r.windows} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

function makeTrend(sym: string, source: string): Daytrade24hAssetCfg {
  return {
    symbol: `${sym}-TREND`,
    sourceSymbol: source,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    disableLong: false,
    stopPct: 0.04,
    tpPct: 0.07,
    holdBars: 180,
  };
}

const POOL = [
  { sym: "ETH", source: "ETHUSDT" },
  { sym: "BTC", source: "BTCUSDT" },
  { sym: "BNB", source: "BNBUSDT" },
  { sym: "ADA", source: "ADAUSDT" },
  { sym: "LINK", source: "LINKUSDT" },
  { sym: "LTC", source: "LTCUSDT" },
  { sym: "DOT", source: "DOTUSDT" },
  { sym: "BCH", source: "BCHUSDT" },
  { sym: "XRP", source: "XRPUSDT" },
  { sym: "DOGE", source: "DOGEUSDT" },
  { sym: "MATIC", source: "MATICUSDT" },
  { sym: "AVAX", source: "AVAXUSDT" },
  { sym: "SOL", source: "SOLUSDT" },
];

describe("4h Trend V2 push", { timeout: 1800_000 }, () => {
  it("expanded asset pool + fine-tune", async () => {
    const candles: Record<string, Candle[]> = {};
    for (const a of POOL) {
      candles[a.source] = await loadBinanceHistory({
        symbol: a.source,
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    const n = Math.min(...Object.values(candles).map((c) => c.length));
    const data: Record<string, Candle[]> = {};
    for (const a of POOL) data[a.source] = candles[a.source].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / 6 / 365).toFixed(2)}y)\n`);

    // V1 winner: 4 assets ETH/BTC/BNB/ADA, trigger=1, sp=0.04 tp=0.07 hb=180
    const v1Assets = ["ETH", "BTC", "BNB", "ADA"].map((s) =>
      makeTrend(s, POOL.find((p) => p.sym === s)!.source),
    );
    let cur: FtmoDaytrade24hConfig = {
      triggerBars: 1,
      leverage: 2,
      tpPct: 0.07,
      stopPct: 0.04,
      holdBars: 180,
      timeframe: "4h",
      assets: v1Assets,
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      maxDays: 30,
      pauseAtTargetReached: true,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur);
    console.log(fmt("V1 BASELINE", baseR));

    // R1: greedy add from full pool
    console.log(`\n--- R1: greedy add more assets ---`);
    let r1Best = { cfg: cur, r: baseR };
    let candidates = POOL.filter(
      (p) => !["ETH", "BTC", "BNB", "ADA"].includes(p.sym),
    );
    while (true) {
      let stepBest: { cfg: FtmoDaytrade24hConfig; r: any; sym: string } | null =
        null;
      for (const c of candidates) {
        const trial = {
          ...r1Best.cfg,
          assets: [...r1Best.cfg.assets, makeTrend(c.sym, c.source)],
        };
        const r = runWalkForward(data, trial);
        if (score(r, r1Best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0)
            stepBest = { cfg: trial, r, sym: c.sym };
        }
      }
      if (stepBest === null) break;
      r1Best = { cfg: stepBest.cfg, r: stepBest.r };
      candidates = candidates.filter((c) => c.sym !== stepBest!.sym);
      console.log(fmt(`  +${stepBest.sym}`, stepBest.r));
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: fine-tune R:R
    console.log(`\n--- R2: R:R fine-grain ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const sp of [0.025, 0.03, 0.035, 0.04, 0.045, 0.05]) {
      for (const tp of [0.04, 0.05, 0.06, 0.07, 0.08, 0.1, 0.12, 0.15, 0.2]) {
        if (tp <= sp * 1.1) continue;
        const cfg = {
          ...cur,
          assets: cur.assets.map((a) => ({ ...a, stopPct: sp, tpPct: tp })),
        };
        const r = runWalkForward(data, cfg);
        if (score(r, r2Best.r) < 0) {
          r2Best = { cfg, r };
          console.log(fmt(`  sp=${sp} tp=${tp}`, r));
        }
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: triggerBars
    console.log(`\n--- R3: triggerBars ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const tb of [1, 2, 3]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) => ({ ...a, triggerBars: tb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        console.log(fmt(`  tb=${tb}`, r));
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: timeBoost
    console.log(`\n--- R4: timeBoost ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const day of [2, 4, 6, 12]) {
      for (const eb of [0.02, 0.05, 0.07]) {
        for (const f of [1.5, 2, 3]) {
          const cfg = {
            ...cur,
            timeBoost: { afterDay: day, equityBelow: eb, factor: f },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, r4Best.r) < 0) {
            r4Best = { cfg, r };
            console.log(fmt(`  tb d=${day} eb=${eb} f=${f}`, r));
          }
        }
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    // R5: adaptiveSizing tiers (early aggressive)
    console.log(`\n--- R5: adaptiveSizing ---`);
    let r5Best = { cfg: cur, r: r4Best.r };
    const sizings: Array<{ label: string; tiers: any[] }> = [
      { label: "off", tiers: [] },
      {
        label: "1.0/1.5",
        tiers: [
          { equityAbove: 0, factor: 1.0 },
          { equityAbove: 0.03, factor: 1.5 },
        ],
      },
      {
        label: "0.7/1.5/2.0",
        tiers: [
          { equityAbove: 0, factor: 0.7 },
          { equityAbove: 0.03, factor: 1.5 },
          { equityAbove: 0.06, factor: 2.0 },
        ],
      },
      {
        label: "0.5/1.0/2.0",
        tiers: [
          { equityAbove: 0, factor: 0.5 },
          { equityAbove: 0.02, factor: 1.0 },
          { equityAbove: 0.05, factor: 2.0 },
        ],
      },
    ];
    for (const s of sizings) {
      const cfg = {
        ...cur,
        adaptiveSizing: s.tiers.length ? s.tiers : undefined,
      };
      const r = runWalkForward(data, cfg);
      if (score(r, r5Best.r) < 0) {
        r5Best = { cfg, r };
        console.log(fmt(`  sizing ${s.label}`, r));
      }
    }
    cur = r5Best.cfg;
    console.log(fmt("R5 winner", r5Best.r));

    console.log(`\n========== TREND_4H_V2 FINAL ==========`);
    console.log(fmt("V1 baseline", baseR));
    console.log(fmt("V2 final   ", r5Best.r));
    console.log(
      `Δ V1→V2: +${((r5Best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(
      `\nFinal asset list: ${cur.assets.map((a) => a.symbol).join(", ")}`,
    );
    console.log(
      `Final R:R: stop ${(cur.assets[0].stopPct ?? cur.stopPct) * 100}% / tp ${(cur.assets[0].tpPct ?? cur.tpPct) * 100}%`,
    );
    console.log(`triggerBars: ${cur.assets[0].triggerBars ?? cur.triggerBars}`);
    if (cur.timeBoost)
      console.log(`timeBoost: ${JSON.stringify(cur.timeBoost)}`);
    if (cur.adaptiveSizing)
      console.log(`adaptiveSizing: ${JSON.stringify(cur.adaptiveSizing)}`);

    expect(r5Best.r.passRate).toBeGreaterThan(0);
  });
});
