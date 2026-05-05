"use client";

import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/utils/indicators";

export type LiveTimeframe =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "1d"
  | "1w";
export type ConnectionStatus =
  | "idle"
  | "loading"
  | "connected"
  | "error"
  | "closed";

interface BinanceKlineMsg {
  e: string;
  E: number;
  s: string;
  k: {
    t: number;
    T: number;
    s: string;
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean;
  };
}

type BinanceRestKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

const MAX_CANDLES = 300;

function parseKlineMessage(k: BinanceKlineMsg["k"]): Candle {
  return {
    openTime: k.t,
    closeTime: k.T,
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
    isFinal: k.x,
  };
}

function parseRestKline(row: BinanceRestKline): Candle {
  return {
    openTime: row[0],
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    closeTime: row[6],
    isFinal: true,
  };
}

export interface UseLiveCandlesOptions {
  symbol: string;
  timeframe: LiveTimeframe;
  history?: number;
}

export interface UseLiveCandlesResult {
  candles: Candle[];
  status: ConnectionStatus;
  error: string | null;
}

// Round 6 audit (HOCH): exponential-backoff reconnect for transient WS
// drops. Without this, a brief network blip put the chart into a permanent
// "closed" state until the user navigated away and back. Caps at 5 attempts
// and 30s delay to avoid thundering-herd if Binance is genuinely down.
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function useLiveCandles({
  symbol,
  timeframe,
  history = 200,
}: UseLiveCandlesOptions): UseLiveCandlesResult {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Round 6 audit (HOCH): attempt counter survives across reconnect ticks
  // but resets on a successful onopen. Stored in a ref so updates don't
  // trigger re-renders.
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    setCandles([]);
    reconnectAttemptRef.current = 0;

    const lowerSymbol = symbol.toLowerCase();
    const restUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${timeframe}&limit=${history}`;

    // Phase 54 (R45-UI-M4): AbortController so a rapid symbol/timeframe
    // switch cancels the previous fetch before it can resolve and open
    // a stale WebSocket. The cancelled flag alone blocked setCandles
    // but `connectWebSocket()` ran from the resolved promise — opened
    // a WS for the OLD symbol that the cleanup couldn't reach because
    // wsRef had already been overwritten by the new effect run.
    const abort = new AbortController();

    fetch(restUrl, { signal: abort.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
        return res.json();
      })
      .then((rows: BinanceRestKline[]) => {
        if (cancelled) return;
        setCandles(rows.map(parseRestKline));
        connectWebSocket();
      })
      .catch((err) => {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load history");
      });

    function scheduleReconnect() {
      if (cancelled) return;
      const attempt = reconnectAttemptRef.current;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        setStatus("error");
        setError("WebSocket reconnect failed after 5 attempts");
        return;
      }
      const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!cancelled) connectWebSocket();
      }, delay);
    }

    function connectWebSocket() {
      const ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${lowerSymbol}@kline_${timeframe}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (!cancelled) {
          // Round 6 audit (HOCH): reset attempt counter on a confirmed open
          // so a stable connection that drops later gets a fresh budget.
          reconnectAttemptRef.current = 0;
          setStatus("connected");
          setError(null);
        }
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg: BinanceKlineMsg = JSON.parse(event.data);
          if (msg.e !== "kline") return;
          const candle = parseKlineMessage(msg.k);
          setCandles((prev) => {
            const next = [...prev];
            // Phase 78: length check guards both reads.
            if (
              next.length > 0 &&
              next[next.length - 1]!.openTime === candle.openTime
            ) {
              next[next.length - 1] = candle;
            } else {
              next.push(candle);
              if (next.length > MAX_CANDLES) next.shift();
            }
            return next;
          });
        } catch {
          // silently ignore malformed messages; the stream will continue
        }
      };

      ws.onerror = () => {
        if (!cancelled) {
          setStatus("error");
          setError("WebSocket error");
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setStatus("closed");
        // Round 6 audit (HOCH): trigger backoff reconnect. The cleanup
        // path sets `cancelled` first, so a deliberate close-on-unmount
        // bails above without scheduling.
        scheduleReconnect();
      };
    }

    return () => {
      cancelled = true;
      abort.abort();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // Round 58 Fix 3: avoid closing a WebSocket while it is still in
      // CONNECTING state — that produces a half-opened TCP connection
      // (server sees connect → immediate FIN). Defer close until the
      // socket reaches OPEN by replacing onopen with an immediate close.
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = () => ws.close();
        } else {
          ws.close();
        }
      }
    };
  }, [symbol, timeframe, history]);

  return { candles, status, error };
}
