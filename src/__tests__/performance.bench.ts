/**
 * Performance benchmark suite for the R22 + R26 perf fixes that were
 * claimed in audit notes but never measured against a reference impl.
 *
 * Run with:
 *   node ./node_modules/vitest/vitest.mjs bench --run
 *   npm run bench
 *
 * Each `bench()` block is paired with a "naive" baseline so we can read
 * the speedup directly off the ops/sec column. Where the optimised code
 * lives behind a Symbol cache, we benchmark cache-miss vs cache-hit by
 * forcing both states inside the benchmark body — the cache lives on
 * the input array via a non-enumerable property, so deleting/re-cloning
 * the array reproduces a cold cache.
 *
 * NB: We intentionally do not import the private Symbols from the
 * utility modules — the cached path is exercised by simply calling the
 * exported function repeatedly on the same array.
 */
import { bench, describe } from "vitest";
import type { Trade } from "@/types/trade";
import {
  generateAllInsights,
  detectRevengeTrade,
  detectImprovingPerformance,
  detectDecliningPerformance,
  detectPairSwitching,
  detectOverleverageAfterWins,
  detectTiltPattern,
} from "@/utils/aiAnalysis";
import {
  calculateMaxDrawdown,
  calculateEquityCurve,
  calculateStreaks,
  calculateAllStats,
} from "@/utils/calculations";

// ---------------------------------------------------------------------------
// Test-data generation
// ---------------------------------------------------------------------------

const PAIRS = ["BTC/USDT", "ETH/USDT", "BNB/USDT", "ADA/USDT", "SOL/USDT"];
const EMOTIONS: Trade["emotion"][] = [
  "confident",
  "neutral",
  "fearful",
  "greedy",
  "fomo",
  "revenge",
];

/**
 * Deterministic LCG so benchmarks are reproducible across runs.
 * Same seed → same trade array → same sort/insight workload.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function buildTrades(n: number, seed = 42): Trade[] {
  const rand = lcg(seed);
  const trades: Trade[] = new Array(n);
  // Spread exits across ~2 years of millisecond timestamps but in
  // RANDOM order so the benchmark actually sorts work, not best-case.
  const startMs = new Date("2024-01-01T00:00:00Z").getTime();
  const span = 2 * 365 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < n; i++) {
    const exitOffset = Math.floor(rand() * span);
    const holdMs = Math.floor(rand() * 6 * 60 * 60 * 1000); // 0-6h hold
    const exitMs = startMs + exitOffset;
    const entryMs = exitMs - holdMs;
    const pnl = (rand() - 0.45) * 100; // slight positive bias
    trades[i] = {
      id: `t-${i}`,
      pair: PAIRS[Math.floor(rand() * PAIRS.length)]!,
      direction: rand() > 0.5 ? "long" : "short",
      entryPrice: 100 + rand() * 100,
      exitPrice: 100 + rand() * 100,
      quantity: 1 + rand() * 5,
      entryDate: new Date(entryMs).toISOString(),
      exitDate: new Date(exitMs).toISOString(),
      pnl,
      pnlPercent: pnl / 100,
      fees: rand() * 2,
      notes: "",
      tags: [],
      leverage: 1 + Math.floor(rand() * 5),
      emotion: EMOTIONS[Math.floor(rand() * EMOTIONS.length)],
      // Deliberately omit exitMs/entryMs cache so we can test BOTH paths.
    };
  }
  return trades;
}

/**
 * Returns a structural clone of the trade array so the cache attached
 * via `Object.defineProperty(trades, SORTED_BY_EXIT_DATE, …)` is gone.
 * The trade objects themselves are reference-shared (cheaper) — the
 * cache lives on the array, not on each trade.
 */
function cloneArrayOnly<T>(arr: T[]): T[] {
  return arr.slice();
}

/**
 * Pre-populate exitMs / entryMs to simulate the storage-boundary cache
 * (R26: `dbToTrade` / `loadTrades` set these so render-time sorts skip
 * `new Date(t.exitDate).getTime()`).
 */
