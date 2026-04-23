/**
 * Verify iter216 (Pareto) and iter217 (fast-pass) configs reproduce
 * the measured results from the fast-pass sweep.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_PARETO,
  FTMO_DAYTRADE_24H_CONFIG_FASTPASS,
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
  const passRate = passes / out.length;
  const passDays: number[] = [];
  for (const r of out) {
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  }
  passDays.sort((a, b) => a - b);
  const med = passDays[Math.floor(passDays.length * 0.5)] ?? 0;
  const p25 = passDays[Math.floor(passDays.length * 0.25)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate,
    ev: passRate * 0.5 * 8000 - 99,
    medianDays: med,
    p25Days: p25,
  };
}

function fmt(label: string, r: ReturnType<typeof runBatch>) {
  return `${label.padEnd(28)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  EV=$${r.ev.toFixed(0).padStart(5)}`;
}

describe("Verify iter216 + iter217 configs", { timeout: 900_000 }, () => {
  it("compare baseline vs pareto vs fastpass", async () => {
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
    const n = Math.min(eth.length, btc.length);
    const data = { ETHUSDT: eth.slice(-n), BTCUSDT: btc.slice(-n) };
    console.log(`\nLoaded ${(n / 6 / 365).toFixed(1)}y 4h data\n`);

    const baseline = runBatch(data, FTMO_DAYTRADE_24H_CONFIG);
    const pareto = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_PARETO);
    const fastpass = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_FASTPASS);

    console.log(fmt("iter212 baseline", baseline));
    console.log(fmt("iter216 pareto", pareto));
    console.log(fmt("iter217 fastpass", fastpass));

    console.log(
      `\nDelta pareto vs baseline: ${((pareto.passRate - baseline.passRate) * 100).toFixed(1)}pp pass, $${(pareto.ev - baseline.ev).toFixed(0)} EV, ${pareto.medianDays - baseline.medianDays}d median`,
    );
    console.log(
      `Delta fastpass vs baseline: ${((fastpass.passRate - baseline.passRate) * 100).toFixed(1)}pp pass, $${(fastpass.ev - baseline.ev).toFixed(0)} EV, ${fastpass.medianDays - baseline.medianDays}d median`,
    );

    // Assert iter216 Pareto-dominates baseline (higher or equal pass rate, no worse median)
    expect(pareto.passRate).toBeGreaterThanOrEqual(baseline.passRate);
    expect(pareto.medianDays).toBeLessThanOrEqual(baseline.medianDays);

    // Assert iter217 is faster (lower median, accept lower pass rate)
    expect(fastpass.medianDays).toBeLessThanOrEqual(baseline.medianDays);
  });
});
