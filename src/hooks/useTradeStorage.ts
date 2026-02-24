'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Trade } from '@/types/trade';
import { useAuth } from '@/lib/auth-context';
import {
  loadTrades, saveTrades, addTrade as addTradeLocal,
  updateTrade as updateTradeLocal, deleteTrade as deleteTradeLocal,
  clearAllData,
} from '@/utils/storage';
import {
  loadTradesFromSupabase, saveTradeToSupabase,
  deleteTradeFromSupabase, saveBulkTradesToSupabase,
  clearAllSupabaseTrades,
} from '@/utils/storage';

// Fire webhook notification for trade events (best-effort, never blocks)
function fireWebhook(event: 'onTradeAdd' | 'onTradeEdit' | 'onTradeDelete', trade?: Trade) {
  try {
    const raw = localStorage.getItem('tradevision-settings');
    if (!raw) return;
    const settings = JSON.parse(raw);
    const wh = settings.webhook;
    if (!wh?.enabled || !wh?.url || !wh.events?.[event]) return;

    const msg = event === 'onTradeAdd'
      ? `New trade: ${trade?.pair} ${trade?.direction?.toUpperCase()} — PnL: $${trade?.pnl?.toFixed(2)}`
      : event === 'onTradeEdit'
        ? `Trade updated: ${trade?.pair} — PnL: $${trade?.pnl?.toFixed(2)}`
        : `Trade deleted: ${trade?.pair ?? 'unknown'}`;

    const payload = wh.platform === 'discord'
      ? { content: msg }
      : wh.platform === 'telegram'
        ? { text: msg }
        : { event, message: msg, trade };

    fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {}); // best-effort
  } catch {}
}

function getActiveAccountId(): string {
  try {
    const raw = localStorage.getItem('tradevision-settings');
    if (raw) {
      const settings = JSON.parse(raw);
      if (settings.activeAccountId) return settings.activeAccountId;
    }
  } catch {}
  return 'default';
}

export function useTradeStorage() {
  const { user, supabase } = useAuth();
  const [allTrades, setAllTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [activeAccountId, setActiveAccountId] = useState('default');
  const isCloud = !!user && !!supabase;

  // Listen for settings changes to update active account
  useEffect(() => {
    setActiveAccountId(getActiveAccountId());
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.activeAccountId) setActiveAccountId(detail.activeAccountId);
    };
    window.addEventListener('tradevision-settings-changed', handler);
    return () => window.removeEventListener('tradevision-settings-changed', handler);
  }, []);

  // Filter trades by active account
  const trades = useMemo(() => {
    if (activeAccountId === 'default') return allTrades;
    return allTrades.filter(t => !t.accountId || t.accountId === activeAccountId);
  }, [allTrades, activeAccountId]);

  // Auto-clear sync errors after 6 seconds
  useEffect(() => {
    if (!syncError) return;
    const timer = setTimeout(() => setSyncError(null), 6000);
    return () => clearTimeout(timer);
  }, [syncError]);

  // Load trades on mount and when auth state changes
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      if (isCloud) {
        try {
          const cloudTrades = await loadTradesFromSupabase(supabase!, user!.id);
          setAllTrades(cloudTrades);
          saveTrades(cloudTrades);
        } catch (err) {
          console.error('Cloud load failed, falling back to local:', err);
          setAllTrades(loadTrades());
        }
      } else {
        setAllTrades(loadTrades());
      }
      setIsLoading(false);
    }
    load();
  }, [user, supabase, isCloud]);

  const addTrade = useCallback(async (trade: Trade) => {
    // Auto-assign active account if not set
    const tradeWithAccount = { ...trade, accountId: trade.accountId || activeAccountId };
    const updated = addTradeLocal(tradeWithAccount);
    setAllTrades(updated);
    fireWebhook('onTradeAdd', tradeWithAccount);
    if (isCloud) {
      try {
        await saveTradeToSupabase(supabase!, tradeWithAccount, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for addTrade:', err);
        setSyncError('Failed to sync new trade to cloud. Your data is saved locally.');
      }
    }
  }, [isCloud, supabase, user, activeAccountId]);

  const editTrade = useCallback(async (trade: Trade) => {
    const updated = updateTradeLocal(trade);
    setAllTrades(updated);
    fireWebhook('onTradeEdit', trade);
    if (isCloud) {
      try {
        await saveTradeToSupabase(supabase!, trade, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for editTrade:', err);
        setSyncError('Failed to sync trade update to cloud. Your data is saved locally.');
      }
    }
  }, [isCloud, supabase, user]);

  const removeTrade = useCallback(async (tradeId: string) => {
    const removedTrade = allTrades.find(t => t.id === tradeId);
    const updated = deleteTradeLocal(tradeId);
    setAllTrades(updated);
    fireWebhook('onTradeDelete', removedTrade);
    if (isCloud) {
      try {
        await deleteTradeFromSupabase(supabase!, tradeId);
      } catch (err) {
        console.error('Cloud sync failed for removeTrade:', err);
        setSyncError('Failed to sync trade deletion to cloud. Your data is saved locally.');
      }
    }
  }, [isCloud, supabase, user, allTrades]);

  const importTrades = useCallback(async (newTrades: Trade[]) => {
    const existing = loadTrades();
    const existingIds = new Set(existing.map(t => t.id));
    // Auto-assign active account to imported trades
    const unique = newTrades
      .filter(t => !existingIds.has(t.id))
      .map(t => ({ ...t, accountId: t.accountId || activeAccountId }));
    const merged = [...existing, ...unique];
    saveTrades(merged);
    setAllTrades(merged);
    if (isCloud) {
      try {
        await saveBulkTradesToSupabase(supabase!, unique, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for importTrades:', err);
        setSyncError('Failed to sync imported trades to cloud. Your data is saved locally.');
      }
    }
    return unique.length;
  }, [isCloud, supabase, user, activeAccountId]);

  const clearAll = useCallback(async () => {
    clearAllData();
    setAllTrades([]);
    if (isCloud) {
      try {
        await clearAllSupabaseTrades(supabase!, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for clearAll:', err);
        setSyncError('Failed to clear cloud data. Please try again.');
      }
    }
  }, [isCloud, supabase, user]);

  const replaceTrades = useCallback(async (newTrades: Trade[]) => {
    saveTrades(newTrades);
    setAllTrades(newTrades);
    if (isCloud) {
      try {
        await saveBulkTradesToSupabase(supabase!, newTrades, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for setAllTrades:', err);
        setSyncError('Failed to sync trades to cloud. Your data is saved locally.');
      }
    }
  }, [isCloud, supabase, user]);

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
