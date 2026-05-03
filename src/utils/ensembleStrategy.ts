import type { Candle } from "@/utils/indicators";
import { ema, rsi, macd, adx, atr } from "@/utils/indicators";
import { bollingerBands } from "@/utils/marketStructure";
import type { StrategyDecision, StrategyConfig } from "@/utils/strategies";
import { DEFAULT_STRATEGY_CONFIG } from "@/utils/strategies";

/**
 * Ensemble voting strategy. Research: classic TA signals individually are
 * weak (Park/Irwin 2007), but the *intersection* of independent signals
 * meaningfully improves win-rate. We require a configurable minimum of
 * independent voters to agree before the ensemble issues a trade.
 *
 * Voters (all free, classic, public):
 *  1. EMA fast/slow relationship
 *  2. MACD histogram sign + slope
 *  3. RSI above/below 50 (trend bias)
 *  4. ADX trend-strength filter (votes flat if ADX < threshold)
 *  5. Bollinger Band position (price above upper = bullish continuation bias)
 *  6. Volume: current candle vs 20-bar SMA
 */

export interface EnsembleVote {
  name: string;
  vote: "long" | "short" | "abstain";
  reason: string;
}

export interface EnsembleDecision extends StrategyDecision {
  votes: EnsembleVote[];
  agreeCount: number;
  requiredAgreement: number;
}

export function ensembleStrategy(
  candles: Candle[],
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  requiredAgreement = 4,
): EnsembleDecision {
  const flat: EnsembleDecision = {
    action: "flat",
    strategy: "trend-follow",
    stopDistance: null,
    targetDistance: null,
    notes: [],
    votes: [],
    agreeCount: 0,
    requiredAgreement,
  };
  if (candles.length < Math.max(cfg.emaSlow, cfg.adxPeriod * 2 + 5))
    return flat;

  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const i = candles.length - 1;

  const emaFast = ema(closes, cfg.emaFast)[i];
  const emaSlow = ema(closes, cfg.emaSlow)[i];
  const rsiNow = rsi(closes, cfg.rsiPeriod)[i];
  const m = macd(closes, 12, 26, 9);
  const histNow = m.histogram[i];
  const histPrev = m.histogram[i - 1];
  const adxArr = adx(candles, cfg.adxPeriod);
  const adxNow = adxArr.adx[i];
  const bb = bollingerBands(closes, cfg.bbPeriod, cfg.bbStdDev);
  const bbUpper = bb.upper[i];
  const bbLower = bb.lower[i];
  const atrNow = atr(candles, cfg.atrPeriod)[i];
  const priceNow = closes[i];
  const volNow = vols[i];
  const volAvg =
    vols.slice(-20).reduce((s, v) => s + v, 0) / Math.min(vols.length, 20);

  const votes: EnsembleVote[] = [];
  const pushVote = (name: string, vote: EnsembleVote["vote"], reason: string) =>
    votes.push({ name, vote, reason });

  // 1. EMA
  if (emaFast !== null && emaSlow !== null) {
    if (emaFast! > emaSlow! * 1.0005)
      pushVote(
        "EMA",
        "long",
        `Fast ${emaFast!.toFixed(2)} > slow ${emaSlow!.toFixed(2)}`,
      );
    else if (emaFast! < emaSlow! * 0.9995)
      pushVote(
        "EMA",
        "short",
        `Fast ${emaFast!.toFixed(2)} < slow ${emaSlow!.toFixed(2)}`,
      );
    else pushVote("EMA", "abstain", "EMAs nearly equal");
  } else pushVote("EMA", "abstain", "Not enough data");

  // 2. MACD
  if (histNow !== null && histPrev !== null) {
    if (histNow! > 0 && histNow! > histPrev!)
      pushVote("MACD", "long", "Hist positive and rising");
    else if (histNow! < 0 && histNow! < histPrev!)
      pushVote("MACD", "short", "Hist negative and falling");
    else pushVote("MACD", "abstain", "Mixed MACD");
  } else pushVote("MACD", "abstain", "Not enough data");

  // 3. RSI
  if (rsiNow !== null) {
    if (rsiNow! >= 55) pushVote("RSI", "long", `${rsiNow!.toFixed(1)} > 55`);
    else if (rsiNow! <= 45)
      pushVote("RSI", "short", `${rsiNow!.toFixed(1)} < 45`);
    else pushVote("RSI", "abstain", `${rsiNow!.toFixed(1)} neutral`);
  } else pushVote("RSI", "abstain", "Not enough data");

  // 4. ADX strength filter
  if (adxNow !== null) {
    if (adxNow! >= cfg.adxTrendThreshold) {
      pushVote(
        "ADX",
        "abstain",
        `Trend strength ${adxNow!.toFixed(1)} (filter ok)`,
      );
    } else {
      // Ranging regime: force everyone to abstain
      return {
        ...flat,
        votes: [
          ...votes,
          {
            name: "ADX",
            vote: "abstain",
            reason: `Weak trend ${adxNow!.toFixed(1)} — ensemble suppressed`,
          },
        ],
        notes: [
          `ADX ${adxNow!.toFixed(1)} below ${cfg.adxTrendThreshold}: ranging regime, ensemble abstains`,
        ],
      };
    }
  } else pushVote("ADX", "abstain", "Not enough data");

  // 5. Bollinger Band position
  if (bbUpper !== null && bbLower !== null) {
    if (priceNow! > bbUpper!)
      pushVote("BB", "long", "Price above upper band (continuation bias)");
    else if (priceNow! < bbLower!)
      pushVote("BB", "short", "Price below lower band");
    else pushVote("BB", "abstain", "Inside bands");
  } else pushVote("BB", "abstain", "Not enough data");

  // 6. Volume
  if (volAvg > 0 && volNow! > volAvg * 1.2) {
    // Volume confirms whatever direction the other voters are leaning
    const netLongs = votes.filter((v) => v.vote === "long").length;
    const netShorts = votes.filter((v) => v.vote === "short").length;
    if (netLongs > netShorts)
      pushVote(
        "Volume",
        "long",
        `${((volNow! / volAvg - 1) * 100).toFixed(0)}% above avg, confirming longs`,
      );
    else if (netShorts > netLongs)
      pushVote(
        "Volume",
        "short",
        `${((volNow! / volAvg - 1) * 100).toFixed(0)}% above avg, confirming shorts`,
      );
    else pushVote("Volume", "abstain", "Above-avg volume, no clear direction");
  } else pushVote("Volume", "abstain", "Volume below 120% of avg");

  const longVotes = votes.filter((v) => v.vote === "long").length;
  const shortVotes = votes.filter((v) => v.vote === "short").length;

  let action: "long" | "short" | "flat" = "flat";
  let agreeCount = 0;
  if (longVotes >= requiredAgreement && longVotes > shortVotes) {
    action = "long";
    agreeCount = longVotes;
  } else if (shortVotes >= requiredAgreement && shortVotes > longVotes) {
    action = "short";
    agreeCount = shortVotes;
  }

  if (action === "flat" || atrNow === null) {
    return { ...flat, votes, agreeCount };
  }

  return {
    action,
    strategy: "trend-follow",
    stopDistance: atrNow! * cfg.stopAtrMult,
    targetDistance: atrNow! * cfg.targetAtrMult,
    notes: votes
      .filter((v) => v.vote === action)
      .map((v) => `${v.name}: ${v.reason}`),
    votes,
    agreeCount,
    requiredAgreement,
  };
}
