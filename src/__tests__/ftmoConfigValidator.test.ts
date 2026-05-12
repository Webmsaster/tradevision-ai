/**
 * R29 Round 4 audit fix — validator coverage test.
 *
 * Verifies that `assertConfigValid` is wired up correctly and that every
 * live-deployable champion config (R28_V6_PASSLOCK + the 3-Strategy
 * multi-account stack) actually passes the FTMO safety constraints.
 *
 * Why a dedicated test:
 *   - The validator was added in R3, but only runs at module-load of
 *     `ftmoLiveSignalV231.ts`, which is hard to exercise inside vitest
 *     (singleton module init). Without this file, a regression where the
 *     champion lost `liveCaps` or `pauseAtTargetReached` would only blow up
 *     at PM2 startup on the live server — too late.
 *   - Also doubles as a contract test for the validator itself (each rule
 *     fires under a tampered config).
 */
import { describe, it, expect } from "vitest";
import { assertConfigValid } from "@/utils/ftmoConfigValidator";
import * as CFGS from "@/utils/ftmoDaytrade24h";
import type { FtmoDaytrade24hConfig } from "@/utils/ftmoDaytrade24h";

// Champion configs that are live-deployable per CLAUDE.md / MEMORY.md.
// Every entry here MUST satisfy assertConfigValid without
// FTMO_ALLOW_UNSAFE_CONFIG=1. Add new champions as they get promoted.
const LIVE_DEPLOYABLE_CHAMPIONS: ReadonlyArray<readonly [string, string]> = [
  // R28_V6 family — active single-account champion
  ["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK", "R28_V6_PASSLOCK"],
  ["FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6", "R28_V6"],
  // 3-Strategy multi-account stack (CLAUDE.md: ~91% min-1-pass)
  ["FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK", "V5_TITANIUM_PASSLOCK"],
  ["FTMO_DAYTRADE_24H_V5_AMBER_PASSLOCK", "V5_AMBER_PASSLOCK"],
  ["FTMO_DAYTRADE_24H_V5_OBSIDIAN_PASSLOCK", "V5_OBSIDIAN_PASSLOCK"],
  [
    "FTMO_DAYTRADE_24H_V5_QUARTZ_LITE_R28_PASSLOCK",
    "V5_QUARTZ_LITE_R28_PASSLOCK",
  ],
  // Sister champions (live-deployable for diversification)
  ["FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM", "V5_TITANIUM"],
  ["FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER", "V5_AMBER"],
  ["FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN", "V5_RUBIN"],
  ["FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ", "V5_TOPAZ"],
];

describe("ftmoConfigValidator — live-deployable champions", () => {
  for (const [key, label] of LIVE_DEPLOYABLE_CHAMPIONS) {
    it(`${label} satisfies all FTMO safety rules`, () => {
      const cfg = (
        CFGS as unknown as Record<string, FtmoDaytrade24hConfig | undefined>
      )[key];
      expect(
        cfg,
        `Config export "${key}" missing from ftmoDaytrade24h.ts`,
      ).toBeDefined();
      expect(() =>
        assertConfigValid(cfg as FtmoDaytrade24hConfig, label),
      ).not.toThrow();
    });
  }
});

describe("PASSLOCK sister selectors carry closeAllOnTargetReached", () => {
  // R29 Round 4 audit fix (R4-Bug #1): without this assertion the multi-account
  // 3-Strategy stack runs without Pass-Lock (~8pp loss). The ftmoLiveService
  // `useV4Engine` routing now triggers on any cfg carrying
  // closeAllOnTargetReached, so this also acts as the contract that ensures
  // these selectors stay on the V4-Engine path.
  const PASSLOCK_SISTERS: ReadonlyArray<readonly [string, string]> = [
    ["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK", "R28_V6_PASSLOCK"],
    ["FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK", "V5_TITANIUM_PASSLOCK"],
    ["FTMO_DAYTRADE_24H_V5_AMBER_PASSLOCK", "V5_AMBER_PASSLOCK"],
    ["FTMO_DAYTRADE_24H_V5_OBSIDIAN_PASSLOCK", "V5_OBSIDIAN_PASSLOCK"],
    [
      "FTMO_DAYTRADE_24H_V5_QUARTZ_LITE_R28_PASSLOCK",
      "V5_QUARTZ_LITE_R28_PASSLOCK",
    ],
  ];

  for (const [key, label] of PASSLOCK_SISTERS) {
    it(`${label} has closeAllOnTargetReached=true`, () => {
      const cfg = (
        CFGS as unknown as Record<string, FtmoDaytrade24hConfig | undefined>
      )[key];
      expect(cfg).toBeDefined();
      expect(cfg?.closeAllOnTargetReached).toBe(true);
    });
  }
});

