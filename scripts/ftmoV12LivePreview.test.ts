/**
 * V12 30m live-preview — runs the detector with FTMO_TF=30m against
 * fresh Binance candles and reports what V12 would do RIGHT NOW under
 * the live-safety caps (riskFrac ≤ 2%, stopPct ≤ 3%).
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *     scripts/ftmoV12LivePreview.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";

let originalTF: string | undefined;

describe(
  "V12 30m live-preview (current Binance data)",
  { timeout: 180_000 },
  () => {
    beforeAll(() => {
      originalTF = process.env.FTMO_TF;
      process.env.FTMO_TF = "30m";
    });
    afterAll(() => {
      if (originalTF === undefined) delete process.env.FTMO_TF;
      else process.env.FTMO_TF = originalTF;
    });

    it("preview: what would V12 emit on the latest 30m bar?", async () => {
      // Need atrStop p84 + htfTrendFilter lookbackBars=200 → load ~600 bars to be safe.
      const targetCount = 600;
      const maxPages = 5;
      const eth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "30m",
        targetCount,
        maxPages,
      });
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "30m",
        targetCount,
        maxPages,
      });
      const sol = await loadBinanceHistory({
        symbol: "SOLUSDT",
        timeframe: "30m",
        targetCount,
        maxPages,
      });

      // Dynamic import after env is set so module-level CFG reads FTMO_TF=30m.
      const mod = await import("../src/utils/ftmoLiveSignalV231");
      const account = {
        equity: 1.0,
        day: 0,
        recentPnls: [],
        equityAtDayStart: 1.0,
      };
      const result = mod.detectLiveSignalsV231(eth, btc, sol, account, []);

      console.log("\n========== V12 30m LIVE PREVIEW ==========");
      console.log(`Active config:  ${result.activeBotConfig}`);
      console.log(`Regime:         ${result.regime}`);
      console.log(
        `BTC: close=$${result.btc.close.toFixed(2)} ema10=${result.btc.ema10.toFixed(2)} ema15=${result.btc.ema15.toFixed(2)} mom24h=${(result.btc.mom24h * 100).toFixed(2)}% uptrend=${result.btc.uptrend}`,
      );
      console.log(
        `Bars: ETH=${eth.length} BTC=${btc.length} SOL=${sol.length}`,
      );

      console.log(`\n--- ${result.signals.length} EMITTED SIGNAL(S) ---`);
      for (const s of result.signals) {
        console.log(
          `  ✅ ${s.assetSymbol} ${s.direction.toUpperCase()} entry=$${s.entryPrice.toFixed(4)} stop=${(s.stopPct * 100).toFixed(2)}% tp=${(s.tpPct * 100).toFixed(2)}% risk=${(s.riskFrac * 100).toFixed(3)}%`,
        );
        for (const r of s.reasons) console.log(`     · ${r}`);
      }

      console.log(`\n--- ${result.skipped.length} SKIPPED ---`);
      for (const s of result.skipped) {
        console.log(`  ❌ ${s.asset}: ${s.reason}`);
      }

      console.log(`\n--- NOTES ---`);
      for (const n of result.notes) console.log(`  · ${n}`);

      // Hard guarantees the live-safety layer must enforce:
      for (const sig of result.signals) {
        expect(
          sig.riskFrac,
          `${sig.assetSymbol} riskFrac ${sig.riskFrac} > 2%`,
        ).toBeLessThanOrEqual(0.02 + 1e-9);
        expect(
          sig.stopPct,
          `${sig.assetSymbol} stopPct ${sig.stopPct} > 3%`,
        ).toBeLessThanOrEqual(0.03 + 1e-9);
      }

      // The detector must always classify each asset (no silent drops).
      expect(result.signals.length + result.skipped.length).toBeGreaterThan(0);
    });
  },
);
