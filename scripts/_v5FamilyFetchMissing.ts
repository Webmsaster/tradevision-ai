/**
 * Pre-fetch missing Binance 30m candles for V5-Family R58 re-validation.
 * Caches to scripts/cache_bakeoff/<SYMBOL>_30m.json so the runner can
 * read them synchronously.
 *
 * Targets ~5 years of 30m candles (= 87600 bars). Fetches in pages of 1000.
 */
import { writeFileSync, existsSync } from "node:fs";
import { loadBinanceHistory } from "../src/utils/historicalData";

const CACHE_DIR = "scripts/cache_bakeoff";

const MISSING_SYMBOLS = [
  "RUNEUSDT",
  "INJUSDT",
  "SANDUSDT",
  "ARBUSDT",
  "TRXUSDT",
  "ALGOUSDT",
  "NEARUSDT",
  "ATOMUSDT",
  "STXUSDT",
];

const TARGET_COUNT = 90000; // ~5.13 years of 30m bars

async function main() {
  for (const sym of MISSING_SYMBOLS) {
    const path = `${CACHE_DIR}/${sym}_30m.json`;
    if (existsSync(path)) {
      console.log(`[skip ${sym}] already cached`);
      continue;
    }
    console.log(`[fetch ${sym}] target ${TARGET_COUNT} bars on 30m...`);
    const t0 = Date.now();
    try {
      const candles = await loadBinanceHistory({
        symbol: sym,
        timeframe: "30m",
        targetCount: TARGET_COUNT,
        maxPages: 100, // 100 * 1000 = 100k bars max
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
  console.log("\nAll done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
