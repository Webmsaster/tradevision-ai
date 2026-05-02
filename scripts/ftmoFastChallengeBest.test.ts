/**
 * Fast challenge selector.
 *
 * Finds the best live-capped Step-1 bot with median pass day <= 4.
 * This intentionally re-tests older high-pass configs under today's live caps
 * instead of trusting stale comments from no-cap/old-engine sweeps.
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
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
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
  FTMO_DAYTRADE_24H_CONFIG_V231,
  FTMO_DAYTRADE_24H_CONFIG_V234,
  FTMO_DAYTRADE_24H_CONFIG_V236,
  FTMO_DAYTRADE_24H_CONFIG_V236_FAST,
  FTMO_DAYTRADE_24H_CONFIG_V236_2D,
  FTMO_DAYTRADE_24H_CONFIG_V238,
  FTMO_DAYTRADE_24H_CONFIG_V239,
  FTMO_DAYTRADE_24H_CONFIG_V240,
  FTMO_DAYTRADE_24H_CONFIG_V241,
  FTMO_DAYTRADE_24H_CONFIG_V242,
  FTMO_DAYTRADE_24H_CONFIG_V243,
  FTMO_DAYTRADE_24H_CONFIG_V244,
  FTMO_DAYTRADE_24H_CONFIG_V245,
  FTMO_DAYTRADE_24H_CONFIG_V246,
  FTMO_DAYTRADE_24H_CONFIG_V247,
  FTMO_DAYTRADE_24H_CONFIG_V248,
  FTMO_DAYTRADE_24H_CONFIG_V249,
  FTMO_DAYTRADE_24H_CONFIG_V250,
  FTMO_DAYTRADE_24H_CONFIG_V251,
  FTMO_DAYTRADE_24H_CONFIG_V251_FAST,
  FTMO_DAYTRADE_24H_CONFIG_V252,
  FTMO_DAYTRADE_24H_CONFIG_V253,
  FTMO_DAYTRADE_24H_CONFIG_V254,
  FTMO_DAYTRADE_24H_CONFIG_V255,
  FTMO_DAYTRADE_24H_CONFIG_V256,
  FTMO_DAYTRADE_24H_CONFIG_V257,
  FTMO_DAYTRADE_24H_CONFIG_V258,
  FTMO_DAYTRADE_24H_CONFIG_V259,
  FTMO_DAYTRADE_24H_CONFIG_V260,
  FTMO_DAYTRADE_24H_CONFIG_V261,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2,
} from "../src/utils/ftmoDaytrade24h";

const LOG_DIR = "scripts/overnight_results";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = `${LOG_DIR}/FAST_CHALLENGE_BEST_${STAMP}.log`;

const BARS_PER_DAY: Record<FtmoDaytrade24hConfig["timeframe"], number> = {
  "5m": 288,
  "15m": 96,
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "4h": 6,
};

const LOAD_PLAN: Record<
  FtmoDaytrade24hConfig["timeframe"],
  { targetCount: number; maxPages: number }
> = {
  "5m": { targetCount: 30000, maxPages: 40 },
  "15m": { targetCount: 30000, maxPages: 40 },
  "30m": { targetCount: 100000, maxPages: 120 },
  "1h": { targetCount: 50000, maxPages: 60 },
  "2h": { targetCount: 30000, maxPages: 40 },
  "4h": { targetCount: 30000, maxPages: 40 },
};

interface Candidate {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  tf: FtmoDaytrade24hConfig["timeframe"];
}

interface Result {
  name: string;
  tf: FtmoDaytrade24hConfig["timeframe"];
  years: number;
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

function normalizeForChallenge(
  cfg: FtmoDaytrade24hConfig,
  tf: FtmoDaytrade24hConfig["timeframe"],
) {
  const c = cloneCfg(cfg);
  c.timeframe = tf;
  c.profitTarget = 0.08;
  c.maxDailyLoss = 0.05;
  c.maxTotalLoss = 0.1;
  c.minTradingDays = 4;
  c.maxDays = 30;
  c.pauseAtTargetReached = true;
  c.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  return c;
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
  candidate: Candidate,
  dataByTf: Record<string, Record<string, Candle[]>>,
): Result {
  const cfg = normalizeForChallenge(candidate.cfg, candidate.tf);
  const symbols = sourceSymbols(cfg);
  const aligned = alignCommon(dataByTf[candidate.tf], symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const barsPerDay = BARS_PER_DAY[candidate.tf];
  const winBars = cfg.maxDays * barsPerDay;
  const stepBars = 3 * barsPerDay;
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
    name: candidate.name,
    tf: candidate.tf,
    years: n / barsPerDay / 365,
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
  return `${r.name.padEnd(28)} ${r.tf.padStart(3)} ${String(r.passes).padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}% TL=${String(r.tl).padStart(3)} DL=${String(r.dl).padStart(3)} TO=${String(r.timeout).padStart(3)} med=${String(r.med).padStart(2)}d p75=${String(r.p75).padStart(2)}d p90=${String(r.p90).padStart(2)}d years=${r.years.toFixed(2)}`;
}

const candidates: Candidate[] = [
  ["V5", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, "2h"],
  ["V5_FASTMAX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX, "2h"],
  ["V5_PRIME", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME, "2h"],
  ["V5_PRIMEX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX, "2h"],
  ["V5_TITAN_REAL", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL, "2h"],
  ["V5_NOVA", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA, "2h"],
  ["V6", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6, "2h"],
  ["V7", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V7, "2h"],
  ["V8", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8, "2h"],
  ["V9", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9, "2h"],
  ["V10", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10, "2h"],
  ["V11", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11, "2h"],
  ["V12", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12, "2h"],
  ["V13_RISKY", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY, "2h"],
  ["V14", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14, "2h"],
  ["V15_RECENT", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT, "2h"],
  ["V231", FTMO_DAYTRADE_24H_CONFIG_V231, "4h"],
  ["V234", FTMO_DAYTRADE_24H_CONFIG_V234, "4h"],
  ["V236", FTMO_DAYTRADE_24H_CONFIG_V236, "4h"],
  ["V236_FAST", FTMO_DAYTRADE_24H_CONFIG_V236_FAST, "4h"],
  ["V236_2D", FTMO_DAYTRADE_24H_CONFIG_V236_2D, "4h"],
  ["V238", FTMO_DAYTRADE_24H_CONFIG_V238, "4h"],
  ["V239", FTMO_DAYTRADE_24H_CONFIG_V239, "4h"],
  ["V240", FTMO_DAYTRADE_24H_CONFIG_V240, "4h"],
  ["V241", FTMO_DAYTRADE_24H_CONFIG_V241, "4h"],
  ["V242", FTMO_DAYTRADE_24H_CONFIG_V242, "4h"],
  ["V243", FTMO_DAYTRADE_24H_CONFIG_V243, "4h"],
  ["V244", FTMO_DAYTRADE_24H_CONFIG_V244, "4h"],
  ["V245", FTMO_DAYTRADE_24H_CONFIG_V245, "4h"],
  ["V246", FTMO_DAYTRADE_24H_CONFIG_V246, "4h"],
  ["V247", FTMO_DAYTRADE_24H_CONFIG_V247, "4h"],
  ["V248", FTMO_DAYTRADE_24H_CONFIG_V248, "4h"],
  ["V249", FTMO_DAYTRADE_24H_CONFIG_V249, "4h"],
  ["V250", FTMO_DAYTRADE_24H_CONFIG_V250, "4h"],
  ["V251", FTMO_DAYTRADE_24H_CONFIG_V251, "4h"],
  ["V251_FAST", FTMO_DAYTRADE_24H_CONFIG_V251_FAST, "4h"],
  ["V252", FTMO_DAYTRADE_24H_CONFIG_V252, "4h"],
  ["V253", FTMO_DAYTRADE_24H_CONFIG_V253, "4h"],
  ["V254", FTMO_DAYTRADE_24H_CONFIG_V254, "4h"],
  ["V255", FTMO_DAYTRADE_24H_CONFIG_V255, "4h"],
  ["V256", FTMO_DAYTRADE_24H_CONFIG_V256, "4h"],
  ["V257", FTMO_DAYTRADE_24H_CONFIG_V257, "4h"],
  ["V258", FTMO_DAYTRADE_24H_CONFIG_V258, "4h"],
  ["V259", FTMO_DAYTRADE_24H_CONFIG_V259, "4h"],
  ["V260", FTMO_DAYTRADE_24H_CONFIG_V260, "4h"],
  ["V261", FTMO_DAYTRADE_24H_CONFIG_V261, "4h"],
  ["V261_2H", FTMO_DAYTRADE_24H_CONFIG_V261_2H, "2h"],
  ["V261_2H_OPT", FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT, "2h"],
  ["V7_1H_OPT", FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT, "1h"],
  ["V10_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT, "30m"],
  ["V11_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT, "30m"],
  ["V12_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT, "30m"],
  ["V12_TURBO_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT, "30m"],
  ["LIVE_30M_V1", FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1, "30m"],
  ["LIVE_30M_V2", FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V2, "30m"],
  ["LIVE_1H_V1", FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1, "1h"],
  ["LIVE_1H_V2", FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2, "1h"],
  ["LIVE_2H_V1", FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1, "2h"],
  ["LIVE_2H_V2", FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V2, "2h"],
  ["LIVE_4H_V1", FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V1, "4h"],
  ["LIVE_4H_V2", FTMO_DAYTRADE_24H_CONFIG_LIVE_4H_V2, "4h"],
].map(([name, cfg, tf]) => ({ name, cfg, tf })) as Candidate[];

describe("Fast challenge best bot", { timeout: 24 * 3600_000 }, () => {
  it("finds best live-capped Step-1 bot with median <= 4d", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      `FAST_CHALLENGE_BEST START ${new Date().toISOString()}\n`,
    );
    const symbolsByTf: Record<string, Set<string>> = {};
    for (const c of candidates) {
      const cfg = normalizeForChallenge(c.cfg, c.tf);
      symbolsByTf[c.tf] ??= new Set<string>();
      for (const s of sourceSymbols(cfg)) symbolsByTf[c.tf].add(s);
    }

    const dataByTf: Record<string, Record<string, Candle[]>> = {};
    for (const [tf, set] of Object.entries(symbolsByTf)) {
      const plan = LOAD_PLAN[tf as FtmoDaytrade24hConfig["timeframe"]];
      dataByTf[tf] = {};
      log(
        `\nLoading ${tf}: ${[...set].sort().join(", ")} target=${plan.targetCount}`,
      );
      for (const s of [...set].sort()) {
        const raw = await loadBinanceHistory({
          symbol: s,
          timeframe: tf as FtmoDaytrade24hConfig["timeframe"],
          targetCount: plan.targetCount,
          maxPages: plan.maxPages,
        });
        dataByTf[tf][s] = raw.filter((c) => c.isFinal);
        const cs = dataByTf[tf][s];
        log(
          `  ${s.padEnd(8)} final=${cs.length} first=${new Date(cs[0]?.openTime ?? 0).toISOString()} last=${new Date(cs[cs.length - 1]?.openTime ?? 0).toISOString()}`,
        );
      }
    }

    const results = candidates
      .map((c) => evaluate(c, dataByTf))
      .sort((a, b) => b.passRate - a.passRate || a.med - b.med || a.dl - b.dl);
    const fast = results
      .filter((r) => r.med > 0 && r.med <= 4 && r.years >= 3)
      .sort((a, b) => b.passRate - a.passRate || a.p90 - b.p90 || a.dl - b.dl);

    log("\n========== TOP ALL ==========");
    for (const r of results.slice(0, 30)) log(fmt(r));
    log("\n========== TOP MEDIAN <= 4D / >= 3Y ==========");
    for (const r of fast.slice(0, 30)) log(fmt(r));

    writeFileSync(
      `${LOG_DIR}/FAST_CHALLENGE_BEST_${STAMP}.json`,
      JSON.stringify(
        { bestFast: fast, bestAll: results.slice(0, 40) },
        null,
        2,
      ),
    );
    expect(fast[0]?.passRate ?? 0).toBeGreaterThan(0);
  });
});
