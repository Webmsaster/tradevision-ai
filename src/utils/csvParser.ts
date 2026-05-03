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
      // Strip UTF-8 BOM (U+FEFF) and whitespace from headers — Excel-exported
      // CSVs frequently include a BOM that breaks column matching.
      // eslint-disable-next-line no-irregular-whitespace
      transformHeader: (h) => h.replace(/^﻿/, "").trim(),
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
 * Map an array of raw CSV row objects to Trade objects using the provided
 * column mapping.  Rows that are missing essential fields (pair, entryPrice,
 * exitPrice, quantity) are silently filtered out.
 */
export function mapCSVToTrades(
  data: Record<string, string>[],
  mapping: CSVColumnMapping,
): Trade[] {
  return data
    .map((row): Trade | null => {
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
        return null;
      }

      // Parse direction -------------------------------------------------
      const rawDirection = sanitizeCSVField(
        row[mapping.direction] ?? "",
      ).toLowerCase();
      let direction: "long" | "short";
      if (rawDirection === "long" || rawDirection === "buy") {
        direction = "long";
      } else if (rawDirection === "short" || rawDirection === "sell") {
        direction = "short";
      } else {
        // Default to long when direction cannot be determined
        direction = "long";
      }

      // Parse dates -----------------------------------------------------
      // Empty value → fall back to "now" (caller didn't supply a date).
      // Non-empty but unparseable → drop the row (fail-loud, prevents stale
      // trades from being silently re-dated to the import time).
      const entryDateRaw = mapping.entryDate
        ? row[mapping.entryDate]?.trim()
        : "";
      let entryDate: string;
      if (!entryDateRaw) {
        entryDate = new Date().toISOString();
      } else {
        const parsed = safeISODate(entryDateRaw);
        if (!parsed) return null;
        entryDate = parsed;
      }
      const exitDateRaw = mapping.exitDate ? row[mapping.exitDate]?.trim() : "";
      let exitDate: string;
      if (!exitDateRaw) {
        exitDate = new Date().toISOString();
      } else {
        const parsed = safeISODate(exitDateRaw);
        if (!parsed) return null;
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

      return {
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
      };
    })
    .filter((t): t is Trade => t !== null);
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
 * silently parsed in the host's local timezone. The CSV import surface
 * still returns a single string here; the warning is logged once per
 * import session via console.warn so the user sees it without us having
 * to thread a return-tuple through every caller.
 */
let _dateWarningEmitted = false;
function safeISODate(raw: string | undefined): string | null {
  const { iso, warning } = normalizeDateToUTC(raw);
  if (iso && warning && !_dateWarningEmitted) {
    _dateWarningEmitted = true;
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        `[csvParser] Date string without timezone detected (e.g. "${raw}"). ` +
          `Coerced to UTC. Add a "Z" suffix or "+HH:MM" offset to silence this warning.`,
      );
    }
  }
  return iso;
}
