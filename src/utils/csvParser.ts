import type { Trade, CSVColumnMapping } from '@/types/trade';
import Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';
import { calculatePnl } from '@/utils/calculations';

/**
 * Parse a CSV File object using PapaParse with headers enabled.
 * Returns a Promise that resolves with the full ParseResult.
 */
export function parseCSVFile(
  file: File
): Promise<Papa.ParseResult<Record<string, string>>> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
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
 * Extract the column headers from a PapaParse result.
 */
export function getCSVHeaders(
  result: Papa.ParseResult<Record<string, string>>
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
  mapping: CSVColumnMapping
): Trade[] {
  return data
    .map((row): Trade | null => {
      const pair = sanitizeCSVField(row[mapping.pair] ?? '');
      const entryPrice = parseFloat(row[mapping.entryPrice]);
      const exitPrice = parseFloat(row[mapping.exitPrice]);
      const quantity = parseFloat(row[mapping.quantity]);

      // Filter out rows where essential fields are missing or invalid
      if (!pair || isNaN(entryPrice) || isNaN(exitPrice) || isNaN(quantity)) {
        return null;
      }

      // Parse direction -------------------------------------------------
      const rawDirection = sanitizeCSVField(row[mapping.direction] ?? '').toLowerCase();
      let direction: 'long' | 'short';
      if (rawDirection === 'long' || rawDirection === 'buy') {
        direction = 'long';
      } else if (rawDirection === 'short' || rawDirection === 'sell') {
        direction = 'short';
      } else {
        // Default to long when direction cannot be determined
        direction = 'long';
      }

      // Parse dates -----------------------------------------------------
      const entryDate = mapping.entryDate
        ? safeISODate(row[mapping.entryDate])
        : new Date().toISOString();
      const exitDate = mapping.exitDate
        ? safeISODate(row[mapping.exitDate])
        : new Date().toISOString();

      // Parse optional numeric fields -----------------------------------
      const leverage =
        mapping.leverage && !isNaN(parseFloat(row[mapping.leverage]))
          ? parseFloat(row[mapping.leverage])
          : 1;

      const fees =
        mapping.fees && !isNaN(parseFloat(row[mapping.fees]))
          ? parseFloat(row[mapping.fees])
          : 0;

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
        notes: '',
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
        notes: '',
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
  headers: string[]
): Partial<CSVColumnMapping> {
  const aliases: Record<keyof CSVColumnMapping, string[]> = {
    pair: ['pair', 'symbol', 'market', 'instrument', 'asset'],
    direction: ['direction', 'side', 'type', 'action'],
    entryPrice: [
      'entry_price',
      'entryprice',
      'entry',
      'open_price',
      'openprice',
      'buy_price',
    ],
    exitPrice: [
      'exit_price',
      'exitprice',
      'exit',
      'close_price',
      'closeprice',
      'sell_price',
    ],
    quantity: ['quantity', 'qty', 'amount', 'size', 'volume', 'lots'],
    entryDate: [
      'entry_date',
      'entrydate',
      'entry_time',
      'open_date',
      'open_time',
      'date',
    ],
    exitDate: [
      'exit_date',
      'exitdate',
      'exit_time',
      'close_date',
      'close_time',
    ],
    fees: ['fees', 'fee', 'commission', 'cost'],
    leverage: ['leverage', 'lev', 'multiplier'],
  };

  const mapping: Partial<CSVColumnMapping> = {};

  for (const [field, candidates] of Object.entries(aliases) as [
    keyof CSVColumnMapping,
    string[],
  ][]) {
    const match = headers.find((h) =>
      candidates.includes(h.trim().toLowerCase())
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
    pair: 'Symbol',
    direction: 'Side',
    entryPrice: 'Price',
    exitPrice: 'Price',
    quantity: 'Quantity',
    entryDate: 'Time',
    exitDate: 'Time',
    fees: 'Fee',
    leverage: '',
  },
  bybit: {
    pair: 'Symbol',
    direction: 'Side',
    entryPrice: 'Entry Price',
    exitPrice: 'Exit Price',
    quantity: 'Qty',
    entryDate: 'Created Time',
    exitDate: 'Closed Time',
    fees: 'Trading Fee',
    leverage: 'Leverage',
  },
  mt4: {
    pair: 'Symbol',
    direction: 'Type',
    entryPrice: 'Open Price',
    exitPrice: 'Close Price',
    quantity: 'Volume',
    entryDate: 'Open Time',
    exitDate: 'Close Time',
    fees: 'Commission',
    leverage: '',
  },
  generic: {
    pair: 'Pair',
    direction: 'Direction',
    entryPrice: 'Entry Price',
    exitPrice: 'Exit Price',
    quantity: 'Quantity',
    entryDate: 'Entry Date',
    exitDate: 'Exit Date',
    fees: 'Fees',
    leverage: 'Leverage',
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
 * Returns the current date/time if the input cannot be parsed.
 */
function safeISODate(raw: string | undefined): string {
  if (!raw || !raw.trim()) return new Date().toISOString();

  const date = new Date(raw.trim());
  if (isNaN(date.getTime())) return new Date().toISOString();

  return date.toISOString();
}

