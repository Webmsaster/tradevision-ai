/**
 * 2026-05-15 RegimeConfluence voter orchestrator (MVP — Top-5 voters only).
 *
 * Mirrors the consensus-tally logic in
 * `engine-rust/ftmo-engine-core/src/signals_regime_confluence.rs::detect_regime_confluence`
 * for the 5 highest-impact voters (per memory's solo-voter ablation):
 *
 *   1. POC-Z          — multi-bar volume-profile z-score
 *   2. BB-Z-Score MR  — Bollinger-band mean-reversion z-extreme
 *   3. Supertrend     — ATR-band trend direction
 *   4. SMC FVG        — 3-bar fair-value-gap retest
 *   5. HMM regime     — 3-state Gaussian regime classifier
 *
 * The 18 other voters (OFI, CMF, RSI-Hidden-Div, AD-Line, Aroon, Double-Top,
 * Kalman, Stop-Hunt, CB-Premium, CME-Basis, NUPL, Top-Trader-LS,
 * Stablecoin-Flow, VWAP-trend, Vol-confirm, etc.) are deferred — they showed
 * low solo-impact in the ablation and increase porting surface without
 * proportional gain. The Top-3 anchors (R28V6, Breakout, MeanRev) are
 * already in the TS V4 engine via `detectAsset`.
 *
 * Consensus rule:
 *   - Each voter casts long / short / abstain.
 *   - Count directional votes; strict majority (>) required; tie → null.
 *   - winningCount must ≥ minVotes.
 *   - When `requireR28v6 = true`, the winning side must include the
 *     R28V6 vote (passed in via `r28v6Vote` parameter — the live engine
 *     supplies this from `detectAsset` results).
 */
import type { Candle } from "@/utils/indicators";

import {
  computeBbZScoreVote,
  defaultBbZScoreSource,
  type BollingerZScoreSource,
} from "./bbZScoreMr";
import {
  computeHmmRegimeVote,
  defaultBtc30mModel,
  defaultHmmRegimeParams,
  type HmmModel,
  type HmmRegimeParams,
} from "./hmmRegime";
import { computePocZVote, defaultPocZParams, type PocZParams } from "./pocZ";
import { computeSmcFvgVote, defaultFvgParams, type FvgParams } from "./smcFvg";
import {
  computeSupertrendVote,
  defaultSupertrendParams,
  type SupertrendParams,
} from "./supertrend";
import type { VoterSide } from "./types";

export type { VoterSide };
export {
  computeBbZScoreVote,
  defaultBbZScoreSource,
  type BollingerZScoreSource,
  computeHmmRegimeVote,
  defaultBtc30mModel,
  defaultHmmRegimeParams,
  type HmmModel,
  type HmmRegimeParams,
  computePocZVote,
  defaultPocZParams,
  type PocZParams,
  computeSmcFvgVote,
  defaultFvgParams,
  type FvgParams,
  computeSupertrendVote,
  defaultSupertrendParams,
  type SupertrendParams,
};

/** Switch-flags for which voters participate in a given consensus run. */
export interface RegimeConfluenceVoterFlags {
  usePocZ?: boolean;
  pocZParams?: Partial<PocZParams>;
  useBbZMr?: boolean;
  bbZParams?: Partial<BollingerZScoreSource>;
  useSupertrend?: boolean;
  supertrendParams?: Partial<SupertrendParams>;
  useSmcFvg?: boolean;
  smcFvgParams?: Partial<FvgParams>;
  useHmm?: boolean;
  hmmParams?: Partial<HmmRegimeParams>;
  hmmModel?: HmmModel;
}

export interface RegimeConfluenceParams {
  /** Strict-majority threshold: winningCount must ≥ minVotes (and > losing). */
  minVotes: number;
  /** When true, winning side must contain the R28V6 vote (passed externally). */
  requireR28v6: boolean;
  voters: RegimeConfluenceVoterFlags;
}

export function defaultRegimeConfluenceParams(): RegimeConfluenceParams {
  return {
    minVotes: 2,
    requireR28v6: false,
    voters: {
      usePocZ: false,
      useBbZMr: false,
      useSupertrend: false,
      useSmcFvg: false,
      useHmm: false,
    },
  };
}

export interface RegimeConfluenceTally {
  longVotes: number;
  shortVotes: number;
  votesByName: Record<string, VoterSide>;
  /**
   * Final consensus side ('long' | 'short' | null). Reflects strict-majority
   * + minVotes threshold + requireR28v6 gate.
   */
  consensus: VoterSide;
}

