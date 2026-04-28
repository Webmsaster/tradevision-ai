/**
 * V5-style trend strategy on Gold (XAU/USD) — top FTMO bots run on Gold not crypto.
 * Test if Gold's tighter trends + lower volatility give higher pass rate.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import {
  loadYahooDaily,
  loadYahooIntraday,
  resampleCandles,
} from "./_loadYahooHistory";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/GOLD_V5_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

describe("V5 on Gold (XAU/USD)", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `GOLD_V5 START ${new Date().toISOString()}\n`);

    log(`Loading Gold data via Yahoo intraday + Stooq daily...`);
    let goldH1: Candle[] = [];
    try {
      // Yahoo: GC=F (Gold futures) at 1h, 730 days max
      goldH1 = await loadYahooIntraday("GC=F", "1h", "2y");
      log(`Yahoo GC=F 1h: ${goldH1.length} bars`);
    } catch (e) {
      log(`Yahoo GC=F failed: ${(e as Error).message}`);
      // Fallback: Stooq daily
      goldH1 = await loadYahooDaily({ symbol: "xauusd" });
      log(`Stooq xauusd daily: ${goldH1.length} bars`);
    }
    if (goldH1.length === 0) {
      log("No gold data available, skipping test");
      expect(true).toBe(true);
      return;
    }

    // Resample to 2h to match V5
    const gold2h = resampleCandles(goldH1, 2);
    log(
      `Gold 2h after resample: ${gold2h.length} bars (${(gold2h.length / 12 / 365).toFixed(2)}y)\n`,
    );

    // Build a Gold-specific V5 config (only one asset)
    const goldAssetCfg = {
      symbol: "GOLD-TREND",
      sourceSymbol: "GC=F",
      costBp: 5, // gold tighter spread
      slippageBp: 2,
      swapBpPerDay: 1,
      riskFrac: 1.0,
      triggerBars: 1,
      invertDirection: true,
      disableShort: true,
      stopPct: 0.015, // gold less volatile — 1.5% stop
      tpPct: 0.025, // 1.67:1 R:R
      holdBars: 240,
    };

    const goldData = { "GC=F": gold2h };

    function evalCfg(cfg: FtmoDaytrade24hConfig, label: string) {
      const winBars = 30 * 12;
      const stepBars = 3 * 12;
      const n = gold2h.length;
      let p = 0,
        w = 0,
        tl = 0,
        dl = 0;
      const passDays: number[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub = { "GC=F": gold2h.slice(s, s + winBars) };
        const r = runFtmoDaytrade24h(sub, cfg);
        if (r.passed) {
          p++;
          if (r.trades.length > 0)
            passDays.push(r.trades[r.trades.length - 1].day + 1);
        }
        if (r.reason === "total_loss") tl++;
        if (r.reason === "daily_loss") dl++;
        w++;
      }
      passDays.sort((a, b) => a - b);
      const med = passDays[Math.floor(passDays.length * 0.5)] ?? 0;
      const p90 = passDays[Math.floor(passDays.length * 0.9)] ?? 0;
      log(
        `  ${label.padEnd(40)} pass=${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${((tl / w) * 100).toFixed(2)}% DL=${((dl / w) * 100).toFixed(2)}% med=${med}d p90=${p90}d`,
      );
      return { p, w, tl, passRate: p / w, med };
    }

    log(`========== Gold V5-style baseline ==========`);
    const baseCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      assets: [goldAssetCfg],
      maxConcurrentTrades: 1,
      profitTarget: 0.08,
      maxDays: 30,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };
    evalCfg(baseCfg, "Gold V5 baseline");

    log(`\n========== Stop/TP variants for Gold ==========`);
    for (const [name, sp, tp] of [
      ["sp=1% tp=1.5%", 0.01, 0.015],
      ["sp=1.5% tp=2%", 0.015, 0.02],
      ["sp=1.5% tp=2.5%", 0.015, 0.025],
      ["sp=2% tp=3%", 0.02, 0.03],
      ["sp=2.5% tp=4%", 0.025, 0.04],
      ["sp=3% tp=5%", 0.03, 0.05],
    ] as const) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        assets: [{ ...goldAssetCfg, stopPct: sp, tpPct: tp }],
      };
      evalCfg(cfg, name);
    }

    log(`\n========== Gold + Crypto Combo ==========`);
    // Maybe Gold + V5 9-cryptos diversifies risk?
    log(`(skipped — different data lengths require alignment work)`);

    log(
      `\n========== Higher Leverage on Gold (FTMO allows up to 30x) ==========`,
    );
    for (const lev of [2, 5, 10, 20, 30]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        leverage: lev,
        assets: [{ ...goldAssetCfg, stopPct: 0.015, tpPct: 0.025 }],
      };
      evalCfg(cfg, `lev=${lev} (sp=1.5% tp=2.5%)`);
    }

    expect(true).toBe(true);
  });
});
