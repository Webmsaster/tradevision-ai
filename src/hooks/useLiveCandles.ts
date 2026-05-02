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

export function useLiveCandles({
  symbol,
  timeframe,
  history = 200,
}: UseLiveCandlesOptions): UseLiveCandlesResult {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    setCandles([]);

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

    function connectWebSocket() {
      const ws = new WebSocket(
        `wss://stream.binance.com:9443/ws/${lowerSymbol}@kline_${timeframe}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (!cancelled) setStatus("connected");
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg: BinanceKlineMsg = JSON.parse(event.data);
          if (msg.e !== "kline") return;
          const candle = parseKlineMessage(msg.k);
          setCandles((prev) => {
            const next = [...prev];
            if (
              next.length > 0 &&
              next[next.length - 1].openTime === candle.openTime
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
        if (!cancelled) setStatus("closed");
      };
    }

    return () => {
      cancelled = true;
      abort.abort();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [symbol, timeframe, history]);

  return { candles, status, error };
}
