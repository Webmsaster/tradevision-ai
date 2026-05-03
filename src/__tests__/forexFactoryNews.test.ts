import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterNewsEvents,
  isNewsBlackout,
  loadForexFactoryArchive,
  loadForexFactoryNews,
  pairToCurrencies,
  type NewsEvent,
} from "../utils/forexFactoryNews";

const t0 = new Date("2026-04-22T13:30:00Z").getTime();
const sample: NewsEvent[] = [
  { timestamp: t0, impact: "High", currency: "USD", title: "CPI y/y" },
  {
    timestamp: t0 + 3 * 3600_000,
    impact: "Medium",
    currency: "USD",
    title: "Retail",
  },
  {
    timestamp: t0 + 6 * 3600_000,
    impact: "High",
    currency: "EUR",
    title: "ECB",
  },
  {
    timestamp: t0 + 9 * 3600_000,
    impact: "Low",
    currency: "JPY",
    title: "PPI",
  },
];

describe("forexFactoryNews — filter", () => {
  it("defaults to high-impact USD/EUR/GBP only", () => {
    const out = filterNewsEvents(sample);
    expect(out.length).toBe(2);
    expect(out.map((e) => e.title)).toEqual(["CPI y/y", "ECB"]);
  });

  it("can include medium impact", () => {
    const out = filterNewsEvents(sample, { impacts: ["High", "Medium"] });
    expect(out.length).toBe(3);
  });

  it("can restrict currencies", () => {
    const out = filterNewsEvents(sample, { currencies: ["USD"] });
    expect(out.length).toBe(1);
  });
});

describe("forexFactoryNews — blackout", () => {
  it("flags exact-match timestamp", () => {
    expect(isNewsBlackout(t0, sample, 2)).toBe(true);
  });

  it("flags within buffer", () => {
    expect(isNewsBlackout(t0 - 90_000, sample, 2)).toBe(true); // 1.5 min before
    expect(isNewsBlackout(t0 + 90_000, sample, 2)).toBe(true);
  });

  it("does NOT flag outside buffer", () => {
    expect(isNewsBlackout(t0 - 3 * 60_000, sample, 2)).toBe(false); // 3 min before
    expect(isNewsBlackout(t0 + 3 * 60_000, sample, 2)).toBe(false);
  });

  it("handles empty events gracefully", () => {
    expect(isNewsBlackout(t0, [], 2)).toBe(false);
  });
});

describe("forexFactoryNews — pairToCurrencies (Round 57 Fix 3)", () => {
  it("maps standard 6-letter pair stems to both sides", () => {
    expect(pairToCurrencies("EURUSD")).toEqual(["EUR", "USD"]);
    expect(pairToCurrencies("USDJPY")).toEqual(["USD", "JPY"]);
    expect(pairToCurrencies("GBPCAD")).toEqual(["GBP", "CAD"]);
  });

  it("strips Yahoo `=X` suffix and is case-insensitive", () => {
    expect(pairToCurrencies("EURUSD=X")).toEqual(["EUR", "USD"]);
    expect(pairToCurrencies("usdjpy=x")).toEqual(["USD", "JPY"]);
  });

  it("returns empty array for non-pair symbols", () => {
    expect(pairToCurrencies("BTCUSDT")).toEqual([]); // 7 letters
    expect(pairToCurrencies("AAPL")).toEqual([]);
    expect(pairToCurrencies("")).toEqual([]);
  });
});

describe("forexFactoryNews — filterNewsEvents with affectedPairs (Round 57 Fix 3)", () => {
  const events: NewsEvent[] = [
    { timestamp: 1, impact: "High", currency: "USD", title: "NFP" },
    { timestamp: 2, impact: "High", currency: "JPY", title: "BoJ" },
    { timestamp: 3, impact: "High", currency: "EUR", title: "ECB" },
    { timestamp: 4, impact: "High", currency: "GBP", title: "BoE" },
  ];

  it("USDJPY pair pulls in BOTH USD and JPY events", () => {
    const out = filterNewsEvents(events, { affectedPairs: ["USDJPY=X"] });
    const titles = out.map((e) => e.title).sort();
    expect(titles).toEqual(["BoJ", "NFP"]);
  });

  it("multi-pair basket unions all affected currencies", () => {
    const out = filterNewsEvents(events, {
      affectedPairs: ["EURUSD=X", "GBPUSD=X"],
    });
    const cur = new Set(out.map((e) => e.currency));
    expect(cur).toEqual(new Set(["USD", "EUR", "GBP"]));
  });

  it("explicit currencies + affectedPairs are unioned", () => {
    const out = filterNewsEvents(events, {
      affectedPairs: ["EURUSD=X"],
      currencies: ["JPY"],
    });
    const cur = new Set(out.map((e) => e.currency));
    expect(cur).toEqual(new Set(["EUR", "USD", "JPY"]));
  });
});

