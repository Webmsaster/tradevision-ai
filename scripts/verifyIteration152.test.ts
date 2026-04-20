/**
 * Iter 152 — Leverage tier: how much leverage delivers 5% per trade?
 *
 * User accepted leverage up to 100×. With leverage L, each trade's PnL
 * scales linearly, BUT stops become margin-destroyers:
 *   effective_pnl = pnl × L
 *   effective_stop = -1% × L  →  if L ≥ 100, stop = full margin wipeout
 *
 * Our simulation:
 *   1. Run iter135 config (already 5-gate validated, Sharpe 10.15).
 *   2. For each leverage level, scale trade PnLs.
 *   3. If a leveraged loss exceeds -90% (liquidation-safe margin), treat
 *      as -100% (position wiped).
 *   4. Report: effective mean, Sharpe, bankruptcy probability (= trade
 *      that liquidates a fresh unit of margin), and risk-adjusted metrics.
 *
 * Additionally: test iter144 MAX (swing) with leverage, because higher
 * base mean + less leverage = safer path to 5%.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runBtcIntraday, BTC_INTRADAY_CONFIG } from "../src/utils/btcIntraday";
import { runBtcSwing, BTC_SWING_MAX_CONFIG } from "../src/utils/btcSwing";

function sharpeOf(pnls: number[], barsPerYear: number): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(barsPerYear);
}

interface LeverageReport {
  leverage: number;
  effMean: number;
  effMin: number;
  effMax: number;
  effSharpe: number;
  effCumRet: number;
  liquidations: number;
  liquidationRate: number;
  maxDd: number;
}

function simulateLeverage(
  rawPnls: number[],
  leverage: number,
  barsPerYear: number,
): LeverageReport {
  // Each trade's PnL multiplied by leverage.
  // Liquidation: if leveraged loss ≥ 90% of margin, position is wiped (-100%)
  // and a new unit of margin must be deployed.
  const liquidationThreshold = -0.9;
  const effPnls: number[] = [];
  let liquidations = 0;
  for (const p of rawPnls) {
    const lev = p * leverage;
    if (lev <= liquidationThreshold) {
      effPnls.push(-1.0);
      liquidations++;
    } else {
      effPnls.push(lev);
    }
  }
  const effMean = effPnls.reduce((a, b) => a + b, 0) / effPnls.length;
  const effCumRet = effPnls.reduce((a, p) => a * (1 + p), 1) - 1;
  const effSharpe = sharpeOf(effPnls, barsPerYear);
  const effMin = Math.min(...effPnls);
  const effMax = Math.max(...effPnls);
  // Equity drawdown
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  for (const p of effPnls) {
    eq *= 1 + p;
    if (eq <= 0) {
      eq = 1; // reset after bankruptcy (new margin)
      peak = 1;
      continue;
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return {
    leverage,
    effMean,
    effMin,
    effMax,
    effSharpe,
    effCumRet,
    liquidations,
    liquidationRate: liquidations / effPnls.length,
    maxDd,
  };
}

describe("iter 152 — leverage simulation for 5% daytrade", () => {
  it(
    "compute leverage needed to reach ≥ 5% mean per trade on iter135/iter144",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 152: LEVERAGE 5%-DELIVERY ===");

      // ---- iter135 DAYTRADE ----
      const c1h = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 50_000,
        maxPages: 100,
      });
      const intraReport = runBtcIntraday(c1h, BTC_INTRADAY_CONFIG);
      const intraPnls = intraReport.trades.map((t) => t.pnl);
      console.log(
        `\niter135 DAYTRADE raw: n=${intraPnls.length}, mean=${((intraPnls.reduce((a, b) => a + b, 0) / intraPnls.length) * 100).toFixed(4)}% per book-trade`,
      );

      console.log(
        "\nLev   effMean%   effMin   Sharpe  liqRate  maxDD   cumRet",
      );
      for (const L of [1, 2, 5, 10, 15, 20, 30, 50, 75, 100]) {
        const r = simulateLeverage(intraPnls, L, 365 * 24);
        const at5 = r.effMean >= 0.05 ? " ★ 5%!" : "";
        console.log(
          `${L.toString().padStart(3)}× ${(r.effMean * 100).toFixed(3).padStart(8)}% ${(r.effMin * 100).toFixed(1).padStart(6)}% ${r.effSharpe.toFixed(2).padStart(6)} ${(r.liquidationRate * 100).toFixed(2).padStart(6)}% ${(r.maxDd * 100).toFixed(0).padStart(5)}% ${(r.effCumRet * 100).toFixed(0).padStart(8)}%${at5}`,
        );
      }

      // ---- iter144 MAX SWING ----
      const c1d = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 100,
      });
      const swingReport = runBtcSwing(c1d, BTC_SWING_MAX_CONFIG);
      const swingPnls = swingReport.trades.map((t) => t.pnl);
      console.log(
        `\niter144 MAX raw: n=${swingPnls.length}, mean=${((swingPnls.reduce((a, b) => a + b, 0) / swingPnls.length) * 100).toFixed(3)}% per trade`,
      );

      console.log(
        "\nLev   effMean%   effMin   Sharpe  liqRate  maxDD   cumRet",
      );
      for (const L of [1, 2, 3, 5, 10, 15, 20]) {
        const r = simulateLeverage(swingPnls, L, 365);
        const at5 = r.effMean >= 0.05 ? " ★ 5%!" : "";
        console.log(
          `${L.toString().padStart(3)}× ${(r.effMean * 100).toFixed(2).padStart(7)}% ${(r.effMin * 100).toFixed(1).padStart(6)}% ${r.effSharpe.toFixed(2).padStart(6)} ${(r.liquidationRate * 100).toFixed(2).padStart(6)}% ${(r.maxDd * 100).toFixed(0).padStart(5)}% ${(r.effCumRet * 100).toFixed(0).padStart(10)}%${at5}`,
        );
      }

      // ---- Find minimum leverage reaching 5% mean on iter135 ----
      console.log("\n── Minimum leverage needed for ≥ 5% mean per trade ──");
      for (let L = 1; L <= 100; L++) {
        const r = simulateLeverage(intraPnls, L, 365 * 24);
        if (r.effMean >= 0.05) {
          console.log(
            `iter135 DAYTRADE: **${L}× leverage** → mean ${(r.effMean * 100).toFixed(2)}%, Sharpe ${r.effSharpe.toFixed(2)}, liq ${(r.liquidationRate * 100).toFixed(2)}%, minTrade ${(r.effMin * 100).toFixed(0)}%, maxDD ${(r.maxDd * 100).toFixed(0)}%`,
          );
          break;
        }
      }
      for (let L = 1; L <= 20; L++) {
        const r = simulateLeverage(swingPnls, L, 365);
        if (r.effMean >= 0.05) {
          console.log(
            `iter144 SWING: **${L}× leverage** → mean ${(r.effMean * 100).toFixed(2)}%, Sharpe ${r.effSharpe.toFixed(2)}, liq ${(r.liquidationRate * 100).toFixed(2)}%, minTrade ${(r.effMin * 100).toFixed(0)}%, maxDD ${(r.maxDd * 100).toFixed(0)}%`,
          );
          break;
        }
      }
    },
  );
});
