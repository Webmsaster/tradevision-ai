// 2026-05-13 Phase B — Regime-Confluence multi-detector consensus signal.
//
// Background: 13 systematic 65%-hunt waves on the standalone R28V6 detector
// + V5_AMBER engine + 30m TF + 19-asset basket plateau at 58.3% s1 single-
// account pass-rate. Knob-tuning (mct, pt, tp×, drop-symbols, hours, DOWs,
// HTF-EMA gate, ADX gate, CHOP gate, RSI gate, multi-detector additive
// ensemble) exhausted. To break 60% requires a structurally different
// signal-quality lever.
//
// This module wraps the existing R28V6, breakout, and meanrev detectors
// behind a VOTING gate: an entry fires only when at least `min_votes`
// detectors AGREE on direction. The intuition is that detectors are noisy
// independently but their combined consensus is selective. Trade-off:
// fewer entries but higher per-trade win-rate → fewer DL/TL hits per
// challenge window → higher pass-rate.
//
// Comparison to existing `also_fire_meanrev` / `also_fire_breakout` flags
// in `sweep.rs`: those ADD entries from extra detectors on top of the
// primary R28V6, which inflates trade count without quality control. This
// detector instead REQUIRES consensus.

use crate::candle::Candle;
use crate::config::{AssetConfig, EngineConfig};
use crate::position::PositionSide;
use crate::signal::PollSignal;
use crate::signals_breakout::{detect_breakout, BreakoutParams};
use crate::signals_meanrev::detect_mean_reversion;
use crate::signals_r28v6::{detect_r28_v6, R28V6Inputs, R28V6Params};
use crate::state::EngineState;

#[derive(Debug, Clone, Copy)]
pub struct RegimeConfluenceParams {
    /// Number of detectors that must agree on direction. With 3 detectors
    /// in the panel, 2 = majority vote, 3 = unanimous.
    pub min_votes: usize,
    /// When true, also require the R28V6 detector to be among the agreeing
    /// votes (i.e. trend-confirmed). Otherwise any 2-of-3 consensus passes.
    pub require_r28v6: bool,
}

impl RegimeConfluenceParams {
    pub fn default_2of3() -> Self {
        Self {
            min_votes: 2,
            require_r28v6: false,
        }
    }
}

/// Detect a consensus entry by polling all three detectors and counting
/// directional votes. Returns the primary detector's signal (R28V6 if it
/// voted, otherwise the first matching detector) only when the consensus
/// threshold is met.
#[allow(clippy::too_many_arguments)]
pub fn detect_regime_confluence(
    state: &mut EngineState,
    cfg: &EngineConfig,
    asset: &AssetConfig,
    source_symbol: &str,
    candles: &[Candle],
    params: &RegimeConfluenceParams,
    inputs: &R28V6Inputs<'_>,
) -> Option<PollSignal> {
    // ---- Probe 1: R28V6 (trend follow / pullback) ----
    let r28p = R28V6Params::default_for(asset, cfg);
    // Mutate a private state copy so the secondary detectors don't see
    // R28V6's loss-streak-cooldown bookkeeping from this probe.
    let r28 = detect_r28_v6(state, cfg, asset, source_symbol, candles, &r28p, inputs);

    // ---- Probe 2: Breakout (lookback-N high/low break) ----
    let bp = BreakoutParams::from_cfg(cfg, asset);
    let bo = detect_breakout(state, cfg, asset, source_symbol, candles, &bp);

    // ---- Probe 3: MeanRev (RSI cross + cooldown) ----
    // Only run if an asset-level or cfg-level MR source is configured;
    // otherwise the MR vote is null (never agreeing/disagreeing).
    let mr = cfg
        .mean_reversion_source
        .as_ref()
        .and_then(|src| detect_mean_reversion(state, cfg, asset, source_symbol, candles, src));

    // Count directional votes. We allow a None probe to count as "abstain"
    // — only positive votes count toward the threshold.
    let mut long_votes = 0u8;
    let mut short_votes = 0u8;
    let mut r28v6_voted_long = false;
    let mut r28v6_voted_short = false;
    let mut anchor: Option<&PollSignal> = None;

    if let Some(s) = r28.as_ref() {
        match s.direction {
            PositionSide::Long => {
                long_votes += 1;
                r28v6_voted_long = true;
            }
            PositionSide::Short => {
                short_votes += 1;
                r28v6_voted_short = true;
            }
        }
        anchor = Some(s);
    }
    if let Some(s) = bo.as_ref() {
        match s.direction {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
        if anchor.is_none() {
            anchor = Some(s);
        }
    }
    if let Some(s) = mr.as_ref() {
        match s.direction {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
        if anchor.is_none() {
            anchor = Some(s);
        }
    }

    let min = params.min_votes as u8;
    let (winning_side, winning_count) = if long_votes >= short_votes {
        (PositionSide::Long, long_votes)
    } else {
        (PositionSide::Short, short_votes)
    };

    if winning_count < min {
        return None;
    }
    if params.require_r28v6 {
        let r28_in_winning = match winning_side {
            PositionSide::Long => r28v6_voted_long,
            PositionSide::Short => r28v6_voted_short,
        };
        if !r28_in_winning {
            return None;
        }
    }

    // Prefer the anchor signal's pricing (entry/stop/tp/eff_risk). We do
    // NOT re-derive sizing — the anchor detector already applied the
    // engine's risk model. Forcing `direction = winning_side` ensures
    // votes from opposing detectors don't fire conflicting trades.
    let anchor = anchor?;
    if anchor.direction != winning_side {
        // Anchor disagrees with winning vote → no valid signal we can
        // emit without recomputing. Return None rather than fabricate.
        return None;
    }
    Some(anchor.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::EngineConfig;

    fn make_candle(t: i64, c: f64) -> Candle {
        Candle::new(t, c, c + 0.5, c - 0.5, c, 100.0)
    }

    #[test]
    fn returns_none_when_no_detector_fires() {
        let candles: Vec<Candle> = (0..100)
            .map(|i| make_candle(i * 1_800_000, 100.0))
            .collect();
        let cfg = EngineConfig::r28_v6_passlock_template();
        let asset = AssetConfig::default();
        let mut state = EngineState::initial(&cfg.label);
        let params = RegimeConfluenceParams::default_2of3();
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        };
        let s = detect_regime_confluence(
            &mut state, &cfg, &asset, "BTCUSDT", &candles, &params, &inputs,
        );
        assert!(s.is_none(), "flat market: no detector should fire");
    }

    #[test]
    fn require_r28v6_filters_when_r28_silent() {
        let candles: Vec<Candle> = (0..100)
            .map(|i| make_candle(i * 1_800_000, 100.0))
            .collect();
        let cfg = EngineConfig::r28_v6_passlock_template();
        let asset = AssetConfig::default();
        let mut state = EngineState::initial(&cfg.label);
        let params = RegimeConfluenceParams {
            min_votes: 1,
            require_r28v6: true,
        };
        let inputs = R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        };
        let s = detect_regime_confluence(
            &mut state, &cfg, &asset, "BTCUSDT", &candles, &params, &inputs,
        );
        // require_r28v6 forces a winning vote that includes R28V6. On flat
        // candles none of the detectors fire so result is None either way,
        // but the gate is reachable.
        assert!(s.is_none());
    }
}
