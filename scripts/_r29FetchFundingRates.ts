/**
 * R29-R7: fetch Binance Futures funding-rate history for the 9 R28_V6 assets.
 * Cache to scripts/cache_bakeoff/{SYMBOL}_funding.json.
 *
 * Funding-rate is published every 8h (3/day). 5.7y * 3 = ~6300 records per asset.
 * Binance public API limit = 1000 per request → ~7 paginated calls per asset.
 *
 * Endpoint: GET https://fapi.binance.com/fapi/v1/fundingRate
 *   ?symbol=BTCUSDT&startTime=<ms>&endTime=<ms>&limit=1000
 * Returns: [{ symbol, fundingTime, fundingRate, markPrice }, ...]
 */
import { writeFileSync, existsSync } from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
const SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
];

// Cover full candle range with buffer.
const START_MS = Date.parse("2020-01-01T00:00:00Z");
const END_MS = Date.now();

interface FundingRow {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

async function fetchPage(
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<FundingRow[]> {
  const url =
    `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}` +
    `&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as FundingRow[];
}

async function fetchAll(symbol: string): Promise<FundingRow[]> {
  const all: FundingRow[] = [];
  let cursor = START_MS;
  while (cursor < END_MS) {
    const page = await fetchPage(symbol, cursor, END_MS);
    if (page.length === 0) break;
    all.push(...page);
    const last = page[page.length - 1]!.fundingTime;
    if (last <= cursor) break; // safety guard
    cursor = last + 1;
    if (page.length < 1000) break; // last page
    await new Promise((r) => setTimeout(r, 250)); // gentle rate-limit
  }
  return all;
}

async function main() {
  for (const sym of SYMBOLS) {
    const path = `${CACHE_DIR}/${sym}_funding.json`;
    if (existsSync(path)) {
      console.log(`[skip ${sym}] already cached`);
      continue;
    }
    console.log(`[fetch ${sym}] funding-rate history...`);
    const t0 = Date.now();
    try {
      const rows = await fetchAll(sym);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      // Compact: only keep [fundingTime, fundingRate as float]
      const compact = rows.map((r) => ({
        t: r.fundingTime,
        r: parseFloat(r.fundingRate),
      }));
      writeFileSync(path, JSON.stringify(compact));
      const start =
        rows.length > 0
          ? new Date(rows[0]!.fundingTime).toISOString().slice(0, 10)
          : "n/a";
      const end =
        rows.length > 0
          ? new Date(rows[rows.length - 1]!.fundingTime)
              .toISOString()
              .slice(0, 10)
          : "n/a";
      console.log(
        `[done ${sym}] ${rows.length} rows / ${start} → ${end} / ${elapsed}s`,
      );
    } catch (e) {
      console.error(`[error ${sym}] ${(e as Error).message}`);
    }
  }
  console.log("\nAll funding rates fetched.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
