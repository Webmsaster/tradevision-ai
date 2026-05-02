/**
 * Max-history validation of LIVE_5M_V1 (analog zu ftmoLive15mMaxHistory).
 *
 * 5m: 288 bars/day. SOL listing 2020-08 limits to ~5.7y → ~600k bars.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

const CHALLENGE_DAYS = 30;
const BARS_PER_DAY = 288;

interface BatchResult {
  passes: number;
  windows: number;
  passRate: number;
  medianDays: number;
  p25Days: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  totalTrades: number;
  ev: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  stepDays = 3,
): BatchResult {
  assertAligned(byAsset);
  const winBars = Math.round(CHALLENGE_DAYS * BARS_PER_DAY);
  const stepBars = Math.round(stepDays * BARS_PER_DAY);
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  let totalTrades = 0;
  for (const r of out) {
    totalTrades += r.trades.length;
    if (r.passed) passDays.push(computePassDay(r));
  }
  passDays.sort((a, b) => a - b);
  const px = (q: number) => {
    const v = pick(passDays, q);
    return Number.isNaN(v) ? 0 : v;
  };
  return {
    passes,
    windows: out.length,
    passRate: passes / out.length,
    medianDays: px(0.5),
    p25Days: px(0.25),
    p75Days: px(0.75),
    p90Days: px(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    totalTrades,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(30)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

describe("LIVE_5M_V1 — max history", { timeout: 1800_000 }, () => {
  it("loads max 5m history and runs full walk-forward", async () => {
    // 5m: 5.71y * 288 * 365 = ~600k bars. 600 pages of 1000.
    const targetCount = 700000;
    const maxPages = 700;

    console.log(
      `\n=== Loading max 5m history (target ${targetCount}, max ${maxPages} pages) ===`,
    );
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "5m",
      targetCount,
      maxPages,
    });

    const ethYrs = (eth.length / BARS_PER_DAY / 365).toFixed(2);
    const btcYrs = (btc.length / BARS_PER_DAY / 365).toFixed(2);
    const solYrs = (sol.length / BARS_PER_DAY / 365).toFixed(2);
    console.log(`  ETH: ${eth.length} bars (${ethYrs}y)`);
    console.log(`  BTC: ${btc.length} bars (${btcYrs}y)`);
    console.log(`  SOL: ${sol.length} bars (${solYrs}y)`);

    const n = Math.min(eth.length, btc.length, sol.length);
    const data: Record<string, Candle[]> = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    const yrs = (n / BARS_PER_DAY / 365).toFixed(2);
    console.log(`  → aligned: ${n} bars (${yrs}y)`);

    // 1) Full
    console.log(`\n=== FULL WALK-FORWARD ===`);
    const full = runWalkForward(data);
    console.log(fmt("LIVE_5M_V1 (full)", full));

    // 2) Per-year
    console.log(`\n=== PER-YEAR BREAKDOWN ===`);
    const startYear = new Date(data.ETHUSDT[0].openTime).getUTCFullYear();
    const endYear = new Date(data.ETHUSDT[n - 1].closeTime).getUTCFullYear();
    for (let y = startYear; y <= endYear; y++) {
      const yStart = Date.UTC(y, 0, 1);
      const yEnd = Date.UTC(y + 1, 0, 1);
      const sliceFn = (arr: Candle[]) =>
        arr.filter((c) => c.openTime >= yStart && c.openTime < yEnd);
      const yearData = {
        ETHUSDT: sliceFn(data.ETHUSDT),
        BTCUSDT: sliceFn(data.BTCUSDT),
        SOLUSDT: sliceFn(data.SOLUSDT),
      };
      const minLen = Math.min(...Object.values(yearData).map((a) => a.length));
      if (minLen < CHALLENGE_DAYS * BARS_PER_DAY) {
        console.log(`  ${y}: insufficient data (${minLen} bars)`);
        continue;
      }
      const yr = runWalkForward(yearData);
      console.log(fmt(`  ${y}`, yr));
    }

    // 3) Train/Test
    console.log(`\n=== TRAIN/TEST OVERFIT CHECK ===`);
    const half = Math.floor(n / 2);
    const train = {
      ETHUSDT: data.ETHUSDT.slice(0, half),
      BTCUSDT: data.BTCUSDT.slice(0, half),
      SOLUSDT: data.SOLUSDT.slice(0, half),
    };
    const test = {
      ETHUSDT: data.ETHUSDT.slice(half),
      BTCUSDT: data.BTCUSDT.slice(half),
      SOLUSDT: data.SOLUSDT.slice(half),
    };
    const trainR = runWalkForward(train);
    const testR = runWalkForward(test);
    console.log(fmt("Train (1st half)", trainR));
    console.log(fmt("Test  (2nd half)", testR));
    console.log(
      `  Δ pass: ${((testR.passRate - trainR.passRate) * 100).toFixed(2)}pp · Δ median: ${testR.medianDays - trainR.medianDays}d`,
    );

    expect(full.windows).toBeGreaterThan(50);
  });
});
