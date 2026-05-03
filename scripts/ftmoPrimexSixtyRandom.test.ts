/**
 * Focused V5_PRIMEX pass-rate search.
 *
 * Searches only robust 2h full-history candidates. Target stays 8%; maxDays is
 * relaxed because this run explicitly ignores pass speed.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const LOG_DIR = "scripts/overnight_results";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = `${LOG_DIR}/PRIMEX_60_RANDOM_${STAMP}.log`;
const BARS_PER_DAY = 12;

interface Result {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  windows: number;
  passes: number;
  passRate: number;
  tl: number;
  dl: number;
  timeout: number;
  med: number;
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

function maybe<T>(r: () => number, p: number, value: () => T): T | undefined {
  return r() < p ? value() : undefined;
}

function cloneCfg(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  return structuredClone(cfg);
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

function evaluate(
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
): Result {
  const symbols = sourceSymbols(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 6 * BARS_PER_DAY;
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
    cfg,
    windows,
    passes,
    passRate: windows > 0 ? passes / windows : 0,
    tl,
    dl,
    timeout,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
  };
}

function fmt(r: Result) {
  return `${r.name.padEnd(42)} ${String(r.passes).padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}% TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)} TO=${String(r.timeout).padStart(3)} med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d`;
}

function withMaxDays(
  cfg: FtmoDaytrade24hConfig,
  maxDays: number,
): FtmoDaytrade24hConfig {
  const c = cloneCfg(cfg);
  c.maxDays = maxDays;
  return c;
}

function withRisk(
  cfg: FtmoDaytrade24hConfig,
  riskFrac: number,
): FtmoDaytrade24hConfig {
  const c = cloneCfg(cfg);
  c.assets = c.assets.map((a) => ({ ...a, riskFrac }));
  return c;
}

function withLossGuard(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = cloneCfg(cfg);
  c.drawdownShield = { belowEquity: -0.015, factor: 0.35 };
  c.peakDrawdownThrottle = { fromPeak: 0.02, factor: 0.35 };
  c.lossStreakCooldown = {
    afterLosses: 1,
    cooldownBars: Math.max(12, Math.round(c.holdBars / 6)),
  };
  return c;
}

function deterministicPrimexCandidates(): Array<{
  name: string;
  cfg: FtmoDaytrade24hConfig;
}> {
  const days = [30, 45, 60, 90, 120, 180, 240, 365];
  const risks = [0.25, 0.3, 0.35, 0.4];
  const out: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];
  for (const d of days) {
    out.push({
      name: `PRIMEX base d${d}`,
      cfg: withMaxDays(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX, d),
    });
    for (const risk of risks) {
      const cfg = withMaxDays(
        withRisk(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX, risk),
        d,
      );
      out.push({ name: `PRIMEX risk=${risk} d${d}`, cfg });
      out.push({
        name: `PRIMEX guard risk=${risk} d${d}`,
        cfg: withLossGuard(cfg),
      });
    }
  }
  return out;
}

function randomVariant(r: () => number, trial: number): FtmoDaytrade24hConfig {
  const seed = pick(r, [
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
    FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
  ]);
  const cfg = cloneCfg(seed);
  cfg.timeframe = "2h";
  cfg.profitTarget = 0.08;
  cfg.maxDays = pick(r, [60, 90, 120, 180]);
  cfg.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  cfg.maxConcurrentTrades = pick(r, [2, 3, 4, 6, 9, 12]);
  cfg.trailingStop = maybe(r, 0.85, () => ({
    activatePct: pick(r, [0.015, 0.02, 0.025, 0.03, 0.04]),
    trailPct: pick(r, [0.001, 0.002, 0.003, 0.005, 0.008]),
  }));
  cfg.breakEven = maybe(r, 0.55, () => ({
    threshold: pick(r, [0.015, 0.02, 0.025, 0.03, 0.04]),
  }));
  cfg.adxFilter = maybe(r, 0.7, () => ({
    period: pick(r, [10, 14, 20, 28]),
    minAdx: pick(r, [0, 5, 10, 12, 15, 20]),
  }));
  cfg.chandelierExit = maybe(r, 0.7, () => ({
    period: pick(r, [28, 56, 84, 168]),
    mult: pick(r, [1.5, 2, 2.5, 3, 4]),
    minMoveR: pick(r, [0.25, 0.5, 0.75]),
  }));
  cfg.choppinessFilter = maybe(r, 0.45, () => ({
    period: pick(r, [10, 14, 20, 28]),
    maxCi: pick(r, [60, 66, 70, 72, 75, 80]),
  }));
  cfg.lossStreakCooldown = maybe(r, 0.65, () => ({
    afterLosses: pick(r, [1, 2, 3, 4]),
    cooldownBars: pick(r, [12, 24, 48, 72, 96, 160]),
  }));
  cfg.momentumRanking = maybe(r, 0.55, () => ({
    lookbackBars: pick(r, [6, 12, 24, 48]),
    topN: pick(r, [4, 5, 6, 7, 8, 9]),
  }));
  cfg.htfTrendFilter = maybe(r, 0.5, () => ({
    lookbackBars: pick(r, [12, 24, 48, 72]),
    apply: pick(r, ["long", "both"] as const),
    threshold: pick(r, [0, 0.01, 0.02, 0.04, 0.06]),
  }));
  cfg.crossAssetFilter = maybe(r, 0.45, () => ({
    symbol: "BTCUSDT",
    emaFastPeriod: pick(r, [4, 6, 8, 10, 12]),
    emaSlowPeriod: pick(r, [12, 16, 24, 36, 48]),
    skipLongsIfSecondaryDowntrend: r() < 0.5,
    momentumBars: pick(r, [6, 12, 24, 48]),
    momSkipLongBelow: pick(r, [-0.04, -0.03, -0.02, -0.01, 0]),
  }));
  cfg.allowedHoursUtc = Array.from({ length: 24 }, (_, h) => h).filter(
    () => r() > 0.25,
  );
  if (cfg.allowedHoursUtc.length < 6)
    cfg.allowedHoursUtc = [0, 4, 8, 12, 16, 20];

  const risk = pick(r, [0.25, 0.3, 0.35, 0.4]);
  const tp = pick(r, [0.05, 0.06, 0.07, 0.08, 0.09]);
  const stop = pick(r, [0.03, 0.04, 0.05]);
  const hold = pick(r, [120, 180, 240, 300, 360, 480, 720]);
  cfg.assets = cfg.assets
    .filter(() => r() > 0.12)
    .map((a) => ({
      ...a,
      riskFrac: risk,
      tpPct: r() < 0.7 ? tp : a.tpPct,
      stopPct: r() < 0.7 ? stop : a.stopPct,
      holdBars: r() < 0.7 ? hold : a.holdBars,
    }));
  if (cfg.assets.length < 4)
    cfg.assets = cloneCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX).assets;

  // Keep names unique when repeated variants are serialized in logs.
  cfg.maxTotalTrades =
    trial % 5 === 0 ? pick(r, [20, 30, 40, 60]) : cfg.maxTotalTrades;
  return cfg;
}

describe("Focused V5_PRIMEX 60% search", { timeout: 24 * 3600_000 }, () => {
  it("runs deterministic random search", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `PRIMEX_60_RANDOM START ${new Date().toISOString()}\n`,
    );

    const symbols = [
      ...new Set([
        ...sourceSymbols(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5),
        ...sourceSymbols(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX),
        "BTCUSDT",
      ]),
    ].sort();
    const data: Record<string, Candle[]> = {};
    log(`Loading 2h: ${symbols.join(", ")}`);
    for (const s of symbols) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      data[s] = raw.filter((c) => c.isFinal);
      log(`  ${s.padEnd(8)} final=${data[s].length}`);
    }

    const baselines = [
      evaluate("V5 d30", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, data),
      evaluate(
        "V5_PRIMEX d30",
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        data,
      ),
      evaluate(
        "V5_PRIMEX d90",
        {
          ...cloneCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX),
          maxDays: 90,
        },
        data,
      ),
    ];
    log("\n========== BASELINES ==========");
    for (const b of baselines) log(fmt(b));

    const deterministic = deterministicPrimexCandidates()
      .map((c) => evaluate(c.name, c.cfg, data))
      .sort((a, b) => b.passRate - a.passRate || a.dl - b.dl);
    log("\n========== DETERMINISTIC PRIMEX TIME/RISK SWEEP ==========");
    for (const row of deterministic.slice(0, 30)) log(fmt(row));

    const r = rng(0x6055);
    const best: Result[] = [...baselines, ...deterministic];
    best.sort((a, b) => b.passRate - a.passRate || a.tl - b.tl);
    best.length = Math.min(best.length, 25);
    const trials = 1200;
    log(`\n========== RANDOM SEARCH (${trials}) ==========`);
    for (let i = 0; i < trials; i++) {
      const cfg = randomVariant(r, i);
      const res = evaluate(
        `trial-${String(i).padStart(4, "0")} d${cfg.maxDays}`,
        cfg,
        data,
      );
      best.push(res);
      best.sort((a, b) => b.passRate - a.passRate || a.tl - b.tl);
      best.length = Math.min(best.length, 25);
      if ((i + 1) % 100 === 0) log(`${i + 1}/${trials} best ${fmt(best[0])}`);
    }

    log("\n========== TOP 25 ==========");
    for (const row of best) log(fmt(row));
    const sixty = best.filter((row) => row.passRate >= 0.6);
    if (sixty.length === 0) log("\nNo robust 2h candidate reached 60%.");
    writeFileSync(
      `${LOG_DIR}/PRIMEX_60_RANDOM_${STAMP}.json`,
      JSON.stringify(
        {
          top: best.map(({ cfg: _cfg, ...rest }) => rest),
          sixty: sixty.map(({ cfg: _cfg, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
    expect(best[0].passRate).toBeGreaterThan(0);
  });
});
