"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Trade } from "@/types/trade";
import { useAuth } from "@/lib/auth-context";
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_KEY,
  STORAGE_KEY,
} from "@/lib/constants";
import {
  loadTrades,
  saveTrades,
  addTrade as addTradeLocal,
  updateTrade as updateTradeLocal,
  deleteTrade as deleteTradeLocal,
  clearAllData,
  SCREENSHOTS_KEY,
  QUOTA_EXCEEDED_EVENT,
} from "@/utils/storage";
import {
  loadTradesFromSupabase,
  saveTradeToSupabase,
  deleteTradeFromSupabase,
  saveBulkTradesToSupabase,
  clearAllSupabaseTrades,
} from "@/utils/storage";

// Phase 41 / Phase 86: SSRF guard moved to @/utils/urlSafety so the
// settings "Test webhook" handler can share the exact same logic.
import { isValidHttpsUrl } from "@/utils/urlSafety";

// Fire webhook notification for trade events (best-effort, never blocks)
function fireWebhook(
  event: "onTradeAdd" | "onTradeEdit" | "onTradeDelete",
  trade?: Trade,
) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const settings = JSON.parse(raw);
    const wh = settings.webhook;
    if (!wh?.enabled || !wh?.url || !wh.events?.[event]) return;
    if (!isValidHttpsUrl(wh.url)) return;

    const msg =
      event === "onTradeAdd"
        ? `New trade: ${trade?.pair} ${trade?.direction?.toUpperCase()} - PnL: $${trade?.pnl?.toFixed(2)}`
        : event === "onTradeEdit"
          ? `Trade updated: ${trade?.pair} - PnL: $${trade?.pnl?.toFixed(2)}`
          : `Trade deleted: ${trade?.pair ?? "unknown"}`;

    // Phase 41 (R44-STO-H2) + Phase 86 (R51-S2): strip screenshot AND
    // notes from webhook payload. Notes are user free-text that often
    // contains PII (broker login hints, prop-firm credentials, chart-
    // anchor passwords); screenshot is up to 2 MB base64. Both are
    // unsafe to ship to a third-party endpoint by default.
    const tradeForWebhook = trade
      ? { ...trade, screenshot: undefined, notes: undefined }
      : trade;
    const payload =
      wh.platform === "discord"
        ? { content: msg }
        : wh.platform === "telegram"
          ? { text: msg }
          : { event, message: msg, trade: tradeForWebhook };

    // Round 56 (Fix 4): 5s AbortSignal.timeout matches /api/webhook-test
    // convention — a hung user-supplied webhook URL can't block the trade
    // CRUD path forever.
    fetch(wh.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    }).catch((err) => {
      console.error("Webhook delivery failed:", err);
    }); // best-effort
  } catch (err) {
    console.error("Webhook fire failed:", err);
  }
}

function getActiveAccountId(): string {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const settings = JSON.parse(raw);
      if (settings.activeAccountId) return settings.activeAccountId;
    }
  } catch (err) {
    console.error("Failed to read active account ID:", err);
  }
  return "default";
}