function withDatePreparse(trades: Trade[]): Trade[] {
  return trades.map((t) => ({
    ...t,
    exitMs: new Date(t.exitDate).getTime(),
    entryMs: new Date(t.entryDate).getTime(),
  }));
}

// ---------------------------------------------------------------------------
// Naive reference implementations (for before/after comparison)
// ---------------------------------------------------------------------------

function compareByExitDateNaive(a: Trade, b: Trade): number {
  const e = new Date(a.exitDate).getTime() - new Date(b.exitDate).getTime();
  if (e !== 0) return e;
  const en = new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime();
  if (en !== 0) return en;
  return a.id.localeCompare(b.id);
}

function naiveSortByExitDate(trades: Trade[]): Trade[] {
  return [...trades].sort(compareByExitDateNaive);
}

/**
 * Naive page.tsx recentTrades — full O(n log n) sort then slice(0, K).
 * Mirrors what the code USED to do before the linear top-K fix.
 */
function naiveRecentTrades(trades: Trade[], k = 10): Trade[] {
  return [...trades]
    .sort(
      (a, b) => new Date(b.exitDate).getTime() - new Date(a.exitDate).getTime(),
    )
    .slice(0, k);
}

/**
 * Optimised page.tsx recentTrades — linear top-K with insertion-sort
 * head-of-K (extracted from src/app/page.tsx so we can bench it without
 * mounting React). Kept byte-for-byte equivalent to the prod copy.
 */
function fastRecentTrades(trades: Trade[], k = 10): Trade[] {
  if (trades.length <= k) {
    return [...trades].sort(
      (a, b) => new Date(b.exitDate).getTime() - new Date(a.exitDate).getTime(),
    );
  }
  type Slot = { trade: Trade; ts: number };
  const top: Slot[] = [];
  for (const trade of trades) {
    const ts = new Date(trade.exitDate).getTime();
    if (!Number.isFinite(ts)) continue;
    if (top.length < k) {
      top.push({ trade, ts });
      for (let i = top.length - 1; i > 0 && top[i]!.ts < top[i - 1]!.ts; i--) {
        [top[i], top[i - 1]] = [top[i - 1]!, top[i]!];
      }
    } else if (ts > top[0]!.ts) {
      top[0] = { trade, ts };
      for (let i = 0; i < top.length - 1 && top[i]!.ts > top[i + 1]!.ts; i++) {
        [top[i], top[i + 1]] = [top[i + 1]!, top[i]!];
      }
    }
  }
  return top.reverse().map((s) => s.trade);
}

/**
 * Naive best/worst — three traversals (filter + reduce + reduce).
 * Mirrors the pre-R22 implementation.
 */
function naiveBestWorst(trades: Trade[]): {
  bestTrade: Trade | null;
  worstTrade: Trade | null;
} {
  const valid = trades.filter((t) => Number.isFinite(t.pnl));
  if (valid.length === 0) return { bestTrade: null, worstTrade: null };
  const bestTrade = valid.reduce((b, t) => (t.pnl > b.pnl ? t : b), valid[0]!);
  const worstTrade = valid.reduce((w, t) => (t.pnl < w.pnl ? t : w), valid[0]!);
  return { bestTrade, worstTrade };
}

/** Optimised best/worst — single fused pass (R22). */
function fastBestWorst(trades: Trade[]): {
  bestTrade: Trade | null;
  worstTrade: Trade | null;
} {
  let bestTrade: Trade | null = null;
  let worstTrade: Trade | null = null;
  for (const t of trades) {
    if (!Number.isFinite(t.pnl)) continue;
    if (bestTrade === null || t.pnl > bestTrade.pnl) bestTrade = t;
    if (worstTrade === null || t.pnl < worstTrade.pnl) worstTrade = t;
  }
  return { bestTrade, worstTrade };
}

// ---------------------------------------------------------------------------
// Pre-built fixtures (built ONCE so generation cost isn't measured)
// ---------------------------------------------------------------------------

