/**
 * Round 28 — R28 30-Day Paper-Trade Simulation.
 *
 * Simulates running R28 for one full 30-day FTMO Step 1 challenge against
 * the LATEST 30 days of historical Binance data. Reports the would-be
 * outcome (pass/fail/total_loss) plus full equity curve & trade log.
 *
 * For real 30-day validation: cron-deploy as
 *   `node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *      scripts/_round28R28PaperTrade30d.test.ts`
 * → run daily, compare equity curve to live MT5 account.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

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

describe(
  "Round 28 — R28 30-Day Paper-Trade Simulation",
  { timeout: 30 * 60_000 },
  () => {
    it("simulate one full 30d Step 1 challenge on latest data", async () => {
      const CFG = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28;
      const cfgWithCaps: FtmoDaytrade24hConfig = {
        ...CFG,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      };
      const symbols = syms(CFG);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 5000,
            maxPages: 50,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));

      const bpd = 48; // 30m → 48 bars/day
      const winBars = 30 * bpd; // 30-day window
      if (minBars < winBars) {
        console.log(`Insufficient data: ${minBars} bars < ${winBars} required`);
        expect(true).toBe(true);
        return;
      }

      // Take the LATEST 30 days
      const startIdx = minBars - winBars;
      const window: Record<string, Candle[]> = {};
      for (const s of symbols)
        window[s] = aligned[s].slice(startIdx, startIdx + winBars);

      const startTs = window[symbols[0]][0].openTime;
      const endTs = window[symbols[0]][winBars - 1].openTime;
      console.log(`\n=== R28 30-Day Paper-Trade Simulation ===`);
      console.log(
        `Period: ${new Date(startTs).toISOString().slice(0, 10)} → ${new Date(endTs).toISOString().slice(0, 10)}`,
      );
      console.log(
        `Config: V5_QUARTZ_LITE_R28 (dpt 0.012 + ptp 0.025/0.6 + liveMode=true)`,
      );
      console.log(`Assets: ${symbols.join(", ")}`);
      console.log(
        `Profit target: ${(CFG.profitTarget * 100).toFixed(0)}% / Max days: ${CFG.maxDays} / Min days: ${CFG.minTradingDays ?? 4}`,
      );

      const result = runFtmoDaytrade24h(window, cfgWithCaps);

      console.log(`\n=== Result ===`);
      console.log(`Outcome: ${result.passed ? "✓ PASSED" : "✗ FAILED"}`);
      console.log(`Reason:  ${result.reason}`);
      console.log(`Pass-day: ${result.passDay ?? "—"}`);
      console.log(`Final equity: ${(result.finalEquityPct * 100).toFixed(2)}%`);
      console.log(`Trades: ${result.trades.length}`);

      // Trade summary
      const wins = result.trades.filter((t) => t.effPnl > 0).length;
      const losses = result.trades.filter((t) => t.effPnl < 0).length;
      const wr =
        result.trades.length > 0 ? (wins / result.trades.length) * 100 : 0;
      console.log(
        `\nWins: ${wins} / Losses: ${losses} / WR: ${wr.toFixed(1)}%`,
      );

      // Per-asset summary
      console.log(`\n--- Per-asset ---`);
      const byAsset: Record<string, { n: number; wins: number; pnl: number }> =
        {};
      for (const t of result.trades) {
        if (!byAsset[t.symbol]) byAsset[t.symbol] = { n: 0, wins: 0, pnl: 0 };
        byAsset[t.symbol].n++;
        if (t.effPnl > 0) byAsset[t.symbol].wins++;
        byAsset[t.symbol].pnl += t.effPnl;
      }
      for (const a of Object.keys(byAsset).sort()) {
        const s = byAsset[a];
        console.log(
          `  ${a.padEnd(15)} ${s.n} trades, ${s.wins} wins (${((s.wins / s.n) * 100).toFixed(0)}%), pnl=${(s.pnl * 100).toFixed(2)}%`,
        );
      }

      // First 10 trades
      console.log(`\n--- First 10 trades ---`);
      for (const t of result.trades.slice(0, 10)) {
        const entryDate = new Date(t.entryTime).toISOString().slice(0, 16);
        const exitDate = new Date(t.exitTime).toISOString().slice(0, 16);
        console.log(
          `  ${entryDate} → ${exitDate} | ${t.symbol.padEnd(12)} ${t.direction} | pnl=${(t.effPnl * 100).toFixed(2)}% | day=${t.entryDay}`,
        );
      }

      // Cron-deployable summary line for parsing
      console.log(
        `\n[CRON_SUMMARY] passed=${result.passed} reason=${result.reason} passDay=${result.passDay ?? 0} trades=${result.trades.length} wr=${wr.toFixed(1)}% finalPct=${(result.finalEquityPct * 100).toFixed(2)}%`,
      );
      expect(true).toBe(true);
    });
  },
);
