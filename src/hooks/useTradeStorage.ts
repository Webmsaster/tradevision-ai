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
} from "@/utils/storage";
import {
  loadTradesFromSupabase,
  saveTradeToSupabase,
  deleteTradeFromSupabase,
  saveBulkTradesToSupabase,
  clearAllSupabaseTrades,
} from "@/utils/storage";

// Phase 41 (R44-STO-H1): block private/loopback/link-local hosts so a
// user-configured webhook URL can't be used to probe internal services
// (cloud-metadata 169.254.169.254, localhost daemons, *.internal). The
// fetch is browser-side so cross-origin reads are blocked already, but
// the POST body still reaches the target's logs — block at the URL gate.
function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0") return true;
  if (
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".localhost")
  )
    return true;
  // IPv4 literals
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a >= 224) return true; // multicast / reserved
  }
  // IPv6 literals (URL host strips brackets when bracketed)
  if (h.startsWith("::") || h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 ULA
  if (h.startsWith("fe80")) return true; // link-local
  return false;
}

function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPrivateHostname(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

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

    // Phase 41 (R44-STO-H2): strip screenshot from webhook payload. The
    // base64 data URL can be up to 2 MB and inflates every notification —
    // bandwidth waste, privacy leak (screenshot may show MT5 account
    // numbers), and Discord/Slack reject oversized payloads.
    const tradeForWebhook = trade ? { ...trade, screenshot: undefined } : trade;
    const payload =
      wh.platform === "discord"
        ? { content: msg }
        : wh.platform === "telegram"
          ? { text: msg }
          : { event, message: msg, trade: tradeForWebhook };

    fetch(wh.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
  }, []);

  // Filter trades by active account
  const trades = useMemo(() => {
    if (activeAccountId === "default") return allTrades;
    return allTrades.filter(
      (t) => !t.accountId || t.accountId === activeAccountId,
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
      if (e.key === STORAGE_KEY) {
        setAllTrades(loadTrades());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
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
        if (cancelled) return;
        hasLoadedInitialDataRef.current = true;
        setIsLoading(false);
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
