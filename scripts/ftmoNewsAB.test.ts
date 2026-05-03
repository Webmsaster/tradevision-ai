/**
 * News-Pause A/B Test on V5 Strategy.
 *
 * A: V5 OHNE News-Pause (newsFilter undefined)
 * B: V5 MIT News-Pause (synthetic FOMC/CPI/NFP/PPI events, ±60min buffer)
 *
 * The user requested asymmetric "30min before / 60min after". The engine
 * exposes only a symmetric ±bufferMinutes via isNewsBlackout(). To capture
 * the full requested post-news window we use the larger value (60 min) as
 * the symmetric buffer — this is conservative (blocks slightly more) and is
 * documented here.
 *
 * 9 native V5 cryptos (ETH, BTC, BNB, ADA, DOGE, AVAX, LTC, BCH, LINK),
 * 2h timeframe, 30000-bar Binance history, walk-forward 30d window / 3d step.
 * Realistic FTMO costs are baked into V5's asset config (costBp/slippageBp/swapBpPerDay).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { getMacroEvents } from "./_macroEvents";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12; // 2h timeframe → 12 bars / day
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/NEWS_AB_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe(
  "FTMO News A/B — V5 with vs without news-pause",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs A/B over walk-forward windows", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `NEWS_AB START ${new Date().toISOString()}\n`);
      log(`Variant A: V5 — newsFilter: undefined`);
      log(`Variant B: V5 — newsFilter: synthetic FOMC/CPI/NFP/PPI ±60min`);

      // Load 30000 2h bars per asset
      const data: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        log(`  loaded ${s}: ${data[s].length} bars`);
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of SOURCES) data[s] = data[s].slice(-n);
      log(
        `  aligned: ${n} bars / asset (~${(n / BARS_PER_DAY / 365).toFixed(2)}y)`,
      );

      // Synthetic high-impact USD macro events
      const macroEvents = getMacroEvents();
      log(
        `  macro events: ${macroEvents.length} (FOMC + CPI + PPI + NFP, 2020-2026)`,
      );

      // Build A and B configs
      const cfgA: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        newsFilter: undefined,
      };
      const cfgB: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        newsFilter: {
          events: macroEvents,
          bufferMinutes: 60,
        },
      };

      // Walk-forward sweep — same window/step pattern as production sweeps
      const winBars = 30 * BARS_PER_DAY; // 30 days
      const stepBars = 3 * BARS_PER_DAY; // step 3 days

      let passA = 0,
        passB = 0,
        total = 0;
      let tlA = 0,
        tlB = 0;
      let tradesA = 0,
        tradesB = 0;
      const reasonsA: Record<string, number> = {};
      const reasonsB: Record<string, number> = {};

      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);

        const rA = runFtmoDaytrade24h(sub, cfgA);
        const rB = runFtmoDaytrade24h(sub, cfgB);

        if (rA.passed) passA++;
        if (rB.passed) passB++;
        if (rA.reason === "total_loss") tlA++;
        if (rB.reason === "total_loss") tlB++;
        tradesA += rA.trades.length;
        tradesB += rB.trades.length;
        reasonsA[rA.reason] = (reasonsA[rA.reason] || 0) + 1;
        reasonsB[rB.reason] = (reasonsB[rB.reason] || 0) + 1;
        total++;

        if (total % 50 === 0) {
          log(
            `  ${total} windows: A=${((passA / total) * 100).toFixed(2)}% B=${((passB / total) * 100).toFixed(2)}% Δ=${(((passB - passA) / total) * 100).toFixed(2)}pp`,
          );
        }
      }

      const passRateA = passA / total;
      const passRateB = passB / total;
      const deltaPP = (passRateB - passRateA) * 100;
      const tradeDelta = tradesA - tradesB; // approximation: trades blocked by news
      const tradeBlockPct = tradesA > 0 ? (tradeDelta / tradesA) * 100 : 0;

      log(`\n========== NEWS A/B RESULT ==========`);
      log(`Total windows: ${total}`);
      log(
        `Variant A (no news): ${passA}/${total} = ${(passRateA * 100).toFixed(2)}% pass / TL=${tlA}`,
      );
      log(
        `Variant B (with news): ${passB}/${total} = ${(passRateB * 100).toFixed(2)}% pass / TL=${tlB}`,
      );
      log(
        `Δ pass-rate: ${deltaPP > 0 ? "+" : ""}${deltaPP.toFixed(2)}pp (B - A)`,
      );
      log(`Δ total-loss: ${tlB - tlA > 0 ? "+" : ""}${tlB - tlA} (B - A)`);
      log(`Total trades A: ${tradesA}`);
      log(`Total trades B: ${tradesB}`);
      log(
        `Trades blocked by news: ${tradeDelta} (~${tradeBlockPct.toFixed(2)}%)`,
      );
      log(`Reasons A: ${JSON.stringify(reasonsA)}`);
      log(`Reasons B: ${JSON.stringify(reasonsB)}`);

      let verdict: string;
      if (deltaPP < -1) {
        verdict = `News-Pause SCHADET (Δ ${deltaPP.toFixed(2)}pp ≤ -1pp). EMPFEHLUNG: News-Pause aus dem Live-Bot ENTFERNEN.`;
      } else if (deltaPP > 1) {
        verdict = `News-Pause HILFT (Δ ${deltaPP.toFixed(2)}pp ≥ +1pp). EMPFEHLUNG: News-Pause BEHALTEN.`;
      } else {
        verdict = `News-Pause NEUTRAL (|Δ|=${Math.abs(deltaPP).toFixed(2)}pp ≤ 1pp). Kein klares Signal — Status quo akzeptabel.`;
      }
      log(`\nVERDICT (60min buffer): ${verdict}`);

      // Sanity-check sweep: aggressive buffer sizes to test robustness of verdict
      log(`\n========== Buffer-Sensitivity Sweep ==========`);
      for (const bufMin of [120, 240, 360]) {
        const cfgC: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
          newsFilter: { events: macroEvents, bufferMinutes: bufMin },
        };
        let pC = 0,
          tlC = 0,
          tradesC = 0;
        for (let s = 0; s + winBars <= n; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
          const r = runFtmoDaytrade24h(sub, cfgC);
          if (r.passed) pC++;
          if (r.reason === "total_loss") tlC++;
          tradesC += r.trades.length;
        }
        const ppC = pC / total;
        const dC = (ppC - passRateA) * 100;
        log(
          `  buf=${bufMin}min: ${pC}/${total} = ${(ppC * 100).toFixed(2)}% / TL=${tlC} / trades=${tradesC} (blocked: ${tradesA - tradesC}) / Δ=${dC > 0 ? "+" : ""}${dC.toFixed(2)}pp`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
