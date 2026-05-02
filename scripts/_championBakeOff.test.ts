/**
 * Champion Bake-Off — runs all top FTMO configs through the *production*
 * V4 Live Engine (`ftmoLiveEngineV4.simulate`) over rolling 30-day windows
 * across the largest available Binance history shared by the basket.
 *
 * V4 Live Engine = persistent-state, sequential-replay, no exit-time
 * lookahead → matches what the live MT5/Python executor actually does.
 * This is the only honest "real-life" pass-rate.
 *
 * Optimisations vs full sweep:
 *  - parallel loader (Promise.all) instead of sequential
 *  - 2y target (not 5y) → faster loads + sims
 *  - step 14 days for ~52 windows/year
 *  - file cache so reruns skip Binance entirely
 */
import { describe, it } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V2,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V3,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { simulate } from "../src/utils/ftmoLiveEngineV4";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";

const CACHE_DIR = "scripts/cache_bakeoff";
mkdirSync(CACHE_DIR, { recursive: true });

const LOG_FILE = "scripts/cache_bakeoff/bakeoff_progress.log";
writeFileSync(LOG_FILE, `[${new Date().toISOString()}] start\n`);
function plog(s: string) {
  const line = `[${new Date().toISOString()}] ${s}\n`;
  appendFileSync(LOG_FILE, line);
  console.log(s);
}

const BARS_PER_DAY: Record<string, number> = {
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "4h": 6,
};

interface ChampionEntry {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  tf: "30m" | "1h" | "2h" | "4h";
}

function symsOf(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function alignCommon(
  data: Record<string, Candle[]>,
  symbols: string[],
): Record<string, Candle[]> {
  const sets = symbols.map(
    (s) => new Set((data[s] ?? []).map((c) => c.openTime)),
  );
  if (sets.length === 0) return {};
  const common = [...sets[0]!].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols) {
    aligned[s] = (data[s] ?? []).filter((c) => cs.has(c.openTime));
  }
  return aligned;
}

const TARGET = 100_000;

async function loadOne(
  symbol: string,
  tf: "30m" | "1h" | "2h" | "4h",
): Promise<Candle[]> {
  const cachePath = `${CACHE_DIR}/${symbol}_${tf}.json`;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Candle[];
      if (cached.length >= 5000) return cached;
    } catch {}
  }
  try {
    const r = await loadBinanceHistory({
      symbol,
      timeframe: tf,
      targetCount: TARGET,
      maxPages: 110,
    });
    const final = r.filter((c) => c.isFinal);
    if (final.length >= 5000) writeFileSync(cachePath, JSON.stringify(final));
    return final;
  } catch (e) {
    console.warn(`[load] ${symbol} ${tf} failed:`, (e as Error).message);
    return [];
  }
}

async function loadAllParallel(
  symbols: string[],
  tf: "30m" | "1h" | "2h" | "4h",
): Promise<Record<string, Candle[]>> {
  const results = await Promise.all(symbols.map((s) => loadOne(s, tf)));
  const data: Record<string, Candle[]> = {};
  symbols.forEach((s, i) => (data[s] = results[i]!));
  return data;
}

interface RowResult {
  name: string;
  windows: number;
  passes: number;
  passRate: number;
  median: number;
  p90: number;
  reasons: Record<string, number>;
  yearsTested: number;
}

const CHAMPIONS: ChampionEntry[] = [
  {
    name: "V5_QUARTZ_LITE_R28_V4 (prod)",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
    tf: "30m",
  },
  {
    name: "V5_QUARTZ_LITE_R28_V3",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V3,
    tf: "30m",
  },
  {
    name: "V5_QUARTZ_LITE_R28_V2",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V2,
    tf: "30m",
  },
  {
    name: "V5_QUARTZ_LITE_R28",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
    tf: "30m",
  },
  {
    name: "V5_QUARTZ_LITE (base)",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    tf: "30m",
  },
  {
    name: "BREAKOUT_V1",
    cfg: FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1,
    tf: "30m",
  },
  {
    name: "V5_NOVA",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
    tf: "2h",
  },
];

