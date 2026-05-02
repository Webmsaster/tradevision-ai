/**
 * Last ceiling push: 2h Trend (faster) and 8h Trend (slower).
 * 4h V2 = 40-42%. Maybe 2h has more entry opportunities.
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

const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "SOLUSDT",
  "BCHUSDT",
  "DOGEUSDT",
];

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  tfHours: number,
  stepDays = 3,
) {
  const barsPerDay = 24 / tfHours;
  const winBars = Math.round(30 * barsPerDay);
  const stepBars = Math.round(stepDays * barsPerDay);
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
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: any) {
  return `${label.padEnd(35)} ${r.passes.toString().padStart(3)}/${r.windows} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

function makeTrendCfg(
  stopPct: number,
  tpPct: number,
  holdBars: number,
  triggerBars: number,
): FtmoDaytrade24hConfig {
  const assets: Daytrade24hAssetCfg[] = SOURCES.map((s) => ({
    symbol: `${s.replace("USDT", "")}-TREND`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars,
    invertDirection: true,
    disableShort: true,
    stopPct,
    tpPct,
    holdBars,
  }));
  return {
    triggerBars,
    leverage: 2,
    tpPct,
    stopPct,
    holdBars,
    timeframe: "4h",
    assets,
    profitTarget: 0.1,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    pauseAtTargetReached: true,
    liveCaps: LIVE_CAPS,
  };
}

describe("Trend 2h/8h exploration", { timeout: 1800_000 }, () => {
  it("scans timeframes around 4h", async () => {
    // Load 2h, 4h, 8h
    const data2h: Record<string, Candle[]> = {};
    const data4h: Record<string, Candle[]> = {};
    const data8h: Record<string, Candle[]> = {};

    console.log(`Loading 2h...`);
    for (const s of SOURCES)
      data2h[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    console.log(`Loading 4h...`);
    for (const s of SOURCES)
      data4h[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
    // 8h dropped (Binance API issue with this asset list)

    console.log(`\n--- 2h Trend variants ---`);
    let best2h = { name: "", r: { passRate: 0, p90Days: 999 } } as any;
    for (const tb of [1, 2, 3]) {
      for (const sp of [0.025, 0.035, 0.04, 0.05]) {
        for (const tp of [0.05, 0.07, 0.1]) {
          if (tp <= sp) continue;
          // 2h: holdBars=360 = 30d
          const cfg = makeTrendCfg(sp, tp, 360, tb);
          const r = runWalkForward(data2h, cfg, 2);
          if (score(r, best2h.r) < 0) {
            best2h = { name: `tb=${tb} sp=${sp} tp=${tp}`, r };
            console.log(fmt(`  2h ${best2h.name}`, r));
          }
        }
      }
    }
    console.log(fmt("BEST 2h", best2h.r));

    console.log(`\n--- 4h Trend (V2 baseline confirmation) ---`);
    const cfg4h = makeTrendCfg(0.05, 0.07, 180, 3);
    const r4h = runWalkForward(data4h, cfg4h, 4);
    console.log(fmt("4h V2-equivalent", r4h));

    console.log(`\n========== TF COMPARISON ==========`);
    console.log(fmt("2h trend", best2h.r));
    console.log(fmt("4h trend (V2)", r4h));

    expect(r4h.windows).toBeGreaterThan(50);
  });
});
