// R67-RR1 audit fix: single source of truth for symbol normalisation.
//
// Previously two separate normalisers existed:
//   - csvParser.ts `normaliseSymbol` stripped `[\s\-_/]+`
//   - TradeForm.tsx `normalisePair` stripped `[\s\-_]+` (NOT `/`)
// → manual entry of `BTC/USDT` stayed `BTC/USDT`, CSV-import became
// `BTCUSDT`, and AI detector groupings split the same instrument across
// two stat-buckets.
//
// We canonicalise on EVERY write-path (CSV, manual form, content-hash
// for dedup) so legacy data with `BTC/USDT` doesn't fragment from
// post-fix `BTCUSDT`. Display layer can re-insert a `/` for known
// quote suffixes if desired (deferred).

const QUOTE_SUFFIXES = [
  "USDT",
  "USDC",
  "USD",
  "BUSD",
  "EUR",
  "GBP",
  "JPY",
  "BTC",
  "ETH",
];

export function normaliseSymbol(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-_/]+/g, "");
}

/**
 * Format-on-display helper: re-insert `/` between base and known quote
 * for nicer UI rendering (e.g. `BTCUSDT` → `BTC/USDT`).
 */
export function formatSymbolForDisplay(canonical: string): string {
  for (const suffix of QUOTE_SUFFIXES) {
    if (canonical.length > suffix.length && canonical.endsWith(suffix)) {
      return `${canonical.slice(0, -suffix.length)}/${suffix}`;
    }
  }
  return canonical;
}
