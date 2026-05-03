/**
 * Ensemble: 4h Trend-Long + 30m MR-Short on unified account.
 *
 * Hypothesis: Trend-Longs work in BULL phases, MR-Shorts in BEAR/CHOP.
 * Combined → more market-state coverage → higher pass-rate.
 *
 * Reuses the multiTfEnsemble helper. Position scale = 0.5 (1/N) to keep
 * single-account leverage.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  precomputeAllTrades,
  walkForwardEnsemble,
  type TfEntry,
} from "./_multiTfEnsemble";
import { LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

describe("Ensemble Trend+MR", { timeout: 1800_000 }, () => {
  it("4h-trend longs + 30m-MR shorts on unified account", async () => {
    // 4h: load all 8 trend assets
    const TREND_SRC = [
      "ETHUSDT",
      "BTCUSDT",
      "BNBUSDT",
      "ADAUSDT",
      "AVAXUSDT",
      "SOLUSDT",
      "BCHUSDT",
      "DOGEUSDT",
    ];
    // 30m MR uses ETH/BTC/SOL
    const MR_SRC = ["ETHUSDT", "BTCUSDT", "SOLUSDT"];
    const all4h: Record<string, Candle[]> = {};
    const all30m: Record<string, Candle[]> = {};
    const all15m: Record<string, Candle[]> = {};

    console.log(`Loading 4h history...`);
    for (const s of TREND_SRC) {
      all4h[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
      console.log(`  4h ${s}: ${all4h[s].length} bars`);
    }
    console.log(`\nLoading 30m history...`);
    for (const s of MR_SRC) {
      all30m[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "30m",
        targetCount: 100000,
        maxPages: 100,
      });
      console.log(`  30m ${s}: ${all30m[s].length} bars`);
    }
    console.log(`\nLoading 15m history...`);
    for (const s of MR_SRC) {
      all15m[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "15m",
        targetCount: 200000,
        maxPages: 200,
      });
      console.log(`  15m ${s}: ${all15m[s].length} bars`);
    }

    // Determine common time-window
    const minTs = Math.max(
      ...Object.values(all4h).map((c) => c[0].openTime),
      ...Object.values(all30m).map((c) => c[0].openTime),
      ...Object.values(all15m).map((c) => c[0].openTime),
    );
    const maxTs = Math.min(
      ...Object.values(all4h).map((c) => c[c.length - 1].closeTime),
      ...Object.values(all30m).map((c) => c[c.length - 1].closeTime),
      ...Object.values(all15m).map((c) => c[c.length - 1].closeTime),
    );
    const yrs = ((maxTs - minTs) / (365 * 86400_000)).toFixed(2);
    console.log(
      `\nCommon window: ${new Date(minTs).toISOString().slice(0, 10)} → ${new Date(maxTs).toISOString().slice(0, 10)} (${yrs}y)\n`,
    );

    const tfTrend: TfEntry = {
      label: "1h", // labelled label is just for tagging; tfHours is what matters
      cfg: { ...FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2, liveCaps: LIVE_CAPS },
      data: all4h,
      tfHours: 4,
    };
    const tfMR30: TfEntry = {
      label: "30m" as any,
      cfg: { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2, liveCaps: LIVE_CAPS },
      data: all30m,
      tfHours: 0.5,
    };
    const tfMR15: TfEntry = {
      label: "15m" as any,
      cfg: { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2, liveCaps: LIVE_CAPS },
      data: all15m,
      tfHours: 0.25,
    };

    console.log(`Pre-computing trades for all configs...`);
    const t0 = Date.now();
    const tradesTrend = precomputeAllTrades([tfTrend]);
    const trades30m = precomputeAllTrades([tfMR30]);
    const trades15m = precomputeAllTrades([tfMR15]);
    console.log(`  Trend 4h: ${tradesTrend.length} trades`);
    console.log(`  MR 30m: ${trades30m.length} trades`);
    console.log(`  MR 15m: ${trades15m.length} trades`);
    console.log(`Precomputed in ${(Date.now() - t0) / 1000}s\n`);

    function fmtRow(label: string, r: any) {
      return `${label.padEnd(28)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
    }

    console.log(`================ ENSEMBLE COMPARISONS ================`);

    // Single strategies (baseline)
    const trendOnly = walkForwardEnsemble(
      tradesTrend,
      minTs,
      maxTs,
      FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
      1,
    );
    const mr30Only = walkForwardEnsemble(
      trades30m,
      minTs,
      maxTs,
      FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
      1,
    );
    const mr15Only = walkForwardEnsemble(
      trades15m,
      minTs,
      maxTs,
      FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
      1,
    );

    console.log(fmtRow("Trend 4h only", trendOnly));
    console.log(fmtRow("MR 30m only", mr30Only));
    console.log(fmtRow("MR 15m only", mr15Only));

    // Ensembles
    const t4_mr30 = walkForwardEnsemble(
      [...tradesTrend, ...trades30m],
      minTs,
      maxTs,
      FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
      2,
    );
    const t4_mr15 = walkForwardEnsemble(
      [...tradesTrend, ...trades15m],
      minTs,
      maxTs,
      FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
      2,
    );
    const t4_mr30_mr15 = walkForwardEnsemble(
      [...tradesTrend, ...trades30m, ...trades15m],
      minTs,
      maxTs,
      FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
      3,
    );

    console.log(fmtRow("Trend + MR-30m (N=2)", t4_mr30));
    console.log(fmtRow("Trend + MR-15m (N=2)", t4_mr15));
    console.log(fmtRow("Trend + MR-30m + MR-15m (N=3)", t4_mr30_mr15));

    // Try with N=1 (full leverage, no scaling) — risk of over-leverage but max profit
    const t4_mr30_full = walkForwardEnsemble(
      [...tradesTrend, ...trades30m],
      minTs,
      maxTs,
      FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
      1,
    );
    console.log(fmtRow("Trend + MR-30m (N=1, full)", t4_mr30_full));

    expect(tradesTrend.length).toBeGreaterThan(0);
  });
});
