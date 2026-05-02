/**
 * V4 LIVE-ENGINE WRAPPER — produces drop-in replacement signals using
 * the persistent-state V4 engine (`ftmoLiveEngineV4.ts`).
 *
 * Usage:
 *   FTMO_TF=2h-trend-v5-quartz-lite-r28-v4engine
 *
 * This wrapper:
 *   1. Loads V4 engine state from `${stateDir}/v4-engine.json`.
 *   2. Calls `pollLive()` with the latest aligned bar.
 *   3. Translates V4 PollSignal → LiveSignal (same interface V231 uses).
 *   4. Persists state via atomic-write.
 *
 * Crucially: the V4 engine has full feature-parity with the backtest's
 * persistent-state behavior (dailyPeakTrailingStop, peakDrawdownThrottle,
 * MCT, lossStreakCooldown, kelly, etc.) — features that the polling V231
 * detector cannot replicate because it has no persistent state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadState,
  saveState,
  pollLive,
  type FtmoLiveStateV4,
} from "@/utils/ftmoLiveEngineV4";
import type { Candle } from "@/utils/indicators";
import type {
  AccountState,
  DetectionResult,
  LiveSignal,
  Regime,
} from "@/utils/ftmoLiveSignalV231";
import type { FtmoDaytrade24hConfig } from "@/utils/ftmoDaytrade24h";

export interface DetectionResultV4 extends DetectionResult {
  /** V4-specific: snapshot of persistent state after this poll. */
  v4State?: {
    equity: number;
    mtmEquity: number;
    day: number;
    challengePeak: number;
    dayPeak: number;
    openPositions: number;
    pausedAtTarget: boolean;
    challengeEnded: boolean;
  };
}

/**
 * Build aligned candles dict for V4 engine. Caller passes flat
 * candleMap; we filter to assets present in the cfg + crossAssetFilter
 * symbol(s), and return only the aligned subset.
 */
function buildAligned(
  cfg: FtmoDaytrade24hConfig,
  candleMap: Record<string, Candle[]>,
): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {};
  const requiredKeys = new Set<string>();
  for (const a of cfg.assets) requiredKeys.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol)
    requiredKeys.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) requiredKeys.add(f.symbol);

  for (const k of requiredKeys) {
    if (!candleMap[k]) continue;
    out[k] = candleMap[k].filter((c) => c.isFinal !== false);
  }
  if (Object.keys(out).length === 0) return out;

  // Trim to common-openTime intersection so V4 engine's "latest bar"
  // assumption holds: every asset's last candle must share openTime.
  const arrs = Object.values(out);
  const common = new Set(arrs[0]!.map((c) => c.openTime));
  for (let i = 1; i < arrs.length; i++) {
    const seen = new Set(arrs[i]!.map((c) => c.openTime));
    for (const t of [...common]) if (!seen.has(t)) common.delete(t);
  }
  const aligned: Record<string, Candle[]> = {};
  for (const [k, v] of Object.entries(out)) {
    aligned[k] = v.filter((c) => common.has(c.openTime));
  }
  return aligned;
}

/**
 * V4 wrapper detection — drop-in replacement for `detectLiveSignalsV231`.
 *
 * Stateful: reads/writes `${stateDir}/v4-engine.json`. The V4 engine
 * encapsulates ALL persistent state (equity, day, peaks, MCT, pause).
 * The `account: AccountState` argument is used only to inform Telegram /
 * UI — the V4 engine maintains its own equity/day tracking internally.
 *
 * Signal-to-LiveSignal translation:
 *   - PollDecision.opens → LiveSignal[]
 *   - effRisk → riskFrac (as live-account risk fraction; the engine's
 *     effRisk is already in matching units for FTMO live-cap conventions)
 *   - chandelierAtrAtEntry / ptpConfig / beThreshold passed through.
 */
