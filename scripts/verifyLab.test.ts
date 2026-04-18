/**
 * Verifies every intraday-lab strategy with live Binance data, reports
 * which ones actually show positive out-of-sample edge.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  computeDowStats,
  computeHourDowMatrix,
  runHourDowStrategy,
  runHourDowWalkForward,
  runTrendFilteredHourStrategy,
  runVolFilteredHourStrategy,
  runSpreadStrategy,
  runChampionStrategy,
  runMondayReversal,
  runTakerImbalance,
  MAKER_COSTS,
} from "../src/utils/intradayLab";
import {
  computeHourStats,
  runHourStrategyWalkForward,
} from "../src/utils/hourOfDayStrategy";

describe("intraday lab (live Binance)", () => {
  it("tests every variant", { timeout: 240_000 }, async () => {
    const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    // ---------------------------------------------------------------------
    // 1. Day-of-week seasonality (1d bars)
    // ---------------------------------------------------------------------
    console.log("\n=== 1. DAY-OF-WEEK (1d bars) ===");
    for (const sym of syms) {
      const daily = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1d",
        targetCount: 3000,
      });
      const stats = computeDowStats(daily);
      const sig = stats.filter((s) => s.significant);
      console.log(
        `${sym}: ${daily.length} days. Significant DOWs: ` +
          (sig
            .map(
              (s) =>
                `${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][s.dayOfWeek]}:${(s.meanReturnPct * 100).toFixed(3)}%(t=${s.tStat.toFixed(2)})`,
            )
            .join(" ") || "(none significant)"),
      );
    }

    // ---------------------------------------------------------------------
    // 2. Hour × Day-of-week combined (1h bars, 168 buckets)
    // ---------------------------------------------------------------------
    console.log("\n=== 2. HOUR × DOW (168 buckets, walk-forward) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const oos = runHourDowWalkForward(h, 0.5, {
        topK: 5,
        bottomK: 5,
        minTStat: 2,
        costs: MAKER_COSTS,
      });
      console.log(
        `${sym}: trades=${oos.totalTrades} ret=${(oos.netReturnPct * 100).toFixed(1)}% WR=${(oos.winRate * 100).toFixed(0)}% sharpe=${oos.sharpe.toFixed(2)} dd=${(oos.maxDrawdownPct * 100).toFixed(1)}%`,
      );
      const top = oos.bestBuckets
        .slice(0, 3)
        .map(
          (b) =>
            `${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][b.dow]}${b.hour}h:${(b.mean * 100).toFixed(2)}%`,
        )
        .join(" ");
      const bot = oos.worstBuckets
        .slice(0, 3)
        .map(
          (b) =>
            `${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][b.dow]}${b.hour}h:${(b.mean * 100).toFixed(2)}%`,
        )
        .join(" ");
      console.log(`  top: ${top}  bottom: ${bot}`);
    }

    // ---------------------------------------------------------------------
    // 3. Trend-filtered hour-of-day
    // ---------------------------------------------------------------------
    console.log(
      "\n=== 3. TREND-FILTERED HOUR-OF-DAY (50h-SMA, top-5 no-sig) ===",
    );
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const train = h.slice(0, Math.floor(h.length / 2));
      const test = h.slice(Math.floor(h.length / 2));
      const stats = computeHourStats(train);
      const sorted = [...stats].sort(
        (a, b) => b.meanReturnPct - a.meanReturnPct,
      );
      // Top-5 / bottom-5 regardless of significance — for symbols where
      // individual hours don't quite reach |t|>2 but the pattern is still
      // exploitable when combined with a trend filter.
      const bestHours = sorted.slice(0, 5).map((s) => s.hourUtc);
      const worstHours = sorted.slice(-5).map((s) => s.hourUtc);
      const makerRep = runTrendFilteredHourStrategy(test, {
        longHours: bestHours,
        shortHours: worstHours,
        smaPeriodBars: 50,
        costs: MAKER_COSTS,
      });
      const takerRep = runTrendFilteredHourStrategy(test, {
        longHours: bestHours,
        shortHours: worstHours,
        smaPeriodBars: 50,
      });
      console.log(
        `${sym} maker: trades=${makerRep.totalTrades} ret=${(makerRep.netReturnPct * 100).toFixed(1)}% WR=${(makerRep.winRate * 100).toFixed(0)}% sharpe=${makerRep.sharpe.toFixed(2)} dd=${(makerRep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
      console.log(
        `${sym} taker: trades=${takerRep.totalTrades} ret=${(takerRep.netReturnPct * 100).toFixed(1)}% WR=${(takerRep.winRate * 100).toFixed(0)}% sharpe=${takerRep.sharpe.toFixed(2)} dd=${(takerRep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    console.log("\n=== 3b. TREND-FILTERED with 200h-SMA (slower trend) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const train = h.slice(0, Math.floor(h.length / 2));
      const test = h.slice(Math.floor(h.length / 2));
      const stats = computeHourStats(train);
      const sorted = [...stats].sort(
        (a, b) => b.meanReturnPct - a.meanReturnPct,
      );
      const bestHours = sorted.slice(0, 5).map((s) => s.hourUtc);
      const worstHours = sorted.slice(-5).map((s) => s.hourUtc);
      const rep = runTrendFilteredHourStrategy(test, {
        longHours: bestHours,
        shortHours: worstHours,
        smaPeriodBars: 200,
        costs: MAKER_COSTS,
      });
      console.log(
        `${sym}: trades=${rep.totalTrades} ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    // ---------------------------------------------------------------------
    // 4. Vol-filtered hour-of-day
    // ---------------------------------------------------------------------
    console.log("\n=== 4. VOL-FILTERED HOUR-OF-DAY (ATR/price 0.3-1.5%) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const train = h.slice(0, Math.floor(h.length / 2));
      const test = h.slice(Math.floor(h.length / 2));
      const stats = computeHourStats(train);
      const sorted = [...stats].sort(
        (a, b) => b.meanReturnPct - a.meanReturnPct,
      );
      const best = sorted
        .slice(0, 3)
        .filter((s) => s.significant)
        .map((s) => s.hourUtc);
      const worst = sorted
        .slice(-3)
        .filter((s) => s.significant)
        .map((s) => s.hourUtc);
      const rep = runVolFilteredHourStrategy(test, {
        longHours: best,
        shortHours: worst,
        atrBars: 14,
        minAtrPct: 0.003,
        maxAtrPct: 0.015,
        costs: MAKER_COSTS,
      });
      console.log(
        `${sym}: trades=${rep.totalTrades} ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    // ---------------------------------------------------------------------
    // 5. Cross-asset spread (SOL/BTC and ETH/BTC)
    // ---------------------------------------------------------------------
    console.log("\n=== 5. CROSS-ASSET SPREAD (1h bars, 20-bar lookback) ===");
    for (const num of ["ETHUSDT", "SOLUSDT"]) {
      const [a, b] = await Promise.all([
        loadBinanceHistory({
          symbol: num,
          timeframe: "1h",
          targetCount: 20000,
        }),
        loadBinanceHistory({
          symbol: "BTCUSDT",
          timeframe: "1h",
          targetCount: 20000,
        }),
      ]);
      const rep = runSpreadStrategy(a, b, {
        lookbackBars: 20,
        entryZ: 2.0,
        exitZ: 0.3,
        holdBarsMax: 48,
        costs: MAKER_COSTS,
      });
      console.log(
        `${num}/BTC: trades=${rep.trades.length} ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}% avgHold=${rep.avgHoldBars.toFixed(1)}bars`,
      );
    }

    // ---------------------------------------------------------------------
    // 6. Longer lookback spreads (research said 14d on daily)
    // ---------------------------------------------------------------------
    console.log("\n=== CHAMPION strategy (trend-filtered hour-of-day) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const cfgLS = {
        trainRatio: 0.5,
        topK: 5,
        bottomK: 5,
        smaPeriodBars: 50,
        costs: MAKER_COSTS,
        requireSignificance: false,
        longOnly: false,
      };
      const cfgLongOnly = { ...cfgLS, longOnly: true };

      const reversed = h.slice().reverse();
      const lsFwd = runChampionStrategy(h, cfgLS);
      const lsRev = runChampionStrategy(reversed, cfgLS);
      const loFwd = runChampionStrategy(h, cfgLongOnly);
      const loRev = runChampionStrategy(reversed, cfgLongOnly);
      console.log(
        `${sym} LONG+SHORT FWD: n=${lsFwd.totalTrades} ret=${(lsFwd.netReturnPct * 100).toFixed(1)}% sharpe=${lsFwd.sharpe.toFixed(2)} dd=${(lsFwd.maxDrawdownPct * 100).toFixed(1)}%`,
      );
      console.log(
        `${sym} LONG+SHORT REV: n=${lsRev.totalTrades} ret=${(lsRev.netReturnPct * 100).toFixed(1)}% sharpe=${lsRev.sharpe.toFixed(2)} dd=${(lsRev.maxDrawdownPct * 100).toFixed(1)}%`,
      );
      console.log(
        `${sym} LONG-ONLY  FWD: n=${loFwd.totalTrades} ret=${(loFwd.netReturnPct * 100).toFixed(1)}% sharpe=${loFwd.sharpe.toFixed(2)} dd=${(loFwd.maxDrawdownPct * 100).toFixed(1)}%`,
      );
      console.log(
        `${sym} LONG-ONLY  REV: n=${loRev.totalTrades} ret=${(loRev.netReturnPct * 100).toFixed(1)}% sharpe=${loRev.sharpe.toFixed(2)} dd=${(loRev.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    console.log("\n=== MONDAY REVERSAL (Aharon & Qadan 2022) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const rep = runMondayReversal(h);
      console.log(
        `${sym}: trades=${rep.trades.length} ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    console.log("\n=== TAKER-BUY-IMBALANCE (Easley/López de Prado 2024) ===");
    for (const sym of syms) {
      for (const tf of ["5m", "15m", "1h"] as const) {
        const count = tf === "5m" ? 20000 : tf === "15m" ? 20000 : 6000;
        const h = await loadBinanceHistory({
          symbol: sym,
          timeframe: tf,
          targetCount: count,
        });
        if (!h[0]?.takerBuyVolume) {
          console.log(`${sym} ${tf}: takerBuyVolume missing`);
          continue;
        }
        const rep = runTakerImbalance(h, {
          imbalanceThreshold: 0.62,
          maxBarReturn: 0.001,
          holdBars: 3,
          targetPct: 0.003,
          stopPct: 0.002,
          costs: MAKER_COSTS,
        });
        console.log(
          `${sym} ${tf}: trades=${rep.trades.length} ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% PF=${rep.profitFactor.toFixed(2)} sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
        );
      }
    }

    console.log("\n=== 6. SPREAD on 4h bars, 84-bar (14d) lookback ===");
    for (const num of ["ETHUSDT", "SOLUSDT"]) {
      const [a, b] = await Promise.all([
        loadBinanceHistory({
          symbol: num,
          timeframe: "4h",
          targetCount: 6000,
        }),
        loadBinanceHistory({
          symbol: "BTCUSDT",
          timeframe: "4h",
          targetCount: 6000,
        }),
      ]);
      const rep = runSpreadStrategy(a, b, {
        lookbackBars: 84, // 14 days on 4h
        entryZ: 2.0,
        exitZ: 0.5,
        holdBarsMax: 30,
        costs: MAKER_COSTS,
      });
      console.log(
        `${num}/BTC: trades=${rep.trades.length} ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}% avgHold=${rep.avgHoldBars.toFixed(1)}bars`,
      );
    }
  });
});
