/**
 * V5_NOVA per-asset SPEED audit — find the trade-engine bottleneck.
 *
 * V5_NOVA is the R46 random-search winner (47.24% mean / 50.33% recent3).
 * Question: which of NOVA's 8 assets actually drive the 4-day speed-pass,
 * and which ones are slow drag we should drop?
 *
 * Outputs per-asset:
 *   - trade count, win-rate, total PnL
 *   - PnL-per-trade & trades-per-day (raw activity rate)
 *   - "Speed score" = avg PnL × trades-per-day (PnL-throughput per day)
 *   - Pass-rate / TL-rate / DL-rate when this asset is the SOLE asset
 *   - Pass-rate when this asset is DROPPED from the pool (counterfactual)
 *
 * Final ranking:
 *   - TOP-3 speed leaders (= candidates for tightened-pool variant)
 *   - BOTTOM speed laggards (= drop candidates)
 *
 * NOTE: "speed" here = how fast the asset's trades cumulatively cross the
 * 8% target inside a 4-day FTMO window, NOT raw trade count alone.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY_2H = 12;

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

interface AssetStats {
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalHoldHours: number;
  winsAtTp: number;
  stopLosses: number;
  timeExits: number;
}

interface EvalResult {
  windows: number;
  passes: number;
  passRate: number;
  passDays: number[];
  tlPct: number;
  dlPct: number;
  totalTrades: number;
  totalSpanDays: number; // sum of window lengths in days (for trades/day calc)
  byAsset: Record<string, AssetStats>;
  // window-level: which windows did each asset have at least 1 trade in
  windowsTouchedByAsset: Record<string, number>;
  // window-level: which windows did each asset push the equity over the line
  windowsClosedByAsset: Record<string, number>;
  // TL/DL attribution: count windows where this asset's trade was the largest
  // negative contributor on the failing day
  tlBlamedByAsset: Record<string, number>;
  dlBlamedByAsset: Record<string, number>;
}

function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  stepDays = 3,
): EvalResult | null {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY_2H;
  const stepBars = stepDays * BARS_PER_DAY_2H;

  const result: EvalResult = {
    windows: 0,
    passes: 0,
    passRate: 0,
    passDays: [],
    tlPct: 0,
    dlPct: 0,
    totalTrades: 0,
    totalSpanDays: 0,
    byAsset: {},
    windowsTouchedByAsset: {},
    windowsClosedByAsset: {},
    tlBlamedByAsset: {},
    dlBlamedByAsset: {},
  };
  let tl = 0,
    dl = 0;

  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    result.windows++;
    result.totalSpanDays += cfg.maxDays;
    if (res.passed) {
      result.passes++;
      if (res.passDay !== undefined) result.passDays.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;

    // Per-asset breakdown for this window
    const touched = new Set<string>();
    let lastWinningAsset: string | null = null;
    let lastWinningExitTime = -Infinity;
    let worstLossAsset: string | null = null;
    let worstLossPnl = 0;

    for (const t of res.trades) {
      result.totalTrades++;
      const a = t.symbol ?? "UNKNOWN";
      touched.add(a);
      if (!result.byAsset[a]) {
        result.byAsset[a] = {
          trades: 0,
          wins: 0,
          losses: 0,
          totalPnl: 0,
          totalHoldHours: 0,
          winsAtTp: 0,
          stopLosses: 0,
          timeExits: 0,
        };
      }
      const s = result.byAsset[a];
      s.trades++;
      s.totalPnl += t.effPnl;
      s.totalHoldHours += t.holdHours ?? 0;
      if (t.effPnl > 0) s.wins++;
      else s.losses++;
      if (t.exitReason === "tp") s.winsAtTp++;
      else if (t.exitReason === "stop") s.stopLosses++;
      else if (t.exitReason === "time") s.timeExits++;

      // Track which winning trade closed last (= the one that pushed over target)
      if (res.passed && t.effPnl > 0 && t.exitTime > lastWinningExitTime) {
        lastWinningAsset = a;
        lastWinningExitTime = t.exitTime;
      }
      // Track worst loss (for TL/DL blame attribution)
      if (t.effPnl < worstLossPnl) {
        worstLossPnl = t.effPnl;
        worstLossAsset = a;
      }
    }

    for (const a of touched) {
      result.windowsTouchedByAsset[a] =
        (result.windowsTouchedByAsset[a] ?? 0) + 1;
    }
    if (res.passed && lastWinningAsset) {
      result.windowsClosedByAsset[lastWinningAsset] =
        (result.windowsClosedByAsset[lastWinningAsset] ?? 0) + 1;
    }
    if (!res.passed && worstLossAsset) {
      if (res.reason === "total_loss") {
        result.tlBlamedByAsset[worstLossAsset] =
          (result.tlBlamedByAsset[worstLossAsset] ?? 0) + 1;
      } else if (res.reason === "daily_loss") {
        result.dlBlamedByAsset[worstLossAsset] =
          (result.dlBlamedByAsset[worstLossAsset] ?? 0) + 1;
      }
    }
  }

  result.passRate = result.windows ? result.passes / result.windows : 0;
  result.tlPct = result.windows ? tl / result.windows : 0;
  result.dlPct = result.windows ? dl / result.windows : 0;
  return result;
}

function fmtPct(x: number, digits = 2): string {
  return (x * 100).toFixed(digits);
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe("V5_NOVA per-asset speed audit", { timeout: 60 * 60_000 }, () => {
  it("ranks NOVA's 8 assets by speed contribution to 4-day pass", async () => {
    const NOVA = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA;
    const symbols = syms(NOVA);
    console.log(`\nLoading ${symbols.length} symbols (2h timeframe)...`);
    console.log(`  ${symbols.join(", ")}`);

    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const r = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 100000,
        maxPages: 120,
      });
      data[s] = r.filter((c) => c.isFinal);
    }

    // CRITICAL: keep pauseAtTargetReached so passDay == real FTMO 4-day target.
    // Speed is measured by passDay (NOT raw trade count) — so we MUST keep the
    // engine's target-reached pause logic active.
    const baseCfg = NOVA;

    // === A. PER-ASSET TRADE CONTRIBUTION (full pool) ===
    console.log("\n=== A. PER-ASSET TRADE CONTRIBUTION (FULL POOL) ===");
    const fullRes = evaluate(baseCfg, data, 3);
    if (!fullRes) throw new Error("full eval returned null");

    console.log(
      `Windows=${fullRes.windows} pass=${fmtPct(fullRes.passRate)}% TL=${fmtPct(fullRes.tlPct)}% DL=${fmtPct(fullRes.dlPct)}%`,
    );
    console.log(
      `Total trades=${fullRes.totalTrades} median passDay=${median(fullRes.passDays).toFixed(1)}d`,
    );

    // Normalisation: trades-per-day uses TOTAL elapsed days across all windows.
    const elapsedDays = fullRes.totalSpanDays;

    console.log(
      "\n  asset          | trades | wr   | totPnl  | avgPnl  | tr/day | speedSc | TL%   | DL%   | windowsHit | windowsClosed",
    );
    console.log(
      "  ---------------|--------|------|---------|---------|--------|---------|-------|-------|------------|---------------",
    );

    type Row = {
      asset: string;
      trades: number;
      wr: number;
      totalPnl: number;
      avgPnl: number;
      tradesPerDay: number;
      speedScore: number;
      tlBlamePct: number;
      dlBlamePct: number;
      windowsHit: number;
      windowsClosed: number;
    };
    const rows: Row[] = [];
    for (const [asset, st] of Object.entries(fullRes.byAsset)) {
      const total = st.wins + st.losses;
      const wr = total > 0 ? st.wins / total : 0;
      const avgPnl = total > 0 ? st.totalPnl / total : 0;
      const tradesPerDay = elapsedDays > 0 ? total / elapsedDays : 0;
      // Speed score: PnL throughput per day. Penalises low-frequency assets
      // even if their per-trade PnL is high — NOVA needs trades to compound
      // toward target inside 4-day window.
      const speedScore = avgPnl * tradesPerDay * 1000; // scale ×1000 for readability
      const tlBlame = fullRes.tlBlamedByAsset[asset] ?? 0;
      const dlBlame = fullRes.dlBlamedByAsset[asset] ?? 0;
      const tlBlamePct = fullRes.windows ? tlBlame / fullRes.windows : 0;
      const dlBlamePct = fullRes.windows ? dlBlame / fullRes.windows : 0;
      const wHit = fullRes.windowsTouchedByAsset[asset] ?? 0;
      const wClosed = fullRes.windowsClosedByAsset[asset] ?? 0;
      rows.push({
        asset,
        trades: total,
        wr,
        totalPnl: st.totalPnl,
        avgPnl,
        tradesPerDay,
        speedScore,
        tlBlamePct,
        dlBlamePct,
        windowsHit: wHit,
        windowsClosed: wClosed,
      });
    }

    rows.sort((a, b) => b.speedScore - a.speedScore);
    for (const r of rows) {
      console.log(
        `  ${r.asset.padEnd(14)} | ${r.trades.toString().padStart(6)} | ${(r.wr * 100).toFixed(1).padStart(4)}% | ${r.totalPnl.toFixed(3).padStart(7)} | ${(r.avgPnl * 100).toFixed(3).padStart(6)}% | ${r.tradesPerDay.toFixed(3).padStart(6)} | ${r.speedScore.toFixed(2).padStart(7)} | ${(r.tlBlamePct * 100).toFixed(1).padStart(5)}% | ${(r.dlBlamePct * 100).toFixed(1).padStart(5)}% | ${r.windowsHit.toString().padStart(10)} | ${r.windowsClosed.toString().padStart(13)}`,
      );
    }

    // === B. SPEED LEADERS / LAGGARDS ===
    console.log(
      "\n=== B. SPEED RANKING (by speedScore = avgPnl × tr/day × 1000) ===",
    );
    console.log("  TOP-3 SPEED LEADERS:");
    for (const r of rows.slice(0, 3)) {
      console.log(
        `    ${r.asset.padEnd(12)} score=${r.speedScore.toFixed(2)} avgPnl=${(r.avgPnl * 100).toFixed(3)}% tr/day=${r.tradesPerDay.toFixed(3)}`,
      );
    }
    console.log("  BOTTOM-3 SPEED LAGGARDS (drop candidates):");
    for (const r of rows.slice(-3).reverse()) {
      console.log(
        `    ${r.asset.padEnd(12)} score=${r.speedScore.toFixed(2)} avgPnl=${(r.avgPnl * 100).toFixed(3)}% tr/day=${r.tradesPerDay.toFixed(3)} TLblame=${(r.tlBlamePct * 100).toFixed(1)}% DLblame=${(r.dlBlamePct * 100).toFixed(1)}%`,
      );
    }

    // === C. SINGLE-ASSET ISOLATION ===
    console.log("\n=== C. SINGLE-ASSET ISOLATION (drop other 7 assets) ===");
    console.log(
      "  asset        | pass% | TL%  | DL%  | trades | medianPassDay",
    );
    console.log("  -------------|-------|------|------|--------|-------------");
    for (const a of NOVA.assets) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        assets: NOVA.assets.filter((x) => x.symbol === a.symbol),
      };
      const r = evaluate(cfg, data, 3);
      if (!r) continue;
      const md = r.passDays.length ? median(r.passDays).toFixed(1) : "-";
      console.log(
        `  ${a.symbol.padEnd(12)} | ${fmtPct(r.passRate).padStart(5)}% | ${fmtPct(r.tlPct).padStart(4)}% | ${fmtPct(r.dlPct).padStart(4)}% | ${r.totalTrades.toString().padStart(6)} | ${md.padStart(11)}`,
      );
    }

    // === D. LEAVE-ONE-OUT (counterfactual: drop this asset from pool) ===
    console.log("\n=== D. LEAVE-ONE-OUT (full pool minus this asset) ===");
    console.log(
      "  dropped       | pass% | Δpp vs full | TL%  | DL%  | medianPassDay",
    );
    console.log(
      "  --------------|-------|-------------|------|------|--------------",
    );
    const fullPass = fullRes.passRate;
    const fullMed = median(fullRes.passDays);
    console.log(
      `  (none/full)   | ${fmtPct(fullPass).padStart(5)}% |     +0.00pp | ${fmtPct(fullRes.tlPct).padStart(4)}% | ${fmtPct(fullRes.dlPct).padStart(4)}% | ${fullMed.toFixed(1).padStart(12)}`,
    );
    for (const a of NOVA.assets) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        assets: NOVA.assets.filter((x) => x.symbol !== a.symbol),
      };
      const r = evaluate(cfg, data, 3);
      if (!r) continue;
      const dpp = (r.passRate - fullPass) * 100;
      const md = r.passDays.length ? median(r.passDays).toFixed(1) : "-";
      const sign = dpp >= 0 ? "+" : "";
      console.log(
        `  ${a.symbol.padEnd(13)} | ${fmtPct(r.passRate).padStart(5)}% | ${(sign + dpp.toFixed(2)).padStart(8)}pp | ${fmtPct(r.tlPct).padStart(4)}% | ${fmtPct(r.dlPct).padStart(4)}% | ${md.padStart(12)}`,
      );
    }

    // === E. TOP-3 SPEED-LEADER POOL (test if leaders alone match full pool) ===
    console.log("\n=== E. TOP-3 SPEED-LEADER POOL ===");
    const top3Symbols = rows.slice(0, 3).map((r) => {
      const matched = NOVA.assets.find(
        (a) => (a.sourceSymbol ?? a.symbol) === r.asset,
      );
      return matched?.symbol ?? r.asset;
    });
    console.log(`  Top-3 speed leaders: ${top3Symbols.join(", ")}`);
    const top3Cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      assets: NOVA.assets.filter((a) => top3Symbols.includes(a.symbol)),
    };
    const top3Res = evaluate(top3Cfg, data, 3);
    if (top3Res) {
      const md = top3Res.passDays.length
        ? median(top3Res.passDays).toFixed(1)
        : "-";
      console.log(
        `  Pool=${top3Symbols.join("+")}: pass=${fmtPct(top3Res.passRate)}% TL=${fmtPct(top3Res.tlPct)}% DL=${fmtPct(top3Res.dlPct)}% trades=${top3Res.totalTrades} medianPassDay=${md}`,
      );
      console.log(
        `  vs full NOVA: Δpass=${((top3Res.passRate - fullPass) * 100).toFixed(2)}pp Δmed=${(median(top3Res.passDays) - fullMed).toFixed(2)}d`,
      );
    }

    // === F. TOP-5 SPEED-LEADER POOL (sanity expansion) ===
    console.log("\n=== F. TOP-5 SPEED-LEADER POOL ===");
    const top5Symbols = rows.slice(0, 5).map((r) => {
      const matched = NOVA.assets.find(
        (a) => (a.sourceSymbol ?? a.symbol) === r.asset,
      );
      return matched?.symbol ?? r.asset;
    });
    console.log(`  Top-5 speed leaders: ${top5Symbols.join(", ")}`);
    const top5Cfg: FtmoDaytrade24hConfig = {
      ...baseCfg,
      assets: NOVA.assets.filter((a) => top5Symbols.includes(a.symbol)),
    };
    const top5Res = evaluate(top5Cfg, data, 3);
    if (top5Res) {
      const md = top5Res.passDays.length
        ? median(top5Res.passDays).toFixed(1)
        : "-";
      console.log(
        `  Pool=${top5Symbols.join("+")}: pass=${fmtPct(top5Res.passRate)}% TL=${fmtPct(top5Res.tlPct)}% DL=${fmtPct(top5Res.dlPct)}% trades=${top5Res.totalTrades} medianPassDay=${md}`,
      );
      console.log(
        `  vs full NOVA: Δpass=${((top5Res.passRate - fullPass) * 100).toFixed(2)}pp Δmed=${(median(top5Res.passDays) - fullMed).toFixed(2)}d`,
      );
    }

    // === G. SUMMARY ===
    console.log("\n=== G. SUMMARY ===");
    console.log(
      `  Full NOVA (8 assets): pass=${fmtPct(fullPass)}% / median ${fullMed.toFixed(1)}d / TL=${fmtPct(fullRes.tlPct)}% / DL=${fmtPct(fullRes.dlPct)}%`,
    );
    console.log("  Speed-leader candidates for tightened-pool variant:");
    console.log(`    Top-3: ${top3Symbols.join(", ")}`);
    console.log(`    Top-5: ${top5Symbols.join(", ")}`);
    console.log("  Drop candidates (negative LOO Δ + low speedScore):");
    const sortedByLoo = [...rows].sort((a, b) => a.speedScore - b.speedScore);
    for (const r of sortedByLoo.slice(0, 3)) {
      console.log(
        `    ${r.asset.padEnd(12)} (speedScore=${r.speedScore.toFixed(2)}, TLblame=${fmtPct(r.tlBlamePct)}%)`,
      );
    }

    expect(true).toBe(true);
  });
});
