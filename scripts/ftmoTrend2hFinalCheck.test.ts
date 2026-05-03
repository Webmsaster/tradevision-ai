/**
 * Final check — best bot + median/p75/p90 days
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/FINAL_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

describe("Final check median days", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `FINAL CHECK ${new Date().toISOString()}\n`);

    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);
    const startMs = data[SOURCES[0]][0].openTime;
    const endMs = data[SOURCES[0]][n - 1].openTime + 2 * 3600_000;

    const fundingBySymbol: Record<string, (number | null)[]> = {};
    for (const s of SOURCES) {
      const rows = await loadBinanceFundingRate(s, startMs, endMs);
      fundingBySymbol[s] = alignFundingToCandles(
        rows,
        data[s].map((c) => c.openTime),
      );
    }

    function evalCfg(cfg: FtmoDaytrade24hConfig, useFunding: boolean) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      const aligned = n;
      const out: FtmoDaytrade24hResult[] = [];
      for (let s = 0; s + winBars <= aligned; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        const subFund: Record<string, (number | null)[]> = {};
        for (const sym of SOURCES) {
          sub[sym] = data[sym].slice(s, s + winBars);
          if (useFunding)
            subFund[sym] = fundingBySymbol[sym].slice(s, s + winBars);
        }
        out.push(
          runFtmoDaytrade24h(sub, cfg, useFunding ? subFund : undefined),
        );
      }
      const passes = out.filter((r) => r.passed).length;
      const passDays: number[] = [];
      for (const r of out)
        if (r.passed && r.trades.length > 0)
          passDays.push(r.trades[r.trades.length - 1].day + 1);
      passDays.sort((a, b) => a - b);
      const pick = (q: number) =>
        passDays[Math.floor(passDays.length * q)] ?? 0;
      // FTMO real has minTradingDays=4, so cap median at 4
      const minDays = cfg.minTradingDays ?? 0;
      return {
        windows: out.length,
        passes,
        passRate: passes / out.length,
        engineMed: pick(0.5),
        engineP75: pick(0.75),
        engineP90: pick(0.9),
        realMed: Math.max(pick(0.5), minDays),
        realP75: Math.max(pick(0.75), minDays),
        realP90: Math.max(pick(0.9), minDays),
        tlBreaches: out.filter((r) => r.reason === "total_loss").length,
        dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
      };
    }

    log(`Full 5.59y / 671 windows, FTMO-real (minTradingDays=4):\n`);
    log(
      `Config            Pass-Rate  Engine-Days(med/p75/p90)  Real-Days(med/p75/p90)  TL  DL`,
    );
    log(`${"-".repeat(110)}`);

    const list = [
      {
        name: "V5 (orig)",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        fund: false,
      },
      {
        name: "V5_ROBUST",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
        fund: false,
      },
      {
        name: "V5_RECENT",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
        fund: false,
      },
      {
        name: "V5_TITAN_REAL",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        fund: true,
      },
      {
        name: "V5_NOVA 🏆",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
        fund: true,
      },
    ];
    for (const v of list) {
      const r = evalCfg(v.cfg, v.fund);
      log(
        `${v.name.padEnd(17)} ${(r.passRate * 100).toFixed(2).padStart(6)}%  ${String(r.engineMed).padStart(2)}d/${String(r.engineP75).padStart(2)}d/${String(r.engineP90).padStart(2)}d            ${String(r.realMed).padStart(2)}d/${String(r.realP75).padStart(2)}d/${String(r.realP90).padStart(2)}d           ${String(r.tlBreaches).padStart(3)} ${String(r.dlBreaches).padStart(3)}`,
      );
    }

    expect(true).toBe(true);
  });
});
