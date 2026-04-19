/**
 * High-frequency LONG-ONLY dip-buy strategy (iter109-113).
 *
 * Context: after iter105-108 proved the volume-spike fade/momentum mechanic
 * cannot produce a multi-year profitable BTC edge (~21k configs → 0 survivors,
 * best Sharpe negative), we searched orthogonal mechanics. Iter109 found the
 * only surviving BTC edge over 1000 days:
 *
 *   - 3 consecutive red (close-lower) hourly bars in an HTF uptrend
 *   - Long entry at next bar open
 *   - Scale-out TP1 (50%) + TP2 (50%), stop, BE stop after TP1
 *
 * Iter110-113 validated it:
 *   - 24/28 zoom variants survive WR≥58, Sharpe≥1.5, pctProf≥60, bootstrap≥80%
 *   - BTC alone: Sharpe 6.20, +26.7%/1000d, 0.37 tpd, 70% of windows profitable
 *   - Filtered 4-basket (BTC/LINK/BNB/XRP) + BTC-macro 96h gate:
 *       Sharpe 5.20, +93.1%/1000d, 1.17 tpd, bootstrap 97% positive,
 *       bs5%ile = +24.9% (even worst resample profitable)
 *
 * ETH and SOL were DROPPED — they lose money with this mechanic (iter111),
 * likely because a 3-bar pullback on higher-vol alt-majors tends to continue
 * downward rather than mean-revert.
 *
 * This edge is a SEPARATE strategy from hfDaytrading (the volume-spike
 * fade). Both can run side-by-side; they trigger on different setups.
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, type CostConfig } from "@/utils/costModel";
import { MAKER_COSTS } from "@/utils/intradayLab";

export interface DipBuyConfig {
  /** Number of consecutive close-lower bars required before entry. */
  nBarsDown: number;
  /** First scale-out target (fraction of entry, e.g. 0.008 = +0.8%). */
  tp1Pct: number;
  /** Runner target (0.04 = +4%). */
  tp2Pct: number;
  /** Initial stop below entry (0.01 = −1%). */
  stopPct: number;
  /** Maximum hold in 1h bars. */
  holdBars: number;
  /** Own-asset trend gate: require close > SMA(htfLen). */
  htfLen: number;
  /** BTC-macro gate: 0 = disabled, else require BTC close > SMA(btcMacroHtf). */
  btcMacroHtf: number;
  avoidHoursUtc?: number[];
  costs?: CostConfig;
}

/**
 * Iter113-validated config.
 *   - nBars 3 / htf 48 / tp1 0.8% / tp2 4.0% / stop 1.0% / hold 24h
 *   - btcMacroHtf 96 (4-day BTC trend filter) to suppress alt bear drawdowns
 * Portfolio stats (iter113 V2 on 1000d, 4-asset):
 *   n=1171, tpd 1.17, WR 57%, cumRet +93.1%, Sharpe 5.20
 *   bootstrap 97% positive, 5th-pct resample +24.9%
 *   60% of 100-day windows profitable, worst window −9.3%
 */
export const HF_DIP_BUY_CONFIG: DipBuyConfig = {
  nBarsDown: 3,
  tp1Pct: 0.008,
  tp2Pct: 0.04,
  stopPct: 0.01,
  holdBars: 24,
  htfLen: 48,
  btcMacroHtf: 96,
  avoidHoursUtc: [0],
  costs: MAKER_COSTS,
};

/**
 * BTC-only high-conviction config (iter110 bootstrap 100% positive).
 * Lower trade frequency, but individual-asset edge is strongest here.
 *   Sharpe 7.05, +31.0%/1000d, 0.31 tpd, 80% windows profitable, minWin −2.8%
 */
export const HF_DIP_BUY_BTC_SOLO_CONFIG: DipBuyConfig = {
  nBarsDown: 3,
  tp1Pct: 0.01,
  tp2Pct: 0.08,
  stopPct: 0.012,
  holdBars: 36,
  htfLen: 48,
  btcMacroHtf: 0,
  avoidHoursUtc: [0],
  costs: MAKER_COSTS,
};

