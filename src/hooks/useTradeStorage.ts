'use client';
import { useState, useEffect, useCallback } from 'react';
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

export function useTradeStorage() {
  const { user, supabase } = useAuth();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isCloud = !!user && !!supabase;

  // Load trades on mount and when auth state changes
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      if (isCloud) {
        try {
          const cloudTrades = await loadTradesFromSupabase(supabase!, user!.id);
          setTrades(cloudTrades);
          // Also cache to localStorage for offline access
          saveTrades(cloudTrades);
        } catch (err) {
          console.error('Cloud load failed, falling back to local:', err);
          setTrades(loadTrades());
        }
      } else {
        setTrades(loadTrades());
      }
      setIsLoading(false);
    }
    load();
  }, [user, supabase, isCloud]);

  const addTrade = useCallback(async (trade: Trade) => {
    // Always save locally first
    const updated = addTradeLocal(trade);
    setTrades(updated);
    fireWebhook('onTradeAdd', trade);
    // Sync to cloud if available
    if (isCloud) {
      try {
        await saveTradeToSupabase(supabase!, trade, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for addTrade:', err);
      }
    }
  }, [isCloud, supabase, user]);

  const editTrade = useCallback(async (trade: Trade) => {
    const updated = updateTradeLocal(trade);
    setTrades(updated);
    fireWebhook('onTradeEdit', trade);
    if (isCloud) {
      try {
        await saveTradeToSupabase(supabase!, trade, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for editTrade:', err);
      }
    }
  }, [isCloud, supabase, user]);

  const removeTrade = useCallback(async (tradeId: string) => {
    const removedTrade = trades.find(t => t.id === tradeId);
    const updated = deleteTradeLocal(tradeId);
    setTrades(updated);
    fireWebhook('onTradeDelete', removedTrade);
    if (isCloud) {
      try {
        await deleteTradeFromSupabase(supabase!, tradeId);
      } catch (err) {
        console.error('Cloud sync failed for removeTrade:', err);
      }
    }
  }, [isCloud, supabase, user, trades]);

  const importTrades = useCallback(async (newTrades: Trade[]) => {
    const existing = loadTrades();
    const existingIds = new Set(existing.map(t => t.id));
    const unique = newTrades.filter(t => !existingIds.has(t.id));
    const merged = [...existing, ...unique];
    saveTrades(merged);
    setTrades(merged);
    if (isCloud) {
      try {
        await saveBulkTradesToSupabase(supabase!, unique, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for importTrades:', err);
      }
    }
    return unique.length;
  }, [isCloud, supabase, user]);

  const clearAll = useCallback(async () => {
    clearAllData();
    setTrades([]);
    if (isCloud) {
      try {
        await clearAllSupabaseTrades(supabase!, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for clearAll:', err);
      }
    }
  }, [isCloud, supabase, user]);

  const setAllTrades = useCallback(async (newTrades: Trade[]) => {
    saveTrades(newTrades);
    setTrades(newTrades);
    if (isCloud) {
      try {
        await saveBulkTradesToSupabase(supabase!, newTrades, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for setAllTrades:', err);
      }
    }
  }, [isCloud, supabase, user]);

  return {
    trades,
    isLoading,
    isCloud,
    addTrade,
    editTrade,
    removeTrade,
    importTrades,
    clearAll,
    setAllTrades,
  };
}
