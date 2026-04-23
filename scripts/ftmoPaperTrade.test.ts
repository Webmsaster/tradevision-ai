/**
 * FTMO Paper-Trading Harness
 *
 * Runs the current regime-recommended bot against live Binance 4h candles,
 * simulates what a challenge would do RIGHT NOW, and appends the result
 * to a rolling paper log.
 *
 * Use case: run this once a day (via cron or manually) during your "wait
 * for good regime" phase. The log shows whether signals fire, what the
 * bot would have done, and cumulative paper P&L.
 *
 * Run via vitest:
 *   node ./node_modules/vitest/vitest.mjs run \
 *        --config vitest.scripts.config.ts \
 *        scripts/ftmoPaperTrade.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runFtmoDaytrade24h,
  pickBestConfig,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_BULL,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import {
  loadForexFactoryNews,
  filterNewsEvents,
} from "../src/utils/forexFactoryNews";

const LOG_PATH = "paper-trade-log.json";

interface PaperLogEntry {
  timestamp: string;
  regime: "BULL" | "BEAR_CHOP";
  botUsed: string;
  ethPrice: number;
  btcPrice: number;
  simulatedChallenge: {
    passed: boolean;
    reason: string;
    finalEquityPct: number;
    tradesCount: number;
    uniqueTradingDays: number;
    maxDrawdown: number;
  };
  firstTrade: Daytrade24hTrade | null;
  lastTrade: Daytrade24hTrade | null;
}

interface PaperLog {
  created: string;
  entries: PaperLogEntry[];
}

function loadLog(): PaperLog {
  if (!existsSync(LOG_PATH)) {
    return { created: new Date().toISOString(), entries: [] };
  }
  return JSON.parse(readFileSync(LOG_PATH, "utf8"));
}

function saveLog(log: PaperLog) {
  mkdirSync(dirname(LOG_PATH) || ".", { recursive: true });
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

describe("ftmo paper-trade tick", { timeout: 120_000 }, () => {
  it("runs simulated 30d challenge on latest data + appends log", async () => {
    console.log(`\n=== Paper-trade tick: ${new Date().toISOString()} ===`);

    // Load recent data for 30-day challenge simulation
    const winBars = 30 * 6; // 180 × 4h = 30d
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: winBars + 50, // buffer for indicator warmup
      maxPages: 3,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: winBars + 50,
      maxPages: 3,
    });
    const n = Math.min(eth.length, btc.length);
    const ethW = eth.slice(n - winBars);
    const btcW = btc.slice(n - winBars);

    // News filter (today's events only — good enough for live bot)
    let newsFilter;
    try {
      const allNews = await loadForexFactoryNews();
      const events = filterNewsEvents(allNews, {
        impacts: ["High"],
        currencies: ["USD", "EUR", "GBP"],
      });
      newsFilter = { events, bufferMinutes: 2 };
      console.log(`Loaded ${events.length} high-impact FF events`);
    } catch (e) {
      console.log(
        `FF unavailable, news filter disabled: ${(e as Error).message}`,
      );
    }

    // Regime pick
    const { cfg: baseCfg, regime, reason } = pickBestConfig(btc);
    const cfg = newsFilter ? { ...baseCfg, newsFilter } : baseCfg;
    const botName =
      baseCfg === FTMO_DAYTRADE_24H_CONFIG
        ? "iter212 (Bear/Chop)"
        : baseCfg === FTMO_DAYTRADE_24H_CONFIG_BULL
          ? "iter213 (Bull)"
          : "iter212 (default)";
    console.log(`Regime: ${regime}  →  ${botName}`);
    console.log(`Reason: ${reason}`);

    // Run simulation
    const r = runFtmoDaytrade24h({ ETHUSDT: ethW, BTCUSDT: btcW }, cfg);

    console.log(
      `\nSimulated 30-day challenge on last ${(winBars / 6).toFixed(0)} days:`,
    );
    console.log(
      `  Passed: ${r.passed ? "✅ YES" : "❌ NO"}  (reason: ${r.reason})`,
    );
    console.log(`  Final equity: ${(r.finalEquityPct * 100).toFixed(2)}%`);
    console.log(`  Max drawdown: ${(r.maxDrawdown * 100).toFixed(2)}%`);
    console.log(
      `  Trades: ${r.trades.length}  Unique days: ${r.uniqueTradingDays}`,
    );

    if (r.trades.length > 0) {
      console.log(`\nLast 5 trades:`);
      for (const t of r.trades.slice(-5)) {
        const d = new Date(t.entryTime).toISOString().slice(0, 16);
        const pnlPct = (t.effPnl * 100).toFixed(2);
        const result =
          t.exitReason === "tp"
            ? "✅ TP"
            : t.exitReason === "stop"
              ? "❌ STOP"
              : "⏱ TIME";
        console.log(
          `  ${d}Z  ${t.direction.toUpperCase()}  @$${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)}  ${result}  ${pnlPct}%`,
        );
      }
    }

    // Append to log
    const log = loadLog();
    const entry: PaperLogEntry = {
      timestamp: new Date().toISOString(),
      regime,
      botUsed: botName,
      ethPrice: ethW[ethW.length - 1].close,
      btcPrice: btcW[btcW.length - 1].close,
      simulatedChallenge: {
        passed: r.passed,
        reason: r.reason,
        finalEquityPct: r.finalEquityPct,
        tradesCount: r.trades.length,
        uniqueTradingDays: r.uniqueTradingDays,
        maxDrawdown: r.maxDrawdown,
      },
      firstTrade: r.trades[0] ?? null,
      lastTrade: r.trades[r.trades.length - 1] ?? null,
    };
    log.entries.push(entry);
    // Keep last 50 entries
    if (log.entries.length > 50) log.entries = log.entries.slice(-50);
    saveLog(log);

    console.log(`\nLog: ${log.entries.length} total entries in ${LOG_PATH}`);

    // Cumulative summary across recent entries
    if (log.entries.length >= 2) {
      const recent = log.entries.slice(-10);
      const passes = recent.filter((e) => e.simulatedChallenge.passed).length;
      console.log(
        `Last ${recent.length} simulated challenges: ${passes} passed = ${((passes / recent.length) * 100).toFixed(0)}%`,
      );
    }

    expect(true).toBe(true);
  });
});
