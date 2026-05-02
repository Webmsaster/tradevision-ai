/**
 * STEP-2 Tuning — V5 → Step-2 variants
 *
 * FTMO Step-2 rules:
 *   profitTarget: 0.05 (5% statt 8%)
 *   maxDays: 60
 *   maxDailyLoss: 0.05
 *   maxTotalLoss: 0.10
 *   minTradingDays: 4
 *
 * Multi-fold OOS (60-day windows, 6-day step) on 9 V5-Cryptos.
 * Realistic FTMO costs (40bp cost / 12bp slippage).
 *
 * Variants:
 *   STEP2_BASE       — V5 + pT=0.05 + maxDays=60 + atrStop + FTMO costs
 *   STEP2_LH300      — BASE + holdBars=300
 *   STEP2_LH500      — BASE + holdBars=500
 *   STEP2_LH720      — BASE + holdBars=720 (cap at window length)
 *   STEP2_4H         — BASE on 4h timeframe
 *   STEP2_LR050      — BASE + riskFrac × 0.50
 *   STEP2_LR075      — BASE + riskFrac × 0.75
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/STEP2_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  medianDays: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  tlRate: number;
  ev: number;
}

const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

/**
 * Realistic FTMO costs: override every asset's costBp / slippageBp
 * (V5 originals are 30bp / 8bp = Binance baseline; FTMO real = 40bp / 12bp).
 */
function applyFtmoRealCosts(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map((a) => ({
      ...a,
      costBp: 40,
      slippageBp: 12,
    })),
  };
}

/**
 * Build STEP-2-base = V5 + atrStop + Step-2 risk rules + FTMO real costs.
 */
function buildStep2Base(): FtmoDaytrade24hConfig {
  const v5 = applyFtmoRealCosts(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
  return {
    ...v5,
    profitTarget: 0.05,
    maxDays: 60,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    pauseAtTargetReached: true,
    atrStop: { period: 14, stopMult: 2.5 },
  };
}

function withHoldBars(
  cfg: FtmoDaytrade24hConfig,
  hb: number,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    holdBars: hb,
    assets: cfg.assets.map((a) => ({ ...a, holdBars: hb })),
  };
}

function withRiskScale(
  cfg: FtmoDaytrade24hConfig,
  scale: number,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map((a) => ({
      ...a,
      riskFrac: (a.riskFrac ?? 1.0) * scale,
    })),
  };
}

function buildStep2_4h(base: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  // 4h: holdBars from V5 (240 = 480h on 2h) → keep ~equivalent calendar (240 4h-bars = 40d)
  return {
    ...base,
    timeframe: "4h",
    // Keep holdBars in BARS units; on 4h that's 2× more calendar time per bar.
    // V5 had hb=240 on 2h = 20 days. On 4h, hb=120 = 20 days (same calendar).
    holdBars: 120,
    assets: base.assets.map((a) => ({ ...a, holdBars: 120 })),
  };
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  barsPerDay: number,
  windowDays: number,
  stepDays: number,
): BatchResult {
  const winBars = windowDays * barsPerDay;
  const stepBars = stepDays * barsPerDay;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset)) {
      slice[sym] = arr.slice(s, s + winBars);
    }
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out) {
    if (r.passed && r.trades.length > 0) {
      passDays.push(r.trades[r.trades.length - 1].day + 1);
    }
  }
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  const tl = out.filter((r) => r.reason === "total_loss").length;
  const dl = out.filter((r) => r.reason === "daily_loss").length;
  // EV: pass yields +5% × $100k account = $5000 net less $99 fee
  return {
    windows: out.length,
    passes,
    passRate: out.length > 0 ? passes / out.length : 0,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: tl,
    dlBreaches: dl,
    tlRate: out.length > 0 ? tl / out.length : 0,
    ev: (out.length > 0 ? passes / out.length : 0) * 5000 - 99,
  };
}

function fmt(label: string, r: BatchResult): string {
  return `${label.padEnd(36)} ${String(r.passes).padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${String(r.medianDays).padStart(2)}d p75=${String(r.p75Days).padStart(2)} p90=${String(r.p90Days).padStart(2)}  TL=${String(r.tlBreaches).padStart(3)} (${(r.tlRate * 100).toFixed(1)}%) DL=${String(r.dlBreaches).padStart(3)}  EV=$${r.ev.toFixed(0)}`;
}

