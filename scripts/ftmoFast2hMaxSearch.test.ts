/**
 * Focused 2h max search for the FTMO-style challenge constraint:
 * target 8%, max 30d, live caps, pause after target, official median <= 4d.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/utils/indicators";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  type FtmoDaytrade24hConfig,
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT,
} from "../src/utils/ftmoDaytrade24h";

const LOG_DIR = "scripts/overnight_results";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = `${LOG_DIR}/FAST_2H_MAX_${STAMP}.log`;
const BARS_PER_DAY = 12;

interface Candidate {
  name: string;
  cfg: FtmoDaytrade24hConfig;
}

interface Result {
  name: string;
  windows: number;
  passes: number;
  passRate: number;
  tl: number;
  dl: number;
  timeout: number;
  med: number;
  p75: number;
  p90: number;
}

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
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

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function cloneCfg(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  return structuredClone(cfg);
}

function normalize(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = cloneCfg(cfg);
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

function sourceSymbols(cfg: FtmoDaytrade24hConfig): string[] {
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
  const commonSet = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => commonSet.has(c.openTime));
  return aligned;
}

const alignCache = new Map<string, Record<string, Candle[]>>();

function alignedFor(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
) {
  const symbols = sourceSymbols(cfg);
  const key = symbols.join("|");
  let aligned = alignCache.get(key);
  if (!aligned) {
    aligned = alignCommon(data, symbols);
    alignCache.set(key, aligned);
  }
  return { symbols, aligned };
}

function evaluate(
  name: string,
  rawCfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
): Result {
  const cfg = normalize(rawCfg);
  const { symbols, aligned } = alignedFor(cfg, data);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0;
  let passes = 0;
  let tl = 0;
  let dl = 0;
  let timeout = 0;
  const days: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) {
      passes++;
      days.push(
        res.passDay ?? (res.trades[res.trades.length - 1]?.day ?? 0) + 1,
      );
    } else if (res.reason === "total_loss") {
      tl++;
    } else if (res.reason === "daily_loss") {
      dl++;
    } else if (res.reason === "time") {
      timeout++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    name,
    windows,
    passes,
    passRate: windows > 0 ? passes / windows : 0,
    tl,
    dl,
    timeout,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p75: days[Math.floor(days.length * 0.75)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
  };
}

function fmt(r: Result) {
  return `${r.name.padEnd(44)} ${String(r.passes).padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}% TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)} TO=${String(r.timeout).padStart(3)} med=${String(r.med).padStart(2)}d p75=${String(r.p75).padStart(2)}d p90=${String(r.p90).padStart(2)}d`;
}

function withRisk(cfg: FtmoDaytrade24hConfig, riskFrac: number) {
  const c = cloneCfg(cfg);
  c.assets = c.assets.map((a) => ({ ...a, riskFrac }));
  return c;
}

function withHold(cfg: FtmoDaytrade24hConfig, holdBars: number) {
  const c = cloneCfg(cfg);
  c.holdBars = holdBars;
  c.assets = c.assets.map((a) => ({ ...a, holdBars }));
  return c;
}

function withUniformTp(cfg: FtmoDaytrade24hConfig, tpPct: number) {
  const c = cloneCfg(cfg);
  c.tpPct = tpPct;
  c.assets = c.assets.map((a) => ({ ...a, tpPct }));
  return c;
}

function withoutSource(cfg: FtmoDaytrade24hConfig, sourceSymbol: string) {
  const c = cloneCfg(cfg);
  c.assets = c.assets.filter(
    (a) => (a.sourceSymbol ?? a.symbol) !== sourceSymbol,
  );
  return c;
}

function hourVariants(seed: Candidate): Candidate[] {
  const base = normalize(seed.cfg);
  const hours = base.allowedHoursUtc ?? Array.from({ length: 24 }, (_, h) => h);
  const out: Candidate[] = [];
  for (const drop of hours) {
    const c = cloneCfg(base);
    c.allowedHoursUtc = hours.filter((h) => h !== drop);
    out.push({ name: `${seed.name} dropH${drop}`, cfg: c });
  }
  for (let add = 0; add < 24; add++) {
    if (hours.includes(add)) continue;
    const c = cloneCfg(base);
    c.allowedHoursUtc = [...hours, add].sort((a, b) => a - b);
    out.push({ name: `${seed.name} addH${add}`, cfg: c });
  }
  return out;
}

function randomVariant(r: () => number, trial: number): Candidate {
  const seed = pick(r, [
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
  ]);
  const cfg = normalize(seed);
  cfg.allowedHoursUtc = Array.from({ length: 24 }, (_, h) => h).filter(
    () => r() > 0.45,
  );
  if (cfg.allowedHoursUtc.length < 6)
    cfg.allowedHoursUtc = [2, 4, 8, 12, 18, 20];
  cfg.trailingStop = {
    activatePct: pick(r, [0.02, 0.025, 0.03, 0.04]),
    trailPct: pick(r, [0.001, 0.002, 0.005, 0.008]),
  };
  cfg.adxFilter = {
    period: pick(r, [10, 14, 20, 28]),
    minAdx: pick(r, [0, 5, 10, 12, 15]),
  };
  cfg.htfTrendFilter = {
    lookbackBars: pick(r, [12, 24, 48, 72]),
    apply: pick(r, ["long", "both"] as const),
    threshold: pick(r, [0, 0.01, 0.02, 0.04, 0.06]),
  };
  cfg.chandelierExit = {
    period: pick(r, [28, 56, 84, 168]),
    mult: pick(r, [1.5, 2, 2.28, 2.5, 3, 4]),
    minMoveR: pick(r, [0.25, 0.5, 0.75]),
  };
  cfg.choppinessFilter = {
    period: pick(r, [10, 14, 20, 28]),
    maxCi: pick(r, [66, 70, 72, 75, 80]),
  };
  cfg.lossStreakCooldown = {
    afterLosses: pick(r, [2, 3, 4]),
    cooldownBars: pick(r, [12, 24, 48, 72, 96, 144]),
  };
  cfg.volumeFilter =
    r() < 0.45
      ? {
          period: pick(r, [50, 75, 100, 150]),
          minRatio: pick(r, [0.5, 0.6, 0.75, 1]),
        }
      : undefined;
  cfg.crossAssetFilter =
    r() < 0.8
      ? {
          symbol: "BTCUSDT",
          emaFastPeriod: pick(r, [4, 6, 8, 10, 12]),
          emaSlowPeriod: pick(r, [12, 16, 24, 36, 48]),
          skipLongsIfSecondaryDowntrend: r() < 0.5,
          momentumBars: pick(r, [6, 12, 24, 48]),
          momSkipLongBelow: pick(r, [-0.04, -0.03, -0.02, -0.01, 0]),
        }
      : undefined;
  const risk = pick(r, [0.3, 0.35, 0.4]);
  const tp = pick(r, [0.055, 0.06, 0.065, 0.07, 0.075, 0.08]);
  const stop = pick(r, [0.035, 0.04, 0.045, 0.05]);
  const hold = pick(r, [120, 180, 240, 300, 360]);
  cfg.assets = cfg.assets
    .filter(() => r() > 0.08)
    .map((a) => ({
      ...a,
      riskFrac: risk,
      tpPct: r() < 0.65 ? tp : a.tpPct,
      stopPct: r() < 0.55 ? stop : a.stopPct,
      holdBars: r() < 0.45 ? hold : a.holdBars,
    }));
  if (cfg.assets.length < 5)
    cfg.assets = normalize(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11).assets;
  return { name: `trial-${String(trial).padStart(4, "0")}`, cfg };
}

describe("Fast 2h max search", { timeout: 24 * 3600_000 }, () => {
  it("searches for a stronger official-med<=4d 2h bot", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `FAST_2H_MAX START ${new Date().toISOString()}\n`);
    const seeds: Candidate[] = [
      ["V5", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5],
      ["V5_FASTMAX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX],
      ["V5_PRIME", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME],
      ["V5_PRIMEX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX],
      ["V6", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6],
      ["V8", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8],
      ["V10", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10],
      ["V11", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11],
      ["V12", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12],
      ["V13", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY],
      ["V14", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14],
      ["V15", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT],
    ].map(([name, cfg]) => ({ name, cfg })) as Candidate[];

    const symbols = [
      ...new Set(seeds.flatMap((s) => sourceSymbols(normalize(s.cfg)))),
    ].sort();
    const data: Record<string, Candle[]> = {};
    log(`Loading 2h: ${symbols.join(", ")}`);
    for (const s of symbols) {
      // AVAX is the limiting 2h symbol (~24.5k final candles), so 25k is enough
      // for the common aligned history and avoids long 30-page fetches on older pairs.
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 25000,
        maxPages: 30,
        signal: AbortSignal.timeout(180_000),
      });
      data[s] = raw.filter((c) => c.isFinal);
      log(`  ${s.padEnd(8)} final=${data[s].length}`);
    }

    const candidates: Candidate[] = [...seeds];
    for (const seed of seeds) {
      candidates.push(...hourVariants(seed));
      for (const risk of [0.3, 0.35, 0.4])
        candidates.push({
          name: `${seed.name} risk=${risk}`,
          cfg: withRisk(seed.cfg, risk),
        });
      for (const hold of [120, 180, 240, 300, 360])
        candidates.push({
          name: `${seed.name} hold=${hold}`,
          cfg: withHold(seed.cfg, hold),
        });
      for (const tp of [0.055, 0.06, 0.065, 0.07, 0.075, 0.08])
        candidates.push({
          name: `${seed.name} tp=${tp}`,
          cfg: withUniformTp(seed.cfg, tp),
        });
    }

    const r = rng(0xf254);
    for (let i = 0; i < 300; i++) candidates.push(randomVariant(r, i));

    const best: Result[] = [];
    log(`\nEvaluating ${candidates.length} candidates`);
    for (let i = 0; i < candidates.length; i++) {
      const row = evaluate(candidates[i].name, candidates[i].cfg, data);
      if (row.med > 0 && row.med <= 4) {
        best.push(row);
        best.sort(
          (a, b) => b.passRate - a.passRate || a.p90 - b.p90 || a.dl - b.dl,
        );
        best.length = Math.min(best.length, 30);
      }
      if ((i + 1) % 100 === 0)
        log(
          `${i + 1}/${candidates.length} best ${best[0] ? fmt(best[0]) : "none"}`,
        );
    }

    log("\n========== TOP MEDIAN <= 4D ==========");
    for (const row of best) log(fmt(row));
    writeFileSync(
      `${LOG_DIR}/FAST_2H_MAX_${STAMP}.json`,
      JSON.stringify(best, null, 2),
    );
    expect(best[0]?.passRate ?? 0).toBeGreaterThan(0);
  });
});
