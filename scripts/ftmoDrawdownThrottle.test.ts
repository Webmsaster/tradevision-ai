/**
 * Drawdown-throttle sweep — reduce 26% total_loss blowout rate by adding
 * NEGATIVE-equity tiers to adaptiveSizing. Goal: lift pass rate WITHOUT
 * losing median speed (must hold ≤ 6d).
 *
 * iter231 current adaptiveSizing is positive-only:
 *   [0.5, 1.25 at +1.5%, 1.25 at +3.5%, 1.0 at +6%, 0.25 at +8%]
 *
 * This sweep tests adding underwater tiers:
 *   [{-2%: 0.3}, {-1%: 0.4}, 0.5, 1.25, ...]
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V231,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  medianDays: number;
  p25Days: number;
  totalLossBreaches: number;
  dailyLossBreaches: number;
  ev: number;
}

function runBatch(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  step = 3,
): BatchResult {
  const winBars = 30 * 6;
  const stepBars = step * 6;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  let daily = 0,
    total = 0;
  for (const r of out) {
    if (r.reason === "daily_loss") daily++;
    if (r.reason === "total_loss") total++;
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  }
  passDays.sort((a, b) => a - b);
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
    p25Days: passDays[Math.floor(passDays.length * 0.25)] ?? 0,
    totalLossBreaches: total,
    dailyLossBreaches: daily,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: BatchResult): string {
  return `${label.padEnd(75)} ${r.passes.toString().padStart(3)}/${r.windows}=${(r.passRate * 100).toFixed(1).padStart(5)}%  med=${r.medianDays.toString().padStart(2)}d  p25=${r.p25Days.toString().padStart(2)}  EV=$${r.ev.toFixed(0).padStart(5)}  DL=${r.dailyLossBreaches} TL=${r.totalLossBreaches}`;
}

describe(
  "Drawdown throttle sweep — lift pass rate without slowing median",
  { timeout: 1_500_000 },
  () => {
    it("test underwater tier variants", async () => {
      const eth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
      const sol = await loadBinanceHistory({
        symbol: "SOLUSDT",
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
      const n = Math.min(eth.length, btc.length, sol.length);
      const data: Record<string, Candle[]> = {
        ETHUSDT: eth.slice(-n),
        BTCUSDT: btc.slice(-n),
        SOLUSDT: sol.slice(-n),
      };
      console.log(`\nLoaded ${(n / 6 / 365).toFixed(1)}y 4h\n`);

      const baseline = runBatch(data, FTMO_DAYTRADE_24H_CONFIG_V231);
      console.log("=== BASELINE ===");
      console.log(fmt("iter231 current", baseline));
      console.log();

      const variants: Array<{ label: string; cfg: FtmoDaytrade24hConfig }> = [];

      // iter231's current adaptiveSizing (positive-only):
      // [0.5, 1.25@+1.5%, 1.25@+3.5%, 1.0@+6%, 0.25@+8%]

      // =================================================================
      // A. Add single underwater tier at different thresholds
      // =================================================================
      for (const dd of [-0.02, -0.03, -0.04, -0.05]) {
        for (const factor of [0.1, 0.2, 0.3, 0.5]) {
          variants.push({
            label: `1-tier: <${(dd * 100).toFixed(0)}% → ${factor}`,
            cfg: {
              ...FTMO_DAYTRADE_24H_CONFIG_V231,
              adaptiveSizing: [
                { equityAbove: dd, factor },
                { equityAbove: 0, factor: 0.5 },
                { equityAbove: 0.015, factor: 1.25 },
                { equityAbove: 0.035, factor: 1.25 },
                { equityAbove: 0.06, factor: 1.0 },
                { equityAbove: 0.08, factor: 0.25 },
              ],
            },
          });
        }
      }

      // =================================================================
      // B. Two-tier underwater (gradual throttle)
      // =================================================================
      for (const [dd1, f1] of [
        [-0.01, 0.4],
        [-0.015, 0.35],
        [-0.02, 0.3],
      ] as const) {
        for (const [dd2, f2] of [
          [-0.03, 0.15],
          [-0.04, 0.1],
          [-0.05, 0.05],
        ] as const) {
          variants.push({
            label: `2-tier: <${(dd1 * 100).toFixed(1)}%→${f1}, <${(dd2 * 100).toFixed(1)}%→${f2}`,
            cfg: {
              ...FTMO_DAYTRADE_24H_CONFIG_V231,
              adaptiveSizing: [
                { equityAbove: dd2, factor: f2 },
                { equityAbove: dd1, factor: f1 },
                { equityAbove: 0, factor: 0.5 },
                { equityAbove: 0.015, factor: 1.25 },
                { equityAbove: 0.035, factor: 1.25 },
                { equityAbove: 0.06, factor: 1.0 },
                { equityAbove: 0.08, factor: 0.25 },
              ],
            },
          });
        }
      }

      // =================================================================
      // C. drawdownShield field alternative
      // =================================================================
      for (const below of [-0.02, -0.03, -0.04]) {
        for (const factor of [0.1, 0.2, 0.3, 0.5]) {
          variants.push({
            label: `shield: below ${(below * 100).toFixed(0)}% → factor ${factor}`,
            cfg: {
              ...FTMO_DAYTRADE_24H_CONFIG_V231,
              drawdownShield: { belowEquity: below, factor },
            },
          });
        }
      }

      // =================================================================
      // D. Aggressive throttle (very small when deep underwater)
      // =================================================================
      const aggressive = [
        {
          label: "aggr: -5%→0.05, -3%→0.15, -1%→0.4",
          tiers: [
            [-0.05, 0.05],
            [-0.03, 0.15],
            [-0.01, 0.4],
          ],
        },
        {
          label: "aggr: -4%→0.1, -2%→0.25",
          tiers: [
            [-0.04, 0.1],
            [-0.02, 0.25],
          ],
        },
        {
          label: "aggr: -3%→0.2, -1%→0.4",
          tiers: [
            [-0.03, 0.2],
            [-0.01, 0.4],
          ],
        },
      ] as const;
      for (const { label, tiers } of aggressive) {
        const ddTiers = tiers.map(([eq, fac]) => ({
          equityAbove: eq,
          factor: fac,
        }));
        variants.push({
          label,
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_V231,
            adaptiveSizing: [
              ...ddTiers,
              { equityAbove: 0, factor: 0.5 },
              { equityAbove: 0.015, factor: 1.25 },
              { equityAbove: 0.035, factor: 1.25 },
              { equityAbove: 0.06, factor: 1.0 },
              { equityAbove: 0.08, factor: 0.25 },
            ],
          },
        });
      }

      console.log(
        `Testing ${variants.length} underwater-throttle variants...\n`,
      );
      const scored = variants.map((v) => ({ ...v, r: runBatch(data, v.cfg) }));

      // Sort by EV
      scored.sort((a, b) => b.r.ev - a.r.ev);
      console.log(
        `--- TOP 20 by EV (baseline EV=$${baseline.ev.toFixed(0)}) ---`,
      );
      for (const { label, r } of scored.slice(0, 20)) {
        const marker =
          r.ev > baseline.ev ? " ★" : r.ev === baseline.ev ? " =" : "";
        console.log(fmt(label, r) + marker);
      }

      // Filter: HARD constraint median ≤6d
      const speedKept = scored.filter(
        (s) => s.r.medianDays <= 6 && s.r.passRate > baseline.passRate,
      );
      speedKept.sort((a, b) => b.r.passRate - a.r.passRate);
      console.log(
        `\n--- median ≤6d AND pass rate > baseline (${speedKept.length}) ---`,
      );
      for (const { label, r } of speedKept.slice(0, 15))
        console.log(fmt(label, r));

      // TotalLoss reduction champions
      scored.sort((a, b) => a.r.totalLossBreaches - b.r.totalLossBreaches);
      console.log(
        `\n--- Fewest total_loss blowouts (baseline=${baseline.totalLossBreaches}) ---`,
      );
      for (const { label, r } of scored.slice(0, 10))
        console.log(fmt(label, r));

      // Strict Pareto over baseline
      const strict = scored.filter(
        (s) =>
          s.r.passRate >= baseline.passRate &&
          s.r.medianDays <= baseline.medianDays &&
          s.r.totalLossBreaches <= baseline.totalLossBreaches &&
          (s.r.passRate > baseline.passRate ||
            s.r.medianDays < baseline.medianDays ||
            s.r.totalLossBreaches < baseline.totalLossBreaches),
      );
      strict.sort((a, b) => b.r.ev - a.r.ev);
      console.log(
        `\n--- Strict Pareto-dominates baseline (${strict.length}) ---`,
      );
      for (const { label, r } of strict.slice(0, 10))
        console.log(fmt(label, r));

      expect(true).toBe(true);
    });
  },
);
