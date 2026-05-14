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

/// 2026-05-13 Phase 3b — VWAP-trend vote helper. Returns the trend
/// direction sampled from VWAP — Long if signal-bar close > VWAP AND VWAP
/// is rising (last-period delta > 0), Short if close < VWAP AND VWAP
/// falling. Provides a 5th independent voter (price+volume joint signal,
/// orthogonal to vol_confirm which only consults raw volume).
///
/// 2026-05-13 Codex KRITISCH FIX: signal-bar = `candles[i-1]` (the just-
/// closed bar), NOT `candles[i]` (the current execution bar whose close
/// is future data). VWAP window is `[i-1-n .. i-1)` and the "previous"
/// window slides one bar back for the slope.
///
/// vwap = Σ(close_k × volume_k) / Σ(volume_k)  over last `vwap_period` bars.
fn compute_vwap_trend_vote(
    candles: &[Candle],
    params: &RegimeConfluenceParams,
) -> Option<PositionSide> {
    let n = params.vwap_period;
    // Need bar `i` + the i-1 slice for VWAP-now + the i-2 slice for prev VWAP.
    if n == 0 || candles.len() < n + 3 {
        return None;
    }
    let signal_idx = candles.len() - 2; // bar i-1 (just closed, no lookahead)
    let signal_bar = candles[signal_idx];
    if !signal_bar.close.is_finite() {
        return None;
    }
    // VWAP-now: bars (i-1-n .. i-1), excluding signal_bar itself so the
    // sum is on bars STRICTLY BEFORE the signal bar.
    let slice = &candles[signal_idx - n..signal_idx];
    let (sum_pv, sum_v) = slice.iter().fold((0.0_f64, 0.0_f64), |(p, v), c| {
        (p + c.close * c.volume, v + c.volume)
    });
    if !sum_v.is_finite() || sum_v <= 0.0 || !sum_pv.is_finite() {
        return None;
    }
    let vwap_now = sum_pv / sum_v;
    // Prev-window VWAP for slope: bars (i-2-n .. i-2).
    if signal_idx < n + 1 {
        return None;
    }
    let prev_slice = &candles[signal_idx - 1 - n..signal_idx - 1];
    let (sum_pv_p, sum_v_p) = prev_slice.iter().fold((0.0_f64, 0.0_f64), |(p, v), c| {
        (p + c.close * c.volume, v + c.volume)
    });
    if sum_v_p <= 0.0 {
        return None;
    }
    let vwap_prev = sum_pv_p / sum_v_p;
    let dev_pct = (signal_bar.close - vwap_now) / vwap_now;
    if !dev_pct.is_finite() {
        return None;
    }
    let min_dev = params.vwap_min_dev_pct.max(0.0);
    let rising = vwap_now > vwap_prev;
    let falling = vwap_now < vwap_prev;
    if rising && dev_pct >= min_dev {
        Some(PositionSide::Long)
    } else if falling && dev_pct <= -min_dev {
        Some(PositionSide::Short)
    } else {
        None
    }
}

