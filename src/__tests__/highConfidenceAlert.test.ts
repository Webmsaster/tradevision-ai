/**
 * highConfidenceAlert tests.
 *
 * evaluateAlert merges champion signal + regime gate + strategy health +
 * net edge + sentiment confluence into a 0-5 star verdict. Covers:
 *   - every star tier (5 take-hard, 4 take, 3 cautious, 2 risky, ≤1 skip)
 *   - every hard-fail path (no signal, funding hour, health PAUSE,
 *     high-confidence opposing confluence)
 *   - missing-data branches (no regime / no health / no confluence)
 *   - direction alignment for both long and short
 *   - evaluateAllAlerts mapping
 *
 * Uses the real regimeGate whitelist (Champion-BTCUSDT allows trend-up,
 * blocks leverage-bull) so the gate integration is exercised, not mocked.
 */
import { describe, expect, it } from "vitest";
import { evaluateAlert, evaluateAllAlerts } from "@/utils/highConfidenceAlert";
import type {
  ChampionSignal,
  StrategyHealthSnapshot,
  CurrentRegime,
} from "@/utils/liveSignals";
import type { SentimentConfluence } from "@/utils/sentimentConfluence";

function makeChampion(overrides: Partial<ChampionSignal> = {}): ChampionSignal {
  return {
    symbol: "BTCUSDT",
    hourUtc: 10,
    nowUtc: "2026-06-11T10:00:00Z",
    aboveSma: true,
    sma50Price: 99_000,
    currentPrice: 100_000,
    longHours: [10],
    shortHours: [],
    action: "long",
    reason: "hour-of-day long window",
    entryPrice: 100_000,
    targetPrice: 101_000,
    stopPrice: 99_000,
    holdUntilUtc: "2026-06-11T14:00:00Z",
    confidence: "high",
    expectedEdgeBps: 5,
    warnings: [],
    ...overrides,
  };
}

function makeHealth(
  overrides: Partial<StrategyHealthSnapshot> = {},
): StrategyHealthSnapshot {
  return {
    symbol: "BTCUSDT",
    strategy: "Champion",
    lifetimeSharpe: 2,
    recentSharpe: 2,
    ratio: 1,
    status: "healthy",
    reason: "recent Sharpe ≈ lifetime",
    ...overrides,
  };
}

function makeRegime(
  regime: CurrentRegime["regime"] = "trend-up",
  symbol = "BTCUSDT",
): CurrentRegime {
  return {
    symbol,
    regime,
    recentWindow: null,
    allowedStrategies: [],
    blockedStrategies: [],
  };
}

function makeConfluence(
  score: number,
  confidence: SentimentConfluence["confidence"] = "high",
): SentimentConfluence {
  return {
    score,
    bias: "neutral",
    confidence,
    components: {
      coinbasePremium: { score: 0, note: "n/a" },
      bybitBasis: { score: 0, note: "n/a" },
      deribitSkew: { score: 0, note: "n/a" },
    },
    interpretation: "",
  };
}

describe("evaluateAlert — star tiers", () => {
  it("5/5 conditions → take-hard with high-conviction summary", () => {
    const v = evaluateAlert(
      makeChampion(),
      [makeHealth()],
      [makeRegime("trend-up")],
      makeConfluence(40, "high"),
    );
    expect(v.stars).toBe(5);
    expect(v.verdict).toBe("take-hard");
    expect(v.summary).toContain("HIGH-CONVICTION LONG");
    expect(v.conditions).toEqual({
      signalFired: true,
      regimeAllows: true,
      healthyStatus: true,
      positiveEdge: true,
      confluenceAligned: true,
    });
    expect(v.detail.join("\n")).toContain("✓ LONG signal fired");
    expect(v.strategy).toBe("Champion-BTCUSDT");
  });

  it("4/5 (weak confluence) → take", () => {
    const v = evaluateAlert(
      makeChampion(),
      [makeHealth()],
      [makeRegime("trend-up")],
      makeConfluence(10, "low"), // |score| < 30 → not aligned
    );
    expect(v.stars).toBe(4);
    expect(v.verdict).toBe("take");
    expect(v.summary).toContain("4/5 conditions");
    expect(v.conditions.confluenceAligned).toBe(false);
    expect(v.detail.join("\n")).toContain("weak/mixed");
  });

  it("3/5 (thin edge + no confluence data) → cautious", () => {
    const v = evaluateAlert(
      makeChampion({ expectedEdgeBps: 2 }),
      [makeHealth()],
      [makeRegime("trend-up")],
      undefined,
    );
    expect(v.stars).toBe(3);
    expect(v.verdict).toBe("cautious");
    expect(v.summary).toContain("half position");
    const detail = v.detail.join("\n");
    expect(detail).toContain("too thin");
    expect(detail).toContain("? No confluence data");
  });

  it("2/5 (regime blocks + thin edge) → risky", () => {
    // Champion-BTCUSDT whitelist has no leverage-bull → gate blocks.
    const v = evaluateAlert(
      makeChampion({ expectedEdgeBps: 1 }),
      [makeHealth()],
      [makeRegime("leverage-bull")],
      undefined,
    );
    expect(v.stars).toBe(2);
    expect(v.verdict).toBe("risky");
    expect(v.conditions.regimeAllows).toBe(false);
    expect(v.detail.join("\n")).toContain("BLOCKS Champion-BTCUSDT");
  });

  it("1/5 (signal only, all data missing) → skip with insufficient-conditions summary", () => {
    const v = evaluateAlert(
      makeChampion({ expectedEdgeBps: 0 }),
      [], // no health data
      [], // no regime data
      undefined,
    );
    expect(v.stars).toBe(1);
    expect(v.verdict).toBe("skip");
    expect(v.summary).toContain("Insufficient conditions (1/5)");
    const detail = v.detail.join("\n");
    expect(detail).toContain("? No regime data for BTCUSDT");
    expect(detail).toContain("? No health data");
  });
});

