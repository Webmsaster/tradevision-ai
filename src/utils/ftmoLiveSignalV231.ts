/**
 * Live iter231 multi-asset signal detector.
 *
 * Checks ETH/BTC/SOL for mean-reversion signals on their MOST RECENTLY
 * CLOSED 4h bar. Returns all triggered signals with exact entry/stop/tp
 * levels and position-size multiplier based on current equity state.
 *
 * This is iter231-aware: it knows about the delayed BTC/SOL activation
 * (minEquityGain 4%), the ETH pyramid (earlyPyr 5x @ +0.3%), the 5-tier
 * adaptive sizing curve, the timeBoost, and Kelly sizing.
 *
 * The caller must pass current account state (equity, day in challenge,
 * recent PnLs for Kelly) so we can compute the exact risk multiplier.
 */
import type { Candle } from "@/utils/indicators";
import { ema } from "@/utils/indicators";
import { FTMO_DAYTRADE_24H_CONFIG_V231 } from "@/utils/ftmoDaytrade24h";
import type { NewsEvent } from "@/utils/forexFactoryNews";
import { isNewsBlackout } from "@/utils/forexFactoryNews";

export interface AccountState {
  /** Current equity as fraction of starting capital (1.0 = break even, 1.05 = +5%). */
  equity: number;
  /** Day in challenge (0 = day 1). */
  day: number;
  /** PnL fractions of last N completed trades (most recent last). */
  recentPnls: number[];
  /** Start-of-day equity for daily-loss check. */
  equityAtDayStart: number;
}

export interface LiveSignal {
  assetSymbol: "ETH-MR" | "ETH-PYR" | "BTC-MR" | "SOL-MR";
  sourceSymbol: "ETHUSDT" | "BTCUSDT" | "SOLUSDT";
  direction: "short";
  entryPrice: number; // market-bar close; exec price will be next-bar open
  stopPrice: number;
  tpPrice: number;
  stopPct: number;
  tpPct: number;
  /** Risk as fraction of account equity (e.g. 0.01 = 1% risk). */
  riskFrac: number;
  /** Effective multiplier applied (adaptive x timeBoost x kelly). */
  sizingFactor: number;
  maxHoldHours: number;
  maxHoldUntil: number;
  signalBarClose: number;
  reasons: string[];
}

export interface DetectionResult {
  timestamp: number;
  signals: LiveSignal[];
  skipped: Array<{ asset: string; reason: string }>;
  notes: string[];
  account: AccountState;
  btc: {
    close: number;
    ema10: number;
    ema15: number;
    uptrend: boolean;
    mom24h: number;
  };
}

const CFG = FTMO_DAYTRADE_24H_CONFIG_V231;

/**
 * Compute current sizing factor from adaptiveSizing + timeBoost + Kelly.
 * Mirrors the engine's logic at src/utils/ftmoDaytrade24h.ts.
 */
function computeSizingFactor(account: AccountState): {
  factor: number;
  notes: string[];
} {
  const notes: string[] = [];
  let factor = 1;

  // Adaptive sizing tiers (sorted ascending; highest matching tier wins)
  if (CFG.adaptiveSizing && CFG.adaptiveSizing.length > 0) {
    for (const tier of CFG.adaptiveSizing) {
      if (account.equity - 1 >= tier.equityAbove) factor = tier.factor;
    }
    notes.push(
      `adaptiveSizing: equity=${((account.equity - 1) * 100).toFixed(2)}% → factor=${factor}`,
    );
  }

  // timeBoost override (only INCREASES)
  if (
    CFG.timeBoost &&
    account.day >= CFG.timeBoost.afterDay &&
    account.equity - 1 < CFG.timeBoost.equityBelow &&
    CFG.timeBoost.factor > factor
  ) {
    factor = CFG.timeBoost.factor;
    notes.push(
      `timeBoost: day=${account.day}, eq<${(CFG.timeBoost.equityBelow * 100).toFixed(0)}% → factor=${factor}`,
    );
  }

  // Kelly sizing multiplier
  if (
    CFG.kellySizing &&
    account.recentPnls.length >= CFG.kellySizing.minTrades
  ) {
    const wins = account.recentPnls.filter((p) => p > 0).length;
    const wr = wins / account.recentPnls.length;
    let kMult = 1;
    const sortedTiers = [...CFG.kellySizing.tiers].sort(
      (a, b) => b.winRateAbove - a.winRateAbove,
    );
    for (const tier of sortedTiers) {
      if (wr >= tier.winRateAbove) {
        kMult = tier.multiplier;
        break;
      }
    }
    factor *= kMult;
    notes.push(
      `kelly: wr=${(wr * 100).toFixed(0)}% (${wins}/${account.recentPnls.length}) → mult=${kMult} (combined factor=${factor.toFixed(3)})`,
    );
  } else if (CFG.kellySizing) {
    notes.push(
      `kelly: warming up (${account.recentPnls.length}/${CFG.kellySizing.minTrades} trades)`,
    );
  }

  return { factor, notes };
}

