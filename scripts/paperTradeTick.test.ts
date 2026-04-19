/**
 * Paper-Trade tick — run manually or from cron.
 *
 *   node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts scripts/paperTradeTick.test.ts --reporter=verbose
 *
 * Or shorthand (after adding to package.json):
 *   npm run paper:tick
 *
 * Steps:
 *  1. Load persisted state from ~/.tradevision-ai/paper-trades.json
 *  2. For each open position: fetch recent candles, advance, close if tp/stop/time hit
 *  3. Fetch all current live signals; register newly-active ones as new positions
 *  4. Persist state; print summary
 */
import { describe, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  evaluateHfDaytradingPortfolio,
  HF_DAYTRADING_ASSETS,
} from "../src/utils/hfDaytrading";
import {
  evaluateHighWrPortfolio,
  HIGH_WR_PORTFOLIO_CONFIGS,
} from "../src/utils/highWrScaleOut";
import {
  evaluateVolumeSpikeSignal,
  LOCKED_EDGES,
  lockedEdgeBinanceSymbol,
} from "../src/utils/volumeSpikeSignal";
import {
  emptyState,
  openPosition,
  advancePosition,
  computeStats,
  type PaperState,
  type PaperPosition,
} from "../src/utils/paperTradeLogger";
import type { Candle } from "../src/utils/indicators";

const STATE_DIR = join(homedir(), ".tradevision-ai");
const STATE_FILE = join(STATE_DIR, "paper-trades.json");