export function useTradeStorage() {
  const { user, supabase } = useAuth();
  const [allTrades, setAllTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [activeAccountId, setActiveAccountId] = useState("default");
  const isCloud = !!user && !!supabase;

  // Ref for allTrades so removeTrade callback stays stable
  const allTradesRef = useRef(allTrades);
  allTradesRef.current = allTrades;
  const hasLoadedInitialDataRef = useRef(false);

  // Listen for settings changes to update active account
  useEffect(() => {
    setActiveAccountId(getActiveAccountId());
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.activeAccountId) setActiveAccountId(detail.activeAccountId);
    };
    // Phase 51 (R45-UI-H2): same-tab event handles account switches in
    // this tab, but cross-tab account switches were missed — listening
    // to the `storage` event for SETTINGS_KEY so a switch in tab B
    // updates tab A's filter immediately. Without this, trades got
    // saved/filtered under the wrong account until the user touched
    // settings UI again.
    const storageHandler = (e: StorageEvent) => {
      if (e.key === SETTINGS_KEY) {
        setActiveAccountId(getActiveAccountId());
      }
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
    window.addEventListener("storage", storageHandler);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
      window.removeEventListener("storage", storageHandler);
    };
  }, []);

  // Filter trades by active account.
  //
  // Phase 95 (R54-STO-6): "default" is treated as a real account ID
  // (matches `accounts: [{id: "default"}]` in settings). Previously
  // any trade was visible while the default account was active —
  // multi-account reports showed cross-account totals, breaking the
  // P&L breakdown. Legacy trades without an `accountId` are normalised
  // to "default" so existing data continues to render under the
  // default account.
  const trades = useMemo(() => {
    return allTrades.filter(
      (t) => (t.accountId ?? "default") === activeAccountId,
    );
  }, [allTrades, activeAccountId]);

  // Auto-clear sync errors after 6 seconds
  useEffect(() => {
    if (!syncError) return;
    const timer = setTimeout(() => setSyncError(null), 6000);
    return () => clearTimeout(timer);
  }, [syncError]);

  // Sync across tabs via storage event
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      // Phase 41 (R44-UI-2): match against the same constant storage.ts uses.
      // Was a hardcoded literal that drifted silently if storage.ts ever
      // renamed the key.
      //
      // Phase 95 (R54-STO-4): also listen on SCREENSHOTS_KEY so a
      // sibling tab's screenshot upload / orphan cleanup re-attaches
      // images in this tab without a manual refresh.
      if (e.key === STORAGE_KEY || e.key === SCREENSHOTS_KEY) {
        setAllTrades(loadTrades());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // Round 56 (R56-STO-1): surface localStorage QuotaExceededError as a
  // sync-error toast so the user sees something actionable instead of a
  // silent drop. The event is dispatched from saveTrades when the
  // browser refuses a write because the ~5 MB localStorage quota is
  // saturated (typically: too many large screenshots).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { tradeCount?: number; screenshotCount?: number }
        | undefined;
      const screenshots = detail?.screenshotCount ?? 0;
      setSyncError(
        `Browser storage is full (5 MB limit reached, ${screenshots} screenshot(s) attached). ` +
          `Recent edits may not have been saved locally. Delete some old screenshots to free space.`,
      );
    };
    window.addEventListener(QUOTA_EXCEEDED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_EXCEEDED_EVENT, handler);
  }, []);

  // Load trades on mount and when auth state changes
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const isInitialLoad = !hasLoadedInitialDataRef.current;

      // Only block the UI during the very first data load.
      if (isInitialLoad) {
        setIsLoading(true);
      }

      try {
        if (isCloud) {
          // Phase 95 (R54-STO-2): drain any pending retry-queue from a
          // previous partial bulk-upsert before trusting the cloud
          // snapshot. If the drain fails (cloud still down), keep
          // local data — overwriting it with the cloud subset would
          // permanently lose the un-uploaded chunk.
          const drained = await saveBulkTradesToSupabase(
            supabase!,
            [],
            user!.id,
          );
          if (cancelled) return;
          if (!drained) {
            console.warn(
              "[useTradeStorage] retry-queue still pending; keeping local data this load",
            );
            setAllTrades(loadTrades());
            return;
          }
          const cloudTrades = await loadTradesFromSupabase(supabase!, user!.id);
          if (cancelled) return;
          setAllTrades(cloudTrades);
          saveTrades(cloudTrades);
        } else {
          if (cancelled) return;
          setAllTrades(loadTrades());
        }
      } catch (err) {
        if (cancelled) return;
        console.error("Cloud load failed, falling back to local:", err);
        setAllTrades(loadTrades());
      } finally {
        // Phase 66 (ESLint no-unsafe-finally): finally is reached on both
        // success and error paths; cancelled is the only signal we care
        // about here. Skip state updates instead of returning from finally
        // (which would override the outer try/catch resolution).
        if (!cancelled) {
          hasLoadedInitialDataRef.current = true;
          setIsLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user, supabase, isCloud]);

  const addTrade = useCallback(
    async (trade: Trade) => {
      // Auto-assign active account if not set
      const tradeWithAccount = {
        ...trade,
        accountId: trade.accountId || activeAccountId,
      };
      const updated = addTradeLocal(tradeWithAccount);
      setAllTrades(updated);
      fireWebhook("onTradeAdd", tradeWithAccount);
      if (isCloud) {
        try {
          await saveTradeToSupabase(supabase!, tradeWithAccount, user!.id);
        } catch (err) {
          console.error("Cloud sync failed for addTrade:", err);
          setSyncError(
            "Failed to sync new trade to cloud. Your data is saved locally.",
          );
        }
      }
    },
    [isCloud, supabase, user, activeAccountId],
  );

  const editTrade = useCallback(
    async (trade: Trade) => {
      const updated = updateTradeLocal(trade);
      setAllTrades(updated);
      fireWebhook("onTradeEdit", trade);
      if (isCloud) {
        try {
          await saveTradeToSupabase(supabase!, trade, user!.id);
        } catch (err) {
          console.error("Cloud sync failed for editTrade:", err);
          setSyncError(
            "Failed to sync trade update to cloud. Your data is saved locally.",
          );
        }
      }
    },
    [isCloud, supabase, user],
  );

  const removeTrade = useCallback(
    async (tradeId: string) => {
      const removedTrade = allTradesRef.current.find((t) => t.id === tradeId);
      const updated = deleteTradeLocal(tradeId);
      setAllTrades(updated);
      fireWebhook("onTradeDelete", removedTrade);
      if (isCloud) {
        try {
          await deleteTradeFromSupabase(supabase!, tradeId, user!.id);
        } catch (err) {
          console.error("Cloud sync failed for removeTrade:", err);
          setSyncError(
            "Failed to sync trade deletion to cloud. Your data is saved locally.",
          );
        }
      }
    },
    [isCloud, supabase, user],
  );

  const importTrades = useCallback(
    async (newTrades: Trade[]) => {
      const existing = loadTrades();
      const existingIds = new Set(existing.map((t) => t.id));
      // Auto-assign active account to imported trades
      const unique = newTrades
        .filter((t) => !existingIds.has(t.id))
        .map((t) => ({ ...t, accountId: t.accountId || activeAccountId }));
      const merged = [...existing, ...unique];
      saveTrades(merged);
      setAllTrades(merged);
      if (isCloud) {
        try {
          await saveBulkTradesToSupabase(supabase!, unique, user!.id);
        } catch (err) {
          console.error("Cloud sync failed for importTrades:", err);
          setSyncError(
            "Failed to sync imported trades to cloud. Your data is saved locally.",
          );
        }
      }
      return unique.length;
    },
    [isCloud, supabase, user, activeAccountId],
  );

  const clearAll = useCallback(async () => {
    clearAllData();
    setAllTrades([]);
    if (isCloud) {
      try {
        await clearAllSupabaseTrades(supabase!, user!.id);
      } catch (err) {
        console.error("Cloud sync failed for clearAll:", err);
        setSyncError("Failed to clear cloud data. Please try again.");
      }
    }
  }, [isCloud, supabase, user]);

  const replaceTrades = useCallback(
    async (newTrades: Trade[]) => {
      saveTrades(newTrades);
      setAllTrades(newTrades);
      if (isCloud) {
        try {
          // Clear existing cloud data first to prevent stale trades from persisting
          await clearAllSupabaseTrades(supabase!, user!.id);
          if (newTrades.length > 0) {
            await saveBulkTradesToSupabase(supabase!, newTrades, user!.id);
          }
        } catch (err) {
          console.error("Cloud sync failed for setAllTrades:", err);
          setSyncError(
            "Failed to sync trades to cloud. Your data is saved locally.",
          );
        }
      }
    },
    [isCloud, supabase, user],
  );

  const dismissSyncError = useCallback(() => setSyncError(null), []);

  return {
    trades,
    isLoading,
    isCloud,
    syncError,
    dismissSyncError,
    addTrade,
    editTrade,
    removeTrade,
    importTrades,
    clearAll,
    setAllTrades: replaceTrades,
  };
}
