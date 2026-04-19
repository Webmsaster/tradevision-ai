/**
 * Iter 44: Add TP exit to existing 1h locked edges.
 *
 * Hypothesis: the locked vol-spike edges close at hold-time bar (4-6h).
 * Often a trade that was at +0.8% gets given back to break-even or loss.
 * Adding a TP at modest profit converts those into locked wins → higher WR.
 * Test if adding TP improves WR while keeping positive Sharpe.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runIntradayScalp } from "../src/utils/intradayScalp";
import {
  LOCKED_EDGES,
  lockedEdgeBinanceSymbol,
} from "../src/utils/volumeSpikeSignal";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

describe("iteration 44 — locked edges + TP exit", () => {
  it(
    "test TP variants on each locked edge (1h bars)",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 44: LOCKED EDGES + TP EXIT (1h) ===");

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

      interface Row {
        label: string;
        tp: number;
        n: number;
        wr: number;
        pf: number;
        sh: number;
        ret: number;
        dd: number;
      }
      const rows: Row[] = [];

      for (const edge of LOCKED_EDGES) {
        const sym = lockedEdgeBinanceSymbol(edge.symbol);
        const baseLabel = `${sym.replace("USDT", "")} ${edge.cfg.mode}`;

        // Test TP at: 0.5%, 0.8%, 1.0%, 1.5%, 2.0%, 3.0% (with original stop)
        for (const tp of [0.005, 0.008, 0.01, 0.015, 0.02, 0.03]) {
          const r = runIntradayScalp(candlesBy[sym], {
            lookback: edge.cfg.lookback,
            volMult: edge.cfg.volMult,
            priceZ: edge.cfg.priceZ,
            tpPct: tp,
            stopPct: edge.cfg.stopPct,
            holdBars: edge.cfg.holdBars,
            mode: edge.cfg.mode,
            costs: MAKER_COSTS,
          });
          if (r.trades.length < 30) continue;
          rows.push({
            label: baseLabel,
            tp,
            n: r.trades.length,
            wr: r.winRate,
            pf: r.profitFactor,
            sh: r.sharpe,
            ret: r.netReturnPct * 100,
            dd: r.maxDrawdownPct * 100,
          });
        }
      }

      console.log(
        "strategy".padEnd(20) +
          "tp%".padStart(7) +
          "n".padStart(5) +
          "WR%".padStart(7) +
          "PF".padStart(7) +
          "Sh".padStart(7) +
          "ret%".padStart(8) +
          "DD%".padStart(7),
      );
      for (const r of rows.sort(
        (a, b) => a.label.localeCompare(b.label) || a.tp - b.tp,
      )) {
        const passed = r.wr >= 0.6 && r.sh >= 1.0 && r.ret > 0;
        console.log(
          r.label.padEnd(20) +
            (r.tp * 100).toFixed(2).padStart(7) +
            r.n.toString().padStart(5) +
            (r.wr * 100).toFixed(1).padStart(7) +
            r.pf.toFixed(2).padStart(7) +
            r.sh.toFixed(2).padStart(7) +
            r.ret.toFixed(1).padStart(8) +
            r.dd.toFixed(1).padStart(7) +
            (passed ? "  ★" : ""),
        );
      }

      const winners = rows.filter(
        (r) => r.wr >= 0.6 && r.sh >= 1.0 && r.ret > 0,
      );
      console.log(`\n★ Winners (WR≥60%, Sharpe≥1, ret>0): ${winners.length}`);
      for (const w of winners.sort((a, b) => b.sh - a.sh)) {
        console.log(
          `  ${w.label} tp=${(w.tp * 100).toFixed(2)}%  WR=${(w.wr * 100).toFixed(1)}%  Sh=${w.sh.toFixed(2)}  ret=${w.ret.toFixed(1)}%  trades=${w.n}`,
        );
      }
    },
  );
});
