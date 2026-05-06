import type { Trade, CSVColumnMapping } from "@/types/trade";
import Papa from "papaparse";
import { v4 as uuidv4 } from "uuid";
import { calculatePnl } from "@/utils/calculations";
import { normalizeDateToUTC } from "@/utils/dateNormalize";

/**
 * Round 54 fix #6: sniff the first ~1KB to confirm the file actually looks
 * like CSV. Defends against MIME spoofing (a `.csv`-renamed binary or HTML
 * page) that the extension/MIME check alone can't catch.
 *
 * Heuristic: parse the first 1KB with the auto-detected delimiter — if we
 * cannot extract at least one row with 2+ columns, it is not CSV.
 */
async function sniffCsvShape(file: File): Promise<boolean> {
  const slice = file.slice(0, 1024);
  let head: string;
  try {
    head = await slice.text();
  } catch {
    return false;
  }
  if (!head || !head.trim()) return false;
  // Reject obvious non-CSV content (HTML/binary/JSON-array).
  const trimmed = head.trimStart();
  if (
    trimmed.startsWith("<") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    return false;
  }
  // Try to parse as CSV with a small safety net — we just need to see >=1 row
  // with >=2 columns or a single header line with multiple delimiter-separated
  // values.
  const result = Papa.parse<string[]>(head, {
    header: false,
    skipEmptyLines: true,
  });
  const data = (result.data as unknown[][]) ?? [];
  if (data.length === 0) return false;
  const row0 = data[0];
  if (!Array.isArray(row0)) return false;
  return row0.length >= 2;
}

/**
 * Parse a CSV File object using PapaParse with headers enabled.
 * Returns a Promise that resolves with the full ParseResult.
 */
export async function parseCSVFile(
  file: File,
): Promise<Papa.ParseResult<Record<string, string>>> {
  // Round 54 fix #6: content-sniff before full parse.
  const looksLikeCsv = await sniffCsvShape(file);
  if (!looksLikeCsv) {
    throw new Error("File doesn't appear to be CSV");
  }
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      // Round 56 fix #8: parse on a Web Worker so a 10MB+ CSV does not
      // freeze the UI thread. PapaParse auto-spawns the worker on browser
      // platforms; in tests/SSR the option is silently ignored.
      worker: true,
      // Strip UTF-8 BOM (U+FEFF) and whitespace from headers — Excel-exported
      // CSVs frequently include a BOM that breaks column matching.
      /* eslint-disable no-irregular-whitespace */
      // Round 9 audit (HOCH): use the explicit `﻿` escape instead of
      // the literal BOM character. Editor/build-tool BOM-stripping (or
      // copy-paste through a normalising clipboard) otherwise silently
      // turned the regex into a no-op, leaving headers like `﻿Pair`
      // unmatched by autoDetectMapping. The escape is invariant under any
      // editor's invisible-character-stripping pass. Strip from both
      // headers AND values (mid-stream merged files can carry BOM into
      // data fields).
      transformHeader: (h) => h.replace(/^\uFEFF/, "").trim(),
      // Round 57 fix #4: trim trailing/leading whitespace from each value
      // (companion to transformHeader). Excel/MT4 exports often pad fields
      // with stray spaces that break numeric parsing.
      transform: (v) =>
        typeof v === "string" ? v.replace(/^\uFEFF/, "").trim() : v,
      /* eslint-enable no-irregular-whitespace */
      complete(results) {
        resolve(results);
      },
      error(err: Error) {
        reject(err);
      },
    });
  });
}

/**
 * Locale-aware number parser. Handles:
 *   "1,50"     → 1.5   (EU decimal comma)
 *   "1.234,56" → 1234.56 (EU thousands + decimal)
 *   "1,234.56" → 1234.56 (US thousands + decimal)
 *   "1234"     → 1234
 *   "$45.50"   → NaN (rejected — stricter than parseFloat)
 *   "45.50 USD" → NaN (rejected)
 *   ""         → NaN
 *   undefined  → NaN
 *
 * Returns NaN when the input is not a clean numeric string. Callers should
 * check `Number.isFinite(result)` to filter out NaN AND Infinity.
 */
