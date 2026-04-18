/**
 * High-Confidence Alert Logic.
 *
 * Combines all the system's live intelligence into a single actionable
 * verdict per active signal:
 *
 *   ★★★★★ TAKE-HARD — all five conditions met:
 *     1. Signal fired (champion action != flat)
 *     2. Regime gate ALLOWS this strategy in current regime
 *     3. Strategy health is HEALTHY (recent Sharpe ≥ 0.8× lifetime)
 *     4. Expected edge >= 3 bps after costs
 *     5. Sentiment confluence |score| >= 30 AND same direction as signal
 *
 *   ★★★★ TAKE     — 4/5 conditions met
 *   ★★★  CAUTIOUS — 3/5
 *   ★★   RISKY    — 2/5
 *   ★    SKIP     — <2/5 or any hard-fail
 *
 * Hard-fail (forces SKIP regardless of star count):
 *   - Funding-settle hour (0/8/16 UTC)
 *   - Strategy health = PAUSE
 *   - No signal fired
 *   - Sentiment confluence OPPOSES signal with HIGH confidence
 */

import type {
  ChampionSignal,
  StrategyHealthSnapshot,
  CurrentRegime,
} from "@/utils/liveSignals";
import type { SentimentConfluence } from "@/utils/sentimentConfluence";
import { regimeGate } from "@/utils/regimeGate";

export interface AlertVerdict {
  symbol: string;
  strategy: string;
  action: "long" | "short";
  stars: 0 | 1 | 2 | 3 | 4 | 5;
  verdict: "take-hard" | "take" | "cautious" | "risky" | "skip";
  summary: string;
  conditions: {
    signalFired: boolean;
    regimeAllows: boolean;
    healthyStatus: boolean;
    positiveEdge: boolean;
    confluenceAligned: boolean;
  };
  detail: string[];
}

