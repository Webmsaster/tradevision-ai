/**
 * R29-Track-A: Fetch 5m Binance candles for the V5_TITANIUM 14-asset basket.
 * Saves to scripts/cache_bakeoff/<SYMBOL>_5m.json.
 *
 * 5 years × 365d × 24h × 12 (5m/h) = 525,600 bars per symbol.
 * 14 symbols × 525,600 ≈ 7.4M bars total.
 *
 * Binance kline endpoint = 1000 bars per request → 525 requests per symbol.
 * Rate limit ~1200 weight/min. Each kline request weight=2. Safe rate: ~400 req/min.
 */
import { writeFileSync, existsSync } from "node:fs";
import { loadBinanceHistory } from "../src/utils/historicalData";

const CACHE_DIR = "scripts/cache_bakeoff";

const SYMBOLS = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "AAVEUSDT",
  "XRPUSDT",
  "INJUSDT",
  "RUNEUSDT",
  "ETCUSDT",
  "SANDUSDT",
];

// Match the 30m cache horizon: ~5.13 years.
// 5m bars per 5.13 years = 539,000. Cap at 540k for safety margin.
const TARGET_COUNT = 540_000;

async function main() {
  for (const sym of SYMBOLS) {
    const path = `${CACHE_DIR}/${sym}_5m.json`;
    if (existsSync(path)) {
      console.log(`[skip ${sym}] already cached`);
      continue;
    }
    console.log(`[fetch ${sym}] target ${TARGET_COUNT} bars on 5m...`);
    const t0 = Date.now();
    try {
      const candles = await loadBinanceHistory({
        symbol: sym,
        timeframe: "5m",
        targetCount: TARGET_COUNT,
        maxPages: 600, // 600 × 1000 = 600k bars max headroom
      });
      const elapsed = Math.round((Date.now() - t0) / 1000);
      writeFileSync(path, JSON.stringify(candles));
      const startDate = new Date(candles[0]?.openTime ?? 0)
        .toISOString()
        .slice(0, 10);
      const endDate = new Date(candles[candles.length - 1]?.openTime ?? 0)
        .toISOString()
        .slice(0, 10);
      console.log(
        `[done ${sym}] ${candles.length} bars / ${startDate} → ${endDate} / ${elapsed}s`,
      );
    } catch (e) {
      console.error(`[error ${sym}] ${(e as Error).message}`);
    }
  }
  console.log("\nAll 5m fetches complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
