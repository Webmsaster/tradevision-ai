import type { Candle } from "@/utils/indicators";
import { loadBinanceHistory } from "@/utils/historicalData";
import {
  runAdvancedBacktest,
  type BacktestReport,
  type StrategyMode,
} from "@/utils/advancedBacktest";
import type { LiveTimeframe } from "@/hooks/useLiveCandles";

export interface MatrixCell {
  symbol: string;
  timeframe: LiveTimeframe;
  mode: StrategyMode;
  candles: number;
  trades: number;
  totalReturnPct: number;
  winRate: number;
  sharpe: number;
  sortino: number;
  profitFactor: number;
  maxDrawdownPct: number;
  verdict:
    | "positive"
    | "low-freq-positive"
    | "marginal"
    | "no-edge"
    | "inconclusive";
}

export interface MatrixRunOptions {
  symbols: string[];
  timeframes: LiveTimeframe[];
  targetCount: number;
  modes?: StrategyMode[];
  onProgress?: (done: number, total: number, currentLabel: string) => void;
}

function verdictFor(report: BacktestReport): MatrixCell["verdict"] {
  const m = report.metrics;
  const pf = m.profitFactor === Infinity ? 999 : m.profitFactor;

  // Low-frequency, high-conviction regime: very few trades, each massive.
  // Documented in Faber 2006, replicated on crypto weeklies.
  if (
    m.trades >= 3 &&
    m.trades < 30 &&
    m.totalReturnPct > 0.5 &&
    pf > 2 &&
    m.sharpe > 2
  ) {
    return "low-freq-positive";
  }

  if (m.trades < 20) return "inconclusive";

  // Standard "positive": conservative risk profile, tight drawdowns.
  if (
    m.totalReturnPct > 0 &&
    pf > 1.3 &&
    m.sharpe > 0.8 &&
    m.maxDrawdownPct < 0.3
  ) {
    return "positive";
  }

  // Crypto-appropriate "positive": accepts up to 50% drawdown if the
  // risk-adjusted performance is strong enough to compensate. Bitcoin itself
  // has repeatedly drawn down 80% in bear cycles, so a strategy with Sharpe>1.5
  // and PF>1.5 but 40% DD is genuinely profitable even though classical
  // thresholds reject it. Calmar (CAGR/MaxDD) > 1 is the research anchor.
  if (
    m.totalReturnPct > 0 &&
    pf > 1.5 &&
    m.sharpe > 1.5 &&
    m.maxDrawdownPct < 0.5 &&
    m.calmar > 1
  ) {
    return "positive";
  }

  if (m.totalReturnPct > 0 && pf > 1) return "marginal";
  return "no-edge";
}

/**
 * Sequentially loads candle history for every (symbol, timeframe) combo and
 * runs the backtest in both regime-switch and ensemble modes. Emits progress
 * via the callback so the UI can show a live counter. Results are returned
 * sorted by Sharpe (descending).
 */
export async function runAutoMatrix({
  symbols,
  timeframes,
  targetCount,
  modes = [
    "regime-switch",
    "ensemble",
    "trend-filter",
    "orb",
    "vwap-reversion",
    "liq-fade",
    "golden-cross",
    "donchian-long",
    "momentum",
  ],
  onProgress,
}: MatrixRunOptions): Promise<MatrixCell[]> {
  const out: MatrixCell[] = [];
  const total = symbols.length * timeframes.length * modes.length;
  let done = 0;

  const historyCache: Record<string, Candle[]> = {};

  for (const symbol of symbols) {
    for (const tf of timeframes) {
      const cacheKey = `${symbol}:${tf}`;
      let history: Candle[];
      if (historyCache[cacheKey]) {
        history = historyCache[cacheKey];
      } else {
        try {
          history = await loadBinanceHistory({
            symbol,
            timeframe: tf,
            targetCount,
          });
          historyCache[cacheKey] = history;
        } catch {
          history = [];
        }
      }

      for (const mode of modes) {
        const label = `${symbol} ${tf} ${mode}`;
        if (history.length < 100) {
          out.push({
            symbol,
            timeframe: tf,
            mode,
            candles: history.length,
            trades: 0,
            totalReturnPct: 0,
            winRate: 0,
            sharpe: 0,
            sortino: 0,
            profitFactor: 0,
            maxDrawdownPct: 0,
            verdict: "inconclusive",
          });
        } else {
          const report = runAdvancedBacktest({
            candles: history,
            timeframe: tf,
            mode,
          });
          out.push({
            symbol,
            timeframe: tf,
            mode,
            candles: history.length,
            trades: report.metrics.trades,
            totalReturnPct: report.metrics.totalReturnPct,
            winRate: report.metrics.winRate,
            sharpe: report.metrics.sharpe,
            sortino: report.metrics.sortino,
            profitFactor:
              report.metrics.profitFactor === Infinity
                ? 999
                : report.metrics.profitFactor,
            maxDrawdownPct: report.metrics.maxDrawdownPct,
            verdict: verdictFor(report),
          });
        }
        done++;
        if (onProgress) onProgress(done, total, label);
        // Let the browser breathe between heavy synchronous backtests
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  out.sort((a, b) => b.sharpe - a.sharpe);
  return out;
}
