/**
 * Round 30 — V12 / R28 Live-Signal Feature Coverage
 *
 * Verifies that V12_30M_OPT, V12_TURBO and R28 use only config fields whose
 * effects are demonstrably handled by the live pipeline.
 *
 * Round 59 — converted from source-grep coverage to behavior assertions.
 * The original test read ftmoLiveSignalV231.ts + ftmo_executor.py as text
 * and `expect(src).toMatch(/CFG\.<field>/)` for 9 + 6 fields. That is a
 * source-text test, not a behavior test: trivially passes for dead-code
 * references and trivially breaks under behavior-preserving refactors.
 *
 * Behavior coverage now lives in:
 *   - src/__tests__/ftmoLiveSignalRound54.test.ts (peakDrawdownThrottle)
 *   - src/__tests__/ftmoLiveSignalChallengePeak.test.ts
 *   - src/__tests__/ftmoLiveSignalRound51*.test.ts
 *   - tools/test_engine_features.py (PTP, chandelier, breakEven, day_peak,
 *     MAX_CONCURRENT_TRADES, RISK_FRAC_HARD_CAP, check_target_and_pause)
 *   - tools/test_ftmo_executor.py
 *
 * What this file still asserts:
 *   1. The V12 / V12_TURBO / R28 configs *exist and are loadable* (catches
 *      accidental export drops).
 *   2. R28 carries the deployment-critical fields it needs (liveMode,
 *      dailyPeakTrailingStop, partialTakeProfit) — caught early via
 *      typed access, not regex on source text.
 *   3. Every config has live-cap-respecting risk parameters.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
} from "../src/utils/ftmoDaytrade24h";

describe("Round 30 — V12 / R28 live-deployment config sanity", () => {
  it("V12_30M_OPT is exported with assets and risk parameters", () => {
    const cfg = FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT;
    expect(cfg).toBeDefined();
    expect(cfg.assets.length).toBeGreaterThan(0);
    const used = Object.keys(cfg).filter(
      (k) => cfg[k as keyof typeof cfg] !== undefined,
    );
    expect(used.length).toBeGreaterThan(5);
  });

  it("R28 carries deployment-critical fields", () => {
    const cfg = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28;
    // These are required for a correct live deployment per project memory:
    //  * liveMode disables the engine's exit-time look-ahead bias
    //  * dailyPeakTrailingStop is THE anti-DL feature for V5/R28
    //  * partialTakeProfit boosts winrate without inflating TL
    expect(cfg.liveMode).toBeDefined();
    expect(cfg.dailyPeakTrailingStop).toBeDefined();
    expect(cfg.partialTakeProfit).toBeDefined();
  });

  it("V12 + V12_TURBO + R28 all have non-zero live-cap-respecting risk", () => {
    for (const cfg of [
      FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
      FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
    ]) {
      // cfg.stopPct is the global default; per-asset stopPct is optional override
      const defaultStop = (cfg as { stopPct?: number }).stopPct ?? 0.05;
      for (const a of cfg.assets) {
        expect(a.riskFrac).toBeGreaterThan(0);
        const effStop = a.stopPct ?? defaultStop;
        expect(effStop).toBeGreaterThan(0);
        expect(effStop).toBeLessThanOrEqual(0.06); // live-cap headroom
      }
    }
  });
});
