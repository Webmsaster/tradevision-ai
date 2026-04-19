/**
 * LIVE signal check — fetches current Binance data and runs all evaluators,
 * reports what is firing RIGHT NOW.
 *
 * This is the same code path that the /live/research dashboard calls when
 * rendered in a browser. Running as a test gives us a pretty-printed CLI
 * snapshot of the current market state.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  evaluateHfDaytradingPortfolio,
  HF_DAYTRADING_ASSETS,
} from "../src/utils/hfDaytrading";
import {
  evaluateHighWrPortfolio,
  HIGH_WR_PORTFOLIO_CONFIGS,
} from "../src/utils/highWrScaleOut";
import {
  evaluateVolumeSpikeSignal,
  LOCKED_EDGES,
  lockedEdgeBinanceSymbol,
} from "../src/utils/volumeSpikeSignal";
import type { Candle } from "../src/utils/indicators";

describe("LIVE — current signal state", () => {
  it("fetch + evaluate all edges", { timeout: 300_000 }, async () => {
    const now = new Date();
    console.log(
      `\n╔════════════════════════════════════════════════════╗\n` +
        `║  LIVE SIGNAL SNAPSHOT — ${now.toISOString()}  ║\n` +
        `╚════════════════════════════════════════════════════╝`,
    );

    // ---- HF Daytrading (15m × 10 alts, iter57) ----
    console.log("\n─── HF DAYTRADING (15m × 10 alts, iter57) ───");
    const hfCandles: Record<string, Candle[] | undefined> = {};
    for (const s of HF_DAYTRADING_ASSETS) {
      try {
        hfCandles[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "15m",
          targetCount: 200,
        });
      } catch {
        hfCandles[s] = undefined;
      }
    }
    const hf = evaluateHfDaytradingPortfolio(hfCandles);
    console.log(`Active legs: ${hf.activeSymbols.length} of ${hf.legs.length}`);
    for (const leg of hf.legs) {
      const status = leg.active
        ? `★ ${leg.direction?.toUpperCase()} FADE`
        : leg.filtersFailed.length > 0
          ? `spike-filtered (${leg.filtersFailed.join(", ")})`
          : "idle";
      const detail = leg.active
        ? ` entry=$${leg.entry?.toFixed(4)} tp1=$${leg.tp1?.toFixed(4)} tp2=$${leg.tp2?.toFixed(4)} stop=$${leg.stop?.toFixed(4)}`
        : "";
      console.log(
        `  ${leg.symbol.padEnd(10)} vZ=${leg.vZ.toFixed(2).padStart(5)}×  pZ=${leg.pZ.toFixed(2).padStart(5)}σ  ${status}${detail}`,
      );
    }

    // ---- Hi-WR 1h portfolio (iter53) ----
    console.log("\n─── HI-WR 1h PORTFOLIO (SUI+AVAX+APT, iter53) ───");
    const wrCandles: Record<string, Candle[] | undefined> = {};
    for (const { symbol } of HIGH_WR_PORTFOLIO_CONFIGS) {
      try {
        wrCandles[symbol] = await loadBinanceHistory({
          symbol,
          timeframe: "1h",
          targetCount: 200,
        });
      } catch {
        wrCandles[symbol] = undefined;
      }
    }
    const wr = evaluateHighWrPortfolio(wrCandles);
    console.log(`Active legs: ${wr.activeSymbols.length} of ${wr.legs.length}`);
    for (const leg of wr.legs) {
      const status = leg.active
        ? `★ ${leg.direction?.toUpperCase()} SCALE-OUT`
        : leg.filtersFailed.length > 0
          ? `spike-filtered (${leg.filtersFailed.join(", ")})`
          : "idle";
      console.log(
        `  ${leg.symbol.padEnd(10)} vZ=${leg.vZ.toFixed(2).padStart(5)}×  pZ=${leg.pZ.toFixed(2).padStart(5)}σ  ${status}`,
      );
    }

    // ---- 7 Vol-Spike locked edges (1h, iter34) ----
    console.log("\n─── 7 VOL-SPIKE LOCKED EDGES (1h, iter34) ───");
    const uniqueSyms = Array.from(
      new Set(LOCKED_EDGES.map((e) => lockedEdgeBinanceSymbol(e.symbol))),
    );
    const locked1hCandles: Record<string, Candle[]> = {};
    for (const s of uniqueSyms) {
      try {
        locked1hCandles[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 200,
        });
      } catch {
        // skip
      }
    }
    let activeLocked = 0;
    for (const edge of LOCKED_EDGES) {
      const sym = lockedEdgeBinanceSymbol(edge.symbol);
      const candles = locked1hCandles[sym];
      if (!candles) {
        console.log(`  ${edge.symbol.padEnd(14)} fetch-fail`);
        continue;
      }
      const snap = evaluateVolumeSpikeSignal(edge.symbol, candles, {
        cfg: edge.cfg,
        edgeMeta: {
          medianOosSharpe: edge.medianOosSharpe,
          minOosSharpe: edge.minOosSharpe,
          pctProfitable: edge.pctProfitable,
          recommendedWeight: edge.recommendedWeight,
        },
      });
      if (snap.active) activeLocked++;
      const status = snap.active
        ? `★ ${snap.direction?.toUpperCase()} ${snap.mode.toUpperCase()}`
        : "idle";
      const detail = snap.active
        ? ` entry=$${snap.entry?.toFixed(4)} stop=$${snap.stop?.toFixed(4)}`
        : "";
      console.log(
        `  ${snap.displayLabel.padEnd(18)} vZ=${snap.vZ.toFixed(2).padStart(5)}×  pZ=${snap.pZ.toFixed(2).padStart(5)}σ  medSh=${edge.medianOosSharpe.toFixed(2)}  ${status}${detail}`,
      );
    }
    console.log(
      `\n  Active: ${activeLocked} of ${LOCKED_EDGES.length} vol-spike edges`,
    );

    // ---- Final summary ----
    const totalActive =
      hf.activeSymbols.length + wr.activeSymbols.length + activeLocked;
    console.log(
      `\n╔════════════════════════════════════════════════════╗` +
        `\n║  TOTAL ACTIVE SIGNALS: ${totalActive}${" ".repeat(Math.max(0, 28 - String(totalActive).length))}║` +
        `\n╚════════════════════════════════════════════════════╝`,
    );
    if (totalActive === 0) {
      console.log(
        "\n  No active signals right now. The strategies are selective —\n" +
          "  most of the time the market is not in a triggerable state.\n" +
          "  Come back in 1-4 hours and re-run this script.",
      );
    } else {
      console.log(
        "\n  Signals above are tradeable RIGHT NOW on Binance Futures.\n" +
          "  Use maker orders (post-only) at the entry price shown.\n" +
          "  Exit at TP1/TP2/Stop levels as noted per signal.",
      );
    }
  });
});