describe("forexFactoryNews — loadForexFactoryArchive (Round 57 Fix 2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ff-archive-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array + warning when archive is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = loadForexFactoryArchive(join(tmpDir, "missing.json"));
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing — backtest news-filter disabled"),
    );
    warnSpy.mockRestore();
  });

  it("loads a valid archive JSON file", () => {
    const archivePath = join(tmpDir, "archive.json");
    const ev: NewsEvent[] = [
      {
        timestamp: 1700000000000,
        impact: "High",
        currency: "USD",
        title: "CPI",
      },
    ];
    writeFileSync(archivePath, JSON.stringify(ev));
    const out = loadForexFactoryArchive(archivePath);
    expect(out).toEqual(ev);
  });

  it("returns empty array on malformed JSON", () => {
    const archivePath = join(tmpDir, "bad.json");
    writeFileSync(archivePath, "not-json{");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = loadForexFactoryArchive(archivePath);
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("forexFactoryNews — loadForexFactoryNews disk cache (Round 57 Fix 2)", () => {
  let tmpDir: string;
  let cachePath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ff-cache-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    cachePath = join(tmpDir, "ff_news_cache.json");
    originalEnv = process.env.FF_NEWS_CACHE;
    // FF_NEWS_CACHE is read at module load via const; the implementation
    // re-reads env each call only if we override CACHE_PATH directly.
    // We instead seed the default path the module already resolved.
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.FF_NEWS_CACHE;
    else process.env.FF_NEWS_CACHE = originalEnv;
  });

  it("returns cached events when disk cache is fresh (no network call)", async () => {
    // Resolve the cache path the module is using and seed it.
    const modulePath =
      process.env.FF_NEWS_CACHE ?? "scripts/cache_forex_2h/ff_news_cache.json";
    const dir = modulePath.substring(0, modulePath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const seeded: NewsEvent[] = [
      {
        timestamp: 1700000000000,
        impact: "High",
        currency: "USD",
        title: "FROM-CACHE",
      },
    ];
    writeFileSync(modulePath, JSON.stringify(seeded));
    // Touch it to NOW so TTL is fresh.
    utimesSync(modulePath, new Date(), new Date());

    // fetch should NOT be called when cache is fresh.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));

    const out = await loadForexFactoryNews();
    expect(out).toEqual(seeded);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    if (existsSync(modulePath)) rmSync(modulePath);
  });

  it("ignores stale cache (older than 6h TTL) and triggers a fetch", async () => {
    const modulePath =
      process.env.FF_NEWS_CACHE ?? "scripts/cache_forex_2h/ff_news_cache.json";
    const dir = modulePath.substring(0, modulePath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stale: NewsEvent[] = [
      {
        timestamp: 1700000000000,
        impact: "High",
        currency: "USD",
        title: "STALE",
      },
    ];
    writeFileSync(modulePath, JSON.stringify(stale));
    // Set mtime to 7h ago — past the 6h TTL.
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000);
    utimesSync(modulePath, sevenHoursAgo, sevenHoursAgo);

    // fetch should be called and return fresh data.
    const fresh: NewsEvent[] = [];
    const ffEntry = [
      {
        title: "FRESH",
        country: "USD",
        date: "2026-04-29T08:30:00Z",
        impact: "High",
      },
    ];
    const body = JSON.stringify(ffEntry);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status: 200 }));

    const out = await loadForexFactoryNews();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.length).toBe(1);
    expect(out[0]?.title).toBe("FRESH");

    void fresh;
    fetchSpy.mockRestore();
    if (existsSync(modulePath)) rmSync(modulePath);
  });
});
