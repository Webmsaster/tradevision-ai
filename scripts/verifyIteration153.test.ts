/**
 * Iter 153 — LEVERAGE × iter149 WEEKLY_MAX to reach 20% mean per trade.
 *
 * iter149 WEEKLY_MAX raw stats (already 5-gate validated):
 *   mean 10.05% per trade, WR 36%, min trade ~−2% (due to 2% stop),
 *   max trade +50% (TP hit), 44 trades over 8.7 years.
 *
 * Because iter149 has a TIGHT 2% stop (not 1% like iter135), even 10×
 * leverage keeps per-trade loss at only −20% margin — no liquidation.
 * Target: find minimum leverage that delivers ≥ 20% mean per trade
 * while keeping multi-year equity curve alive (no bankruptcy).
 *
 * Also test iter144 MAX for comparison (has 5% stop = bigger per-trade
 * risk but already higher base mean of 5.80%).
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runBtcSwing,
  BTC_WEEKLY_MAX_CONFIG,
  BTC_SWING_MAX_CONFIG,
} from "../src/utils/btcSwing";

function sharpeOf(pnls: number[], barsPerYear: number): number {
  if (pnls.length < 3) return 0;
  const m = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((a, b) => a + (b - m) * (b - m), 0) / (pnls.length - 1);
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (m / sd) * Math.sqrt(barsPerYear);
}

interface LevReport {
  leverage: number;
  effMean: number;
  effMin: number;
  effMax: number;
  effSharpe: number;
  effCumRet: number;
  liquidations: number;
  maxDd: number;
  bankrupt: boolean;
}

function simulate(
  pnls: number[],
  leverage: number,
  barsPerYear: number,
): LevReport {
  const effPnls: number[] = [];
  let liquidations = 0;
  for (const p of pnls) {
    const lev = p * leverage;
    if (lev <= -0.9) {
      effPnls.push(-1.0);
      liquidations++;
    } else {
      effPnls.push(lev);
    }
  }
  const effMean =
    effPnls.length > 0
      ? effPnls.reduce((a, b) => a + b, 0) / effPnls.length
      : 0;
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  let bankrupt = false;
  for (const p of effPnls) {
    eq *= 1 + p;
    if (eq <= 0.01) {
      bankrupt = true;
      break;
    }
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  const effCumRet = bankrupt ? -1 : eq - 1;
  return {
    leverage,
    effMean,
    effMin: Math.min(...effPnls),
    effMax: Math.max(...effPnls),
    effSharpe: sharpeOf(effPnls, barsPerYear),
    effCumRet,
    liquidations,
    maxDd,
    bankrupt,
  };
}

describe("iter 153 — 20% leverage target", () => {
  it(
    "find minimum leverage for 20% mean without bankruptcy",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 153: LEVERAGE × WEEKLY/MAX for 20% ===");

      const c1d = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1d",
        targetCount: 3000,
        maxPages: 100,
      });
      const c1w = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1w",
        targetCount: 500,
        maxPages: 100,
      });

      const maxReport = runBtcSwing(c1d, BTC_SWING_MAX_CONFIG);
      const weeklyReport = runBtcSwing(c1w, BTC_WEEKLY_MAX_CONFIG);
      const maxPnls = maxReport.trades.map((t) => t.pnl);
      const weeklyPnls = weeklyReport.trades.map((t) => t.pnl);

      console.log(
        `\niter144 MAX: n=${maxPnls.length}, mean=${((maxPnls.reduce((a, b) => a + b, 0) / maxPnls.length) * 100).toFixed(2)}%, min=${(Math.min(...maxPnls) * 100).toFixed(1)}%, max=${(Math.max(...maxPnls) * 100).toFixed(1)}%`,
      );
      console.log(
        `iter149 WEEKLY_MAX: n=${weeklyPnls.length}, mean=${((weeklyPnls.reduce((a, b) => a + b, 0) / weeklyPnls.length) * 100).toFixed(2)}%, min=${(Math.min(...weeklyPnls) * 100).toFixed(1)}%, max=${(Math.max(...weeklyPnls) * 100).toFixed(1)}%`,
      );

      console.log(
        "\n── iter144 MAX × leverage (40d hold) ──\nLev  effMean  minTr   Shp    maxDD    cumRet      bankrupt?",
      );
      for (const L of [1, 2, 3, 4, 5, 10]) {
        const r = simulate(maxPnls, L, 365);
        const at20 = r.effMean >= 0.2 ? " ★ 20%!" : "";
        console.log(
          `${L.toString().padStart(2)}× ${(r.effMean * 100).toFixed(2).padStart(7)}% ${(r.effMin * 100).toFixed(1).padStart(6)}% ${r.effSharpe.toFixed(2).padStart(5)} ${(r.maxDd * 100).toFixed(0).padStart(5)}% ${(r.effCumRet * 100).toFixed(0).padStart(12)}%  ${r.bankrupt ? "BANKRUPT" : "alive"}${at20}`,
        );
      }

      console.log(
        "\n── iter149 WEEKLY_MAX × leverage (4w hold, tight 2% stop) ──\nLev  effMean  minTr   Shp    maxDD    cumRet       bankrupt?",
      );
      for (const L of [1, 2, 3, 5, 10, 15, 20, 30, 50]) {
        const r = simulate(weeklyPnls, L, 52);
        const at20 = r.effMean >= 0.2 ? " ★ 20%!" : "";
        console.log(
          `${L.toString().padStart(2)}× ${(r.effMean * 100).toFixed(2).padStart(7)}% ${(r.effMin * 100).toFixed(1).padStart(6)}% ${r.effSharpe.toFixed(2).padStart(5)} ${(r.maxDd * 100).toFixed(0).padStart(5)}% ${(r.effCumRet * 100).toFixed(0).padStart(14)}%  ${r.bankrupt ? "BANKRUPT" : "alive"}${at20}`,
        );
      }

      console.log(
        "\n── Minimum leverage reaching ≥ 20% mean WITHOUT bankruptcy ──",
      );
      for (let L = 1; L <= 50; L++) {
        const r = simulate(maxPnls, L, 365);
        if (r.effMean >= 0.2 && !r.bankrupt) {
          console.log(
            `iter144 MAX: ${L}× lev → mean ${(r.effMean * 100).toFixed(2)}%, maxDD ${(r.maxDd * 100).toFixed(0)}%, cumRet ${(r.effCumRet * 100).toFixed(0)}%, Shp ${r.effSharpe.toFixed(2)}`,
          );
          break;
        }
      }
      for (let L = 1; L <= 50; L++) {
        const r = simulate(weeklyPnls, L, 52);
        if (r.effMean >= 0.2 && !r.bankrupt) {
          console.log(
            `iter149 WEEKLY_MAX: ${L}× lev → mean ${(r.effMean * 100).toFixed(2)}%, maxDD ${(r.maxDd * 100).toFixed(0)}%, cumRet ${(r.effCumRet * 100).toFixed(0)}%, Shp ${r.effSharpe.toFixed(2)}`,
          );
          break;
        }
      }
    },
  );
});
