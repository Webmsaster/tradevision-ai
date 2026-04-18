import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  fetchUsdtSupplyHistory,
  runSupplyBacktest,
} from "../src/utils/stablecoinSupply";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 17 — USDT supply signal", () => {
  it("365d supply backtest", { timeout: 240_000 }, async () => {
    console.log("\n=== USDT SUPPLY SIGNAL (Grobys/Huynh 2022) ===");
    const supply = await fetchUsdtSupplyHistory(365);
    console.log(`Supply samples: ${supply.length}`);
    if (supply.length < 30) {
      console.log("  too few samples; skipping");
      return;
    }
    const deltas = supply.map((s) => s.deltaUsd);
    const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const stdD = Math.sqrt(
      deltas.reduce((a, b) => a + (b - meanD) * (b - meanD), 0) / deltas.length,
    );
    const maxMint = Math.max(...deltas);
    const maxBurn = Math.min(...deltas);
    console.log(
      `  daily deltas: mean=$${(meanD / 1e6).toFixed(0)}M std=$${(stdD / 1e6).toFixed(0)}M maxMint=$${(maxMint / 1e6).toFixed(0)}M maxBurn=$${(maxBurn / 1e6).toFixed(0)}M`,
    );

    const bnb = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 9000,
    });
    console.log(`Binance bars: ${bnb.length}`);

    for (const cfg of [
      {
        name: "$500M mint, 24h hold, long+short",
        mintThresholdUsd: 500e6,
        burnThresholdUsd: -500e6,
        holdBars: 24,
        stopPct: 0.02,
        longOnly: false,
      },
      {
        name: "$1B mint, 48h hold, long+short",
        mintThresholdUsd: 1000e6,
        burnThresholdUsd: -1000e6,
        holdBars: 48,
        stopPct: 0.025,
        longOnly: false,
      },
      {
        name: "$300M mint, 24h hold, long-only",
        mintThresholdUsd: 300e6,
        burnThresholdUsd: -300e6,
        holdBars: 24,
        stopPct: 0.02,
        longOnly: true,
      },
      {
        name: "+1σ mint, 24h hold, long-only",
        mintThresholdUsd: meanD + stdD,
        burnThresholdUsd: meanD - stdD,
        holdBars: 24,
        stopPct: 0.02,
        longOnly: true,
      },
      {
        name: "+2σ mint, 24h hold, long+short",
        mintThresholdUsd: meanD + 2 * stdD,
        burnThresholdUsd: meanD - 2 * stdD,
        holdBars: 24,
        stopPct: 0.02,
        longOnly: false,
      },
    ]) {
      const rep = runSupplyBacktest(supply, bnb, {
        ...cfg,
        costs: MAKER_COSTS,
      });
      console.log(
        `  ${cfg.name.padEnd(40)} signals=${rep.signalsFired}  trades=${rep.trades.length}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  WR=${(rep.winRate * 100).toFixed(0)}%  PF=${rep.profitFactor.toFixed(2)}  sharpe=${rep.sharpe.toFixed(2)}  dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }
  });
});
