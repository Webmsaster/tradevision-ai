/**
 * Integration test for live signal detection (iter231).
 * Verifies detectLiveSignalsV231 runs end-to-end on real Binance data
 * and returns sensible output (signals or documented skip reasons).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  detectLiveSignalsV231,
  renderDetection,
  type AccountState,
} from "../src/utils/ftmoLiveSignalV231";

describe("Live signal detector v231", { timeout: 120_000 }, () => {
  it("runs end-to-end on real Binance data", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });

    const account: AccountState = {
      equity: 1.0,
      day: 0,
      recentPnls: [],
      equityAtDayStart: 1.0,
    };
    const result = detectLiveSignalsV231(eth, btc, sol, account, []);

    console.log("\n" + renderDetection(result));
    console.log("\n--- Raw signals ---");
    console.log(JSON.stringify(result.signals, null, 2));

    expect(result.account).toBeDefined();
    expect(result.btc.close).toBeGreaterThan(0);
    expect(result.signals.length + result.skipped.length).toBeGreaterThan(0);
  });

  it("shows pyramid unlocked at +0.3% equity", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });

    // simulate account at +0.5% equity (ETH-PYR active, BTC/SOL still locked at +4%)
    const account: AccountState = {
      equity: 1.005,
      day: 2,
      recentPnls: [0.01, -0.005, 0.01],
      equityAtDayStart: 1.003,
    };
    const result = detectLiveSignalsV231(eth, btc, sol, account, []);

    // ETH-PYR should not be skipped due to equity gate
    const pyrSkip = result.skipped.find((s) => s.asset === "ETH-PYR");
    if (pyrSkip) {
      expect(pyrSkip.reason).not.toContain("equity gate");
    }
    // BTC-MR / SOL-MR should still be skipped due to equity gate (need +4%)
    const btcSkip = result.skipped.find((s) => s.asset === "BTC-MR");
    if (btcSkip) {
      expect(btcSkip.reason).toMatch(/equity gate|BTC filter|session|news/);
    }
  });

  it("saves detection result to disk in state dir", async () => {
    const stateDir = "/tmp/ftmo-test-state-" + Date.now();
    fs.mkdirSync(stateDir, { recursive: true });

    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });

    const account: AccountState = {
      equity: 1.0,
      day: 0,
      recentPnls: [],
      equityAtDayStart: 1.0,
    };
    const result = detectLiveSignalsV231(eth, btc, sol, account, []);

    const outPath = path.join(stateDir, "last-check.json");
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    expect(fs.existsSync(outPath)).toBe(true);

    const reread = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(reread.account.equity).toBe(1.0);
    expect(reread.signals).toBeDefined();

    fs.rmSync(stateDir, { recursive: true });
  });
});
