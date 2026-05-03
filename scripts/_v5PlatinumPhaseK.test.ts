/**
 * Phase K — GA-style 200 random trials on V5_PLATINUM combining all dimensions.
 * Goal: lift step=1d pass-rate from 54.13% to ≥55% (high-N robust signal).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_PLAT_PHASE_K_${STAMP}.log`;
const TRIALS = 200;

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
  pass1: number;
  pass3: number;
  passes1: number;
  passes3: number;
  n1: number;
  n3: number;
  tl3: number;
  med3: number;
  wr3: number;
  meta: Record<string, unknown>;
}
function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  stepBars: number,
) {
  const c = normalize(cfg);
  const symbols = syms(c);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = c.maxDays * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
    totalT = 0,
    totalW = 0;
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
      totalT++;
      if (t.effPnl > 0) totalW++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    passRate: passes / windows,
    passes,
    windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalT > 0 ? totalW / totalT : 0,
  };
}
function fmt(r: Result): string {
  return `t${String(r.trial).padStart(3)} 1d=${(r.pass1 * 100).toFixed(2).padStart(6)}% (${r.passes1}/${r.n1}) | 3d=${(r.pass3 * 100).toFixed(2).padStart(6)}% (${r.passes3}/${r.n3}) | wr3=${(r.wr3 * 100).toFixed(2).padStart(6)}% TL3=${r.tl3} ${JSON.stringify(r.meta)}`;
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

const BASE_HOURS = [2, 4, 6, 8, 10, 12, 14, 18, 20, 22];

function buildVariant(rand: () => number): {
  cfg: FtmoDaytrade24hConfig;
  meta: Record<string, unknown>;
} {
  const meta: Record<string, unknown> = {};
  let cfg = structuredClone(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM);

  // 1) Global tp/sp shifts (additive on top of per-asset)
  if (rand() < 0.3) {
    const tpShift = pick(rand, [-0.005, 0, 0.005]);
    if (tpShift !== 0) {
      meta.tpShift = tpShift;
      cfg.assets = cfg.assets.map((a) => ({
        ...a,
        tpPct: Math.max(0.02, (a.tpPct ?? 0.04) + tpShift),
      }));
    }
  }

  // 2) hour-drop (1-3)
  if (rand() < 0.6) {
    const dropN = 1 + Math.floor(rand() * 3);
    const drops = new Set<number>();
    while (drops.size < dropN) drops.add(pick(rand, BASE_HOURS));
    cfg.allowedHoursUtc = BASE_HOURS.filter((h) => !drops.has(h));
    meta.dropHrs = [...drops];
  }

  // 3) atrStop
  if (rand() < 0.4) {
    const period = pick(rand, [14, 28]);
    const mult = pick(rand, [2, 3, 4]);
    cfg.atrStop = { period, stopMult: mult };
    meta.atr = `p${period}m${mult}`;
  }

  // 4) lossStreakCooldown
  if (rand() < 0.3) {
    const after = pick(rand, [2, 3]);
    const cd = pick(rand, [12, 24, 48, 96]);
    cfg.lossStreakCooldown = { afterLosses: after, cooldownBars: cd };
    meta.lsc = `${after}/${cd}`;
  }

  // 5) htfTrendFilter
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

  // 6) chandelierExit
  if (rand() < 0.25) {
    const period = pick(rand, [14, 28, 56]);
    const mult = pick(rand, [2, 3, 4]);
    cfg.chandelierExit = { period, mult, minMoveR: 0.5 };
    meta.chand = `p${period}m${mult}`;
  }

  // 7) breakEven
  if (rand() < 0.2) {
    const th = pick(rand, [0.02, 0.025, 0.03, 0.035]);
    cfg.breakEven = { threshold: th };
    meta.be = th;
  }

  // 8) maxConcurrentTrades
  if (rand() < 0.25) {
    cfg.maxConcurrentTrades = pick(rand, [4, 5, 6, 8, 10, 12]);
    meta.mct = cfg.maxConcurrentTrades;
  }

  // 9) holdBars sweep (uniform)
  if (rand() < 0.3) {
    const hb = pick(rand, [120, 180, 240, 300, 360, 480]);
    cfg.holdBars = hb;
    cfg.assets = cfg.assets.map((a) => ({ ...a, holdBars: hb }));
    meta.hb = hb;
  }

  // 10) trailingStop
  if (rand() < 0.2) {
    const ap = pick(rand, [0.02, 0.025, 0.03]);
    const tr = pick(rand, [0.005, 0.01, 0.015]);
    cfg.trailingStop = { activatePct: ap, trailPct: tr };
    meta.trail = `${ap}/${tr}`;
  }

  return { cfg, meta };
}

describe(
  "V5_PLATINUM Phase K — GA random search",
  { timeout: 8 * 3600_000 },
  () => {
    it("200 trials, optimize 1d step pass-rate", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5_PLAT_PHASE_K START ${new Date().toISOString()}\n`,
      );

      const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM);
      log(`\nLoading: ${symbols.join(", ")}`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        const raw = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data[s] = raw.filter((c) => c.isFinal);
      }

      const r1 = evaluate(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
        data,
        BARS_PER_DAY,
      );
      const r3 = evaluate(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
        data,
        3 * BARS_PER_DAY,
      );
      const baseline: Result = {
        trial: 0,
        pass1: r1.passRate,
        pass3: r3.passRate,
        passes1: r1.passes,
        passes3: r3.passes,
        n1: r1.windows,
        n3: r3.windows,
        tl3: r3.tl,
        med3: r3.med,
        wr3: r3.winrate,
        meta: { name: "baseline" },
      };
      log(fmt(baseline));

      const results: Result[] = [baseline];
      const rand = rng(20260429);

      log(`\n========== ${TRIALS} TRIALS ==========`);
      let hits1d55 = 0;
      for (let t = 1; t <= TRIALS; t++) {
        const { cfg, meta } = buildVariant(rand);
        try {
          const e1 = evaluate(cfg, data, BARS_PER_DAY);
          const e3 = evaluate(cfg, data, 3 * BARS_PER_DAY);
          const r: Result = {
            trial: t,
            pass1: e1.passRate,
            pass3: e3.passRate,
            passes1: e1.passes,
            passes3: e3.passes,
            n1: e1.windows,
            n3: e3.windows,
            tl3: e3.tl,
            med3: e3.med,
            wr3: e3.winrate,
            meta,
          };
          log(fmt(r));
          results.push(r);
          if (r.pass1 >= 0.55 && r.med3 <= 4) {
            hits1d55++;
            log(`  🎯 1d step ≥55% (#${hits1d55})`);
          }
        } catch (e) {
          log(`t${t} ERR ${String(e).slice(0, 80)}`);
        }
      }

      log(`\n========== TOP 15 BY 1d (med ≤ 4d) ==========`);
      const top1 = results
        .filter((r) => r.med3 > 0 && r.med3 <= 4)
        .sort((a, b) => b.pass1 - a.pass1);
      for (const r of top1.slice(0, 15)) log(fmt(r));

      log(`\n========== TOP 15 BY 3d (med ≤ 4d) ==========`);
      const top3 = results
        .filter((r) => r.med3 > 0 && r.med3 <= 4)
        .sort((a, b) => b.pass3 - a.pass3);
      for (const r of top3.slice(0, 15)) log(fmt(r));

      log(`\n1d-step ≥55% hits: ${hits1d55}`);

      writeFileSync(
        `${LOG_DIR}/V5_PLAT_PHASE_K_${STAMP}.json`,
        JSON.stringify(results, null, 2),
      );

      expect(top1[0]?.pass1 ?? 0).toBeGreaterThan(0);
    });
  },
);