export function evaluateAlert(
  champion: ChampionSignal,
  healthSnapshots: StrategyHealthSnapshot[],
  regimes: CurrentRegime[],
  confluence?: SentimentConfluence,
): AlertVerdict {
  const strategy = `Champion-${champion.symbol}`;
  const detail: string[] = [];

  // Condition 1: signal fired
  const signalFired = champion.action !== "flat";
  if (signalFired)
    detail.push(`✓ ${champion.action.toUpperCase()} signal fired`);
  else detail.push(`✗ No signal (action=flat)`);

  // Condition 2: regime gate
  const currentRegime = regimes.find((r) => r.symbol === champion.symbol);
  let regimeAllows = false;
  if (currentRegime) {
    const gate = regimeGate(strategy, currentRegime.regime);
    regimeAllows = gate.allowed;
    detail.push(
      regimeAllows
        ? `✓ Regime ${currentRegime.regime} allows ${strategy}`
        : `✗ Regime ${currentRegime.regime} BLOCKS ${strategy}: ${gate.reason.split(":")[1]?.trim() ?? gate.reason}`,
    );
  } else {
    detail.push(`? No regime data for ${champion.symbol}`);
  }

  // Condition 3: health
  const health = healthSnapshots.find(
    (h) => h.symbol === champion.symbol && h.strategy === "Champion",
  );
  let healthyStatus = false;
  if (health) {
    healthyStatus = health.status === "healthy";
    detail.push(
      healthyStatus
        ? `✓ Champion-${champion.symbol} HEALTHY (ratio ${(health.ratio * 100).toFixed(0)}%)`
        : health.status === "watch"
          ? `⚠ Champion-${champion.symbol} WATCH (ratio ${(health.ratio * 100).toFixed(0)}%)`
          : `✗ Champion-${champion.symbol} PAUSE (ratio ${(health.ratio * 100).toFixed(0)}%) — degrading`,
    );
  } else {
    detail.push(`? No health data`);
  }

  // Condition 4: positive net edge
  const positiveEdge = champion.expectedEdgeBps >= 3;
  detail.push(
    positiveEdge
      ? `✓ Expected edge ${champion.expectedEdgeBps.toFixed(1)} bps after costs`
      : `✗ Expected edge ${champion.expectedEdgeBps.toFixed(1)} bps — too thin`,
  );

  // Condition 5: sentiment confluence alignment
  let confluenceAligned = false;
  let confluenceOpposesHard = false;
  if (confluence && signalFired) {
    const absScore = Math.abs(confluence.score);
    const sameDirection =
      (champion.action === "long" && confluence.score > 0) ||
      (champion.action === "short" && confluence.score < 0);
    const oppositeDirection =
      (champion.action === "long" && confluence.score < 0) ||
      (champion.action === "short" && confluence.score > 0);

    if (sameDirection && absScore >= 30) {
      confluenceAligned = true;
      detail.push(
        `✓ Sentiment confluence ${confluence.score > 0 ? "+" : ""}${confluence.score.toFixed(0)} (${confluence.confidence}) aligned with ${champion.action.toUpperCase()}`,
      );
    } else if (
      oppositeDirection &&
      absScore >= 50 &&
      confluence.confidence === "high"
    ) {
      // Hard-fail: confluence strongly opposes signal
      confluenceOpposesHard = true;
      detail.push(
        `✗ HARD-FAIL: confluence ${confluence.score > 0 ? "+" : ""}${confluence.score.toFixed(0)} (HIGH) strongly OPPOSES ${champion.action.toUpperCase()}`,
      );
    } else if (oppositeDirection && absScore >= 30) {
      detail.push(
        `✗ Confluence ${confluence.score > 0 ? "+" : ""}${confluence.score.toFixed(0)} opposes ${champion.action.toUpperCase()}`,
      );
    } else {
      detail.push(
        `~ Confluence ${confluence.score > 0 ? "+" : ""}${confluence.score.toFixed(0)} (${confluence.confidence}) — weak/mixed`,
      );
    }
  } else if (!confluence) {
    detail.push(`? No confluence data`);
  }

  // Funding-hour hard-fail
  const isFundingHour =
    champion.hourUtc === 0 || champion.hourUtc === 8 || champion.hourUtc === 16;
  if (signalFired && isFundingHour) {
    detail.push(
      `✗ HARD-FAIL: funding-settle hour (${champion.hourUtc}:00 UTC)`,
    );
  }

  const conditions = {
    signalFired,
    regimeAllows,
    healthyStatus,
    positiveEdge,
    confluenceAligned,
  };
  const metCount =
    (signalFired ? 1 : 0) +
    (regimeAllows ? 1 : 0) +
    (healthyStatus ? 1 : 0) +
    (positiveEdge ? 1 : 0) +
    (confluenceAligned ? 1 : 0);

  // Hard-fail triggers force SKIP
  const hardFail =
    (signalFired && isFundingHour) ||
    health?.status === "pause" ||
    !signalFired ||
    confluenceOpposesHard;

  let stars: AlertVerdict["stars"];
  let verdict: AlertVerdict["verdict"];
  let summary: string;
  if (hardFail) {
    stars = 0;
    verdict = "skip";
    summary = !signalFired
      ? "No active signal this hour"
      : isFundingHour
        ? "Funding-hour — toxic flow risk, skip"
        : confluenceOpposesHard
          ? "Sentiment confluence strongly opposes — skip"
          : "Strategy in PAUSE — skip until health recovers";
  } else if (metCount === 5) {
    stars = 5;
    verdict = "take-hard";
    summary = `★★★★★ All 5 conditions met — HIGH-CONVICTION ${champion.action.toUpperCase()} at ${champion.entryPrice.toFixed(2)}`;
  } else if (metCount === 4) {
    stars = 4;
    verdict = "take";
    summary = `★★★★ 4/5 conditions — take the ${champion.action.toUpperCase()} at ${champion.entryPrice.toFixed(2)}`;
  } else if (metCount === 3) {
    stars = 3;
    verdict = "cautious";
    summary = `★★★ 3/5 conditions — size down, half position`;
  } else if (metCount === 2) {
    stars = 2;
    verdict = "risky";
    summary = `★★ Only 2/5 conditions — skip unless strong conviction`;
  } else {
    stars = metCount === 1 ? 1 : 0;
    verdict = "skip";
    summary = `Insufficient conditions (${metCount}/5) — skip`;
  }

  return {
    symbol: champion.symbol,
    strategy,
    action: champion.action === "flat" ? "long" : champion.action,
    stars,
    verdict,
    summary,
    conditions,
    detail,
  };
}

export function evaluateAllAlerts(
  champions: ChampionSignal[],
  healthSnapshots: StrategyHealthSnapshot[],
  regimes: CurrentRegime[],
  confluence?: SentimentConfluence,
): AlertVerdict[] {
  return champions.map((c) =>
    evaluateAlert(c, healthSnapshots, regimes, confluence),
  );
}