/**
 * Check if a 4h bar shows the N-red or N-green close sequence
 * (mean-reversion: N green closes → short signal).
 */
function hasSignalPattern(
  candles: Candle[],
  triggerBars: number,
  invert: boolean,
): boolean {
  const last = candles.length - 1;
  if (last < triggerBars) return false;
  for (let k = 0; k < triggerBars; k++) {
    // Mean-reversion short: need each close <= prev (not a green sequence) inverts to "needs green"
    // We want N consecutive GREEN closes for a short signal (mean-revert the run-up).
    const cur = candles[last - k];
    const prev = candles[last - k - 1];
    if (!cur || !prev) return false;
    const isGreen = cur.close > prev.close;
    if (!isGreen) return false;
  }
  return true;
}

export function detectLiveSignalsV231(
  ethCandles: Candle[],
  btcCandles: Candle[],
  solCandles: Candle[],
  account: AccountState,
  newsEvents: NewsEvent[] = [],
): DetectionResult {
  const result: DetectionResult = {
    timestamp: Date.now(),
    signals: [],
    skipped: [],
    notes: [],
    account,
    btc: { close: 0, ema10: 0, ema15: 0, uptrend: false, mom24h: 0 },
  };

  // BTC regime for cross-asset filter
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
  result.btc = {
    close: btcClose,
    ema10: btcEma10,
    ema15: btcEma15,
    uptrend: btcUptrend,
    mom24h: btcMom24h,
  };

  const blockedByBtcFilter = btcUptrend || btcMom24h > 0.02;
  if (blockedByBtcFilter) {
    result.notes.push(
      `BTC cross-asset filter BLOCKS all signals: uptrend=${btcUptrend}, mom24h=${(btcMom24h * 100).toFixed(2)}%`,
    );
    // No short signals allowed when BTC is bullish
  }

  // Session filter (iter212 base: allowedHoursUtc = [0, 4, 12, 16, 20])
  // Entry = next bar's open. So signal-bar close hour + 4 is entry hour.
  const ethLastIdx = ethCandles.length - 1;
  const b1 = ethCandles[ethLastIdx];
  const entryOpenTime = b1.openTime + 4 * 3600_000;
  const entryHour = new Date(entryOpenTime).getUTCHours();
  const allowedHours = CFG.allowedHoursUtc ?? [0, 4, 8, 12, 16, 20];
  const hourBlocked = !allowedHours.includes(entryHour);
  if (hourBlocked) {
    result.notes.push(
      `Session filter: entry hour ${entryHour} UTC not in [${allowedHours.join(",")}]`,
    );
  }

  // News filter
  const newsBlocked = isNewsBlackout(entryOpenTime, newsEvents, 2);
  if (newsBlocked) {
    result.notes.push(`News blackout: within 2min of high-impact event`);
  }

  const sharedBlock = blockedByBtcFilter || hourBlocked || newsBlocked;

  // Compute sizing factor once
  const { factor, notes: sizingNotes } = computeSizingFactor(account);
  result.notes.push(...sizingNotes);

  // Per-asset signal check
  const assets = [
    {
      asset: "ETH-MR" as const,
      source: "ETHUSDT" as const,
      candles: ethCandles,
      triggerBars: 2,
      minEqGain: 0,
      baseRisk: 1.0,
    },
    {
      asset: "ETH-PYR" as const,
      source: "ETHUSDT" as const,
      candles: ethCandles,
      triggerBars: 2,
      minEqGain: 0.003,
      baseRisk: 5.0,
    },
    {
      asset: "BTC-MR" as const,
      source: "BTCUSDT" as const,
      candles: btcCandles,
      triggerBars: 1,
      minEqGain: 0.04,
      baseRisk: 0.15,
    },
    {
      asset: "SOL-MR" as const,
      source: "SOLUSDT" as const,
      candles: solCandles,
      triggerBars: 1,
      minEqGain: 0.04,
      baseRisk: 0.15,
    },
  ];

  for (const a of assets) {
    // Check equity gate (delayed assets)
    if (a.minEqGain > 0 && account.equity - 1 < a.minEqGain) {
      result.skipped.push({
        asset: a.asset,
        reason: `equity gate: need +${(a.minEqGain * 100).toFixed(1)}%, at ${((account.equity - 1) * 100).toFixed(2)}%`,
      });
      continue;
    }
    if (sharedBlock) {
      result.skipped.push({
        asset: a.asset,
        reason: "blocked by BTC filter / session / news",
      });
      continue;
    }

    // Signal pattern check
    const hasPattern = hasSignalPattern(a.candles, a.triggerBars, false);
    if (!hasPattern) {
      result.skipped.push({
        asset: a.asset,
        reason: `no ${a.triggerBars}-green sequence`,
      });
      continue;
    }

    // Build signal
    const last = a.candles[a.candles.length - 1];
    const entryPrice = last.close;
    const stopPct = CFG.stopPct;
    const tpPct = CFG.tpPct;
    const stopPrice = entryPrice * (1 + stopPct); // short: stop above entry
    const tpPrice = entryPrice * (1 - tpPct); // short: TP below entry
    const maxHoldHours = CFG.holdBars * 4;

    // Effective risk = baseRisk × sizingFactor × leverage (leverage baked into position sizing)
    const effectiveRiskFrac = a.baseRisk * factor * CFG.leverage;

    result.signals.push({
      assetSymbol: a.asset,
      sourceSymbol: a.source,
      direction: "short",
      entryPrice,
      stopPrice,
      tpPrice,
      stopPct,
      tpPct,
      riskFrac: effectiveRiskFrac,
      sizingFactor: factor,
      maxHoldHours,
      maxHoldUntil: entryOpenTime + maxHoldHours * 3600_000,
      signalBarClose: last.closeTime,
      reasons: [
        `${a.triggerBars}-green pattern on ${a.source}`,
        `equity gate OK (need +${(a.minEqGain * 100).toFixed(1)}%)`,
        `sizing: baseRisk=${a.baseRisk}× × factor=${factor.toFixed(3)} × lev=${CFG.leverage} = ${effectiveRiskFrac.toFixed(4)}`,
      ],
    });
  }

  return result;
}