export function detectLiveSignalsV4(
  candleMap: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  cfgLabel: string,
  stateDir: string,
  account: AccountState,
): DetectionResultV4 {
  const result: DetectionResultV4 = {
    timestamp: Date.now(),
    regime: "BEAR_CHOP" as Regime,
    activeBotConfig: `V4_ENGINE:${cfgLabel}`,
    signals: [],
    skipped: [],
    notes: [`detectLiveSignalsV4: V4 persistent-state engine, cfg=${cfgLabel}`],
    account,
    btc: { close: 0, ema10: 0, ema15: 0, uptrend: false, mom24h: 0 },
  };

  const aligned = buildAligned(cfg, candleMap);
  if (Object.keys(aligned).length === 0) {
    result.notes.push("V4: no aligned candles after intersection");
    return result;
  }
  // Drop assets that have <100 bars (detectAsset minimum).
  for (const [k, v] of Object.entries(aligned)) {
    if (v.length < 100) {
      result.skipped.push({ asset: k, reason: `<100 bars (${v.length})` });
      delete aligned[k];
    }
  }
  if (Object.keys(aligned).length === 0) {
    result.notes.push("V4: all assets dropped (insufficient bars)");
    return result;
  }

  const state: FtmoLiveStateV4 = loadState(stateDir, cfgLabel);

  // Phase 15 (V4 Bug 1+2): SYNC engine state with the authoritative MT5
  // state from Python BEFORE pollLive. The engine's `state.equity` and
  // `state.openPositions` are reproductions, not source of truth. The
  // Python executor (sync_account_state) writes account.json with the
  // real MT5 equity, and ftmo_executor maintains real open positions.
  // Without this sync the engine's MTM diverges 1-3% per day from reality
  // → fail-checks and peak-drawdown trigger on phantom equity.
  // Phase 30 (V4 Audit Bug 2 — CRITICAL FIX): account.equity is the MT5 MTM
  // (realised + unrealised). Engine state.equity is realised-only. Setting
  // state.equity = account.equity caused double-counting: computeMtmEquity
  // adds unrealised PnL on top of state.equity → MTM was inflated by the
  // unrealised amount on every tick with open positions.
  // Phase 33 (Audit Bug 1): RECONCILE openPositions BEFORE equity-sync.
  // Otherwise a phantom position prevents the safe sync path (gated on
  // openPositions.length===0) — engine equity stays stale forever.
  try {
    const openPosPath = path.join(stateDir, "open-positions.json");
    if (fs.existsSync(openPosPath)) {
      const raw = JSON.parse(fs.readFileSync(openPosPath, "utf-8")) as {
        positions?: Array<{
          signalAsset?: string;
          assetSymbol?: string;
          direction?: string;
        }>;
      };
      const mt5Keys = new Set(
        (raw.positions ?? []).map((p) => {
          const sym = p.signalAsset ?? p.assetSymbol ?? "";
          const dir = p.direction ?? "";
          return `${sym}@${dir}`;
        }),
      );
      const before = state.openPositions.length;
      const GRACE_BARS = 3;
      const refKeyForBar = Object.keys(candleMap)[0];
      const refCandlesForBar = refKeyForBar
        ? candleMap[refKeyForBar]
        : undefined;
      const barDurMs =
        refCandlesForBar && refCandlesForBar.length >= 2
          ? refCandlesForBar[refCandlesForBar.length - 1]!.openTime -
            refCandlesForBar[refCandlesForBar.length - 2]!.openTime
          : 30 * 60_000;
      // Phase 33 (Audit Bug 6): cold-start guard. lastBarOpenTime=0 would
      // make graceCutoff negative → all phantoms survive forever.
      if (state.lastBarOpenTime > 0) {
        const graceCutoff = state.lastBarOpenTime - GRACE_BARS * barDurMs;
        state.openPositions = state.openPositions.filter((pos) => {
          const key = `${pos.symbol}@${pos.direction}`;
          if (mt5Keys.has(key)) return true;
          if (pos.entryTime >= graceCutoff) return true;
          return false;
        });
        const dropped = before - state.openPositions.length;
        if (dropped > 0) {
          result.notes.push(
            `V4 reconcile: dropped ${dropped} phantom position(s) not present in MT5`,
          );
        }
      }
    }
  } catch (e) {
    result.notes.push(
      `V4 reconcile failed: ${(e as Error).message} — keeping engine view`,
    );
  }

  // Equity sync — runs AFTER reconcile so the openPositions.length===0 gate
  // sees the true post-reconcile state.
  if (account.equity != null && Number.isFinite(account.equity)) {
    if (account.equity > 0.5 && account.equity < 2.0) {
      if (state.openPositions.length === 0) {
        // No unrealised — safe to fully adopt MT5 MTM into realised.
        state.equity = account.equity;
        state.mtmEquity = account.equity;
      } else {
        // Have open positions: account.equity reflects MTM. Sanity-check
        // drift but keep engine view (asset-level detail).
        const engineMtm = state.mtmEquity ?? state.equity;
        const drift = Math.abs(engineMtm - account.equity);
        if (drift > 0.02) {
          result.notes.push(
            `V4 sync: engine MTM ${(engineMtm * 100).toFixed(2)}% diverges from MT5 ${(account.equity * 100).toFixed(2)}% (drift ${(drift * 100).toFixed(2)}pp) — keeping engine view`,
          );
        }
      }
    } else {
      result.notes.push(
        `V4 sync: rejected anomalous account.equity=${account.equity}`,
      );
    }
  }
  if (
    account.challengePeak != null &&
    Number.isFinite(account.challengePeak) &&
    account.challengePeak > 0
  ) {
    if (account.challengePeak > state.challengePeak) {
      state.challengePeak = account.challengePeak;
    }
  }

  // Phase 20 (V4 Bug 4): adopt Python's externally-confirmed ping-days for
  // post-target trading-day count. Engine speculatively counts days since
  // target-hit, but FTMO only counts days where a real trade actually filled.
  // Python's pause-state.json tracks confirmed ping-day fills.
  try {
    if (state.pausedAtTarget) {
      const pauseStatePath = path.join(stateDir, "pause-state.json");
      if (fs.existsSync(pauseStatePath)) {
        const raw = JSON.parse(fs.readFileSync(pauseStatePath, "utf-8")) as {
          ping_dates?: string[];
        };
        const confirmedPings = (raw.ping_dates ?? []).length;
        // Pre-target trading days are real (they had real trade fills).
        // Use min(engine-counted, target_day + confirmedPings + 1) as the honest count.
        const targetDay = state.firstTargetHitDay ?? state.day;
        const honestCount = Math.min(
          state.tradingDays.length,
          targetDay + confirmedPings + 1, // +1 for the target-hit day itself
        );
        if (honestCount < state.tradingDays.length) {
          // Engine counted post-target days that Python hasn't confirmed.
          state.tradingDays = state.tradingDays.slice(0, honestCount);
          result.notes.push(
            `V4 ping-confirm: capped tradingDays to ${honestCount} ` +
              `(target ${targetDay} + ${confirmedPings} confirmed pings)`,
          );
        }
      }
    }
  } catch (e) {
    result.notes.push(
      `V4 ping-confirm failed: ${(e as Error).message} — keeping engine view`,
    );
  }

  // BTC sample for the legacy `btc` field (display only, not used by V4).
  const btc = aligned["BTCUSDT"];
  if (btc && btc.length > 0) {
    const last = btc[btc.length - 1];
    result.btc.close = last!.close;
  }

  let poll;
  try {
    poll = pollLive(state, aligned, cfg);
  } catch (err) {
    result.notes.push(`V4 pollLive threw: ${(err as Error).message}`);
    return result;
  }

  // Translate decisions to LiveSignal records (same shape V231 emits).
  const refKey = Object.keys(aligned)[0];
  const refCandles = aligned[refKey];
  const lastBar = refCandles[refCandles.length - 1];
  const barDur =
    refCandles.length >= 2
      ? refCandles[refCandles.length - 1].openTime -
        refCandles[refCandles.length - 2].openTime
      : 30 * 60 * 1000;

  for (const open of poll.decision.opens) {
    const asset = cfg.assets.find((a) => a.symbol === open.symbol);
    const holdBars = asset?.holdBars ?? cfg.holdBars;
    const hoursPerBar = barDur / 3_600_000;
    const maxHoldHours = (holdBars + 1) * hoursPerBar;
    // engine effRisk → live-loss-fraction conversion
    const equityLossFrac = open.effRisk * open.stopPct * cfg.leverage;
    const sig: LiveSignal = {
      assetSymbol: open.symbol,
      sourceSymbol: open.sourceSymbol,
      direction: open.direction,
      regime: result.regime,
      entryPrice: open.entryPrice,
      stopPrice: open.stopPrice,
      tpPrice: open.tpPrice,
      stopPct: open.stopPct,
      tpPct: open.tpPct,
      riskFrac: Math.min(equityLossFrac, 0.04), // live-cap 4% per trade
      sizingFactor: 1, // already baked into effRisk by engine
      maxHoldHours,
      maxHoldUntil: open.entryTime + maxHoldHours * 3_600_000,
      signalBarClose: lastBar.closeTime,
      reasons: [`V4 engine open: ${open.symbol} ${open.direction}`],
      ...(open.chandelierAtrAtEntry != null
        ? {
            chandelierExit: {
              atrAtEntry: open.chandelierAtrAtEntry,
              mult: cfg.chandelierExit?.mult ?? 0,
              minMoveR: cfg.chandelierExit?.minMoveR ?? 0.5,
              stopPct: open.stopPct,
            },
          }
        : {}),
      ...(open.ptpConfig ? { partialTakeProfit: open.ptpConfig } : {}),
      ...(open.beThreshold !== undefined
        ? { breakEvenAtProfit: { threshold: open.beThreshold } }
        : {}),
    };
    result.signals.push(sig);
  }

  result.skipped.push(...poll.skipped);
  result.notes.push(...poll.notes);
  if (poll.targetHit) result.notes.push("V4: profitTarget hit");
  if (poll.challengeEnded) {
    result.notes.push(
      `V4: challenge ended — ${poll.passed ? "PASSED" : `FAILED (${poll.failReason})`}`,
    );
  }

  result.v4State = {
    equity: state.equity,
    mtmEquity: state.mtmEquity,
    day: state.day,
    challengePeak: state.challengePeak,
    dayPeak: state.dayPeak,
    openPositions: state.openPositions.length,
    pausedAtTarget: state.pausedAtTarget,
    challengeEnded: poll.challengeEnded,
  };

  // Persist updated state.
  try {
    saveState(state, stateDir);
  } catch (err) {
    result.notes.push(`V4: saveState failed — ${(err as Error).message}`);
  }
  return result;
}

/**
 * Reset V4 state — call on new challenge start. Wipes `v4-engine.json`
 * and re-initializes from cfgLabel.
 */
export function resetV4State(stateDir: string, cfgLabel: string): void {
  // Phase 14 (V4 Bug 13): top-level ESM `import * as fs` instead of CJS
  // require(). Strict-ESM environments throw on require() in .ts files.
  const filePath = path.join(stateDir, "v4-engine.json");
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
  // Just write a fresh initial state.
  const fresh = loadState(stateDir, cfgLabel);
  saveState(fresh, stateDir);
}
