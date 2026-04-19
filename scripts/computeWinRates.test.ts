/**
 * Compute honest win rates at three levels for the 7 locked Volume-Spike edges:
 *   1. Per-trade win rate (% of individual trades profitable)
 *   2. Per-day win rate (% of days the portfolio finished green)
 *   3. Per-bootstrap-window (already in iter34 — restate)
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runVolumeSpikeFade } from "../src/utils/volumeSpikeFade";
import {
  LOCKED_EDGES,
  lockedEdgeBinanceSymbol,
} from "../src/utils/volumeSpikeSignal";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

const DAY_MS = 86_400_000;

describe("Win rate breakdown for the 9 validated edges", () => {
  it("per-trade, per-day, per-window", { timeout: 600_000 }, async () => {
    console.log("\n=== WIN RATE BREAKDOWN ===\n");

    const uniqueSyms = Array.from(
      new Set(LOCKED_EDGES.map((e) => lockedEdgeBinanceSymbol(e.symbol))),
    );
    const candlesBy: Record<string, Candle[]> = {};
    for (const s of uniqueSyms) {
      candlesBy[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "1h",
        targetCount: 10000,
      });
    }
    const minStart = Math.max(
      ...uniqueSyms.map((s) => candlesBy[s][0].openTime),
    );
    const maxEnd = Math.min(
      ...uniqueSyms.map((s) => candlesBy[s][candlesBy[s].length - 1].closeTime),
    );

    interface PerStrat {
      label: string;
      trades: number;
      tradeWR: number;
      daily: number[];
      weight: number;
    }
    const strats: PerStrat[] = [];
    for (const edge of LOCKED_EDGES) {
      const sym = lockedEdgeBinanceSymbol(edge.symbol);
      const slice = candlesBy[sym].filter(
        (c) => c.openTime >= minStart && c.closeTime <= maxEnd,
      );
      const rep = runVolumeSpikeFade(slice, {
        ...edge.cfg,
        costs: MAKER_COSTS,
      });
      const wins = rep.trades.filter((t) => t.netPnlPct > 0).length;
      const tradeWR = rep.trades.length > 0 ? wins / rep.trades.length : 0;
      const days = Math.max(1, Math.floor((maxEnd - minStart) / DAY_MS));
      const daily = new Array(days).fill(0);
      for (const t of rep.trades) {
        const d = Math.floor((t.exitTime - minStart) / DAY_MS);
        if (d >= 0 && d < days) daily[d] += t.netPnlPct;
      }
      strats.push({
        label: `${sym.replace("USDT", "")} ${edge.cfg.mode}`,
        trades: rep.trades.length,
        tradeWR,
        daily,
        weight: edge.recommendedWeight,
      });
    }

    console.log("PER-TRADE WIN RATE (single-asset edges):");
    console.log(
      "strategy".padEnd(20) + "trades".padStart(8) + "WR%".padStart(8),
    );
    for (const s of strats) {
      console.log(
        s.label.padEnd(20) +
          s.trades.toString().padStart(8) +
          (s.tradeWR * 100).toFixed(1).padStart(7) +
          "%",
      );
    }
    const avgTradeWR =
      strats.reduce((a, s) => a + s.tradeWR, 0) / strats.length;
    console.log(
      `\nAvg per-trade WR across 7 edges: ${(avgTradeWR * 100).toFixed(1)}%`,
    );

    // Per-day win rate per strategy
    console.log("\nPER-DAY WIN RATE (% of days strategy was green):");
    for (const s of strats) {
      const greenDays = s.daily.filter((r) => r > 0).length;
      const tradedDays = s.daily.filter((r) => r !== 0).length;
      const totalDays = s.daily.length;
      const greenOfTraded = tradedDays > 0 ? greenDays / tradedDays : 0;
      const greenOfAll = greenDays / totalDays;
      console.log(
        `  ${s.label.padEnd(18)}  green/total=${(greenOfAll * 100).toFixed(1)}%  green/active=${(greenOfTraded * 100).toFixed(1)}%  active-days=${tradedDays}/${totalDays}`,
      );
    }

    // Equal-weight + inv-vol portfolio
    const days = strats[0].daily.length;
    const portEq = new Array(days).fill(0);
    const portIv = new Array(days).fill(0);
    for (let d = 0; d < days; d++) {
      let sumEq = 0,
        sumIv = 0;
      for (const s of strats) {
        sumEq += s.daily[d] / strats.length;
        sumIv += s.daily[d] * s.weight;
      }
      portEq[d] = sumEq;
      portIv[d] = sumIv;
    }
    const eqGreen = portEq.filter((r) => r > 0).length;
    const eqRed = portEq.filter((r) => r < 0).length;
    const eqFlat = portEq.filter((r) => r === 0).length;
    const ivGreen = portIv.filter((r) => r > 0).length;
    const ivRed = portIv.filter((r) => r < 0).length;
    const ivFlat = portIv.filter((r) => r === 0).length;

    console.log("\nPORTFOLIO-LEVEL DAILY WIN RATE (416 days):");
    console.log(
      `  Equal-weight     green ${eqGreen} (${((eqGreen / days) * 100).toFixed(1)}%)  red ${eqRed} (${((eqRed / days) * 100).toFixed(1)}%)  flat ${eqFlat} (${((eqFlat / days) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Inverse-vol      green ${ivGreen} (${((ivGreen / days) * 100).toFixed(1)}%)  red ${ivRed} (${((ivRed / days) * 100).toFixed(1)}%)  flat ${ivFlat} (${((ivFlat / days) * 100).toFixed(1)}%)`,
    );

    // Of days where SOMETHING traded, what's WR?
    const eqActiveDays = portEq.filter((r) => r !== 0).length;
    const ivActiveDays = portIv.filter((r) => r !== 0).length;
    console.log(`\nOf only the days the portfolio actually had a position:`);
    console.log(
      `  Equal-weight: ${eqGreen}/${eqActiveDays} = ${((eqGreen / eqActiveDays) * 100).toFixed(1)}% green`,
    );
    console.log(
      `  Inverse-vol:  ${ivGreen}/${ivActiveDays} = ${((ivGreen / ivActiveDays) * 100).toFixed(1)}% green`,
    );
  });
});
