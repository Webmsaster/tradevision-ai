import { describe, expect, it } from "vitest";
import type { Candle } from "@/utils/indicators";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
} from "@/utils/ftmoDaytrade24h";

function makeCandles(): Candle[] {
  const out: Candle[] = [];
  const stepMs = 2 * 60 * 60 * 1000;
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 60; i++) {
    const open = i === 0 ? 100 : out[i - 1]!.close;
    const close = i === 1 ? 101 : open;
    const high = i === 2 ? 112 : Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    out.push({
      openTime: t,
      closeTime: t + stepMs - 1,
      open,
      high,
      low,
      close,
      volume: 1000,
      isFinal: true,
    });
    t += stepMs;
  }
  return out;
}

describe("runFtmoDaytrade24h passDay", () => {
  it("counts virtual ping days after target when pauseAtTargetReached is enabled", () => {
    const cfg: FtmoDaytrade24hConfig = {
      triggerBars: 1,
      leverage: 2,
      tpPct: 0.1,
      stopPct: 0.05,
      holdBars: 2,
      timeframe: "2h",
      assets: [
        {
          symbol: "TEST",
          costBp: 0,
          riskFrac: 0.4,
          invertDirection: true,
          disableShort: true,
        },
      ],
      profitTarget: 0.08,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      maxDays: 30,
      pauseAtTargetReached: true,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };

    const result = runFtmoDaytrade24h({ TEST: makeCandles() }, cfg);

    expect(result.passed).toBe(true);
    expect(result.reason).toBe("profit_target");
    expect(result.passDay).toBe(4);
    expect(result.uniqueTradingDays).toBe(4);
    expect(result.trades).toHaveLength(1);
  });
});
