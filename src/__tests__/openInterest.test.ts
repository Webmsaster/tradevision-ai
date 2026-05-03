/**
 * openInterest tests — Round 54.
 *
 * Covers fetchOpenInterestHistory: URL construction (symbol uppercase,
 * period passthrough, limit cap at 500), happy-path parsing + sorting,
 * non-ok error path, abort-signal forwarding.
 *
 * Goal per Round 54 Agent 9: 30-50% branch coverage on this module
 * (recently changed in R43 — ensure no regression).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenInterestHistory } from "@/utils/openInterest";

type FetchMock = ReturnType<typeof vi.fn>;

function makeOkResponse(rows: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => rows,
  };
}

function stubFetch(response: ReturnType<typeof makeOkResponse>): FetchMock {
  const mock: FetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("openInterest — happy path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses, converts numeric fields, and sorts ascending by time", async () => {
    // Provide rows OUT of order to verify the sort step.
    const fetchMock = stubFetch(
      makeOkResponse([
        {
          symbol: "BTCUSDT",
          sumOpenInterest: "1000.5",
          sumOpenInterestValue: "50000000",
          timestamp: 2000,
        },
        {
          symbol: "BTCUSDT",
          sumOpenInterest: "999.0",
          sumOpenInterestValue: "49800000",
          timestamp: 1000,
        },
      ]),
    );
    const samples = await fetchOpenInterestHistory({
      symbol: "btcusdt",
      period: "1h",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(samples).toHaveLength(2);
    // Sort: oldest (1000) first.
    expect(samples[0]!.time).toBe(1000);
    expect(samples[0]!.sumOpenInterest).toBeCloseTo(999.0, 5);
    expect(samples[0]!.sumOpenInterestValueUsd).toBeCloseTo(49_800_000, 0);
    expect(samples[1]!.time).toBe(2000);
    expect(samples[1]!.sumOpenInterest).toBeCloseTo(1000.5, 5);
  });

  it("uppercases the symbol param + uses default limit=500", async () => {
    const fetchMock = stubFetch(makeOkResponse([]));
    await fetchOpenInterestHistory({ symbol: "ethusdt", period: "4h" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("symbol=ETHUSDT");
    expect(url).toContain("period=4h");
    expect(url).toContain("limit=500");
  });

  it("caps an oversized limit to 500", async () => {
    const fetchMock = stubFetch(makeOkResponse([]));
    await fetchOpenInterestHistory({
      symbol: "BTCUSDT",
      period: "5m",
      limit: 9999,
    });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("limit=500");
  });

  it("honours an explicit smaller limit", async () => {
    const fetchMock = stubFetch(makeOkResponse([]));
    await fetchOpenInterestHistory({
      symbol: "BTCUSDT",
      period: "1d",
      limit: 30,
    });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("limit=30");
  });

  it("forwards an AbortSignal to fetch", async () => {
    const fetchMock = stubFetch(makeOkResponse([]));
    const ac = new AbortController();
    await fetchOpenInterestHistory({
      symbol: "BTCUSDT",
      period: "1h",
      signal: ac.signal,
    });
    const init = fetchMock.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBe(ac.signal);
  });
});

describe("openInterest — error path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("non-ok HTTP response throws with status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({}),
      }),
    );
    await expect(
      fetchOpenInterestHistory({ symbol: "BTCUSDT", period: "1h" }),
    ).rejects.toThrow(/Binance OI fetch failed: 429/);
  });

  it("propagates fetch rejection (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network down")),
    );
    await expect(
      fetchOpenInterestHistory({ symbol: "BTCUSDT", period: "1h" }),
    ).rejects.toThrow(/network down/);
  });
});
