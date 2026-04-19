/**
 * Iter 31b: Walk-forward validation + asymmetric mode (BTC/ETH momentum, SOL fade).
 *
 * 60/40 split: pick best-Sharpe params on first 60% of data, then evaluate
 * on last 40%. If OOS Sharpe stays positive (and ideally close to IS), the
 * edge is robust. If OOS collapses, it was overfit.
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
    name: `${mode} v${p.volMult}×p${p.priceZ} / ${p.holdBars}h`,
    cfg: {
      lookback: 48,
      ...p,
      mode,
      costs: MAKER_COSTS,
    },
  }));
}

function splitInOos(
  candles: Candle[],
  ratio = 0.6,
): { is: Candle[]; oos: Candle[] } {
  const cut = Math.floor(candles.length * ratio);
  return { is: candles.slice(0, cut), oos: candles.slice(cut) };
}

describe("iteration 31b — walk-forward validation + asymmetric mode", () => {
  it(
    "60/40 split: best IS params then OOS evaluate (BTC/ETH/SOL × fade/momentum)",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 31b: WALK-FORWARD VOLUME-SPIKE EDGE ===");
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
      for (const sym of symbols) {
        console.log(`\nFetching ${sym} 1h (~10000)...`);
        const all = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 10000,
        });
        const { is, oos } = splitInOos(all, 0.6);
        console.log(
          `  total=${all.length}  IS=${is.length}  OOS=${oos.length}`,
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
            console.log(`  ${sym} ${mode}: no variant qualified`);
            continue;
          }
          const oosRep = runVolumeSpikeFade(oos, best.cfg);
          console.log(
            `  ${sym} ${mode.padEnd(8)} BEST=${best.name.padEnd(24)} IS_Sh=${best.isSharpe.toFixed(2)}  OOS_Sh=${oosRep.sharpe.toFixed(2)}  OOS_ret=${(oosRep.netReturnPct * 100).toFixed(1)}%  OOS_trades=${oosRep.trades.length}  OOS_DD=${(oosRep.maxDrawdownPct * 100).toFixed(1)}%`,
          );
        }
      }
    },
  );
});
