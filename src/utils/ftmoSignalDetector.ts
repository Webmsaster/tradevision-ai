/**
 * Live signal detector for iter212/iter213 — reusable logic that checks
 * whether a trade signal is present on the MOST RECENTLY CLOSED 4h bar.
 *
 * Unlike the backtest engine which generates a full trade history, this
 * detector returns a single "is there a signal right now?" answer with
 * exact entry/stop/tp/max-hold levels ready for manual execution.
 */

import type { Candle } from "@/utils/indicators";
import { ema } from "@/utils/indicators";
import type { NewsEvent } from "@/utils/forexFactoryNews";
import { isNewsBlackout } from "@/utils/forexFactoryNews";
import {
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_CONFIG_BULL,
} from "@/utils/ftmoDaytrade24h";

export type Regime = "BULL" | "BEAR_CHOP";

export interface SignalAlert {
  hasSignal: boolean;
  regime: Regime;
  botUsed: "iter212" | "iter213";
  direction: "long" | "short" | null;
  entryPrice: number | null;
  stopPrice: number | null;
  tpPrice: number | null;
  stopPct: number | null;
  tpPct: number | null;
  maxHoldHours: number;
  maxHoldUntil: number | null; // epoch ms
  signalBarClose: number; // epoch ms of signal bar's close
  reasons: string[]; // human-readable check log
  skipReason: string | null; // if hasSignal=false, why
  btc: {
    close: number;
    ema10: number;
    ema15: number;
    uptrend: boolean;
    mom24h: number;
  };
  eth: {
    close: number;
    last2GreenSeq: boolean;
    last2RedSeq: boolean;
  };
}

/**
 * Check the MOST RECENTLY CLOSED 4h bar for a trade signal.
 *
 * Live usage: call this right after each 4h bar close (00/04/08/12/16/20 UTC).
 * The `ethCandles` and `btcCandles` arrays must end with the just-closed bar.
 */
