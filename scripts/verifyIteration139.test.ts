/**
 * Iter 139 — hour-of-day analysis on iter135 trades.
 *
 * iter135 currently avoids only hour 0 UTC (legacy from iter114 analysis).
 * Break out per-entry-hour WR / mean / Sharpe to see if any specific hours
 * are degrading quality. If yes, add them to `avoidHoursUtc`.
 *
 * Compute:
 *   - per-hour stats (trades, WR, mean pnl, Sharpe-by-hour)
 *   - UTC hours where mean pnl is negative OR Sharpe < 0
 *   - a trial config that excludes those hours and measures portfolio Sharpe
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runBtcIntraday,
  BTC_INTRADAY_CONFIG,
  type BtcIntradayConfig,
} from "../src/utils/btcIntraday";

function sharpeOf(pnls: number[]): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(365 * 24);
}
function bootstrap(
  pnls: number[],
  resamples: number,
  blockLen: number,
  seed: number,
): { pctPositive: number; p5: number } {
  if (pnls.length < blockLen) return { pctPositive: 0, p5: 0 };
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const rets: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sampled: number[] = [];
    const nBlocks = Math.ceil(pnls.length / blockLen);
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * Math.max(1, pnls.length - blockLen));
      for (let k = 0; k < blockLen; k++) sampled.push(pnls[start + k]);
    }
    const ret = sampled.reduce((a, p) => a * (1 + p), 1) - 1;
    rets.push(ret);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    pctPositive: rets.filter((r) => r > 0).length / rets.length,
    p5: sorted[Math.floor(sorted.length * 0.05)],
  };
}

describe("iter 139 — hour-of-day analysis on iter135", () => {
  it(
    "find worst-performing entry hours and test filtering",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 139: hour-of-day analysis ===");
      const c = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const days = c.length / 24;
      console.log(`loaded ${c.length} BTC candles (${days.toFixed(0)} days)`);

      // Enable all hours (remove legacy avoidHoursUtc=[0]) to see raw per-hour
      const openCfg: BtcIntradayConfig = {
        ...BTC_INTRADAY_CONFIG,
        avoidHoursUtc: [],
      };
      const report = runBtcIntraday(c, openCfg);
      console.log(
        `\nUnfiltered (all hours): n=${report.trades.length}, WR ${(report.winRate * 100).toFixed(1)}%, cumRet ${(report.netReturnPct * 100).toFixed(1)}%`,
      );

      // Per-hour stats
      const byHour = new Map<
        number,
        { n: number; wins: number; sumPnl: number; pnls: number[] }
      >();
      for (const t of report.trades) {
        const h = new Date(t.entryTime).getUTCHours();
        const entry = byHour.get(h) ?? { n: 0, wins: 0, sumPnl: 0, pnls: [] };
        entry.n += 1;
        if (t.pnl > 0) entry.wins += 1;
        entry.sumPnl += t.pnl;
        entry.pnls.push(t.pnl);
        byHour.set(h, entry);
      }

      console.log("\nhour(UTC)  n    WR      mean%      cumRet     Sharpe");
      const badHours: number[] = [];
      for (let h = 0; h < 24; h++) {
        const e = byHour.get(h);
        if (!e || e.n < 30) {
          console.log(
            `   ${h.toString().padStart(2)}     ${(e?.n ?? 0).toString().padStart(3)} — too few trades`,
          );
          continue;
        }
        const mean = e.sumPnl / e.n;
        const ret = e.pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const sh = sharpeOf(e.pnls);
        const wr = e.wins / e.n;
        const bad = mean < 0 || sh < 0;
        if (bad) badHours.push(h);
        console.log(
          `   ${h.toString().padStart(2)}    ${e.n.toString().padStart(3)}   ${(wr * 100).toFixed(1).padStart(5)}%   ${(mean * 100).toFixed(3).padStart(6)}%   ${(ret * 100).toFixed(1).padStart(6)}%   ${sh.toFixed(2).padStart(5)} ${bad ? "← BAD" : ""}`,
        );
      }

      console.log(`\nBad hours (mean<0 or Shp<0): [${badHours.join(", ")}]`);

      if (badHours.length === 0) {
        console.log("  — no bad hours, legacy avoidHoursUtc=[0] is optional");
      } else {
        // Test filtering these hours
        console.log(
          "\n── Test with bad hours filtered (includes legacy hour 0) ──",
        );
        const filterCfg: BtcIntradayConfig = {
          ...BTC_INTRADAY_CONFIG,
          avoidHoursUtc: Array.from(new Set([0, ...badHours])).sort(
            (a, b) => a - b,
          ),
        };
        const fReport = runBtcIntraday(c, filterCfg);
        const pnls = fReport.trades.map((t) => t.pnl);
        const ret = pnls.reduce((a, p) => a * (1 + p), 1) - 1;
        const mean = pnls.length
          ? pnls.reduce((a, p) => a + p, 0) / pnls.length
          : 0;
        const sh = sharpeOf(pnls);
        const wr = fReport.winRate;
        const bs = bootstrap(
          pnls,
          100,
          Math.max(10, Math.floor(pnls.length / 15)),
          42,
        );
        console.log(
          `  n=${fReport.trades.length} tpd=${fReport.tradesPerDay.toFixed(2)} WR=${(wr * 100).toFixed(1)}% mean=${(mean * 100).toFixed(3)}% ret=${(ret * 100).toFixed(1)}% Shp=${sh.toFixed(2)} bs+=${(bs.pctPositive * 100).toFixed(0)}% bs5%=${(bs.p5 * 100).toFixed(1)}%`,
        );
      }

      // For reference: current shipping config (hour 0 only)
      console.log("\n── Current shipping config (avoid only hour 0) ──");
      const shipReport = runBtcIntraday(c, BTC_INTRADAY_CONFIG);
      const shPnls = shipReport.trades.map((t) => t.pnl);
      const shSh = sharpeOf(shPnls);
      const shRet = shPnls.reduce((a, p) => a * (1 + p), 1) - 1;
      const shMean = shPnls.reduce((a, p) => a + p, 0) / shPnls.length;
      console.log(
        `  n=${shipReport.trades.length} tpd=${shipReport.tradesPerDay.toFixed(2)} WR=${(shipReport.winRate * 100).toFixed(1)}% mean=${(shMean * 100).toFixed(3)}% ret=${(shRet * 100).toFixed(1)}% Shp=${shSh.toFixed(2)}`,
      );
    },
  );
});
