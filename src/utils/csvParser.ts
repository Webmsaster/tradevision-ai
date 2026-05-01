import type { Trade, CSVColumnMapping } from "@/types/trade";
import Papa from "papaparse";
import { v4 as uuidv4 } from "uuid";
import { calculatePnl } from "@/utils/calculations";

/**
 * Parse a CSV File object using PapaParse with headers enabled.
 * Returns a Promise that resolves with the full ParseResult.
 */
export function parseCSVFile(
  file: File,
): Promise<Papa.ParseResult<Record<string, string>>> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      // Strip UTF-8 BOM (﻿) and whitespace from headers — Excel-exported
      // CSVs frequently include a BOM that breaks column matching.
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
  const lastComma = trimmed.lastIndexOf(",");
  const lastDot = trimmed.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    // EU format: "1.234,56" → "1234.56"
    normalized = trimmed.replace(/\./g, "").replace(",", ".");
  } else {
    // US format: "1,234.56" → "1234.56"
    normalized = trimmed.replace(/,/g, "");
  }
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
 * Safely convert a raw date string into an ISO-8601 string.
 * Returns null if the input cannot be parsed (callers must handle).
 * Previously fell silently to "now" — that hid CSV import errors and put
 * old trades on the import date, breaking equity curves.
 */
function safeISODate(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const date = new Date(raw.trim());
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}
