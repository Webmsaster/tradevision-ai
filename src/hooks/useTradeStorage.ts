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
    if (isCloud) {
      try {
        await saveTradeToSupabase(supabase!, trade, user!.id);
      } catch (err) {
        console.error('Cloud sync failed for editTrade:', err);
      }
    }
  }, [isCloud, supabase, user]);

  const removeTrade = useCallback(async (tradeId: string) => {
    const updated = deleteTradeLocal(tradeId);
    setTrades(updated);
    if (isCloud) {
      try {
        await deleteTradeFromSupabase(supabase!, tradeId);
      } catch (err) {
        console.error('Cloud sync failed for removeTrade:', err);
      }
    }
  }, [isCloud, supabase, user]);

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
