import type { SignalSnapshot } from "@/utils/signalEngine";
import type {
  MarketStructure,
  KeyLevels,
  SetupClassification,
  BaseRate,
} from "@/utils/marketStructure";

export interface ThesisInputs {
  symbol: string;
  timeframe: string;
  snapshot: SignalSnapshot;
  gatedAction: "long" | "short" | "flat";
  consensusConfidence: number;
  structure: MarketStructure;
  keyLevels: KeyLevels;
  setup: SetupClassification;
  baseRate: BaseRate | null;
  vwap: number | null;
  bbWidthPct: number | null;
  atrPercentile: number | null;
}

export interface TradeThesis {
  headline: string;
  context: string;
  setup: string;
  execution: string;
  invalidation: string;
  counterArguments: string[];
}

function fmt(v: number | null, digits = 2): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDirection(action: "long" | "short" | "flat"): string {
  return action === "long"
    ? "long"
    : action === "short"
      ? "short"
      : "sidelined";
}

/**
 * Builds a structured trade thesis from the current market state. Output is
 * five paragraphs + a counter-argument list; the UI formats this as readable
 * copy so the user sees *reasoning*, not a binary BUY/SELL.
 */
export function buildThesis(inputs: ThesisInputs): TradeThesis {
  const {
    symbol,
    timeframe,
    snapshot,
    gatedAction,
    consensusConfidence,
    structure,
    keyLevels,
    setup,
    baseRate,
    vwap,
    bbWidthPct,
    atrPercentile,
  } = inputs;

  const price = snapshot.price;
  // formatDirection result kept available via _actionWord; not currently
  // rendered into the narrative copy but referenced as side-effect anchor.
  const _actionWord = formatDirection(gatedAction);
  void _actionWord;
  const structureWord =
    structure.state === "bullish"
      ? "bullish (higher highs + higher lows)"
      : structure.state === "bearish"
        ? "bearish (lower highs + lower lows)"
        : "undetermined";

  const eventWord =
    structure.lastEvent === "none"
      ? "no structural break"
      : structure.lastEvent.replace("-", " ");

  const vwapRel =
    vwap === null
      ? "VWAP data unavailable"
      : price > vwap
        ? `price is above VWAP (${fmt(vwap)}), which buyers defend intraday`
        : `price is below VWAP (${fmt(vwap)}), which sellers defend intraday`;

  const volContext =
    bbWidthPct === null
      ? ""
      : bbWidthPct < 2
        ? " Volatility is compressed — expect a sharp expansion move soon."
        : bbWidthPct > 6
          ? " Volatility is elevated — be mindful of slippage and whipsaw."
          : "";

  const atrContext =
    atrPercentile === null
      ? ""
      : atrPercentile > 0.75
        ? " ATR is in the top quartile of recent history (volatile regime)."
        : atrPercentile < 0.25
          ? " ATR is in the bottom quartile (quiet regime; breakouts can fail)."
          : "";

  const headline =
    gatedAction === "flat"
      ? `${symbol} ${timeframe}: stand aside — no actionable setup`
      : `${symbol} ${timeframe}: ${gatedAction === "long" ? "long" : "short"} thesis @ ${fmt(price)} (${consensusConfidence}% confidence)`;

  const context = [
    `Market structure is ${structureWord}; the last structural event was "${eventWord}".`,
    `${vwapRel}.`,
    volContext + atrContext,
    keyLevels.nearestSupport !== null
      ? `Nearest support sits at ${fmt(keyLevels.nearestSupport)} (${fmt(keyLevels.distanceToSupportPct ?? 0)}% below).`
      : "",
    keyLevels.nearestResistance !== null
      ? `Nearest resistance sits at ${fmt(keyLevels.nearestResistance)} (${fmt(keyLevels.distanceToResistancePct ?? 0)}% above).`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const setupPara = `Setup classified as **${setup.type}**: ${setup.description} ${setup.playbook}`;

  let executionPara: string;
  if (gatedAction === "flat") {
    executionPara =
      "No trade. Wait for a clear setup: either a break of structure in a new direction, or a clean retest of a key level with signal alignment.";
  } else if (snapshot.levels) {
    executionPara = `Suggested plan: enter around ${fmt(snapshot.levels.entry)}, stop at ${fmt(snapshot.levels.stopLoss)} (2×ATR = about ${fmt(snapshot.indicators.atr)} distance), target ${fmt(snapshot.levels.takeProfit)} (3×ATR) for a 1:${snapshot.levels.riskReward.toFixed(2)} R:R. Size the position so a full stop is ≤1% of your account.`;
  } else {
    executionPara =
      "ATR-based stop/target data is not yet available — wait for the next closed candle.";
  }

  let invalidationPara: string;
  if (gatedAction === "long") {
    const inv = structure.lastSwingLow ?? snapshot.levels?.stopLoss ?? null;
    invalidationPara = inv
      ? `The thesis is invalidated on a decisive close below ${fmt(inv)}. If that breaks, structure flips and the next higher-probability direction is short.`
      : "Thesis invalidation level is not yet computable.";
  } else if (gatedAction === "short") {
    const inv = structure.lastSwingHigh ?? snapshot.levels?.stopLoss ?? null;
    invalidationPara = inv
      ? `The thesis is invalidated on a decisive close above ${fmt(inv)}. If that breaks, structure flips and the next higher-probability direction is long.`
      : "Thesis invalidation level is not yet computable.";
  } else {
    invalidationPara =
      "With no active trade there is no specific invalidation level — continue monitoring for a structural break.";
  }

  const counterArguments: string[] = [];
  if (gatedAction !== "flat") {
    if (snapshot.regime === "ranging") {
      counterArguments.push(
        "ADX flags the market as ranging — trend-following signals fail more often here.",
      );
    }
    if (snapshot.indicators.rsi !== null) {
      if (gatedAction === "long" && snapshot.indicators.rsi > 70) {
        counterArguments.push(
          `RSI ${snapshot.indicators.rsi.toFixed(1)} is overbought — higher risk of short-term mean reversion before continuation.`,
        );
      } else if (gatedAction === "short" && snapshot.indicators.rsi < 30) {
        counterArguments.push(
          `RSI ${snapshot.indicators.rsi.toFixed(1)} is oversold — expect bounces that could stop you out before the move continues.`,
        );
      }
    }
    if (baseRate && baseRate.samples < 20) {
      counterArguments.push(
        `Base rate sample is small (n=${baseRate.samples}); historical win rate ${Math.round(baseRate.winRate * 100)}% has a wide confidence band (${Math.round(baseRate.confidenceLower * 100)}-${Math.round(baseRate.confidenceUpper * 100)}%).`,
      );
    }
    if (baseRate && baseRate.winRate < 0.4) {
      counterArguments.push(
        `Historically this exact setup only hit target ${Math.round(baseRate.winRate * 100)}% of the time on this pair — consider reducing size.`,
      );
    }
    if (bbWidthPct !== null && bbWidthPct < 1.5) {
      counterArguments.push(
        "Bollinger-Band width is unusually low — breakouts from this regime often fail before succeeding.",
      );
    }
  }
  if (counterArguments.length === 0) {
    counterArguments.push(
      "No obvious counter-arguments flagged by the engine — but that does not mean they don't exist. Scan the chart manually before committing.",
    );
  }

  return {
    headline,
    context,
    setup: setupPara,
    execution: executionPara,
    invalidation: invalidationPara,
    counterArguments,
  };
}

/**
 * Computes the percentile rank of the latest ATR value within the last N
 * readings. Used to communicate whether the current volatility regime is
 * unusual (quiet or loud) relative to recent history.
 */
export function atrPercentile(
  atrSeries: (number | null)[],
  lookback = 100,
): number | null {
  const slice = atrSeries
    .slice(-lookback)
    .filter((v): v is number => v !== null);
  if (slice.length < 20) return null;
  const current = slice[slice.length - 1];
  const smaller = slice.filter((v) => v < current).length;
  return smaller / slice.length;
}
