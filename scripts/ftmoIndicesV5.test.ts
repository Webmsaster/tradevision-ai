/**
 * V5-on-Indices backtest — kann V5 auf DAX / US30 / NAS / S&P / FTSE
 * die FTMO Step-1 Pass-Rate über 50% pushen?
 *
 * Hypothese: Indices haben tighter trends + weniger noise als crypto →
 * V5-Trend-Following sollte besser performen. Crypto-Baseline: 47% pass.
 *
 * Setup:
 *   - Daten: Yahoo Finance v8 chart API (1h candles, max ~730d range)
 *           → resample zu 2h für V5-Engine
 *   - Costs:  costBp=5, slippageBp=2, swapBpPerDay=1 (indices spread tighter)
 *   - Risk:   stopPct=2%, tpPct=3% (1.5:1 R:R, indices weniger volatil)
 *   - Engine: V5-clone, leverage=5, profitTarget=0.08, maxDays=30, mD=4
 *   - Hour-Filter: removed (V5-default targets crypto 24/7 — indices RTH only)
 *
 * Tests:
 *   - per-asset (jeder Index alleine)
 *   - combo (alle gemeinsam)
 *   - Walk-forward 30d/3d step auf 2h
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadYahooIntraday, resampleCandles } from "./_loadYahooHistory";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12; // 2h on 24/7 — for indices 6.5h RTH ≈ 3-4 actual bars/day
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/INDICES_V5_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const INDICES: Array<{ key: string; yahoo: string; label: string }> = [
  { key: "GSPC", yahoo: "^GSPC", label: "S&P500" },
  { key: "DJI", yahoo: "^DJI", label: "US30" },
  { key: "IXIC", yahoo: "^IXIC", label: "NAS100" },
  { key: "GDAXI", yahoo: "^GDAXI", label: "DAX" },
  { key: "FTSE", yahoo: "^FTSE", label: "FTSE100" },
];

function buildIndexAsset(key: string) {
  return {
    symbol: `${key}-TREND`,
    sourceSymbol: key,
    costBp: 5,
    slippageBp: 2,
    swapBpPerDay: 1,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.02,
    tpPct: 0.03,
    holdBars: 240,
  };
}

function buildIndicesV5Config(selectedKeys: string[]): FtmoDaytrade24hConfig {
  const base = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5;
  return {
    ...base,
    assets: selectedKeys.map(buildIndexAsset),
    leverage: 5,
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    pauseAtTargetReached: true,
    liveCaps: { maxStopPct: 0.03, maxRiskFrac: 0.4 },
    // V5 hour-filter is crypto-tuned 24/7 — strip for indices RTH market
    allowedHoursUtc: undefined,
  };
}

describe("V5-on-Indices", { timeout: 24 * 3600_000 }, () => {
  it("backtests V5 on major indices", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `INDICES V5 ${new Date().toISOString()}\n`);

    // ---------- 1. LOAD DATA ----------
    log("Loading Yahoo intraday 1h x 2y for indices…");
    const data1h: Record<string, Candle[]> = {};
    const loaded: string[] = [];
    const failed: string[] = [];

    for (const idx of INDICES) {
      try {
        const c = await loadYahooIntraday(idx.yahoo, "1h", "2y");
        if (c.length < 500) {
          log(`  ${idx.label} (${idx.yahoo}): only ${c.length} bars → SKIP`);
          failed.push(idx.label);
          continue;
        }
        data1h[idx.key] = c;
        loaded.push(idx.label);
        const days = (c.length / 6.5).toFixed(0);
        log(
          `  ${idx.label.padEnd(8)} (${idx.yahoo}): ${c.length} 1h bars (≈${days} trading days)`,
        );
      } catch (e: any) {
        failed.push(idx.label);
        log(`  ${idx.label} (${idx.yahoo}): FAILED — ${e.message}`);
      }
    }

    if (loaded.length === 0) {
      log("\nNO DATA LOADED — FTMO Indices Backtest unmöglich ohne API-Key");
      expect(true).toBe(true);
      return;
    }

    // ---------- 2. RESAMPLE 1h → 2h ----------
    log("\nResampling 1h → 2h…");
    const TWO_H = 2 * 3600_000;
    const data2h: Record<string, Candle[]> = {};
    for (const k of Object.keys(data1h)) {
      data2h[k] = resampleCandles(data1h[k], TWO_H);
      log(`  ${k.padEnd(8)}: 1h ${data1h[k].length} → 2h ${data2h[k].length}`);
    }

    // Align lengths to common length per fold (we don't trim globally — each
    // index has different trading hours; instead we walk-forward each asset's
    // own bars).
    // For multi-asset combo we need same length: align by openTime overlap.

    // ---------- 3. PER-ASSET BACKTEST ----------
    log(
      `\n${"=".repeat(80)}\nPER-ASSET WALK-FORWARD (30d window / 3d step on 2h)\n${"=".repeat(80)}`,
    );
    log(
      `${"Asset".padEnd(10)} | ${"Bars".padEnd(6)} | ${"Win".padEnd(6)} | ${"Pass%".padEnd(7)} | ${"TL%".padEnd(6)} | ${"DL%".padEnd(6)} | ${"medD".padEnd(5)} | ${"p90D".padEnd(5)}`,
    );
    log("-".repeat(80));

    function walkForward(
      data: Record<string, Candle[]>,
      cfg: FtmoDaytrade24hConfig,
    ): {
      windows: number;
      passes: number;
      passRate: number;
      tl: number;
      tlRate: number;
      dl: number;
      dlRate: number;
      med: number;
      p75: number;
      p90: number;
    } {
      const lengths = Object.values(data).map((c) => c.length);
      const n = Math.min(...lengths);
      // Trim to common length so all assets align
      const aligned: Record<string, Candle[]> = {};
      for (const k of Object.keys(data)) aligned[k] = data[k].slice(-n);

      // 30d window @ 2h bars: indices ~3.5 actual bars/day RTH → adapt
      // BUT walk-forward window is in *bars*, not days. Use 30d × 12 bars/day=360.
      // For indices the actual elapsed wall-clock is longer, but engine treats bars
      // as time units. We apply the SAME window as crypto: 30 calendar days = 360
      // 2h-bars. Indices have gaps, so 360 bars covers more wall-clock — but the
      // engine's day counter uses bar-index/12, matching crypto convention.
      const winBars = 30 * BARS_PER_DAY; // 360
      const stepBars = 3 * BARS_PER_DAY; // 36
      const out: FtmoDaytrade24hResult[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const k of Object.keys(aligned)) {
          sub[k] = aligned[k].slice(s, s + winBars);
        }
        out.push(runFtmoDaytrade24h(sub, cfg));
      }
      const passes = out.filter((r) => r.passed).length;
      const tl = out.filter((r) => r.reason === "total_loss").length;
      const dl = out.filter((r) => r.reason === "daily_loss").length;
      const passDays: number[] = [];
      for (const r of out)
        if (r.passed && r.trades.length > 0)
          passDays.push(r.trades[r.trades.length - 1].day + 1);
      passDays.sort((a, b) => a - b);
      const pick = (q: number) =>
        passDays.length === 0
          ? 0
          : passDays[
              Math.min(passDays.length - 1, Math.floor(passDays.length * q))
            ];
      return {
        windows: out.length,
        passes,
        passRate: out.length > 0 ? passes / out.length : 0,
        tl,
        tlRate: out.length > 0 ? tl / out.length : 0,
        dl,
        dlRate: out.length > 0 ? dl / out.length : 0,
        med: pick(0.5),
        p75: pick(0.75),
        p90: pick(0.9),
      };
    }

    const perAsset: Array<{
      key: string;
      label: string;
      res: ReturnType<typeof walkForward>;
    }> = [];
    for (const idx of INDICES) {
      if (!data2h[idx.key]) continue;
      const cfg = buildIndicesV5Config([idx.key]);
      const subset: Record<string, Candle[]> = { [idx.key]: data2h[idx.key] };
      const res = walkForward(subset, cfg);
      perAsset.push({ key: idx.key, label: idx.label, res });
      log(
        `${idx.label.padEnd(10)} | ${String(data2h[idx.key].length).padEnd(6)} | ${String(res.windows).padEnd(6)} | ${(res.passRate * 100).toFixed(2).padEnd(7)} | ${(res.tlRate * 100).toFixed(2).padEnd(6)} | ${(res.dlRate * 100).toFixed(2).padEnd(6)} | ${String(res.med).padEnd(5)} | ${String(res.p90).padEnd(5)}`,
      );
    }

    // ---------- 4. COMBO BACKTEST ----------
    log(
      `\n${"=".repeat(80)}\nCOMBO WALK-FORWARD (all loaded indices) — leverage sweep\n${"=".repeat(80)}`,
    );
    const allKeys = Object.keys(data2h);
    if (allKeys.length >= 2) {
      log(
        `${"Variant".padEnd(28)} | ${"Pass%".padEnd(7)} | ${"TL%".padEnd(6)} | ${"DL%".padEnd(6)} | ${"medD".padEnd(5)} | ${"p75".padEnd(4)} | ${"p90".padEnd(4)}`,
      );
      log("-".repeat(80));
      const variants: Array<{
        name: string;
        mut: (c: FtmoDaytrade24hConfig) => FtmoDaytrade24hConfig;
      }> = [
        { name: "lev=5 (default brief)", mut: (c) => c },
        { name: "lev=3", mut: (c) => ({ ...c, leverage: 3 }) },
        { name: "lev=2", mut: (c) => ({ ...c, leverage: 2 }) },
        {
          name: "lev=5 + maxConcurrent=2",
          mut: (c) => ({ ...c, maxConcurrentTrades: 2 }),
        },
        {
          name: "lev=3 + maxConcurrent=2",
          mut: (c) => ({ ...c, leverage: 3, maxConcurrentTrades: 2 }),
        },
        {
          name: "lev=2 + maxConcurrent=2",
          mut: (c) => ({ ...c, leverage: 2, maxConcurrentTrades: 2 }),
        },
      ];
      for (const v of variants) {
        const cfg = v.mut(buildIndicesV5Config(allKeys));
        const r = walkForward(data2h, cfg);
        log(
          `${v.name.padEnd(28)} | ${(r.passRate * 100).toFixed(2).padEnd(7)} | ${(r.tlRate * 100).toFixed(2).padEnd(6)} | ${(r.dlRate * 100).toFixed(2).padEnd(6)} | ${String(r.med).padEnd(5)} | ${String(r.p75).padEnd(4)} | ${String(r.p90).padEnd(4)}`,
        );
      }
    } else {
      log(`Need ≥2 indices for combo, only ${allKeys.length} loaded`);
    }

    // ---------- 5. SUMMARY ----------
    log(
      `\n${"=".repeat(80)}\nSUMMARY VS V5-CRYPTO BASELINE (47% pass)\n${"=".repeat(80)}`,
    );
    if (perAsset.length > 0) {
      const best = [...perAsset].sort(
        (a, b) => b.res.passRate - a.res.passRate,
      )[0];
      log(
        `Best single asset: ${best.label} = ${(best.res.passRate * 100).toFixed(2)}% pass`,
      );
      const meanPerAsset =
        perAsset.reduce((s, r) => s + r.res.passRate, 0) / perAsset.length;
      log(`Mean per-asset pass-rate: ${(meanPerAsset * 100).toFixed(2)}%`);
    }
    log(`Crypto V5 baseline: ~47%`);
    log(`Loaded: ${loaded.join(", ")}`);
    if (failed.length) log(`Failed: ${failed.join(", ")}`);

    expect(true).toBe(true);
  });
});
