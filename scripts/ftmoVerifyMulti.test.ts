/**
 * Verify iter218/219/220 reproduce measured results.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_PARETO,
  FTMO_DAYTRADE_24H_CONFIG_BE,
  FTMO_DAYTRADE_24H_CONFIG_BE_CURVE,
  FTMO_DAYTRADE_24H_CONFIG_MULTI,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

function runBatch(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  step = 3,
) {
  const winBars = 30 * 6;
  const stepBars = step * 6;
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
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
    medianDays: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
    p25Days: passDays[Math.floor(passDays.length * 0.25)] ?? 0,
  };
}

function fmt(label: string, r: ReturnType<typeof runBatch>) {
  return `${label.padEnd(32)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  EV=$${r.ev.toFixed(0).padStart(5)}`;
}

describe("Verify iter218/219/220", { timeout: 900_000 }, () => {
  it("full frontier comparison", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "4h",
      targetCount: 30000,
      maxPages: 40,
    });

    // Dataset A: ETH+BTC full history (for iter212-219)
    const nEB = Math.min(eth.length, btc.length);
    const dataEB = { ETHUSDT: eth.slice(-nEB), BTCUSDT: btc.slice(-nEB) };

    // Dataset B: ETH+BTC+SOL aligned (for iter220)
    const nAll = Math.min(eth.length, btc.length, sol.length);
    const dataAll = {
      ETHUSDT: eth.slice(-nAll),
      BTCUSDT: btc.slice(-nAll),
      SOLUSDT: sol.slice(-nAll),
    };

    console.log(`\nFull-history ETH+BTC: ${(nEB / 6 / 365).toFixed(1)}y`);
    console.log(`SOL-aligned ETH+BTC+SOL: ${(nAll / 6 / 365).toFixed(1)}y\n`);

    // On full 8.7y:
    console.log("--- Full 8.7y (ETH+BTC) ---");
    const b1 = runBatch(dataEB, FTMO_DAYTRADE_24H_CONFIG);
    const b2 = runBatch(dataEB, FTMO_DAYTRADE_24H_CONFIG_PARETO);
    const b3 = runBatch(dataEB, FTMO_DAYTRADE_24H_CONFIG_BE);
    const b4 = runBatch(dataEB, FTMO_DAYTRADE_24H_CONFIG_BE_CURVE);
    console.log(fmt("iter212 baseline", b1));
    console.log(fmt("iter216 pareto", b2));
    console.log(fmt("iter218 BE@2%", b3));
    console.log(fmt("iter219 BE+curve", b4));

    // On SOL-aligned 5.7y:
    console.log("\n--- SOL-aligned 5.7y (ETH+BTC+SOL) ---");
    const c1 = runBatch(dataAll, FTMO_DAYTRADE_24H_CONFIG);
    const c2 = runBatch(dataAll, FTMO_DAYTRADE_24H_CONFIG_PARETO);
    const c3 = runBatch(dataAll, FTMO_DAYTRADE_24H_CONFIG_BE);
    const c4 = runBatch(dataAll, FTMO_DAYTRADE_24H_CONFIG_BE_CURVE);
    const c5 = runBatch(dataAll, FTMO_DAYTRADE_24H_CONFIG_MULTI);
    console.log(fmt("iter212 baseline", c1));
    console.log(fmt("iter216 pareto", c2));
    console.log(fmt("iter218 BE@2%", c3));
    console.log(fmt("iter219 BE+curve", c4));
    console.log(fmt("iter220 MULTI (ETH+BTC+SOL)", c5));

    // Deltas iter220 vs all
    console.log(`\n-- iter220 deltas vs baselines (on SOL-aligned 5.7y) --`);
    console.log(
      `iter220 vs iter212: +${((c5.passRate - c1.passRate) * 100).toFixed(1)}pp pass, ${c5.medianDays - c1.medianDays}d median, +$${(c5.ev - c1.ev).toFixed(0)} EV`,
    );
    console.log(
      `iter220 vs iter216: +${((c5.passRate - c2.passRate) * 100).toFixed(1)}pp pass, ${c5.medianDays - c2.medianDays}d median, +$${(c5.ev - c2.ev).toFixed(0)} EV`,
    );
    console.log(
      `iter220 vs iter219: +${((c5.passRate - c4.passRate) * 100).toFixed(1)}pp pass, ${c5.medianDays - c4.medianDays}d median, +$${(c5.ev - c4.ev).toFixed(0)} EV`,
    );

    // Assertions: iter220 must beat iter219 on passRate AND medianDays
    expect(c5.passRate).toBeGreaterThan(c4.passRate);
    expect(c5.medianDays).toBeLessThanOrEqual(c4.medianDays);
    // Iter219 must beat iter216 on passRate (on full 8.7y sample)
    expect(b4.passRate).toBeGreaterThan(b2.passRate);
  });
});
