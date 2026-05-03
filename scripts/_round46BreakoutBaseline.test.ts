/**
 * Round 46 — Breakout (Donchian + Volatility-Expansion) baseline + sweep.
 *
 * Hypothesis: V5 family fades trend-continuation; breakout captures the
 * volatility-expansion regime — different P/L distribution than MR or trend.
 *
 * Strategy:
 *   Long when close > N-bar prior high AND ATR(14) > SMA-of-ATR(volMaPeriod)
 *   Exit: trailing stop = chandelier (mult × ATR), pyramid via partialTakeProfit
 *   liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4}
 *
 * Asset basket: same 9 cores as Round 45 for fair comparison.
 *
 * Sweep: 27 variants — donchianPeriod {15,20,25} × atrMult-chand {1.5,2.0,2.5}
 *        × volMaPeriod {30,50,70}.
 *
 * Walk-forward TRAIN/TEST: train first 70% / test last 30%, Δ ≤5pp.
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
const LOG_FILE = `${LOG_DIR}/ROUND46_BREAKOUT_${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

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
    symbol: `${symbol.replace("USDT", "")}-BO`,
    sourceSymbol: symbol,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.07, // trend-following exit; chandelier may exit earlier
    holdBars: 240, // 240×30m = 5d
  };
}

function buildCfg(
  donchianPeriod: number,
  chandMult: number,
  volMaPeriod: number,
): FtmoDaytrade24hConfig {
  const breakout = {
    donchianPeriod,
    atrPeriod: 14,
    volMaPeriod,
  };
  const assets: Daytrade24hAssetCfg[] = BASKET.map((s) => ({
    ...buildAsset(s),
    breakoutEntry: breakout,
  }));
  return {
    triggerBars: 1,
    leverage: 2,
    tpPct: 0.07,
    stopPct: 0.05,
    holdBars: 240,
    timeframe: "30m",
    assets,
    profitTarget: 0.08,
    maxDailyLoss: 0.05,
    maxTotalLoss: 0.1,
    minTradingDays: 4,
    maxDays: 30,
    maxConcurrentTrades: 4,
    pauseAtTargetReached: true,
    atrStop: { period: 14, stopMult: 2.5 },
    chandelierExit: { period: 14, mult: chandMult, minMoveR: 0.5 },
    partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.5 },
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
) {
  const bpd = 48;
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
  "Round 46 — Breakout baseline + sweep",
  { timeout: 4 * 3600_000 },
  () => {
    it("runs", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `ROUND46 START ${new Date().toISOString()}\n`);

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

      const donchianPeriods = [15, 20, 25];
      const chandMults = [1.5, 2.0, 2.5];
      const volMaPeriods = [30, 50, 70];

      const results: Array<{
        label: string;
        cfg: FtmoDaytrade24hConfig;
        full: ReturnType<typeof evalCfg>;
      }> = [];

      log(`========== Breakout sweep (27 variants) ==========`);
      log(`${"label".padEnd(28)}  pass%       p/w      TL%   DL%   med  p90`);
      for (const dp of donchianPeriods) {
        for (const cm of chandMults) {
          for (const vp of volMaPeriods) {
            const cfg = buildCfg(dp, cm, vp);
            const r = evalCfg(aligned, cfg, 0, minBars);
            const label = `dp${dp}_cm${cm}_v${vp}`;
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

      const top3 = results.slice(0, 3).map((r) => ({
        label: `BO_${r.label}`,
        donchianPeriod: (
          r.cfg.assets[0].breakoutEntry as { donchianPeriod: number }
        ).donchianPeriod,
        chandMult: r.cfg.chandelierExit?.mult,
        volMaPeriod: (r.cfg.assets[0].breakoutEntry as { volMaPeriod: number })
          .volMaPeriod,
        passRate: r.full.pass / r.full.total,
        med: r.full.med,
      }));
      writeFileSync(
        `${LOG_DIR}/ROUND46_TOP3.json`,
        JSON.stringify(top3, null, 2),
      );
      log(`\nTop-3 written to ${LOG_DIR}/ROUND46_TOP3.json`);

      expect(results.length).toBe(27);
    });
  },
);
