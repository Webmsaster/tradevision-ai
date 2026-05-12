/**
 * FTMO Config Validator (R29 Round 3 audit-fix Bug #3).
 *
 * Hard-fails at module load when a config selected for live-deployment is
 * missing FTMO-realistic safety fields. Per CLAUDE.md:
 *
 *   "Engine fields `pauseAtTargetReached: true` + `atrStop` +
 *    `liveCaps {maxStopPct: 0.05, maxRiskFrac: 0.4}` are mandatory for
 *    FTMO-realistic backtests. `minTradingDays: 4` (real FTMO 2-Step rule)."
 *
 * Without this guard, a typo or forgotten field silently degrades pass-rate
 * by 20-40pp live (V12_30M_OPT debunk 2026-05-08 = 0/140 = 0% with caps).
 */
import type { FtmoDaytrade24hConfig } from "./ftmoDaytrade24h";

/**
 * Validate an FTMO config against the mandatory safety constraints.
 *
 * Throws `Error` with a precise diagnostic when any rule fails. Returns
 * silently when all checks pass.
 *
 * Rules (all live-deployment configs MUST satisfy these):
 *   - `pauseAtTargetReached: true` — stop adding risk once profit-target hit
 *   - `atrStop` defined (period + stopMult) — volatility-adaptive stop floor
 *   - `liveCaps.maxStopPct <= 0.05` — hard cap on per-trade stop distance
 *   - `liveCaps.maxRiskFrac <= 0.4` — hard cap on engine-riskFrac exposure
 *   - `minTradingDays >= 4` — real FTMO 2-Step rule (Step 2 = 4 days)
 *
 * Optional escape hatch: set `FTMO_ALLOW_UNSAFE_CONFIG=1` to skip — used by
 * backtest/research scripts that intentionally bypass live caps.
 *
 * @param cfg The config object to validate
 * @param label Human-readable name used in error messages (e.g. CFG_LABEL)
 */
export function assertConfigValid(
  cfg: FtmoDaytrade24hConfig,
  label: string,
): void {
  if (process.env.FTMO_ALLOW_UNSAFE_CONFIG === "1") return;

  const violations: string[] = [];

  if (cfg.pauseAtTargetReached !== true) {
    violations.push(
      `pauseAtTargetReached must be true (got ${cfg.pauseAtTargetReached}) — ` +
        `without it the bot keeps adding risk after the profit-target is hit, ` +
        `causing give_back failures.`,
    );
  }

  if (!cfg.atrStop || typeof cfg.atrStop.stopMult !== "number") {
    violations.push(
      `atrStop must be defined with {period, stopMult} — volatility-adaptive ` +
        `stop is mandatory for FTMO-realistic backtests.`,
    );
  }

  if (!cfg.liveCaps) {
    violations.push(
      `liveCaps must be defined as {maxStopPct, maxRiskFrac} — without it ` +
        `the engine reports a backtest pass-rate that is unreachable live.`,
    );
  } else {
    if (cfg.liveCaps.maxStopPct > 0.05) {
      violations.push(
        `liveCaps.maxStopPct=${cfg.liveCaps.maxStopPct} exceeds 0.05 ` +
          `(FTMO daily-loss is 5% — wider stops will breach the limit).`,
      );
    }
    if (cfg.liveCaps.maxRiskFrac > 0.4) {
      violations.push(
        `liveCaps.maxRiskFrac=${cfg.liveCaps.maxRiskFrac} exceeds 0.4 ` +
          `(at 5% stop × 2× leverage that maps to 4% live loss per trade).`,
      );
    }
  }

  if (typeof cfg.minTradingDays !== "number" || cfg.minTradingDays < 4) {
    violations.push(
      `minTradingDays=${cfg.minTradingDays} must be >= 4 (real FTMO 2-Step ` +
        `rule — Step 2 requires 4 trading days).`,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `[ftmoConfigValidator] Config "${label}" is NOT live-deployable:\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        `\nSet FTMO_ALLOW_UNSAFE_CONFIG=1 to bypass (research/backtest only).`,
    );
  }
}
