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
      const pair = row[mapping.pair]?.trim();
      const entryPrice = parseFloat(row[mapping.entryPrice]);
      const exitPrice = parseFloat(row[mapping.exitPrice]);
      const quantity = parseFloat(row[mapping.quantity]);

      // Filter out rows where essential fields are missing or invalid
      if (!pair || isNaN(entryPrice) || isNaN(exitPrice) || isNaN(quantity)) {
        return null;
      }

      // Parse direction -------------------------------------------------
      const rawDirection = (row[mapping.direction] ?? '').trim().toLowerCase();
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

/**
 * Parse Binance Futures trade history CSV rows into Trade objects.
 *
 * Binance exports one row per fill with columns like:
 *   Symbol, Side, Price, Quantity, Fee, Time, Realized Profit
 *
 * If the "Realized Profit" column exists we use it directly as PnL for each
 * row.  Otherwise we attempt basic entry/exit pairing by grouping rows per
 * Symbol+Side sequence.
 */
export function parseBinanceCSV(data: Record<string, string>[]): Trade[] {
  if (data.length === 0) return [];

  const hasRealizedProfit = Object.keys(data[0]).some(
    (k) => k.trim().toLowerCase() === 'realized profit'
  );

  if (hasRealizedProfit) {
    return parseBinanceWithRealizedProfit(data);
  }

  return parseBinanceGrouped(data);
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

/**
 * Resolve a column value from a row, trying an exact key first and falling
 * back to a case-insensitive match.
 */
function getColumn(row: Record<string, string>, key: string): string {
  if (row[key] !== undefined) return row[key];

  const lower = key.toLowerCase();
  const found = Object.keys(row).find((k) => k.trim().toLowerCase() === lower);
  return found ? row[found] : '';
}

/**
 * Parse Binance rows that include a "Realized Profit" column.
 * Each row with a non-zero realized profit is treated as a closed trade.
 */
function parseBinanceWithRealizedProfit(
  data: Record<string, string>[]
): Trade[] {
  return data
    .map((row): Trade | null => {
      const realizedProfit = parseFloat(getColumn(row, 'Realized Profit'));
      // Skip rows without meaningful realized profit data
      if (isNaN(realizedProfit) || realizedProfit === 0) return null;

      const pair = getColumn(row, 'Symbol').trim();
      const rawSide = getColumn(row, 'Side').trim().toLowerCase();
      const price = parseFloat(getColumn(row, 'Price'));
      const quantity = parseFloat(getColumn(row, 'Quantity'));
      const fee = parseFloat(getColumn(row, 'Fee')) || 0;
      const time = safeISODate(getColumn(row, 'Time'));

      if (!pair || isNaN(price) || isNaN(quantity)) return null;

      // For Binance, the "Side" on the closing fill is the opposite of the
      // position direction.  A SELL close means the position was LONG, etc.
      const direction: 'long' | 'short' =
        rawSide === 'sell' ? 'long' : 'short';

      // We only have one price from the close fill; approximate entry from PnL
      let entryPrice: number;
      if (direction === 'long') {
        // pnl ~ (exit - entry) * qty  =>  entry ~ exit - pnl/qty
        entryPrice =
          quantity !== 0 ? price - realizedProfit / quantity : price;
      } else {
        // pnl ~ (entry - exit) * qty  =>  entry ~ exit + pnl/qty
        entryPrice =
          quantity !== 0 ? price + realizedProfit / quantity : price;
      }

      const pnl = realizedProfit - fee;
      const invested = entryPrice * quantity;
      const pnlPercent = invested !== 0 ? (pnl / invested) * 100 : 0;
      // Note: for leveraged Binance trades, the actual margin used is invested/leverage,
      // so the real ROI% would be higher. Since Binance CSV doesn't include leverage info,
      // we use the notional value as base.

      return {
        id: uuidv4(),
        pair,
        direction,
        entryPrice,
        exitPrice: price,
        quantity,
        entryDate: time,
        exitDate: time,
        pnl,
        pnlPercent,
        fees: fee,
        notes: '',
        tags: [],
        leverage: 1,
        strategy: undefined,
      };
    })
    .filter((t): t is Trade => t !== null);
}

/**
 * Fallback Binance parser that groups rows by Symbol + Side into sequential
 * pairs (entry fill followed by exit fill).
 */
function parseBinanceGrouped(data: Record<string, string>[]): Trade[] {
  const trades: Trade[] = [];
  const openPositions: Map<
    string,
    { row: Record<string, string>; side: string }
  > = new Map();

  for (const row of data) {
    const pair = getColumn(row, 'Symbol').trim();
    const side = getColumn(row, 'Side').trim().toLowerCase();
    if (!pair || !side) continue;

    const key = `${pair}`;

    if (!openPositions.has(key)) {
      // First fill for this symbol -- treat as entry
      openPositions.set(key, { row, side });
    } else {
      // Second fill for this symbol -- treat as exit
      const entry = openPositions.get(key)!;
      openPositions.delete(key);

      const entryPrice = parseFloat(getColumn(entry.row, 'Price'));
      const exitPrice = parseFloat(getColumn(row, 'Price'));
      const quantity = parseFloat(getColumn(entry.row, 'Quantity'));
      const entryFee = parseFloat(getColumn(entry.row, 'Fee')) || 0;
      const exitFee = parseFloat(getColumn(row, 'Fee')) || 0;
      const fees = entryFee + exitFee;

      if (isNaN(entryPrice) || isNaN(exitPrice) || isNaN(quantity)) continue;

      const direction: 'long' | 'short' =
        entry.side === 'buy' ? 'long' : 'short';

      const entryDate = safeISODate(getColumn(entry.row, 'Time'));
      const exitDate = safeISODate(getColumn(row, 'Time'));

      const { pnl, pnlPercent } = calculatePnl({
        direction,
        entryPrice,
        exitPrice,
        quantity,
        leverage: 1,
        fees,
        pair,
        entryDate,
        exitDate,
        notes: '',
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
        notes: '',
        tags: [],
        leverage: 1,
        strategy: undefined,
      });
    }
  }

  return trades;
}