export function detectLiveSignal(
  ethCandles: Candle[],
  btcCandles: Candle[],
  newsEvents: NewsEvent[] = [],
): SignalAlert {
  const reasons: string[] = [];

  // ---------- Regime detection ----------
  const btcCloses = btcCandles.map((c) => c.close);
  const btcEma10Arr = ema(btcCloses, 10);
  const btcEma15Arr = ema(btcCloses, 15);
  const lastIdx = btcCandles.length - 1;
  const btcClose = btcCandles[lastIdx].close;
  const btcEma10 = btcEma10Arr[lastIdx] ?? btcClose;
  const btcEma15 = btcEma15Arr[lastIdx] ?? btcClose;
  const btcMom24h =
    lastIdx >= 6
      ? (btcClose - btcCandles[lastIdx - 6].close) /
        btcCandles[lastIdx - 6].close
      : 0;
  const btcUptrend = btcClose > btcEma10 && btcEma10 > btcEma15;
  const btcBullMom = btcMom24h > 0.02;
  const regime: Regime = btcUptrend && btcBullMom ? "BULL" : "BEAR_CHOP";
  const botUsed = regime === "BULL" ? "iter213" : "iter212";
  reasons.push(`Regime: ${regime} → ${botUsed}`);

  // ---------- ETH signal pattern (last 2 bars) ----------
  const ethLastIdx = ethCandles.length - 1;
  const b0 = ethCandles[ethLastIdx - 1]; // previous bar
  const b1 = ethCandles[ethLastIdx]; // just-closed bar
  if (!b0 || !b1) {
    return mkNoSignal(regime, botUsed, reasons, "insufficient candles", {
      btcClose,
      btcEma10,
      btcEma15,
      btcUptrend,
      btcMom24h,
      ethClose: b1?.close ?? 0,
    });
  }
  const last2Green =
    b1.close > b0.close && b0.close > ethCandles[ethLastIdx - 2]?.close;
  const last2Red =
    b1.close < b0.close && b0.close < ethCandles[ethLastIdx - 2]?.close;

  // iter212 MR-short: 2 green → short
  // iter213 MOM-long (invertDirection=true): 2 green → long
  // Both use 2-green pattern, just interpret differently.
  const patternOk = last2Green;
  reasons.push(`2-green sequence: ${patternOk ? "✓" : "✗"}`);
  if (!patternOk) {
    return mkNoSignal(regime, botUsed, reasons, "no 2-green sequence", {
      btcClose,
      btcEma10,
      btcEma15,
      btcUptrend,
      btcMom24h,
      ethClose: b1.close,
    });
  }

  // ---------- BTC cross-asset filter ----------
  let blockedByBTC = false;
  if (botUsed === "iter212") {
    // skipShortsIfSecondaryUptrend + mom>+2%
    if (btcUptrend) {
      blockedByBTC = true;
      reasons.push("BTC filter: uptrend detected → skip short");
    } else if (btcMom24h > 0.02) {
      blockedByBTC = true;
      reasons.push(
        `BTC filter: 24h mom +${(btcMom24h * 100).toFixed(2)}% > +2% → skip short`,
      );
    } else {
      reasons.push(
        `BTC filter: OK (uptrend=${btcUptrend}, mom=${(btcMom24h * 100).toFixed(2)}%)`,
      );
    }
  } else {
    // iter213: skipLongsIfSecondaryDowntrend + mom<-2%
    const btcDowntrend = btcClose < btcEma10 && btcEma10 < btcEma15;
    if (btcDowntrend) {
      blockedByBTC = true;
      reasons.push("BTC filter: downtrend → skip long");
    } else if (btcMom24h < -0.02) {
      blockedByBTC = true;
      reasons.push(
        `BTC filter: 24h mom ${(btcMom24h * 100).toFixed(2)}% < −2% → skip long`,
      );
    } else {
      reasons.push(
        `BTC filter: OK (downtrend=${btcDowntrend}, mom=${(btcMom24h * 100).toFixed(2)}%)`,
      );
    }
  }
  if (blockedByBTC) {
    return mkNoSignal(
      regime,
      botUsed,
      reasons,
      "BTC cross-asset filter blocks trade",
      {
        btcClose,
        btcEma10,
        btcEma15,
        btcUptrend,
        btcMom24h,
        ethClose: b1.close,
      },
    );
  }

  // ---------- Session filter (iter212: drop 8 UTC) ----------
  // Entry = next 4h bar's open, which is the hour of b1.closeTime + 1ms.
  // b1.closeTime = b1.openTime + 4h - 1ms, so next open = b1.openTime + 4h.
  const entryOpenTime = b1.openTime + 4 * 3600_000;
  const entryHour = new Date(entryOpenTime).getUTCHours();
  if (botUsed === "iter212") {
    const allowed = [0, 4, 12, 16, 20];
    if (!allowed.includes(entryHour)) {
      reasons.push(
        `Session filter: entry hour ${entryHour} UTC not in [0,4,12,16,20]`,
      );
      return mkNoSignal(
        regime,
        botUsed,
        reasons,
        `entry hour ${entryHour} UTC dropped by session filter`,
        {
          btcClose,
          btcEma10,
          btcEma15,
          btcUptrend,
          btcMom24h,
          ethClose: b1.close,
        },
      );
    }
  }
  // iter213 has no session filter — all hours allowed

  // ---------- News filter ----------
  if (isNewsBlackout(entryOpenTime, newsEvents, 2)) {
    const windowStart = new Date(entryOpenTime - 2 * 60_000).toISOString();
    const windowEnd = new Date(entryOpenTime + 2 * 60_000).toISOString();
    reasons.push(
      `News blackout: entry ${new Date(entryOpenTime).toISOString()} within 2-min of high-impact event`,
    );
    return mkNoSignal(
      regime,
      botUsed,
      reasons,
      `news blackout (±2min) around ${windowStart}..${windowEnd}`,
      {
        btcClose,
        btcEma10,
        btcEma15,
        btcUptrend,
        btcMom24h,
        ethClose: b1.close,
      },
    );
  }
  reasons.push("News filter: clear");

  // ---------- Build signal ----------
  const cfg =
    botUsed === "iter212"
      ? FTMO_DAYTRADE_24H_CONFIG
      : FTMO_DAYTRADE_24H_CONFIG_BULL;
  const direction: "long" | "short" = botUsed === "iter212" ? "short" : "long";
  // Entry = next bar open. In live, by the time user places order, price ≈ current
  // market. We report the signal-bar close as the reference; actual fill will be
  // next-bar open within seconds.
  const entryPrice = b1.close;
  const stopPct = cfg.stopPct;
  const tpPct = cfg.tpPct;
  const stopPrice =
    direction === "long"
      ? entryPrice * (1 - stopPct)
      : entryPrice * (1 + stopPct);
  const tpPrice =
    direction === "long" ? entryPrice * (1 + tpPct) : entryPrice * (1 - tpPct);
  const maxHoldHours = cfg.holdBars * 4;
  const maxHoldUntil = entryOpenTime + maxHoldHours * 3600_000;

  reasons.push(
    `✅ ENTRY: ${direction.toUpperCase()} @ ${entryPrice.toFixed(2)}`,
  );

  return {
    hasSignal: true,
    regime,
    botUsed,
    direction,
    entryPrice,
    stopPrice,
    tpPrice,
    stopPct,
    tpPct,
    maxHoldHours,
    maxHoldUntil,
    signalBarClose: b1.closeTime,
    reasons,
    skipReason: null,
    btc: {
      close: btcClose,
      ema10: btcEma10,
      ema15: btcEma15,
      uptrend: btcUptrend,
      mom24h: btcMom24h,
    },
    eth: { close: b1.close, last2GreenSeq: last2Green, last2RedSeq: last2Red },
  };
}

