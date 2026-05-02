/**
 * Multi-TF Ensemble — combine 5m + 15m + 1h signals on a unified equity track.
 *
 * Hypothesis: each TF has different blind-spots. Combining them diversifies
 * timing-related failures. Each TF brings own MR signals, all share one
 * account, ensemble-scaled (1/N) to preserve single-account risk.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  precomputeAllTrades,
  walkForwardEnsemble,
  type TfEntry,
} from "./_multiTfEnsemble";
import type { Candle } from "../src/utils/indicators";
import { LIVE_CAPS } from "./_aggressiveSweepHelper";

describe("Multi-TF Ensemble", { timeout: 1800_000 }, () => {
  it("combines 5m + 15m + 1h on unified equity", async () => {
    // Load all needed assets per TF. Use intersection of LIVE_5M_V3 + LIVE_15M_V3 + LIVE_1H_V2 assets.
    const TF_HOURS = { "5m": 5 / 60, "15m": 0.25, "1h": 1 };
    const TARGETS_5M = { count: 600000, pages: 600 };
    const TARGETS_15M = { count: 200000, pages: 200 };
    const TARGETS_1H = { count: 50000, pages: 50 };

    async function loadTf(
      syms: string[],
      tf: "5m" | "15m" | "1h",
      t: { count: number; pages: number },
    ) {
      const out: Record<string, Candle[]> = {};
      for (const s of syms) {
        out[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: tf,
          targetCount: t.count,
          maxPages: t.pages,
        });
        console.log(`  ${tf} ${s}: ${out[s].length} bars`);
      }
      return out;
    }

    // Collect assets from each cfg
    const collectSrc = (cfg: FtmoDaytrade24hConfig) =>
      Array.from(new Set(cfg.assets.map((a) => a.sourceSymbol ?? a.symbol)));
    const syms5m = collectSrc(FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3);
    const syms15m = collectSrc(FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3);
    const syms1h = collectSrc(FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2);
    console.log(`5m assets: ${syms5m.join(", ")}`);
    console.log(`15m assets: ${syms15m.join(", ")}`);
    console.log(`1h assets: ${syms1h.join(", ")}`);

    console.log(`\nLoading 5m...`);
    const data5m = await loadTf(syms5m, "5m", TARGETS_5M);
    console.log(`Loading 15m...`);
    const data15m = await loadTf(syms15m, "15m", TARGETS_15M);
    console.log(`Loading 1h...`);
    const data1h = await loadTf(syms1h, "1h", TARGETS_1H);

    // Determine common time-window across all TFs
    const minTs = Math.max(
      ...Object.values(data5m).map((c) => c[0].openTime),
      ...Object.values(data15m).map((c) => c[0].openTime),
      ...Object.values(data1h).map((c) => c[0].openTime),
    );
    const maxTs = Math.min(
      ...Object.values(data5m).map((c) => c[c.length - 1].closeTime),
      ...Object.values(data15m).map((c) => c[c.length - 1].closeTime),
      ...Object.values(data1h).map((c) => c[c.length - 1].closeTime),
    );
    const yrs = ((maxTs - minTs) / (365 * 86400_000)).toFixed(2);
    console.log(
      `\nCommon window: ${new Date(minTs).toISOString().slice(0, 10)} → ${new Date(maxTs).toISOString().slice(0, 10)} (${yrs}y)\n`,
    );

    const tfs: TfEntry[] = [
      {
        label: "5m",
        cfg: { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3, liveCaps: LIVE_CAPS },
        data: data5m,
        tfHours: TF_HOURS["5m"],
      },
      {
        label: "15m",
        cfg: { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3, liveCaps: LIVE_CAPS },
        data: data15m,
        tfHours: TF_HOURS["15m"],
      },
      {
        label: "1h",
        cfg: { ...FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2, liveCaps: LIVE_CAPS },
        data: data1h,
        tfHours: TF_HOURS["1h"],
      },
    ];

    console.log(`Pre-computing trades for all TFs...`);
    const t0 = Date.now();
    const allTrades = precomputeAllTrades(tfs);
    console.log(
      `Precomputed ${allTrades.length} trades in ${(Date.now() - t0) / 1000}s\n`,
    );

    // Walk-forward variants:
    //   1) only 5m
    //   2) only 15m
    //   3) only 1h
    //   4) 5m + 15m
    //   5) 5m + 1h
    //   6) 15m + 1h
    //   7) 5m + 15m + 1h
    const variants: Array<{
      label: string;
      tfSet: string[];
      cfg: FtmoDaytrade24hConfig;
    }> = [
      {
        label: "5m only",
        tfSet: ["5m"],
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_5M_V3,
      },
      {
        label: "15m only",
        tfSet: ["15m"],
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
      },
      {
        label: "1h only",
        tfSet: ["1h"],
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
      },
      {
        label: "5m + 15m",
        tfSet: ["5m", "15m"],
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
      },
      {
        label: "5m + 1h",
        tfSet: ["5m", "1h"],
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
      },
      {
        label: "15m + 1h",
        tfSet: ["15m", "1h"],
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V2,
      },
      {
        label: "5m + 15m + 1h",
        tfSet: ["5m", "15m", "1h"],
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V3,
      },
    ];

    console.log(`================ ENSEMBLE COMPARISON ================`);
    for (const v of variants) {
      const filtered = allTrades.filter((t) => v.tfSet.includes(t.tf));
      const r = walkForwardEnsemble(
        filtered,
        minTs,
        maxTs,
        { ...v.cfg, liveCaps: LIVE_CAPS },
        v.tfSet.length,
      );
      const evStr = `EV=$${r.ev.toFixed(0).padStart(5)}`;
      console.log(
        `${v.label.padEnd(20)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  ${evStr}`,
      );
    }

    expect(allTrades.length).toBeGreaterThan(0);
  });
});
