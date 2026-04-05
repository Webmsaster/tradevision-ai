import { Trade } from '@/types/trade';
import type { SupabaseClient } from '@supabase/supabase-js';

const STORAGE_KEY = 'trading-journal-trades';
const SCREENSHOTS_KEY = 'trading-journal-screenshots';

// ---------------------------------------------------------------------------
// Helper: convert between DB snake_case and app camelCase
// ---------------------------------------------------------------------------

function dbToTrade(row: Record<string, unknown>): Trade {
  return {
    id: row.id as string,
    pair: row.pair as string,
    direction: row.direction as 'long' | 'short',
    entryPrice: Number(row.entry_price),
    exitPrice: Number(row.exit_price),
    quantity: Number(row.quantity),
    entryDate: row.entry_date as string,
    exitDate: row.exit_date as string,
    pnl: Number(row.pnl),
    pnlPercent: Number(row.pnl_percent),
    fees: Number(row.fees),
    leverage: Number(row.leverage),
    notes: (row.notes as string) ?? '',
    tags: (row.tags as string[]) ?? [],
    strategy: row.strategy as string | undefined,
    emotion: row.emotion as Trade['emotion'],
    confidence: row.confidence as number | undefined,
    setupType: row.setup_type as string | undefined,
    timeframe: row.timeframe as string | undefined,
    marketCondition: row.market_condition as Trade['marketCondition'],
    screenshot: row.screenshot_url as string | undefined,
    accountId: (row.account_id as string) ?? 'default',
  };
}

function tradeToDb(trade: Trade, userId: string) {
  return {
    id: trade.id,
    user_id: userId,
    pair: trade.pair,
    direction: trade.direction,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    quantity: trade.quantity,
    entry_date: trade.entryDate,
    exit_date: trade.exitDate,
    pnl: trade.pnl,
    pnl_percent: trade.pnlPercent,
    fees: trade.fees,
    leverage: trade.leverage,
    notes: trade.notes,
    tags: trade.tags,
    strategy: trade.strategy ?? null,
    emotion: trade.emotion ?? null,
    confidence: trade.confidence ?? null,
    setup_type: trade.setupType ?? null,
    timeframe: trade.timeframe ?? null,
    market_condition: trade.marketCondition ?? null,
    screenshot_url: trade.screenshot ?? null,
    account_id: trade.accountId ?? 'default',
  };
}

// ---------------------------------------------------------------------------
// Supabase storage functions
// ---------------------------------------------------------------------------

export async function loadTradesFromSupabase(
  supabase: SupabaseClient,
  userId: string
): Promise<Trade[]> {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('exit_date', { ascending: false });

  if (error) {
    console.error('Failed to load trades from Supabase:', error);
    return [];
  }

  return (data ?? []).map(dbToTrade);
}

export async function saveTradeToSupabase(
  supabase: SupabaseClient,
  trade: Trade,
  userId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('trades')
    .upsert(tradeToDb(trade, userId));

  if (error) {
    console.error('Failed to save trade to Supabase:', error);
    return false;
  }
  return true;
}

export async function deleteTradeFromSupabase(
  supabase: SupabaseClient,
  tradeId: string,
  userId?: string
): Promise<boolean> {
  let query = supabase
    .from('trades')
    .delete()
    .eq('id', tradeId);
  if (userId) query = query.eq('user_id', userId);
  const { error } = await query;

  if (error) {
    console.error('Failed to delete trade from Supabase:', error);
    return false;
  }
  return true;
}

export async function saveBulkTradesToSupabase(
  supabase: SupabaseClient,
  trades: Trade[],
  userId: string
): Promise<boolean> {
  const rows = trades.map((t) => tradeToDb(t, userId));
  const { error } = await supabase.from('trades').upsert(rows);

  if (error) {
    console.error('Failed to bulk save trades to Supabase:', error);
    return false;
  }
  return true;
}