/** Render a DetectionResult to human-readable text. */
export function renderDetection(r: DetectionResult): string {
  const lines: string[] = [];
  const ts =
    new Date(r.timestamp).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  lines.push(`━━━━━ iter231 Signal Check @ ${ts} ━━━━━`);
  lines.push(
    `BTC: $${r.btc.close.toFixed(0)}  EMA10: $${r.btc.ema10.toFixed(0)}  EMA15: $${r.btc.ema15.toFixed(0)}  24h: ${(r.btc.mom24h * 100).toFixed(2)}%`,
  );
  lines.push(
    `Account: equity=${((r.account.equity - 1) * 100).toFixed(2)}%  day=${r.account.day + 1}/30  recent trades: ${r.account.recentPnls.length}`,
  );
  lines.push("");
  for (const n of r.notes) lines.push(`  ${n}`);
  lines.push("");

  if (r.signals.length === 0) {
    lines.push("⏸  NO SIGNALS");
    for (const s of r.skipped) lines.push(`   ${s.asset}: ${s.reason}`);
  } else {
    lines.push(
      `🚨 ${r.signals.length} SIGNAL${r.signals.length > 1 ? "S" : ""}`,
    );
    for (const s of r.signals) {
      lines.push("");
      lines.push(
        `  ${s.assetSymbol} (${s.sourceSymbol}) — ${s.direction.toUpperCase()}`,
      );
      lines.push(`    Entry: $${s.entryPrice.toFixed(4)}`);
      lines.push(
        `    Stop:  $${s.stopPrice.toFixed(4)} (+${(s.stopPct * 100).toFixed(2)}%)`,
      );
      lines.push(
        `    TP:    $${s.tpPrice.toFixed(4)} (−${(s.tpPct * 100).toFixed(2)}%)`,
      );
      lines.push(`    Risk:  ${(s.riskFrac * 100).toFixed(3)}% of account`);
      lines.push(
        `    Max hold: ${s.maxHoldHours}h (until ${new Date(s.maxHoldUntil).toISOString().slice(0, 16)}Z)`,
      );
    }
  }
  return lines.join("\n");
}
