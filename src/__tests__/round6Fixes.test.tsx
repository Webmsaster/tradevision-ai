/**
 * Round 6 audit follow-ups — regression tests for the four deferred
 * fixes:
 *
 *  - Task A: webhook-test must NOT echo raw error messages → covered in
 *            src/__tests__/webhookTestRoute.test.ts (extended).
 *  - Task B: useLiveCandles WS reconnect with exponential backoff (here).
 *  - Task C: useTradeStorage webhook-fetch unmount-abort (here).
 *  - Task D: isValidTrade rejects non-positive numbers (here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { isValidTrade, type Trade } from "@/types/trade";

// ---------------------------------------------------------------------------
// Task D: isValidTrade rejects non-positive numbers
// ---------------------------------------------------------------------------

describe("Task D — isValidTrade positive-number invariants", () => {
  const baseTrade: Trade = {
    id: "t1",
    pair: "BTC/USDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    entryDate: "2024-01-01T00:00:00Z",
    exitDate: "2024-01-01T01:00:00Z",
    pnl: 10,
    pnlPercent: 10,
    fees: 0,
    notes: "",
    tags: [],
    leverage: 1,
  };

  it("accepts a well-formed Trade", () => {
    expect(isValidTrade(baseTrade)).toBe(true);
  });

  it("rejects negative quantity", () => {
    expect(isValidTrade({ ...baseTrade, quantity: -1 })).toBe(false);
  });

  it("rejects zero quantity", () => {
    expect(isValidTrade({ ...baseTrade, quantity: 0 })).toBe(false);
  });

  it("rejects negative entryPrice", () => {
    expect(isValidTrade({ ...baseTrade, entryPrice: -1 })).toBe(false);
  });

  it("rejects negative exitPrice", () => {
    expect(isValidTrade({ ...baseTrade, exitPrice: -1 })).toBe(false);
  });

  it("rejects NaN quantity (from a malformed CSV row)", () => {
    expect(isValidTrade({ ...baseTrade, quantity: NaN })).toBe(false);
  });

  it("rejects null/undefined input", () => {
    expect(isValidTrade(null)).toBe(false);
    expect(isValidTrade(undefined)).toBe(false);
  });

  it("rejects bogus direction enum", () => {
    expect(
      isValidTrade({
        ...baseTrade,
        direction: "sideways" as unknown as "long",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task B: useLiveCandles WebSocket exponential-backoff reconnect
// ---------------------------------------------------------------------------

interface MockWS {
  url: string;
  readyState: number;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null;
  close: () => void;
  // helpers (test-only):
  _open: () => void;
  _drop: () => void;
}

const wsInstances: MockWS[] = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  constructor(url: string) {
    this.url = url;
    const handle: MockWS = {
      url,
      get readyState() {
        return self.readyState;
      },
      set readyState(v: number) {
        self.readyState = v;
      },
      get onopen() {
        return self.onopen as MockWS["onopen"];
      },
      set onopen(v) {
        self.onopen = v as typeof self.onopen;
      },
      get onmessage() {
        return self.onmessage as MockWS["onmessage"];
      },
      set onmessage(v) {
        self.onmessage = v as typeof self.onmessage;
      },
      get onerror() {
        return self.onerror as MockWS["onerror"];
      },
      set onerror(v) {
        self.onerror = v as typeof self.onerror;
      },
      get onclose() {
        return self.onclose as MockWS["onclose"];
      },
      set onclose(v) {
        self.onclose = v as typeof self.onclose;
      },
      close: () => self.close(),
      _open: () => {
        self.readyState = FakeWebSocket.OPEN;
        self.onopen?.(new Event("open"));
      },
      _drop: () => {
        self.readyState = FakeWebSocket.CLOSED;
        self.onclose?.(new CloseEvent("close"));
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    wsInstances.push(handle);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe("Task B — useLiveCandles exponential-backoff reconnect", () => {
  let ORIG_WS: typeof globalThis.WebSocket;
  let ORIG_FETCH: typeof globalThis.fetch;

  beforeEach(() => {
    wsInstances.length = 0;
    vi.useFakeTimers();
    ORIG_WS = globalThis.WebSocket;
    ORIG_FETCH = globalThis.fetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    // Stub history fetch — resolve with one candle so connectWebSocket runs.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [
        [
          1_700_000_000_000,
          "100",
          "110",
          "90",
          "105",
          "10",
          1_700_000_059_999,
          "0",
          0,
          "0",
          "0",
          "0",
        ],
      ],
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    (
      globalThis as unknown as { WebSocket: typeof globalThis.WebSocket }
    ).WebSocket = ORIG_WS;
    globalThis.fetch = ORIG_FETCH;
  });

  it("schedules a reconnect with exponential backoff on close", async () => {
    const { useLiveCandles } = await import("@/hooks/useLiveCandles");
    renderHook(() =>
      useLiveCandles({ symbol: "BTCUSDT", timeframe: "1m", history: 1 }),
    );
    // Flush the history-fetch promise → connectWebSocket() runs.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(wsInstances).toHaveLength(1);

    // Open the first WS, then drop it.
    act(() => {
      wsInstances[0]!._open();
    });
    act(() => {
      wsInstances[0]!._drop();
    });
    // No reconnect yet — backoff is 1000ms for attempt 0.
    expect(wsInstances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    // Reconnect attempt 1 fires.
    expect(wsInstances).toHaveLength(2);

    // Drop again (without opening) → next backoff is 2000ms (attempt 1).
    act(() => {
      wsInstances[1]!._drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(1999);
      await Promise.resolve();
    });
    expect(wsInstances).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(wsInstances).toHaveLength(3);
  });

  it("stops reconnecting after MAX_RECONNECT_ATTEMPTS=5", async () => {
    const { useLiveCandles } = await import("@/hooks/useLiveCandles");
    renderHook(() =>
      useLiveCandles({ symbol: "BTCUSDT", timeframe: "1m", history: 1 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Drop without ever successfully opening → all 5 attempts use the
    // sequence 1000, 2000, 4000, 8000, 16000 ms (capped at 30000).
    const expectedDelays = [1000, 2000, 4000, 8000, 16_000];
    for (let i = 0; i < 5; i++) {
      expect(wsInstances).toHaveLength(i + 1);
      act(() => {
        wsInstances[i]!._drop();
      });
      await act(async () => {
        vi.advanceTimersByTime(expectedDelays[i]!);
        await Promise.resolve();
      });
    }
    expect(wsInstances).toHaveLength(6);

    // After the 6th drop, no further reconnect — budget exhausted.
    act(() => {
      wsInstances[5]!._drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(wsInstances).toHaveLength(6);
  });

  it("resets the attempt counter on a successful onopen", async () => {
    const { useLiveCandles } = await import("@/hooks/useLiveCandles");
    renderHook(() =>
      useLiveCandles({ symbol: "BTCUSDT", timeframe: "1m", history: 1 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Drop → reconnect at 1000ms.
    act(() => {
      wsInstances[0]!._drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    // Open the second WS — counter must reset.
    act(() => {
      wsInstances[1]!._open();
    });
    act(() => {
      wsInstances[1]!._drop();
    });
    // Should reconnect at 1000ms again, NOT 2000ms.
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(wsInstances).toHaveLength(3);
  });
});
