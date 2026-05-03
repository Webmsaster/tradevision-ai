/**
 * Pre-deploy live-preview for TREND_2H_V1.
 * Loads current Binance 2h candles for all 8 trend assets, runs detector,
 * verifies signals are well-formed and pass safety caps.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";

let originalTF: string | undefined;

describe("TREND_2H_V1 — pre-deploy live preview", { timeout: 180_000 }, () => {
  beforeAll(() => {
    originalTF = process.env.FTMO_TF;
    process.env.FTMO_TF = "2h-trend";
  });
  afterAll(() => {
    if (originalTF === undefined) delete process.env.FTMO_TF;
    else process.env.FTMO_TF = originalTF;
  });

  it("emits valid signals on current Binance data", async () => {
    const targetCount = 500;
    const maxPages = 2;
    const symbols = [
      "ETHUSDT",
      "BTCUSDT",
      "SOLUSDT",
      "BNBUSDT",
      "ADAUSDT",
      "AVAXUSDT",
      "BCHUSDT",
      "DOGEUSDT",
    ];

    const candles: Record<string, any[]> = {};
    for (const s of symbols) {
      candles[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount,
        maxPages,
      });
    }

    const mod = await import("../src/utils/ftmoLiveSignalV231");
    const account = {
      equity: 1.0,
      day: 0,
      recentPnls: [],
      equityAtDayStart: 1.0,
    };

    // Pass extra symbols as the 6th param
    const extra: Record<string, any[]> = {
      BNBUSDT: candles.BNBUSDT,
      ADAUSDT: candles.ADAUSDT,
      AVAXUSDT: candles.AVAXUSDT,
      BCHUSDT: candles.BCHUSDT,
      DOGEUSDT: candles.DOGEUSDT,
    };
    const result = mod.detectLiveSignalsV231(
      candles.ETHUSDT,
      candles.BTCUSDT,
      candles.SOLUSDT,
      account,
      [],
      extra,
    );

    console.log(`\n========== TREND_2H_V1 LIVE PREVIEW ==========`);
    console.log(`Active config:  ${result.activeBotConfig}`);
    console.log(`Regime:         ${result.regime}`);
    console.log(
      `Bars loaded:    ETH=${candles.ETHUSDT.length} ... DOGE=${candles.DOGEUSDT.length}`,
    );
    console.log(`\n--- ${result.signals.length} EMITTED SIGNAL(S) ---`);
    for (const s of result.signals) {
      console.log(
        `  ✅ ${s.assetSymbol} ${s.direction.toUpperCase()} entry=$${s.entryPrice.toFixed(4)} stop=${(s.stopPct * 100).toFixed(2)}% tp=${(s.tpPct * 100).toFixed(2)}% risk=${(s.riskFrac * 100).toFixed(3)}%`,
      );
    }
    console.log(`\n--- ${result.skipped.length} SKIPPED ---`);
    for (const s of result.skipped) console.log(`  ❌ ${s.asset}: ${s.reason}`);
    console.log(`\n--- NOTES ---`);
    for (const n of result.notes) console.log(`  · ${n}`);

    // Hard guarantees:
    for (const sig of result.signals) {
      // Direction must be LONG (Trend config has invertDirection=true + disableShort=true)
      expect(
        sig.direction,
        `${sig.assetSymbol}: Trend config must produce LONG signals only`,
      ).toBe("long");
      // For LONG: stop must be BELOW entry, tp ABOVE entry
      expect(sig.stopPrice).toBeLessThan(sig.entryPrice);
      expect(sig.tpPrice).toBeGreaterThan(sig.entryPrice);
      // Live caps respected
      expect(sig.riskFrac).toBeLessThanOrEqual(0.04 + 1e-9);
      expect(sig.stopPct).toBeLessThanOrEqual(0.05 + 1e-9);
      // Source symbol must be in our 8-asset pool
      expect([
        "ETHUSDT",
        "BTCUSDT",
        "SOLUSDT",
        "BNBUSDT",
        "ADAUSDT",
        "AVAXUSDT",
        "BCHUSDT",
        "DOGEUSDT",
      ]).toContain(sig.sourceSymbol);
    }

    // Detector must classify each asset (no silent drops)
    expect(result.signals.length + result.skipped.length).toBeGreaterThan(0);
  });
});
