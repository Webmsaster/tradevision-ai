/**
 * Iter 33: Volume-Spike Fade/Momentum across 8 alts.
 *
 * Hypothesis: SOL is retail-dominated → fade works. Other Solana-ecosystem
 * + L2 + DeFi alts may show similar retail-cohort dynamics. Test BOTH
 * fade and momentum modes per asset over a 9-variant matrix to discover
 * which assets have a usable edge in either direction.
 *
 * Output: per-asset best-IS variant + OOS Sharpe via 60/40 walk-forward.
 * Honest filter: OOS Sharpe ≥ 1.0 AND OOS trades ≥ 30 AND IS sign matches OOS sign.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runVolumeSpikeFade,
  type VolumeSpikeFadeConfig,
} from "../src/utils/volumeSpikeFade";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import type { Candle } from "../src/utils/indicators";

interface Variant {
  name: string;
  cfg: VolumeSpikeFadeConfig;
}

function buildVariants(mode: "fade" | "momentum"): Variant[] {
  const params = [
    { volMult: 3, priceZ: 2.0, holdBars: 4, stopPct: 0.01 },
    { volMult: 3, priceZ: 2.0, holdBars: 6, stopPct: 0.012 },
    { volMult: 3, priceZ: 2.5, holdBars: 6, stopPct: 0.012 },
    { volMult: 4, priceZ: 2.0, holdBars: 6, stopPct: 0.012 },
    { volMult: 5, priceZ: 2.0, holdBars: 4, stopPct: 0.01 },
    { volMult: 5, priceZ: 2.0, holdBars: 6, stopPct: 0.012 },
    { volMult: 5, priceZ: 2.5, holdBars: 6, stopPct: 0.012 },
    { volMult: 6, priceZ: 2.5, holdBars: 6, stopPct: 0.015 },
  ];
  return params.map((p) => ({
    name: `${mode} v${p.volMult}×p${p.priceZ}/${p.holdBars}h`,
    cfg: { lookback: 48, ...p, mode, costs: MAKER_COSTS },
  }));
}

function splitInOos(
  candles: Candle[],
  ratio = 0.6,
): { is: Candle[]; oos: Candle[] } {
  const cut = Math.floor(candles.length * ratio);
  return { is: candles.slice(0, cut), oos: candles.slice(cut) };
}

interface FinalResult {
  symbol: string;
  mode: "fade" | "momentum";
  variant: string;
  isSharpe: number;
  oosSharpe: number;
  oosRetPct: number;
  oosTrades: number;
  oosDdPct: number;
  passed: boolean;
}

describe("iteration 33 — alt-coin volume-spike sweep", () => {
  it(
    "8 alts × fade/momentum × walk-forward",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 33: ALT VOLUME-SPIKE SWEEP ===");

      // Liquid alts available on Binance with reasonable history.
      // Mix L1, L2, DeFi, ecosystem.
      const symbols = [
        "AVAXUSDT",
        "MATICUSDT",
        "ARBUSDT",
        "OPUSDT",
        "INJUSDT",
        "NEARUSDT",
        "APTUSDT",
        "SUIUSDT",
      ];

      const allResults: FinalResult[] = [];
      for (const sym of symbols) {
        let all: Candle[] = [];
        try {
          all = await loadBinanceHistory({
            symbol: sym,
            timeframe: "1h",
            targetCount: 10000,
          });
        } catch (err) {
          console.log(`  ${sym}: fetch failed (${(err as Error).message})`);
          continue;
        }
        if (all.length < 3000) {
          console.log(
            `  ${sym}: too little history (${all.length} bars). Skip.`,
          );
          continue;
        }
        const { is, oos } = splitInOos(all, 0.6);
        console.log(
          `\n${sym}  total=${all.length}  IS=${is.length}  OOS=${oos.length}`,
        );

        for (const mode of ["fade", "momentum"] as const) {
          const variants = buildVariants(mode);
          let best: {
            name: string;
            isSharpe: number;
            cfg: VolumeSpikeFadeConfig;
          } | null = null;
          for (const v of variants) {
            const rep = runVolumeSpikeFade(is, v.cfg);
            if (rep.trades.length < 10) continue;
            if (!best || rep.sharpe > best.isSharpe) {
              best = { name: v.name, isSharpe: rep.sharpe, cfg: v.cfg };
            }
          }
          if (!best) {
            console.log(`  ${sym} ${mode}: no qualifying variant`);
            continue;
          }
          const oosRep = runVolumeSpikeFade(oos, best.cfg);
          const passed =
            oosRep.sharpe >= 1.0 &&
            oosRep.trades.length >= 30 &&
            best.isSharpe > 0;
          allResults.push({
            symbol: sym,
            mode,
            variant: best.name,
            isSharpe: best.isSharpe,
            oosSharpe: oosRep.sharpe,
            oosRetPct: oosRep.netReturnPct * 100,
            oosTrades: oosRep.trades.length,
            oosDdPct: oosRep.maxDrawdownPct * 100,
            passed,
          });
          console.log(
            `  ${mode.padEnd(8)} BEST=${best.name.padEnd(28)} IS=${best.isSharpe.toFixed(2).padStart(6)}  OOS=${oosRep.sharpe.toFixed(2).padStart(6)}  OOSret=${(oosRep.netReturnPct * 100).toFixed(1).padStart(6)}%  trades=${oosRep.trades.length.toString().padStart(4)}  DD=${(oosRep.maxDrawdownPct * 100).toFixed(1)}%${passed ? "  ★" : ""}`,
          );
        }
      }

      console.log(
        "\n=== SUMMARY: ★ = OOS Sharpe ≥ 1.0, OOS trades ≥ 30, IS sign positive ===",
      );
      const winners = allResults.filter((r) => r.passed);
      console.log(
        `Winners: ${winners.length} / ${allResults.length} configurations tested`,
      );
      for (const w of winners.sort((a, b) => b.oosSharpe - a.oosSharpe)) {
        console.log(
          `  ★ ${w.symbol} ${w.mode}  ${w.variant}  IS=${w.isSharpe.toFixed(2)}  OOS=${w.oosSharpe.toFixed(2)}  +${w.oosRetPct.toFixed(1)}%  ${w.oosTrades}t  DD=${w.oosDdPct.toFixed(1)}%`,
        );
      }
      if (winners.length === 0) {
        console.log("  (none — only SOL Fade remains the validated edge)");
      }
    },
  );
});
