import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  advancePosition,
  computeStats,
  emptyState,
  openPosition,
  type ClosedTrade,
  type PaperPosition,
} from "@/utils/paperTradeLogger";
import type { Candle } from "@/utils/indicators";

function bar(args: {
  t: number;
  o?: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}): Candle {
  return {
    openTime: args.t,
    open: args.o ?? args.c,
    high: args.h,
    low: args.l,
    close: args.c,
    volume: args.v ?? 1000,
    closeTime: args.t + 900_000 - 1, // 15m
    isFinal: true,
  };
}

describe("paperTradeLogger", () => {
  // Round 58 cleanup: freeze time so Date.now()-based fixtures are stable.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emptyState has no positions or trades", () => {
    const s = emptyState();
    expect(s.openPositions).toHaveLength(0);
    expect(s.closedTrades).toHaveLength(0);
  });

  it("openPosition creates a valid position", () => {
    const p = openPosition({
      strategy: "hf-daytrading",
      symbol: "SUIUSDT",
      direction: "short",
      entry: 2.0,
      tp1: 1.994,
      tp2: 1.976,
      stop: 2.06,
      holdUntil: new Date(Date.now() + 6 * 3600_000).toISOString(),
      legs: 2,
      now: "2026-04-19T12:00:00.000Z",
    });
    expect(p.symbol).toBe("SUIUSDT");
    expect(p.tp1Hit).toBe(false);
    expect(p.legs).toBe(2);
    expect(p.id).toBeTruthy();
  });

  it("advancePosition: short hits stop-loss on high-spike bar", () => {
    const p = openPosition({
      strategy: "hf-daytrading",
      symbol: "SUIUSDT",
      direction: "short",
      entry: 2.0,
      tp1: 1.994,
      tp2: 1.976,
      stop: 2.06,
      holdUntil: new Date(Date.now() + 6 * 3600_000).toISOString(),
      legs: 2,
      now: "2026-04-19T12:00:00.000Z",
    });
    const bars: Candle[] = [
      bar({ t: Date.parse("2026-04-19T12:15:00Z"), h: 2.07, l: 1.99, c: 2.05 }),
    ];
    const closed = advancePosition(p, bars, "2026-04-19T12:20:00Z");
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe("stop");
    expect(closed!.exit).toBe(2.06);
    // Short: entry 2.0, exit 2.06 → gross loss 3%
    expect(closed!.grossPnlPct).toBeCloseTo(-0.03, 3);
  });

  it("advancePosition: long hits tp1 first, then tp2 on leg2", () => {
    const p = openPosition({
      strategy: "hf-daytrading",
      symbol: "SUIUSDT",
      direction: "long",
      entry: 2.0,
      tp1: 2.006,
      tp2: 2.024,
      stop: 1.94,
      holdUntil: new Date(Date.now() + 6 * 3600_000).toISOString(),
      legs: 2,
      now: "2026-04-19T12:00:00.000Z",
    });
    const bars: Candle[] = [
      bar({
        t: Date.parse("2026-04-19T12:15:00Z"),
        h: 2.008,
        l: 1.999,
        c: 2.007,
      }), // hits tp1
      bar({
        t: Date.parse("2026-04-19T12:30:00Z"),
        h: 2.025,
        l: 2.005,
        c: 2.024,
      }), // hits tp2
    ];
    const closed = advancePosition(p, bars, "2026-04-19T12:35:00Z");
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe("tp2");
    expect(closed!.legPnls).toHaveLength(2);
    // Both legs profitable
    expect(closed!.netPnlPct).toBeGreaterThan(0);
  });

  it("advancePosition: long hits tp1, then stop at breakeven → small positive (leg1 profit)", () => {
    const p = openPosition({
      strategy: "hf-daytrading",
      symbol: "SUIUSDT",
      direction: "long",
      entry: 2.0,
      tp1: 2.006,
      tp2: 2.024,
      stop: 1.94,
      holdUntil: new Date(Date.now() + 6 * 3600_000).toISOString(),
      legs: 2,
      now: "2026-04-19T12:00:00.000Z",
    });
    const bars: Candle[] = [
      bar({
        t: Date.parse("2026-04-19T12:15:00Z"),
        h: 2.008,
        l: 1.999,
        c: 2.007,
      }), // tp1
      bar({
        t: Date.parse("2026-04-19T12:30:00Z"),
        h: 2.01,
        l: 1.995,
        c: 1.999,
      }), // drops to entry — BE stop triggers
    ];
    const closed = advancePosition(p, bars, "2026-04-19T12:35:00Z");
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe("breakeven");
    // leg1 +0.3% - costs, leg2 ~0 - costs → net slightly positive before costs, might be slightly negative after
    expect(closed!.legPnls).toBeDefined();
    expect(closed!.legPnls![0]).toBeGreaterThan(0); // leg1 was profitable
  });

  it("advancePosition: time-exit when hold deadline passed and no TP/stop hit", () => {
    const entryTime = "2026-04-19T12:00:00.000Z";
    const holdUntil = "2026-04-19T13:00:00.000Z";
    const p: PaperPosition = {
      id: "x",
      strategy: "hf-daytrading",
      symbol: "SUIUSDT",
      direction: "long",
      entry: 2.0,
      tp1: 2.006,
      tp2: 2.024,
      stop: 1.94,
      entryTime,
      holdUntil,
      tp1Hit: false,
      legs: 2,
    };
    const bars: Candle[] = [
      bar({
        t: Date.parse("2026-04-19T12:15:00Z"),
        h: 2.003,
        l: 1.998,
        c: 2.001,
      }),
      bar({
        t: Date.parse("2026-04-19T12:30:00Z"),
        h: 2.004,
        l: 1.999,
        c: 2.002,
      }),
    ];
    const closed = advancePosition(p, bars, "2026-04-19T13:30:00Z");
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe("time");
  });

  it("computeStats: aggregates trades correctly across strategies", () => {
    const trades: ClosedTrade[] = [
      {
        id: "1",
        strategy: "hf-daytrading",
        symbol: "SUI",
        direction: "long",
        entry: 1,
        exit: 1.01,
        entryTime: "",
        exitTime: "",
        grossPnlPct: 0.01,
        netPnlPct: 0.008,
        exitReason: "tp2",
      },
      {
        id: "2",
        strategy: "hf-daytrading",
        symbol: "AVAX",
        direction: "short",
        entry: 1,
        exit: 1.03,
        entryTime: "",
        exitTime: "",
        grossPnlPct: -0.03,
        netPnlPct: -0.032,
        exitReason: "stop",
      },
      {
        id: "3",
        strategy: "hi-wr-1h",
        symbol: "SUI",
        direction: "long",
        entry: 1,
        exit: 1.012,
        entryTime: "",
        exitTime: "",
        grossPnlPct: 0.012,
        netPnlPct: 0.01,
        exitReason: "tp2",
      },
    ];
    const s = computeStats(trades);
    expect(s.totalTrades).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.byStrategy["hf-daytrading"].trades).toBe(2);
    expect(s.byStrategy["hi-wr-1h"].trades).toBe(1);
  });

  it("computeStats: empty trades returns zero stats", () => {
    const s = computeStats([]);
    expect(s.totalTrades).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.totalReturnPct).toBe(0);
  });
});
