/**
 * Live-Caps Shootout — apply REAL live caps to ALL configs and find true winner.
 * Live caps: maxStopPct=0.05 (FTMO-real), maxRiskFrac=0.4 (4% live equity loss max).
 * Stricter caps: maxStopPct=0.03, maxRiskFrac=0.2 (real Telegram-shown live caps: 2% risk, 3% stop).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2,
  FTMO_DAYTRADE_24H_CONFIG_V261,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY_2H = 12;
const BARS_PER_DAY_4H = 6;
const BARS_PER_DAY_30M = 48;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/LIVECAPS_SHOOTOUT_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

// Real live caps as shown in Telegram heartbeat: 2% risk, 3% stop
const REAL_LIVE_CAPS = { maxStopPct: 0.03, maxRiskFrac: 0.2 };
// Looser caps (FTMO-real): 5% stop, 40% risk
const LOOSER_LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

describe(
  "Live-Caps Shootout — true deployable winner",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `LIVECAPS_SHOOTOUT START ${new Date().toISOString()}\n`,
      );

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
      for (const s of eth9)
        data2h[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
      const data4h: Record<string, Candle[]> = {};
      for (const s of ethBtcSol)
        data4h[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "4h",
          targetCount: 30000,
          maxPages: 40,
        });
      const data30m: Record<string, Candle[]> = {};
      for (const s of ethBtcSol)
        data30m[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 30000,
          maxPages: 40,
        });

      function evalCfg(
        name: string,
        cfg: FtmoDaytrade24hConfig,
        dataset: Record<string, Candle[]>,
        barsPerDay: number,
      ) {
        const symbols = Object.keys(dataset);
        const aligned: Record<string, Candle[]> = {};
        const n = Math.min(...symbols.map((s) => dataset[s].length));
        for (const s of symbols) aligned[s] = dataset[s].slice(-n);

        const winBars = 30 * barsPerDay;
        const stepBars = 3 * barsPerDay;
        let p = 0,
          w = 0,
          tl = 0;
        const passDays: number[] = [];
        for (let s = 0; s + winBars <= n; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const sym of symbols)
            sub[sym] = aligned[sym].slice(s, s + winBars);
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
        return {
          name,
          passRate: w > 0 ? p / w : 0,
          tlRate: w > 0 ? tl / w : 0,
          med,
          p90,
          p,
          w,
          years: n / barsPerDay / 365,
        };
      }

      function runSet(
        label: string,
        caps: { maxStopPct: number; maxRiskFrac: number } | null,
      ) {
        log(`\n========== ${label} ==========`);
        const tag = caps
          ? ` (caps: stop≤${caps.maxStopPct * 100}% risk≤${caps.maxRiskFrac * 100}%)`
          : " (NO caps)";
        log(`Apply caps to every config${tag}\n`);
        const apply = (c: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig =>
          caps ? { ...c, liveCaps: caps } : { ...c, liveCaps: undefined };
        const results: any[] = [];
        results.push(
          evalCfg(
            "V5",
            apply(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5),
            data2h,
            BARS_PER_DAY_2H,
          ),
        );
        results.push(
          evalCfg(
            "V5_NOVA",
            apply(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA),
            data2h,
            BARS_PER_DAY_2H,
          ),
        );
        results.push(
          evalCfg(
            "V5_PRIMEX",
            apply(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX),
            data2h,
            BARS_PER_DAY_2H,
          ),
        );
        results.push(
          evalCfg(
            "V5_TITAN_REAL",
            apply(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL),
            data2h,
            BARS_PER_DAY_2H,
          ),
        );
        results.push(
          evalCfg(
            "V5_STEP2",
            apply(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2),
            data2h,
            BARS_PER_DAY_2H,
          ),
        );
        results.push(
          evalCfg(
            "V6 (2h trend)",
            apply(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6),
            data2h,
            BARS_PER_DAY_2H,
          ),
        );
        results.push(
          evalCfg(
            "V261_2H_OPT",
            apply(FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT),
            data2h,
            BARS_PER_DAY_2H,
          ),
        );
        results.push(
          evalCfg(
            "V261 (4h)",
            apply(FTMO_DAYTRADE_24H_CONFIG_V261),
            data4h,
            BARS_PER_DAY_4H,
          ),
        );
        results.push(
          evalCfg(
            "V12_30M_OPT",
            apply(FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT),
            data30m,
            BARS_PER_DAY_30M,
          ),
        );
        results.push(
          evalCfg(
            "V12_TURBO_30M",
            apply(FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT),
            data30m,
            BARS_PER_DAY_30M,
          ),
        );
        results.push(
          evalCfg(
            "LIVE_30M_V1",
            apply(FTMO_DAYTRADE_24H_CONFIG_LIVE_30M_V1),
            data30m,
            BARS_PER_DAY_30M,
          ),
        );

        results.sort((a, b) => b.passRate - a.passRate);
        log(`rank | config           | pass    | TL      | med | p90 | years`);
        log(`-----|------------------|---------|---------|-----|-----|------`);
        results.forEach((r, i) => {
          log(
            `${(i + 1).toString().padStart(2)}   | ${r.name.padEnd(16)} | ${(r.passRate * 100).toFixed(2).padStart(6)}% | ${(r.tlRate * 100).toFixed(2).padStart(5)}% | ${r.med.toString().padStart(2)}d | ${r.p90.toString().padStart(2)}d | ${r.years.toFixed(1)}y`,
          );
        });
        return results;
      }

      log(
        `\n==================== TEST 1: NO live caps (academic backtest) ====================`,
      );
      const noCapsResults = runSet("Without Live-Caps", null);

      log(
        `\n==================== TEST 2: FTMO-real Live-Caps (5% stop / 40% risk) ====================`,
      );
      const looseResults = runSet("With Looser Live-Caps", LOOSER_LIVE_CAPS);

      log(
        `\n==================== TEST 3: REAL deploy Live-Caps (3% stop / 20% risk) ====================`,
      );
      const realResults = runSet("With Real Live-Caps", REAL_LIVE_CAPS);

      log(
        `\n==================== FINAL: BEST DEPLOYABLE BOT ====================`,
      );
      const winner = realResults[0];
      log(
        `Top config under REAL live caps: ${winner.name} @ ${(winner.passRate * 100).toFixed(2)}% pass / TL=${(winner.tlRate * 100).toFixed(2)}% / med=${winner.med}d / p90=${winner.p90}d`,
      );
      log(
        `\nIf winner = V5: ${winner.name === "V5" ? "✅ V5 confirmed as best deployable" : "❌ better config exists: " + winner.name}`,
      );

      expect(true).toBe(true);
    });
  },
);