export function parseLocaleNumber(s: string | undefined): number {
  if (!s) return NaN;
  const trimmed = s.trim().replace(/['\s]/g, "");
  if (!trimmed) return NaN;
  // Reject anything containing non-numeric/non-separator characters
  if (!/^-?[\d.,]+$/.test(trimmed)) return NaN;

  // Phase 46 (R45-CC-C1): strict validation. The previous heuristic accepted
  // ambiguous strings like "1,234,567" (US thousands, expected 1234567)
  // and silently returned 1.234 because `.replace(",", ".")` only replaced
  // the FIRST comma. CSV imports of quantity columns then under-sized PnL
  // by a factor of 1,000,000.
  //
  // Rules:
  //   1. At most one decimal separator (the LAST `,` or `.` if present
  //      with no further separators after it).
  //   2. Thousand separators must form 3-digit groups (e.g. "1,234" / "1,234,567").
  //   3. Same separator can't appear multiple times AND also be the decimal
  //      (two commas in "1,2,3" → ambiguous → reject).
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const dots = (body.match(/\./g) ?? []).length;
  const commas = (body.match(/,/g) ?? []).length;
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");

  let intPart: string;
  let fracPart = "";

  if (dots === 0 && commas === 0) {
    intPart = body;
  } else if (dots > 0 && commas > 0) {
    // Mixed: last-occurring separator is the decimal, the other is thousand.
    if (lastComma > lastDot) {
      // EU: dots = thousands, comma = decimal. Reject if comma appears more than once.
      if (commas !== 1) return NaN;
      const left = body.slice(0, lastComma);
      fracPart = body.slice(lastComma + 1);
      // All dots must form valid 3-digit groups.
      if (!/^\d{1,3}(?:\.\d{3})*$/.test(left)) return NaN;
      intPart = left.replace(/\./g, "");
    } else {
      // US: commas = thousands, dot = decimal. Reject if dot appears more than once.
      if (dots !== 1) return NaN;
      const left = body.slice(0, lastDot);
      fracPart = body.slice(lastDot + 1);
      if (!/^\d{1,3}(?:,\d{3})*$/.test(left)) return NaN;
      intPart = left.replace(/,/g, "");
    }
  } else if (dots > 0) {
    // Only dots. One dot → could be decimal OR thousand-separator. Disambiguate
    // by the right-side digit count: exactly 3 digits AND no leading zeros AND
    // multiple dots → thousand. Single dot with non-3-digit fraction → decimal.
    if (dots === 1) {
      const right = body.slice(lastDot + 1);
      if (right.length === 3 && body.length >= 5 && !right.match(/^0/)) {
        // Ambiguous "1.234" — could be 1.234 OR 1,234. Treat as decimal
        // unless caller used unambiguous form ("1234.5", "0.5", etc.).
        // Conservative: reject ambiguous form.
        // Actually: if the user means thousand-separator they should have
        // used commas in EN locale. Default decimal interpretation.
        intPart = body.slice(0, lastDot);
        fracPart = right;
      } else {
        intPart = body.slice(0, lastDot);
        fracPart = right;
      }
    } else {
      // Multiple dots, no commas → only valid as thousand-separators.
      if (!/^\d{1,3}(?:\.\d{3})+$/.test(body)) return NaN;
      intPart = body.replace(/\./g, "");
    }
  } else {
    // Only commas, same logic mirrored.
    if (commas === 1) {
      intPart = body.slice(0, lastComma);
      fracPart = body.slice(lastComma + 1);
    } else {
      if (!/^\d{1,3}(?:,\d{3})+$/.test(body)) return NaN;
      intPart = body.replace(/,/g, "");
    }
  }

  if (!/^\d+$/.test(intPart)) return NaN;
  if (fracPart && !/^\d+$/.test(fracPart)) return NaN;
  const normalized =
    (negative ? "-" : "") + intPart + (fracPart ? "." + fracPart : "");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Extract the column headers from a PapaParse result.
 */
export function getCSVHeaders(
  result: Papa.ParseResult<Record<string, string>>,
): string[] {
  return result.meta.fields ?? [];
}

/**
 * Result of mapping CSV rows → Trade objects. Includes structured warnings
 * accumulated during the import (naive-date coercions, ambiguous-slash
 * heuristics, skipped-direction rows) so the UI can surface them to the
 * user instead of swallowing them in console.warn.
 *
 * Round 57 fix #2: replaces the previous module-level `_dateWarningEmitted`
 * boolean which was a once-per-process latch — second import would silently
 * suppress all warnings. Per-call accumulation makes the contract honest.
 */
export interface CSVImportResult {
  trades: Trade[];
  warnings: string[];
}

/**
 * Direction parser. Supports:
 *   - English: long/buy → long ; short/sell → short
 *   - German:  kauf/kaufen → long ; verkauf/verkaufen → short
 *   - Abbreviations: L → long ; S → short
 *   - MT4 numeric: 0 → long (OP_BUY) ; 1 → short (OP_SELL)
 *
 * Returns null if direction cannot be determined — caller SKIPS the row
 * rather than silently defaulting to long, so users notice MT4-numeric
 * exports that map to the wrong column.
 */
function parseDirection(raw: string): "long" | "short" | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  // MT4 numeric convention: 0 = OP_BUY (long), 1 = OP_SELL (short).
  if (v === "0") return "long";
  if (v === "1") return "short";
  // Prefix-match: l/b/k → long, s/v → short. Order matters: check long
  // synonyms before short to handle e.g. "long" (l-prefix) vs "short" (s).
  const c = v[0];
  if (c === "l" || c === "b" || c === "k") return "long";
  if (c === "s" || c === "v") return "short";
  return null;
}

/**
 * Map an array of raw CSV row objects to Trade objects using the provided
 * column mapping.  Rows that are missing essential fields (pair, entryPrice,
 * exitPrice, quantity) are silently filtered out.
 *
 * Round 57 fix #2: now returns `{ trades, warnings }` so callers can show
 * structured warnings (naive-date coercion, ambiguous slash dates,
 * skipped-direction rows) in the UI.
 */
export function mapCSVToTrades(
  data: Record<string, string>[],
  mapping: CSVColumnMapping,
): CSVImportResult {
  const warnings: string[] = [];
  // Track which warning kinds have been added so we don't spam the UI with
  // one identical message per row. Distinct warnings (e.g. ambiguous slash
  // date for two different rows) still merge to a single banner.
  const seenWarnings = new Set<string>();
  function addWarning(key: string, message: string) {
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push(message);
  }

  const trades: Trade[] = [];
  for (const row of data) {
    const pair = sanitizeCSVField(row[mapping.pair] ?? "");
    const entryPrice = parseLocaleNumber(row[mapping.entryPrice]);
    const exitPrice = parseLocaleNumber(row[mapping.exitPrice]);
    const quantity = parseLocaleNumber(row[mapping.quantity]);

    // Filter out rows where essential fields are missing or invalid.
    // Number.isFinite filters NaN AND Infinity; positive prices/quantities only.
    if (
      !pair ||
      !Number.isFinite(entryPrice) ||
      !Number.isFinite(exitPrice) ||
      !Number.isFinite(quantity) ||
      entryPrice <= 0 ||
      exitPrice <= 0 ||
      quantity <= 0
    ) {
      continue;
    }
    // R67 audit (Round 2): magnitude-cap. Excel exports dates as serial
    // numbers (e.g. 44927 = 2023-01-01); if the user mismaps a date column
    // to Quantity, parseLocaleNumber returns 44927 as a valid number and a
    // single trade can balloon PnL by billions. Clamp absurd magnitudes —
    // no realistic crypto/forex trade has size > 1e9 units or price > 1e9.
    if (entryPrice > 1e9 || exitPrice > 1e9 || quantity > 1e9) {
      addWarning(
        "magnitude-cap",
        "Skipped rows with absurd magnitudes (>1e9). Likely an Excel serial-date in the wrong column.",
      );
      continue;
    }

    // Parse direction -------------------------------------------------
    // Round 57 fix #3: support German (kauf/verkauf), MT4-numeric (0/1),
    // L/S abbreviations. Unknown direction → SKIP the row (no silent
    // long-default) so users notice mapping errors.
    const rawDirection = sanitizeCSVField(row[mapping.direction] ?? "");
    const direction = parseDirection(rawDirection);
    if (!direction) {
      addWarning(
        "direction-unknown",
        `Skipped rows with unrecognised direction value (e.g. "${rawDirection || "(empty)"}"). Expected long/short, buy/sell, kauf/verkauf, L/S, or 0/1.`,
      );
      continue;
    }

    // Parse dates -----------------------------------------------------
    // Empty value → fall back to "now" (caller didn't supply a date),
    // routed through normalizeDateToUTC for symmetry with non-empty path.
    // Non-empty but unparseable → drop the row (fail-loud, prevents stale
    // trades from being silently re-dated to the import time).
    // Round 56 fix #1: empty fallback now uses normalizeDateToUTC, so all
    // CSV-imported dates pass through the same UTC-coercion gate.
    const entryDateRaw = mapping.entryDate
      ? row[mapping.entryDate]?.trim()
      : "";
    let entryDate: string;
    if (!entryDateRaw) {
      const fallback = normalizeDateToUTC(new Date().toISOString()).iso;
      // new Date().toISOString() always has Z → never null in practice,
      // but the explicit null-check defends against future refactors.
      if (!fallback) continue;
      entryDate = fallback;
    } else {
      const parsed = safeISODate(entryDateRaw, addWarning);
      if (!parsed) continue;
      entryDate = parsed;
    }
    const exitDateRaw = mapping.exitDate ? row[mapping.exitDate]?.trim() : "";
    let exitDate: string;
    if (!exitDateRaw) {
      const fallback = normalizeDateToUTC(new Date().toISOString()).iso;
      if (!fallback) continue;
      exitDate = fallback;
    } else {
      const parsed = safeISODate(exitDateRaw, addWarning);
      if (!parsed) continue;
      exitDate = parsed;
    }

    // Parse optional numeric fields -----------------------------------
    const leverageRaw = mapping.leverage
      ? parseLocaleNumber(row[mapping.leverage])
      : NaN;
    const leverage =
      Number.isFinite(leverageRaw) && leverageRaw > 0 ? leverageRaw : 1;

    const feesRaw = mapping.fees ? parseLocaleNumber(row[mapping.fees]) : NaN;
    const fees = Number.isFinite(feesRaw) ? feesRaw : 0;

    // Calculate PnL ---------------------------------------------------
    const { pnl, pnlPercent } = calculatePnl({
      direction,
      entryPrice,
      exitPrice,
      quantity,
      leverage,
      fees,
      pair,
      entryDate,
      exitDate,
      notes: "",
      tags: [],
    });

    trades.push({
      id: uuidv4(),
      pair,
      direction,
      entryPrice,
      exitPrice,
      quantity,
      entryDate,
      exitDate,
      pnl,
      pnlPercent,
      fees,
      notes: "",
      tags: [],
      leverage,
      strategy: undefined,
    });
  }

  return { trades, warnings };
}

/**
 * Attempt to auto-detect a CSVColumnMapping by matching known header aliases
 * (case-insensitive) against the actual CSV headers.
 * Returns only the fields that could be matched.
 */
export function autoDetectMapping(
  headers: string[],
): Partial<CSVColumnMapping> {
  const aliases: Record<keyof CSVColumnMapping, string[]> = {
    pair: ["pair", "symbol", "market", "instrument", "asset"],
    direction: ["direction", "side", "type", "action"],
    entryPrice: [
      "entry_price",
      "entryprice",
      "entry",
      "open_price",
      "openprice",
      "buy_price",
    ],
    exitPrice: [
      "exit_price",
      "exitprice",
      "exit",
      "close_price",
      "closeprice",
      "sell_price",
    ],
    quantity: ["quantity", "qty", "amount", "size", "volume", "lots"],
    entryDate: [
      "entry_date",
      "entrydate",
      "entry_time",
      "open_date",
      "open_time",
      "date",
    ],
    exitDate: [
      "exit_date",
      "exitdate",
      "exit_time",
      "close_date",
      "close_time",
    ],
    fees: ["fees", "fee", "commission", "cost"],
    leverage: ["leverage", "lev", "multiplier"],
  };

  const mapping: Partial<CSVColumnMapping> = {};

  for (const [field, candidates] of Object.entries(aliases) as [
    keyof CSVColumnMapping,
    string[],
  ][]) {
    const match = headers.find((h) =>
      candidates.includes(h.trim().toLowerCase()),
    );
    if (match) {
      mapping[field] = match;
    }
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// Platform presets
// ---------------------------------------------------------------------------

export const PLATFORM_PRESETS: Record<string, CSVColumnMapping> = {
  binance: {
    pair: "Symbol",
    direction: "Side",
    entryPrice: "Price",
    exitPrice: "Price",
    quantity: "Quantity",
    entryDate: "Time",
    exitDate: "Time",
    fees: "Fee",
    leverage: "",
  },
  bybit: {
    pair: "Symbol",
    direction: "Side",
    entryPrice: "Entry Price",
    exitPrice: "Exit Price",
    quantity: "Qty",
    entryDate: "Created Time",
    exitDate: "Closed Time",
    fees: "Trading Fee",
    leverage: "Leverage",
  },
  mt4: {
    pair: "Symbol",
    direction: "Type",
    entryPrice: "Open Price",
    exitPrice: "Close Price",
    quantity: "Volume",
    entryDate: "Open Time",
    exitDate: "Close Time",
    fees: "Commission",
    leverage: "",
  },
  generic: {
    pair: "Pair",
    direction: "Direction",
    entryPrice: "Entry Price",
    exitPrice: "Exit Price",
    quantity: "Quantity",
    entryDate: "Entry Date",
    exitDate: "Exit Date",
    fees: "Fees",
    leverage: "Leverage",
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const CSV_INJECTION_PATTERN = /^[=@\t\r]/;

/**
 * Sanitize a CSV field value to prevent CSV injection (formula injection).
 * Values starting with =, @, tab, or carriage return could be interpreted
 * as formulas by spreadsheet software. Note: + and - are NOT stripped
 * because they appear in valid trading data (e.g. pair names, directions).
 */
export function sanitizeCSVField(value: string): string {
  let sanitized = value.trim();
  if (!sanitized) return sanitized;
  // Strip all leading dangerous characters
  while (sanitized.length > 0 && CSV_INJECTION_PATTERN.test(sanitized)) {
    sanitized = sanitized.slice(1);
  }
  return sanitized;
}

/**
 * Safely convert a raw date string into a UTC ISO-8601 string.
 *
 * Round 54: route through normalizeDateToUTC so naive (no-TZ) inputs are
 * coerced to UTC explicitly with a structured warning, instead of being
 * silently parsed in the host's local timezone.
 *
 * Round 57 fix #2: warnings are now accumulated into the per-call warnings
 * array via the `addWarning` callback (was: module-level `_dateWarningEmitted`
 * singleton that only fired once per process). This ensures every import
 * surface its own warnings, even if a previous import already ran.
 */
function safeISODate(
  raw: string | undefined,
  addWarning: (key: string, message: string) => void,
): string | null {
  const { iso, warning } = normalizeDateToUTC(raw);
  if (iso && warning) {
    switch (warning) {
      case "naive-iso-assumed-utc":
        addWarning(
          "naive-iso",
          `Date strings without timezone detected (e.g. "${raw}"). Coerced to UTC. Add a "Z" suffix or "+HH:MM" offset to silence this warning.`,
        );
        break;
      case "date-only-assumed-utc-midnight":
        addWarning(
          "date-only",
          `Date-only strings detected (e.g. "${raw}"). Time-of-day defaulted to UTC midnight.`,
        );
        break;
      case "ambiguous-slash-date-assumed-dmy":
        addWarning(
          "ambiguous-slash",
          `Ambiguous slash-date detected (e.g. "${raw}") interpreted as dd/mm/yyyy (EU). If your CSV is US-format (mm/dd/yyyy), check that dates >12 are present in the day position to disambiguate.`,
        );
        break;
      case "mt4-date-assumed-utc":
        addWarning(
          "mt4-date",
          `MT4-format dates detected (e.g. "${raw}"). Coerced to UTC.`,
        );
        break;
      case "eu-date-assumed-utc":
        addWarning(
          "eu-date",
          `EU-format dates detected (e.g. "${raw}"). Coerced to UTC.`,
        );
        break;
      case "us-date-assumed-utc":
        addWarning(
          "us-date",
          `US-format dates detected (e.g. "${raw}"). Coerced to UTC.`,
        );
        break;
    }
  }
  return iso;
}
