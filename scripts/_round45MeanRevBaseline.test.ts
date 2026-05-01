/**
 * Round 45 — Mean-Reversion (Bollinger + RSI) baseline + sweep.
 *
 * Hypothesis: V5-family trend-following has hit ceiling (~42% V4-Sim).
 * Mean-reversion captures different P/L distribution (range/oversold dips)
 * → could deliver complementary edge or higher pass-rate.
 *
 * Strategy:
 *   Long when close < lower BB(period, sigma) AND RSI(rsiPeriod) <= rsiThresh
 *   Exit: TP at +1% (mean-reversion target), SL via atrStop (p=14, m=2)
 *   liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4}
 *
 * Asset basket: V5_QUARTZ_LITE 9-core (BTC/ETH/BNB/ADA/LTC/BCH/ETC/XRP/AAVE)
 * — fall back to V5 9-asset basket if ETC/AAVE not in this branch.
 *
 * Sweep: 27 variants — bbPeriod {15,20,25} × sigma {1.8,2.0,2.2} × rsiThresh {25,30,35}.
 *
 * Walk-forward TRAIN/TEST split: train first 70% windows, test last 30% — Δ ≤5pp.
 *
 * Acceptance:
 *   - typecheck clean
 *   - test green
 *   - report top-3 with V4-sim hand-off to round 47
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/ROUND45_MEANREV_${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

// V5_QUARTZ_LITE-style 9 core (this branch has just the V5 8-asset basket; we use those + extend later)
const BASKET = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
];

function buildAsset(symbol: string): Daytrade24hAssetCfg {
  return {
    symbol: `${symbol.replace("USDT", "")}-MR`,
    sourceSymbol: symbol,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.01, // MR: TP near mean (~1%)
    holdBars: 60, // 60×30m = 30h max hold (MR should resolve fast)
  };
}

function buildCfg(
  bbPeriod: number,
  bbSigma: number,
  rsiThresh: number,
): FtmoDaytrade24hConfig {
  const meanRev = {
    bbPeriod,
    bbSigma,
    rsiPeriod: 14,
    rsiThresh,
  };
  const assets: Daytrade24hAssetCfg[] = BASKET.map((s) => ({
    ...buildAsset(s),
    meanRevEntry: meanRev,
  }));
  return {
    triggerBars: 1,
    leverage: 2,
    tpPct: 0.01,
    stopPct: 0.05,
    holdBars: 60,
    timeframe: "30m",
    assets,
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    maxConcurrentTrades: 4,
    pauseAtTargetReached: true,
    atrStop: { period: 14, stopMult: 2 },
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  };
}

function alignCommon(
  data: Record<string, Candle[]>,
  symbols: string[],
): Record<string, Candle[]> {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

function evalCfg(
  aligned: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  startBar: number,
  endBar: number,
): {
  pass: number;
  total: number;
  med: number;
  p90: number;
  tl: number;
  dl: number;
} {
  const bpd = 48; // 30m
  const winBars = cfg.maxDays * bpd;
  const stepBars = 3 * bpd;
  let p = 0,
    w = 0,
    tl = 0,
    dl = 0;
  const days: number[] = [];
  for (let s = startBar; s + winBars <= endBar; s += stepBars) {
    const sub: Record<string, Candle[]> = {};
    for (const sm of Object.keys(aligned))
      sub[sm] = aligned[sm].slice(s, s + winBars);
    const r = runFtmoDaytrade24h(sub, cfg);
    if (r.passed) {
      p++;
      if (r.trades.length > 0) days.push(r.trades[r.trades.length - 1].day + 1);
    }
    if (r.reason === "total_loss") tl++;
    if (r.reason === "daily_loss") dl++;
    w++;
  }
  days.sort((a, b) => a - b);
  return {
    pass: p,
    total: w,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    tl,
    dl,
  };
}

describe(
  "Round 45 — Mean-Reversion baseline + sweep",
  { timeout: 4 * 3600_000 },
  () => {
    it("runs", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `ROUND45 START ${new Date().toISOString()}\n`);

      log(`Loading 30m candles for ${BASKET.length} assets...`);
      const data: Record<string, Candle[]> = {};
      for (const s of BASKET) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 30000,
            maxPages: 40,
          });
          data[s] = r.filter((c) => c.isFinal !== false);
          log(`  ${s}: ${data[s].length} bars`);
        } catch (e) {
          log(`  ${s}: FAIL ${(e as Error).message}`);
        }
      }
      const symbols = BASKET.filter((s) => data[s]?.length > 0);
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s].length));
      const years = minBars / 48 / 365;
      log(
        `Aligned: ${minBars} bars / ${years.toFixed(2)}y across ${symbols.length} assets\n`,
      );

      const bbPeriods = [15, 20, 25];
      const sigmas = [1.8, 2.0, 2.2];
      const rsiThreshs = [25, 30, 35];

      const results: Array<{
        label: string;
        cfg: FtmoDaytrade24hConfig;
        full: ReturnType<typeof evalCfg>;
      }> = [];

      log(`========== Mean-Rev sweep (27 variants) ==========`);
      log(`${"label".padEnd(28)}  pass%       p/w      TL%   DL%   med  p90`);
      for (const bbP of bbPeriods) {
        for (const sg of sigmas) {
          for (const rs of rsiThreshs) {
            const cfg = buildCfg(bbP, sg, rs);
            const r = evalCfg(aligned, cfg, 0, minBars);
            const label = `bb${bbP}_s${sg}_r${rs}`;
            log(
              `${label.padEnd(28)}  ${((r.pass / r.total) * 100).toFixed(2).padStart(5)}%  ${String(r.pass).padStart(3)}/${String(r.total).padEnd(4)}  ${((r.tl / r.total) * 100).toFixed(1).padStart(5)}%  ${((r.dl / r.total) * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(3)}d  ${String(r.p90).padStart(3)}d`,
            );
            results.push({ label, cfg, full: r });
          }
        }
      }

      results.sort(
        (a, b) => b.full.pass / b.full.total - a.full.pass / a.full.total,
      );
      log(`\n========== Top 5 (full sample) ==========`);
      for (const r of results.slice(0, 5)) {
        log(
          `  ${r.label.padEnd(28)} ${((r.full.pass / r.full.total) * 100).toFixed(2)}% / med ${r.full.med}d / p90 ${r.full.p90}d / TL ${((r.full.tl / r.full.total) * 100).toFixed(1)}%`,
        );
      }

      // Walk-forward train/test on top 5
      log(
        `\n========== Walk-forward (train 70% / test 30%) — top 5 ==========`,
      );
      const splitBar = Math.floor(minBars * 0.7);
      log(
        `Train: bars 0..${splitBar} (${(splitBar / 48 / 365).toFixed(2)}y) | Test: bars ${splitBar}..${minBars} (${((minBars - splitBar) / 48 / 365).toFixed(2)}y)`,
      );
      for (const r of results.slice(0, 5)) {
        const tr = evalCfg(aligned, r.cfg, 0, splitBar);
        const te = evalCfg(aligned, r.cfg, splitBar, minBars);
        const trPct = (tr.pass / tr.total) * 100;
        const tePct = (te.pass / te.total) * 100;
        const drift = tePct - trPct;
        log(
          `  ${r.label.padEnd(28)} train=${trPct.toFixed(2)}% (${tr.pass}/${tr.total}) test=${tePct.toFixed(2)}% (${te.pass}/${te.total}) Δ=${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp ${Math.abs(drift) <= 5 ? "[ROBUST]" : "[OVERFIT]"}`,
        );
      }

      const champion = results[0];
      log(
        `\n>>> CHAMPION: ${champion.label}  pass ${((champion.full.pass / champion.full.total) * 100).toFixed(2)}%  med ${champion.full.med}d  TL ${((champion.full.tl / champion.full.total) * 100).toFixed(1)}%`,
      );
      log(`(write top-3 configs to round-47 V4-sim handoff)`);

      // Persist top-3 for round-47 V4-sim consumer
      const top3 = results.slice(0, 3).map((r) => ({
        label: `MR_${r.label}`,
        bbPeriod: (r.cfg.assets[0].meanRevEntry as { bbPeriod: number })
          .bbPeriod,
        bbSigma: (r.cfg.assets[0].meanRevEntry as { bbSigma: number }).bbSigma,
        rsiThresh: (r.cfg.assets[0].meanRevEntry as { rsiThresh: number })
          .rsiThresh,
        passRate: r.full.pass / r.full.total,
        med: r.full.med,
      }));
      writeFileSync(
        `${LOG_DIR}/ROUND45_TOP3.json`,
        JSON.stringify(top3, null, 2),
      );
      log(`\nTop-3 written to ${LOG_DIR}/ROUND45_TOP3.json`);

      expect(results.length).toBe(27);
    });
  },
);
