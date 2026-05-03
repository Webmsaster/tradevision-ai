/**
 * Quick Win 1: 12h Trend exploration.
 * Cleaner trends on longer TF — test against 2h V3 baseline.
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

const TF_HOURS = 12;
const BARS_PER_DAY = 2;
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
  stepDays = 3,
) {
  const winBars = 30 * BARS_PER_DAY;
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
  return `${label.padEnd(30)} ${r.passes.toString().padStart(3)}/${r.windows} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

function makeTrend(
  s: string,
  sp: number,
  tp: number,
  hb: number,
  tb: number,
): Daytrade24hAssetCfg {
  return {
    symbol: `${s.replace("USDT", "")}-TREND`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: tb,
    invertDirection: true,
    disableShort: true,
    stopPct: sp,
    tpPct: tp,
    holdBars: hb,
  };
}

describe("12h Trend exploration", { timeout: 1800_000 }, () => {
  it("sweeps R:R, triggers on 12h", async () => {
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES)
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "1d",
        targetCount: 5000,
        maxPages: 10,
      });
    // 12h is not directly available — use 1d as proxy if 12h unavailable
    const data12h: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      try {
        data12h[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "12h" as any,
          targetCount: 6000,
          maxPages: 10,
        });
      } catch (e) {
        console.log(`12h load failed for ${s}: ${e}`);
      }
    }
    const useData =
      Object.keys(data12h).length === SOURCES.length ? data12h : data;
    const tfHrs = Object.keys(data12h).length === SOURCES.length ? 12 : 24;
    const barsDay = 24 / tfHrs;
    console.log(`Using ${tfHrs}h candles | ${SOURCES.length} assets`);
    const n = Math.min(...Object.values(useData).map((c) => c.length));
    for (const s of SOURCES) useData[s] = useData[s].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / barsDay / 365).toFixed(2)}y)\n`);

    let best = { name: "", r: { passRate: 0, p90Days: 999 } as any };
    for (const tb of [1, 2]) {
      for (const sp of [0.025, 0.04, 0.05]) {
        for (const tp of [0.05, 0.07, 0.1]) {
          if (tp <= sp) continue;
          const hb = 30 * barsDay; // 30d
          const cfg: FtmoDaytrade24hConfig = {
            triggerBars: tb,
            leverage: 2,
            tpPct: tp,
            stopPct: sp,
            holdBars: hb,
            timeframe: "4h" as any,
            assets: SOURCES.map((s) => makeTrend(s, sp, tp, hb, tb)),
            profitTarget: 0.1,
            maxDailyLoss: 0.05,
            maxTotalLoss: 0.1,
            minTradingDays: 4,
            maxDays: 30,
            pauseAtTargetReached: true,
            liveCaps: LIVE_CAPS,
          };
          const r = runWalkForward(useData, cfg);
          if (score(r, best.r) < 0) {
            best = { name: `tb=${tb} sp=${sp} tp=${tp}`, r };
            console.log(fmt(`  ${best.name}`, r));
          }
        }
      }
    }
    console.log(`\nBEST ${tfHrs}h: ${best.name}`);
    console.log(fmt("Best 12h/1d", best.r));
    console.log(`Compare V3 (2h): 43,52% / 1d / p90 2d`);
    expect(best.r.windows).toBeGreaterThan(20);
  });
});