function mkNoSignal(
  regime: Regime,
  botUsed: "iter212" | "iter213",
  reasons: string[],
  skipReason: string,
  ctx: {
    btcClose: number;
    btcEma10: number;
    btcEma15: number;
    btcUptrend: boolean;
    btcMom24h: number;
    ethClose: number;
  },
): SignalAlert {
  return {
    hasSignal: false,
    regime,
    botUsed,
    direction: null,
    entryPrice: null,
    stopPrice: null,
    tpPrice: null,
    stopPct: null,
    tpPct: null,
    maxHoldHours: 12,
    maxHoldUntil: null,
    signalBarClose: 0,
    reasons,
    skipReason,
    btc: {
      close: ctx.btcClose,
      ema10: ctx.btcEma10,
      ema15: ctx.btcEma15,
      uptrend: ctx.btcUptrend,
      mom24h: ctx.btcMom24h,
    },
    eth: { close: ctx.ethClose, last2GreenSeq: false, last2RedSeq: false },
  };
}

/** Render a SignalAlert to a human-readable string for terminal/telegram/email. */
export function renderAlert(a: SignalAlert): string {
  const lines: string[] = [];
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  lines.push(`━━━━━ FTMO Signal Check @ ${ts} ━━━━━`);
  lines.push(`Regime: ${a.regime}  |  Bot: ${a.botUsed}`);
  lines.push(
    `BTC: $${a.btc.close.toFixed(0)}  EMA10: $${a.btc.ema10.toFixed(0)}  EMA15: $${a.btc.ema15.toFixed(0)}  24h: ${(a.btc.mom24h * 100).toFixed(2)}%`,
  );
  lines.push(`ETH: $${a.eth.close.toFixed(2)}`);
  lines.push("");
  for (const r of a.reasons) lines.push(`  ${r}`);
  lines.push("");
  if (a.hasSignal) {
    lines.push("╔══════════════════════════════════════════════════╗");
    lines.push(`║  🚨 TRADE SIGNAL: ${a.direction!.toUpperCase().padEnd(32)}║`);
    lines.push("╠══════════════════════════════════════════════════╣");
    lines.push(
      `║  Entry: ETH ${a.direction} @ $${a.entryPrice!.toFixed(2).padEnd(30)}║`,
    );
    lines.push(
      `║  Stop:  $${a.stopPrice!.toFixed(2)} (${a.direction === "short" ? "+" : "-"}${(a.stopPct! * 100).toFixed(2)}%)${" ".repeat(Math.max(0, 29 - (a.direction === "short" ? 1 : 1) - (a.stopPct! * 100).toFixed(2).length))}║`,
    );
    lines.push(
      `║  TP:    $${a.tpPrice!.toFixed(2)} (${a.direction === "short" ? "-" : "+"}${(a.tpPct! * 100).toFixed(2)}%)${" ".repeat(Math.max(0, 29 - 1 - (a.tpPct! * 100).toFixed(2).length))}║`,
    );
    lines.push(
      `║  Max hold: ${a.maxHoldHours}h → until ${new Date(a.maxHoldUntil!).toISOString().slice(0, 16)}Z  ║`,
    );
    lines.push("╚══════════════════════════════════════════════════╝");
    lines.push("");
    lines.push("➡️  ACTION: Open this trade in FTMO MT5/cTrader NOW.");
    lines.push(
      `    Use 1:2 leverage. Base position size: 100% risk allocation.`,
    );
    lines.push(
      `    If account equity > +1.5%, ADD 4× pyramid on this signal too.`,
    );
  } else {
    lines.push(`⏸  NO SIGNAL — ${a.skipReason}`);
  }
  return lines.join("\n");
}
