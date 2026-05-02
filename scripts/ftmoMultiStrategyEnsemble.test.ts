/**
 * Multi-Strategy Ensemble: TREND_2H_V3 (long) + LIVE_30M_V2 (short)
 * + optional BTC funding-rate filter as cross-strategy regime gate.
 *
 * Hypothesis: Trend-Longs in BULL phases + MR-Shorts in BEAR/CHOP phases →
 * coverage of both market regimes → higher combined pass-rate.
 */
import { describe, it, expect } from "vitest";
import {
  detectAsset,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import { LIVE_CAPS } from "./_aggressiveSweepHelper";
import {
  walkForwardEnsemble,
  type TfEntry,
  precomputeAllTrades,
} from "./_multiTfEnsemble";
import type { Candle } from "../src/utils/indicators";

const TREND_SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "SOLUSDT",
  "BCHUSDT",
  "DOGEUSDT",
];
const MR_SOURCES = ["ETHUSDT", "BTCUSDT", "SOLUSDT"];

describe("Multi-Strategy Ensemble", { timeout: 1800_000 }, () => {
  it("Trend-Long + MR-Short on unified account", async () => {
    // Load 2h data for trend
    const data2h: Record<string, Candle[]> = {};
    for (const s of TREND_SOURCES) {
      data2h[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    // Load 30m data for MR
    const data30m: Record<string, Candle[]> = {};
    for (const s of MR_SOURCES) {
      data30m[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "30m",
        targetCount: 100000,
        maxPages: 100,
      });
    }

    const minTs = Math.max(
      ...Object.values(data2h).map((c) => c[0].openTime),
      ...Object.values(data30m).map((c) => c[0].openTime),
    );
    const maxTs = Math.min(
      ...Object.values(data2h).map((c) => c[c.length - 1].closeTime),
      ...Object.values(data30m).map((c) => c[c.length - 1].closeTime),
    );
    const yrs = ((maxTs - minTs) / (365 * 86400_000)).toFixed(2);
    console.log(`Common window: ${yrs}y\n`);

    const trendCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
      liveCaps: LIVE_CAPS,
    };
    const mrCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
      liveCaps: LIVE_CAPS,
    };

    // Pre-compute trades
    const tfTrend: TfEntry = {
      label: "1h" as any,
      cfg: trendCfg,
      data: data2h,
      tfHours: 2,
    };
    const tfMR: TfEntry = {
      label: "30m" as any,
      cfg: mrCfg,
      data: data30m,
      tfHours: 0.5,
    };
    const tradesTrend = precomputeAllTrades([tfTrend]);
    const tradesMR = precomputeAllTrades([tfMR]);

    console.log(
      `Trend trades: ${tradesTrend.length} | MR trades: ${tradesMR.length}\n`,
    );

    function fmtRow(label: string, r: any) {
      return `${label.padEnd(38)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
    }

    console.log(`================ ENSEMBLE COMPARISON ================`);

    // Baseline: each strategy alone
    const trendOnly = walkForwardEnsemble(
      tradesTrend,
      minTs,
      maxTs,
      trendCfg,
      1,
    );
    const mrOnly = walkForwardEnsemble(tradesMR, minTs, maxTs, mrCfg, 1);
    console.log(fmtRow("Trend 2h only (V3)", trendOnly));
    console.log(fmtRow("MR 30m only (V2)", mrOnly));

    // Combined N=1 (no position scaling)
    const combinedN1 = walkForwardEnsemble(
      [...tradesTrend, ...tradesMR],
      minTs,
      maxTs,
      trendCfg,
      1,
    );
    console.log(fmtRow("Combined Trend+MR (N=1)", combinedN1));

    // Combined N=2 (positions halved for safety)
    const combinedN2 = walkForwardEnsemble(
      [...tradesTrend, ...tradesMR],
      minTs,
      maxTs,
      trendCfg,
      2,
    );
    console.log(fmtRow("Combined Trend+MR (N=2)", combinedN2));

    // Apply BTC funding rate filter to TREND-LONG trades only
    console.log(`\n--- + BTC funding-rate filter on Trend-Longs ---`);
    let funding: any[] = [];
    try {
      funding = await loadBinanceFundingRate("BTCUSDT", minTs, maxTs);
    } catch (e) {
      console.log(`Funding load error: ${e}`);
    }
    if (funding.length > 0) {
      const candleTimes = data2h.BTCUSDT.map((c) => c.openTime);
      const fundingAligned = alignFundingToCandles(funding, candleTimes);

      // Tag trend trades with funding at entry
      const taggedTrend = tradesTrend.map((t) => {
        const idx = data2h.BTCUSDT.findIndex((c) => c.openTime === t.entryTime);
        return { ...t, entryFunding: idx >= 0 ? fundingAligned[idx] : null };
      });

      for (const ratePct of [0.005, 0.01, 0.015, 0.02, 0.03]) {
        const rate = ratePct / 100;
        const filteredTrend = taggedTrend.filter(
          (t) => t.entryFunding === null || t.entryFunding <= rate,
        );
        const combined = walkForwardEnsemble(
          [...filteredTrend, ...tradesMR],
          minTs,
          maxTs,
          trendCfg,
          1,
        );
        console.log(
          fmtRow(
            `  funding ≤ ${ratePct}% (${filteredTrend.length}/${tradesTrend.length} trends)`,
            combined,
          ),
        );
      }
    }

    expect(tradesTrend.length).toBeGreaterThan(0);
  });
});
