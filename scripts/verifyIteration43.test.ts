/**
 * Iter 43: Hunt for ≥60% Win-Rate intraday strategy.
 *
 * Mechanics under test:
 *   1. Shorter timeframe (15m bars instead of 1h) for more trades/day
 *   2. Asymmetric TP/Stop ratios (tight TP, wider stop) → mathematically
 *      converts probability mass into the "winner" bucket
 *
 * Critical honesty check: high WR doesn't equal profitability. We require
 * BOTH WR ≥ 60% AND positive Sharpe AND OOS that holds up.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runIntradayScalp,
  type IntradayScalpConfig,
} from "../src/utils/intradayScalp";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Variant {
  name: string;
  cfg: IntradayScalpConfig;
}

function build(): Variant[] {
  const out: Variant[] = [];
  for (const mode of ["fade", "momentum"] as const) {
    // tp ratio search — each tp/stop combo tests different WR/PF tradeoff
    for (const [tp, st] of [
      [0.0015, 0.005], // tight: 0.15% tp / 0.50% stop  → 1:3.3 ratio
      [0.002, 0.006], // 0.2% / 0.6%  → 1:3
      [0.003, 0.008], // 0.3% / 0.8%  → 1:2.7
      [0.003, 0.006], // 0.3% / 0.6%  → 1:2
      [0.005, 0.01], // 0.5% / 1.0%  → 1:2
      [0.005, 0.008], // 0.5% / 0.8%  → 1:1.6
      [0.005, 0.005], // symmetric    → 1:1
    ]) {
      for (const [vm, pz] of [
        [3, 2.0],
        [4, 2.5],
        [5, 2.5],
      ]) {
        out.push({
          name: `${mode} v${vm}p${pz} tp${(tp * 100).toFixed(2)}/st${(st * 100).toFixed(1)}`,
          cfg: {
            lookback: 96, // 24h on 15m bars
            volMult: vm,
            priceZ: pz,
            tpPct: tp,
            stopPct: st,
            holdBars: 16, // 4h max hold on 15m
            costs: MAKER_COSTS,
            mode,
          },
        });
      }
    }
  }
  return out;
}

describe("iteration 43 — high-WR intraday scalp", () => {
  it(
    "15m bars, asymmetric TP/Stop, find ≥60% WR with positive Sharpe",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 43: HIGH-WIN-RATE INTRADAY SCALP ===");
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT", "SUIUSDT"];
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        console.log(`Fetching ${s} 15m (~10000)...`);
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "15m",
          targetCount: 10000,
        });
        console.log(
          `  ${s}: ${data[s].length}  ≈${((data[s].length * 15) / 60 / 24).toFixed(0)} days`,
        );
      }

      const variants = build();
      console.log(
        `\nTesting ${variants.length} variants × ${symbols.length} symbols = ${variants.length * symbols.length} configs\n`,
      );

      interface Row {
        sym: string;
        name: string;
        mode: string;
        trades: number;
        wr: number;
        pf: number;
        sharpe: number;
        ret: number;
        dd: number;
        tpExits: number;
        stopExits: number;
        timeExits: number;
        passed: boolean;
      }
      const all: Row[] = [];

      for (const sym of symbols) {
        for (const v of variants) {
          const r = runIntradayScalp(data[sym], v.cfg);
          if (r.trades.length < 30) continue;
          const passed =
            r.winRate >= 0.6 && r.sharpe >= 1.0 && r.netReturnPct > 0;
          all.push({
            sym,
            name: v.name,
            mode: v.cfg.mode,
            trades: r.trades.length,
            wr: r.winRate,
            pf: r.profitFactor,
            sharpe: r.sharpe,
            ret: r.netReturnPct * 100,
            dd: r.maxDrawdownPct * 100,
            tpExits: r.tpExits,
            stopExits: r.stopExits,
            timeExits: r.timeExits,
            passed,
          });
        }
      }

      console.log("=== ALL configs with WR≥55% ===");
      console.log(
        "sym".padEnd(10) +
          "config".padEnd(34) +
          "n".padStart(5) +
          "WR%".padStart(7) +
          "PF".padStart(7) +
          "Sh".padStart(7) +
          "ret%".padStart(8) +
          "DD%".padStart(7) +
          "  tp/st/tm",
      );
      for (const r of all
        .filter((x) => x.wr >= 0.55)
        .sort((a, b) => b.wr - a.wr)) {
        console.log(
          r.sym.padEnd(10) +
            r.name.padEnd(34) +
            r.trades.toString().padStart(5) +
            (r.wr * 100).toFixed(1).padStart(7) +
            r.pf.toFixed(2).padStart(7) +
            r.sharpe.toFixed(2).padStart(7) +
            r.ret.toFixed(1).padStart(8) +
            r.dd.toFixed(1).padStart(7) +
            `  ${r.tpExits}/${r.stopExits}/${r.timeExits}` +
            (r.passed ? "  ★" : ""),
        );
      }

      const winners = all.filter((r) => r.passed);
      console.log(
        `\n★ Configs with WR≥60% AND Sharpe≥1.0 AND positive return: ${winners.length}`,
      );
      for (const w of winners.sort((a, b) => b.sharpe - a.sharpe)) {
        console.log(
          `  ${w.sym} ${w.name}  WR=${(w.wr * 100).toFixed(1)}%  Sh=${w.sharpe.toFixed(2)}  ret=${w.ret.toFixed(1)}%  trades=${w.trades}`,
        );
      }
    },
  );
});
