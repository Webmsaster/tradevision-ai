/**
 * longShortRatio tests.
 *
 * Covers fetchLongShortRatio: URL construction (symbol uppercased,
 * period passthrough, limit default + cap at 500), numeric parsing,
 * ascending time sort, non-ok error path, abort-signal forwarding.
 * Mirrors the openInterest.test.ts pattern (same Binance futures-data
 * endpoint family).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLongShortRatio } from "@/utils/longShortRatio";

type FetchMock = ReturnType<typeof vi.fn>;

function makeOkResponse(rows: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => rows,
  };
}

function stubFetch(response: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}): FetchMock {
  const mock: FetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLongShortRatio — happy path", () => {
  it("parses string fields to numbers and sorts ascending by time", async () => {
    const fetchMock = stubFetch(
      makeOkResponse([
        {
          symbol: "BTCUSDT",
          longShortRatio: "2.61",
          longAccount: "0.723",
          shortAccount: "0.277",
          timestamp: 2000,
        },
        {
          symbol: "BTCUSDT",
          longShortRatio: "1.95",
          longAccount: "0.661",
          shortAccount: "0.339",
          timestamp: 1000,
        },
      ]),
    );
    const samples = await fetchLongShortRatio({
      symbol: "btcusdt",
      period: "1h",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(samples).toHaveLength(2);
    // Oldest first despite reversed input order.
    expect(samples[0]).toEqual({
      time: 1000,
      longShortRatio: 1.95,
      longAccount: 0.661,
      shortAccount: 0.339,
    });
    expect(samples[1]!.time).toBe(2000);
    expect(samples[1]!.longShortRatio).toBeCloseTo(2.61);
  });

  it("uppercases the symbol and defaults limit to 500", async () => {
    const fetchMock = stubFetch(makeOkResponse([]));
    await fetchLongShortRatio({ symbol: "ethusdt", period: "4h" });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe(
      "https://fapi.binance.com/futures/data/globalLongShortAccountRatio",
    );
    expect(url.searchParams.get("symbol")).toBe("ETHUSDT");
    expect(url.searchParams.get("period")).toBe("4h");
    expect(url.searchParams.get("limit")).toBe("500");
  });

  it("caps an oversized limit at 500 and passes a smaller limit through", async () => {
    const fetchMock = stubFetch(makeOkResponse([]));
    await fetchLongShortRatio({ symbol: "BTCUSDT", period: "5m", limit: 9999 });
    await fetchLongShortRatio({ symbol: "BTCUSDT", period: "5m", limit: 42 });
    const first = new URL(fetchMock.mock.calls[0]![0] as string);
    const second = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(first.searchParams.get("limit")).toBe("500");
    expect(second.searchParams.get("limit")).toBe("42");
  });

  it("forwards the abort signal to fetch", async () => {
    const fetchMock = stubFetch(makeOkResponse([]));
    const controller = new AbortController();
    await fetchLongShortRatio({
      symbol: "BTCUSDT",
      period: "1d",
      signal: controller.signal,
    });
    const init = fetchMock.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBe(controller.signal);
  });
});

describe("fetchLongShortRatio — error path", () => {
  it("throws with the HTTP status on a non-ok response", async () => {
    stubFetch({ ok: false, status: 429, json: async () => ({}) });
    await expect(
      fetchLongShortRatio({ symbol: "BTCUSDT", period: "1h" }),
    ).rejects.toThrow("L/S ratio fetch failed: 429");
  });
});
