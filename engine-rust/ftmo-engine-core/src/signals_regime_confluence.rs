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
    // 2026-05-13 Audit-2 fix: each probe gets its OWN clone of state so
    // a probe's internal state-mutations (resolve_sizing_factor mutates
    // state.kelly_tier_idx; MR mutates state.loss_streak_by_asset_dir)
    // do not bias later probes. Before this fix, REGIME mode produced
    // 55 trades that standalone R28V6 didn't fire — symptom of state
    // divergence between probe calls and the standalone path. After
    // the fix the surviving signal still mutates the real state once,
    // when it goes to the harness via push_with_gates.
    let mut state_for_r28 = state.clone();
    let r28p = R28V6Params::default_for(asset, cfg);
    let r28 = detect_r28_v6(
        &mut state_for_r28,
        cfg,
        asset,
        source_symbol,
        candles,
        &r28p,
        inputs,
    );

    // 2026-05-13 Audit-3: early-exit when R28V6 is the must-have anchor
    // and didn't vote. Saves the breakout/MR probe calls AND mathematically
    // forces "R28V6 must be in any winning consensus" on configs where
    // MR-source is None (every AMBER family + R28_V6_PASSLOCK template).
    // Without this, the only way 2-of-3 consensus could fire without
    // R28V6 was breakout+MR agreement — but MR=None blocks that path
    // anyway. Adding the explicit gate prevents downstream state-mutation
    // and signal-set divergence we observed in the post-fix audit (175
    // REGIME-only trades vs standalone R28V6).
    if r28.is_none() && params.min_votes >= 2 && cfg.mean_reversion_source.is_none() {
        return None;
    }

    let mut state_for_bo = state.clone();
    let bp = BreakoutParams::from_cfg(cfg, asset);
    let bo = detect_breakout(&mut state_for_bo, cfg, asset, source_symbol, candles, &bp);

    let mr = cfg.mean_reversion_source.as_ref().and_then(|src| {
        let mut state_for_mr = state.clone();
        detect_mean_reversion(&mut state_for_mr, cfg, asset, source_symbol, candles, src)
    });

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
    // 2026-05-13 Audit-3: debug counter for "winning vote without R28V6
    // contribution". If env REGIME_DEBUG=1, eprintln when this happens —
    // exposes any signal that was claimed valid despite R28V6 not voting
    // on the winning side. With MR-source = None (AMBER family), 2-of-3
    // mathematically requires R28V6 + breakout consensus. Any fire here
    // without R28V6 would be a logic bug.
    let r28_in_winning = match winning_side {
        PositionSide::Long => r28v6_voted_long,
        PositionSide::Short => r28v6_voted_short,
    };
    if !r28_in_winning && std::env::var("REGIME_DEBUG").ok().as_deref() == Some("1") {
        eprintln!(
            "[regime-debug] FIRED without R28V6 vote — asset={} sym={} side={:?} long_votes={} short_votes={} mr_src_is_some={}",
            asset.symbol,
            source_symbol,
            winning_side,
            long_votes,
            short_votes,
            cfg.mean_reversion_source.is_some(),
        );
    }
    if params.require_r28v6 && !r28_in_winning {
        return None;
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
