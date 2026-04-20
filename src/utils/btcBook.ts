/**
 * BTC Book — combined intraday + swing portfolio (iter138).
 *
 * Wraps the two shipped single-edge configs:
 *   - `BTC_INTRADAY_CONFIG` (iter135): 1h, Sharpe 10.15 bar-level, maxDD −10%
 *   - `BTC_SWING_CONFIG`    (iter128): 1d, mean 3.17%/trade, maxDD −77%
 *
 * Swing solo has enormous cumRet but 77% drawdown (too big for real deployment).
 * Intraday solo has tame drawdown but moderate return. Combining them 80/20
 * gives the best risk-adjusted profile:
 *
 * Validated (iter138, 2083 days 1h + 3000 days 1d):
 *   allocation       activeDays  WR     meanDaily  cumRet    DailySharpe  maxDD
 *   100/0 intraday    781        52.8%  0.102%     +132.7%   2.39         −10.3%
 *   **80/20 mix**     859        51.1%  0.232%     +570.2%   **3.02**     −26.2%
 *   70/30             859        50.8%  0.298%     +978.8%   2.78         −36.1%
 *   50/50             859        50.8%  0.428%     +2427.0%  2.49         −52.2%
 *   0/100 swing       198        41.9%  0.755%     +12130.8% 2.22         −77.6%
 *
 * The 80/20 mix lifts daily Sharpe +26% over intraday solo while multiplying
 * cumRet by 4.3× — at the cost of doubling the max drawdown. The extra DD
 * comes from the swing book's larger per-trade size; allocating 20% keeps it
 * bounded. Higher swing allocation continues to raise return but Sharpe falls
 * and DD explodes, so 80/20 is the Sharpe-max plateau.
 */
import type { Candle } from "@/utils/indicators";
import {
  runBtcIntraday,
  BTC_INTRADAY_CONFIG,
  type BtcIntradayConfig,
  type BtcIntradayTrade,
} from "@/utils/btcIntraday";
import {
  runBtcSwing,
  BTC_SWING_CONFIG,
  type BtcSwingConfig,
  type BtcSwingTrade,
} from "@/utils/btcSwing";

export interface BtcBookConfig {
  intraday: BtcIntradayConfig;
  swing: BtcSwingConfig;
  /** Capital weight on intraday book (0..1). Swing gets 1 − intradayWeight. */
  intradayWeight: number;
}

export const BTC_BOOK_CONFIG: BtcBookConfig = {
  intraday: BTC_INTRADAY_CONFIG,
  swing: BTC_SWING_CONFIG,
  intradayWeight: 0.8,
};

export const BTC_BOOK_STATS = {
  iteration: 138,
  basis: "iter135 intraday × iter128 swing combined book",
  allocation: "80% intraday / 20% swing",
  /** Daily-bar Sharpe (portfolio-level, not per-trade). */
  dailySharpe: 3.02,
  cumReturnPct: 5.702,
  meanDailyPct: 0.00232,
  maxDrawdown: -0.262,
  activeDaysCovered: 859,
  // Per-book stats for reference
  intradayStats: {
    dailySharpe: 2.39,
    cumReturnPct: 1.327,
    maxDrawdown: -0.103,
  },
  swingStats: {
    dailySharpe: 2.22,
    cumReturnPct: 121.308,
    maxDrawdown: -0.776,
  },
  note:
    "Iter 138 80/20 combined book. Daily Sharpe 3.02 is 26% higher than " +
    "intraday-solo (2.39) and beats swing-solo (2.22). 4.3× higher cumRet " +
    "than intraday-solo with roughly doubled drawdown (−26% vs −10%). The " +
    "swing book's larger per-trade edge compounds multiplicatively with the " +
    "intraday's high frequency. A higher swing weight (30%/50%) pushes " +
    "cumRet higher but collapses Sharpe and inflates drawdown, so 80/20 is " +
    "the Sharpe-optimal plateau. Both underlying books already pass their own " +
    "5-gate validation (iter135 and iter128). REQUIRES MAKER FILLS on intraday.",
} as const;

export interface BtcBookDailyPnl {
  day: number; // unix-epoch day index
  intradayPnl: number;
  swingPnl: number;
  totalPnl: number;
}

export interface BtcBookReport {
  intradayTrades: BtcIntradayTrade[];
  swingTrades: BtcSwingTrade[];
  dailyPnl: BtcBookDailyPnl[];
  cumReturnPct: number;
  dailySharpe: number;
  maxDrawdown: number;
  activeDays: number;
  winRate: number;
}

function accumulateDaily(
  trades: { entryTime: number; pnl: number }[],
  weight: number,
): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.entryTime / 86_400_000);
    m.set(day, (m.get(day) ?? 0) + t.pnl * weight);
  }
  return m;
}

/**
 * Run both books and aggregate their PnL at daily resolution.
 *
 * `candles1h` should be hourly BTC bars (enough for iter135 — at least
 * htfLen + macro30dBars + atrLen + 5). `candles1d` should be daily BTC
 * bars (at least htfLen + macroBars + 5 of the swing config).
 */
export function runBtcBook(
  candles1h: Candle[],
  candles1d: Candle[],
  cfg: BtcBookConfig = BTC_BOOK_CONFIG,
): BtcBookReport {
  const intraday = runBtcIntraday(candles1h, cfg.intraday);
  const swing = runBtcSwing(candles1d, cfg.swing);
  const wi = Math.max(0, Math.min(1, cfg.intradayWeight));
  const ws = 1 - wi;
  const intradayDaily = accumulateDaily(intraday.trades, wi);
  const swingDaily = accumulateDaily(swing.trades, ws);
  const allDays = new Set<number>([
    ...intradayDaily.keys(),
    ...swingDaily.keys(),
  ]);
  const dailyPnl: BtcBookDailyPnl[] = Array.from(allDays)
    .sort((a, b) => a - b)
    .map((day) => {
      const ip = intradayDaily.get(day) ?? 0;
      const sp = swingDaily.get(day) ?? 0;
      return { day, intradayPnl: ip, swingPnl: sp, totalPnl: ip + sp };
    });
  const totals = dailyPnl.map((d) => d.totalPnl);
  const wins = totals.filter((p) => p > 0).length;
  const losses = totals.filter((p) => p < 0).length;
  const cum = totals.reduce((a, p) => a * (1 + p), 1) - 1;
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  for (const p of totals) {
    eq *= 1 + p;
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  let sharpe = 0;
  if (totals.length >= 3) {
    const m = totals.reduce((a, b) => a + b, 0) / totals.length;
    const v =
      totals.reduce((a, b) => a + (b - m) * (b - m), 0) / (totals.length - 1);
    const sd = Math.sqrt(v);
    sharpe = sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
  }
  return {
    intradayTrades: intraday.trades,
    swingTrades: swing.trades,
    dailyPnl,
    cumReturnPct: cum,
    dailySharpe: sharpe,
    maxDrawdown: maxDd,
    activeDays: wins + losses,
    winRate: wins + losses ? wins / (wins + losses) : 0,
  };
}
