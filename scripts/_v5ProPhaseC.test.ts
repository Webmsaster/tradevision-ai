/**
 * Phase C — Random hyperparameter sweep on V5_PRO (10 assets).
 * Now that AAVE+XRP changed the asset distribution, original V5 hours/TPs
 * may not be optimum. Search 100 trials over global + asset-specific hooks.
 *
 * Goal: push 53.46% → 55%+ while keeping med ≤ 4d.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_PRO_PHASE_C_${STAMP}.log`;
const TRIALS = 100;

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
  trial: number;
  passRate: number;
  passes: number;
  windows: number;
  tl: number;
  dl: number;
  med: number;
  p90: number;
  winrate: number;
  config: Record<string, unknown>;
}

function evaluate(
  trial: number,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  configMeta: Record<string, unknown>,
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
    trial,
    passRate: passes / windows,
    passes,
    windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalTrades > 0 ? totalWins / totalTrades : 0,
    config: configMeta,
  };
}

function fmt(r: Result): string {
  return `t${String(r.trial).padStart(3)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) wr=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)} ${JSON.stringify(r.config)}`;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function buildVariant(rand: () => number): {
  cfg: FtmoDaytrade24hConfig;
  meta: Record<string, unknown>;
} {
  const meta: Record<string, unknown> = {};
  let cfg = structuredClone(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO);

  // 1) tpPct
  const tp = pick(rand, [0.035, 0.04, 0.045, 0.05]);
  meta.tp = tp;
  cfg.tpPct = tp;
  cfg.assets = cfg.assets.map((a) => ({ ...a, tpPct: tp }));

  // 2) stopPct
  const sp = pick(rand, [0.04, 0.045, 0.05]);
  meta.sp = sp;
  cfg.stopPct = sp;
  cfg.assets = cfg.assets.map((a) => ({ ...a, stopPct: sp }));

  // 3) holdBars
  const hb = pick(rand, [120, 180, 240, 300, 360, 480]);
  meta.hb = hb;
  cfg.holdBars = hb;
  cfg.assets = cfg.assets.map((a) => ({ ...a, holdBars: hb }));

  // 4) hour-filter — ALL hours, drop 0-3 random ones
  if (rand() < 0.6) {
    const baseHrs = cfg.allowedHoursUtc ?? [];
    const dropN = Math.floor(rand() * 4);
    const dropped = new Set<number>();
    for (let i = 0; i < dropN; i++) dropped.add(pick(rand, baseHrs));
    cfg.allowedHoursUtc = baseHrs.filter((h) => !dropped.has(h));
    meta.hours = cfg.allowedHoursUtc;
  }

  // 5) atrStop
  if (rand() < 0.4) {
    const period = pick(rand, [14, 28]);
    const mult = pick(rand, [2, 3, 4]);
    cfg.atrStop = { period, stopMult: mult };
    meta.atr = `p${period}m${mult}`;
  }

  // 6) lossStreakCooldown
  if (rand() < 0.3) {
    const after = pick(rand, [2, 3]);
    const cd = pick(rand, [12, 24, 48, 96]);
    cfg.lossStreakCooldown = { afterLosses: after, cooldownBars: cd };
    meta.lsc = `${after}/${cd}`;
  }

  // 7) htfTrendFilter
  if (rand() < 0.3) {
    const lb = pick(rand, [12, 24, 48]);
    const apply = pick(rand, ["short", "long", "both"]) as
      | "short"
      | "long"
      | "both";
    const thr = pick(rand, [0, 0.02, 0.05]);
    cfg.htfTrendFilter = { lookbackBars: lb, apply, threshold: thr };
    meta.htf = `lb${lb}/${apply}/${thr}`;
  }

  // 8) trailingStop (V3-style)
  if (rand() < 0.2) {
    const ap = pick(rand, [0.02, 0.025, 0.03]);
    const tr = pick(rand, [0.005, 0.01, 0.015]);
    cfg.trailingStop = { activatePct: ap, trailPct: tr };
    meta.trail = `${ap}/${tr}`;
  }

  // 9) maxConcurrentTrades
  if (rand() < 0.3) {
    const mc = pick(rand, [3, 4, 5, 6, 8]);
    cfg.maxConcurrentTrades = mc;
    meta.mct = mc;
  }

  return { cfg, meta };
}

describe(
  "V5_PRO Phase C — random hyperparameter search",
  { timeout: 8 * 3600_000 },
  () => {
    it("explores config space targeting >=55% pass-rate", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5_PRO_PHASE_C START ${new Date().toISOString()}\n`,
      );

      const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO);
      log(`\nLoading 2h: ${symbols.join(", ")}`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        const raw = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data[s] = raw.filter((c) => c.isFinal);
        log(`  ${s.padEnd(10)} final=${data[s].length}`);
      }

      const baseR = evaluate(
        0,
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
        data,
        { name: "V5_PRO baseline" },
      );
      log(`\n${fmt(baseR)}`);

      const results: Result[] = [baseR];
      const rand = rng(20260428);

      let hits55 = 0;
      log(`\n========== ${TRIALS} TRIALS ==========`);
      for (let t = 1; t <= TRIALS; t++) {
        const { cfg, meta } = buildVariant(rand);
        try {
          const r = evaluate(t, cfg, data, meta);
          log(fmt(r));
          results.push(r);
          if (r.passRate >= 0.55 && r.med <= 4) {
            hits55++;
            log(`  🎯 55% TARGET HIT (${hits55}× total)`);
          }
        } catch (e) {
          log(`t${t} ERR ${String(e).slice(0, 80)}`);
        }
      }

      log(`\n========== TOP 15 BY PASS-RATE (med ≤ 4d) ==========`);
      const champs = results
        .filter((r) => r.med > 0 && r.med <= 4)
        .sort((a, b) => b.passRate - a.passRate);
      for (const r of champs.slice(0, 15)) log(fmt(r));

      log(
        `\n========== TOP 15 BY WINRATE (med ≤ 4d, pass ≥ baseline) ==========`,
      );
      const wrChamps = results
        .filter((r) => r.med > 0 && r.med <= 4 && r.passRate >= baseR.passRate)
        .sort((a, b) => b.winrate - a.winrate);
      for (const r of wrChamps.slice(0, 15)) log(fmt(r));

      log(`\n55% targets hit: ${hits55}`);

      writeFileSync(
        `${LOG_DIR}/V5_PRO_PHASE_C_${STAMP}.json`,
        JSON.stringify({ baseR, results }, null, 2),
      );

      expect(champs[0]?.passRate ?? 0).toBeGreaterThanOrEqual(baseR.passRate);
    });
  },
);
