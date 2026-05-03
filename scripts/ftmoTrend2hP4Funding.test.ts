/**
 * Phase 4: Funding-rate filter for trend-longs.
 *
 * Hypothesis: extreme positive BTC funding (overheated longs in perps)
 * predicts mean-reversion in spot → skip trend-longs when funding is too high.
 *
 * Implementation: external filter applied post-hoc to the trade list, then
 * walk-forward on filtered trades. Avoids engine modification for this experiment.
 */
import { describe, it, expect } from "vitest";
import {
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import { LIVE_CAPS, runWalkForward, fmt } from "./_aggressiveSweepHelper";
import { walkForwardEnsemble } from "./_multiTfEnsemble";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
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

describe("Phase 4: Funding Rate Filter", { timeout: 1800_000 }, () => {
  it("filters trend-longs by BTC funding rate", async () => {
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / 12 / 365).toFixed(2)}y)\n`);

    // Load BTC funding rate over the full window
    const minTs = data.BTCUSDT[0].openTime;
    const maxTs = data.BTCUSDT[n - 1].closeTime;
    console.log(
      `Loading BTC funding rate ${new Date(minTs).toISOString().slice(0, 10)} → ${new Date(maxTs).toISOString().slice(0, 10)}...`,
    );
    const funding = await loadBinanceFundingRate("BTCUSDT", minTs, maxTs);
    console.log(`  ${funding.length} funding settlements loaded`);

    // Align funding to BTC candle openTimes (other assets share grid)
    const candleTimes = data.BTCUSDT.map((c) => c.openTime);
    const fundingAligned = alignFundingToCandles(funding, candleTimes);
    const validFunding = fundingAligned.filter((r) => r !== null) as number[];
    if (validFunding.length > 0) {
      const sorted = [...validFunding].sort((a, b) => a - b);
      const pick = (q: number) => sorted[Math.floor(sorted.length * q)];
      console.log(
        `  funding distribution: p10=${(pick(0.1) * 100).toFixed(4)}% p50=${(pick(0.5) * 100).toFixed(4)}% p90=${(pick(0.9) * 100).toFixed(4)}% p99=${(pick(0.99) * 100).toFixed(4)}%`,
      );
    }

    const baseCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, baseCfg, TF_HOURS);
    console.log(fmt("V2 BASELINE (no funding filter)", baseR));

    // Pre-compute trades for each asset
    const allTrades: Array<
      Daytrade24hTrade & { tf: string; entryFunding: number | null }
    > = [];
    for (const asset of baseCfg.assets) {
      const lookupKey = asset.sourceSymbol ?? asset.symbol;
      const candles = data[lookupKey];
      if (!candles) continue;
      const trades = detectAsset(candles, asset, baseCfg);
      // Map each trade entry to funding rate at that time
      for (const t of trades) {
        // find candle index by entryTime
        const idx = candles.findIndex((c) => c.openTime === t.entryTime);
        const fundingAtEntry = idx >= 0 ? fundingAligned[idx] : null;
        allTrades.push({ ...t, tf: "2h", entryFunding: fundingAtEntry });
      }
    }
    allTrades.sort((a, b) => a.entryTime - b.entryTime);
    console.log(`Total trades pre-computed: ${allTrades.length}`);

    function fmtRow(label: string, r: any) {
      return `${label.padEnd(38)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
    }

    // Run baseline ensemble (no filter)
    const r0 = walkForwardEnsemble(allTrades, minTs, maxTs, baseCfg, 1);
    console.log(fmtRow("Ensemble baseline (no filter)", r0));

    // Sweep funding-rate caps (skip longs when funding > maxRate)
    console.log(
      `\n--- Funding-rate cap sweep (skip when BTC funding > X%) ---`,
    );
    let best = { rate: Infinity, r: r0 };
    for (const ratePct of [
      0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.05, 0.08, 0.1,
    ]) {
      const rate = ratePct / 100; // input as %, e.g. 0.01% = 0.0001
      const filtered = allTrades.filter(
        (t) => t.entryFunding === null || t.entryFunding <= rate,
      );
      const r = walkForwardEnsemble(filtered, minTs, maxTs, baseCfg, 1);
      console.log(
        fmtRow(
          `  funding ≤ ${ratePct}% (${filtered.length}/${allTrades.length} trades)`,
          r,
        ),
      );
      if (
        r.passRate > best.r.passRate ||
        (r.passRate === best.r.passRate && r.p90Days < best.r.p90Days)
      ) {
        best = { rate: ratePct, r };
      }
    }

    console.log(`\n========== PHASE 4 FINAL ==========`);
    console.log(fmtRow("Ensemble baseline ", r0));
    console.log(fmtRow("Phase 4 winner    ", best.r));
    console.log(
      `Δ: +${((best.r.passRate - r0.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - r0.p90Days}d p90`,
    );
    console.log(`Best filter: funding ≤ ${best.rate}%`);

    expect(allTrades.length).toBeGreaterThan(0);
  });
});
