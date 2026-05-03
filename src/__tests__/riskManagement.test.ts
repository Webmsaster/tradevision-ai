import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  computeRiskState,
  evaluateEntry,
  DEFAULT_RISK_LIMITS,
} from "@/utils/riskManagement";
import type { ClosedTrade, PaperPosition } from "@/utils/paperTradeLogger";

// Round 58 cleanup: deterministic ID counter (replaces Math.random()).
let _idCounter = 0;

function makeClosed(args: {
  exitTime: string;
  netPnlPct: number;
  symbol?: string;
}): ClosedTrade {
  return {
    id: `t-${++_idCounter}`,
    strategy: "hf-daytrading",
    symbol: args.symbol ?? "SUIUSDT",
    direction: "long",
    entry: 1,
    exit: 1 + args.netPnlPct,
    entryTime: args.exitTime,
    exitTime: args.exitTime,
    grossPnlPct: args.netPnlPct,
    netPnlPct: args.netPnlPct,
    exitReason: "tp2",
  };
}

function makeOpen(args: {
  symbol: string;
  direction: "long" | "short";
  id?: string;
}): PaperPosition {
  return {
    id: args.id ?? `p-${++_idCounter}`,
    strategy: "hf-daytrading",
    symbol: args.symbol,
    direction: args.direction,
    entry: 1,
    stop: 0.97,
    entryTime: new Date().toISOString(),
    holdUntil: new Date(Date.now() + 3600_000).toISOString(),
    tp1Hit: false,
    legs: 2,
  };
}

describe("riskManagement — state computation", () => {
  // Round 58 cleanup: freeze time so Date.now()/new Date() fixtures are stable.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    _idCounter = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes daily realised loss from today's closes only", () => {
    const today = new Date("2026-04-19T14:00:00Z");
    const state = computeRiskState({
      capital: 10000,
      closedTrades: [
        makeClosed({ exitTime: "2026-04-19T10:00:00Z", netPnlPct: -0.02 }),
        makeClosed({ exitTime: "2026-04-19T12:00:00Z", netPnlPct: -0.015 }),
        makeClosed({ exitTime: "2026-04-18T10:00:00Z", netPnlPct: -0.05 }), // yesterday - not counted
      ],
      openPositions: [],
      now: today,
    });
    expect(state.dailyRealisedPct).toBeCloseTo(-0.035, 3);
  });

  it("counts open positions by direction + symbol", () => {
    const state = computeRiskState({
      capital: 10000,
      closedTrades: [],
      openPositions: [
        makeOpen({ symbol: "BTC", direction: "long" }),
        makeOpen({ symbol: "ETH", direction: "long" }),
        makeOpen({ symbol: "SOL", direction: "short" }),
      ],
    });
    expect(state.openCount).toBe(3);
    expect(state.openLongCount).toBe(2);
    expect(state.openShortCount).toBe(1);
    expect(state.bySymbol["BTC"]).toBe(1);
  });
});

describe("riskManagement — entry evaluation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    _idCounter = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects entry when daily loss cap hit", () => {
    const state = computeRiskState({
      capital: 10000,
      closedTrades: [
        makeClosed({
          exitTime: new Date().toISOString(),
          netPnlPct: -0.04,
        }),
      ],
      openPositions: [],
    });
    const d = evaluateEntry({
      state,
      direction: "long",
      symbol: "X",
      notional: 1000,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/daily loss cap/i);
  });

  it("rejects entry when max concurrent reached", () => {
    const opens = Array.from({ length: DEFAULT_RISK_LIMITS.maxConcurrent }).map(
      (_, i) => makeOpen({ symbol: `S${i}`, direction: "long" }),
    );
    const state = computeRiskState({
      capital: 10000,
      closedTrades: [],
      openPositions: opens,
    });
    const d = evaluateEntry({
      state,
      direction: "short",
      symbol: "NEW",
      notional: 100,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/max concurrent/i);
  });

  it("rejects duplicate-symbol entry", () => {
    const state = computeRiskState({
      capital: 10000,
      closedTrades: [],
      openPositions: [makeOpen({ symbol: "BTC", direction: "long" })],
    });
    const d = evaluateEntry({
      state,
      direction: "short",
      symbol: "BTC",
      notional: 100,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/duplicate symbol/i);
  });

  it("rejects too-many-same-direction", () => {
    const opens = Array.from({
      length: DEFAULT_RISK_LIMITS.maxSameDirection,
    }).map((_, i) => makeOpen({ symbol: `L${i}`, direction: "long" }));
    const state = computeRiskState({
      capital: 10000,
      closedTrades: [],
      openPositions: opens,
    });
    const d = evaluateEntry({
      state,
      direction: "long",
      symbol: "NEW",
      notional: 100,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/same-direction/i);
  });

  it("allows entry under normal conditions, warns approaching caps", () => {
    const state = computeRiskState({
      capital: 10000,
      closedTrades: [
        makeClosed({
          exitTime: new Date().toISOString(),
          netPnlPct: -0.025, // ≥ 70% of daily cap
        }),
      ],
      openPositions: [],
    });
    const d = evaluateEntry({
      state,
      direction: "long",
      symbol: "BTC",
      notional: 1000,
    });
    expect(d.allowed).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/daily PnL/i);
  });
});
