/**
 * Iter 30: Cross-Asset Coinbase Premium Rotation backtest (BTC vs ETH).
 *
 * If US cohort prefers BTC over ETH (BTC premium - ETH premium > +0.10%),
 * does the BTC/ETH ratio drift up over the next 12 hours?
 *
 * Pair-trade backtest: equal-$ long BTC + short ETH (or inverse).
 */
import { describe, it } from "vitest";
import { fetchCoinbaseLongHistory } from "../src/utils/coinbaseHistory";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runCohortRotationBacktest,
  type CohortRotationConfig,
} from "../src/utils/cohortRotationStrategy";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 30 — cross-asset premium rotation", () => {
  it("BTC-ETH cohort rotation pair trade", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 30: COHORT ROTATION (BTC-ETH PREMIUM SPREAD) ===");

    console.log("Fetching Coinbase BTC-USD 1h...");
    const cbBtc = await fetchCoinbaseLongHistory("BTC-USD", 3600, 5000);
    console.log(`  cb-BTC: ${cbBtc.length}`);

    console.log("Fetching Coinbase ETH-USD 1h...");
    const cbEth = await fetchCoinbaseLongHistory("ETH-USD", 3600, 5000);
    console.log(`  cb-ETH: ${cbEth.length}`);

    console.log("Fetching Binance BTC + ETH 1h...");
    const [bnbBtc, bnbEth] = await Promise.all([
      loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 8000,
      }),
      loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "1h",
        targetCount: 8000,
      }),
    ]);
    console.log(`  bnb-BTC: ${bnbBtc.length}  bnb-ETH: ${bnbEth.length}`);

    // Debug spread distribution
    {
      const cbEthMap = new Map(cbEth.map((c) => [c.openTime, c]));
      const bnbBtcMap = new Map(bnbBtc.map((c) => [c.openTime, c]));
      const bnbEthMap = new Map(bnbEth.map((c) => [c.openTime, c]));
      const spreads: number[] = [];
      for (const c of cbBtc) {
        const ce = cbEthMap.get(c.openTime);
        const bb = bnbBtcMap.get(c.openTime);
        const be = bnbEthMap.get(c.openTime);
        if (!ce || !bb || !be) continue;
        const btcPrem = (c.close - bb.close) / bb.close;
        const ethPrem = (ce.close - be.close) / be.close;
        spreads.push(btcPrem - ethPrem);
      }
      spreads.sort((a, b) => a - b);
      const p = (q: number) => spreads[Math.floor(spreads.length * q)];
      console.log(
        `\nspread stats (n=${spreads.length}): p1=${(p(0.01) * 100).toFixed(3)}%  p5=${(p(0.05) * 100).toFixed(3)}%  p25=${(p(0.25) * 100).toFixed(3)}%  p50=${(p(0.5) * 100).toFixed(3)}%  p75=${(p(0.75) * 100).toFixed(3)}%  p95=${(p(0.95) * 100).toFixed(3)}%  p99=${(p(0.99) * 100).toFixed(3)}%`,
      );
      const abs = spreads.map(Math.abs).sort((a, b) => a - b);
      console.log(
        `|spread| p50=${(abs[Math.floor(abs.length * 0.5)] * 100).toFixed(3)}%  p90=${(abs[Math.floor(abs.length * 0.9)] * 100).toFixed(3)}%  p95=${(abs[Math.floor(abs.length * 0.95)] * 100).toFixed(3)}%  p99=${(abs[Math.floor(abs.length * 0.99)] * 100).toFixed(3)}%  max=${(abs[abs.length - 1] * 100).toFixed(3)}%`,
      );
    }

    const variants: Array<
      Pick<
        CohortRotationConfig,
        "minSpreadPct" | "consecutiveBars" | "holdBars" | "stopPct" | "longOnly"
      > & { name: string }
    > = [
      {
        name: "L+S 2×0.02% / 12h",
        minSpreadPct: 0.0002,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "L+S 2×0.03% / 12h",
        minSpreadPct: 0.0003,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "L+S 2×0.05% / 12h",
        minSpreadPct: 0.0005,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "L+S 2×0.05% / 24h",
        minSpreadPct: 0.0005,
        consecutiveBars: 2,
        holdBars: 24,
        stopPct: 0.02,
        longOnly: false,
      },
      {
        name: "L+S 2×0.05% /  6h",
        minSpreadPct: 0.0005,
        consecutiveBars: 2,
        holdBars: 6,
        stopPct: 0.012,
        longOnly: false,
      },
      {
        name: "L+S 2×0.10% / 12h",
        minSpreadPct: 0.001,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "L+S 3×0.05% / 12h",
        minSpreadPct: 0.0005,
        consecutiveBars: 3,
        holdBars: 12,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "Long-only 2×0.05%",
        minSpreadPct: 0.0005,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.015,
        longOnly: true,
      },
    ];

    console.log("\n=== RESULTS ===");
    console.log(
      "config".padEnd(22) +
        "fired".padStart(7) +
        "ret%".padStart(9) +
        "WR%".padStart(7) +
        "PF".padStart(7) +
        "Sharpe".padStart(9) +
        "DD%".padStart(7),
    );
    let bestSharpe = -Infinity;
    let bestName = "";
    for (const cfg of variants) {
      const rep = runCohortRotationBacktest(cbBtc, cbEth, bnbBtc, bnbEth, {
        minSpreadPct: cfg.minSpreadPct,
        consecutiveBars: cfg.consecutiveBars,
        holdBars: cfg.holdBars,
        stopPct: cfg.stopPct,
        longOnly: cfg.longOnly,
        costs: MAKER_COSTS,
      });
      console.log(
        cfg.name.padEnd(22) +
          String(rep.signalsFired).padStart(7) +
          (rep.netReturnPct * 100).toFixed(1).padStart(9) +
          (rep.winRate * 100).toFixed(0).padStart(7) +
          rep.profitFactor.toFixed(2).padStart(7) +
          rep.sharpe.toFixed(2).padStart(9) +
          (rep.maxDrawdownPct * 100).toFixed(1).padStart(7),
      );
      if (rep.sharpe > bestSharpe && rep.trades.length >= 5) {
        bestSharpe = rep.sharpe;
        bestName = cfg.name;
      }
    }
    console.log(`\nbest variant: ${bestName}  Sharpe=${bestSharpe.toFixed(2)}`);
  });
});
