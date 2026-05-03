/**
 * bybitBasis tests — Round 54.
 *
 * Covers fetchBybitBasis happy paths (each magnitude/signal branch) plus
 * the three error paths (HTTP non-ok, malformed payload, retCode != 0).
 * Goal per Round 54 Agent 9: 30-50% branch coverage on this module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBybitBasis } from "@/utils/bybitBasis";

type FetchMock = ReturnType<typeof vi.fn>;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function makeOkResponse(price: number): FakeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      retCode: 0,
      result: { list: [{ lastPrice: String(price) }] },
    }),
  };
}

function makeBadStatusResponse(): FakeResponse {
  return {
    ok: false,
    status: 503,
    json: async () => ({}),
  };
}

function makeMalformedResponse(): FakeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({ retCode: 0, result: { list: [] } }),
  };
}

function makeBadRetCodeResponse(): FakeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      retCode: 10001,
      result: { list: [{ lastPrice: "100" }] },
    }),
  };
}

/**
 * Stub the global fetch with a queue of responses (one per call).
 */
function stubFetchSequence(responses: FakeResponse[]) {
  const mock: FetchMock = vi.fn();
  for (const r of responses) mock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("bybitBasis — happy paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flat: |basis| < 0.05% → signal=flat / magnitude=noise", async () => {
    // spot 50000, perp 50010 → +0.02% → flat
    stubFetchSequence([makeOkResponse(50000), makeOkResponse(50010)]);
    const r = await fetchBybitBasis();
    expect(r.signal).toBe("flat");
    expect(r.magnitude).toBe("noise");
    expect(r.spotPriceUsdt).toBe(50000);
    expect(r.perpPriceUsdt).toBe(50010);
    expect(r.basisPct).toBeCloseTo(0.0002, 5);
    expect(r.interpretation).toMatch(/no structural tilt/);
    expect(typeof r.capturedAt).toBe("number");
  });

  it("contango moderate: 0.05%-0.15% → contango/moderate", async () => {
    // spot 50000, perp 50050 → +0.10% → contango moderate
    stubFetchSequence([makeOkResponse(50000), makeOkResponse(50050)]);
    const r = await fetchBybitBasis();
    expect(r.signal).toBe("contango");
    expect(r.magnitude).toBe("moderate");
    expect(r.interpretation).toMatch(/Mild contango/);
  });

  it("contango strong: 0.15%-0.30% → contango/strong", async () => {
    // spot 50000, perp 50100 → +0.20% → strong
    stubFetchSequence([makeOkResponse(50000), makeOkResponse(50100)]);
    const r = await fetchBybitBasis();
    expect(r.signal).toBe("contango");
    expect(r.magnitude).toBe("strong");
    expect(r.interpretation).toMatch(/Strong contango/);
  });

  it("contango extreme: > 0.3% → contango/extreme", async () => {
    // spot 50000, perp 50200 → +0.40% → extreme
    stubFetchSequence([makeOkResponse(50000), makeOkResponse(50200)]);
    const r = await fetchBybitBasis();
    expect(r.signal).toBe("contango");
    expect(r.magnitude).toBe("extreme");
    expect(r.interpretation).toMatch(/EXTREME contango/);
  });

  it("backwardation extreme: < -0.3% → backwardation/extreme", async () => {
    // spot 50000, perp 49800 → -0.40%
    stubFetchSequence([makeOkResponse(50000), makeOkResponse(49800)]);
    const r = await fetchBybitBasis();
    expect(r.signal).toBe("backwardation");
    expect(r.magnitude).toBe("extreme");
    expect(r.interpretation).toMatch(/EXTREME backwardation/);
  });

  it("backwardation strong: -0.3% to -0.15% → backwardation/strong", async () => {
    // spot 50000, perp 49900 → -0.20%
    stubFetchSequence([makeOkResponse(50000), makeOkResponse(49900)]);
    const r = await fetchBybitBasis();
    expect(r.signal).toBe("backwardation");
    expect(r.magnitude).toBe("strong");
    expect(r.interpretation).toMatch(/Strong backwardation/);
  });

  it("backwardation mild: -0.15% to -0.05% → backwardation/moderate", async () => {
    // spot 50000, perp 49950 → -0.10%
    stubFetchSequence([makeOkResponse(50000), makeOkResponse(49950)]);
    const r = await fetchBybitBasis();
    expect(r.signal).toBe("backwardation");
    expect(r.magnitude).toBe("moderate");
    expect(r.interpretation).toMatch(/Mild backwardation/);
  });
});

describe("bybitBasis — error paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HTTP non-ok throws with status code", async () => {
    stubFetchSequence([makeBadStatusResponse(), makeOkResponse(100)]);
    await expect(fetchBybitBasis()).rejects.toThrow(
      /Bybit .* fetch failed: 503/,
    );
  });

  it("malformed payload (empty list) throws", async () => {
    // Both calls happen via Promise.all; both must be valid for the
    // fetchBybitBasis helper's destructuring to succeed.
    stubFetchSequence([makeOkResponse(100), makeMalformedResponse()]);
    await expect(fetchBybitBasis()).rejects.toThrow(/malformed response/);
  });

  it("retCode != 0 throws", async () => {
    stubFetchSequence([makeOkResponse(100), makeBadRetCodeResponse()]);
    await expect(fetchBybitBasis()).rejects.toThrow(/malformed response/);
  });
});

describe("bybitBasis — fetch URL construction", () => {
  let fetchMock: FetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockResolvedValue(makeOkResponse(100));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits both spot and linear endpoints with BTCUSDT", async () => {
    await fetchBybitBasis();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    const hasSpot = urls.some(
      (u) => u.includes("category=spot") && u.includes("symbol=BTCUSDT"),
    );
    const hasLinear = urls.some(
      (u) => u.includes("category=linear") && u.includes("symbol=BTCUSDT"),
    );
    expect(hasSpot).toBe(true);
    expect(hasLinear).toBe(true);
  });
});
