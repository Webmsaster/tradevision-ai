/**
 * High-Confidence Alert Logic.
 *
 * Combines all the system's live intelligence into a single actionable
 * verdict per active signal:
 *
 *   ★★★ TAKE IT — all four conditions met:
 *     1. Signal fired (champion action != flat)
 *     2. Regime gate ALLOWS this strategy in current regime
 *     3. Strategy health is HEALTHY (recent Sharpe ratio ≥ 0.8× lifetime)
 *     4. Expected edge >= 3 bps after costs
 *
 *   ★★  CAUTIOUS — 3/4 conditions met
 *   ★   RISKY   — 2/4
 *   ✗   SKIP    — <2/4 or any hard-fail (funding hour, PAUSE status, regime mismatch)
 */

import type {
  ChampionSignal,
  StrategyHealthSnapshot,
  CurrentRegime,
} from "@/utils/liveSignals";
import { regimeGate } from "@/utils/regimeGate";

export interface AlertVerdict {
  symbol: string;
  strategy: string;
  action: "long" | "short";
  stars: 0 | 1 | 2 | 3;
  verdict: "take" | "cautious" | "risky" | "skip";
  summary: string;
  conditions: {
    signalFired: boolean;
    regimeAllows: boolean;
    healthyStatus: boolean;
    positiveEdge: boolean;
  };
  detail: string[];
}

export function evaluateAlert(
  champion: ChampionSignal,
  healthSnapshots: StrategyHealthSnapshot[],
  regimes: CurrentRegime[],
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
  };
  const metCount =
    (signalFired ? 1 : 0) +
    (regimeAllows ? 1 : 0) +
    (healthyStatus ? 1 : 0) +
    (positiveEdge ? 1 : 0);

  // Hard-fail if signal fires in funding hour OR health is PAUSE
  const hardFail =
    (signalFired && isFundingHour) ||
    health?.status === "pause" ||
    !signalFired;

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
        : "Strategy in PAUSE — skip until health recovers";
  } else if (metCount === 4) {
    stars = 3;
    verdict = "take";
    summary = `★★★ All 4 conditions met — take the ${champion.action.toUpperCase()} at ${champion.entryPrice.toFixed(2)}`;
  } else if (metCount === 3) {
    stars = 2;
    verdict = "cautious";
    summary = `★★ 3/4 conditions — size down, consider half position`;
  } else if (metCount === 2) {
    stars = 1;
    verdict = "risky";
    summary = `★ Only 2/4 conditions — skip unless strong conviction`;
  } else {
    stars = 0;
    verdict = "skip";
    summary = `Insufficient conditions (${metCount}/4) — skip`;
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
): AlertVerdict[] {
  return champions.map((c) => evaluateAlert(c, healthSnapshots, regimes));
}