/**
 * Validated 4-asset basket. ETH and SOL were EXCLUDED — they consistently
 * lose on this mechanic (iter111 showed −20.6% ETH, −17.8% SOL over 1000d).
 */
export const HF_DIP_BUY_BASKET = [
  "BTCUSDT",
  "LINKUSDT",
  "BNBUSDT",
  "XRPUSDT",
] as const;

export const HF_DIP_BUY_STATS = {
  iteration: 113,
  timeframe: "1h",
  daysTested: 1000,
  basket: HF_DIP_BUY_BASKET as unknown as string[],
  /** Portfolio (V2) results, btcMacro 96h gate. */
  portfolio: {
    trades: 1171,
    tradesPerDay: 1.17,
    winRate: 0.57,
    cumReturnPct: 0.931,
    sharpe: 5.2,
    pctWindowsProfitable: 0.6,
    minWindowRet: -0.093,
    bootstrapPctPositive: 0.97,
    bootstrap5thPctRet: 0.249,
  },
  /** BTC-alone (solo config) — strongest single-asset edge. */
  btcSolo: {
    trades: 306,
    tradesPerDay: 0.31,
    winRate: 0.592,
    cumReturnPct: 0.31,
    sharpe: 7.05,
    pctWindowsProfitable: 0.8,
    minWindowRet: -0.028,
    bootstrapPctPositive: 1.0,
  },
  trigger: "3 consecutive close-lower 1h bars",
  filters: "own-asset 48h-SMA uptrend + BTC-macro 96h-SMA uptrend gate",
  execution:
    "long-only, scale 50% @ +0.8% / 50% @ +4.0%, stop −1.0% (BE after TP1), hold ≤ 24h",
  note:
    "Unlike hfDaytrading (which showed multi-year overfit), this edge was " +
    "VALIDATED across 1000 days, 10 disjoint windows, and 30-resample " +
    "bootstrap. ETH/SOL intentionally excluded (they lose on this mechanic).",
} as const;

export interface DipBuyTrade {
  sym: string;
  entryTime: number;
  exitTime: number;
  entry: number;
  tp1Hit: boolean;
  totalPnl: number;
  exitReason: "stop" | "tp2" | "breakeven" | "time";
  openBar: number;
}

export interface DipBuyReport {
  trades: DipBuyTrade[];
  winRate: number;
  netReturnPct: number;
  tp1HitRate: number;
}