export async function clearAllSupabaseTrades(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('trades')
    .delete()
    .eq('user_id', userId);

  if (error) {
    console.error('Failed to clear trades from Supabase:', error);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// localStorage storage functions (offline / unauthenticated fallback)
// ---------------------------------------------------------------------------

/**
 * Save trades array to localStorage.
 * Screenshots are stripped out and stored separately to keep the main
 * trades payload small and prevent hitting the localStorage quota.
 */
export function saveTrades(trades: Trade[]): void {
  try {
    if (typeof window === 'undefined') return;

    // Separate screenshots from trade data
    const screenshots: Record<string, string> = {};
    const tradesWithoutScreenshots = trades.map(t => {
      if (t.screenshot) {
        screenshots[t.id] = t.screenshot;
        const { screenshot: _, ...rest } = t;
        return rest;
      }
      return t;
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(tradesWithoutScreenshots));

    // Store screenshots separately; if quota is exceeded, trade data is still safe
    if (Object.keys(screenshots).length > 0) {
      try {
        const existing = JSON.parse(localStorage.getItem(SCREENSHOTS_KEY) || '{}');
        localStorage.setItem(SCREENSHOTS_KEY, JSON.stringify({ ...existing, ...screenshots }));
      } catch {
        console.warn('Failed to save screenshots - storage quota may be full.');
      }
    }
  } catch (error) {
    console.error('Failed to save trades to localStorage:', error);
  }
}

/**
 * Load trades array from localStorage and re-attach screenshots.
 * Returns an empty array if data is not found, unparseable, or running on the server.
 */
export function loadTrades(): Trade[] {
  try {
    if (typeof window === 'undefined') {
      return [];
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Re-attach screenshots from separate store
    let screenshots: Record<string, string> = {};
    try {
      screenshots = JSON.parse(localStorage.getItem(SCREENSHOTS_KEY) || '{}');
    } catch (err) {
      console.error('Failed to parse screenshots from localStorage:', err);
    }

    return (parsed as unknown[])
      .filter(isValidTrade)
      .map(t => {
        if (screenshots[t.id]) {
          return { ...t, screenshot: screenshots[t.id] };
        }
        return t;
      });
  } catch (error) {
    console.error('Failed to load trades from localStorage:', error);
    return [];
  }
}

/**
 * Add a single trade, persist, and return the updated array.
 */
export function addTrade(trade: Trade): Trade[] {
  const trades = loadTrades();
  trades.push(trade);
  saveTrades(trades);
  return trades;
}

/**
 * Replace an existing trade by id, persist, and return the updated array.
 */
export function updateTrade(updatedTrade: Trade): Trade[] {
  const trades = loadTrades();
  const index = trades.findIndex((t) => t.id === updatedTrade.id);
  if (index !== -1) {
    trades[index] = updatedTrade;
  }
  saveTrades(trades);
  return trades;
}

/**
 * Remove a trade by id, persist, and return the updated array.
 */
export function deleteTrade(tradeId: string): Trade[] {
  const trades = loadTrades();
  const filtered = trades.filter((t) => t.id !== tradeId);
  saveTrades(filtered);
  return filtered;
}

/**
 * Export trades as a downloadable JSON file.
 * The file wraps the trades in a metadata envelope with exportDate and version.
 */
export function exportToJSON(trades: Trade[]): void {
  try {
    const wrapper = {
      exportDate: new Date().toISOString(),
      version: '1.0',
      trades,
    };
    const blob = new Blob([JSON.stringify(wrapper, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'trading-journal-backup.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to export trades to JSON:', error);
  }
}

/**
 * Export trades as a downloadable CSV file.
 * Headers: Pair,Direction,Entry Price,Exit Price,Quantity,Leverage,Fees,PnL,PnL %,Entry Date,Exit Date,Strategy,Emotion,Notes
 */
export function exportToCSV(trades: Trade[]): void {
  try {
    const headers = [
      'Pair',
      'Direction',
      'Entry Price',
      'Exit Price',
      'Quantity',
      'Leverage',
      'Fees',
      'PnL',
      'PnL %',
      'Entry Date',
      'Exit Date',
      'Strategy',
      'Emotion',
      'Notes',
    ];

    const escapeCSV = (value: string): string => {
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };

    const rows = trades.map((t) =>
      [
        escapeCSV(t.pair),
        t.direction,
        t.entryPrice.toString(),
        t.exitPrice.toString(),
        t.quantity.toString(),
        t.leverage.toString(),
        t.fees.toString(),
        t.pnl.toFixed(2),
        t.pnlPercent.toFixed(2),
        t.entryDate,
        t.exitDate,
        escapeCSV(t.strategy ?? ''),
        t.emotion ?? '',
        escapeCSV(t.notes ?? ''),
      ].join(',')
    );

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'trading-journal-export.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to export trades to CSV:', error);
  }
}

function isValidTrade(obj: unknown): obj is Trade {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.pair === 'string' &&
    (t.direction === 'long' || t.direction === 'short') &&
    typeof t.entryPrice === 'number' && t.entryPrice > 0 &&
    typeof t.exitPrice === 'number' && t.exitPrice > 0 &&
    typeof t.quantity === 'number' && t.quantity > 0 &&
    typeof t.entryDate === 'string' &&
    typeof t.exitDate === 'string' &&
    typeof t.pnl === 'number' &&
    typeof t.pnlPercent === 'number'
  );
}

/**
 * Import trades from a JSON file.
 * Accepts both a raw Trade[] array and a wrapped { trades: Trade[] } format.
 */
export function importFromJSON(file: File): Promise<Trade[]> {
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE_SIZE) {
      reject(new Error('File too large. Maximum size is 10 MB.'));
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const text = reader.result as string;
        const parsed = JSON.parse(text);

        const rawTrades = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray(parsed.trades)
            ? parsed.trades
            : null;

        if (rawTrades) {
          const valid = rawTrades.filter(isValidTrade);
          if (valid.length === 0) {
            reject(new Error('No valid trades found in the file.'));
          } else {
            // Keep the first occurrence of each trade id to avoid duplicate imports
            // from malformed backups.
            const deduped: Trade[] = [];
            const seenIds = new Set<string>();
            for (const trade of valid) {
              if (seenIds.has(trade.id)) continue;
              seenIds.add(trade.id);
              deduped.push(trade);
            }
            resolve(deduped);
          }
          return;
        }

        reject(new Error('Invalid JSON structure: expected a Trade[] array or an object with a "trades" array.'));
      } catch (error) {
        reject(new Error('Failed to parse JSON file.'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file.'));
    };

    reader.readAsText(file);
  });
}

/**
 * Remove all saved trade data from localStorage.
 */
export function clearAllData(): void {
  try {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SCREENSHOTS_KEY);
    }
  } catch (error) {
    console.error('Failed to clear trade data from localStorage:', error);
  }
}

/**
 * Check whether localStorage contains a non-empty trades array.
 * Returns false during SSR.
 */
export function hasSavedData(): boolean {
  try {
    if (typeof window === 'undefined') {
      return false;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch (error) {
    return false;
  }
}
