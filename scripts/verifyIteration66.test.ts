/**
 * Iter 66: Hour-of-day analysis on HF daytrading edge.
 *
 * Question: are there UTC hours where the HF edge performs significantly
 * worse than average? If so, an avoid-hours filter could improve minWR
 * further without changing the core config.
 *
 * Method: bucket all HF trades by entry-hour (0-23 UTC), compute per-bucket
 * WR + ret + trade count. Flag hours that have:
 *   - WR < 80% AND trade count > 5 (significantly worse than 90% average)
 *   - negative cumulative return
 *
 * If any hours fail both, test adding them as avoidHours and measure
 * effect on overall metrics.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  HF_DAYTRADING_ASSETS,
  runHfDaytrading,
  type HfTrade,
} from "../src/utils/hfDaytrading";
import type { Candle } from "../src/utils/indicators";

describe("iteration 66 — hour-of-day on HF", () => {
  it("per-hour bucket analysis", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 66: Hour-of-day ===");
    const data: Record<string, Candle[]> = {};
    for (const s of HF_DAYTRADING_ASSETS) {
      try {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "15m",
          targetCount: 10000,
        });
      } catch {
        // skip
      }
    }

    // Collect all trades across assets with their entry-hour
    interface TradeRec {
      hourUtc: number;
      pnl: number;
    }
    const all: TradeRec[] = [];
    for (const s of HF_DAYTRADING_ASSETS) {
      const c = data[s];
      if (!c) continue;
      const r = runHfDaytrading(c);
      for (const t of r.trades) {
        const hour = new Date(t.entryTime).getUTCHours();
        all.push({ hourUtc: hour, pnl: t.totalPnl });
      }
    }
    console.log(`Total trades: ${all.length}`);

    // Per-hour bucket stats
    interface Bucket {
      hour: number;
      n: number;
      wins: number;
      wr: number;
      sumPnl: number;
    }
    const buckets: Bucket[] = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      n: 0,
      wins: 0,
      wr: 0,
      sumPnl: 0,
    }));
    for (const t of all) {
      const b = buckets[t.hourUtc];
      b.n++;
      if (t.pnl > 0) b.wins++;
      b.sumPnl += t.pnl;
    }
    for (const b of buckets) {
      b.wr = b.n > 0 ? b.wins / b.n : 0;
    }

    // Print table
    console.log(
      "\n" +
        "hour".padEnd(6) +
        "n".padStart(6) +
        "WR%".padStart(7) +
        "avgPnl%".padStart(10) +
        "sumPnl%".padStart(10) +
        "  flag",
    );
    const avgWR =
      all.length > 0 ? all.filter((t) => t.pnl > 0).length / all.length : 0;
    console.log(
      `  avg        ${all.length.toString().padStart(3)}   ${(avgWR * 100).toFixed(1)}%`,
    );
    const flaggedHours: number[] = [];
    for (const b of buckets) {
      if (b.n === 0) {
        console.log(
          b.hour.toString().padEnd(6) + "  -".padStart(6) + "  -".padStart(7),
        );
        continue;
      }
      const avgPnl = b.sumPnl / b.n;
      const flag =
        b.n >= 5 && (b.wr < 0.8 || b.sumPnl < 0)
          ? " ⚠ avoid-candidate"
          : b.wr >= 0.95 && b.n >= 5
            ? " ★ best"
            : "";
      if (flag.includes("avoid")) flaggedHours.push(b.hour);
      console.log(
        b.hour.toString().padEnd(6) +
          b.n.toString().padStart(6) +
          (b.wr * 100).toFixed(1).padStart(7) +
          (avgPnl * 100).toFixed(3).padStart(10) +
          (b.sumPnl * 100).toFixed(2).padStart(10) +
          flag,
      );
    }

    console.log(
      `\nFlagged avoid-candidate hours: [${flaggedHours.join(", ")}]`,
    );

    // If we have flagged hours, simulate what the portfolio looks like without them
    if (flaggedHours.length > 0) {
      const kept = all.filter((t) => !flaggedHours.includes(t.hourUtc));
      const wr = kept.filter((t) => t.pnl > 0).length / kept.length;
      const sumLog = kept.reduce((s, t) => s + Math.log(1 + t.pnl), 0);
      const ret = Math.exp(sumLog) - 1;
      console.log(
        `\nWith flagged hours removed: trades=${kept.length} (was ${all.length}, -${all.length - kept.length})  WR=${(wr * 100).toFixed(1)}%  cumRet=${(ret * 100).toFixed(1)}%`,
      );
      const origRet =
        Math.exp(all.reduce((s, t) => s + Math.log(1 + t.pnl), 0)) - 1;
      console.log(
        `Original full: trades=${all.length}  WR=${(avgWR * 100).toFixed(1)}%  cumRet=${(origRet * 100).toFixed(1)}%`,
      );
    } else {
      console.log(
        `\nNo hours significantly underperform — hour-of-day filter has no benefit.`,
      );
    }
  });
});