describe("evaluateAlert — hard-fail paths", () => {
  it("no signal (action=flat) → 0 stars skip, action defaults to long", () => {
    const v = evaluateAlert(
      makeChampion({ action: "flat" }),
      [makeHealth()],
      [makeRegime("trend-up")],
      makeConfluence(40),
    );
    expect(v.stars).toBe(0);
    expect(v.verdict).toBe("skip");
    expect(v.summary).toBe("No active signal this hour");
    expect(v.action).toBe("long");
    expect(v.detail.join("\n")).toContain("✗ No signal (action=flat)");
  });

  it("funding-settle hour forces skip even with all 5 conditions met", () => {
    for (const hourUtc of [0, 8, 16]) {
      const v = evaluateAlert(
        makeChampion({ hourUtc }),
        [makeHealth()],
        [makeRegime("trend-up")],
        makeConfluence(40, "high"),
      );
      expect(v.stars).toBe(0);
      expect(v.verdict).toBe("skip");
      expect(v.summary).toContain("Funding-hour");
      expect(v.detail.join("\n")).toContain(
        `funding-settle hour (${hourUtc}:00 UTC)`,
      );
    }
  });

  it("strategy health PAUSE forces skip", () => {
    const v = evaluateAlert(
      makeChampion(),
      [makeHealth({ status: "pause", ratio: 0.3 })],
      [makeRegime("trend-up")],
      makeConfluence(40, "high"),
    );
    expect(v.stars).toBe(0);
    expect(v.verdict).toBe("skip");
    expect(v.summary).toContain("PAUSE");
    expect(v.detail.join("\n")).toContain("PAUSE (ratio 30%)");
  });

  it("high-confidence opposing confluence (|score| ≥ 50) forces skip", () => {
    const v = evaluateAlert(
      makeChampion({ action: "long" }),
      [makeHealth()],
      [makeRegime("trend-up")],
      makeConfluence(-60, "high"),
    );
    expect(v.stars).toBe(0);
    expect(v.verdict).toBe("skip");
    expect(v.summary).toContain("strongly opposes");
    expect(v.detail.join("\n")).toContain("HARD-FAIL: confluence -60");
  });

  it("moderately opposing confluence (30-50, medium) does NOT hard-fail", () => {
    const v = evaluateAlert(
      makeChampion({ action: "long" }),
      [makeHealth()],
      [makeRegime("trend-up")],
      makeConfluence(-35, "medium"),
    );
    // 4/5 met (confluence not aligned) but no hard-fail → take.
    expect(v.verdict).toBe("take");
    expect(v.stars).toBe(4);
    expect(v.detail.join("\n")).toContain("opposes LONG");
  });
});

describe("evaluateAlert — direction + health nuances", () => {
  it("short signal aligns with strongly negative confluence", () => {
    const v = evaluateAlert(
      makeChampion({ action: "short" }),
      [makeHealth()],
      [makeRegime("trend-down")],
      makeConfluence(-45, "high"),
    );
    expect(v.conditions.confluenceAligned).toBe(true);
    expect(v.stars).toBe(5);
    expect(v.detail.join("\n")).toContain("aligned with SHORT");
  });

  it("WATCH health counts as not-healthy but is not a hard-fail", () => {
    const v = evaluateAlert(
      makeChampion(),
      [makeHealth({ status: "watch", ratio: 0.7 })],
      [makeRegime("trend-up")],
      makeConfluence(40, "high"),
    );
    expect(v.conditions.healthyStatus).toBe(false);
    expect(v.stars).toBe(4);
    expect(v.verdict).toBe("take");
    expect(v.detail.join("\n")).toContain("WATCH (ratio 70%)");
  });
});

describe("evaluateAllAlerts", () => {
  it("evaluates each champion against the shared context", () => {
    const verdicts = evaluateAllAlerts(
      [
        makeChampion({ symbol: "BTCUSDT" }),
        makeChampion({ symbol: "ETHUSDT", action: "flat" }),
      ],
      [makeHealth({ symbol: "BTCUSDT" })],
      [makeRegime("trend-up", "BTCUSDT")],
      makeConfluence(40, "high"),
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]!.symbol).toBe("BTCUSDT");
    expect(verdicts[0]!.verdict).toBe("take-hard");
    expect(verdicts[1]!.symbol).toBe("ETHUSDT");
    expect(verdicts[1]!.verdict).toBe("skip");
  });

  it("returns an empty array for no champions", () => {
    expect(evaluateAllAlerts([], [], [], undefined)).toEqual([]);
  });
});