/// 2026-05-13 — volume-confirmation vote helper. Returns the breakout's
/// direction if the SIGNAL-bar's volume cleared
/// `params.vol_confirm_mult × SMA(volume, params.vol_confirm_period)`.
/// Independent voter so mv=3/mv=4 consensus is reachable without an
/// MR-source on AMBER family.
///
/// 2026-05-13 Codex KRITISCH FIX: signal-bar = `candles[i-1]` (just-closed,
/// volume known). SMA window slides to bars STRICTLY BEFORE the signal bar
/// so the comparison is "signal-bar volume vs prior N bars", with no
/// dependency on `candles[i].volume` (which is future data at signal time).
fn compute_vol_confirm_vote(
    candles: &[Candle],
    params: &RegimeConfluenceParams,
    bo_signal: Option<&PollSignal>,
) -> Option<PositionSide> {
    let n = params.vol_confirm_period;
    // Need bar `i` + signal-bar (i-1) + n SMA-window bars before signal-bar.
    if n == 0 || candles.len() < n + 2 {
        return None;
    }
    // 2026-05-13 Bug-Audit Round 3 — BUG #5 FIX: guard against vol_confirm_mult
    // ≤ 0 or non-finite. Previously mult=0 made the comparison
    // `last.volume >= 0 * sma` = `last.volume >= 0` always true → unconditional
    // fire. Negative mult triggered same pathology. Now treated as "gate
    // disabled" (no vote).
    if !params.vol_confirm_mult.is_finite() || params.vol_confirm_mult <= 0.0 {
        return None;
    }
    let bo = bo_signal?;
    let signal_idx = candles.len() - 2;
    let signal_bar = candles[signal_idx];
    let sma: f64 = candles[signal_idx - n..signal_idx]
        .iter()
        .map(|c| c.volume)
        .sum::<f64>()
        / n as f64;
    if !sma.is_finite() || sma <= 0.0 || !signal_bar.volume.is_finite() {
        return None;
    }
    if signal_bar.volume >= params.vol_confirm_mult * sma {
        Some(bo.direction)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct RegimeConfluenceParams {
    /// Number of detectors that must agree on direction. With 3 detectors
    /// in the panel, 2 = majority vote, 3 = unanimous.
    pub min_votes: usize,
    /// When true, also require the R28V6 detector to be among the agreeing
    /// votes (i.e. trend-confirmed). Otherwise any 2-of-3 consensus passes.
    pub require_r28v6: bool,
    /// 2026-05-13 Audit-6: optional MR source that overrides cfg.mean_reversion_source.
    /// Lets `mv=3` work on configs whose template doesn't carry MR (AMBER family).
    pub mr_source_override: Option<crate::config::MeanReversionSource>,
    /// 2026-05-13 Audit-6: optional volume-confirmation probe. When true, a 4th
    /// vote fires when current bar volume ≥ `vol_mult` × SMA-N(volume) AND
    /// direction agrees with breakout's price direction. Lets mv=3 work with
    /// 4 voters available (R28V6 + Breakout + MR + Vol-confirm) so quorum is
    /// reachable even when MR-source is absent.
    pub use_vol_confirm: bool,
    pub vol_confirm_period: usize,
    pub vol_confirm_mult: f64,
    /// 2026-05-13 Audit Round 2 — propagate R28V6 secondary-gate overrides
    /// (ADX/CHOP/RSI) into the regime probe. Before this fix, the standalone
    /// R28V6 path applied these via `apply_r28v6_param_overrides`, but
    /// detect_regime_confluence called `R28V6Params::default_for` directly
    /// → CLI flags silently no-op'd inside REGIME mode.
    pub r28v6_adx_min: Option<f64>,
    pub r28v6_adx_period: Option<usize>,
    pub r28v6_chop_max: Option<f64>,
    pub r28v6_chop_period: Option<usize>,
    pub r28v6_rsi_long_max: Option<f64>,
    pub r28v6_rsi_short_min: Option<f64>,
    pub r28v6_rsi_period: Option<usize>,
    /// 2026-05-13 Phase 3b: 5th voter — VWAP-trend gate. When
    /// `use_vwap_trend`, fires the side of price-vs-VWAP whose VWAP slope
    /// agrees (Long if close > VWAP AND VWAP rising). Orthogonal to
    /// vol_confirm (which uses raw volume) and breakout (which uses
    /// price-vs-prev-high). 5 voters → mv=4 / mv=5 quorum reachable.
    pub use_vwap_trend: bool,
    pub vwap_period: usize,
    pub vwap_min_dev_pct: f64,
    /// 2026-05-14 Detector #14 — Stop-Hunt Liquidity-Sweep Reversal voter
    /// (6th independent voter). Fires Long when the signal-bar wicks below
    /// the prior N-bar swing-low by ≥ `stop_hunt_wick_pct` then closes back
    /// above it; Short on the symmetric upside sweep. Reference range is
    /// EXCLUSIVE of the signal bar to prevent self-fulfilling lookahead
    /// (the bug class from TS `ftmoSmcEngine.ts:138-170`).
    pub use_stop_hunt: bool,
    pub stop_hunt_lookback: usize,
    pub stop_hunt_wick_pct: f64,
    pub stop_hunt_close_strict: bool,
    /// 2026-05-14 Detector #1 — Bollinger-Band Z-score Mean-Reversion voter
    /// (7th independent voter). Fires Long when price dips to a deep z-extreme
    /// (Z ≤ -threshold) within the last `look_back_bars` AND closes back inside
    /// the lower BB on the signal bar AND the signal-bar z is back below
    /// `z_recover_cap`. Short on the symmetric upside extreme. Orthogonal to
    /// RSI-MR (cross-of-threshold) and Stop-Hunt (wick-depth) — picks up clean
    /// snap-back setups from absolute-price displacement.
    pub use_bb_z_mr: bool,
    pub bb_z_params: crate::signals_bb_zscore_mr::BollingerZScoreSource,
    /// 2026-05-14 Detector #2 — Order-Flow-Imbalance Persistent Cluster voter
    /// (8th independent voter). Fires the direction agreed by every bar in the
    /// last N closed bars' signed taker-flow delta, gated by a min ratio
    /// threshold, an SMA-trend confirmation, and a net-return secondary
    /// filter. Orthogonal to vol_confirm (raw volume), VWAP-trend
    /// (price-vs-mean slope), and the MR/Stop-Hunt voters (reversal-class).
    /// Lookahead-safe: window strictly ends at `signal_idx = len-2`.
    pub use_ofi: bool,
    pub ofi_params: crate::signals_ofi::OfiPersistentParams,
    /// 2026-05-14 Phase-2 — Chaikin Money Flow voter (volume-weighted price-position).
    pub use_cmf: bool,
    pub cmf_params: crate::signals_cmf::CmfParams,
    /// 2026-05-14 Phase-2 — CME futures basis premium voter (BTC-only).
    pub use_cme_basis: bool,
    pub cme_basis_params: crate::signals_cme_basis::CmeBasisParams,
    /// 2026-05-14 Phase-2 — HMM regime classifier voter (3-state bear/range/bull).
    pub use_hmm_regime: bool,
    pub hmm_regime_params: crate::signals_hmm_regime::HmmRegimeParams,
    /// 2026-05-14 Phase-2 — NUPL regime voter (multi-week macro on-chain signal).
    pub use_nupl: bool,
    pub nupl_params: crate::signals_nupl::NuplParams,
    /// 2026-05-14 Phase-2 — RSI hidden-divergence trend-continuation voter.
    pub use_rsi_hidden_div: bool,
    pub rsi_hidden_div_params: crate::signals_rsi_hidden_div::RsiHiddenDivParams,
    /// 2026-05-14 Phase-2 — Top-trader long/short follow voter (smart-money).
    pub use_top_trader_ls: bool,
    pub top_trader_ls_params: crate::signals_top_trader_ls::TopTraderLsParams,
}

impl RegimeConfluenceParams {
    pub fn default_2of3() -> Self {
        Self {
            min_votes: 2,
            require_r28v6: false,
            mr_source_override: None,
            use_vol_confirm: false,
            vol_confirm_period: 20,
            vol_confirm_mult: 1.2,
            r28v6_adx_min: None,
            r28v6_adx_period: None,
            r28v6_chop_max: None,
            r28v6_chop_period: None,
            r28v6_rsi_long_max: None,
            r28v6_rsi_short_min: None,
            r28v6_rsi_period: None,
            use_vwap_trend: false,
            vwap_period: 20,
            vwap_min_dev_pct: 0.0,
            use_stop_hunt: false,
            stop_hunt_lookback: 20,
            stop_hunt_wick_pct: 0.003,
            stop_hunt_close_strict: false,
            use_bb_z_mr: false,
            bb_z_params: crate::signals_bb_zscore_mr::BollingerZScoreSource::default(),
            use_ofi: false,
            ofi_params: crate::signals_ofi::OfiPersistentParams::default_30m_crypto(),
            use_cmf: false,
            cmf_params: crate::signals_cmf::CmfParams::default_30m_crypto(),
            use_cme_basis: false,
            cme_basis_params: crate::signals_cme_basis::CmeBasisParams::default(),
            use_hmm_regime: false,
            hmm_regime_params: crate::signals_hmm_regime::HmmRegimeParams::default(),
            use_nupl: false,
            nupl_params: crate::signals_nupl::NuplParams::default(),
            use_rsi_hidden_div: false,
            rsi_hidden_div_params: crate::signals_rsi_hidden_div::RsiHiddenDivParams::default(),
            use_top_trader_ls: false,
            top_trader_ls_params: crate::signals_top_trader_ls::TopTraderLsParams::default(),
        }
    }

    /// Apply ADX/CHOP/RSI overrides onto a fresh `R28V6Params`. Mirrors the
    /// helper at `sweep::apply_r28v6_param_overrides` so REGIME mode honors
    /// the same CLI flags as standalone R28V6.
    fn apply_r28v6_overrides(&self, p: &mut R28V6Params) {
        if let Some(min) = self.r28v6_adx_min {
            p.adx_min = Some(min);
            p.adx_period = Some(self.r28v6_adx_period.unwrap_or(14));
        }
        if let Some(max) = self.r28v6_chop_max {
            p.choppiness_max = Some(max);
            p.choppiness_period = Some(self.r28v6_chop_period.unwrap_or(14));
        }
        if self.r28v6_rsi_long_max.is_some() || self.r28v6_rsi_short_min.is_some() {
            p.rsi_period = Some(self.r28v6_rsi_period.unwrap_or(14));
            p.rsi_long_max = self.r28v6_rsi_long_max;
            p.rsi_short_min = self.r28v6_rsi_short_min;
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
    let mut r28p = R28V6Params::default_for(asset, cfg);
    params.apply_r28v6_overrides(&mut r28p);
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
    let mr_effective_some =
        cfg.mean_reversion_source.is_some() || params.mr_source_override.is_some();
    // 2026-05-13 Codex MED FIX: VWAP-trend is a 5th independent voter — if
    // enabled it can carry quorum with breakout even when R28V6 abstains
    // and MR/vol-confirm are disabled. Previously the early-exit didn't
    // know about VWAP and dropped legitimate VWAP+BO consensus.
    // 2026-05-14 Detector #14: Stop-Hunt is the 6th voter — same reasoning,
    // it can carry quorum with breakout when R28V6 abstains and MR/vol-
    // confirm/VWAP are disabled.
    // 2026-05-14 Detector #2: OFI is the 8th voter — same reasoning, it
    // can carry quorum with breakout when R28V6 abstains and every other
    // optional voter is off.
    if r28.is_none()
        && params.min_votes >= 2
        && !mr_effective_some
        && !params.use_vol_confirm
        && !params.use_vwap_trend
        && !params.use_stop_hunt
        && !params.use_bb_z_mr
        && !params.use_ofi
    {
        return None;
    }

    let mut state_for_bo = state.clone();
    let bp = BreakoutParams::from_cfg(cfg, asset);
    let bo = detect_breakout(&mut state_for_bo, cfg, asset, source_symbol, candles, &bp);

    // MR probe — uses override if provided, else cfg.mean_reversion_source.
    // 2026-05-13 Codex MED FIX: hoist state_for_mr out of the closure so we
    // can propagate its mutations (cooldown_by_asset_dir + loss-streak) back
    // when MR is the winning anchor. Without this, MR cooldown silently
    // evaporates and back-to-back MR signals fire same-bar (anti-spam dead).
    let mr_src = params
        .mr_source_override
        .as_ref()
        .or(cfg.mean_reversion_source.as_ref());
    let mut state_for_mr = state.clone();
    let mr = mr_src.and_then(|src| {
        detect_mean_reversion(&mut state_for_mr, cfg, asset, source_symbol, candles, src)
    });

    // Volume-confirmation probe — fires on the breakout direction when current
    // bar's volume ≥ params.vol_confirm_mult × SMA(vol, period). Provides a
    // 4th vote so mv=3 is achievable without an MR-source. Uses breakout's
    // direction as the proxy (the simplest "price+volume agreement" rule).
    let vol_vote = if params.use_vol_confirm {
        compute_vol_confirm_vote(candles, params, bo.as_ref())
    } else {
        None
    };
    // VWAP-trend probe (Phase 3b) — independent 5th voter. Long if close >
    // VWAP and VWAP rising, Short if close < VWAP and VWAP falling. Uses
    // its own direction (NOT parasitic on breakout). Orthogonal joint
    // price+volume signal.
    let vwap_vote = if params.use_vwap_trend {
        compute_vwap_trend_vote(candles, params)
    } else {
        None
    };
    // 2026-05-14 Detector #14 — Stop-Hunt Liquidity-Sweep 6th voter.
    // Independent of all prior voters: uses OHLC wick-vs-prior-swing
    // relationship, not trend / volume / VWAP slope. Lookahead-safe by
    // construction (reference range EXCLUDES signal bar).
    let stop_hunt_vote = if params.use_stop_hunt {
        let sh_params = crate::signals_stop_hunt::StopHuntParams {
            lookback: params.stop_hunt_lookback,
            required_wick_depth_pct: params.stop_hunt_wick_pct,
            close_back_strict: params.stop_hunt_close_strict,
        };
        crate::signals_stop_hunt::compute_stop_hunt_vote(candles, &sh_params)
    } else {
        None
    };
    // 2026-05-14 Detector #1 — Bollinger-Band Z-score MR 7th voter. Vote is
    // computed by `compute_bb_zscore_vote` (pure helper, no state). Provides
    // an orthogonal mean-reversion read independent of RSI-MR / Stop-Hunt /
    // VWAP-trend. Lookahead-safe by construction (reads candles[..=i-1]).
    let bb_z_vote = if params.use_bb_z_mr {
        crate::signals_bb_zscore_mr::compute_bb_zscore_vote(candles, &params.bb_z_params)
    } else {
        None
    };
    // 2026-05-14 Detector #2 — OFI persistent-cluster 8th voter. Pure
    // helper (`compute_ofi_vote`) so no state-clone juggling — orthogonal
    // taker-flow-aggregate signal independent of all prior voters
    // (price-only, single-bar volume, raw aggressor ratio, value-area
    // distance). Lookahead-safe by construction (window ends at signal_idx).
    let ofi_vote = if params.use_ofi {
        crate::signals_ofi::compute_ofi_vote(candles, &params.ofi_params, cfg)
    } else {
        None
    };
    // 2026-05-14 Phase-2 voters — module-only registered. Wire via dedicated flags.
    let cmf_vote = if params.use_cmf {
        crate::signals_cmf::compute_cmf_vote(candles, &params.cmf_params, cfg)
    } else {
        None
    };
    let rsi_hd_vote = if params.use_rsi_hidden_div {
        crate::signals_rsi_hidden_div::compute_rsi_hidden_div_vote(
            candles,
            &params.rsi_hidden_div_params,
        )
    } else {
        None
    };

    // Count directional votes. We allow a None probe to count as "abstain"
    // — only positive votes count toward the threshold.
    let mut long_votes = 0u8;
    let mut short_votes = 0u8;
    let mut r28v6_voted_long = false;
    let mut r28v6_voted_short = false;

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
    }
    if let Some(s) = bo.as_ref() {
        match s.direction {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(s) = mr.as_ref() {
        match s.direction {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(side) = vol_vote {
        match side {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(side) = vwap_vote {
        match side {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(side) = stop_hunt_vote {
        match side {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(side) = bb_z_vote {
        match side {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(side) = ofi_vote {
        match side {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(side) = cmf_vote {
        match side {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }
    if let Some(side) = rsi_hd_vote {
        match side {
            PositionSide::Long => long_votes += 1,
            PositionSide::Short => short_votes += 1,
        }
    }

    // 2026-05-13 Codex LOW FIX: clamp before u8 cast — min_votes ≥ 256
    // would silently wrap to 0 (vacuous-truth fires every bar).
    let min = params.min_votes.min(u8::MAX as usize) as u8;
    // 2026-05-13 Bug-Audit Round 3 — BUG #2 FIX: strict majority `>` not `>=`.
    // Tie (long_votes == short_votes) means no consensus → return None.
    // Previously `>=` favored Long unconditionally on tied votes which fired
    // unsupported entries (e.g. R28V6=Long + Bo=Short with mv=1).
    let (winning_side, winning_count) = if long_votes > short_votes {
        (PositionSide::Long, long_votes)
    } else if short_votes > long_votes {
        (PositionSide::Short, short_votes)
    } else {
        // Tie → no consensus. Return None even if min_votes would be met.
        return None;
    };

    if winning_count < min {
        return None;
    }
    // Disable_short/disable_long policy enforcement at consensus output.
    // Breakout/MR/vol-confirm/vwap can outvote per-direction asset flags
    // because only R28V6 honors them internally. Bug-Audit Round 3 added
    // disable_short. 2026-05-13 Codex Round 8 #D FIX: add the symmetric
    // disable_long check — recently-added AssetConfig.disable_long was
    // omitted at this site, so a disable_long=true asset could still emit
    // a winning Long via Breakout+Vol-confirm consensus despite the primary
    // R28V6 path correctly skipping Long.
    if asset.disable_short && winning_side == PositionSide::Short {
        return None;
    }
    if asset.disable_long && winning_side == PositionSide::Long {
        return None;
    }
    // 2026-05-13 Audit-3: debug counter for "winning vote without R28V6
    // contribution". If env REGIME_DEBUG=1, eprintln when this happens —
    // exposes any signal that was claimed valid despite R28V6 not voting
    // on the winning side.
    //
    // 2026-05-13 Bug-Audit Round 2 — Bug F clarification: previously this
    // comment claimed "MR-source=None ⇒ mv=2 mathematically requires
    // R28V6 + breakout consensus". That's only true when
    // `use_vol_confirm=false`. When vol-confirm is enabled, Breakout +
    // Volume-Spike together carry quorum=2 without R28V6 — and that path
    // IS reachable (params.require_r28v6=false by default). Use the
    // require_r28v6 flag to enforce R28V6 mandatory.
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

    // 2026-05-13 Bug-Audit Round 3 — BUG #1 FIX: anchor selection. Previously
    // the FIRST detector to fire (R28V6 typically) became the anchor. When
    // R28V6 dissented from the winning side (e.g. R28V6=Short, Bo=Long, Vol=Long
    // → winning=Long but anchor=R28V6-Short), the function returned None and
    // silently dropped legitimate consensus entries.
    //
    // Fix: pick the FIRST signal in (r28, bo, mr) whose direction matches the
    // winning side. Vol-confirm only carries a PositionSide vote, not a full
    // PollSignal, so it cannot be the anchor — but the breakout signal (which
    // vol-confirm parasitizes) is available as a fallback anchor in that case.
    // 2026-05-13 Codex MED FIX: track the index of the winning probe so we
    // can propagate its private state-clone back to the real state. Order
    // mirrors the [r28, bo, mr] iteration above.
    let probes: [(Option<&PollSignal>, AnchorKind); 3] = [
        (r28.as_ref(), AnchorKind::R28V6),
        (bo.as_ref(), AnchorKind::Breakout),
        (mr.as_ref(), AnchorKind::MeanReversion),
    ];
    let (anchor, anchor_kind) = probes
        .into_iter()
        .filter_map(|(s, k)| s.map(|sig| (sig, k)))
        .find(|(s, _)| s.direction == winning_side)?;
    // Propagate the chosen probe's state-mutations back to the real state.
    // Other probes' clones are discarded (their side-effects had no
    // entry-route to the harness anyway). Without this propagation:
    //   - MR cooldown_by_asset_dir resets every bar → MR fires every poll
    //     instead of being throttled
    //   - Kelly-tier index decrement on a fresh tier-roll is lost → next
    //     bar's sizing reads stale tier, causing repeated over-sizing
    //
    // 2026-05-13 Codex MED FIX (Fix 5): when MR voted on the winning side
    // but R28/BO became the anchor, MR's cooldown install on
    // `state_for_mr.loss_streak_by_asset_dir` was discarded → MR voted
    // again every bar (anti-spam dead). Now we MERGE MR's
    // loss_streak_by_asset_dir delta whenever MR contributed a vote on
    // `winning_side`, regardless of which probe was the anchor.
    let mr_voted_on_winning = mr.as_ref().is_some_and(|s| s.direction == winning_side);
    let pre_mr_keys: std::collections::HashSet<String> =
        state.loss_streak_by_asset_dir.keys().cloned().collect();
    match anchor_kind {
        AnchorKind::R28V6 => *state = state_for_r28,
        AnchorKind::Breakout => *state = state_for_bo,
        AnchorKind::MeanReversion => *state = state_for_mr.clone(),
    }
    if mr_voted_on_winning && anchor_kind != AnchorKind::MeanReversion {
        // Copy any MR-installed cooldown entries (keys present in state_for_mr
        // but NOT in pre_mr state). MR's detect_mean_reversion writes
        // entries with key prefix "MR|" — copy those forward.
        for (key, value) in state_for_mr.loss_streak_by_asset_dir.iter() {
            if key.starts_with("MR|") && !pre_mr_keys.contains(key) {
                state
                    .loss_streak_by_asset_dir
                    .insert(key.clone(), value.clone());
            }
        }
    }
    Some(anchor.clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnchorKind {
    R28V6,
    Breakout,
    MeanReversion,
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
            ..RegimeConfluenceParams::default_2of3()
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

    // 2026-05-13 Audit Round 2: edge-case unit tests on the consensus voting
    // logic. These guard against subtle vote-counting / state-mutation /
    // numerical drift bugs that a sweep might mask. Each test isolates ONE
    // boundary condition and asserts the documented contract.

    fn nop_inputs<'a>() -> R28V6Inputs<'a> {
        R28V6Inputs {
            htf_closes: None,
            cross_asset_closes: None,
            news_events: None,
            funding_series: None,
        }
    }

    fn flat_candles(n: usize) -> Vec<Candle> {
        (0..n)
            .map(|i| make_candle(i as i64 * 1_800_000, 100.0))
            .collect()
    }

    #[test]
    fn mv0_with_no_signals_still_returns_none() {
        // mv=0 means "0 votes required" — even with no detector firing,
        // returns None (anchor is None). Guards a divide-by-zero / vacuous-
        // truth interpretation that would let mv=0 fire on every bar.
        let cfg = EngineConfig::r28_v6_passlock_template();
        let asset = AssetConfig::default();
        let mut state = EngineState::initial(&cfg.label);
        let params = RegimeConfluenceParams {
            min_votes: 0,
            ..RegimeConfluenceParams::default_2of3()
        };
        let s = detect_regime_confluence(
            &mut state,
            &cfg,
            &asset,
            "BTCUSDT",
            &flat_candles(100),
            &params,
            &nop_inputs(),
        );
        assert!(
            s.is_none(),
            "mv=0 must not fabricate a signal from None anchor"
        );
    }

    #[test]
    fn mv4_unreachable_returns_none() {
        // 3 detectors available (R28V6, breakout, MR), MR is None by default.
        // Even if all 3 fire same direction, max vote count is 3 < 4 → None.
        // With vol-confirm 4 voters max — but mv=4 still requires all to agree.
        let cfg = EngineConfig::r28_v6_passlock_template();
        let asset = AssetConfig::default();
        let mut state = EngineState::initial(&cfg.label);
        let params = RegimeConfluenceParams {
            min_votes: 4,
            ..RegimeConfluenceParams::default_2of3()
        };
        let s = detect_regime_confluence(
            &mut state,
            &cfg,
            &asset,
            "BTCUSDT",
            &flat_candles(100),
            &params,
            &nop_inputs(),
        );
        assert!(s.is_none(), "mv=4 with 3 max detectors must be unreachable");
    }

    #[test]
    fn state_unchanged_when_no_signal_fires() {
        // Critical state-clone correctness check: when all probes return None
        // (flat market), the real state must not be mutated. Probes run on
        // state.clone() so mutations are contained.
        let cfg = EngineConfig::r28_v6_passlock_template();
        let asset = AssetConfig::default();
        let mut state = EngineState::initial(&cfg.label);
        let pre_equity = state.equity;
        let pre_kelly = state.kelly_tier_idx;
        let pre_bars_seen = state.bars_seen;
        let params = RegimeConfluenceParams::default_2of3();
        let _ = detect_regime_confluence(
            &mut state,
            &cfg,
            &asset,
            "BTCUSDT",
            &flat_candles(100),
            &params,
            &nop_inputs(),
        );
        assert_eq!(state.equity, pre_equity, "equity must not change");
        assert_eq!(
            state.kelly_tier_idx, pre_kelly,
            "kelly_tier_idx must not change"
        );
        assert_eq!(state.bars_seen, pre_bars_seen, "bars_seen must not change");
    }

    #[test]
    fn vol_confirm_handles_nan_volume() {
        // Numerical edge: if signal-bar volume is NaN/inf, helper must NOT panic.
        // 2026-05-13 Codex fix: signal-bar = i-1 → put NaN on candles[48].
        let mut candles = flat_candles(50);
        // Give the SMA window some non-zero baseline so it isn't filtered out
        // by sum_v <= 0 before reaching the NaN guard.
        for c in candles.iter_mut() {
            c.volume = 100.0;
        }
        candles[48].volume = f64::NAN;
        let params = RegimeConfluenceParams {
            min_votes: 1,
            use_vol_confirm: true,
            vol_confirm_period: 20,
            vol_confirm_mult: 1.2,
            ..RegimeConfluenceParams::default_2of3()
        };
        // Build a fake breakout signal (caller-side; we just test compute helper)
        let fake_signal = PollSignal {
            symbol: "X".into(),
            source_symbol: "X".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: 100.0,
            stop_price: 99.0,
            tp_price: 101.0,
            stop_pct: 0.01,
            tp_pct: 0.01,
            eff_risk: 0.1,
            chandelier_atr_at_entry: None,
        };
        let v = compute_vol_confirm_vote(&candles, &params, Some(&fake_signal));
        assert!(v.is_none(), "NaN volume must produce no vote");
    }

    #[test]
    fn vol_confirm_handles_zero_period() {
        let candles = flat_candles(50);
        let params = RegimeConfluenceParams {
            min_votes: 1,
            use_vol_confirm: true,
            vol_confirm_period: 0,
            vol_confirm_mult: 1.2,
            ..RegimeConfluenceParams::default_2of3()
        };
        let v = compute_vol_confirm_vote(&candles, &params, None);
        assert!(v.is_none(), "period=0 must safely produce no vote");
    }

    #[test]
    fn vol_confirm_returns_none_without_bo_signal() {
        // Vol-confirm is parasitic on breakout's direction. Without bo signal
        // input, the helper has no direction to project → None.
        let candles = flat_candles(50);
        let params = RegimeConfluenceParams {
            min_votes: 1,
            use_vol_confirm: true,
            vol_confirm_period: 20,
            vol_confirm_mult: 1.2,
            ..RegimeConfluenceParams::default_2of3()
        };
        let v = compute_vol_confirm_vote(&candles, &params, None);
        assert!(v.is_none());
    }

    #[test]
    fn vol_confirm_fires_when_volume_spikes() {
        // Numerical contract: when SIGNAL-bar (i-1) volume ≥ mult × SMA(N),
        // vote = bo.direction.
        // 2026-05-13 Codex KRITISCH FIX adjustment: signal-bar now i-1,
        // spike placed at candles[48], not candles[49].
        let mut candles = flat_candles(50);
        for c in candles.iter_mut() {
            c.volume = 100.0;
        }
        // Signal-bar (i-1 = idx 48) = 250 = 2.5× SMA.
        candles[48].volume = 250.0;
        let params = RegimeConfluenceParams {
            min_votes: 1,
            use_vol_confirm: true,
            vol_confirm_period: 20,
            vol_confirm_mult: 2.0,
            ..RegimeConfluenceParams::default_2of3()
        };
        let fake_signal = PollSignal {
            symbol: "X".into(),
            source_symbol: "X".into(),
            direction: PositionSide::Short,
            entry_time: 0,
            entry_price: 100.0,
            stop_price: 101.0,
            tp_price: 99.0,
            stop_pct: 0.01,
            tp_pct: 0.01,
            eff_risk: 0.1,
            chandelier_atr_at_entry: None,
        };
        let v = compute_vol_confirm_vote(&candles, &params, Some(&fake_signal));
        assert_eq!(
            v,
            Some(PositionSide::Short),
            "2.5× spike at mult=2.0 must vote bo.direction"
        );
    }

    #[test]
    fn vol_confirm_skips_when_volume_below_threshold() {
        let mut candles = flat_candles(50);
        for c in candles.iter_mut() {
            c.volume = 100.0;
        }
        // Signal-bar i-1 = idx 48 (after Codex lookahead fix).
        candles[48].volume = 150.0; // 1.5× SMA but mult is 2.0
        let params = RegimeConfluenceParams {
            min_votes: 1,
            use_vol_confirm: true,
            vol_confirm_period: 20,
            vol_confirm_mult: 2.0,
            ..RegimeConfluenceParams::default_2of3()
        };
        let fake_signal = PollSignal {
            symbol: "X".into(),
            source_symbol: "X".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: 100.0,
            stop_price: 99.0,
            tp_price: 101.0,
            stop_pct: 0.01,
            tp_pct: 0.01,
            eff_risk: 0.1,
            chandelier_atr_at_entry: None,
        };
        let v = compute_vol_confirm_vote(&candles, &params, Some(&fake_signal));
        assert!(v.is_none(), "below threshold = no vote");
    }

    #[test]
    fn vol_confirm_handles_too_few_candles() {
        // Need ≥ period+1 candles to compute SMA window.
        let candles = flat_candles(5);
        let params = RegimeConfluenceParams {
            min_votes: 1,
            use_vol_confirm: true,
            vol_confirm_period: 20,
            vol_confirm_mult: 1.2,
            ..RegimeConfluenceParams::default_2of3()
        };
        let v = compute_vol_confirm_vote(&candles, &params, None);
        assert!(v.is_none(), "too-short candle slice → safe None");
    }

    #[test]
    fn vol_confirm_handles_zero_sma() {
        // All-zero volume → SMA=0 → divide-by-zero guard triggers → None.
        let mut candles = flat_candles(50);
        for c in candles.iter_mut() {
            c.volume = 0.0;
        }
        // 2026-05-13 Codex fix: signal-bar = i-1 → put any spike on candles[48].
        candles[48].volume = 1.0; // tiny spike, but SMA=0 → guard out
        let params = RegimeConfluenceParams {
            min_votes: 1,
            use_vol_confirm: true,
            vol_confirm_period: 20,
            vol_confirm_mult: 1.2,
            ..RegimeConfluenceParams::default_2of3()
        };
        let fake_signal = PollSignal {
            symbol: "X".into(),
            source_symbol: "X".into(),
            direction: PositionSide::Long,
            entry_time: 0,
            entry_price: 100.0,
            stop_price: 99.0,
            tp_price: 101.0,
            stop_pct: 0.01,
            tp_pct: 0.01,
            eff_risk: 0.1,
            chandelier_atr_at_entry: None,
        };
        let v = compute_vol_confirm_vote(&candles, &params, Some(&fake_signal));
        assert!(v.is_none(), "sma=0 must not divide-by-zero");
    }
}
