/**
 * Maximum-history validation of LIVE_15M_V1.
 *
 * The original tuning sweep used 60k bars / 1.71y (Binance default loader).
 * This re-runs LIVE_15M_V1 on the LONGEST 15m history Binance can serve
 * for ETH/BTC/SOL (capped by SOL's 2020-08 listing → ~5.7y theoretical max).
 *
 * Reports:
 *   - Full-history walk-forward (pass-rate, median, p90, EV)
 *   - Per-year breakdown (yearly pass-rate)
 *   - Train (first half) vs Test (second half) → overfit check
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

const CHALLENGE_DAYS = 30;
const BARS_PER_DAY_15M = 96;
const TF_HOURS = 0.25;

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
  const winBars = Math.round(CHALLENGE_DAYS * BARS_PER_DAY_15M);
  const stepBars = Math.round(stepDays * BARS_PER_DAY_15M);
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1));
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

describe(
  "LIVE_15M_V1 — maximum history validation",
  { timeout: 1800_000 },
  () => {
    it("loads max Binance 15m history and runs full walk-forward", async () => {
      // 250k bars × 1000/page = 250 pages max. SOL 15m listing ~2020-08
      // limits theoretical max to ~5.7y / ~200k bars.
      const targetCount = 250000;
      const maxPages = 250;

      console.log(
        `\n=== Loading max 15m history (target ${targetCount}, max ${maxPages} pages) ===`,
      );
      const eth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "15m",
        targetCount,
        maxPages,
      });
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "15m",
        targetCount,
        maxPages,
      });
      const sol = await loadBinanceHistory({
        symbol: "SOLUSDT",
        timeframe: "15m",
        targetCount,
        maxPages,
      });

      const ethYrs = (eth.length / BARS_PER_DAY_15M / 365).toFixed(2);
      const btcYrs = (btc.length / BARS_PER_DAY_15M / 365).toFixed(2);
      const solYrs = (sol.length / BARS_PER_DAY_15M / 365).toFixed(2);
      console.log(`  ETH: ${eth.length} bars (${ethYrs}y)`);
      console.log(`  BTC: ${btc.length} bars (${btcYrs}y)`);
      console.log(`  SOL: ${sol.length} bars (${solYrs}y)`);

      const n = Math.min(eth.length, btc.length, sol.length);
      const data: Record<string, Candle[]> = {
        ETHUSDT: eth.slice(-n),
        BTCUSDT: btc.slice(-n),
        SOLUSDT: sol.slice(-n),
      };
      const yrs = (n / BARS_PER_DAY_15M / 365).toFixed(2);
      console.log(`  → aligned: ${n} bars (${yrs}y, limited by SOL)`);

      // 1) Full-history walk-forward
      console.log(`\n=== FULL WALK-FORWARD ===`);
      const full = runWalkForward(data);
      console.log(fmt("LIVE_15M_V1 (full)", full));

      // 2) Per-year breakdown
      console.log(`\n=== PER-YEAR BREAKDOWN ===`);
      const startTs = data.ETHUSDT[0].openTime;
      const endTs = data.ETHUSDT[n - 1].closeTime;
      const startYear = new Date(startTs).getUTCFullYear();
      const endYear = new Date(endTs).getUTCFullYear();
      for (let y = startYear; y <= endYear; y++) {
        const yStart = Date.UTC(y, 0, 1);
        const yEnd = Date.UTC(y + 1, 0, 1);
        const sliceFn = (arr: Candle[]) =>
          arr.filter((c) => c.openTime >= yStart && c.openTime < yEnd);
        const yearData: Record<string, Candle[]> = {
          ETHUSDT: sliceFn(data.ETHUSDT),
          BTCUSDT: sliceFn(data.BTCUSDT),
          SOLUSDT: sliceFn(data.SOLUSDT),
        };
        const minLen = Math.min(
          ...Object.values(yearData).map((a) => a.length),
        );
        if (minLen < CHALLENGE_DAYS * BARS_PER_DAY_15M) {
          console.log(`  ${y}: insufficient data (${minLen} bars)`);
          continue;
        }
        const yr = runWalkForward(yearData);
        console.log(fmt(`  ${y}`, yr));
      }

      // 3) Train (first half) vs Test (second half)
      console.log(`\n=== TRAIN/TEST OVERFIT CHECK ===`);
      const half = Math.floor(n / 2);
      const train: Record<string, Candle[]> = {
        ETHUSDT: data.ETHUSDT.slice(0, half),
        BTCUSDT: data.BTCUSDT.slice(0, half),
        SOLUSDT: data.SOLUSDT.slice(0, half),
      };
      const test: Record<string, Candle[]> = {
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
      console.log(
        testR.passRate >= trainR.passRate - 0.05
          ? "  → OK: test ≈ train (no major overfit)"
          : "  → WARN: test > 5pp below train (possible overfit)",
      );

      expect(full.windows).toBeGreaterThan(100);
    });
  },
);
