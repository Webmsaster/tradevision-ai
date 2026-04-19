/**
 * Iter 89: BTC isolated performance diagnostic.
 *
 * Question: how does BTC fare in the HF strategy standalone? BTC has
 * different microstructure than alts — more institutional, tighter
 * spreads, less retail-pump dynamics. The current config was optimized
 * for the ALT portfolio; may be suboptimal for BTC alone.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runHfDaytrading } from "../src/utils/hfDaytrading";
import type { Candle } from "../src/utils/indicators";

describe("iter 89 — BTC diagnostic", () => {
  it("per-asset metrics + bootstrap", { timeout: 600_000 }, async () => {
    console.log("\n=== ITER 89: BTC diagnostic ===");
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 10000,
    });
    console.log(
      `BTC loaded: ${btc.length} bars (${(btc.length / 96).toFixed(0)} days)`,
    );

    const r = runHfDaytrading(btc);
    console.log(
      `\nFull-history BTC: trades=${r.trades.length} WR=${(r.winRate * 100).toFixed(1)}% cumRet=${(r.netReturnPct * 100).toFixed(1)}% PF=${r.profitFactor.toFixed(2)} tp1HitRate=${(r.tp1HitRate * 100).toFixed(1)}%`,
    );

    // Breakdown by exit reason
    const byReason: Record<
      string,
      { n: number; wins: number; sumPnl: number }
    > = {};
    for (const t of r.trades) {
      const key = t.exitReason;
      if (!byReason[key]) byReason[key] = { n: 0, wins: 0, sumPnl: 0 };
      byReason[key].n++;
      if (t.totalPnl > 0) byReason[key].wins++;
      byReason[key].sumPnl += t.totalPnl;
    }
    console.log("\n── by exit reason ──");
    for (const [reason, s] of Object.entries(byReason)) {
      console.log(
        `  ${reason.padEnd(11)} n=${s.n}  WR=${((s.wins / s.n) * 100).toFixed(1)}%  avg=${((s.sumPnl / s.n) * 100).toFixed(2)}%  sum=${(s.sumPnl * 100).toFixed(1)}%`,
      );
    }

    // Breakdown by direction
    const byDir: Record<string, { n: number; wins: number; sumPnl: number }> = {
      long: { n: 0, wins: 0, sumPnl: 0 },
      short: { n: 0, wins: 0, sumPnl: 0 },
    };
    for (const t of r.trades) {
      byDir[t.direction].n++;
      if (t.totalPnl > 0) byDir[t.direction].wins++;
      byDir[t.direction].sumPnl += t.totalPnl;
    }
    console.log("\n── by direction ──");
    for (const [dir, s] of Object.entries(byDir)) {
      console.log(
        `  ${dir.padEnd(6)} n=${s.n}  WR=${((s.wins / s.n) * 100).toFixed(1)}%  avgPnl=${((s.sumPnl / s.n) * 100).toFixed(2)}%`,
      );
    }

    // Chrono bootstrap
    console.log("\n── BTC bootstrap ──");
    const cuts = [0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8];
    console.log(
      "window".padEnd(10) +
        "n".padStart(5) +
        "WR%".padStart(8) +
        "ret%".padStart(9),
    );
    for (const cut of cuts) {
      const slice = btc.slice(Math.floor(btc.length * cut));
      const rr = runHfDaytrading(slice);
      console.log(
        `chr${(cut * 100).toFixed(0)}`.padEnd(10) +
          rr.trades.length.toString().padStart(5) +
          (rr.winRate * 100).toFixed(1).padStart(8) +
          (rr.netReturnPct * 100).toFixed(1).padStart(9),
      );
    }
  });
});
