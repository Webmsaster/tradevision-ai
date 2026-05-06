/**
 * ML-Overlay Feature-Extraction — produces a labelled dataset where each
 * row is (signal_features, outcome). The dataset feeds an XGBoost trainer
 * (Python — see scripts/ml_overlay_train.py).
 *
 * Pipeline:
 *   1. Replay R28_V6_PASSLOCK on cached candles, capturing every signal
 *      that the engine emitted PLUS the eventual outcome (win/loss).
 *   2. For each signal, extract per-bar features at the moment of emission:
 *        - rsi (3 timeframes)
 *        - atr / close (volatility ratio)
 *        - ema-ratios (trend strength)
 *        - volume z-score
 *        - hour-of-day, day-of-week
 *        - regime (bull/bear/range from BTC)
 *   3. Outcome = 1 if signal closed at TP, 0 if at stop.
 *   4. Write to features.parquet.jsonl (one row per signal).
 *
 * Output: scripts/cache_bakeoff/ml_features.jsonl
 *
 * Usage: npx tsx scripts/_mlOverlayFeatures.ts
 *
 * Next step (Python, deferred): scripts/ml_overlay_train.py reads the JSONL,
 * trains XGBoost with 80/20 split, computes feature importance, persists
 * model.json. Integration point: in detectAsset, score signals with the
 * model and skip those below threshold.
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { FTMO_DAYTRADE_24H_R28_V6_PASSLOCK } from "../src/utils/ftmoDaytrade24h";
import { initialState, pollLive } from "../src/utils/ftmoLiveEngineV4";
import { atr, ema, rsi } from "../src/utils/indicators";
import type { Candle } from "../src/utils/indicators";

const CACHE_DIR = "scripts/cache_bakeoff";
const OUT = `${CACHE_DIR}/ml_features.jsonl`;
writeFileSync(OUT, "");

const SYMBOLS = [
  "AAVEUSDT",
  "ADAUSDT",
  "BCHUSDT",
  "BNBUSDT",
  "BTCUSDT",
  "ETCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
];

function loadAligned() {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    data[s] = JSON.parse(readFileSync(`${CACHE_DIR}/${s}_30m.json`, "utf-8"));
  const sets = SYMBOLS.map((s) => new Set(data[s]!.map((c) => c.openTime)));
  const common = [...sets[0]!]
    .filter((t) => sets.every((set) => set.has(t)))
    .sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of SYMBOLS)
    aligned[s] = data[s]!.filter((c) => cs.has(c.openTime));
  return {
    aligned,
    minBars: Math.min(...SYMBOLS.map((s) => aligned[s]!.length)),
  };
}

const { aligned, minBars } = loadAligned();

// Pre-compute indicator caches PER ASSET on the full series (one-time).
const indicators: Record<
  string,
  {
    rsi14: (number | null)[];
    rsi28: (number | null)[];
    atr14: (number | null)[];
    ema9: (number | null)[];
    ema21: (number | null)[];
    ema55: (number | null)[];
  }
> = {};
for (const sym of SYMBOLS) {
  const closes = aligned[sym]!.map((c) => c.close);
  indicators[sym] = {
    rsi14: rsi(closes, 14),
    rsi28: rsi(closes, 28),
    atr14: atr(aligned[sym]!, 14),
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema55: ema(closes, 55),
  };
}

// BTC regime (4-class encoding for tree models: 0=range, 1=bull, -1=bear).
function btcRegimeAt(idx: number): number {
  const e9 = indicators["BTCUSDT"]!.ema9[idx];
  const e55 = indicators["BTCUSDT"]!.ema55[idx];
  const close = aligned["BTCUSDT"]![idx]?.close;
  if (e9 == null || e55 == null || close == null) return 0;
  if (e9 > e55 && close > e55) return 1; // bull
  if (e9 < e55 && close < e55) return -1; // bear
  return 0; // range
}

// Replay engine, capture (signal, eventual outcome) pairs.
const cfg = FTMO_DAYTRADE_24H_R28_V6_PASSLOCK;
const winBars = cfg.maxDays * 48;
const stepBars = 14 * 48;
const WARMUP = 5000;

interface PendingSignal {
  symbol: string;
  source_symbol: string;
  bar_idx: number;
  features: Record<string, number | null>;
  ticket_id: string;
  emitted_at_ts: number;
}
let totalRows = 0;

console.log(
  `[ml-features] extracting features per signal across all R28_V6 windows`,
);

for (let start = WARMUP; start + winBars <= minBars; start += stepBars) {
  const state = initialState("R28_V6_PASSLOCK");
  let pending: PendingSignal[] = [];

  for (let i = start; i < start + winBars; i++) {
    const slice: Record<string, Candle[]> = {};
    for (const k of Object.keys(aligned))
      slice[k] = aligned[k]!.slice(0, i + 1);
    const r = pollLive(state, slice, cfg);

    // Capture freshly emitted signals.
    for (const sig of r.decision.opens) {
      const sym = sig.sourceSymbol;
      const idx = i;
      const ind = indicators[sym]!;
      const c = aligned[sym]![idx]!;
      const e9 = ind.ema9[idx];
      const e21 = ind.ema21[idx];
      const e55 = ind.ema55[idx];
      const a14 = ind.atr14[idx];
      const features: Record<string, number | null> = {
        // Direction encoded as ±1
        direction: sig.direction === "long" ? 1 : -1,
        rsi14: ind.rsi14[idx],
        rsi28: ind.rsi28[idx],
        atr_pct: a14 != null ? a14 / c.close : null,
        ema_9_21_ratio:
          e9 != null && e21 != null && e21 > 0 ? e9 / e21 - 1 : null,
        ema_21_55_ratio:
          e21 != null && e55 != null && e55 > 0 ? e21 / e55 - 1 : null,
        close_vs_ema21: e21 != null && e21 > 0 ? c.close / e21 - 1 : null,
        log_volume: c.volume > 0 ? Math.log(c.volume) : null,
        hour_utc: new Date(c.openTime).getUTCHours(),
        dow_utc: new Date(c.openTime).getUTCDay(),
        btc_regime: btcRegimeAt(idx),
        stop_pct: sig.stopPct,
        tp_pct: sig.tpPct,
        eff_risk: sig.effRisk,
      };
      pending.push({
        symbol: sig.symbol,
        source_symbol: sym,
        bar_idx: idx,
        features,
        // R67-r8 audit fix: match the engine's ticketId format exactly
        // (ftmoLiveEngineV4.ts:1831 = `${asset.symbol}@${matched.entryTime}@${matched.direction}`).
        // R7 used `${sig.entryTime}-${sig.symbol}` which would never match
        // closes → ZERO labeled rows → ML training silently bombs.
        ticket_id: `${sig.symbol}@${sig.entryTime}@${sig.direction}`,
        emitted_at_ts: c.openTime,
      });
    }

    // Match newly closed trades to pending signals by ticket_id and label them.
    // Iterate r.decision.closes (per-bar list) instead of state.closedTrades.slice(-N) —
    // slice is fragile when force-close batches mix into the same poll.
    for (const close of r.decision.closes) {
      const matched = pending.find((p) => p.ticket_id === close.ticketId);
      if (!matched) continue;
      const outcome =
        close.exitReason === "tp" ? 1 : close.exitReason === "stop" ? 0 : -1;
      if (outcome !== -1) {
        const closedRec = state.closedTrades.find(
          (c) => c.ticketId === close.ticketId,
        );
        appendFileSync(
          OUT,
          JSON.stringify({
            ...matched.features,
            outcome,
            eff_pnl: closedRec?.effPnl ?? 0,
            window_start: start,
            ticket_id: matched.ticket_id,
          }) + "\n",
        );
        totalRows++;
      }
      pending = pending.filter((p) => p.ticket_id !== matched.ticket_id);
    }

    if (r.challengeEnded) break;
  }
}

console.log(`[ml-features] DONE — wrote ${totalRows} feature rows to ${OUT}`);
console.log(
  `Next step: train XGBoost on the JSONL via scripts/ml_overlay_train.py`,
);
