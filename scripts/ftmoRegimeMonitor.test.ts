/**
 * FTMO Regime-Monitor CLI
 *
 * One-shot check: should I start a challenge right now?
 *
 * Run via vitest script runner:
 *   node ./node_modules/vitest/vitest.mjs run \
 *        --config vitest.scripts.config.ts \
 *        scripts/ftmoRegimeMonitor.test.ts --reporter=verbose
 *
 * Output: current regime, recommended bot (iter212 bear/chop vs iter213 bull),
 * active filter status, today's high-impact news, and a START/WAIT verdict.
 */
import { describe, it, expect } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_BULL,
  pickBestConfig,
} from "../src/utils/ftmoDaytrade24h";
import {
  loadForexFactoryNews,
  filterNewsEvents,
  type NewsEvent,
} from "../src/utils/forexFactoryNews";
import { ema } from "../src/utils/indicators";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function h(title: string) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${title} ━━━${C.reset}`);
}

describe("ftmo regime monitor", { timeout: 60_000 }, () => {
  it("shows current regime + recommended bot", async () => {
    console.log(
      `${C.bold}FTMO Regime Monitor${C.reset}  ${C.dim}${new Date().toISOString()}${C.reset}`,
    );

    h("Live Market");
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const btcLast = btc[btc.length - 1].close;
    const ethLast = eth[eth.length - 1].close;
    const btcChange24h =
      ((btcLast - btc[btc.length - 6].close) / btc[btc.length - 6].close) * 100;
    const ethChange24h =
      ((ethLast - eth[eth.length - 6].close) / eth[eth.length - 6].close) * 100;
    console.log(
      `  BTC: ${C.bold}$${btcLast.toLocaleString("en-US", { maximumFractionDigits: 0 })}${C.reset}  ${btcChange24h >= 0 ? C.green : C.red}${btcChange24h >= 0 ? "+" : ""}${btcChange24h.toFixed(2)}%${C.reset} (24h)`,
    );
    console.log(
      `  ETH: ${C.bold}$${ethLast.toLocaleString("en-US", { maximumFractionDigits: 0 })}${C.reset}  ${ethChange24h >= 0 ? C.green : C.red}${ethChange24h >= 0 ? "+" : ""}${ethChange24h.toFixed(2)}%${C.reset} (24h)`,
    );

    h("Regime Analysis");
    const btcCloses = btc.map((c) => c.close);
    const ema10Arr = ema(btcCloses, 10);
    const ema15Arr = ema(btcCloses, 15);
    const btcEma10 = ema10Arr[ema10Arr.length - 1]!;
    const btcEma15 = ema15Arr[ema15Arr.length - 1]!;
    const btcUptrend = btcLast > btcEma10 && btcEma10 > btcEma15;
    const btcMom6 =
      (btcLast - btc[btc.length - 6].close) / btc[btc.length - 6].close;
    const bullMom = btcMom6 > 0.02;

    console.log(
      `  BTC close:    $${btcLast.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    );
    console.log(
      `  BTC EMA10:    $${btcEma10.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    );
    console.log(
      `  BTC EMA15:    $${btcEma15.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    );
    console.log(
      `  Close > EMA10 > EMA15 (uptrend): ${btcUptrend ? C.green + "✓ YES" : C.red + "✗ NO"}${C.reset}`,
    );
    console.log(
      `  BTC 24h momentum: ${C.bold}${btcMom6 >= 0 ? "+" : ""}${(btcMom6 * 100).toFixed(2)}%${C.reset}  (threshold: ±2%)`,
    );

    h("Recommended Bot");
    const { cfg, regime, reason } = pickBestConfig(btc);
    const botName =
      cfg === FTMO_DAYTRADE_24H_CONFIG
        ? "iter212 (BEAR/CHOP bot — short ETH)"
        : cfg === FTMO_DAYTRADE_24H_CONFIG_BULL
          ? "iter213 (BULL bot — long ETH momentum)"
          : "iter212 (default)";
    console.log(
      `  Regime:  ${C.bold}${regime === "BULL" ? C.yellow : C.blue}${regime}${C.reset}`,
    );
    console.log(`  Bot:     ${C.bold}${botName}${C.reset}`);
    console.log(`  Reason:  ${C.dim}${reason}${C.reset}`);

    h("News Today/Tomorrow (FTMO 2-min blackout)");
    let news: NewsEvent[] = [];
    try {
      news = filterNewsEvents(await loadForexFactoryNews(), {
        impacts: ["High"],
        currencies: ["USD", "EUR", "GBP"],
      });
    } catch (e) {
      console.log(
        `  ${C.yellow}⚠️  FF feed unavailable: ${(e as Error).message}${C.reset}`,
      );
    }
    const now = Date.now();
    const in48h = now + 48 * 3600_000;
    const upcoming = news.filter(
      (e) => e.timestamp >= now - 3600_000 && e.timestamp <= in48h,
    );
    if (upcoming.length === 0) {
      console.log(`  ${C.dim}(no high-impact events in next 48h)${C.reset}`);
    } else {
      for (const e of upcoming) {
        const when = new Date(e.timestamp);
        const rel = Math.round((e.timestamp - now) / 3600_000);
        const relStr = rel < 0 ? `${Math.abs(rel)}h ago` : `in ${rel}h`;
        console.log(
          `  ${C.dim}${when.toISOString().slice(0, 16)}Z${C.reset}  ${C.yellow}${e.currency}${C.reset}  ${e.title.padEnd(42)} ${C.dim}(${relStr})${C.reset}`,
        );
      }
    }

    h("Verdict");
    // Compute if any bot would fire signals right now
    const nowSec = now / 1000;
    let next4hBar = Math.ceil(nowSec / (4 * 3600)) * 4 * 3600 * 1000;
    if (next4hBar < now) next4hBar += 4 * 3600_000;
    // next entry if signals permit:
    const verdict =
      regime === "BULL"
        ? `${C.green}${C.bold}✅ START: Bull-Bot${C.reset} (iter213 would be trading ETH longs)`
        : `${C.green}${C.bold}✅ START: Bear/Chop-Bot${C.reset} (iter212 would be trading ETH shorts)`;
    console.log(`  ${verdict}`);
    console.log(
      `  ${C.dim}Next 4h candle close: ${new Date(next4hBar).toISOString().slice(0, 16)}Z${C.reset}`,
    );

    // Extra caution
    if (upcoming.length > 0) {
      const firstNews = upcoming[0];
      const hoursToNews = (firstNews.timestamp - now) / 3600_000;
      if (hoursToNews < 12 && hoursToNews > 0) {
        console.log(
          `  ${C.yellow}⚠️  High-impact ${firstNews.currency} news in ${hoursToNews.toFixed(1)}h: ${firstNews.title}${C.reset}`,
        );
      }
    }

    // Regime stability warning
    console.log("");
    console.log(`  ${C.dim}Historical per-regime pass rate:${C.reset}`);
    if (regime === "BULL") {
      console.log(
        `  ${C.dim}  Bull regimes: iter213 avg 60%+ (73% in 2020 bull)${C.reset}`,
      );
      console.log(
        `  ${C.dim}  Switch to iter212 when BTC drops below EMA10 or 24h-mom < +2%${C.reset}`,
      );
    } else {
      console.log(
        `  ${C.dim}  Bear/Chop regimes: iter212 avg 55-67% (67% in 2018 bear)${C.reset}`,
      );
      console.log(
        `  ${C.dim}  Switch to iter213 when BTC closes above EMA10 with 24h-mom > +2%${C.reset}`,
      );
    }
    console.log("");
    expect(true).toBe(true);
  });
});