const TRADES_1K = buildTrades(1_000);
const TRADES_5K = buildTrades(5_000);
const TRADES_10K = buildTrades(10_000);
const TRADES_50K = buildTrades(50_000);
const TRADES_10K_PRE = withDatePreparse(TRADES_10K);

// Common bench options — generous warmup, fewer iterations for the
// expensive end-to-end suites so the run finishes in <60s.
const FAST_OPTS = { warmupIterations: 10, iterations: 100, time: 1500 };
const SLOW_OPTS = { warmupIterations: 5, iterations: 20, time: 2500 };

// ---------------------------------------------------------------------------
// 1) aiAnalysis sort-cache — naive vs Symbol-cached (R15-r22)
// ---------------------------------------------------------------------------

describe("aiAnalysis sort-cache (R15-r22)", () => {
  // The cached path is exercised by re-using the SAME array reference;
  // the naive path always re-sorts. We fan out 6 detector calls per
  // bench iteration to mimic generateAllInsights' real workload (6 of
  // 17 detectors sort by exitDate).
  const detectors = [
    detectRevengeTrade,
    detectImprovingPerformance,
    detectDecliningPerformance,
    detectPairSwitching,
    detectOverleverageAfterWins,
    detectTiltPattern,
  ];

  for (const [label, fixture] of [
    ["N=1000", TRADES_1K],
    ["N=5000", TRADES_5K],
    ["N=10000", TRADES_10K],
  ] as const) {
    bench(
      `${label} naive: 6× independent [...].sort(compareByExitDate)`,
      () => {
        for (let i = 0; i < detectors.length; i++) {
          const sorted = naiveSortByExitDate(fixture);
          // tiny sink so the JIT can't dead-code-eliminate
          if (sorted.length < 0) throw new Error("nope");
        }
      },
      FAST_OPTS,
    );

    bench(
      `${label} cached: 6× detectors share Symbol-cached sort`,
      () => {
        // SAME array → first detector sorts, the next 5 hit the cache.
        for (const detector of detectors) {
          detector(fixture);
        }
      },
      FAST_OPTS,
    );
  }
});

// ---------------------------------------------------------------------------
// 2) calculations sort-cache — naive vs Symbol-cached (R22)
// ---------------------------------------------------------------------------

describe("calculations sort-cache (R22)", () => {
  for (const [label, fixture] of [
    ["N=1000", TRADES_1K],
    ["N=5000", TRADES_5K],
    ["N=10000", TRADES_10K],
  ] as const) {
    bench(
      `${label} naive: 3× independent sort (DD + EquityCurve + Streaks)`,
      () => {
        // simulate 3 independent callers each running their own sort
        const a = naiveSortByExitDate(fixture);
        const b = naiveSortByExitDate(fixture);
        const c = naiveSortByExitDate(fixture);
        if (a.length + b.length + c.length < 0) throw new Error("nope");
      },
      FAST_OPTS,
    );

    bench(
      `${label} cached: calculateAllStats reuses Symbol-cached sort`,
      () => {
        // The 3 internal callers (calculateMaxDrawdown / calculateEquityCurve /
        // calculateStreaks) share the cache attached to the array.
        calculateMaxDrawdown(fixture);
        calculateEquityCurve(fixture);
        calculateStreaks(fixture);
      },
      FAST_OPTS,
    );
  }
});

// ---------------------------------------------------------------------------
// 3) page.tsx recentTrades top-K (R22) — linear vs full sort
// ---------------------------------------------------------------------------

describe("recentTrades top-K (R22)", () => {
  for (const [label, fixture] of [
    ["N=1000", TRADES_1K],
    ["N=5000", TRADES_5K],
    ["N=10000", TRADES_10K],
    ["N=50000", TRADES_50K],
  ] as const) {
    bench(
      `${label} naive: full O(n log n) sort + slice(0,10)`,
      () => {
        const out = naiveRecentTrades(fixture, 10);
        if (out.length < 0) throw new Error("nope");
      },
      FAST_OPTS,
    );

    bench(
      `${label} fast: linear top-K-of-10 (one pass + 10-element insertion)`,
      () => {
        const out = fastRecentTrades(fixture, 10);
        if (out.length < 0) throw new Error("nope");
      },
      FAST_OPTS,
    );
  }
});

