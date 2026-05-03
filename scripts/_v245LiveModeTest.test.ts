/**
 * Round 28 — V245 liveMode (entry-time sort) vs default (exit-time sort).
 *
 * Tests `FTMO_DAYTRADE_24H_CONFIG_V245` under TWO test setups × TWO sort modes:
 *   1) Engine-claim mode: profitTarget=0.10 (10%), no liveCaps
 *      → reproduces the 85.84% Pareto-baseline number from V245's doc
 *   2) FTMO Step-1 mode: profitTarget=0.08 (8%) + liveCaps {maxStopPct:0.05,
 *      maxRiskFrac:0.4} + pauseAtTargetReached=true
 *      → matches the user's actual deployment goal
 *
 * Each setup is run under liveMode=false (exit-time sort) AND liveMode=true
 * (entry-time sort, live-bot fair). Drift = (false − true) in pp.
 *
 * Hypothesis: V245 was Agent-2's "drift-free" candidate. If true, the
 * sort-mode drift should be small (<5pp) under both setups.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V245,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

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

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
}

function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  barsPerDay: number,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * barsPerDay;
  const stepBars = 3 * barsPerDay;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const passDays: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) passDays.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  passDays.sort((a, b) => a - b);
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    p25: pctile(passDays, 0.25),
    med: pctile(passDays, 0.5),
    p75: pctile(passDays, 0.75),
    p90: pctile(passDays, 0.9),
  };
}

async function loadFor(
  cfg: FtmoDaytrade24hConfig,
  timeframe: "30m" | "1h" | "2h" | "4h",
) {
  const symbols = syms(cfg);
  console.log(
    `Loading ${symbols.length} symbols (${timeframe}): ${symbols.join(",")}`,
  );
  const data: Record<string, Candle[]> = {};
  for (const s of symbols) {
    try {
      const r = await loadBinanceHistory({
        symbol: s,
        timeframe,
        targetCount: 100000,
        maxPages: 120,
      });
      data[s] = r.filter((c) => c.isFinal);
    } catch (e) {
      console.warn(`Failed to load ${s}: ${(e as Error).message}`);
    }
  }
  return data;
}

function fmt(label: string, r: ReturnType<typeof evaluate>) {
  if (!r) return `${label}: null`;
  return (
    `${label}: w=${r.windows} pass=${(r.passRate * 100).toFixed(2)}% ` +
    `tl=${(r.tlPct * 100).toFixed(2)}% dl=${(r.dlPct * 100).toFixed(2)}% ` +
    `p25=${r.p25}d med=${r.med}d p75=${r.p75}d p90=${r.p90}d`
  );
}

describe("Round 28 — V245 liveMode test", { timeout: 60 * 60_000 }, () => {
  it("V245 liveMode-false vs liveMode-true (engine-claim AND FTMO Step-1 setups)", async () => {
    const data = await loadFor(FTMO_DAYTRADE_24H_CONFIG_V245, "4h");
    const BARS_PER_DAY_4H = 6;

    // ─── Setup 1: Engine-claim (matches V245 doc 85.84% Pareto baseline) ───
    const claimCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_V245,
      // engine claim was: profitTarget 10%, no liveCaps, pauseAtTargetReached
      // already set via V245 chain (V236 sets it). Confirm:
      pauseAtTargetReached: true,
    };

    console.log("\n=== Setup 1 — Engine-claim (10% target, no liveCaps) ===");
    const A1 = evaluate(
      { ...claimCfg, liveMode: false },
      data,
      BARS_PER_DAY_4H,
    );
    const B1 = evaluate({ ...claimCfg, liveMode: true }, data, BARS_PER_DAY_4H);
    console.log(fmt("A1 (liveMode=false)", A1));
    console.log(fmt("B1 (liveMode=true) ", B1));
    const drift1 = (A1!.passRate - B1!.passRate) * 100;
    console.log(`Drift1 (false − true): ${drift1.toFixed(2)}pp`);

    // ─── Setup 2: FTMO Step-1 reality (8% target + liveCaps) ───────────────
    const step1Cfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_V245,
      profitTarget: 0.08, // FTMO Step-1
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      pauseAtTargetReached: true,
      minTradingDays: 4, // CLAUDE.md project rule
    };

    console.log(
      "\n=== Setup 2 — FTMO Step-1 (8% target, liveCaps, minDays=4) ===",
    );
    const A2 = evaluate(
      { ...step1Cfg, liveMode: false },
      data,
      BARS_PER_DAY_4H,
    );
    const B2 = evaluate({ ...step1Cfg, liveMode: true }, data, BARS_PER_DAY_4H);
    console.log(fmt("A2 (liveMode=false)", A2));
    console.log(fmt("B2 (liveMode=true) ", B2));
    const drift2 = (A2!.passRate - B2!.passRate) * 100;
    console.log(`Drift2 (false − true): ${drift2.toFixed(2)}pp`);

    // ─── Verdict ───────────────────────────────────────────────────────────
    console.log("\n=== VERDICT ===");
    const liveStep1 = B2?.passRate ?? 0;
    if (liveStep1 >= 0.75) {
      console.log(
        "V245 holds ≥75% under FTMO Step-1 + liveMode=true → DEPLOY CANDIDATE.",
      );
    } else if (liveStep1 >= 0.7) {
      console.log(
        "V245 holds ≥70% under FTMO Step-1 + liveMode=true — meets 70% goal.",
      );
    } else if (liveStep1 >= 0.5) {
      console.log(
        "V245 partial: ≥50% but <70% on Step-1+liveMode → not deploy-ready.",
      );
    } else {
      console.log(
        "V245 collapses on FTMO Step-1 + liveMode=true → NOT deploy-ready.",
      );
    }

    expect(A1).not.toBeNull();
    expect(B1).not.toBeNull();
    expect(A2).not.toBeNull();
    expect(B2).not.toBeNull();
  });
});
