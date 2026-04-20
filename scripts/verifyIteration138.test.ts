/**
 * Iter 138 — BTC intraday (iter135, 1h) + BTC swing (iter128, 1d) portfolio.
 *
 * Two already-validated edges, orthogonal by timeframe and trigger geometry.
 * Both run standalone on their own candles; we aggregate returns chronologically
 * with a capital allocation:
 *   - A: 80% intraday / 20% swing
 *   - B: 50% / 50%
 *   - C: 70% / 30%
 *   - D: intraday solo (iter135 reference)
 *   - E: swing solo (iter128 reference)
 *
 * Goal: verify that portfolio Sharpe > max(single-Sharpe) via diversification.
 * If Sharpe rises, ship as BTC_BOOK_CONFIG alongside single-edge configs.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runBtcIntraday, BTC_INTRADAY_CONFIG } from "../src/utils/btcIntraday";
import { runBtcSwing, BTC_SWING_CONFIG } from "../src/utils/btcSwing";

function sharpeOf(pnls: number[], barsPerYear: number): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(barsPerYear);
}

interface DailyPnl {
  day: number; // days since unix epoch
  pnl: number;
}

function tradesToDailyPnl(
  trades: { entryTime: number; pnl: number }[],
  scale = 1,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.entryTime / 86_400_000);
    out.set(d, (out.get(d) ?? 0) + t.pnl * scale);
  }
  return out;
}

function mergeDaily(
  a: Map<number, number>,
  b: Map<number, number>,
): DailyPnl[] {
  const allDays = new Set<number>([...a.keys(), ...b.keys()]);
  return Array.from(allDays)
    .sort((x, y) => x - y)
    .map((day) => ({ day, pnl: (a.get(day) ?? 0) + (b.get(day) ?? 0) }));
}

function sharpeAndStats(daily: DailyPnl[]) {
  const pnls = daily.map((d) => d.pnl);
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const mean = pnls.length ? pnls.reduce((a, p) => a + p, 0) / pnls.length : 0;
  const sh = sharpeOf(pnls, 365);
  // max-drawdown on equity curve
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  for (const p of pnls) {
    eq *= 1 + p;
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return {
    days: pnls.length,
    activeDays: wins + losses,
    winRate: wins + losses ? wins / (wins + losses) : 0,
    meanDailyPct: mean,
    cumReturnPct: ret,
    sharpeDaily: sh,
    maxDD: maxDd,
  };
}

describe("iter 138 — intraday + swing portfolio", () => {
  it(
    "compare combined books vs single-book references",
    { timeout: 1_500_000 },
    async () => {
      console.log("\n=== ITER 138: intraday+swing portfolio ===");
      const c1h = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const c1d = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 100,
      });
      console.log(
        `loaded 1h=${c1h.length} candles (${(c1h.length / 24).toFixed(0)} days), 1d=${c1d.length} candles (${c1d.length} days)`,
      );

      const intradayReport = runBtcIntraday(c1h, BTC_INTRADAY_CONFIG);
      const swingReport = runBtcSwing(c1d, BTC_SWING_CONFIG);
      console.log(
        `\niter135 intraday: ${intradayReport.trades.length} trades, WR ${(intradayReport.winRate * 100).toFixed(1)}%, cumRet ${(intradayReport.netReturnPct * 100).toFixed(1)}%`,
      );
      console.log(
        `iter128 swing:    ${swingReport.trades.length} trades, WR ${(swingReport.winRate * 100).toFixed(1)}%, cumRet ${(swingReport.netReturnPct * 100).toFixed(1)}%`,
      );

      const allocations = [
        { label: "A 80/20 intraday/swing", wi: 0.8, ws: 0.2 },
        { label: "B 70/30 intraday/swing", wi: 0.7, ws: 0.3 },
        { label: "C 50/50 intraday/swing", wi: 0.5, ws: 0.5 },
        { label: "D 100/0 intraday-solo", wi: 1.0, ws: 0 },
        { label: "E 0/100 swing-solo", wi: 0, ws: 1.0 },
      ];

      console.log(
        "\nallocation                   activeDays  WR    meanDaily%  cumRet    Sharpe  maxDD",
      );
      for (const a of allocations) {
        const intradayDaily = tradesToDailyPnl(intradayReport.trades, a.wi);
        const swingDaily = tradesToDailyPnl(swingReport.trades, a.ws);
        const merged = mergeDaily(intradayDaily, swingDaily);
        // Only count from the first day where we have data in either book
        const s = sharpeAndStats(merged);
        console.log(
          `${a.label.padEnd(30)} ${s.activeDays.toString().padStart(4)} ${(s.winRate * 100).toFixed(1).padStart(5)}% ${(s.meanDailyPct * 100).toFixed(3).padStart(7)}% ${(s.cumReturnPct * 100).toFixed(1).padStart(7)}% ${s.sharpeDaily.toFixed(2).padStart(6)} ${(s.maxDD * 100).toFixed(1).padStart(6)}%`,
        );
      }
    },
  );
});