describe("CFG_REGISTRY ↔ TF_DISPATCH completeness", () => {
  // R29 Round 4 audit fix (R4-Bug #3): selectors missing from TF_DISPATCH that
  // also miss a prefix-rule fall-through silently route to "4h" — catastrophic
  // when CFG.timeframe is 5m/15m/30m. Cross-check both lists from source.
  it("every CFG_REGISTRY key has a TF_DISPATCH route or fail-loud handler", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const v231Src = fs.readFileSync(
      path.resolve(__dirname, "../utils/ftmoLiveSignalV231.ts"),
      "utf8",
    );
    const serviceSrc = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/ftmoLiveService.ts"),
      "utf8",
    );
    // Extract CFG_REGISTRY keys (lines like `  "2h-trend-…": {` inside the
    // CFG_REGISTRY block).
    const registryBlock =
      v231Src.match(/const CFG_REGISTRY[\s\S]+?^};/m)?.[0] ?? "";
    const cfgKeys: string[] = [
      ...registryBlock.matchAll(/^\s+"([^"]+)":\s*\{/gm),
    ]
      .map((m) => m[1] ?? "")
      .filter((s) => s.length > 0);
    expect(cfgKeys.length).toBeGreaterThan(40);
    // Extract TF_DISPATCH keys.
    const dispatchBlock =
      serviceSrc.match(/const TF_DISPATCH[\s\S]+?^};/m)?.[0] ?? "";
    const dispatchKeys = new Set<string>(
      [...dispatchBlock.matchAll(/^\s+"([^"]+)":\s*"/gm)]
        .map((m) => m[1] ?? "")
        .filter((s) => s.length > 0),
    );
    const missing: string[] = [];
    for (const k of cfgKeys) {
      if (dispatchKeys.has(k)) continue;
      // Fall-through rules from resolveTf():
      //   1. startsWith("2h-trend-v5-") → throws (acceptable: explicit reject)
      //   2. startsWith("2h-trend")     → routes to "2h" (legacy non-v5)
      //   3. /^(5m|15m|30m|1h|2h|4h)-live(-v\d+)?$/ → throws (R4 fix)
      if (k.startsWith("2h-trend-v5-")) continue;
      if (k.startsWith("2h-trend")) continue;
      if (/^(5m|15m|30m|1h|2h|4h)-live(-v\d+)?$/.test(k)) continue;
      missing.push(k);
    }
    expect(
      missing,
      `Selectors in CFG_REGISTRY but unroutable in TF_DISPATCH (will default to 4h): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("ftmoConfigValidator — rule enforcement", () => {
  const base = CFGS.FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;

  it("rejects config missing pauseAtTargetReached", () => {
    const bad: FtmoDaytrade24hConfig = { ...base, pauseAtTargetReached: false };
    expect(() => assertConfigValid(bad, "tampered")).toThrow(
      /pauseAtTargetReached/,
    );
  });

  it("rejects config missing atrStop", () => {
    const bad: FtmoDaytrade24hConfig = {
      ...base,
      atrStop: undefined as unknown as FtmoDaytrade24hConfig["atrStop"],
    };
    expect(() => assertConfigValid(bad, "tampered")).toThrow(/atrStop/);
  });

  it("rejects liveCaps.maxStopPct > 0.05", () => {
    const bad: FtmoDaytrade24hConfig = {
      ...base,
      liveCaps: { maxStopPct: 0.08, maxRiskFrac: 0.4 },
    };
    expect(() => assertConfigValid(bad, "tampered")).toThrow(/maxStopPct/);
  });

  it("rejects liveCaps.maxRiskFrac > 0.4", () => {
    const bad: FtmoDaytrade24hConfig = {
      ...base,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.6 },
    };
    expect(() => assertConfigValid(bad, "tampered")).toThrow(/maxRiskFrac/);
  });

  it("rejects minTradingDays < 4", () => {
    const bad: FtmoDaytrade24hConfig = { ...base, minTradingDays: 2 };
    expect(() => assertConfigValid(bad, "tampered")).toThrow(/minTradingDays/);
  });

  it("FTMO_ALLOW_UNSAFE_CONFIG=1 bypasses all checks", () => {
    const prev = process.env.FTMO_ALLOW_UNSAFE_CONFIG;
    process.env.FTMO_ALLOW_UNSAFE_CONFIG = "1";
    try {
      const bad: FtmoDaytrade24hConfig = {
        ...base,
        pauseAtTargetReached: false,
        minTradingDays: 0,
      };
      expect(() => assertConfigValid(bad, "research")).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.FTMO_ALLOW_UNSAFE_CONFIG;
      else process.env.FTMO_ALLOW_UNSAFE_CONFIG = prev;
    }
  });
});
