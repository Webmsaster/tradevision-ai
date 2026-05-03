/**
 * V5_FASTMAX_HIWIN sweep — maximize trade-level winrate without dropping
 * challenge pass-rate below V5 baseline.
 *
 * Hypothesis: tighter TP + breakEven + chandelier should raise the per-trade
 * winrate (more wins, fewer reversal losses) at the cost of avg-win size.
 * If pass-rate stays ≥ V5 (48.96%) and median ≤ 4d, we have a real upgrade.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_FASTMAX_HIWIN_${STAMP}.log`;

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
  med: number;
  p90: number;
  tl: number;
  dl: number;
  tradeWinRate: number;
  totalTrades: number;
  totalWins: number;
  avgTradesPerWin: number;
}

function evaluate(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  stepBars: number,
): Result {
  const c = normalize(cfg);
  const symbols = syms(c);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = c.maxDays * BARS_PER_DAY;
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
    for (const t of res.trades as Daytrade24hTrade[]) {
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
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    tl,
    dl,
    tradeWinRate: totalTrades > 0 ? totalWins / totalTrades : 0,
    totalTrades,
    totalWins,
    avgTradesPerWin: totalWins > 0 ? totalTrades / totalWins : 0,
  };
}

function fmt(r: Result): string {
  return `${r.name.padEnd(36)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${String(r.passes).padStart(4)}/${r.windows}) winrate=${(r.tradeWinRate * 100).toFixed(2).padStart(6)}% (${r.totalWins}/${r.totalTrades}) med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)}`;
}

function setUniformTp(
  cfg: FtmoDaytrade24hConfig,
  tp: number,
): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.tpPct = tp;
  c.assets = c.assets.map((a) => ({ ...a, tpPct: tp }));
  return c;
}

function setUniformSl(
  cfg: FtmoDaytrade24hConfig,
  sl: number,
): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.stopPct = sl;
  c.assets = c.assets.map((a) => ({ ...a, stopPct: sl }));
  return c;
}

function withBreakEven(
  cfg: FtmoDaytrade24hConfig,
  threshold: number,
): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.breakEven = { threshold };
  return c;
}

function withChandelier(
  cfg: FtmoDaytrade24hConfig,
  period: number,
  mult: number,
  minMoveR: number,
): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.chandelierExit = { period, mult, minMoveR };
  return c;
}

function withPtp(
  cfg: FtmoDaytrade24hConfig,
  triggerPct: number,
  closeFraction: number,
): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.partialTakeProfit = { triggerPct, closeFraction };
  return c;
}

describe("V5_FASTMAX_HIWIN sweep", { timeout: 4 * 3600_000 }, () => {
  it("maximizes daytrade winrate while keeping pass-rate >= V5", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_FASTMAX_HIWIN START ${new Date().toISOString()}\n`,
    );

    const symbolsAll = [
      ...new Set([
        ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5),
        ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX),
      ]),
    ].sort();

    log(`\nLoading 2h candles: ${symbolsAll.join(", ")}`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbolsAll) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      data[s] = raw.filter((c) => c.isFinal);
      log(`  ${s.padEnd(8)} final=${data[s].length}`);
    }

    const stepBars = 3 * BARS_PER_DAY;

    log(`\n========== BASELINES ==========`);
    const baseV5 = evaluate(
      "V5",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      data,
      stepBars,
    );
    const baseFastmax = evaluate(
      "V5_FASTMAX",
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
      data,
      stepBars,
    );
    log(fmt(baseV5));
    log(fmt(baseFastmax));
    const passFloor = baseV5.passRate;
    const targetWin = baseFastmax.tradeWinRate;
    log(`\nPass-floor (must beat): ${(passFloor * 100).toFixed(2)}%`);
    log(`Trade-winrate to beat: ${(targetWin * 100).toFixed(2)}%`);

    const all: Result[] = [baseV5, baseFastmax];

    log(`\n========== PHASE 1: TP scan (uniform tpPct on V5) ==========`);
    for (const tp of [
      0.04, 0.045, 0.05, 0.055, 0.058, 0.06, 0.062, 0.065, 0.07,
    ]) {
      const c = setUniformTp(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, tp);
      const r = evaluate(`TP=${(tp * 100).toFixed(1)}%`, c, data, stepBars);
      log(fmt(r));
      all.push(r);
    }

    // best-by-winrate config among TP scan that still passes >= V5 pass floor
    const tpCandidates = all
      .filter((r) => r.name.startsWith("TP=") && r.passRate >= passFloor)
      .sort((a, b) => b.tradeWinRate - a.tradeWinRate);
    const bestTpResult = tpCandidates[0] ?? null;
    if (!bestTpResult) {
      log(
        `\nNo TP variant beat V5 pass-floor — using FASTMAX TP=6.0% as baseline.`,
      );
    } else {
      log(
        `\nBest TP variant by winrate (passing floor): ${bestTpResult.name} winrate=${(bestTpResult.tradeWinRate * 100).toFixed(2)}%`,
      );
    }
    const bestTpPct = bestTpResult
      ? Number(bestTpResult.name.match(/TP=([\d.]+)%/)![1]) / 100
      : 0.06;

    log(
      `\n========== PHASE 2: + breakEven (best TP=${(bestTpPct * 100).toFixed(1)}%) ==========`,
    );
    const tpBase = setUniformTp(
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      bestTpPct,
    );
    for (const be of [0.015, 0.02, 0.025, 0.03, 0.035]) {
      const c = withBreakEven(tpBase, be);
      const r = evaluate(
        `TP=${(bestTpPct * 100).toFixed(1)}% +BE=${(be * 100).toFixed(1)}%`,
        c,
        data,
        stepBars,
      );
      log(fmt(r));
      all.push(r);
    }

    const beCandidates = all
      .filter((r) => r.name.includes("+BE=") && r.passRate >= passFloor)
      .sort((a, b) => b.tradeWinRate - a.tradeWinRate);
    const bestBeResult = beCandidates[0] ?? null;
    log(
      bestBeResult
        ? `\nBest +BE: ${bestBeResult.name}`
        : `\nNo BE variant beat V5 pass-floor.`,
    );
    const bestBe = bestBeResult
      ? Number(bestBeResult.name.match(/\+BE=([\d.]+)%/)![1]) / 100
      : null;

    log(`\n========== PHASE 3: + chandelierExit (on best TP+BE) ==========`);
    let phase3Base = bestBe !== null ? withBreakEven(tpBase, bestBe) : tpBase;
    for (const [period, mult, minR] of [
      [14, 3, 0.5],
      [14, 4, 0.5],
      [28, 3, 0.5],
      [28, 4, 0.5],
      [28, 3, 1.0],
      [56, 3, 0.5],
    ] as Array<[number, number, number]>) {
      const c = withChandelier(phase3Base, period, mult, minR);
      const beTag = bestBe !== null ? `+BE=${(bestBe * 100).toFixed(1)}%` : "";
      const r = evaluate(
        `TP=${(bestTpPct * 100).toFixed(1)}% ${beTag} +CHN p=${period}m=${mult}r=${minR}`,
        c,
        data,
        stepBars,
      );
      log(fmt(r));
      all.push(r);
    }

    log(`\n========== PHASE 4: + partialTakeProfit (on best chain) ==========`);
    const chnCandidates = all
      .filter((r) => r.name.includes("+CHN") && r.passRate >= passFloor)
      .sort((a, b) => b.tradeWinRate - a.tradeWinRate);
    const bestChnResult = chnCandidates[0] ?? null;
    let phase4Base = phase3Base;
    if (bestChnResult) {
      const m = bestChnResult.name.match(/\+CHN p=(\d+)m=(\d+)r=([\d.]+)/);
      if (m)
        phase4Base = withChandelier(
          phase3Base,
          Number(m[1]),
          Number(m[2]),
          Number(m[3]),
        );
      log(`Best +CHN: ${bestChnResult.name}`);
    } else {
      log(`No CHN variant beat floor — staying on TP+BE base.`);
    }
    for (const [trigger, frac] of [
      [0.02, 0.3],
      [0.025, 0.3],
      [0.03, 0.3],
      [0.025, 0.5],
    ] as Array<[number, number]>) {
      const c = withPtp(phase4Base, trigger, frac);
      const r = evaluate(
        `PTP trig=${(trigger * 100).toFixed(1)}% frac=${frac}`,
        c,
        data,
        stepBars,
      );
      log(fmt(r));
      all.push(r);
    }

    log(`\n========== TOP BY WINRATE (passing V5 floor + med ≤ 4d) ==========`);
    const champions = all
      .filter((r) => r.passRate >= passFloor && r.med > 0 && r.med <= 4)
      .sort((a, b) => b.tradeWinRate - a.tradeWinRate);
    for (const r of champions.slice(0, 12)) log(fmt(r));

    log(`\n========== TOP BY PASS-RATE (med ≤ 4d) ==========`);
    const passLeaders = all
      .filter((r) => r.med > 0 && r.med <= 4)
      .sort((a, b) => b.passRate - a.passRate);
    for (const r of passLeaders.slice(0, 12)) log(fmt(r));

    writeFileSync(
      `${LOG_DIR}/V5_FASTMAX_HIWIN_${STAMP}.json`,
      JSON.stringify({ baseV5, baseFastmax, all }, null, 2),
    );

    expect(champions[0]?.tradeWinRate ?? 0).toBeGreaterThan(0);
  });
});