// ---------------------------------------------------------------------------
// 4) TradeTable Date pre-parse (R26) — cache-miss vs cache-hit
// ---------------------------------------------------------------------------

describe("TradeTable Date pre-parse (R26)", () => {
  // 10k trades — the table sorts by exitDate when the user clicks the
  // column header. Cache miss = `new Date(t.exitDate).getTime()` allocs
  // for every comparator call; cache hit = read `t.exitMs` directly.

  bench(
    "N=10000 cache MISS: sort with new Date(t.exitDate).getTime()",
    () => {
      const trades = TRADES_10K; // exitMs is undefined → cache miss path
      const sorted = [...trades].sort((a, b) => {
        const aVal = a.exitMs ?? new Date(a.exitDate).getTime();
        const bVal = b.exitMs ?? new Date(b.exitDate).getTime();
        return bVal - aVal;
      });
      if (sorted.length < 0) throw new Error("nope");
    },
    FAST_OPTS,
  );

  bench(
    "N=10000 cache HIT: sort with pre-parsed t.exitMs",
    () => {
      const trades = TRADES_10K_PRE; // exitMs populated → cache hit
      const sorted = [...trades].sort((a, b) => {
        const aVal = a.exitMs ?? new Date(a.exitDate).getTime();
        const bVal = b.exitMs ?? new Date(b.exitDate).getTime();
        return bVal - aVal;
      });
      if (sorted.length < 0) throw new Error("nope");
    },
    FAST_OPTS,
  );
});

// ---------------------------------------------------------------------------
// 5) best/worst-trade fused pass (R22)
// ---------------------------------------------------------------------------

describe("best/worst-trade fused pass (R22)", () => {
  bench(
    "N=10000 naive: filter + reduce(best) + reduce(worst)",
    () => {
      const out = naiveBestWorst(TRADES_10K);
      if (out.bestTrade === null && out.worstTrade === null) {
        // never true with our fixture
        throw new Error("nope");
      }
    },
    FAST_OPTS,
  );

  bench(
    "N=10000 fast: single fused pass",
    () => {
      const out = fastBestWorst(TRADES_10K);
      if (out.bestTrade === null && out.worstTrade === null) {
        throw new Error("nope");
      }
    },
    FAST_OPTS,
  );
});

// ---------------------------------------------------------------------------
// 6) End-to-end regression — generateAllInsights + calculateAllStats
// ---------------------------------------------------------------------------

describe("end-to-end (regression check)", () => {
  // Each iteration uses a FRESH array clone so the Symbol cache starts
  // cold — this is the realistic "user opens dashboard" scenario.
  bench(
    "N=10000 generateAllInsights (cold cache, fresh array)",
    () => {
      const fresh = cloneArrayOnly(TRADES_10K);
      const insights = generateAllInsights(fresh);
      if (insights.length < 0) throw new Error("nope");
    },
    SLOW_OPTS,
  );

  bench(
    "N=10000 calculateAllStats (cold cache, fresh array)",
    () => {
      const fresh = cloneArrayOnly(TRADES_10K);
      const stats = calculateAllStats(fresh);
      if (stats.totalTrades < 0) throw new Error("nope");
    },
    SLOW_OPTS,
  );

  // The "warm" variant reuses the SAME reference across iterations so
  // the cache survives — this is the steady-state scenario when a user
  // re-renders the dashboard without trade-list mutation.
  bench(
    "N=10000 generateAllInsights (warm cache, shared array)",
    () => {
      const insights = generateAllInsights(TRADES_10K);
      if (insights.length < 0) throw new Error("nope");
    },
    SLOW_OPTS,
  );

  bench(
    "N=10000 calculateAllStats (warm cache, shared array)",
    () => {
      const stats = calculateAllStats(TRADES_10K);
      if (stats.totalTrades < 0) throw new Error("nope");
    },
    SLOW_OPTS,
  );
});
