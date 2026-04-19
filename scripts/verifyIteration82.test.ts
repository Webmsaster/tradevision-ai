/**
 * Iter 82: Search for MORE quality alts to add to HF basket.
 *
 * Constraint: minWR must NOT drop. iter64 showed that adding assets with
 * WR ≥ 70% but negative ret destroys pctProf. Only accept assets where:
 *   - per-asset WR ≥ 92% (matching or beating current basket avg)
 *   - per-asset cumRet ≥ +3% (positive edge, not noise)
 *   - trade count ≥ 20 (statistically meaningful)
 *
 * Focus on retail-heavy, established-but-volatile alts that match the
 * structural profile of iter57 winners (SUI, APT, AVAX, INJ, etc.):
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runHfDaytrading } from "../src/utils/hfDaytrading";
import type { Candle } from "../src/utils/indicators";

const NEW_CANDIDATES = [
  "RENDERUSDT",
  "TIAUSDT",
  "SEIUSDT",
  "JUPUSDT",
  "WLDUSDT",
  "ORDIUSDT",
  "RUNEUSDT",
  "FETUSDT",
  "MANTAUSDT",
  "JTOUSDT",
  "PENDLEUSDT",
  "STRKUSDT",
  "ARUSDT",
  "FTMUSDT",
  "MKRUSDT",
  "CRVUSDT",
  "IMXUSDT",
  "RNDRUSDT",
  "PYTHUSDT",
  "BLURUSDT",
];

describe("iteration 82 — alt expansion hunt", () => {
  it(
    "test new candidates with WR ≥ 92% + ret ≥ +3% + n ≥ 20",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 82: hunt for more quality alts ===");

      interface Row {
        symbol: string;
        trades: number;
        wr: number;
        cumRet: number;
        bars: number;
        days: number;
        verdict: string;
      }
      const rows: Row[] = [];

      for (const sym of NEW_CANDIDATES) {
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
              bars: c.length,
              days: c.length / 96,
              verdict: "insufficient history",
            });
            continue;
          }
          const r = runHfDaytrading(c);
          if (r.trades.length === 0) {
            rows.push({
              symbol: sym,
              trades: 0,
              wr: 0,
              cumRet: 0,
              bars: c.length,
              days: c.length / 96,
              verdict: "no trades",
            });
            continue;
          }
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
            bars: c.length,
            days: c.length / 96,
            verdict,
          });
        } catch (err) {
          rows.push({
            symbol: sym,
            trades: 0,
            wr: 0,
            cumRet: 0,
            bars: 0,
            days: 0,
            verdict: `fetch fail: ${(err as Error).message.slice(0, 40)}`,
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
        `\n★ ${accepted.length} alts pass (WR≥92 AND ret≥+3% AND n≥20): ${accepted.map((r) => r.symbol).join(", ")}`,
      );
    },
  );
});
