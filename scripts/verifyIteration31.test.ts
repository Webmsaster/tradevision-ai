/**
 * Iter 31: Volume-Spike Fade verification.
 *
 * Tests fading hourly volume spikes accompanied by outsized price moves.
 * Run on BTC, ETH, SOL with realistic maker costs. Validates parameter
 * sensitivity (volMult × priceZ × holdBars).
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runVolumeSpikeFade,
  type VolumeSpikeFadeConfig,
} from "../src/utils/volumeSpikeFade";
import { MAKER_COSTS } from "../src/utils/intradayLab";

interface Variant {
  name: string;
  volMult: number;
  priceZ: number;
  holdBars: number;
  stopPct: number;
  longOnly?: boolean;
  shortOnly?: boolean;
}

describe("iteration 31 — volume-spike fade", () => {
  it(
    "BTC + ETH + SOL volume-spike fade matrix",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 31: VOLUME-SPIKE FADE ===");

      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
      const data: Record<
        string,
        Awaited<ReturnType<typeof loadBinanceHistory>>
      > = {};
      for (const s of symbols) {
        console.log(`Fetching ${s} 1h (~10000 bars)...`);
        const c = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 10000,
        });
        data[s] = c;
        console.log(`  ${s} candles: ${c.length}`);
      }

      const variants: Variant[] = [
        {
          name: "v3×p2.0 / 6h",
          volMult: 3,
          priceZ: 2.0,
          holdBars: 6,
          stopPct: 0.012,
        },
        {
          name: "v3×p2.5 / 6h",
          volMult: 3,
          priceZ: 2.5,
          holdBars: 6,
          stopPct: 0.012,
        },
        {
          name: "v4×p2.0 / 6h",
          volMult: 4,
          priceZ: 2.0,
          holdBars: 6,
          stopPct: 0.012,
        },
        {
          name: "v5×p2.0 / 6h",
          volMult: 5,
          priceZ: 2.0,
          holdBars: 6,
          stopPct: 0.012,
        },
        {
          name: "v5×p2.5 / 6h",
          volMult: 5,
          priceZ: 2.5,
          holdBars: 6,
          stopPct: 0.012,
        },
        {
          name: "v5×p2.5 / 12h",
          volMult: 5,
          priceZ: 2.5,
          holdBars: 12,
          stopPct: 0.015,
        },
        {
          name: "v6×p3.0 / 6h",
          volMult: 6,
          priceZ: 3.0,
          holdBars: 6,
          stopPct: 0.015,
        },
        {
          name: "v3×p2.0 / 4h",
          volMult: 3,
          priceZ: 2.0,
          holdBars: 4,
          stopPct: 0.01,
        },
        {
          name: "v5×p2.0 / 4h",
          volMult: 5,
          priceZ: 2.0,
          holdBars: 4,
          stopPct: 0.01,
        },
      ];

      for (const sym of symbols) {
        console.log(`\n=== ${sym} (n=${data[sym].length}) ===`);
        console.log(
          "config".padEnd(18) +
            "fired".padStart(7) +
            "ret%".padStart(9) +
            "WR%".padStart(7) +
            "PF".padStart(7) +
            "Sharpe".padStart(9) +
            "DD%".padStart(7),
        );
        for (const v of variants) {
          const cfg: VolumeSpikeFadeConfig = {
            lookback: 48,
            volMult: v.volMult,
            priceZ: v.priceZ,
            holdBars: v.holdBars,
            stopPct: v.stopPct,
            costs: MAKER_COSTS,
            longOnly: v.longOnly,
            shortOnly: v.shortOnly,
          };
          const rep = runVolumeSpikeFade(data[sym], cfg);
          console.log(
            v.name.padEnd(18) +
              String(rep.signalsFired).padStart(7) +
              (rep.netReturnPct * 100).toFixed(1).padStart(9) +
              (rep.winRate * 100).toFixed(0).padStart(7) +
              rep.profitFactor.toFixed(2).padStart(7) +
              rep.sharpe.toFixed(2).padStart(9) +
              (rep.maxDrawdownPct * 100).toFixed(1).padStart(7),
          );
        }
      }
    },
  );
});