describe("Champion Bake-Off (V4 Live Engine)", { timeout: 90 * 60_000 }, () => {
  it("ranks champions by real-life pass-rate", async () => {
    const rows: RowResult[] = [];

    const byTf: Record<string, ChampionEntry[]> = {};
    for (const c of CHAMPIONS) (byTf[c.tf] ??= []).push(c);

    for (const tf of Object.keys(byTf) as ("30m" | "1h" | "2h" | "4h")[]) {
      const entries = byTf[tf]!;
      const allSyms = new Set<string>();
      for (const e of entries) for (const s of symsOf(e.cfg)) allSyms.add(s);
      const symbols = [...allSyms].sort();
      plog(
        `\n[loader] ${tf}: ${symbols.length} symbols → ${symbols.join(",")}`,
      );
      const t0 = Date.now();
      const data = await loadAllParallel(symbols, tf);
      plog(
        `[loader] ${tf}: done in ${Math.round((Date.now() - t0) / 1000)}s — ${symbols
          .map((s) => `${s}=${(data[s] ?? []).length}`)
          .join(" ")}`,
      );

      for (const entry of entries) {
        const cfg: FtmoDaytrade24hConfig = {
          ...entry.cfg,
          liveCaps: entry.cfg.liveCaps ?? {
            maxStopPct: 0.05,
            maxRiskFrac: 0.4,
          },
        };
        const cfgSyms = symsOf(cfg);
        const subset: Record<string, Candle[]> = {};
        for (const s of cfgSyms) subset[s] = data[s] ?? [];
        const aligned = alignCommon(subset, cfgSyms);
        const lengths = cfgSyms.map((s) => (aligned[s] ?? []).length);
        const minBars = lengths.length ? Math.min(...lengths) : 0;
        if (minBars < 1500) {
          console.warn(`[skip] ${entry.name}: minBars=${minBars} < 1500`);
          continue;
        }
        const bpd = BARS_PER_DAY[tf]!;
        const winBars = cfg.maxDays * bpd;
        const stepBars = 14 * bpd;

        let passes = 0;
        let windows = 0;
        const passDays: number[] = [];
        const reasons: Record<string, number> = {};
        const tStart = Date.now();
        const WARMUP = 5000; // bars of indicator-history before window start
        plog(
          `[start] ${entry.name}: minBars=${minBars} winBars=${winBars} stepBars=${stepBars} warmup=${WARMUP}`,
        );
        for (
          let start = WARMUP;
          start + winBars <= minBars;
          start += stepBars
        ) {
          windows++;
          const tw = Date.now();
          try {
            // Trim to [start-WARMUP, start+winBars] so simulate's per-tick
            // slice(0, i+1) cost stays bounded (else O(n²) over full history).
            const trimStart = start - WARMUP;
            const trimEnd = start + winBars;
            const trimmed: Record<string, Candle[]> = {};
            for (const k of Object.keys(aligned)) {
              trimmed[k] = aligned[k]!.slice(trimStart, trimEnd);
            }
            const r = simulate(
              trimmed,
              cfg,
              WARMUP,
              WARMUP + winBars,
              entry.name,
            );
            const reason = r.passed ? "pass" : r.reason;
            reasons[reason] = (reasons[reason] ?? 0) + 1;
            if (r.passed) {
              passes++;
              if (typeof r.passDay === "number") passDays.push(r.passDay);
            }
            plog(
              `  win ${windows} @${start}: ${r.passed ? "PASS" : r.reason} ${r.passDay ? `d${r.passDay}` : ""} (${Math.round((Date.now() - tw) / 1000)}s)`,
            );
          } catch (e) {
            reasons.error = (reasons.error ?? 0) + 1;
            plog(`  win ${windows} @${start}: ERROR ${(e as Error).message}`);
          }
        }
        passDays.sort((a, b) => a - b);
        const median =
          passDays.length > 0 ? passDays[Math.floor(passDays.length / 2)]! : 0;
        const p90Idx = Math.min(
          passDays.length - 1,
          Math.floor(passDays.length * 0.9),
        );
        const p90 = passDays.length > 0 ? passDays[p90Idx]! : 0;
        const yrs = Number((minBars / bpd / 365).toFixed(2));
        rows.push({
          name: entry.name,
          windows,
          passes,
          passRate: windows > 0 ? (passes / windows) * 100 : 0,
          median,
          p90,
          reasons,
          yearsTested: yrs,
        });
        plog(
          `[done] ${entry.name}: ${passes}/${windows} = ${(
            (passes / Math.max(windows, 1)) *
            100
          ).toFixed(
            2,
          )}% / med=${median}d / p90=${p90}d / years=${yrs} / sim=${Math.round(
            (Date.now() - tStart) / 1000,
          )}s / reasons=${JSON.stringify(reasons)}`,
        );
      }
    }

    rows.sort((a, b) => {
      if (b.passRate !== a.passRate) return b.passRate - a.passRate;
      return a.median - b.median;
    });

    plog("\n=== CHAMPION RANKING (V4 Live Engine — honest live numbers) ===");
    plog(
      "rank | config                              | pass% | med | p90 | windows | years",
    );
    plog(
      "-----+-------------------------------------+-------+-----+-----+---------+------",
    );
    rows.forEach((r, i) => {
      const name = r.name.padEnd(36).slice(0, 36);
      plog(
        `${String(i + 1).padStart(4)} | ${name} | ${r.passRate
          .toFixed(2)
          .padStart(5)} | ${String(r.median).padStart(3)} | ${String(
          r.p90,
        ).padStart(
          3,
        )} | ${String(r.windows).padStart(7)} | ${r.yearsTested.toFixed(2)}`,
      );
    });
    if (rows.length > 0) {
      const winner = rows[0]!;
      plog(
        `\n>>> BEST: ${winner.name} → ${winner.passRate.toFixed(
          2,
        )}% pass / ${winner.median}d median / ${winner.windows} windows / ${winner.yearsTested}y`,
      );
    }
  });
});
