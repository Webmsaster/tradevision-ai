/**
 * V12_QUARTZ_30M Adaptation Test (Round 28).
 *
 * Adapts V12_30M_OPT engine stack to V5_QUARTZ_LITE 9-asset basket
 * (BTC, ETH, BNB, ADA, LTC, BCH, ETC, XRP, AAVE) on 30m bars and reports
 * walk-forward backtest stats.
 *
 * Goal: ≥80% pass-rate keeping V12's drift-friendly features intact while
 * removing state-dependent ones (kellySizing, pauseAtTargetReached,
 * dailyPeakTrailingStop) so the same config is live-deployable.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run scripts/_v12QuartzAdapt.test.ts \
 *     --reporter=basic 2>&1 | tail -30
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V12_QUARTZ_30M,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

const BARS_PER_DAY = 48; // 30m TF
const CHALLENGE_DAYS = 30;

const ASSETS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "ETCUSDT",
  "XRPUSDT",
  "AAVEUSDT",
];

function runWalkForward(byAsset: Record<string, Candle[]>, stepDays = 3) {
  assertAligned(byAsset);
  const winBars = Math.round(CHALLENGE_DAYS * BARS_PER_DAY);
  const stepBars = Math.round(stepDays * BARS_PER_DAY);
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(
      runFtmoDaytrade24h(slice, FTMO_DAYTRADE_24H_CONFIG_V12_QUARTZ_30M),
    );
  }
  const passes = out.filter((r) => r.passed).length;
  const tlBreaches = out.filter((r) => r.reason === "total_loss").length;
  const dlBreaches = out.filter((r) => r.reason === "daily_loss").length;
  const passDays: number[] = [];
  for (const r of out) if (r.passed) passDays.push(computePassDay(r));
  passDays.sort((a, b) => a - b);
  const px = (q: number) => {
    const v = pick(passDays, q);
    return Number.isNaN(v) ? 0 : v;
  };
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: px(0.5),
    p25Days: px(0.25),
    p75Days: px(0.75),
    p90Days: px(0.9),
    tlPct: out.length > 0 ? tlBreaches / out.length : 0,
    dlPct: out.length > 0 ? dlBreaches / out.length : 0,
    tlBreaches,
    dlBreaches,
  };
}

describe("V12_QUARTZ_30M adaptation", { timeout: 1800_000 }, () => {
  it("loads 9-asset 30m data and runs walk-forward backtest", async () => {
    // ~50000 bars per asset (~2.85y at 30m) for proper walk-forward.
    // 30m has 48 bars/day — task spec said ~3000 bars but that's <2 windows;
    // bump to ~50k so we get ~340 step=3d windows after warmup.
    const targetCount = 50000;
    const maxPages = 50;

    console.log(
      `\n=== V12_QUARTZ_30M — loading 9 assets @ 30m (~${targetCount} bars each) ===`,
    );
    const data: Record<string, Candle[]> = {};
    for (const sym of ASSETS) {
      const bars = await loadBinanceHistory({
        symbol: sym,
        timeframe: "30m",
        targetCount,
        maxPages,
      });
      data[sym] = bars;
      const yrs = (bars.length / BARS_PER_DAY / 365).toFixed(2);
      console.log(`  ${sym.padEnd(10)} ${bars.length} bars (${yrs}y)`);
    }
    // align to common length and intersect openTimes
    const minLen = Math.min(...Object.values(data).map((a) => a.length));
    const slicedTail: Record<string, Candle[]> = {};
    for (const sym of ASSETS) slicedTail[sym] = data[sym].slice(-minLen);
    // Now intersect openTimes (Binance can have small gaps for newer-listed
    // assets like AAVE).
    const sets = ASSETS.map(
      (s) => new Set(slicedTail[s].map((c) => c.openTime)),
    );
    let common = [...sets[0]];
    for (let i = 1; i < sets.length; i++) {
      common = common.filter((t) => sets[i].has(t));
    }
    common.sort((a, b) => a - b);
    const cs = new Set(common);
    const aligned: Record<string, Candle[]> = {};
    for (const sym of ASSETS)
      aligned[sym] = slicedTail[sym].filter((c) => cs.has(c.openTime));

    const n = aligned[ASSETS[0]].length;
    const yrs = (n / BARS_PER_DAY / 365).toFixed(2);
    console.log(`\n  Aligned: ${n} bars (${yrs}y) across all 9 assets`);

    console.log(`\n=== Walk-forward step=3d ===`);
    const r = runWalkForward(aligned, 3);
    console.log(
      `V12_QUARTZ_30M  ${r.passes}/${r.windows} = ${(r.passRate * 100).toFixed(2)}%  ` +
        `med=${r.medianDays}d p25=${r.p25Days} p75=${r.p75Days} p90=${r.p90Days}  ` +
        `TL=${(r.tlPct * 100).toFixed(1)}% DL=${(r.dlPct * 100).toFixed(1)}%`,
    );

    // Final report
    console.log(`\n=== FINAL ===`);
    console.log(`Config:    FTMO_DAYTRADE_24H_CONFIG_V12_QUARTZ_30M`);
    console.log(
      `Pass-rate: ${(r.passRate * 100).toFixed(2)}%  med=${r.medianDays}d p90=${r.p90Days}d  TL=${(r.tlPct * 100).toFixed(1)}%  DL=${(r.dlPct * 100).toFixed(1)}%`,
    );
    console.log(
      `Goal:      ≥80% backtest. Achieved: ${r.passRate >= 0.8 ? "YES" : "NO"}.`,
    );

    // Sanity: at least some windows ran
    expect(r.windows).toBeGreaterThan(0);
  });
});
