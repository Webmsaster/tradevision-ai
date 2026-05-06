import { Trade, isValidTrade as isValidTradeShared } from "@/types/trade";
import type { SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
// Phase 41 (R44-UI-2): single source of truth for the trades-localStorage
// key. Cross-tab `storage` event listeners in useTradeStorage compare
// against this same constant instead of a hardcoded string literal.
import { STORAGE_KEY } from "@/lib/constants";

// Phase 95 (R54-STO-4): exported so the cross-tab listener in
// useTradeStorage can re-render when a sibling tab modifies screenshots
// (orphan screenshot cleanup or screenshot upload).
export const SCREENSHOTS_KEY = "trading-journal-screenshots";

// Round 56 (R56-STO-1): quota-exceeded broadcast event. Listened to by
// TradeForm/dashboard so the user gets a clear toast when localStorage
// (~5MB on most browsers) overflows after attaching too many
// screenshots — instead of trades silently failing to persist.
export const QUOTA_EXCEEDED_EVENT = "tradevision:storage-quota-exceeded";

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  // Modern browsers throw a DOMException with name === 'QuotaExceededError'
  // (or, on older WebKit, 'QUOTA_EXCEEDED_ERR'). Some Safari/Chrome combos
  // also use `code === 22` or `code === 1014`.
  const name = (e as { name?: string }).name ?? "";
  const code = (e as { code?: number }).code ?? 0;
  return (
    name === "QuotaExceededError" ||
    name === "QUOTA_EXCEEDED_ERR" ||
    code === 22 ||
    code === 1014
  );
}

function broadcastQuotaExceeded(detail: {
  tradeCount: number;
  screenshotCount: number;
}): void {
  try {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(QUOTA_EXCEEDED_EVENT, { detail }));
  } catch {
    /* CustomEvent may not exist in some test envs — silent no-op */
  }
}

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

// Round 56 (Finding #4): tighten the soft-delete column-missing detection.
// The previous check was `msg.includes("column")` which matched ANY error
// mentioning a column (including unrelated NOT-NULL violations or check
// constraints) and silently fell back to hard-delete — defeating the
// soft-delete guarantee. Postgres / PostgREST report 42703 (undefined
// column) for the case we actually want; we accept 42703 OR a tightly
// matched message containing both "deleted_at" AND "does not exist".
function isUndefinedDeletedAtColumn(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code === "42703") return true;
  const m = (e.message ?? "").toLowerCase();
  return m.includes("deleted_at") && m.includes("does not exist");
}

// Round 56 (Finding #4): module-scope cache of the soft-delete capability.
// Once any query has succeeded with the `deleted_at` filter we know the
// column exists; we never fall back to hard-delete after that, even if a
// later query throws an unrelated error that vaguely mentions a column.
//   null  → unknown / probe on next call
//   true  → column confirmed present (soft-delete only)
//   false → confirmed absent (pre-migration DB → hard-delete)
let softDeleteAvailable: boolean | null = null;

