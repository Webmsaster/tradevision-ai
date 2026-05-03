import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSignal,
  closeExpiredSignals,
  loadJournal,
  saveJournal,
  computeJournalStats,
  type SignalEntry,
} from "@/utils/signalJournal";

describe("signalJournal.closeExpiredSignals", () => {
  beforeEach(() => {
    saveJournal([]);
  });

  it("closes open signals whose plannedExitTime has passed", () => {
    const now = 2_000_000;
    const past = now - 60_000;
    recordSignal({
      symbol: "BTCUSDT",
      strategy: "Champion",
      direction: "long",
      entryTime: past - 3_600_000,
      entryPrice: 100,
      targetPrice: 102,
      stopPrice: 99,
      plannedExitTime: past,
      confidence: "high",
      expectedEdgeBps: 10,
    });
    const closed = closeExpiredSignals({ BTCUSDT: 101 }, now);
    expect(closed.length).toBe(1);
    expect(closed[0]!.exitPrice).toBe(101);
    expect(closed[0]!.exitReason).toBe("expired");
    expect(closed[0]!.actualPnlPct).toBeCloseTo(0.01, 6);
    const reloaded = loadJournal();
    expect(reloaded[0]!.exitPrice).toBe(101);
  });

  it("leaves future-exit signals untouched", () => {
    const now = 2_000_000;
    recordSignal({
      symbol: "ETHUSDT",
      strategy: "Champion",
      direction: "short",
      entryTime: now - 60_000,
      entryPrice: 200,
      targetPrice: 198,
      stopPrice: 201,
      plannedExitTime: now + 60_000, // future
      confidence: "medium",
      expectedEdgeBps: 5,
    });
    const closed = closeExpiredSignals({ ETHUSDT: 199 }, now);
    expect(closed.length).toBe(0);
    const all = loadJournal();
    expect(all[0]!.exitPrice).toBeUndefined();
  });

  it("computes short P&L correctly on auto-close", () => {
    const now = 2_000_000;
    recordSignal({
      symbol: "SOLUSDT",
      strategy: "Champion",
      direction: "short",
      entryTime: now - 3_600_000,
      entryPrice: 100,
      targetPrice: 98,
      stopPrice: 101,
      plannedExitTime: now - 1000,
      confidence: "high",
      expectedEdgeBps: 8,
    });
    // Price dropped 2% → short wins 2%
    const closed = closeExpiredSignals({ SOLUSDT: 98 }, now);
    expect(closed.length).toBe(1);
    expect(closed[0]!.actualPnlPct).toBeCloseTo(0.02, 6);
  });

  it("skips signals with no price data", () => {
    const now = 2_000_000;
    recordSignal({
      symbol: "DOGEUSDT",
      strategy: "Champion",
      direction: "long",
      entryTime: now - 3_600_000,
      entryPrice: 1,
      targetPrice: 1.02,
      stopPrice: 0.99,
      plannedExitTime: now - 1000,
      confidence: "high",
      expectedEdgeBps: 4,
    });
    const closed = closeExpiredSignals({ BTCUSDT: 100 }, now);
    expect(closed.length).toBe(0);
    const all = loadJournal();
    expect(all[0]!.exitPrice).toBeUndefined();
  });

  it("expired auto-closures flow through journal stats", () => {
    const now = 2_000_000;
    recordSignal({
      symbol: "BTCUSDT",
      strategy: "Champion",
      direction: "long",
      entryTime: now - 3_600_000,
      entryPrice: 100,
      targetPrice: 102,
      stopPrice: 99,
      plannedExitTime: now - 1000,
      confidence: "high",
      expectedEdgeBps: 10,
    });
    closeExpiredSignals({ BTCUSDT: 101 }, now);
    const stats = computeJournalStats(loadJournal());
    expect(stats.completed).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.open).toBe(0);
  });

  it("ignores already-closed signals", () => {
    const now = 2_000_000;
    const closedEntry: SignalEntry = {
      id: "abc",
      symbol: "BTCUSDT",
      strategy: "Champion",
      direction: "long",
      entryTime: now - 3_600_000,
      entryPrice: 100,
      targetPrice: 102,
      stopPrice: 99,
      plannedExitTime: now - 1000,
      confidence: "high",
      expectedEdgeBps: 10,
      exitTime: now - 500,
      exitPrice: 101.5,
      exitReason: "target",
      actualPnlPct: 0.015,
    };
    saveJournal([closedEntry]);
    const closed = closeExpiredSignals({ BTCUSDT: 99 }, now);
    expect(closed.length).toBe(0);
    const reloaded = loadJournal();
    expect(reloaded[0]!.exitPrice).toBe(101.5); // unchanged
  });
});
