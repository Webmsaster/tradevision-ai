"use client";

import { useEffect, useRef, useState } from "react";
import type { SignalSnapshot } from "@/utils/signalEngine";

export interface TrackedSignal {
  id: string;
  symbol: string;
  timeframe: string;
  openTime: number;
  action: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  strength: number;
  confidence: number;
  status: "open" | "win" | "loss" | "expired";
  closeTime?: number;
  closePrice?: number;
  pnlR?: number;
}

const STORAGE_KEY = "tradevision-live-tracked-signals";
const MAX_STORED = 200;
const EXPIRY_MS = 12 * 60 * 60 * 1000;

function loadStored(): TrackedSignal[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_STORED) : [];
  } catch {
    return [];
  }
}

function persist(signals: TrackedSignal[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(signals.slice(-MAX_STORED)),
    );
  } catch {
    // ignore quota errors
  }
}

export interface UseSignalTrackingParams {
  symbol: string;
  timeframe: string;
  snapshot: SignalSnapshot | null;
  confidence: number;
  currentPrice: number | null;
}

export interface UseSignalTrackingResult {
  tracked: TrackedSignal[];
  openCount: number;
  todayLossStreak: number;
  circuitBreakerActive: boolean;
  clearAll: () => void;
}

export function useSignalTracking({
  symbol,
  timeframe,
  snapshot,
  confidence,
  currentPrice,
}: UseSignalTrackingParams): UseSignalTrackingResult {
  const [tracked, setTracked] = useState<TrackedSignal[]>([]);
  const lastRecordedActionRef = useRef<string | null>(null);

  // Load once on mount
  useEffect(() => {
    setTracked(loadStored());
  }, []);

  // Record new signals (flip to long/short with SL/TP)
  // Phase 33 (React Audit Bug 2): removed `tracked` from deps. Was causing
  // permanent re-renders + stale-closure (mostRecent was an old snapshot).
  // Round 12's R73 fix was incomplete. Now uses functional setTracked
  // which sees the FRESH `prev` state and does dedup inside the updater.
  useEffect(() => {
    if (!snapshot || !snapshot.levels || snapshot.action === "flat") return;
    const key = `${symbol}:${timeframe}:${snapshot.time}:${snapshot.action}`;
    if (lastRecordedActionRef.current === key) return;
    lastRecordedActionRef.current = key;
    // Phase 33: capture narrowed values OUTSIDE the closure so TS keeps
    // the action/levels narrowing inside setTracked.
    const action = snapshot.action;
    const levels = snapshot.levels;
    const time = snapshot.time;
    const strength = snapshot.strength;

    setTracked((prev) => {
      const mostRecent = prev[prev.length - 1];
      if (
        mostRecent &&
        mostRecent.status === "open" &&
        mostRecent.symbol === symbol &&
        mostRecent.timeframe === timeframe &&
        mostRecent.action === action
      ) {
        return prev;
      }
      const entry: TrackedSignal = {
        id: `${symbol}-${timeframe}-${time}-${action}`,
        symbol,
        timeframe,
        openTime: time,
        action,
        entry: levels.entry,
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
        strength,
        confidence,
        status: "open",
      };
      const next = [...prev, entry].slice(-MAX_STORED);
      persist(next);
      return next;
    });
  }, [snapshot, symbol, timeframe, confidence]);

  // Price-watcher: evaluate open positions
  useEffect(() => {
    if (currentPrice === null) return;
    const now = Date.now();
    setTracked((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.status !== "open") return t;
        const slDistance = Math.abs(t.entry - t.stopLoss);
        if (slDistance <= 0) return t;
        if (t.action === "long") {
          if (currentPrice <= t.stopLoss) {
            changed = true;
            return {
              ...t,
              status: "loss" as const,
              closeTime: now,
              closePrice: currentPrice,
              pnlR: -1,
            };
          }
          if (currentPrice >= t.takeProfit) {
            const pnlR = (currentPrice - t.entry) / slDistance;
            changed = true;
            return {
              ...t,
              status: "win" as const,
              closeTime: now,
              closePrice: currentPrice,
              pnlR,
            };
          }
        } else {
          if (currentPrice >= t.stopLoss) {
            changed = true;
            return {
              ...t,
              status: "loss" as const,
              closeTime: now,
              closePrice: currentPrice,
              pnlR: -1,
            };
          }
          if (currentPrice <= t.takeProfit) {
            const pnlR = (t.entry - currentPrice) / slDistance;
            changed = true;
            return {
              ...t,
              status: "win" as const,
              closeTime: now,
              closePrice: currentPrice,
              pnlR,
            };
          }
        }
        if (now - t.openTime > EXPIRY_MS) {
          changed = true;
          return {
            ...t,
            status: "expired" as const,
            closeTime: now,
            closePrice: currentPrice,
          };
        }
        return t;
      });
      if (changed) persist(next);
      return changed ? next : prev;
    });
  }, [currentPrice]);

  const openCount = tracked.filter(
    (t) => t.status === "open" && t.symbol === symbol,
  ).length;

  // Consecutive losses today for current symbol
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayClosed = tracked
    .filter(
      (t) => t.symbol === symbol && (t.status === "win" || t.status === "loss"),
    )
    .filter((t) => (t.closeTime ?? 0) >= startOfDay.getTime())
    .sort((a, b) => (b.closeTime ?? 0) - (a.closeTime ?? 0));
  let todayLossStreak = 0;
  for (const t of todayClosed) {
    if (t.status === "loss") todayLossStreak++;
    else break;
  }

  const circuitBreakerActive = todayLossStreak >= 3;

  function clearAll() {
    setTracked([]);
    persist([]);
  }

  return {
    tracked,
    openCount,
    todayLossStreak,
    circuitBreakerActive,
    clearAll,
  };
}
