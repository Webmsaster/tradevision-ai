/**
 * Iter 84: Second-wave alt hunt — different narrative clusters than iter82.
 * Target: DeFi / RWA / GameFi / Legacy-mid-cap tokens.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runHfDaytrading } from "../src/utils/hfDaytrading";

const CANDIDATES = [
  // DeFi
  "LDOUSDT",
  "SNXUSDT",
  "DYDXUSDT",
  "GMXUSDT",
  "STGUSDT",
  "TRBUSDT",
  // RWA / New
  "ENAUSDT",
  "WUSDT",
  "ETHFIUSDT",
  "ONDOUSDT",
  // GameFi
  "GALAUSDT",
  "AXSUSDT",
  "APEUSDT",
  "MANAUSDT",
  "SANDUSDT",
  "CHZUSDT",
  // Legacy mid-caps
  "ALGOUSDT",
  "XLMUSDT",
  "VETUSDT",
  "ICPUSDT",
];

describe("iteration 84 — second-wave alt hunt", () => {
  it(
    "test candidates with strict quality filter",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 84: second-wave alt hunt ===");
      interface Row {
        symbol: string;
        trades: number;
        wr: number;
        cumRet: number;
        days: number;
        verdict: string;
      }
      const rows: Row[] = [];
      for (const sym of CANDIDATES) {
        try {
          const c = await loadBinanceHistory({
            symbol: sym,
            timeframe: "15m",
            targetCount: 10000,
          });
          if (c.length < 2000) {
            rows.push({
              symbol: sym,
              trades: 0,
              wr: 0,
              cumRet: 0,
              days: c.length / 96,
              verdict: "insufficient",
            });
            continue;
          }
          const r = runHfDaytrading(c);
          const verdict =
            r.trades.length >= 20 && r.winRate >= 0.92 && r.netReturnPct >= 0.03
              ? "★ ACCEPT"
              : r.winRate >= 0.85
                ? "marginal"
                : "reject";
          rows.push({
            symbol: sym,
            trades: r.trades.length,
            wr: r.winRate,
            cumRet: r.netReturnPct,
            days: c.length / 96,
            verdict,
          });
        } catch (err) {
          rows.push({
            symbol: sym,
            trades: 0,
            wr: 0,
            cumRet: 0,
            days: 0,
            verdict: `fetch fail`,
          });
        }
      }
      console.log(
        "\n" +
          "symbol".padEnd(14) +
          "days".padStart(6) +
          "n".padStart(5) +
          "WR%".padStart(7) +
          "ret%".padStart(8) +
          "  verdict",
      );
      for (const r of rows.sort((a, b) => b.wr - a.wr)) {
        console.log(
          r.symbol.padEnd(14) +
            r.days.toFixed(0).padStart(6) +
            r.trades.toString().padStart(5) +
            (r.wr * 100).toFixed(1).padStart(7) +
            (r.cumRet * 100).toFixed(1).padStart(8) +
            "  " +
            r.verdict,
        );
      }
      const accepted = rows.filter((r) => r.verdict === "★ ACCEPT");
      console.log(
        `\n★ ${accepted.length} accept: ${accepted.map((r) => r.symbol).join(", ")}`,
      );
    },
  );
});
