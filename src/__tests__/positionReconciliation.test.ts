import { describe, it, expect } from "vitest";
import { reconcile, formatDiffSummary } from "@/utils/positionReconciliation";
import type { PaperPosition } from "@/utils/paperTradeLogger";
import type { OpenPosition } from "@/utils/binanceAccount";

function paper(
  symbol: string,
  direction: "long" | "short",
  id = symbol,
  entry = 1,
): PaperPosition {
  return {
    id,
    strategy: "hf-daytrading",
    symbol,
    direction,
    entry,
    stop: direction === "long" ? 0.97 : 1.03,
    entryTime: "2026-04-19T12:00:00Z",
    holdUntil: "2026-04-19T18:00:00Z",
    tp1Hit: false,
    legs: 2,
  };
}

function exchange(symbol: string, amt: number, entry = 1): OpenPosition {
  return {
    symbol,
    positionAmt: amt,
    entryPrice: entry,
    markPrice: entry,
    unrealisedPnl: 0,
    liquidationPrice: 0,
    leverage: 10,
    marginType: "cross",
  };
}

describe("positionReconciliation — reconcile", () => {
  it("empty in, empty out", () => {
    const d = reconcile({ paperOpen: [], exchangePositions: [] });
    expect(d.matched).toHaveLength(0);
    expect(d.paperOnly).toHaveLength(0);
    expect(d.exchangeOnly).toHaveLength(0);
  });

  it("matches position by symbol + direction", () => {
    const d = reconcile({
      paperOpen: [paper("SUIUSDT", "long")],
      exchangePositions: [exchange("SUIUSDT", 100)],
    });
    expect(d.matched).toHaveLength(1);
    expect(d.paperOnly).toHaveLength(0);
    expect(d.exchangeOnly).toHaveLength(0);
  });

  it("paper-only when position is in paper but not on exchange", () => {
    const d = reconcile({
      paperOpen: [paper("SUIUSDT", "long"), paper("AVAXUSDT", "short")],
      exchangePositions: [exchange("SUIUSDT", 100)],
    });
    expect(d.paperOnly.map((p) => p.symbol)).toEqual(["AVAXUSDT"]);
  });

  it("exchange-only when position is on exchange but not tracked", () => {
    const d = reconcile({
      paperOpen: [],
      exchangePositions: [exchange("BTCUSDT", 0.1)],
    });
    expect(d.exchangeOnly.map((e) => e.symbol)).toEqual(["BTCUSDT"]);
  });

  it("ignores flat exchange positions (positionAmt=0)", () => {
    const d = reconcile({
      paperOpen: [],
      exchangePositions: [exchange("BTCUSDT", 0)],
    });
    expect(d.exchangeOnly).toHaveLength(0);
  });

  it("flags direction mismatch (paper=long, exchange=short)", () => {
    const d = reconcile({
      paperOpen: [paper("SUIUSDT", "long")],
      exchangePositions: [exchange("SUIUSDT", -100)], // short
    });
    expect(d.directionMismatch).toHaveLength(1);
    expect(d.matched).toHaveLength(0);
  });

  it("flags size mismatch > 5% when notionalsById provided", () => {
    // paper notional $200 at entry $1 → paperQty=200. Exchange positionAmt=150 → 25% gap.
    const d = reconcile({
      paperOpen: [paper("SUIUSDT", "long", "id1", 1)],
      exchangePositions: [exchange("SUIUSDT", 150, 1)],
      notionalsById: { id1: 200 },
    });
    expect(d.sizeMismatch).toHaveLength(1);
    expect(d.sizeMismatch[0].paperQty).toBe(200);
    expect(d.sizeMismatch[0].exchangeQty).toBe(150);
  });

  it("tolerates size mismatch ≤ 5%", () => {
    // paper=100, exchange=103 → 3% gap → matched
    const d = reconcile({
      paperOpen: [paper("SUIUSDT", "long", "id1", 1)],
      exchangePositions: [exchange("SUIUSDT", 103, 1)],
      notionalsById: { id1: 100 },
    });
    expect(d.sizeMismatch).toHaveLength(0);
    expect(d.matched).toHaveLength(1);
  });

  it("format summary renders each category with emoji", () => {
    const d = reconcile({
      paperOpen: [paper("SUIUSDT", "long"), paper("AVAXUSDT", "long")],
      exchangePositions: [
        exchange("SUIUSDT", -100), // dir mismatch
        exchange("BTCUSDT", 0.1), // exchange-only
      ],
    });
    const s = formatDiffSummary(d);
    expect(s).toMatch(/DIRECTION MISMATCH/);
    expect(s).toMatch(/paperOnly/);
    expect(s).toMatch(/exchangeOnly/);
  });
});
