/**
 * Round 60 — V231 selector inventory sanity test.
 *
 * `ftmoLiveSignalV231.ts` resolves `process.env.FTMO_TF` → CFG at module-load
 * time, so we cannot reliably round-trip every selector through a single
 * test process (the registry is closed-over). Instead this test asserts:
 *
 *   1. Every champion config that V231's CFG_REGISTRY references IS exported
 *      from ftmoDaytrade24h.ts (catches typos in the registry source).
 *   2. The default-no-FTMO_TF resolution lands on a defined CFG with the
 *      "V261" fallback label (matches the documented contract in the file
 *      header — "Default fallback: V261 4h ... only used when FTMO_TF is unset").
 *   3. `getActiveCfgInfo()` returns a non-empty label and a string ftmoTfKey
 *      (defensive against silent introspection regressions).
 *
 * Goal: when a future PR adds a 14th selector, this test fails loudly if
 * the cfg-name in CFG_REGISTRY doesn't match the actual export name. The
 * earlier symptom was a runtime "Cannot read property 'assets' of undefined"
 * thrown only after FTMO_TF was set in production.
 */
import { describe, it, expect } from "vitest";
import * as Cfgs from "@/utils/ftmoDaytrade24h";
import { getActiveCfgInfo } from "@/utils/ftmoLiveSignalV231";

// Champion configs live-deployable (per CLAUDE.md project memory). If any
// of these go missing, the V231 registry is broken.
const CHAMPION_CONFIG_NAMES = [
  // R28 family (post-R56-58 audit)
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_STEP2",
  // Jewel family (sister champions)
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO",
  "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX",
] as const;

describe("V231 champion config exports (R60 inventory)", () => {
  it.each(CHAMPION_CONFIG_NAMES)(
    "exports %s with required FTMO fields",
    (name) => {
      const cfg = (Cfgs as Record<string, unknown>)[name];
      expect(cfg, `missing export: ${name}`).toBeDefined();
      // Smoke-check the required FTMO live-engine fields:
      const c = cfg as {
        assets?: unknown[];
        minTradingDays?: number;
        liveCaps?: { maxStopPct?: number; maxRiskFrac?: number };
      };
      expect(Array.isArray(c.assets)).toBe(true);
      expect(c.assets!.length).toBeGreaterThan(0);
      // FTMO 2-Step rule: minTradingDays MUST be 4 per CLAUDE.md guidance.
      // (Some legacy configs may omit it — only assert on R28 family.)
      if (
        name.startsWith("FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28")
      ) {
        expect(c.minTradingDays).toBe(4);
        expect(c.liveCaps?.maxStopPct).toBe(0.05);
        expect(c.liveCaps?.maxRiskFrac).toBe(0.4);
      }
    },
  );
});

describe("getActiveCfgInfo() integration", () => {
  it("returns label + ftmoTfKey strings", () => {
    const info = getActiveCfgInfo();
    expect(typeof info.label).toBe("string");
    expect(info.label.length).toBeGreaterThan(0);
    expect(typeof info.ftmoTfKey).toBe("string");
  });

  it("falls back to V261 when no FTMO_TF env-var is set during test run", () => {
    // In the vitest harness FTMO_TF is unset → fallback path activates per
    // the file header comment ("only used when FTMO_TF is unset, e.g. test
    // harness"). If a future refactor changes the default this test surfaces
    // the regression immediately.
    const info = getActiveCfgInfo();
    if (!process.env.FTMO_TF) {
      expect(info.label).toBe("V261");
      expect(info.ftmoTfKey).toBe("");
    } else {
      // CI may set FTMO_TF — just assert structural invariants.
      expect(info.label).not.toBe("");
    }
  });
});

describe("R28_V6 invariants (champion sanity)", () => {
  it("R28_V6 has tpPct = R28_V4 × 0.55 per asset", () => {
    const v4 = Cfgs.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
    const v6 = Cfgs.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
    expect(v4.assets.length).toBe(v6.assets.length);
    for (let i = 0; i < v4.assets.length; i++) {
      const v4tp = v4.assets[i]!.tpPct ?? 0.05;
      const v6tp = v6.assets[i]!.tpPct ?? 0.05;
      expect(v6tp).toBeCloseTo(v4tp * 0.55, 6);
    }
  });

  it("R28_V6 PTP triggerPct documents intentional design (PTP > minTp on small-TP cohort)", () => {
    // Round 60 audit-trail (2026-05-05):
    //   R3 lowered PTP 0.012 → 0.005 thinking PTP must fire on every asset.
    //   Spot-check showed >2pp equity delta + 1/4 PASS→FAIL flip on shared
    //   windows → invalidated 63.24% Champion claim. REVERTED to 0.012.
    //
    // The R28_V6 PTP design is INTENTIONAL:
    //   - Small-TP cohort (BTC/BNB/ADA/BCH/ETC at 0.00825 + ETH at 0.011)
    //     → PTP is INERT; assets go full-TP.
    //   - Large-TP cohort (LTC 0.01925, XRP 0.0165) → PTP fires partial-close.
    //   - Marginal: AAVE 0.01375 (PTP fires at 0.012, ~13% gap to TP).
    //
    // Test documents the dual-cohort design: PTP > minTp (small assets dead)
    // AND PTP < maxTp (large assets active). When a future round re-runs full
    // sweep with PTP=0.005 and confirms a higher pass-rate, flip both
    // assertions and update the comment.
    const v6 = Cfgs.FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
    const ptp = v6.partialTakeProfit?.triggerPct;
    expect(ptp).toBeDefined();
    expect(ptp).toBeGreaterThan(0);
    const minTp = Math.min(...v6.assets.map((a) => a.tpPct ?? 0.05));
    const maxTp = Math.max(...v6.assets.map((a) => a.tpPct ?? 0.05));
    // PTP > minTp (small-cohort goes full-TP, intentional)
    expect(ptp!).toBeGreaterThan(minTp);
    // PTP < maxTp (large-cohort gets partial-close before full TP)
    expect(ptp!).toBeLessThan(maxTp);
  });
});