function loadState(): PaperState {
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as PaperState;
  } catch {
    return emptyState();
  }
}
function saveState(state: PaperState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

describe("Paper-Trade TICK (side-effect: updates ~/.tradevision-ai/paper-trades.json)", () => {
  it(
    "advance open positions + register new signals",
    { timeout: 300_000 },
    async () => {
      const now = new Date().toISOString();
      console.log(`\n═══ Paper-Trade Tick @ ${now} ═══`);

      const state = loadState();
      const preClosed = state.closedTrades.length;

      // 1. Advance open positions
      const stillOpen: PaperPosition[] = [];
      const justClosed = [];
      for (const pos of state.openPositions) {
        const tf = pos.strategy === "hf-daytrading" ? "15m" : "1h";
        let bars: Candle[] = [];
        try {
          bars = await loadBinanceHistory({
            symbol: pos.symbol,
            timeframe: tf,
            targetCount: 200,
          });
        } catch {
          stillOpen.push(pos);
          continue;
        }
        const closed = advancePosition(pos, bars, now);
        if (closed) {
          justClosed.push(closed);
          console.log(
            `  CLOSE ${closed.strategy} ${closed.symbol} ${closed.direction} → ${closed.exitReason} @ ${(closed.netPnlPct * 100).toFixed(2)}%`,
          );
        } else {
          stillOpen.push(pos);
        }
      }
      state.openPositions = stillOpen;
      state.closedTrades.push(...justClosed);

      // 2. Fetch current signals
      const dedupeKey = (s: string, sym: string) => `${s}|${sym}`;
      const existing = new Set(
        state.openPositions.map((p) => dedupeKey(p.strategy, p.symbol)),
      );

      // 2a. HF daytrading
      const hfC: Record<string, Candle[] | undefined> = {};
      for (const s of HF_DAYTRADING_ASSETS) {
        try {
          hfC[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "15m",
            targetCount: 200,
          });
        } catch {
          hfC[s] = undefined;
        }
      }
      const hf = evaluateHfDaytradingPortfolio(hfC);
      for (const leg of hf.legs) {
        if (!leg.active || leg.entry === undefined) continue;
        const key = dedupeKey("hf-daytrading", leg.symbol);
        if (existing.has(key)) continue;
        const holdMs = leg.holdUntil ?? Date.now() + 6 * 60 * 60 * 1000;
        state.openPositions.push(
          openPosition({
            strategy: "hf-daytrading",
            symbol: leg.symbol,
            direction: leg.direction!,
            entry: leg.entry,
            tp1: leg.tp1,
            tp2: leg.tp2,
            stop: leg.stop!,
            holdUntil: new Date(holdMs).toISOString(),
            legs: 2,
            now,
          }),
        );
        existing.add(key);
        console.log(
          `  OPEN hf-daytrading ${leg.symbol} ${leg.direction} entry=$${leg.entry.toFixed(4)}`,
        );
      }

      // 2b. Hi-WR 1h
      const wrC: Record<string, Candle[] | undefined> = {};
      for (const { symbol } of HIGH_WR_PORTFOLIO_CONFIGS) {
        try {
          wrC[symbol] = await loadBinanceHistory({
            symbol,
            timeframe: "1h",
            targetCount: 200,
          });
        } catch {
          wrC[symbol] = undefined;
        }
      }
      const wr = evaluateHighWrPortfolio(wrC);
      for (const leg of wr.legs) {
        if (!leg.active || leg.entry === undefined) continue;
        const key = dedupeKey("hi-wr-1h", leg.symbol);
        if (existing.has(key)) continue;
        const holdMs = leg.holdUntil ?? Date.now() + 6 * 60 * 60 * 1000;
        state.openPositions.push(
          openPosition({
            strategy: "hi-wr-1h",
            symbol: leg.symbol,
            direction: leg.direction!,
            entry: leg.entry,
            tp1: leg.tp1,
            tp2: leg.tp2,
            stop: leg.stop!,
            holdUntil: new Date(holdMs).toISOString(),
            legs: 2,
            now,
          }),
        );
        existing.add(key);
        console.log(
          `  OPEN hi-wr-1h ${leg.symbol} ${leg.direction} entry=$${leg.entry.toFixed(4)}`,
        );
      }

      // 2c. Vol-spike locked edges (single leg)
      const uniqueVs = Array.from(
        new Set(LOCKED_EDGES.map((e) => lockedEdgeBinanceSymbol(e.symbol))),
      );
      const vsC: Record<string, Candle[]> = {};
      for (const s of uniqueVs) {
        try {
          vsC[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: "1h",
            targetCount: 200,
          });
        } catch {
          // skip
        }
      }
      for (const edge of LOCKED_EDGES) {
        const sym = lockedEdgeBinanceSymbol(edge.symbol);
        const c = vsC[sym];
        if (!c) continue;
        const snap = evaluateVolumeSpikeSignal(edge.symbol, c, {
          cfg: edge.cfg,
        });
        if (!snap.active || snap.entry === undefined) continue;
        const key = dedupeKey("vol-spike-1h", edge.symbol);
        if (existing.has(key)) continue;
        const holdMs =
          snap.exitAt ?? Date.now() + edge.cfg.holdBars * 60 * 60 * 1000;
        state.openPositions.push(
          openPosition({
            strategy: "vol-spike-1h",
            symbol: edge.symbol,
            direction: snap.direction!,
            entry: snap.entry,
            stop: snap.stop!,
            holdUntil: new Date(holdMs).toISOString(),
            legs: 1,
            now,
          }),
        );
        existing.add(key);
        console.log(
          `  OPEN vol-spike-1h ${edge.symbol} ${snap.direction} entry=$${snap.entry.toFixed(4)}`,
        );
      }

      state.lastTickAt = now;
      saveState(state);

      // 3. Summary
      const stats = computeStats(state.closedTrades);
      console.log(
        `\nThis tick: closed ${state.closedTrades.length - preClosed}, total open ${state.openPositions.length}, total closed ${state.closedTrades.length}`,
      );
      if (stats.totalTrades > 0) {
        console.log(
          `Cumulative: WR ${(stats.winRate * 100).toFixed(1)}%  net ret ${(stats.totalReturnPct * 100).toFixed(2)}%  PF ${stats.profitFactor.toFixed(2)}`,
        );
        console.log(
          `  avgWin ${(stats.avgWinPct * 100).toFixed(2)}%  avgLoss ${(stats.avgLossPct * 100).toFixed(2)}%`,
        );
        for (const s of Object.keys(stats.byStrategy) as Array<
          keyof typeof stats.byStrategy
        >) {
          const x = stats.byStrategy[s];
          if (x.trades === 0) continue;
          console.log(
            `  ${s.padEnd(16)} n=${x.trades}  WR ${(x.wr * 100).toFixed(1)}%  sumRet ${(x.ret * 100).toFixed(2)}%`,
          );
        }
      }
      console.log(`\nState: ${STATE_FILE}`);
    },
  );
});
