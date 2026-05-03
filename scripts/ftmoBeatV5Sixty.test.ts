/**
 * Beat V5 / 60% pass-rate hunt.
 *
 * Goal: compare every credible live-capped bot against V5, then try
 * deterministic pass-rate-first variants. Median speed is reported but not
 * optimized. Variants with maxDays > 30 are marked as relaxed-time candidates.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const LOG_DIR = "scripts/overnight_results";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = `${LOG_DIR}/BEAT_V5_60_${STAMP}.log`;

const BARS_PER_DAY: Record<FtmoDaytrade24hConfig["timeframe"], number> = {
  "5m": 288,
  "15m": 96,
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "4h": 6,
};

interface Candidate {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  tf?: FtmoDaytrade24hConfig["timeframe"];
  family: "baseline" | "variant";
}

interface BatchResult {
  name: string;
  family: "baseline" | "variant";
  timeframe: FtmoDaytrade24hConfig["timeframe"];
  targetPct: number;
  maxDays: number;
  windows: number;
  passes: number;
  passRate: number;
  tl: number;
  dl: number;
  timeout: number;
  insufficient: number;
  med: number;
  p90: number;
  years: number;
  first: string;
  last: string;
}

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
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
  for (const s of symbols) {
    aligned[s] = data[s].filter((c) => commonSet.has(c.openTime));
  }
  return aligned;
}

function evalCfg(
  candidate: Candidate,
  dataByTf: Record<string, Record<string, Candle[]>>,
): BatchResult {
  const name = candidate.name;
  const tf = candidate.tf ?? candidate.cfg.timeframe;
  const cfg = { ...candidate.cfg, timeframe: tf };
  const family = candidate.family;
  const symbols = sourceSymbols(cfg);
  const aligned = alignCommon(dataByTf[tf], symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const barsPerDay = BARS_PER_DAY[tf];
  const winBars = cfg.maxDays * barsPerDay;
  const stepDays = cfg.maxDays >= 60 ? 6 : 3;
  const stepBars = stepDays * barsPerDay;

  let passes = 0;
  let windows = 0;
  let tl = 0;
  let dl = 0;
  let timeout = 0;
  let insufficient = 0;
  const passDays: number[] = [];

  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols) {
      slice[s] = aligned[s].slice(start, start + winBars);
    }
    const r = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (r.passed) {
      passes++;
      passDays.push(r.passDay ?? (r.trades[r.trades.length - 1]?.day ?? 0) + 1);
    } else if (r.reason === "total_loss") {
      tl++;
    } else if (r.reason === "daily_loss") {
      dl++;
    } else if (r.reason === "time") {
      timeout++;
    } else if (r.reason === "insufficient_days") {
      insufficient++;
    }
  }

  passDays.sort((a, b) => a - b);
  const first = new Date(aligned[symbols[0]][0]?.openTime ?? 0).toISOString();
  const last = new Date(
    aligned[symbols[0]][n - 1]?.openTime ?? 0,
  ).toISOString();
  return {
    name,
    family,
    timeframe: tf,
    targetPct: cfg.profitTarget,
    maxDays: cfg.maxDays,
    windows,
    passes,
    passRate: windows > 0 ? passes / windows : 0,
    tl,
    dl,
    timeout,
    insufficient,
    med: passDays[Math.floor(passDays.length * 0.5)] ?? 0,
    p90: passDays[Math.floor(passDays.length * 0.9)] ?? 0,
    years: n / barsPerDay / 365,
    first,
    last,
  };
}

function fmt(r: BatchResult) {
  const rules = r.maxDays > 30 ? "relaxed" : "30d";
  return (
    `${r.name.padEnd(34)} ${r.timeframe.padStart(3)} ${rules.padEnd(7)} target=${(r.targetPct * 100).toFixed(0).padStart(2)}% ` +
    `${String(r.passes).padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}% ` +
    `TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)} TO=${String(r.timeout).padStart(3)} med=${String(r.med).padStart(2)}d p90=${String(r.p90).padStart(2)}d years=${r.years.toFixed(2)}`
  );
}

function setRisk(cfg: FtmoDaytrade24hConfig, riskFrac: number) {
  const c = cloneCfg(cfg);
  c.assets = c.assets.map((a) => ({ ...a, riskFrac }));
  return c;
}

function setMaxDays(cfg: FtmoDaytrade24hConfig, maxDays: number) {
  const c = cloneCfg(cfg);
  c.maxDays = maxDays;
  return c;
}

function setHoldScale(cfg: FtmoDaytrade24hConfig, scale: number) {
  const c = cloneCfg(cfg);
  c.holdBars = Math.max(1, Math.round(c.holdBars * scale));
  c.assets = c.assets.map((a) => ({
    ...a,
    holdBars:
      a.holdBars === undefined
        ? a.holdBars
        : Math.max(1, Math.round(a.holdBars * scale)),
  }));
  return c;
}

function withAdaptive(cfg: FtmoDaytrade24hConfig) {
  const c = cloneCfg(cfg);
  c.adaptiveSizing = [
    { equityAbove: -1, factor: 0.55 },
    { equityAbove: 0.02, factor: 0.85 },
    { equityAbove: 0.05, factor: 1.0 },
  ];
  return c;
}

function withLossGuard(cfg: FtmoDaytrade24hConfig) {
  const c = cloneCfg(cfg);
  c.drawdownShield = { belowEquity: -0.015, factor: 0.35 };
  c.peakDrawdownThrottle = { fromPeak: 0.02, factor: 0.35 };
  c.lossStreakCooldown = {
    afterLosses: 1,
    cooldownBars: Math.max(12, Math.round(c.holdBars / 6)),
  };
  return c;
}

function makeVariants(seed: Candidate): Candidate[] {
  const out: Candidate[] = [];
  const risks = [0.2, 0.25, 0.3, 0.35, 0.4];
  const maxDays = [30, 45, 60, 90];
  const holdScales = [1, 1.5, 2];
  for (const risk of risks) {
    for (const days of maxDays) {
      const base = setMaxDays(setRisk(seed.cfg, risk), days);
      out.push({
        name: `${seed.name} risk=${risk} d=${days}`,
        cfg: base,
        tf: seed.tf,
        family: "variant",
      });
      out.push({
        name: `${seed.name} guard risk=${risk} d=${days}`,
        cfg: withLossGuard(base),
        tf: seed.tf,
        family: "variant",
      });
      out.push({
        name: `${seed.name} adaptive risk=${risk} d=${days}`,
        cfg: withAdaptive(base),
        tf: seed.tf,
        family: "variant",
      });
    }
  }
  for (const scale of holdScales) {
    const c = setHoldScale(seed.cfg, scale);
    out.push({
      name: `${seed.name} holdx${scale}`,
      cfg: c,
      tf: seed.tf,
      family: "variant",
    });
  }
  return out;
}

describe("Beat V5 / 60% pass-rate hunt", { timeout: 24 * 3600_000 }, () => {
  it("searches credible live-capped candidates", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `BEAT_V5_60 START ${new Date().toISOString()}\n`);

    const baselines: Candidate[] = [
      {
        name: "V5",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        family: "baseline",
      },
      {
        name: "V5_STEP2",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2,
        family: "baseline",
      },
      {
        name: "V5_PRIME",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
        family: "baseline",
      },
      {
        name: "V5_PRIMEX",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        family: "baseline",
      },
      {
        name: "V5_NOVA",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
        family: "baseline",
      },
      {
        name: "V5_TITAN_REAL",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        family: "baseline",
      },
      {
        name: "V6",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
        family: "baseline",
      },
      {
        name: "V7",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7,
        family: "baseline",
      },
      {
        name: "V8",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
        family: "baseline",
      },
      {
        name: "V9",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
        family: "baseline",
      },
      {
        name: "V10",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
        family: "baseline",
      },
      {
        name: "V11",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
        family: "baseline",
      },
      {
        name: "V12",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
        family: "baseline",
      },
      {
        name: "V13_RISKY",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
        family: "baseline",
      },
      {
        name: "V14",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
        family: "baseline",
      },
      {
        name: "V15_RECENT",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT,
        family: "baseline",
      },
      {
        name: "LIVE_5M_V1",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V1,
        tf: "5m",
        family: "baseline",
      },
      {
        name: "LIVE_5M_V2",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V2,
        tf: "5m",
        family: "baseline",
      },
      {
        name: "LIVE_5M_V3",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
        tf: "5m",
        family: "baseline",
      },
      {
        name: "LIVE_15M_V1",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
        tf: "15m",
        family: "baseline",
      },
      {
        name: "LIVE_15M_V2",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
        tf: "15m",
        family: "baseline",
      },
      {
        name: "LIVE_15M_V3",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
        tf: "15m",
        family: "baseline",
      },
      {
        name: "LIVE_30M_V1",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1,
        tf: "30m",
        family: "baseline",
      },
      {
        name: "LIVE_30M_V2",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
        tf: "30m",
        family: "baseline",
      },
      {
        name: "LIVE_1H_V1",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
        tf: "1h",
        family: "baseline",
      },
      {
        name: "LIVE_1H_V2",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
        tf: "1h",
        family: "baseline",
      },
      {
        name: "LIVE_2H_V1",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
        tf: "2h",
        family: "baseline",
      },
      {
        name: "LIVE_2H_V2",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2,
        tf: "2h",
        family: "baseline",
      },
      {
        name: "LIVE_4H_V1",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1,
        tf: "4h",
        family: "baseline",
      },
      {
        name: "LIVE_4H_V2",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2,
        tf: "4h",
        family: "baseline",
      },
    ];

    const byTfSymbols: Record<string, Set<string>> = {};
    for (const c of baselines) {
      const tf = c.tf ?? c.cfg.timeframe;
      byTfSymbols[tf] ??= new Set<string>();
      for (const s of sourceSymbols(c.cfg)) byTfSymbols[tf].add(s);
    }

    const dataByTf: Record<string, Record<string, Candle[]>> = {};
    for (const [tf, symbols] of Object.entries(byTfSymbols)) {
      dataByTf[tf] = {};
      log(`\nLoading ${tf}: ${[...symbols].join(", ")}`);
      for (const sym of [...symbols].sort()) {
        const raw = await loadBinanceHistory({
          symbol: sym,
          timeframe: tf as FtmoDaytrade24hConfig["timeframe"],
          targetCount: 30000,
          maxPages: 40,
        });
        const finalOnly = raw.filter((c) => c.isFinal);
        dataByTf[tf][sym] = finalOnly;
        log(
          `  ${sym.padEnd(8)} raw=${raw.length} final=${finalOnly.length} first=${new Date(finalOnly[0]?.openTime ?? 0).toISOString()} last=${new Date(finalOnly.at(-1)?.openTime ?? 0).toISOString()}`,
        );
      }
    }

    log("\n========== BASELINE CANDIDATES ==========");
    const baselineResults = baselines.map((c) => evalCfg(c, dataByTf));
    baselineResults.sort((a, b) => b.passRate - a.passRate || a.tl - b.tl);
    for (const r of baselineResults) log(fmt(r));

    const seeds = baselines.filter((c) =>
      [
        "V5",
        "V5_STEP2",
        "V5_PRIMEX",
        "V6",
        "LIVE_1H_V2",
        "LIVE_2H_V2",
        "LIVE_4H_V2",
        "LIVE_15M_V3",
        "LIVE_5M_V3",
      ].includes(c.name),
    );
    const variants = seeds.flatMap(makeVariants);
    log(`\n========== VARIANT SWEEP (${variants.length}) ==========`);
    const variantResults: BatchResult[] = [];
    for (const v of variants) {
      const r = evalCfg(v, dataByTf);
      variantResults.push(r);
    }
    variantResults.sort((a, b) => b.passRate - a.passRate || a.tl - b.tl);
    for (const r of variantResults.slice(0, 40)) log(fmt(r));

    const all = [...baselineResults, ...variantResults].sort(
      (a, b) => b.passRate - a.passRate || a.tl - b.tl,
    );
    log("\n========== BEST OVERALL ==========");
    for (const r of all.slice(0, 20)) log(fmt(r));

    const sixty = all.filter((r) => r.passRate >= 0.6);
    if (sixty.length > 0) {
      log("\n========== >=60% CANDIDATES ==========");
      for (const r of sixty.slice(0, 20)) log(fmt(r));
    } else {
      log("\nNo candidate reached 60% in this run.");
    }

    writeFileSync(
      `${LOG_DIR}/BEAT_V5_60_${STAMP}.json`,
      JSON.stringify({ best: all.slice(0, 20), sixty }, null, 2),
    );
    expect(all[0].passRate).toBeGreaterThan(0);
  });
});
