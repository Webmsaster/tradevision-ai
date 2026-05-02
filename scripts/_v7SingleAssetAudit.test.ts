/**
 * V7_1H_OPT single-asset breakdown — find out if 87% is pool-magic.
 *
 * If V7 truly works, each individual asset (BTC, ETH, SOL) should produce
 * a meaningful pass-rate. If only one asset carries everything, the 87%
 * is a single-asset lottery dressed up as a "diversified" strategy.
 *
 * Also: print sample passed-window trade lists so the user can eyeball them.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY_1H = 24;

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

function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  stepDays = 3,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY_1H;
  const stepBars = stepDays * BARS_PER_DAY_1H;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
    totalT = 0;
  const tradesByAsset: Record<
    string,
    { wins: number; losses: number; totalPnl: number }
  > = {};
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) passes++;
    else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
    for (const t of res.trades) {
      totalT++;
      const a = t.symbol ?? "UNKNOWN";
      if (!tradesByAsset[a])
        tradesByAsset[a] = { wins: 0, losses: 0, totalPnl: 0 };
      if (t.effPnl > 0) tradesByAsset[a].wins++;
      else tradesByAsset[a].losses++;
      tradesByAsset[a].totalPnl += t.effPnl;
    }
  }
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    totalTrades: totalT,
    tradesByAsset,
  };
}

describe("V7_1H_OPT single-asset audit", { timeout: 30 * 60_000 }, () => {
  it("pool-magic vs single-asset breakdown", async () => {
    const V7 = FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT;
    const symbols = syms(V7);
    console.log(`\nLoading ${symbols.length} symbols (1h)...`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const r = await loadBinanceHistory({
        symbol: s,
        timeframe: "1h",
        targetCount: 100000,
        maxPages: 120,
      });
      data[s] = r.filter((c) => c.isFinal);
    }

    const noPause = { ...V7, pauseAtTargetReached: false };

    // Per-asset trade contribution under FULL pool (V7 base)
    console.log(
      "\n=== A. PER-ASSET TRADE CONTRIBUTION (full pool, NO-PAUSE) ===",
    );
    const fullRes = evaluate(noPause, data, 3);
    if (fullRes) {
      console.log(
        `Total: pass=${(fullRes.passRate * 100).toFixed(2)}% trades=${fullRes.totalTrades}`,
      );
      for (const [asset, stats] of Object.entries(fullRes.tradesByAsset)) {
        const total = stats.wins + stats.losses;
        const wr = total > 0 ? stats.wins / total : 0;
        console.log(
          `  ${asset.padEnd(12)} trades=${total.toString().padStart(5)} wr=${(wr * 100).toFixed(1)}% totalPnl=${stats.totalPnl.toFixed(4)}`,
        );
      }
    }

    // Single-asset isolation: drop assets one at a time
    console.log("\n=== B. SINGLE-ASSET ISOLATION (drop other assets) ===");
    for (const isolatedSym of ["ETHUSDT", "BTCUSDT", "SOLUSDT"]) {
      const isolatedAssets = V7.assets.filter((a) => {
        const src = a.sourceSymbol ?? a.symbol;
        return src === isolatedSym;
      });
      if (isolatedAssets.length === 0) continue;
      const cfg: FtmoDaytrade24hConfig = {
        ...noPause,
        assets: isolatedAssets,
      };
      // Keep crossAssetFilter (BTC) so signals still work
      const r = evaluate(cfg, data, 3);
      if (r) {
        console.log(
          `${isolatedSym.padEnd(10)}: pass=${(r.passRate * 100).toFixed(2).padStart(6)}% TL=${(r.tlPct * 100).toFixed(2)}% DL=${(r.dlPct * 100).toFixed(2)}% trades=${r.totalTrades}`,
        );
      }
    }

    // Pair tests
    console.log("\n=== C. PAIR TESTS ===");
    const pairs = [
      ["BTCUSDT", "ETHUSDT"],
      ["BTCUSDT", "SOLUSDT"],
      ["ETHUSDT", "SOLUSDT"],
    ];
    for (const pair of pairs) {
      const pairAssets = V7.assets.filter((a) => {
        const src = a.sourceSymbol ?? a.symbol;
        return pair.includes(src);
      });
      const cfg: FtmoDaytrade24hConfig = { ...noPause, assets: pairAssets };
      const r = evaluate(cfg, data, 3);
      if (r) {
        console.log(
          `${pair.join("+").padEnd(20)}: pass=${(r.passRate * 100).toFixed(2)}% trades=${r.totalTrades}`,
        );
      }
    }

    // Cost stress: 2x slippage and cost
    console.log("\n=== D. COST STRESS (2x and 3x) ===");
    for (const mult of [1, 2, 3]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...noPause,
        assets: V7.assets.map((a) => ({
          ...a,
          costBp: (a.costBp ?? 30) * mult,
          slippageBp: (a.slippageBp ?? 8) * mult,
        })),
      };
      const r = evaluate(cfg, data, 3);
      if (r) {
        console.log(
          `${mult}x cost+slip: pass=${(r.passRate * 100).toFixed(2)}% TL=${(r.tlPct * 100).toFixed(2)}%`,
        );
      }
    }

    // Sample trade inspection: print 1 passing window and 1 TL-fail window
    console.log("\n=== E. SAMPLE WINDOW TRADE INSPECTION ===");
    const symbols0 = syms(V7);
    const aligned = alignCommon(data, symbols0);
    const n = Math.min(...symbols0.map((s) => aligned[s].length));
    const winBars = V7.maxDays * BARS_PER_DAY_1H;
    const stepBars = 3 * BARS_PER_DAY_1H;
    let printedPass = false,
      printedTL = false;
    for (
      let start = 0;
      start + winBars <= n && !(printedPass && printedTL);
      start += stepBars
    ) {
      const slice: Record<string, Candle[]> = {};
      for (const s of symbols0)
        slice[s] = aligned[s].slice(start, start + winBars);
      const res = runFtmoDaytrade24h(slice, noPause);
      if (res.passed && !printedPass) {
        console.log(
          `\n--- PASSED window @ start=${start} (${new Date(slice[symbols0[0]][0].openTime).toISOString().slice(0, 10)}) ---`,
        );
        console.log(
          `passDay=${res.passDay}d, totalTrades=${res.trades.length}`,
        );
        for (const t of res.trades.slice(0, 8)) {
          console.log(
            `  ${(t.symbol ?? "?").padEnd(10)} ${t.direction.padEnd(5)} entry=${t.entryPrice?.toFixed(2)} exit=${t.exitPrice?.toFixed(2)} effPnl=${(t.effPnl * 100).toFixed(3)}% reason=${t.exitReason}`,
          );
        }
        printedPass = true;
      }
      if (!res.passed && res.reason === "total_loss" && !printedTL) {
        console.log(
          `\n--- FAILED (TL) window @ start=${start} (${new Date(slice[symbols0[0]][0].openTime).toISOString().slice(0, 10)}) ---`,
        );
        console.log(`reason=total_loss, totalTrades=${res.trades.length}`);
        for (const t of res.trades.slice(0, 8)) {
          console.log(
            `  ${(t.symbol ?? "?").padEnd(10)} ${t.direction.padEnd(5)} entry=${t.entryPrice?.toFixed(2)} exit=${t.exitPrice?.toFixed(2)} effPnl=${(t.effPnl * 100).toFixed(3)}% reason=${t.exitReason}`,
          );
        }
        printedTL = true;
      }
    }

    expect(true).toBe(true);
  });
});
