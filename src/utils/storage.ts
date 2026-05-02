import { Trade } from "@/types/trade";
import type { SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
// Phase 41 (R44-UI-2): single source of truth for the trades-localStorage
// key. Cross-tab `storage` event listeners in useTradeStorage compare
// against this same constant instead of a hardcoded string literal.
import { STORAGE_KEY } from "@/lib/constants";

const SCREENSHOTS_KEY = "trading-journal-screenshots";

// Phase 7 (Storage Bug 7): screenshot data-URL safety. Reject anything that
// isn't an image base64 data URL. Caps size at 2 MB to prevent DB-bloat.
// Without this, javascript: / data:text/html URLs can flow through to <img
// src> producing XSS, and unbounded base64 hoses Supabase storage.
const SCREENSHOT_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

export function validateScreenshot(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (!SCREENSHOT_RE.test(s)) return undefined;
  // base64 length × 0.75 ≈ decoded bytes; allow 1.4× headroom
  if (s.length > SCREENSHOT_MAX_BYTES * 1.4) return undefined;
  return s;
}

// Phase 7 (Storage Bug 6): NaN-safe numeric coercion at the boundary.
// Number(null) === 0 (acceptable), Number('garbage') === NaN — propagates
// into stats and poisons winRate/sharpe.
function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const ALLOWED_EMOTIONS = [
  "confident",
  "neutral",
  "fearful",
  "greedy",
  "fomo",
  "revenge",
] as const;
const ALLOWED_MARKET_CONDITIONS = [
  "trending",
  "ranging",
  "volatile",
  "calm",
] as const;

// ---------------------------------------------------------------------------
// Helper: convert between DB snake_case and app camelCase
// ---------------------------------------------------------------------------

function dbToTrade(row: Record<string, unknown>): Trade {
  // Phase 7 (Storage Bug 6): allow-list emotion / marketCondition; arbitrary
  // strings from the DB cast straight to Trade['emotion'] would let a future
  // dangerouslySetInnerHTML render unfiltered values.
  const rawEmotion = row.emotion as string | null | undefined;
  const emotion =
    rawEmotion && (ALLOWED_EMOTIONS as readonly string[]).includes(rawEmotion)
      ? (rawEmotion as Trade["emotion"])
      : undefined;
  const rawMarket = row.market_condition as string | null | undefined;
  const marketCondition =
    rawMarket &&
    (ALLOWED_MARKET_CONDITIONS as readonly string[]).includes(rawMarket)
      ? (rawMarket as Trade["marketCondition"])
      : undefined;
  return {
    id: row.id as string,
    pair: row.pair as string,
    direction: row.direction as "long" | "short",
    entryPrice: num(row.entry_price),
    exitPrice: num(row.exit_price),
    quantity: num(row.quantity),
    entryDate: row.entry_date as string,
    exitDate: row.exit_date as string,
    pnl: num(row.pnl),
    pnlPercent: num(row.pnl_percent),
    fees: num(row.fees),
    leverage: num(row.leverage, 1),
    notes: (row.notes as string) ?? "",
    tags: (row.tags as string[]) ?? [],
    strategy: row.strategy as string | undefined,
    emotion,
    confidence: row.confidence as number | undefined,
    setupType: row.setup_type as string | undefined,
    timeframe: row.timeframe as string | undefined,
    marketCondition,
    screenshot: validateScreenshot(row.screenshot_url as string | undefined),
    accountId: (row.account_id as string) ?? "default",
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
    // Phase 7: validate before persisting too — defense-in-depth so a
    // tampered client cannot inject javascript:/data:text/html URLs.
    screenshot_url: validateScreenshot(trade.screenshot) ?? null,
    account_id: trade.accountId ?? "default",
  };
}

// ---------------------------------------------------------------------------
// Supabase storage functions
// ---------------------------------------------------------------------------

export async function loadTradesFromSupabase(
  supabase: SupabaseClient,
  userId: string,
): Promise<Trade[]> {
  // Phase 22 (Storage Bug 9): paginate. Supabase default limit is 1000 rows;
  // power-users with backtest data can have 10k+ trades and were silently
  // losing the older 9k. Fetch in 1000-row pages until exhausted.
  //
  // Phase 47 (R45-DB-1): added `id` as a tie-breaker in the order. Without
  // it, ties on `exit_date` (very common for bulk-imported backtest trades
  // sharing the same second) yielded non-deterministic page boundaries —
  // some rows got duplicated across pages, others skipped.
  //
  // Phase 47 (R45-CC-H1): on a mid-fetch error we now THROW instead of
  // silent `break`. Returning a partially-loaded array poisoned downstream
  // stats (winRate / drawdown / Sharpe) with no signal to the caller.
  const PAGE = 1000;
  const all: Trade[] = [];
  for (let from = 0; from < 100_000; from += PAGE) {
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("user_id", userId)
      .order("exit_date", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("Failed to load trades from Supabase:", error);
      throw new Error(
        `loadTradesFromSupabase: page-fetch failed at offset ${from}: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    for (const row of data) all.push(dbToTrade(row));
    if (data.length < PAGE) break;
  }
  return all;
}

export async function saveTradeToSupabase(
  supabase: SupabaseClient,
  trade: Trade,
  userId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("trades")
    .upsert(tradeToDb(trade, userId));

  if (error) {
    console.error("Failed to save trade to Supabase:", error);
    return false;
  }
  return true;
}

export async function deleteTradeFromSupabase(
  supabase: SupabaseClient,
  tradeId: string,
  // Phase 33 (API Audit Bug 10): userId now REQUIRED. Was optional → callers
  // could forget it and rely on RLS alone (no defense-in-depth). Always
  // filter explicitly so a future RLS misconfig doesn't leak deletes.
  userId: string,
): Promise<boolean> {
  let query = supabase.from("trades").delete().eq("id", tradeId);
  if (userId) query = query.eq("user_id", userId);
  const { error } = await query;

  if (error) {
    console.error("Failed to delete trade from Supabase:", error);
    return false;
  }
  return true;
}

export async function saveBulkTradesToSupabase(
  supabase: SupabaseClient,
  trades: Trade[],
  userId: string,
): Promise<boolean> {
  // Phase 47 (R45-DB-2): batch in 500-row chunks. Supabase pooler caps
  // payloads around 4 MB; a single upsert of 50k+ trades from CSV import
  // hit the cap and was rejected wholesale (no partial-success / no
  // resume). Process in chunks and abort on the first failure — caller
  // sees `false` and can show a clear error.
  if (trades.length === 0) return true;
  const CHUNK = 500;
  const rows = trades.map((t) => tradeToDb(t, userId));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("trades").upsert(slice);
    if (error) {
      console.error(
        `Failed to bulk save trades to Supabase (chunk ${i / CHUNK}):`,
        error,
      );
      return false;
    }
  }
  return true;
}

export async function clearAllSupabaseTrades(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("trades")
    .delete()
    .eq("user_id", userId);

  if (error) {
    console.error("Failed to clear trades from Supabase:", error);
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
    if (typeof window === "undefined") return;

    // Separate screenshots from trade data
    const screenshots: Record<string, string> = {};
    const tradesWithoutScreenshots = trades.map((t) => {
      if (t.screenshot) {
        screenshots[t.id] = t.screenshot;
        const { screenshot: _, ...rest } = t;
        return rest;
      }
      return t;
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(tradesWithoutScreenshots));

    // Phase 47 (R45-CC-H3): rebuild the screenshots map from the CURRENT
    // trade ids on every save instead of merging. Was leaking — when a
    // user deleted a trade, its screenshot remained in SCREENSHOTS_KEY
    // forever (each up to 2MB); after ~10 deletions a user could hit
    // localStorage quota with no live trade referencing the data.
    try {
      const tradeIds = new Set(trades.map((t) => t.id));
      const existing = JSON.parse(
        localStorage.getItem(SCREENSHOTS_KEY) || "{}",
      ) as Record<string, string>;
      const cleaned: Record<string, string> = {};
      for (const [id, dataUrl] of Object.entries(existing)) {
        if (tradeIds.has(id)) cleaned[id] = dataUrl;
      }
      // Overlay any new/updated screenshots from this save.
      Object.assign(cleaned, screenshots);
      if (Object.keys(cleaned).length > 0) {
        localStorage.setItem(SCREENSHOTS_KEY, JSON.stringify(cleaned));
      } else {
        localStorage.removeItem(SCREENSHOTS_KEY);
      }
    } catch {
      console.warn("Failed to save screenshots - storage quota may be full.");
    }
  } catch (error) {
    console.error("Failed to save trades to localStorage:", error);
  }
}

/**
 * Load trades array from localStorage and re-attach screenshots.
 * Returns an empty array if data is not found, unparseable, or running on the server.
 */
export function loadTrades(): Trade[] {
  try {
    if (typeof window === "undefined") {
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
      screenshots = JSON.parse(localStorage.getItem(SCREENSHOTS_KEY) || "{}");
    } catch (err) {
      console.error("Failed to parse screenshots from localStorage:", err);
    }

    return (parsed as unknown[]).filter(isValidTrade).map((t) => {
      if (screenshots[t.id]) {
        return { ...t, screenshot: screenshots[t.id] };
      }
      return t;
    });
  } catch (error) {
    console.error("Failed to load trades from localStorage:", error);
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
      version: "1.0",
      trades,
    };
    const blob = new Blob([JSON.stringify(wrapper, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "trading-journal-backup.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Failed to export trades to JSON:", error);
  }
}

/**
 * Export trades as a downloadable CSV file.
 * Headers: Pair,Direction,Entry Price,Exit Price,Quantity,Leverage,Fees,PnL,PnL %,Entry Date,Exit Date,Strategy,Emotion,Notes
 */
export function exportToCSV(trades: Trade[]): void {
  try {
    const headers = [
      "Pair",
      "Direction",
      "Entry Price",
      "Exit Price",
      "Quantity",
      "Leverage",
      "Fees",
      "PnL",
      "PnL %",
      "Entry Date",
      "Exit Date",
      "Strategy",
      "Emotion",
      "Notes",
    ];

    const escapeCSV = (value: string): string => {
      if (value.includes(",") || value.includes('"') || value.includes("\n")) {
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
        escapeCSV(t.strategy ?? ""),
        t.emotion ?? "",
        escapeCSV(t.notes ?? ""),
      ].join(","),
    );

    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "trading-journal-export.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Failed to export trades to CSV:", error);
  }
}

function isValidTrade(obj: unknown): obj is Trade {
  if (!obj || typeof obj !== "object") return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.pair === "string" &&
    (t.direction === "long" || t.direction === "short") &&
    typeof t.entryPrice === "number" &&
    t.entryPrice > 0 &&
    typeof t.exitPrice === "number" &&
    t.exitPrice > 0 &&
    typeof t.quantity === "number" &&
    t.quantity > 0 &&
    typeof t.entryDate === "string" &&
    typeof t.exitDate === "string" &&
    typeof t.pnl === "number" &&
    typeof t.pnlPercent === "number"
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
      reject(new Error("File too large. Maximum size is 10 MB."));
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const text = reader.result as string;
        const parsed = JSON.parse(text);

        const rawTrades = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray(parsed.trades)
            ? parsed.trades
            : null;

        if (rawTrades) {
          const valid = rawTrades.filter(isValidTrade);
          if (valid.length === 0) {
            reject(new Error("No valid trades found in the file."));
          } else {
            // Phase 30 (Storage Audit Bug 4): only re-generate UUIDs on
            // CONFLICT with existing trades — preserves AIInsight
            // relatedTrades references when re-importing your own backup.
            // Phase 22 was too aggressive (regenerate ALL) which broke
            // every saved insight after a re-import.
            const existingIds = new Set(loadTrades().map((t) => t.id));
            const deduped: Trade[] = (valid as Trade[]).map((trade) => ({
              ...trade,
              id: existingIds.has(trade.id) ? uuidv4() : trade.id,
            }));
            // Legacy dedup loop (kept for symmetry — though all ids are now
            // freshly generated so seenIds will always pass).
            const seenIds = new Set<string>();
            for (const trade of deduped) {
              if (seenIds.has(trade.id)) continue;
              seenIds.add(trade.id);
            }
            resolve(deduped);
          }
          return;
        }

        reject(
          new Error(
            'Invalid JSON structure: expected a Trade[] array or an object with a "trades" array.',
          ),
        );
      } catch (error) {
        reject(new Error("Failed to parse JSON file."));
      }
    };

    reader.onerror = () => {
      reject(new Error("Failed to read file."));
    };

    reader.readAsText(file);
  });
}

/**
 * Remove all saved trade data from localStorage.
 */
export function clearAllData(): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SCREENSHOTS_KEY);
    }
  } catch (error) {
    console.error("Failed to clear trade data from localStorage:", error);
  }
}

/**
 * Check whether localStorage contains a non-empty trades array.
 * Returns false during SSR.
 */
export function hasSavedData(): boolean {
  try {
    if (typeof window === "undefined") {
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