/**
 * Tally the Top-5 voters against the supplied candles and external anchors.
 *
 * **External anchors** — the orchestrator does NOT call R28V6, Breakout, or
 * MeanRev itself; those live inside `detectAsset` in the existing engine.
 * The live caller passes those side-votes in via `anchors` so the consensus
 * gate can see all available votes.
 *
 * Strict-majority rule: when `long_votes == short_votes`, consensus = null
 * even if `minVotes` is met (mirrors Rust BUG-AUDIT-ROUND-3 BUG #2 fix).
 *
 * @param candles Live-convention candle slice — last element IS the signal
 *   bar (just-closed). The voters internally expect Rust-convention
 *   `signal_idx = len - 2`, so this function appends a placeholder
 *   entry-bar via `withPlaceholderEntryBar`. Voters never read it.
 */
export function tallyRegimeConfluence(
  candles: Candle[],
  params: RegimeConfluenceParams,
  anchors: {
    r28v6Vote?: VoterSide;
    breakoutVote?: VoterSide;
    meanRevVote?: VoterSide;
  } = {},
): RegimeConfluenceTally {
  // Append placeholder entry-bar so Rust-convention voters work directly.
  // Voters never read the appended slot — it just shifts signal_idx to len-2.
  const candlesWithEntry =
    candles.length > 0
      ? [
          ...candles,
          {
            ...candles[candles.length - 1]!,
            openTime: candles[candles.length - 1]!.openTime + 1,
            closeTime: candles[candles.length - 1]!.closeTime + 1,
            volume: 0,
            isFinal: false,
          },
        ]
      : candles;

  const votesByName: Record<string, VoterSide> = {};

  // External anchors (R28V6, Breakout, MR).
  if (anchors.r28v6Vote !== undefined) votesByName.r28v6 = anchors.r28v6Vote;
  if (anchors.breakoutVote !== undefined)
    votesByName.breakout = anchors.breakoutVote;
  if (anchors.meanRevVote !== undefined)
    votesByName.meanRev = anchors.meanRevVote;

  // Top-5 ported voters.
  if (params.voters.usePocZ) {
    votesByName.pocZ = computePocZVote(candlesWithEntry, {
      ...defaultPocZParams(),
      ...params.voters.pocZParams,
    });
  }
  if (params.voters.useBbZMr) {
    votesByName.bbZMr = computeBbZScoreVote(candlesWithEntry, {
      ...defaultBbZScoreSource(),
      ...params.voters.bbZParams,
    });
  }
  if (params.voters.useSupertrend) {
    votesByName.supertrend = computeSupertrendVote(candlesWithEntry, {
      ...defaultSupertrendParams(),
      ...params.voters.supertrendParams,
    });
  }
  if (params.voters.useSmcFvg) {
    votesByName.smcFvg = computeSmcFvgVote(candlesWithEntry, {
      ...defaultFvgParams(),
      ...params.voters.smcFvgParams,
    });
  }
  if (params.voters.useHmm) {
    votesByName.hmm = computeHmmRegimeVote(
      candlesWithEntry,
      params.voters.hmmModel ?? defaultBtc30mModel(),
      {
        ...defaultHmmRegimeParams(),
        ...params.voters.hmmParams,
      },
    );
  }

  // Count.
  let longVotes = 0;
  let shortVotes = 0;
  let r28v6IsLong = false;
  let r28v6IsShort = false;
  for (const [name, side] of Object.entries(votesByName)) {
    if (side === "long") {
      longVotes++;
      if (name === "r28v6") r28v6IsLong = true;
    } else if (side === "short") {
      shortVotes++;
      if (name === "r28v6") r28v6IsShort = true;
    }
  }

  // Strict majority — tie → null.
  let winningSide: VoterSide = null;
  let winningCount = 0;
  if (longVotes > shortVotes) {
    winningSide = "long";
    winningCount = longVotes;
  } else if (shortVotes > longVotes) {
    winningSide = "short";
    winningCount = shortVotes;
  }

  if (winningSide === null || winningCount < params.minVotes) {
    return { longVotes, shortVotes, votesByName, consensus: null };
  }
  if (params.requireR28v6) {
    const r28InWinning =
      (winningSide === "long" && r28v6IsLong) ||
      (winningSide === "short" && r28v6IsShort);
    if (!r28InWinning) {
      return { longVotes, shortVotes, votesByName, consensus: null };
    }
  }
  return { longVotes, shortVotes, votesByName, consensus: winningSide };
}