// Test-only hook so the unit-test can reset the cache between cases.
export const __resetSoftDeleteCacheForTest = (): void => {
  softDeleteAvailable = null;
};

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
// Round 9 audit (MEDIUM): content-hash for CSV-import dedupe.
//
// Re-importing the same CSV currently inserts duplicates because each row
// is freshly UUID'd at parse time → the existing-id Set in importTrades
// never sees a match. The fix: derive a deterministic hash from the
// trade-content fields (pair / direction / prices / quantity / dates) and
// skip rows whose hash already exists in the user's trade set. UUIDs
// remain the row-id; the hash is purely a dedupe key.
//
// Hash is FNV-1a 32-bit over the canonical string — fast (no crypto
// import on the client), collision-rate ~0 for the realistic per-user
// trade volume (<1M rows). Returned as 8-char hex.
// ---------------------------------------------------------------------------
export function tradeContentHash(t: Trade): string {
  // R67 audit (Round 3): normalize dates to epoch-ms so format drift
  // (Supabase ISO with `+00:00` vs `Z`, with vs without milliseconds)
  // doesn't change the hash on roundtrip → re-import dedup actually works.
  // Prices fixed to 8 decimals to avoid float-stringification drift.
  const toMs = (s: string): string => {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? String(ms) : s;
  };
  const canonical = [
    t.pair.toLowerCase(),
    t.direction,
    Number(t.entryPrice).toFixed(8),
    Number(t.exitPrice).toFixed(8),
    Number(t.quantity).toFixed(8),
    toMs(t.entryDate),
    toMs(t.exitDate),
  ].join("|");
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to unsigned 32-bit hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Round 9 audit (MEDIUM): build the dedupe-set from existing trades
 * (cloud or local). Used by the import handler to skip rows whose
 * content matches an already-stored trade.
 */
export function buildContentHashSet(trades: Trade[]): Set<string> {
  const set = new Set<string>();
  for (const t of trades) set.add(tradeContentHash(t));
  return set;
}

// ---------------------------------------------------------------------------
// Helper: convert between DB snake_case and app camelCase
// ---------------------------------------------------------------------------

// Phase 95 (R54-STO-3): defensive type-guards for optional fields. Values
// arriving from Supabase are typed `unknown` (a future schema-mismatch or
// adversarial RLS bypass could feed garbage). Without guards, NaN
// confidence and non-array tags propagate into stats / UI iterators.
function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === "string");
}
function finiteOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function dbToTrade(row: Record<string, unknown>): Trade | null {
  // Phase 7 (Storage Bug 6): allow-list emotion / marketCondition; arbitrary
  // strings from the DB cast straight to Trade['emotion'] would let a future
  // dangerouslySetInnerHTML render unfiltered values.
  const rawEmotion = strOrUndef(row.emotion);
  const emotion =
    rawEmotion && (ALLOWED_EMOTIONS as readonly string[]).includes(rawEmotion)
      ? (rawEmotion as Trade["emotion"])
      : undefined;
  const rawMarket = strOrUndef(row.market_condition);
  const marketCondition =
    rawMarket &&
    (ALLOWED_MARKET_CONDITIONS as readonly string[]).includes(rawMarket)
      ? (rawMarket as Trade["marketCondition"])
      : undefined;
  // Round 6 audit (MEDIUM): previously any invalid direction silently
  // fell back to "long" — corrupting the P&L sign for shorts that
  // arrived with a typo'd column. Log + skip the row instead so the
  // user sees data is missing rather than mis-categorised.
  const rawDirection = strOrUndef(row.direction);
  if (rawDirection !== "long" && rawDirection !== "short") {
    console.warn(
      `[storage] dbToTrade: skipping row id=${strOrEmpty(row.id) || "<no-id>"} with invalid direction=${JSON.stringify(rawDirection)}`,
    );
    return null;
  }
  const direction: "long" | "short" = rawDirection;
  const rawAccountId = strOrUndef(row.account_id);
  return {
    id: strOrEmpty(row.id),
    pair: strOrEmpty(row.pair),
    direction,
    entryPrice: num(row.entry_price),
    exitPrice: num(row.exit_price),
    quantity: num(row.quantity),
    entryDate: strOrEmpty(row.entry_date),
    exitDate: strOrEmpty(row.exit_date),
    pnl: num(row.pnl),
    pnlPercent: num(row.pnl_percent),
    fees: num(row.fees),
    leverage: num(row.leverage, 1),
    notes: strOrEmpty(row.notes),
    tags: strArr(row.tags),
    strategy: strOrUndef(row.strategy),
    emotion,
    confidence: finiteOrUndef(row.confidence),
    setupType: strOrUndef(row.setup_type),
    timeframe: strOrUndef(row.timeframe),
    marketCondition,
    screenshot: validateScreenshot(strOrUndef(row.screenshot_url)),
    accountId:
      rawAccountId && rawAccountId.length > 0 ? rawAccountId : "default",
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
  //
  // Phase 95 (R54-STO-1): drop the 100_000-row hard cap. Power-users with
  // multi-year backtest imports were silently losing the oldest trades when
  // their cloud DB exceeded 100k rows. Loop until a partial page (<PAGE)
  // signals end-of-result-set. A 1M soft-cap remains as a defensive guard
  // against runaway result-sets — it logs a warning so the rare hit is
  // observable instead of silent.
  // Phase 95 (R54-STO-7): filter soft-deleted rows. `deleted_at is null`
  // is a no-op for rows in DBs that haven't been migrated yet (the column
  // simply doesn't exist there) — Supabase rejects the query with a
  // "column does not exist" error. We catch that and retry without the
  // filter so the client works against pre-migration deployments.
  const PAGE = 1000;
  const SOFT_CAP = 1_000_000;
  const all: Trade[] = [];
  // Round 56 (Finding #4): start from the cached capability if known.
  // `null` → probe (try with filter, allow one retry without on 42703).
  let useSoftDeleteFilter = softDeleteAvailable !== false;
  for (let from = 0; from < SOFT_CAP; from += PAGE) {
    let query = supabase.from("trades").select("*").eq("user_id", userId);
    if (useSoftDeleteFilter) query = query.is("deleted_at", null);
    const { data, error } = await query
      .order("exit_date", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      // Round 56 (Finding #4): only retry on a true 42703 (undefined
      // column) error. Other column-related errors (e.g. permission,
      // type-cast, RLS) bubble up so we don't silently mask real bugs.
      if (useSoftDeleteFilter && isUndefinedDeletedAtColumn(error)) {
        useSoftDeleteFilter = false;
        softDeleteAvailable = false; // cache for the rest of the session
        from -= PAGE; // retry this offset
        continue;
      }
      console.error("Failed to load trades from Supabase:", error);
      throw new Error(
        `loadTradesFromSupabase: page-fetch failed at offset ${from}: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    for (const row of data) {
      const t = dbToTrade(row);
      if (t) all.push(t);
    }
    // First successful query with the soft-delete filter promotes the
    // cache to "confirmed present" — subsequent calls in this process
    // skip the probe entirely.
    if (useSoftDeleteFilter && softDeleteAvailable === null) {
      softDeleteAvailable = true;
    }
    if (data.length < PAGE) break;
    if (from + PAGE >= SOFT_CAP) {
      console.warn(
        `[storage] hit ${SOFT_CAP.toLocaleString()} trade soft-cap, oldest trades may be missing`,
      );
    }
  }
  return all;
}

export async function saveTradeToSupabase(
  supabase: SupabaseClient,
  trade: Trade,
  userId: string,
): Promise<boolean> {
  // Phase 69 (R45-DB-M1): explicit onConflict on PK so the upsert path
  // is unambiguous — supabase-js infers from the PK by default but
  // future schema changes (e.g. composite PK on (user_id, id)) would
  // silently change semantics.
  const { error } = await supabase
    .from("trades")
    .upsert(tradeToDb(trade, userId), { onConflict: "id" });

  if (error) {
    console.error("Failed to save trade to Supabase:", error);
    return false;
  }
  return true;
}

/**
 * Soft-delete a trade. Audit-trail enforcement lives entirely on the client
 * via the `.is("deleted_at", null)` filter on the UPDATE WHERE clause (see
 * Round 7 / R67-r5). DO NOT re-introduce a DB trigger to enforce this — the
 * R67-r3 attempt was reverted in `migration_round67_audit_trigger_drop.sql`
 * because it broke the legitimate UPSERT-resolve-to-UPDATE re-import path.
 * The only sanctioned un-tombstone path is the explicit
 * `update({ deleted_at: null })` in saveBulkTradesToSupabase.
 */
export async function deleteTradeFromSupabase(
  supabase: SupabaseClient,
  tradeId: string,
  // Phase 33 (API Audit Bug 10): userId now REQUIRED. Was optional → callers
  // could forget it and rely on RLS alone (no defense-in-depth). Always
  // filter explicitly so a future RLS misconfig doesn't leak deletes.
  userId: string,
): Promise<boolean> {
  // Phase 95 (R54-STO-7): soft-delete instead of hard-delete. Project
  // convention (CLAUDE.md) is soft-delete. Falls back to hard-delete if
  // the deleted_at column doesn't exist (pre-migration DBs) so the client
  // continues working through the migration window.
  //
  // Round 56 (Finding #4): once the cache says the column is present we
  // never fall back — a "column"-mentioning error from any other source
  // would otherwise silently strip soft-delete semantics.
  const nowIso = new Date().toISOString();
  if (softDeleteAvailable === false) {
    // Confirmed pre-migration DB: hard-delete directly, skip the probe.
    const hardDel = await supabase
      .from("trades")
      .delete()
      .eq("id", tradeId)
      .eq("user_id", userId);
    if (hardDel.error) {
      console.error("Failed to delete trade from Supabase:", hardDel.error);
      return false;
    }
    return true;
  }
  // R67 audit (Round 5): audit-trail protection lives HERE via the
  // `.is("deleted_at", null)` filter on the UPDATE WHERE clause. A
  // double-delete is a no-op (zero rows match, no rewrite of deleted_at).
  // The R67-r3 DB trigger that enforced this server-side was dropped in
  // migration_round67_audit_trigger_drop.sql because it broke the
  // UPSERT-resolve-to-UPDATE re-import path (R67-r2 RLS policy allows
  // updates on tombstoned rows, but the trigger silently blocked the
  // deleted_at→NULL flip, leaving the row hidden by the SELECT policy).
  // The only sanctioned un-tombstone path is the explicit
  // `update({ deleted_at: null })` in saveBulkTradesToSupabase after a
  // successful UPSERT — the user's explicit re-import action.
  const updateQuery = supabase
    .from("trades")
    .update({ deleted_at: nowIso })
    .eq("id", tradeId)
    .eq("user_id", userId)
    .is("deleted_at", null);
  let { error } = await updateQuery;
  if (error) {
    if (softDeleteAvailable !== true && isUndefinedDeletedAtColumn(error)) {
      // Pre-migration DB: hard-delete and remember.
      softDeleteAvailable = false;
      const hardDel = await supabase
        .from("trades")
        .delete()
        .eq("id", tradeId)
        .eq("user_id", userId);
      error = hardDel.error;
    }
  } else {
    softDeleteAvailable = true;
  }
  if (error) {
    console.error("Failed to delete trade from Supabase:", error);
    return false;
  }
  return true;
}

// Phase 95 (R54-STO-2): retry-queue for bulk-upserts that fail mid-flight.
// Trade IDs are UUIDs, upserts are idempotent → on the next save attempt
// we drain the queue first (re-uploading rows from a previous partial
// failure) before processing the new payload. Survives tab reloads via
// localStorage.
const BULK_RETRY_KEY = "sb-retry-queue";

interface RetryEntry {
  rows: Array<Record<string, unknown>>;
  enqueuedAt: string;
}

function readRetryQueue(): RetryEntry[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = localStorage.getItem(BULK_RETRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RetryEntry =>
        !!e && typeof e === "object" && Array.isArray(e.rows),
    );
  } catch {
    return [];
  }
}

function writeRetryQueue(queue: RetryEntry[]): void {
  try {
    if (typeof window === "undefined") return;
    if (queue.length === 0) {
      localStorage.removeItem(BULK_RETRY_KEY);
    } else {
      localStorage.setItem(BULK_RETRY_KEY, JSON.stringify(queue));
    }
  } catch (err) {
    console.warn("[storage] retry-queue persistence failed:", err);
  }
}

function enqueueRetry(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const queue = readRetryQueue();
  queue.push({ rows, enqueuedAt: new Date().toISOString() });
  writeRetryQueue(queue);
}

async function uploadChunked(
  supabase: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  chunk: number,
): Promise<{ ok: boolean; failedFromIndex: number | null }> {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await supabase
      .from("trades")
      .upsert(slice, { onConflict: "id" });
    if (error) {
      console.error(
        `Failed to bulk save trades to Supabase (chunk ${i / chunk}):`,
        error,
      );
      return { ok: false, failedFromIndex: i };
    }
  }
  return { ok: true, failedFromIndex: null };
}

export async function saveBulkTradesToSupabase(
  supabase: SupabaseClient,
  trades: Trade[],
  userId: string,
): Promise<boolean> {
  // Phase 47 (R45-DB-2): batch in 500-row chunks. Supabase pooler caps
  // payloads around 4 MB; a single upsert of 50k+ trades from CSV import
  // hit the cap and was rejected wholesale.
  //
  // Phase 95 (R54-STO-2): drain retry-queue first, then upload current
  // payload. On mid-flight failure we enqueue the un-uploaded slice
  // (rows from the failing chunk onward) for the next call. UUID
  // primary keys make the upsert idempotent — replaying succeeded
  // chunks is safe.
  const CHUNK = 500;

  // 1) Drain queue from prior failed runs.
  const pending = readRetryQueue();
  if (pending.length > 0) {
    const survived: RetryEntry[] = [];
    for (const entry of pending) {
      const result = await uploadChunked(supabase, entry.rows, CHUNK);
      if (result.ok) continue;
      // Re-enqueue everything from the failure point onward.
      const remaining = entry.rows.slice(result.failedFromIndex ?? 0);
      survived.push({ ...entry, rows: remaining });
    }
    if (survived.length > 0) {
      // Bug fix (race-audit): atomically persist BOTH survivors and the
      // new payload in a single write. The previous version called
      // writeRetryQueue(survived) and then enqueueRetry(newPayload)
      // separately — a browser crash / power loss between the two
      // writes lost the new payload while keeping the survivors.
      if (trades.length > 0) {
        survived.push({
          rows: trades.map((t) => tradeToDb(t, userId)),
          enqueuedAt: new Date().toISOString(),
        });
      }
      writeRetryQueue(survived);
      // Surface failure so the caller keeps their localStorage copy.
      return false;
    }
    writeRetryQueue(survived); // empty → removes the key
  }

  if (trades.length === 0) return true;
  const rows = trades.map((t) => tradeToDb(t, userId));
  const result = await uploadChunked(supabase, rows, CHUNK);
  if (!result.ok) {
    const remaining = rows.slice(result.failedFromIndex ?? 0);
    enqueueRetry(remaining);
    return false;
  }
  return true;
}

export async function clearAllSupabaseTrades(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  // Phase 95 (R54-STO-7): soft-delete batch. Falls back to hard-delete
  // for pre-migration DBs.
  //
  // Round 56 (Finding #4): respect the cached capability so a transient
  // unrelated column-error can't trick us into hard-deleting once we've
  // already seen the soft-delete column work.
  const nowIso = new Date().toISOString();
  if (softDeleteAvailable === false) {
    const hardDel = await supabase
      .from("trades")
      .delete()
      .eq("user_id", userId);
    if (hardDel.error) {
      console.error("Failed to clear trades from Supabase:", hardDel.error);
      return false;
    }
    return true;
  }
  let { error } = await supabase
    .from("trades")
    .update({ deleted_at: nowIso })
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (error) {
    if (softDeleteAvailable !== true && isUndefinedDeletedAtColumn(error)) {
      softDeleteAvailable = false;
      const hardDel = await supabase
        .from("trades")
        .delete()
        .eq("user_id", userId);
      error = hardDel.error;
    }
  } else {
    softDeleteAvailable = true;
  }
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

    // Round 56 (R56-STO-1): isolate the trades-payload write so we can
    // detect and signal QuotaExceededError. Previously a quota-overflow
    // hit the outer catch which only logged to console — users had no
    // way to know that subsequent trade edits were silently discarded.
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(tradesWithoutScreenshots),
      );
    } catch (writeErr) {
      if (isQuotaError(writeErr)) {
        console.error(
          "[storage] saveTrades: localStorage quota exceeded — trades not persisted. " +
            "Reduce screenshot resolution or delete old screenshots to free space.",
        );
        broadcastQuotaExceeded({
          tradeCount: trades.length,
          screenshotCount: Object.keys(screenshots).length,
        });
        return;
      }
      throw writeErr;
    }

    // Phase 47 (R45-CC-H3): rebuild the screenshots map from the CURRENT
    // trade ids on every save instead of merging. Was leaking — when a
    // user deleted a trade, its screenshot remained in SCREENSHOTS_KEY
    // forever (each up to 2MB); after ~10 deletions a user could hit
    // localStorage quota with no live trade referencing the data.
    //
    // Phase 95 (R54-STO-4): tab-safe rebuild. Anchor the trade-id set
    // on the *current* STORAGE_KEY content (which we just wrote),
    // re-derived from `tradesWithoutScreenshots` plus any ids from
    // OTHER tabs we haven't yet observed. The idempotent rebuild
    // tolerates an interleaved write from a sibling tab — worst case
    // we drop a screenshot that the sibling just attached, and the
    // sibling's next save re-attaches it (saveTrades carries the
    // screenshot in the trade payload).
    try {
      const tradeIds = new Set(trades.map((t) => t.id));
      const existing = JSON.parse(
        localStorage.getItem(SCREENSHOTS_KEY) || "{}",
      ) as Record<string, string>;
      // Re-read STORAGE_KEY (in case a sibling tab wrote between our
      // setItem above and now) so we don't drop their trade ids.
      try {
        const currentRaw = localStorage.getItem(STORAGE_KEY);
        if (currentRaw) {
          const currentTrades = JSON.parse(currentRaw);
          if (Array.isArray(currentTrades)) {
            for (const t of currentTrades) {
              if (t && typeof t === "object" && typeof t.id === "string") {
                tradeIds.add(t.id);
              }
            }
          }
        }
      } catch {
        /* ignore — fall back to our own trade-id set */
      }
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
    } catch (err) {
      // Round 56 (R56-STO-1): screenshots block exceeded quota. Trades
      // already persisted above, so we keep going but broadcast so the
      // UI can suggest deleting screenshots.
      console.warn(
        "[storage] Failed to save screenshots - storage quota may be full.",
      );
      if (isQuotaError(err)) {
        broadcastQuotaExceeded({
          tradeCount: trades.length,
          screenshotCount: Object.keys(screenshots).length,
        });
      }
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

    // Phase 95 (R54-STO-5): fail-closed on invalid rows — log a warning
    // so corrupt entries are observable instead of silently dropped.
    const arr = parsed as unknown[];
    const valid: Trade[] = [];
    let dropped = 0;
    for (const row of arr) {
      if (isValidTrade(row)) valid.push(row);
      else dropped += 1;
    }
    if (dropped > 0) {
      console.warn(
        `[storage] loadTrades: dropped ${dropped} invalid row(s) of ${arr.length}`,
      );
    }
    return valid.map((t) => {
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
 *
 * Phase 55 (R45-CC-H2): delegates to `exportTradesToCsv` from csvExport.ts
 * (the canonical exporter — 20 columns, full \r\n escape, UTF-8 BOM,
 * `id` column included). The /import page used to call a 14-column
 * exporter here while /trades used the 20-column one — same data, two
 * different files. Now both routes produce the same CSV.
 */
export async function exportToCSV(trades: Trade[]): Promise<void> {
  try {
    const { exportTradesToCsv } = await import("@/utils/csvExport");
    exportTradesToCsv(trades, "trading-journal-export");
  } catch (error) {
    console.error("Failed to export trades to CSV:", error);
  }
}

// Round 6 audit (MEDIUM): single source of truth lives in `@/types/trade`
// — re-exported here under the original local name so existing tests and
// call sites continue to work.
const isValidTrade = isValidTradeShared;

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
          // Phase 95 (R54-STO-5): warn on invalid rows so corrupt
          // backups don't fail silently.
          const valid = rawTrades.filter(isValidTrade);
          const dropped = (rawTrades.length as number) - valid.length;
          if (dropped > 0) {
            console.warn(
              `[storage] importFromJSON: skipped ${dropped} invalid row(s) of ${rawTrades.length}`,
            );
          }
          if (valid.length === 0) {
            reject(new Error("No valid trades found in the file."));
          } else {
            // Phase 30 (Storage Audit Bug 4): only re-generate UUIDs on
            // CONFLICT with existing trades — preserves AIInsight
            // relatedTrades references when re-importing your own backup.
            // Phase 22 was too aggressive (regenerate ALL) which broke
            // every saved insight after a re-import.
            // Phase 61 (R45-CC-M1): removed dead seenIds loop. Comment
            // claimed "all ids are now freshly generated" but the map
            // above only regenerates conflicting ids, not non-conflicts;
            // either way the loop iterated without filtering. Pure dead
            // code — kept just the conflict-rewrite map.
            const existingIds = new Set(loadTrades().map((t) => t.id));
            const deduped: Trade[] = (valid as Trade[]).map((trade) => ({
              ...trade,
              id: existingIds.has(trade.id) ? uuidv4() : trade.id,
            }));
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
        reject(new Error("Failed to parse JSON file.", { cause: error }));
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
 *
 * R67 audit (Round 3): also clear SETTINGS_KEY (webhook URLs, account list,
 * activeAccountId, dashboard widgets — User-A's webhook would otherwise
 * leak across logout→login as User-B) and BULK_RETRY_KEY (User-A's pending
 * bulk-uploads would be flushed under User-B's session on next mount).
 */
export function clearAllData(): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SCREENSHOTS_KEY);
      // R67-r3: prevent cross-user data leakage on logout
      localStorage.removeItem("tradevision-settings");
      localStorage.removeItem(BULK_RETRY_KEY);
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
  } catch {
    return false;
  }
}
