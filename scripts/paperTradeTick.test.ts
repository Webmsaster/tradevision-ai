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
import {
  recommendSize,
  STRATEGY_EDGE_STATS,
  type SizingMethod,
} from "../src/utils/positionSizing";
import { adaptiveStrategyStatsMap } from "../src/utils/adaptiveSizing";
import {
  computeRiskState,
  evaluateEntry,
  DEFAULT_RISK_LIMITS,
} from "../src/utils/riskManagement";
import {
  placeOrder,
  safetyConfigFromEnv as orderSafetyFromEnv,
  OrderBlockedError,
} from "../src/utils/binanceOrders";
import {
  configFromEnv as binanceConfigFromEnv,
  snapshotAccount,
} from "../src/utils/binanceAccount";
import {
  reconcile,
  formatDiffSummary,
} from "../src/utils/positionReconciliation";
import type { Candle } from "../src/utils/indicators";

const DEFAULT_CAPITAL = 10_000; // $10k paper capital (configurable via env)
const CAPITAL = Number(process.env.PAPER_CAPITAL ?? DEFAULT_CAPITAL);
const SIZING_METHOD: SizingMethod =
  (process.env.PAPER_SIZING as SizingMethod) ?? "quarter-kelly";
// Iter75: if BINANCE_LIVE=1, also place real orders on Binance (testnet by
// default; requires BINANCE_LIVE_MODE=1 for mainnet). Dry-run unless
// BINANCE_LIVE_EXECUTE=1. See src/utils/binanceOrders.ts for full safety.
const BINANCE_LIVE = process.env.BINANCE_LIVE === "1";

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

      // 2. Fetch current signals + apply risk/sizing gate

      // Compute current risk state for gating
      const riskState = computeRiskState({
        capital: CAPITAL,
        closedTrades: state.closedTrades,
        openPositions: state.openPositions,
      });
      console.log(
        `\nRisk state: capital $${CAPITAL}  daily ${(riskState.dailyRealisedPct * 100).toFixed(2)}%  open ${riskState.openCount}  longs ${riskState.openLongCount}  shorts ${riskState.openShortCount}`,
      );

      // Iter78: adaptive stats — switches to live-measured edge when n≥30
      const adaptive = adaptiveStrategyStatsMap(state.closedTrades);
      for (const [k, r] of Object.entries(adaptive)) {
        if (r.usedLive) {
          const wrDelta = (r.stats.winRate - r.backtest.winRate) * 100;
          console.log(
            `  adaptive ${k}: n=${r.liveN} live WR ${(r.stats.winRate * 100).toFixed(1)}% (backtest ${(r.backtest.winRate * 100).toFixed(1)}%, ${wrDelta >= 0 ? "+" : ""}${wrDelta.toFixed(1)}pp)`,
          );
        }
      }

      const dedupeKey = (s: string, sym: string) => `${s}|${sym}`;
      const existing = new Set(
        state.openPositions.map((p) => dedupeKey(p.strategy, p.symbol)),
      );

      // Helper to decide + size a proposed entry
      type Proposed = {
        strategy: "hf-daytrading" | "hi-wr-1h" | "vol-spike-1h";
        symbol: string;
        direction: "long" | "short";
        entry: number;
        stop: number;
        tp1?: number;
        tp2?: number;
        holdUntil: string;
        legs: 1 | 2;
      };
      async function tryOpen(p: Proposed): Promise<void> {
        const key = dedupeKey(p.strategy, p.symbol);
        if (existing.has(key)) return;
        const stats =
          adaptive[p.strategy]?.stats ?? STRATEGY_EDGE_STATS[p.strategy];
        const sizing = recommendSize({
          capital: CAPITAL,
          entry: p.entry,
          stop: p.stop,
          stats,
          method: SIZING_METHOD,
        });
        const decision = evaluateEntry({
          state: riskState,
          direction: p.direction,
          symbol: p.symbol,
          notional: sizing.notional,
          limits: DEFAULT_RISK_LIMITS,
        });
        if (!decision.allowed) {
          console.log(
            `  SKIP ${p.strategy} ${p.symbol} ${p.direction} — ${decision.reasons.join("; ")}`,
          );
          return;
        }
        state.openPositions.push(
          openPosition({
            strategy: p.strategy,
            symbol: p.symbol,
            direction: p.direction,
            entry: p.entry,
            tp1: p.tp1,
            tp2: p.tp2,
            stop: p.stop,
            holdUntil: p.holdUntil,
            legs: p.legs,
            now,
          }),
        );
        existing.add(key);
        // Update risk state (so next proposals in same tick see accurate count)
        riskState.openCount++;
        if (p.direction === "long") riskState.openLongCount++;
        else riskState.openShortCount++;
        riskState.bySymbol[p.symbol] = (riskState.bySymbol[p.symbol] ?? 0) + 1;
        riskState.totalOpenNotional += sizing.notional;
        riskState.totalExposureMult =
          riskState.totalOpenNotional / riskState.capital;

        const notesStr = sizing.notes.length
          ? ` [${sizing.notes.join(", ")}]`
          : "";
        const warnStr = decision.warnings.length
          ? ` ⚠ ${decision.warnings.join("; ")}`
          : "";
        console.log(
          `  OPEN ${p.strategy} ${p.symbol} ${p.direction} entry=$${p.entry.toFixed(4)} notional=$${sizing.notional.toFixed(0)} maxLoss=$${sizing.maxLoss.toFixed(2)} (${(sizing.maxLossPct * 100).toFixed(2)}%)${notesStr}${warnStr}`,
        );

        // Iter75: optionally place real order on Binance
        if (BINANCE_LIVE) {
          try {
            const qty = sizing.notional / p.entry;
            const r = await placeOrder(
              {
                symbol: p.symbol,
                side: p.direction === "long" ? "BUY" : "SELL",
                type: "LIMIT",
                quantity: Number(qty.toFixed(3)),
                price: p.entry,
                postOnly: true,
                notionalUsd: sizing.notional,
                clientOrderId: `tv-${p.strategy}-${Date.now()}`,
              },
              binanceConfigFromEnv(),
              orderSafetyFromEnv(),
            );
            console.log(
              `    ↳ BINANCE order ${r.orderId} ${r.status} @ $${r.price} qty=${r.quantity}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`    ↳ BINANCE order failed: ${msg}`);
          }
        }
      }

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
        const holdMs = leg.holdUntil ?? Date.now() + 6 * 60 * 60 * 1000;
        await tryOpen({
          strategy: "hf-daytrading",
          symbol: leg.symbol,
          direction: leg.direction!,
          entry: leg.entry,
          stop: leg.stop!,
          tp1: leg.tp1,
          tp2: leg.tp2,
          holdUntil: new Date(holdMs).toISOString(),
          legs: 2,
        });
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
        const holdMs = leg.holdUntil ?? Date.now() + 6 * 60 * 60 * 1000;
        await tryOpen({
          strategy: "hi-wr-1h",
          symbol: leg.symbol,
          direction: leg.direction!,
          entry: leg.entry,
          stop: leg.stop!,
          tp1: leg.tp1,
          tp2: leg.tp2,
          holdUntil: new Date(holdMs).toISOString(),
          legs: 2,
        });
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
        const holdMs =
          snap.exitAt ?? Date.now() + edge.cfg.holdBars * 60 * 60 * 1000;
        await tryOpen({
          strategy: "vol-spike-1h",
          symbol: edge.symbol,
          direction: snap.direction!,
          entry: snap.entry,
          stop: snap.stop!,
          holdUntil: new Date(holdMs).toISOString(),
          legs: 1,
        });
      }

      // Iter76: reconciliation against Binance (only when BINANCE_LIVE=1)
      if (BINANCE_LIVE) {
        try {
          const snap = await snapshotAccount(binanceConfigFromEnv());
          const diff = reconcile({
            paperOpen: state.openPositions,
            exchangePositions: snap.openPositions,
          });
          console.log(
            `\nReconciliation (${snap.isTestnet ? "testnet" : "mainnet"}, USDT=$${snap.usdtBalance.toFixed(2)}, uPnL=$${snap.totalUnrealisedPnl.toFixed(2)}):`,
          );
          console.log(formatDiffSummary(diff));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`\nReconciliation failed: ${msg}`);
        }
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
