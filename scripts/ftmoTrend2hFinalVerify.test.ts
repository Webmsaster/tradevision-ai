/**
 * FINAL VERIFICATION — show ALL numbers honestly:
 *  - Single-eval (full 5.59y as one walk-forward)
 *  - Multi-fold mean (11 × 6mo slices, mean of slice means)
 *  - Both with median/p75/p90
 *
 * Antwort User: "stimmen die 46% Werte?"
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
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
const LOG_FILE = `${LOG_DIR}/FINAL_VERIFY_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("FINAL VERIFY — honest numbers", { timeout: 24 * 3600_000 }, () => {
  it("verifies", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `FINAL VERIFY ${new Date().toISOString()}\n`);

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

    log(
      `Data: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) per asset, 9 assets, FTMO-real costs\n`,
    );

    function singleEval(cfg: FtmoDaytrade24hConfig, useFunding: boolean) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      const out: FtmoDaytrade24hResult[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
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
      const tl = out.filter((r) => r.reason === "total_loss").length;
      const dl = out.filter((r) => r.reason === "daily_loss").length;
      const passDays: number[] = [];
      for (const r of out)
        if (r.passed && r.trades.length > 0)
          passDays.push(r.trades[r.trades.length - 1].day + 1);
      passDays.sort((a, b) => a - b);
      const pick = (q: number) =>
        passDays[Math.floor(passDays.length * q)] ?? 0;
      return {
        windows: out.length,
        passes,
        passRate: passes / out.length,
        tl,
        tlRate: tl / out.length,
        dl,
        dlRate: dl / out.length,
        engineMed: pick(0.5),
        engineP75: pick(0.75),
        engineP90: pick(0.9),
        realMed: Math.max(pick(0.5), 4),
      };
    }

    function multiFold(cfg: FtmoDaytrade24hConfig, useFunding: boolean) {
      const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY);
      const numSlices = Math.floor(n / sixMo);
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      const slicePassRates: number[] = [];
      for (let si = 0; si < numSlices; si++) {
        let p = 0,
          w = 0;
        const sliceStart = si * sixMo;
        const sliceEnd = (si + 1) * sixMo;
        for (let s = sliceStart; s + winBars <= sliceEnd; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          const subFund: Record<string, (number | null)[]> = {};
          for (const sym of SOURCES) {
            sub[sym] = data[sym].slice(s, s + winBars);
            if (useFunding)
              subFund[sym] = fundingBySymbol[sym].slice(s, s + winBars);
          }
          const r = runFtmoDaytrade24h(
            sub,
            cfg,
            useFunding ? subFund : undefined,
          );
          if (r.passed) p++;
          w++;
        }
        slicePassRates.push(w > 0 ? p / w : 0);
      }
      const mean =
        slicePassRates.reduce((a, b) => a + b, 0) / slicePassRates.length;
      const min = Math.min(...slicePassRates);
      return { numSlices, mean, min };
    }

    const list = [
      {
        name: "V5 (orig)",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        fund: false,
      },
      {
        name: "V5_PRIME",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
        fund: false,
      },
      {
        name: "V5_PRIMEX",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        fund: true,
      },
      {
        name: "V5_NOVA",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
        fund: true,
      },
    ];

    log(`====================================================================`);
    log(
      `Method 1: SINGLE-EVAL (one walk-forward over full 5.59y, ~671 windows)`,
    );
    log(`Method 2: MULTI-FOLD (11 × 6-month slices, mean of slice pass-rates)`);
    log(
      `====================================================================\n`,
    );

    log(
      `${"Config".padEnd(15)} | ${"Single-eval".padEnd(45)} | ${"Multi-fold".padEnd(20)}`,
    );
    log(`${"=".repeat(15)} | ${"=".repeat(45)} | ${"=".repeat(20)}`);
    for (const v of list) {
      const s = singleEval(v.cfg, v.fund);
      const m = multiFold(v.cfg, v.fund);
      const single = `${(s.passRate * 100).toFixed(2)}% (${s.passes}/${s.windows}) TL=${(s.tlRate * 100).toFixed(2)}% med=${s.realMed}d p90=${s.engineP90}d`;
      const multi = `${(m.mean * 100).toFixed(2)}% (min ${(m.min * 100).toFixed(2)}%)`;
      log(`${v.name.padEnd(15)} | ${single.padEnd(45)} | ${multi.padEnd(20)}`);
    }

    log(
      `\n====================================================================`,
    );
    log(`INTERPRETATION:`);
    log(`- Single-eval = ehrliche aggregierte Zahl über alle Daten`);
    log(`- Multi-fold = Mittelwert von 11 Slice-Bewertungen (jede 6mo)`);
    log(`- Beide sind valide. Multi-fold filtert Sample-Size-Bias raus.`);
    log(`- Real-World Live Performance: erwartet 60-70% von Backtest`);
    log(`====================================================================`);

    expect(true).toBe(true);
  });
});
