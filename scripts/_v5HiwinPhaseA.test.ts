/**
 * Phase A — Asset-Pool Expansion on V5_HIWIN.
 * Goal: push pass-rate from 49.85% toward 55% by adding helper assets.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5HIWIN_PHASE_A_${STAMP}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
}

function normalize(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.timeframe = "2h";
  c.profitTarget = 0.08;
  c.maxDailyLoss = 0.05;
  c.maxTotalLoss = 0.1;
  c.minTradingDays = 4;
  c.maxDays = 30;
  c.pauseAtTargetReached = true;
  c.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  return c;
}

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

interface Result {
  name: string;
  passRate: number;
  passes: number;
  windows: number;
  tl: number;
  dl: number;
  med: number;
  p90: number;
  totalTrades: number;
  totalWins: number;
  winrate: number;
}

function evaluate(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
): Result {
  const c = normalize(cfg);
  const symbols = syms(c);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = c.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0;
  let passes = 0;
  let tl = 0;
  let dl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  const days: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, c);
    windows++;
    if (res.passed) {
      passes++;
      days.push(res.passDay ?? 0);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
    for (const t of res.trades) {
      totalTrades++;
      if (t.effPnl > 0) totalWins++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    name,
    passRate: passes / windows,
    passes,
    windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    totalTrades,
    totalWins,
    winrate: totalTrades > 0 ? totalWins / totalTrades : 0,
  };
}

function fmt(r: Result): string {
  return `${r.name.padEnd(40)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${String(r.passes).padStart(4)}/${r.windows}) winrate=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)}`;
}

function makeAsset(
  srcSym: string,
  label: string,
): FtmoDaytrade24hConfig["assets"][number] {
  return {
    symbol: label,
    sourceSymbol: srcSym,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.04, // hiwin tp
    holdBars: 240,
  };
}

function withAdded(
  base: FtmoDaytrade24hConfig,
  srcSym: string,
  label: string,
): FtmoDaytrade24hConfig {
  return { ...base, assets: [...base.assets, makeAsset(srcSym, label)] };
}

function withDropped(
  base: FtmoDaytrade24hConfig,
  label: string,
): FtmoDaytrade24hConfig {
  return { ...base, assets: base.assets.filter((a) => a.symbol !== label) };
}

const CANDIDATES: Array<{ binance: string; label: string }> = [
  { binance: "XRPUSDT", label: "XRP-TREND" },
  { binance: "DOTUSDT", label: "DOT-TREND" },
  { binance: "AAVEUSDT", label: "AAVE-TREND" },
  { binance: "UNIUSDT", label: "UNI-TREND" },
  { binance: "MATICUSDT", label: "MATIC-TREND" },
  { binance: "TRXUSDT", label: "TRX-TREND" },
  { binance: "ATOMUSDT", label: "ATOM-TREND" },
  { binance: "FILUSDT", label: "FIL-TREND" },
  { binance: "ETCUSDT", label: "ETC-TREND" },
  { binance: "ALGOUSDT", label: "ALGO-TREND" },
  { binance: "ICPUSDT", label: "ICP-TREND" },
  { binance: "NEARUSDT", label: "NEAR-TREND" },
];

describe(
  "V5_HIWIN Phase A — asset expansion",
  { timeout: 6 * 3600_000 },
  () => {
    it("greedily adds best helper assets", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5HIWIN_PHASE_A START ${new Date().toISOString()}\n`,
      );

      // Load all candidate symbols + base symbols
      const allSyms = [
        ...new Set([
          ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN),
          ...CANDIDATES.map((c) => c.binance),
        ]),
      ].sort();

      log(`\nLoading 2h candles for ${allSyms.length} symbols...`);
      const data: Record<string, Candle[]> = {};
      for (const s of allSyms) {
        try {
          const raw = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 30000,
            maxPages: 40,
          });
          data[s] = raw.filter((c) => c.isFinal);
          log(
            `  ${s.padEnd(10)} final=${data[s].length} first=${new Date(data[s][0]?.openTime ?? 0).toISOString()}`,
          );
        } catch (e) {
          log(`  ${s.padEnd(10)} LOAD FAILED: ${String(e).slice(0, 80)}`);
        }
      }

      // Baseline
      log(`\n========== BASELINE ==========`);
      const baseR = evaluate(
        "V5_HIWIN baseline",
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
        data,
      );
      log(fmt(baseR));

      // Phase A1: each new asset added singly
      log(`\n========== PHASE A1: single-asset adds ==========`);
      const singles: Result[] = [];
      for (const { binance, label } of CANDIDATES) {
        if (!data[binance] || data[binance].length < 5000) {
          log(`  skip ${label} (insufficient data)`);
          continue;
        }
        const cfg = withAdded(
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
          binance,
          label,
        );
        const r = evaluate(`+${label}`, cfg, data);
        log(fmt(r));
        singles.push(r);
      }

      // Phase A2: greedy stack — add all that helped
      log(`\n========== PHASE A2: greedy stack of helpers ==========`);
      const helpers = singles
        .filter((r) => r.passRate > baseR.passRate && r.med <= 4)
        .sort((a, b) => b.passRate - a.passRate);
      log(`Helpers (sorted): ${helpers.map((h) => h.name).join(", ")}`);

      let stacked = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN;
      let stackedR = baseR;
      for (const h of helpers) {
        const m = h.name.match(/^\+(.+)$/);
        if (!m) continue;
        const label = m[1];
        const cand = CANDIDATES.find((c) => c.label === label);
        if (!cand) continue;
        const trial = withAdded(stacked, cand.binance, cand.label);
        const r = evaluate(
          `stack(${stacked.assets.length + 1}): +${label}`,
          trial,
          data,
        );
        log(fmt(r));
        if (r.passRate > stackedR.passRate && r.med <= 4) {
          stacked = trial;
          stackedR = r;
          log(
            `  ✓ kept (pass ${(r.passRate * 100).toFixed(2)}% > ${(stackedR.passRate * 100).toFixed(2)}%)`,
          );
        } else {
          log(`  ✗ dropped`);
        }
      }

      // Phase A3: greedy drop — try removing each existing asset
      log(`\n========== PHASE A3: greedy drop of existing assets ==========`);
      let bestR = stackedR;
      let best = stacked;
      let progress = true;
      while (progress) {
        progress = false;
        const labels = best.assets.map((a) => a.symbol);
        for (const label of labels) {
          const trial = withDropped(best, label);
          if (trial.assets.length === 0) continue;
          const r = evaluate(`drop ${label}`, trial, data);
          log(fmt(r));
          if (r.passRate > bestR.passRate && r.med <= 4) {
            best = trial;
            bestR = r;
            progress = true;
            log(`  ✓ kept (pass ${(r.passRate * 100).toFixed(2)}%)`);
            break;
          }
        }
      }

      log(`\n========== FINAL CHAMPION ==========`);
      log(fmt(bestR));
      log(`Asset list: ${best.assets.map((a) => a.symbol).join(", ")}`);
      log(
        `vs baseline: ${(bestR.passRate * 100).toFixed(2)}% vs ${(baseR.passRate * 100).toFixed(2)}% = +${((bestR.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );

      writeFileSync(
        `${LOG_DIR}/V5HIWIN_PHASE_A_${STAMP}.json`,
        JSON.stringify(
          {
            baseline: baseR,
            singles,
            finalAssets: best.assets.map((a) => ({
              symbol: a.symbol,
              sourceSymbol: a.sourceSymbol,
            })),
            finalResult: bestR,
          },
          null,
          2,
        ),
      );

      expect(bestR.passRate).toBeGreaterThanOrEqual(baseR.passRate);
    });
  },
);