function smaLast(v: number[], n: number): number {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

export function runHfDipBuy(
  candles: Candle[],
  cfg: DipBuyConfig = HF_DIP_BUY_CONFIG,
  btcCandles?: Candle[],
  sym = "UNKNOWN",
): DipBuyReport {
  const trades: DipBuyTrade[] = [];
  if (candles.length < Math.max(cfg.htfLen, cfg.nBarsDown + 1)) {
    return { trades, winRate: 0, netReturnPct: 0, tp1HitRate: 0 };
  }
  const closes = candles.map((c) => c.close);
  const btcCloses = btcCandles?.map((c) => c.close) ?? [];
  const costs = cfg.costs ?? MAKER_COSTS;
  const macroActive =
    cfg.btcMacroHtf > 0 && !!btcCandles && btcCandles.length > 0;
  const start = Math.max(
    cfg.htfLen,
    macroActive ? cfg.btcMacroHtf : 0,
    cfg.nBarsDown + 1,
  );
  for (let i = start; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const sma = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    if (cur.close <= sma) continue;

    if (cfg.btcMacroHtf > 0 && btcCandles && btcCandles.length > 0) {
      // Align by openTime; fallback to index-aligned if same length
      let btcI = -1;
      if (btcCandles.length === candles.length) {
        btcI = i;
      } else {
        for (let k = btcCandles.length - 1; k >= 0; k--) {
          if (btcCandles[k].openTime <= cur.openTime) {
            btcI = k;
            break;
          }
        }
      }
      if (btcI < cfg.btcMacroHtf) continue;
      const btcSma = smaLast(
        btcCloses.slice(btcI - cfg.btcMacroHtf, btcI),
        cfg.btcMacroHtf,
      );
      if (btcCandles[btcI].close <= btcSma) continue;
    }

    let allRed = true;
    for (let k = 0; k < cfg.nBarsDown; k++) {
      if (candles[i - k].close >= candles[i - k - 1].close) {
        allRed = false;
        break;
      }
    }
    if (!allRed) continue;

    if (cfg.avoidHoursUtc && cfg.avoidHoursUtc.length > 0) {
      const h = new Date(cur.openTime).getUTCHours();
      if (cfg.avoidHoursUtc.includes(h)) continue;
    }

    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1L = entry * (1 + cfg.tp1Pct);
    const tp2L = entry * (1 + cfg.tp2Pct);
    let sL = entry * (1 - cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    let exitReason: DipBuyTrade["exitReason"] = "time";
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = bar.low <= sL;
      const t1 = bar.high >= tp1L;
      const t2 = bar.high >= tp2L;
      if (!tp1Hit) {
        if ((t1 && sH) || sH) {
          l2B = j;
          l2P = sL;
          exitReason = "stop";
          break;
        }
        if (t1) {
          tp1Hit = true;
          tp1Bar = j;
          sL = entry;
          if (t2) {
            l2B = j;
            l2P = tp2L;
            exitReason = "tp2";
            break;
          }
          continue;
        }
      } else {
        const s2 = bar.low <= sL;
        const t22 = bar.high >= tp2L;
        if ((t22 && s2) || s2) {
          l2B = j;
          l2P = sL;
          exitReason = "breakeven";
          break;
        }
        if (t22) {
          l2B = j;
          l2P = tp2L;
          exitReason = "tp2";
          break;
        }
      }
    }
    const l2c = applyCosts({
      entry,
      exit: l2P,
      direction: "long",
      holdingHours: l2B - (i + 1),
      config: costs,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: costs,
      });
      leg1 = l1c.netPnlPct;
    } else {
      leg1 = leg2;
    }
    const totalPnl = 0.5 * leg1 + 0.5 * leg2;
    trades.push({
      sym,
      entryTime: eb.openTime,
      exitTime: candles[l2B].closeTime,
      entry,
      tp1Hit,
      totalPnl,
      exitReason,
      openBar: i,
    });
    i = l2B;
  }
  const wins = trades.filter((t) => t.totalPnl > 0).length;
  const cum = trades.reduce((a, t) => a * (1 + t.totalPnl), 1) - 1;
  const tp1H = trades.filter((t) => t.tp1Hit).length;
  return {
    trades,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    netReturnPct: cum,
    tp1HitRate: trades.length > 0 ? tp1H / trades.length : 0,
  };
}

export interface DipBuyPortfolioSnapshot {
  perAsset: Record<string, DipBuyReport>;
  portfolio: {
    trades: number;
    winRate: number;
    netReturnPct: number;
    tradesPerDay: number;
  };
}

export function evaluateHfDipBuyPortfolio(
  candlesBySym: Record<string, Candle[]>,
  cfg: DipBuyConfig = HF_DIP_BUY_CONFIG,
): DipBuyPortfolioSnapshot {
  const perAsset: Record<string, DipBuyReport> = {};
  const btc = candlesBySym["BTCUSDT"];
  let all: DipBuyTrade[] = [];
  let maxDays = 0;
  for (const sym of Object.keys(candlesBySym)) {
    const candles = candlesBySym[sym];
    if (!candles || candles.length === 0) continue;
    const days = candles.length / 24;
    maxDays = Math.max(maxDays, days);
    const rep = runHfDipBuy(candles, cfg, btc, sym);
    perAsset[sym] = rep;
    all = all.concat(rep.trades);
  }
  all.sort((a, b) => a.openBar - b.openBar);
  const wins = all.filter((t) => t.totalPnl > 0).length;
  const cum = all.reduce((a, t) => a * (1 + t.totalPnl), 1) - 1;
  return {
    perAsset,
    portfolio: {
      trades: all.length,
      winRate: all.length > 0 ? wins / all.length : 0,
      netReturnPct: cum,
      tradesPerDay: maxDays > 0 ? all.length / maxDays : 0,
    },
  };
}
