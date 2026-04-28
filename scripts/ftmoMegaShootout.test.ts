/**
 * Mega Shootout — re-validate ALL existing top configs on post-bugfix engine.
 * Find the actual best config for live deploy, possibly beating V5's 47%.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
  FTMO_DAYTRADE_24H_CONFIG_V261,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6 as FTMO_DAYTRADE_24H_CONFIG_V6_2H_OPT, // alias for legacy name
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY_2H = 12;
const BARS_PER_DAY_4H = 6;
const BARS_PER_DAY_30M = 48;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/MEGA_SHOOTOUT_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

describe(
  "Mega Shootout — best config under post-bugfix engine",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `MEGA_SHOOTOUT START ${new Date().toISOString()}\n`,
      );

      // Load all data variants
      const eth9 = [
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
      const ethBtcSol = ["ETHUSDT", "BTCUSDT", "SOLUSDT"];

      log("Loading data...");
      const data2h: Record<string, Candle[]> = {};
      for (const s of eth9) {
        data2h[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
      }
      const data4h: Record<string, Candle[]> = {};
      for (const s of ethBtcSol) {
        data4h[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "4h",
          targetCount: 30000,
          maxPages: 40,
        });
      }
      const data30m: Record<string, Candle[]> = {};
      for (const s of ethBtcSol) {
        data30m[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 30000,
          maxPages: 40,
        });
      }

      function evalCfg(
        name: string,
        cfg: FtmoDaytrade24hConfig,
        dataset: Record<string, Candle[]>,
        barsPerDay: number,
      ) {
        const symbols = Object.keys(dataset);
        const n = Math.min(...symbols.map((s) => dataset[s].length));
        for (const s of symbols) dataset[s] = dataset[s].slice(-n);

        const winBars = 30 * barsPerDay;
        const stepBars = 3 * barsPerDay;
        let p = 0,
          w = 0,
          tl = 0;
        const passDays: number[] = [];
        for (let s = 0; s + winBars <= n; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const sym of symbols)
            sub[sym] = dataset[sym].slice(s, s + winBars);
          const r = runFtmoDaytrade24h(sub, cfg);
          if (r.passed) {
            p++;
            if (r.trades.length > 0)
              passDays.push(r.trades[r.trades.length - 1].day + 1);
          }
          if (r.reason === "total_loss") tl++;
          w++;
        }
        passDays.sort((a, b) => a - b);
        const med = passDays[Math.floor(passDays.length * 0.5)] ?? 0;
        const p90 = passDays[Math.floor(passDays.length * 0.9)] ?? 0;
        const passRate = w > 0 ? p / w : 0;
        const tlRate = w > 0 ? tl / w : 0;
        log(
          `  ${name.padEnd(35)} ${(passRate * 100).toFixed(2)}% (${p}/${w}) TL=${(tlRate * 100).toFixed(2)}% med=${med}d p90=${p90}d (${(n / barsPerDay / 365).toFixed(2)}y)`,
        );
        return { name, passRate, tlRate, med, p90, p, w };
      }

      log(`\n========== 2H STRATEGIES (9 cryptos) ==========`);
      const r2h: any[] = [];
      r2h.push(
        evalCfg(
          "V5 (orig, current live)",
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          { ...data2h },
          BARS_PER_DAY_2H,
        ),
      );
      r2h.push(
        evalCfg(
          "V5_NOVA (R46 winner)",
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
          { ...data2h },
          BARS_PER_DAY_2H,
        ),
      );
      r2h.push(
        evalCfg(
          "V5_PRIMEX",
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
          { ...data2h },
          BARS_PER_DAY_2H,
        ),
      );
      r2h.push(
        evalCfg(
          "V5_TITAN_REAL",
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
          { ...data2h },
          BARS_PER_DAY_2H,
        ),
      );
      r2h.push(
        evalCfg(
          "V6_2H_OPT",
          FTMO_DAYTRADE_24H_CONFIG_V6_2H_OPT,
          { ...data2h },
          BARS_PER_DAY_2H,
        ),
      );
      r2h.push(
        evalCfg(
          "V261_2H_OPT",
          FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
          { ...data2h },
          BARS_PER_DAY_2H,
        ),
      );

      log(`\n========== 4H STRATEGIES (BTC+ETH+SOL) ==========`);
      const r4h: any[] = [];
      r4h.push(
        evalCfg(
          "V261 (4h champion)",
          FTMO_DAYTRADE_24H_CONFIG_V261,
          { ...data4h },
          BARS_PER_DAY_4H,
        ),
      );

      log(`\n========== 30M STRATEGIES (BTC+ETH+SOL) ==========`);
      const r30m: any[] = [];
      r30m.push(
        evalCfg(
          "V12_30M_OPT (claimed 95%)",
          FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
          { ...data30m },
          BARS_PER_DAY_30M,
        ),
      );
      r30m.push(
        evalCfg(
          "V12_TURBO_30M_OPT",
          FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
          { ...data30m },
          BARS_PER_DAY_30M,
        ),
      );

      log(`\n========== FINAL RANKING (post-bugfix engine) ==========`);
      const all = [...r2h, ...r4h, ...r30m].sort(
        (a, b) => b.passRate - a.passRate,
      );
      log(
        "rank | config                              | pass    | TL    | med | p90",
      );
      log(
        "-----|-------------------------------------|---------|-------|-----|----",
      );
      all.forEach((r, i) => {
        log(
          `${(i + 1).toString().padStart(2)} | ${r.name.padEnd(35)} | ${(r.passRate * 100).toFixed(2)}% | ${(r.tlRate * 100).toFixed(2)}% | ${r.med}d | ${r.p90}d`,
        );
      });

      log(
        `\n🏆 WINNER: ${all[0].name} @ ${(all[0].passRate * 100).toFixed(2)}%`,
      );
      expect(true).toBe(true);
    });
  },
);
