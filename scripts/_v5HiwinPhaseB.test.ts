/**
 * Phase B — Random Hyperparameter Search on V5_HIWIN.
 * 100 seeded random configs over (tpPct, stopPct, holdBars, hour-subsets,
 * atrStop, htfTrendFilter, lossStreakCooldown, breakEven).
 *
 * Goal: find any config that pushes pass-rate above V5_HIWIN baseline 49.85%
 * while keeping median <= 4d.
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
const LOG_FILE = `${LOG_DIR}/V5HIWIN_PHASE_B_${STAMP}.log`;
const TRIALS = 80;

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
  return `t${String(r.trial).padStart(3)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) winrate=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)} ${JSON.stringify(r.config)}`;
}

// mulberry32 seeded RNG
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

function buildVariant(
  trial: number,
  rand: () => number,
): { cfg: FtmoDaytrade24hConfig; meta: Record<string, unknown> } {
  const meta: Record<string, unknown> = {};
  let cfg = structuredClone(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN);

  // 1) tpPct grid
  const tp = pick(rand, [0.035, 0.04, 0.045, 0.05, 0.055]);
  meta.tp = tp;
  cfg.tpPct = tp;
  cfg.assets = cfg.assets.map((a) => ({ ...a, tpPct: tp }));

  // 2) stopPct (within liveCaps 5%)
  const sp = pick(rand, [0.04, 0.045, 0.05]);
  meta.sp = sp;
  cfg.stopPct = sp;
  cfg.assets = cfg.assets.map((a) => ({ ...a, stopPct: sp }));

  // 3) holdBars
  const hb = pick(rand, [120, 180, 240, 300, 360]);
  meta.hb = hb;
  cfg.holdBars = hb;
  cfg.assets = cfg.assets.map((a) => ({ ...a, holdBars: hb }));

  // 4) hour-filter — drop random subset
  if (rand() < 0.6) {
    const baseHrs = cfg.allowedHoursUtc ?? [];
    const dropN = Math.floor(rand() * 3);
    const dropped = new Set<number>();
    for (let i = 0; i < dropN; i++) {
      dropped.add(pick(rand, baseHrs));
    }
    cfg.allowedHoursUtc = baseHrs.filter((h) => !dropped.has(h));
    meta.hours = cfg.allowedHoursUtc;
  }

  // 5) atrStop (defensive)
  if (rand() < 0.4) {
    const period = pick(rand, [14, 28]);
    const mult = pick(rand, [2, 3, 4, 5]);
    cfg.atrStop = { period, stopMult: mult };
    meta.atrStop = `p${period}m${mult}`;
  }

  // 6) lossStreakCooldown
  if (rand() < 0.3) {
    const after = pick(rand, [2, 3]);
    const cd = pick(rand, [12, 24, 48]);
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

  // 8) breakEven (only if TP large enough)
  if (rand() < 0.2 && tp >= 0.045) {
    const beTh = pick(rand, [0.02, 0.025, 0.03]);
    cfg.breakEven = { threshold: beTh };
    meta.be = beTh;
  }

  return { cfg, meta };
}

describe(
  "V5_HIWIN Phase B — random hyperparameter search",
  { timeout: 8 * 3600_000 },
  () => {
    it("explores config space for >50% pass-rate", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5HIWIN_PHASE_B START ${new Date().toISOString()}\n`,
      );

      const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN);
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
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
        data,
        { name: "baseline" },
      );
      log(`\n${fmt(baseR)}`);

      const results: Result[] = [baseR];
      const rand = rng(20260428);

      log(`\n========== ${TRIALS} RANDOM TRIALS ==========`);
      for (let t = 1; t <= TRIALS; t++) {
        const { cfg, meta } = buildVariant(t, rand);
        try {
          const r = evaluate(t, cfg, data, meta);
          log(fmt(r));
          results.push(r);
          if (r.passRate >= 0.55 && r.med <= 4) {
            log(`\n🏆 PASS-RATE ≥55% HIT @ trial ${t}!`);
          }
        } catch (e) {
          log(`t${t} ERR ${String(e).slice(0, 80)}`);
        }
      }

      log(`\n========== TOP 10 BY PASS-RATE (med ≤ 4d) ==========`);
      const champs = results
        .filter((r) => r.med > 0 && r.med <= 4)
        .sort((a, b) => b.passRate - a.passRate);
      for (const r of champs.slice(0, 10)) log(fmt(r));

      writeFileSync(
        `${LOG_DIR}/V5HIWIN_PHASE_B_${STAMP}.json`,
        JSON.stringify({ baseR, results }, null, 2),
      );

      expect(champs[0]?.passRate ?? 0).toBeGreaterThan(0);
    });
  },
);
