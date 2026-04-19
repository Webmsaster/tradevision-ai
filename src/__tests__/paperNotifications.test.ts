import { describe, it, expect } from "vitest";
import {
  formatOpenedPosition,
  formatClosedTrade,
  formatDailyReport,
  rollingWr,
} from "@/utils/paperNotifications";
import type { PaperPosition, ClosedTrade } from "@/utils/paperTradeLogger";

describe("paperNotifications — formatters", () => {
  const samplePos: PaperPosition = {
    id: "x",
    strategy: "hf-daytrading",
    symbol: "SUIUSDT",
    direction: "short",
    entry: 2.0,
    tp1: 1.994,
    tp2: 1.976,
    stop: 2.06,
    entryTime: "2026-04-19T14:00:00Z",
    holdUntil: "2026-04-19T20:00:00Z",
    tp1Hit: false,
    legs: 2,
  };

  it("opened position contains entry/tp/stop/notional", () => {
    const p = formatOpenedPosition(samplePos, 1500);
    expect(p.title).toMatch(/OPEN.*SUIUSDT.*SHORT/);
    expect(p.body).toMatch(/\$2\.0000/);
    expect(p.body).toMatch(/\$1\.9940/);
    expect(p.body).toMatch(/\$2\.0600/);
    expect(p.body).toMatch(/\$1500/);
    expect(p.color).toBe(15158332); // red for short
  });

  it("long position has green color", () => {
    const p = formatOpenedPosition({ ...samplePos, direction: "long" }, 1000);
    expect(p.color).toBe(3066993);
  });

  it("closed trade shows net PnL + exit reason", () => {
    const t: ClosedTrade = {
      id: "x",
      strategy: "hf-daytrading",
      symbol: "AVAXUSDT",
      direction: "long",
      entry: 20,
      exit: 20.24,
      entryTime: "2026-04-19T12:00:00Z",
      exitTime: "2026-04-19T18:00:00Z",
      grossPnlPct: 0.012,
      netPnlPct: 0.0098,
      exitReason: "tp2",
    };
    const p = formatClosedTrade(t);
    expect(p.title).toMatch(/CLOSE.*AVAXUSDT.*LONG/);
    expect(p.body).toMatch(/tp2/);
    expect(p.body).toMatch(/\+0\.98%/);
    expect(p.color).toBe(3066993); // green
  });

  it("daily report flags degradation when 7d WR < backtest - 10pp", () => {
    const p = formatDailyReport({
      totalTrades: 20,
      winRate: 0.75,
      totalReturnPct: 0.04,
      byStrategy: {
        "hf-daytrading": { trades: 20, wins: 15, wr: 0.75, ret: 0.04 },
        "hi-wr-1h": { trades: 0, wins: 0, wr: 0, ret: 0 },
        "vol-spike-1h": { trades: 0, wins: 0, wr: 0, ret: 0 },
      },
      rolling7dWr: { "hf-daytrading": 0.7 }, // 70%
      backtestWr: { "hf-daytrading": 0.85 }, // 85% → 15pp gap → warn
    });
    expect(p.title).toMatch(/DEGRADATION/);
    expect(p.body).toMatch(/gap -15/);
    expect(p.color).toBe(15158332); // red
  });

  it("daily report shows normal when within tolerance", () => {
    const p = formatDailyReport({
      totalTrades: 20,
      winRate: 0.9,
      totalReturnPct: 0.04,
      byStrategy: {
        "hf-daytrading": { trades: 20, wins: 18, wr: 0.9, ret: 0.04 },
        "hi-wr-1h": { trades: 0, wins: 0, wr: 0, ret: 0 },
        "vol-spike-1h": { trades: 0, wins: 0, wr: 0, ret: 0 },
      },
      rolling7dWr: { "hf-daytrading": 0.88 },
      backtestWr: { "hf-daytrading": 0.85 },
    });
    expect(p.title).not.toMatch(/DEGRADATION/);
    expect(p.color).toBe(3066993);
  });
});

describe("paperNotifications — rollingWr", () => {
  const base = new Date("2026-04-19T12:00:00Z");
  const trade = (daysAgo: number, strategy: string, pnl: number) => ({
    strategy,
    netPnlPct: pnl,
    exitTime: new Date(base.getTime() - daysAgo * 86400_000).toISOString(),
  });

  it("returns empty map when no recent trades", () => {
    const r = rollingWr([trade(30, "hf-daytrading", 0.01)], base, 7);
    expect(r).toEqual({});
  });

  it("computes WR per strategy within 7-day window", () => {
    const r = rollingWr(
      [
        trade(1, "hf-daytrading", 0.01), // win
        trade(3, "hf-daytrading", -0.03), // loss
        trade(5, "hf-daytrading", 0.01), // win
        trade(8, "hf-daytrading", 0.01), // outside window
        trade(2, "hi-wr-1h", 0.01), // win
      ],
      base,
      7,
    );
    expect(r["hf-daytrading"]).toBeCloseTo(2 / 3, 2);
    expect(r["hi-wr-1h"]).toBe(1);
  });
});
