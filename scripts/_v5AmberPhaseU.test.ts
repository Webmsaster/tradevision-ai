/**
 * Phase U — GA second-pass on V5_AMBER with different seed.
 * Tests if Phase S/T plateau is final or if more lift is possible.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_AMBER_PHASE_U_${STAMP}.log`;
const TRIALS = 100;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
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
  trial: number,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  meta: Record<string, unknown>,
): Result {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const compute = (stepBars: number) => {
    let windows = 0,
      passes = 0,
      tl = 0,
      totalT = 0,
      totalW = 0;
    const days: number[] = [];
    for (let start = 0; start + winBars <= n; start += stepBars) {
      const slice: Record<string, Candle[]> = {};
      for (const s of symbols)
        slice[s] = aligned[s].slice(start, start + winBars);
      const res = runFtmoDaytrade24h(slice, cfg);
      windows++;
      if (res.passed) {
        passes++;
        days.push(res.passDay ?? 0);
      } else if (res.reason === "total_loss") tl++;
      for (const t of res.trades) {
        totalT++;
        if (t.effPnl > 0) totalW++;
      }
    }
    days.sort((a, b) => a - b);
    return {
      passes,
      windows,
      tl,
      med: days[Math.floor(days.length * 0.5)] ?? 0,
      wr: totalT > 0 ? totalW / totalT : 0,
    };
  };
  const r1 = compute(BARS_PER_DAY);
  const r3 = compute(3 * BARS_PER_DAY);
  return {
    trial,
    pass1: r1.passes / r1.windows,
    pass3: r3.passes / r3.windows,
    passes1: r1.passes,
    passes3: r3.passes,
    n1: r1.windows,
    n3: r3.windows,
    tl3: r3.tl,
    med3: r3.med,
    wr3: r3.wr,
    meta,
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
const HOURS = [4, 6, 8, 10, 14, 18, 20, 22];

function buildVariant(rand: () => number): {
  cfg: FtmoDaytrade24hConfig;
  meta: Record<string, unknown>;
} {
  const meta: Record<string, unknown> = {};
  let cfg = structuredClone(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER);

  if (rand() < 0.3) {
    const dropN = 1 + Math.floor(rand() * 2);
    const drops = new Set<number>();
    while (drops.size < dropN) drops.add(pick(rand, HOURS));
    cfg.allowedHoursUtc = HOURS.filter((h) => !drops.has(h));
    meta.dropHrs = [...drops];
  }
  if (rand() < 0.4) {
    cfg.atrStop = {
      period: pick(rand, [14, 28, 56]),
      stopMult: pick(rand, [2, 3, 4]),
    };
    meta.atr = `p${cfg.atrStop.period}m${cfg.atrStop.stopMult}`;
  }
  if (rand() < 0.4) {
    cfg.chandelierExit = {
      period: pick(rand, [14, 28, 56]),
      mult: pick(rand, [2, 3, 4]),
      minMoveR: 0.5,
    };
    meta.chand = `p${cfg.chandelierExit.period}m${cfg.chandelierExit.mult}`;
  }
  if (rand() < 0.3) {
    cfg.lossStreakCooldown = {
      afterLosses: pick(rand, [2, 3]),
      cooldownBars: pick(rand, [12, 24, 48, 96]),
    };
    meta.lsc = `${cfg.lossStreakCooldown.afterLosses}/${cfg.lossStreakCooldown.cooldownBars}`;
  }
  if (rand() < 0.3) {
    cfg.htfTrendFilter = {
      lookbackBars: pick(rand, [12, 24, 48]),
      apply: pick(rand, ["short", "long", "both"]) as "short" | "long" | "both",
      threshold: pick(rand, [0, 0.02, 0.05]),
    };
    meta.htf = `${cfg.htfTrendFilter.lookbackBars}/${cfg.htfTrendFilter.apply}/${cfg.htfTrendFilter.threshold}`;
  }
  if (rand() < 0.3) {
    cfg.breakEven = { threshold: pick(rand, [0.015, 0.02, 0.025, 0.03]) };
    meta.be = cfg.breakEven.threshold;
  }
  if (rand() < 0.3) {
    cfg.maxConcurrentTrades = pick(rand, [6, 8, 10, 12, 15]);
    meta.mct = cfg.maxConcurrentTrades;
  }
  if (rand() < 0.3) {
    const hb = pick(rand, [120, 180, 240, 300, 360]);
    cfg.holdBars = hb;
    cfg.assets = cfg.assets.map((a) => ({ ...a, holdBars: hb }));
    meta.hb = hb;
  }
  if (rand() < 0.3) {
    const tpShift = pick(rand, [-0.005, 0.005]);
    meta.tpShift = tpShift;
    cfg.assets = cfg.assets.map((a) => ({
      ...a,
      tpPct: Math.max(0.015, (a.tpPct ?? 0.02) + tpShift),
    }));
  }
  return { cfg, meta };
}

describe("V5_AMBER Phase U", { timeout: 6 * 3600_000 }, () => {
  it("GA second-pass random search", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `V5_AMBER_PHASE_U START ${new Date().toISOString()}\n`,
    );

    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER);
    log(`\nLoading 30m: ${symbols.join(", ")}`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "30m",
        targetCount: 100000,
        maxPages: 120,
      });
      data[s] = raw.filter((c) => c.isFinal);
    }

    const baseEval = evaluate(
      0,
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
      data,
      { name: "baseline" },
    );
    log(fmt(baseEval));

    const results: Result[] = [baseEval];
    const rand = rng(20260430);

    log(`\n========== ${TRIALS} TRIALS ==========`);
    for (let t = 1; t <= TRIALS; t++) {
      const { cfg, meta } = buildVariant(rand);
      try {
        const r = evaluate(t, cfg, data, meta);
        log(fmt(r));
        results.push(r);
      } catch (e) {
        log(`t${t} ERR ${String(e).slice(0, 80)}`);
      }
    }

    log(`\n========== TOP 15 BY 1d (med ≤ 4d) ==========`);
    const top1 = results
      .filter((r) => r.med3 > 0 && r.med3 <= 4)
      .sort((a, b) => b.pass1 - a.pass1);
    for (const r of top1.slice(0, 15)) log(fmt(r));

    log(`\n========== TOP 15 BY 3d ==========`);
    const top3 = results
      .filter((r) => r.med3 > 0 && r.med3 <= 4)
      .sort((a, b) => b.pass3 - a.pass3);
    for (const r of top3.slice(0, 15)) log(fmt(r));

    writeFileSync(
      `${LOG_DIR}/V5_AMBER_PHASE_U_${STAMP}.json`,
      JSON.stringify(results, null, 2),
    );
    expect(top1[0]?.pass1 ?? 0).toBeGreaterThan(0);
  });
});