describe(
  "STEP-2 Tuning — V5 → Step-2 variants",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs Step-2 sweep", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `STEP2 START ${new Date().toISOString()}\n`);

      log("Loading 2h Binance history (9 assets, ~30000 bars each)...");
      const data2h: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        data2h[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        log(`  ${s} 2h: ${data2h[s].length} bars`);
      }
      const n2h = Math.min(...Object.values(data2h).map((c) => c.length));
      for (const s of SOURCES) data2h[s] = data2h[s].slice(-n2h);
      log(`2h aligned: ${n2h} bars (${(n2h / 12 / 365).toFixed(2)}y)\n`);

      log("Loading 4h Binance history (9 assets, ~30000 bars each)...");
      const data4h: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        data4h[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "4h",
          targetCount: 30000,
          maxPages: 40,
        });
        log(`  ${s} 4h: ${data4h[s].length} bars`);
      }
      const n4h = Math.min(...Object.values(data4h).map((c) => c.length));
      for (const s of SOURCES) data4h[s] = data4h[s].slice(-n4h);
      log(`4h aligned: ${n4h} bars (${(n4h / 6 / 365).toFixed(2)}y)\n`);

      // Build all variants
      const STEP2_BASE = buildStep2Base();
      const STEP2_LH300 = withHoldBars(STEP2_BASE, 300);
      const STEP2_LH500 = withHoldBars(STEP2_BASE, 500);
      const STEP2_LH720 = withHoldBars(STEP2_BASE, 720);
      const STEP2_4H = buildStep2_4h(STEP2_BASE);
      const STEP2_LR050 = withRiskScale(STEP2_BASE, 0.5);
      const STEP2_LR075 = withRiskScale(STEP2_BASE, 0.75);

      const variants: Array<{
        name: string;
        cfg: FtmoDaytrade24hConfig;
        data: Record<string, Candle[]>;
        barsPerDay: number;
      }> = [
        { name: "STEP2_BASE", cfg: STEP2_BASE, data: data2h, barsPerDay: 12 },
        { name: "STEP2_LH300", cfg: STEP2_LH300, data: data2h, barsPerDay: 12 },
        { name: "STEP2_LH500", cfg: STEP2_LH500, data: data2h, barsPerDay: 12 },
        { name: "STEP2_LH720", cfg: STEP2_LH720, data: data2h, barsPerDay: 12 },
        { name: "STEP2_4H", cfg: STEP2_4H, data: data4h, barsPerDay: 6 },
        { name: "STEP2_LR050", cfg: STEP2_LR050, data: data2h, barsPerDay: 12 },
        { name: "STEP2_LR075", cfg: STEP2_LR075, data: data2h, barsPerDay: 12 },
      ];

      log(`\n========== STEP-2 SWEEP ==========\n`);
      log(`Window: 60 days  Step: 6 days  Costs: 40bp + 12bp slip\n`);

      const results: Array<{
        name: string;
        cfg: FtmoDaytrade24hConfig;
        r: BatchResult;
      }> = [];
      for (const v of variants) {
        const r = runWalkForward(v.data, v.cfg, v.barsPerDay, 60, 6);
        results.push({ name: v.name, cfg: v.cfg, r });
        log(fmt(v.name, r));
      }

      // Pick winner: max passRate; tie-break by lower TL-rate, then lower median.
      function score(a: BatchResult, b: BatchResult): number {
        if (Math.abs(a.passRate - b.passRate) > 1e-9)
          return b.passRate - a.passRate;
        if (a.tlRate !== b.tlRate) return a.tlRate - b.tlRate;
        return a.medianDays - b.medianDays;
      }
      results.sort((x, y) => score(x.r, y.r));

      log(`\n========== RANKING ==========`);
      for (let i = 0; i < results.length; i++) {
        log(fmt(`${i + 1}. ${results[i].name}`, results[i].r));
      }

      const winner = results[0];
      log(`\n========== WINNER ==========`);
      log(fmt(`>>> ${winner.name}`, winner.r));
      writeFileSync(
        `${LOG_DIR}/STEP2_WINNER.json`,
        JSON.stringify(
          {
            name: winner.name,
            metrics: winner.r,
            cfg: winner.cfg,
          },
          null,
          2,
        ),
      );
      log(`Wrote STEP2_WINNER.json`);

      expect(winner.r.windows).toBeGreaterThan(0);
    });
  },
);
