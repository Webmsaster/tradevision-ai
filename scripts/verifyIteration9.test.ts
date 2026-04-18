import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchRecentFunding } from "../src/utils/fundingRate";
import { fetchLongShortRatio } from "../src/utils/longShortRatio";
import { runFundingContrarianBacktest } from "../src/utils/fundingContrarian";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 9 — Funding-Extreme Contrarian", () => {
  it("live verification", { timeout: 180_000 }, async () => {
    console.log(
      "\n=== FUNDING-EXTREME CONTRARIAN (Kharat 2025, SSRN 5290137) ===\n",
    );
    for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
      const [candles, funding, ls] = await Promise.all([
        loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 2000,
        }),
        fetchRecentFunding(sym, 200),
        fetchLongShortRatio({ symbol: sym, period: "1h", limit: 500 }),
      ]);
      console.log(
        `${sym}: candles=${candles.length} funding=${funding.length} lsSamples=${ls.length}`,
      );
      // Diagnostic
      const lsStart = ls[0]?.time ?? 0;
      const lsEnd = ls[ls.length - 1]?.time ?? 0;
      const fStart = funding[0]?.fundingTime ?? 0;
      const fEnd = funding[funding.length - 1]?.fundingTime ?? 0;
      console.log(
        `  L/S: ${new Date(lsStart).toISOString().slice(0, 10)} → ${new Date(lsEnd).toISOString().slice(0, 10)}`,
      );
      console.log(
        `  Funding: ${new Date(fStart).toISOString().slice(0, 10)} → ${new Date(fEnd).toISOString().slice(0, 10)}`,
      );
      const fundingInLsRange = funding.filter(
        (f) => f.fundingTime >= lsStart && f.fundingTime <= lsEnd,
      );
      if (fundingInLsRange.length > 0) {
        const maxFunding = Math.max(
          ...fundingInLsRange.map((f) => f.fundingRate),
        );
        const minFunding = Math.min(
          ...fundingInLsRange.map((f) => f.fundingRate),
        );
        const maxLs = Math.max(...ls.map((l) => l.longShortRatio));
        const minLs = Math.min(...ls.map((l) => l.longShortRatio));
        console.log(
          `  Overlap: ${fundingInLsRange.length} funding events. fundingMax=${(maxFunding * 100).toFixed(4)}% fundingMin=${(minFunding * 100).toFixed(4)}%. L/S max=${maxLs.toFixed(2)} min=${minLs.toFixed(2)}`,
        );
        const posStreak2 = fundingInLsRange.filter(
          (f, i) =>
            i >= 2 &&
            f.fundingRate > 0.0002 &&
            fundingInLsRange[i - 1].fundingRate > 0.0002 &&
            fundingInLsRange[i - 2].fundingRate > 0.0002,
        ).length;
        console.log(
          `  3× consec funding>0.02% count in L/S window: ${posStreak2}`,
        );
      } else {
        console.log(`  No overlap!`);
      }

      for (const cfg of [
        {
          name: "default (3×0.05% + L/S>2.5)",
          fundingPosThreshold: 0.0005,
          fundingNegThreshold: 0.0005,
          consecutivePeriods: 3,
          longShortLongCrowded: 2.5,
          longShortShortCrowded: 0.4,
          exitFundingBelow: 0.0001,
          holdBarsMax: 8,
          stopPct: 0.02,
        },
        {
          name: "loose (2× funding, L/S>2.0)",
          fundingPosThreshold: 0.0003,
          fundingNegThreshold: 0.0003,
          consecutivePeriods: 2,
          longShortLongCrowded: 2.0,
          longShortShortCrowded: 0.5,
          exitFundingBelow: 0.0001,
          holdBarsMax: 8,
          stopPct: 0.02,
        },
        {
          name: "v-loose (1× funding, L/S>1.5)",
          fundingPosThreshold: 0.0002,
          fundingNegThreshold: 0.0002,
          consecutivePeriods: 1,
          longShortLongCrowded: 1.5,
          longShortShortCrowded: 0.7,
          exitFundingBelow: 0.0001,
          holdBarsMax: 8,
          stopPct: 0.02,
        },
        {
          name: "funding-only (no L/S gate)",
          fundingPosThreshold: 0.0005,
          fundingNegThreshold: 0.0005,
          consecutivePeriods: 3,
          longShortLongCrowded: 0,
          longShortShortCrowded: 10,
          exitFundingBelow: 0.0001,
          holdBarsMax: 8,
          stopPct: 0.02,
        },
      ]) {
        const rep = runFundingContrarianBacktest(candles, funding, ls, {
          ...cfg,
          costs: MAKER_COSTS,
        });
        console.log(
          `  ${cfg.name.padEnd(36)} signals=${rep.signalsFired}  trades=${rep.trades.length}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  WR=${(rep.winRate * 100).toFixed(0)}%  PF=${rep.profitFactor.toFixed(2)}  sharpe=${rep.sharpe.toFixed(2)}  dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
        );
      }
    }
  });
});
