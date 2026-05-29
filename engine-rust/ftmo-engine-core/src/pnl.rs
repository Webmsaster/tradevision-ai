//! PnL math — port of `computeEffPnl` and `computeMtmEquity` from
//! `ftmoLiveEngineV4.ts`.
//!
//! GAP_TAIL_MULT (-1.5) is the realised-loss floor that absorbs slippage
//! through the stop on weekend gaps. Without it the engine clamps every
//! loss to exactly -stopPct → gap-tail realism is silently disabled and
//! pass-rate over-stated. Same rule applies to unrealised PnL in
//! `computeMtmEquity` so dailyPeakTrailingStop / pDD math sees the same
//! floor mid-trade.

use std::collections::HashMap;

use crate::config::EngineConfig;
use crate::position::{OpenPosition, PositionSide};
use crate::state::EngineState;

/// -1.5R floor on losses (absorbs gap-through-stop slippage).
pub const GAP_TAIL_MULT: f64 = -1.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffPnl {
    pub raw_pnl: f64,
    pub eff_pnl: f64,
}

/// Compute realised effPnl for a position closing at `exit_price`. Includes
/// PTP partial-realised blend.
///
/// `exit_time` is the UTC-millis timestamp of the closing bar; used by the
/// per-asset swap-fee deduction (R67-r17). When `None` (e.g. a synthetic
/// test that cannot be bothered to thread the bar time), swap is skipped —
/// matches TS behaviour where `exitTime === undefined` short-circuits swap.
pub fn compute_eff_pnl(pos: &OpenPosition, exit_price: f64, cfg: &EngineConfig) -> EffPnl {
    compute_eff_pnl_with_time(pos, exit_price, cfg, None)
}

pub fn compute_eff_pnl_with_time(
    pos: &OpenPosition,
    exit_price: f64,
    cfg: &EngineConfig,
    exit_time: Option<i64>,
) -> EffPnl {
    // R67 audit fix: guard against entry_price ≤ 0 / non-finite. Without this,
    // a corrupted state file or a synthetic-test 0-priced asset produces NaN,
    // which propagates into state.equity and silently disables all failure
    // checks (NaN comparisons return false → challenge never ends).
    if !(pos.entry_price.is_finite()) || pos.entry_price <= 0.0 {
        return EffPnl {
            raw_pnl: 0.0,
            eff_pnl: 0.0,
        };
    }
    // R29-Audit-Round1-A1.1: same guard for exit_price. A NaN/negative exit
    // price (e.g. stale last_known_price persisted from a corrupt feed)
    // would produce raw_pnl=NaN. f64::max(NaN, finite) in Rust returns the
    // finite value (≠ JS Math.max(NaN, x)=NaN), so the GAP_TAIL floor
    // silently flips a NaN PnL into a -1.5R loss — a real TS↔Rust parity
    // drift. Early-out with zero PnL matches TS-engine `if (!isFinite(...))
    // continue` short-circuits elsewhere.
    if !(exit_price.is_finite()) || exit_price <= 0.0 {
        return EffPnl {
            raw_pnl: 0.0,
            eff_pnl: 0.0,
        };
    }
    let mut raw_pnl = match pos.direction {
        PositionSide::Long => (exit_price - pos.entry_price) / pos.entry_price,
        PositionSide::Short => (pos.entry_price - exit_price) / pos.entry_price,
    };
    if pos.ptp_triggered {
        if let Some(ptp) = cfg.partial_take_profit {
            let cf = ptp.close_fraction;
            raw_pnl = pos.ptp_realized_pct + (1.0 - cf) * raw_pnl;
        }
    } else if pos.ptp_levels_realized > 0.0 {
        if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
            let total_closed: f64 = levels
                .iter()
                .take(pos.ptp_level_idx)
                .map(|l| l.close_fraction)
                .sum();
            raw_pnl = pos.ptp_levels_realized + (1.0 - total_closed) * raw_pnl;
        }
    }

    // R67-r18 BIT-PRECISE parity port from TS `computeEffPnl` lines 1021-1065:
    //   - Per-asset roundtrip cost  (`costBp/10000`) — full position size.
    //   - Per-asset slippage roundtrip × 2 × remainingFraction (PTP partials
    //     already paid their slippage at fill).
    //   - Per-asset swap × N UTC-midnight crossings between entry and exit.
    let asset_cfg = cfg.assets.iter().find(|a| a.symbol == pos.symbol);
    let cost_bp = asset_cfg.and_then(|a| a.cost_bp).unwrap_or(0.0);
    let slip_bp = asset_cfg.and_then(|a| a.slippage_bp).unwrap_or(0.0);
    let swap_bp_per_day = asset_cfg.and_then(|a| a.swap_bp_per_day).unwrap_or(0.0);

    if cost_bp > 0.0 {
        raw_pnl -= cost_bp / 10_000.0;
    }
    if slip_bp > 0.0 {
        let mut remaining_fraction = 1.0_f64;
        if pos.ptp_triggered {
            if let Some(ptp) = cfg.partial_take_profit {
                remaining_fraction = 1.0 - ptp.close_fraction;
            }
        } else if pos.ptp_levels_realized > 0.0 {
            if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
                let total_closed: f64 = levels
                    .iter()
                    .take(pos.ptp_level_idx)
                    .map(|l| l.close_fraction)
                    .sum();
                remaining_fraction = (1.0 - total_closed).max(0.0);
            }
        }
        raw_pnl -= (slip_bp / 10_000.0) * 2.0 * remaining_fraction;
    }
    if swap_bp_per_day > 0.0 {
        if let Some(exit_t) = exit_time {
            const MS_PER_DAY: i64 = 86_400_000;
            // Floor-div on both sides; subtract day-indices to match TS
            // `Math.floor(t/MS_PER_DAY)` semantics for non-negative timestamps.
            let entry_day = pos.entry_time.div_euclid(MS_PER_DAY);
            let exit_day = exit_t.div_euclid(MS_PER_DAY);
            let crossings = (exit_day - entry_day).max(0);
            if crossings > 0 {
                raw_pnl -= (swap_bp_per_day / 10_000.0) * crossings as f64;
            }
        }
    }

    // R29-R3.C: clamp eff_risk to ≥0 when computing the GAP_TAIL floor so a
    // corrupted state with negative eff_risk (e.g. a sizing-factor regression
    // multiplying a positive risk by a negative reentry_scale) can never flip
    // the loss-floor into a profit-floor — that would turn a -150% R loss
    // into a +150% R "gain" silently. The PnL itself uses raw eff_risk for
    // parity with TS, the floor is the defensive clamp.
    // 2026-05-16 Round 8 KRIT FIX (sizing-pnl agent): use the clamped value
    // in the PnL multiplication too. With raw negative eff_risk a positive
    // raw_pnl flips sign (Long winner → "Loss"); the floor (=GAP_TAIL_MULT*0)
    // would NOT catch it because the formula reads max(eff_pnl_neg, 0.0) and
    // the original eff_pnl already passed the floor. Mirror clamp on both
    // sides — TS-parity preserved (raw_pnl unchanged, just NaN/<0 defense).
    let risk_eff = pos.eff_risk.max(0.0);
    let eff_pnl = (raw_pnl * cfg.leverage * risk_eff).max(GAP_TAIL_MULT * risk_eff);
    EffPnl { raw_pnl, eff_pnl }
}

/// 2026-05-13 Round-2 Audit Bug A FIX — funding-cost-deduction port of TS
/// `ftmoDaytrade24h.ts:4819-4862` (R56 audit fix). Walks every 8h settlement
/// boundary in `(entry_time, exit_time]` and deducts the funding rate at the
/// containing bar from raw_pnl.
///
/// Sign convention: positive funding rate ⇒ long pays, short receives.
/// → Long position: raw_pnl -= sum_funding
/// → Short position: raw_pnl += sum_funding
///
/// `funding_series` is forward-filled per-bar (typically from `align_funding`
/// in loader.rs). `bar_open_time_0` is the open_time of `funding_series[0]`.
/// `bar_dur_ms` is the candle duration (e.g. 1_800_000 for 30m).
pub fn compute_eff_pnl_with_funding(
    pos: &OpenPosition,
    exit_price: f64,
    cfg: &EngineConfig,
    exit_time: Option<i64>,
    funding_series: Option<&[Option<f64>]>,
    bar_open_time_0: i64,
    bar_dur_ms: i64,
) -> EffPnl {
    // Compute base PnL via existing path (without funding).
    let mut base = compute_eff_pnl_with_time(pos, exit_price, cfg, exit_time);
    // Funding-cost only when series provided AND exit_time known AND bar_dur valid.
    let (Some(funding), Some(exit_t)) = (funding_series, exit_time) else {
        return base;
    };
    if bar_dur_ms <= 0 || funding.is_empty() {
        return base;
    }
    const EIGHT_H_MS: i64 = 8 * 3_600_000;
    let sign: f64 = match pos.direction {
        PositionSide::Long => 1.0,
        PositionSide::Short => -1.0,
    };
    // 2026-05-13 Codex Round 6 MED FIX (#S7): use STRICT less-than so an
    // entry AT a settlement boundary (00:00 / 08:00 / 16:00 UTC) pays that
    // bucket's funding. The legacy `<=` skipped the boundary settlement.
    // Now matches TS source-of-truth (ftmoDaytrade24h.ts:4908 after Codex
    // Round 6 fix). Economic-correct rule: position held AT settlement
    // pays funding.
    let mut bucket = (pos.entry_time.div_euclid(EIGHT_H_MS)) * EIGHT_H_MS;
    if bucket < pos.entry_time {
        bucket += EIGHT_H_MS;
    }
    let mut sum_funding = 0.0_f64;
    let max_iter = (funding.len() as i64).saturating_add(8);
    let mut iter = 0_i64;
    while bucket <= exit_t && iter < max_iter {
        iter += 1;
        let bar_idx_signed = (bucket - bar_open_time_0).div_euclid(bar_dur_ms);
        if bar_idx_signed >= 0 {
            let bar_idx = bar_idx_signed as usize;
            if bar_idx < funding.len() {
                if let Some(f) = funding[bar_idx] {
                    if f.is_finite() {
                        sum_funding += f;
                    }
                }
            }
        }
        bucket += EIGHT_H_MS;
    }
    if sum_funding != 0.0 {
        base.raw_pnl -= sign * sum_funding;
        // Recompute eff_pnl with same GAP_TAIL floor.
        // 2026-05-20 bug-find round: multiply by the CLAMPED risk, matching the
        // base path (line 143-144, Round-8 KRIT fix). Using raw `pos.eff_risk`
        // here reverted that clamp on the funding code path (the production
        // crypto path) — a negative eff_risk would sign-flip the PnL.
        let risk_eff = pos.eff_risk.max(0.0);
        base.eff_pnl =
            (base.raw_pnl * cfg.leverage * risk_eff).max(GAP_TAIL_MULT * risk_eff);
    }
    base
}

/// Mark-to-market equity = realised + Σ unrealised at the current bar.
/// Mutates `pos.last_known_price` for every position whose source symbol
/// has a price on this tick — TS `ftmoLiveEngineV4.ts` line 605 parity.
/// Positions whose feed is missing this tick are skipped (NOT blended via
/// last_known_price) to match TS `computeMtmEquity` semantics.
pub fn compute_mtm_equity(
    state: &mut EngineState,
    prices_by_source: &HashMap<String, f64>,
    cfg: &EngineConfig,
) -> f64 {
    let mut mtm = state.equity;
    for pos in state.open_positions.iter_mut() {
        // R29-R10 PARITY FIX: TS `computeMtmEquity` (ftmoLiveEngineV4.ts
        // lines 599-605) skips feedless positions outright — it does NOT
        // fall back to last_known_price. The earlier "R67 audit" fallback
        // diverged from TS reference and depressed Rust pass-rate vs TS
        // (47.10% vs 55.88% on R28_V6_PASSLOCK 138-w sweep). Match TS:
        // feed missing on this tick → skip position from MTM blend.
        let price = match prices_by_source.get(&pos.source_symbol).copied() {
            Some(p) if p.is_finite() && p > 0.0 => p,
            _ => continue,
        };
        // TS line 605: track most recent observed close so end-of-window
        // force-close has a fallback. Only updated when feed has a price.
        pos.last_known_price = Some(price);
        // Guard against entry_price ≤ 0 / non-finite (NaN poisoning of
        // state.equity, see compute_eff_pnl).
        if !(pos.entry_price.is_finite()) || pos.entry_price <= 0.0 {
            continue;
        }
        let mut raw_pnl = match pos.direction {
            PositionSide::Long => (price - pos.entry_price) / pos.entry_price,
            PositionSide::Short => (pos.entry_price - price) / pos.entry_price,
        };
        if pos.ptp_triggered {
            if let Some(ptp) = cfg.partial_take_profit {
                let close_frac = ptp.close_fraction;
                raw_pnl = pos.ptp_realized_pct + (1.0 - close_frac) * raw_pnl;
            }
        } else if pos.ptp_levels_realized > 0.0 {
            if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
                let total_closed: f64 = levels
                    .iter()
                    .take(pos.ptp_level_idx)
                    .map(|l| l.close_fraction)
                    .sum();
                raw_pnl = pos.ptp_levels_realized + (1.0 - total_closed) * raw_pnl;
            }
        }
        // R29-R3.C: same defensive clamp as compute_eff_pnl_with_time —
        // negative eff_risk must not invert the unrealised-loss floor.
        // 2026-05-21 bug-find round: multiply by the CLAMPED risk, matching
        // compute_eff_pnl_with_time (line 143-144) and the funding path
        // (line 218-220). Using raw `pos.eff_risk` here re-introduced the
        // sign-flip the Round-8 KRIT fix removed: a negative eff_risk turns a
        // positive raw_pnl into a positive unrealised "gain" (floor uses the
        // clamped value, so it never catches it) → inflated MTM equity / peak
        // → false target-hits and entry-gate corruption.
        let risk_for_floor = pos.eff_risk.max(0.0);
        let unrealised =
            (raw_pnl * cfg.leverage * risk_for_floor).max(GAP_TAIL_MULT * risk_for_floor);
        mtm *= 1.0 + unrealised;
    }
    mtm
}

/// Worst-case intra-bar mark-to-market equity: like `compute_mtm_equity` but
/// each open position is priced at its ADVERSE intra-bar extreme (the bar LOW
/// for longs, the bar HIGH for shorts) instead of the close. Used for the
/// optional intra-bar drawdown check (`cfg.intrabar_dd_check`) so a position
/// that pierces the loss floor mid-bar and recovers by the close is still
/// caught — matching a broker's real-time, tick-by-tick equity monitoring.
///
/// ⚠️ 2026-05-29 KNOWN LIMITATION — over-counts multi-asset drawdown. This sums
/// EVERY open position at its OWN intra-bar extreme, i.e. it assumes all assets
/// hit their worst tick SIMULTANEOUSLY. That is exact for a SINGLE position but
/// a hard upper bound for a basket: real assets do not bottom in the same tick.
/// Empirically (2026-05-29) the single-asset penalty is ~3% relative while a
/// 4-asset basket showed ~19% — ~6× inflation that is pure artifact. So treat
/// this as a single-asset / worst-case tool only; for honest multi-asset
/// pass-rates prefer the close-based MTM (≈ truth minus a small ~3-10% haircut),
/// NOT this. A faithful multi-asset version needs joint sub-bar (e.g. 5m) data.
///
/// READ-ONLY: unlike `compute_mtm_equity` it does NOT write `last_known_price`,
/// so it is safe to call alongside the close-based MTM in the same bar.
/// `intrabar_by_source` maps source symbol → (bar_low, bar_high).
pub fn compute_stress_mtm_equity(
    state: &EngineState,
    intrabar_by_source: &HashMap<String, (f64, f64)>,
    cfg: &EngineConfig,
) -> f64 {
    let mut mtm = state.equity;
    for pos in state.open_positions.iter() {
        let Some(&(low, high)) = intrabar_by_source.get(&pos.source_symbol) else {
            continue;
        };
        let price = match pos.direction {
            PositionSide::Long => low,
            PositionSide::Short => high,
        };
        if !price.is_finite() || price <= 0.0 {
            continue;
        }
        if !pos.entry_price.is_finite() || pos.entry_price <= 0.0 {
            continue;
        }
        let mut raw_pnl = match pos.direction {
            PositionSide::Long => (price - pos.entry_price) / pos.entry_price,
            PositionSide::Short => (pos.entry_price - price) / pos.entry_price,
        };
        // Mirror compute_mtm_equity's PTP-aware blend so a partially-closed
        // position's remaining exposure is sized identically.
        if pos.ptp_triggered {
            if let Some(ptp) = cfg.partial_take_profit {
                let close_frac = ptp.close_fraction;
                raw_pnl = pos.ptp_realized_pct + (1.0 - close_frac) * raw_pnl;
            }
        } else if pos.ptp_levels_realized > 0.0 {
            if let Some(levels) = cfg.partial_take_profit_levels.as_ref() {
                let total_closed: f64 = levels
                    .iter()
                    .take(pos.ptp_level_idx)
                    .map(|l| l.close_fraction)
                    .sum();
                raw_pnl = pos.ptp_levels_realized + (1.0 - total_closed) * raw_pnl;
            }
        }
        let risk_for_floor = pos.eff_risk.max(0.0);
        let unrealised =
            (raw_pnl * cfg.leverage * risk_for_floor).max(GAP_TAIL_MULT * risk_for_floor);
        mtm *= 1.0 + unrealised;
    }
    mtm
}

/// Inline trim — bound `kelly_pnls` and `closed_trades` between saves.
/// Mirrors `trimInline()` in the TS engine.
pub fn trim_inline(state: &mut EngineState, cfg: &EngineConfig) {
    let kelly_window = cfg
        .kelly_sizing
        .as_ref()
        .map(|k| k.window_size)
        .unwrap_or(100);
    let kelly_cap = (kelly_window as usize * 4).max(500);
    if state.kelly_pnls.len() > kelly_cap {
        let drop = state.kelly_pnls.len() - kelly_cap;
        state.kelly_pnls.drain(..drop);
    }
    if state.closed_trades.len() > 200 {
        let drop = state.closed_trades.len() - 200;
        state.closed_trades.drain(..drop);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EngineConfig, PartialTakeProfit};
    use crate::position::{OpenPosition, PositionSide};

    fn base_cfg() -> EngineConfig {
        EngineConfig::r28_v6_passlock_template()
    }

    fn make_pos(direction: PositionSide, entry: f64) -> OpenPosition {
        OpenPosition {
            ticket_id: "t".into(),
            symbol: "BTC-TREND".into(),
            source_symbol: "BTCUSDT".into(),
            direction,
            entry_time: 0,
            entry_price: entry,
            initial_stop_pct: 0.02,
            stop_price: if direction == PositionSide::Long {
                entry * 0.98
            } else {
                entry * 1.02
            },
            tp_price: if direction == PositionSide::Long {
                entry * 1.04
            } else {
                entry * 0.96
            },
            eff_risk: 0.4,
            entry_bar_idx: 0,
            high_watermark: entry,
            be_active: false,
            ptp_triggered: false,
            ptp_realized_pct: 0.0,
            ptp_level_idx: 0,
            ptp_levels_realized: 0.0,
            last_known_price: None,
            trail_active: false,
            trail_peak: 0.0,
        }
    }

    #[test]
    fn eff_pnl_long_winner() {
        let cfg = base_cfg();
        let pos = make_pos(PositionSide::Long, 100.0);
        // +4% raw → 0.04 × 2 (lev) × 0.4 (risk) = 0.032 effPnl
        let r = compute_eff_pnl(&pos, 104.0, &cfg);
        assert!((r.raw_pnl - 0.04).abs() < 1e-12);
        assert!((r.eff_pnl - 0.032).abs() < 1e-12);
    }

    #[test]
    fn eff_pnl_short_winner() {
        let cfg = base_cfg();
        let pos = make_pos(PositionSide::Short, 100.0);
        // Short from 100, exit at 96 → +4% raw → 0.032 effPnl
        let r = compute_eff_pnl(&pos, 96.0, &cfg);
        assert!((r.raw_pnl - 0.04).abs() < 1e-12);
        assert!((r.eff_pnl - 0.032).abs() < 1e-12);
    }

    #[test]
    fn eff_pnl_clamped_at_gap_tail() {
        let cfg = base_cfg();
        let pos = make_pos(PositionSide::Long, 100.0);
        // -10% raw move → -0.10 * 2 * 0.4 = -0.08 — but floor is -1.5 * 0.4 = -0.6
        // So actual loss = -0.08 (within floor).
        let r = compute_eff_pnl(&pos, 90.0, &cfg);
        assert!((r.eff_pnl - -0.08).abs() < 1e-12);
        // -100% raw → -0.4 * 2 = -0.8 raw eff, but floor at -0.6.
        let r = compute_eff_pnl(&pos, 25.0, &cfg);
        assert!((r.eff_pnl - GAP_TAIL_MULT * pos.eff_risk).abs() < 1e-9);
    }

    #[test]
    fn eff_pnl_charges_round_trip_cost_bp() {
        // R67-r18: roundtrip costBp subtracts directly from rawPnl.
        let mut cfg = base_cfg();
        cfg.assets.push(crate::config::AssetConfig {
            symbol: "BTC-TREND".into(),
            cost_bp: Some(30.0), // 30bp roundtrip
            ..Default::default()
        });
        let pos = make_pos(PositionSide::Long, 100.0);
        // raw = 0.04, minus 30bp/10000 = 0.003 → 0.037
        // eff = 0.037 × 2 × 0.4 = 0.0296
        let r = compute_eff_pnl(&pos, 104.0, &cfg);
        assert!((r.raw_pnl - 0.037).abs() < 1e-12, "raw_pnl={}", r.raw_pnl);
        assert!((r.eff_pnl - 0.0296).abs() < 1e-12, "eff_pnl={}", r.eff_pnl);
    }

    #[test]
    fn eff_pnl_charges_slippage_round_trip_full_when_no_ptp() {
        let mut cfg = base_cfg();
        cfg.assets.push(crate::config::AssetConfig {
            symbol: "BTC-TREND".into(),
            slippage_bp: Some(8.0),
            ..Default::default()
        });
        let pos = make_pos(PositionSide::Long, 100.0);
        // raw = 0.04, minus 8bp/10000 × 2 × 1 = 0.0016 → 0.0384
        let r = compute_eff_pnl(&pos, 104.0, &cfg);
        assert!((r.raw_pnl - 0.0384).abs() < 1e-12);
    }

    #[test]
    fn eff_pnl_slippage_only_on_remainder_after_single_ptp() {
        // PTP partial leg already paid its slippage at fill — remainder gets
        // (1 - close_fraction) × 2 × slippage charge.
        let mut cfg = base_cfg();
        cfg.partial_take_profit = Some(crate::config::PartialTakeProfit {
            trigger_pct: 0.02,
            close_fraction: 0.5,
        });
        cfg.assets.push(crate::config::AssetConfig {
            symbol: "BTC-TREND".into(),
            slippage_bp: Some(10.0),
            ..Default::default()
        });
        let mut pos = make_pos(PositionSide::Long, 100.0);
        pos.ptp_triggered = true;
        pos.ptp_realized_pct = 0.5 * 0.02; // 50% closed at +2%
                                           // raw blend: 0.01 + 0.5 × 0.04 = 0.03; minus 10bp/10000 × 2 × 0.5 = 0.001
                                           // → raw 0.029, eff = 0.029 × 2 × 0.4 = 0.0232
        let r = compute_eff_pnl(&pos, 104.0, &cfg);
        assert!((r.raw_pnl - 0.029).abs() < 1e-12, "raw_pnl={}", r.raw_pnl);
        assert!((r.eff_pnl - 0.0232).abs() < 1e-12);
    }

    #[test]
    fn eff_pnl_charges_swap_per_midnight_crossing() {
        // 3 UTC-midnight crossings × 4 bp/day = 12 bp deduction.
        let mut cfg = base_cfg();
        cfg.assets.push(crate::config::AssetConfig {
            symbol: "BTC-TREND".into(),
            swap_bp_per_day: Some(4.0),
            ..Default::default()
        });
        let mut pos = make_pos(PositionSide::Long, 100.0);
        const MS_DAY: i64 = 86_400_000;
        pos.entry_time = 1_700_000_000_000;
        // Exit 3 days later at midnight-crossing = 3 crossings.
        let exit_time = pos.entry_time + 3 * MS_DAY;
        let r = compute_eff_pnl_with_time(&pos, 104.0, &cfg, Some(exit_time));
        // raw = 0.04 - 12bp/10000 = 0.0388
        assert!((r.raw_pnl - 0.0388).abs() < 1e-12, "raw_pnl={}", r.raw_pnl);
    }

    #[test]
    fn eff_pnl_swap_zero_when_intraday() {
        let mut cfg = base_cfg();
        cfg.assets.push(crate::config::AssetConfig {
            symbol: "BTC-TREND".into(),
            swap_bp_per_day: Some(4.0),
            ..Default::default()
        });
        let mut pos = make_pos(PositionSide::Long, 100.0);
        pos.entry_time = 1_700_000_000_000;
        // Same UTC-day exit (no midnight crossing).
        let exit_time = pos.entry_time + 60_000;
        let r = compute_eff_pnl_with_time(&pos, 104.0, &cfg, Some(exit_time));
        assert!((r.raw_pnl - 0.04).abs() < 1e-12);
    }

    #[test]
    fn eff_pnl_combines_cost_slippage_swap_for_passlock_realism() {
        // R67-r18 BIT-PRECISE check vs TS reference: with cost=30, slip=8,
        // swap=4 (typical R28_V6 crypto) on a 4% winner held 1 day:
        //   raw = 0.04 - 0.003 - 0.0016 - 0.0004 = 0.035
        let mut cfg = base_cfg();
        cfg.assets.push(crate::config::AssetConfig {
            symbol: "BTC-TREND".into(),
            cost_bp: Some(30.0),
            slippage_bp: Some(8.0),
            swap_bp_per_day: Some(4.0),
            ..Default::default()
        });
        let mut pos = make_pos(PositionSide::Long, 100.0);
        pos.entry_time = 1_700_000_000_000;
        let exit_time = pos.entry_time + 86_400_000;
        let r = compute_eff_pnl_with_time(&pos, 104.0, &cfg, Some(exit_time));
        assert!((r.raw_pnl - 0.035).abs() < 1e-12, "raw_pnl={}", r.raw_pnl);
        assert!((r.eff_pnl - 0.028).abs() < 1e-12, "eff_pnl={}", r.eff_pnl);
    }

    #[test]
    fn eff_pnl_blends_ptp_partial() {
        let mut cfg = base_cfg();
        cfg.partial_take_profit = Some(PartialTakeProfit {
            trigger_pct: 0.02,
            close_fraction: 0.5,
        });
        let mut pos = make_pos(PositionSide::Long, 100.0);
        pos.ptp_triggered = true;
        pos.ptp_realized_pct = 0.5 * 0.02; // 50% closed at +2%
                                           // Remainder runs to 104 → raw remainder 4% × 50% = 0.02; total = 0.01 + 0.02 = 0.03
        let r = compute_eff_pnl(&pos, 104.0, &cfg);
        assert!((r.raw_pnl - 0.03).abs() < 1e-9);
        // effPnl = 0.03 × 2 × 0.4 = 0.024
        assert!((r.eff_pnl - 0.024).abs() < 1e-9);
    }

    #[test]
    fn mtm_equity_zero_positions_returns_realised() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        state.equity = 1.05;
        let prices = HashMap::new();
        assert_eq!(compute_mtm_equity(&mut state, &prices, &cfg), 1.05);
    }

    #[test]
    fn mtm_equity_blends_unrealised_long() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        let pos = make_pos(PositionSide::Long, 100.0);
        state.open_positions.push(pos);
        let mut prices = HashMap::new();
        prices.insert("BTCUSDT".into(), 102.0);
        let mtm = compute_mtm_equity(&mut state, &prices, &cfg);
        // raw=0.02, eff=0.02*2*0.4=0.016 → mtm = 1.0 * 1.016 = 1.016
        assert!((mtm - 1.016).abs() < 1e-9);
        // last_known_price was tracked
        assert_eq!(state.open_positions[0].last_known_price, Some(102.0));
    }

    #[test]
    fn mtm_equity_skips_feedless_position_no_lkp_fallback() {
        // R29-R10 PARITY: TS computeMtmEquity (ftmoLiveEngineV4.ts L599-605)
        // has NO fallback to lastKnownPrice — feedless positions skipped.
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        let mut pos = make_pos(PositionSide::Long, 100.0);
        pos.last_known_price = Some(50.0); // would imply -50% unrealised loss
        state.open_positions.push(pos);
        let prices = HashMap::new(); // no current price
                                     // Without fallback, MTM unchanged (skips position).
        assert_eq!(compute_mtm_equity(&mut state, &prices, &cfg), state.equity);
    }

    #[test]
    fn mtm_equity_skips_when_no_price_for_symbol() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        state
            .open_positions
            .push(make_pos(PositionSide::Long, 100.0));
        let prices = HashMap::new(); // no price for BTCUSDT
        assert_eq!(compute_mtm_equity(&mut state, &prices, &cfg), state.equity);
    }

    #[test]
    fn trim_inline_caps_buffers() {
        let cfg = base_cfg();
        let mut state = EngineState::initial("x");
        for i in 0..1000 {
            state.kelly_pnls.push(crate::state::KellyPnl {
                close_time: i,
                eff_pnl: 0.0,
            });
        }
        // No kelly_sizing → cap = max(500, 100×4) = 500
        trim_inline(&mut state, &cfg);
        assert_eq!(state.kelly_pnls.len(), 500);
        // Oldest should be dropped — kept the LAST 500 (close_time 500..999)
        assert_eq!(state.kelly_pnls[0].close_time, 500);
    }

    // ────────────────────────────────────────────────────────────────
    // Detector #11 Phase 0 — funding-cost bit-parity test suite.
    // Reference: ftmoDaytrade24h.ts:4888-4937 (post Codex Round 6 #S7).
    // ────────────────────────────────────────────────────────────────

    const BAR_DUR_30M: i64 = 30 * 60 * 1_000;
    const EIGHT_H_MS: i64 = 8 * 3_600 * 1_000;

    fn make_funding(n_bars: usize, overrides: &[(usize, f64)]) -> Vec<Option<f64>> {
        let mut v = vec![Some(0.0_f64); n_bars];
        for &(idx, rate) in overrides {
            v[idx] = Some(rate);
        }
        v
    }

    fn ts_reference_funding_walk(
        entry_time: i64,
        exit_time: i64,
        funding: &[Option<f64>],
        bar0_open: i64,
        bar_dur_ms: i64,
    ) -> (f64, usize) {
        let mut bucket = entry_time.div_euclid(EIGHT_H_MS) * EIGHT_H_MS;
        if bucket < entry_time {
            bucket += EIGHT_H_MS;
        }
        let mut sum = 0.0_f64;
        let mut n = 0usize;
        let max_iter = funding.len() + 8;
        let mut iter = 0usize;
        while bucket <= exit_time && iter < max_iter {
            iter += 1;
            let bar_idx_signed = (bucket - bar0_open).div_euclid(bar_dur_ms);
            if bar_idx_signed >= 0 {
                let bar_idx = bar_idx_signed as usize;
                if bar_idx < funding.len() {
                    if let Some(f) = funding[bar_idx] {
                        if f.is_finite() {
                            sum += f;
                            n += 1;
                        }
                    }
                }
            }
            bucket += EIGHT_H_MS;
        }
        (sum, n)
    }

    #[test]
    fn funding_parity_entry_at_8h_boundary_pays_that_bucket() {
        let cfg = base_cfg();
        let mut pos = make_pos(PositionSide::Long, 100.0);
        let boundary = (1_700_000_000_000_i64 / EIGHT_H_MS) * EIGHT_H_MS;
        pos.entry_time = boundary;
        let bar0_open = boundary;
        let exit_time = boundary + EIGHT_H_MS;
        let funding = make_funding(50, &[(0, 0.0001), (16, 0.0002)]);
        let (sum_ref, n_buckets) =
            ts_reference_funding_walk(pos.entry_time, exit_time, &funding, bar0_open, BAR_DUR_30M);
        assert_eq!(n_buckets, 2);
        assert!((sum_ref - 0.0003).abs() < 1e-15);
        let r = compute_eff_pnl_with_funding(
            &pos,
            104.0,
            &cfg,
            Some(exit_time),
            Some(&funding),
            bar0_open,
            BAR_DUR_30M,
        );
        let expected_raw = 0.04 - 0.0003;
        assert!(
            (r.raw_pnl - expected_raw).abs() < 1e-12,
            "raw_pnl={} expected={}",
            r.raw_pnl,
            expected_raw
        );
    }

    #[test]
    fn funding_parity_three_bucket_mixed_signs() {
        let cfg = base_cfg();
        let mut pos = make_pos(PositionSide::Long, 100.0);
        let bar0_open = (1_700_000_000_000_i64 / EIGHT_H_MS) * EIGHT_H_MS;
        pos.entry_time = bar0_open + BAR_DUR_30M;
        let exit_time = bar0_open + 3 * EIGHT_H_MS;
        let funding = make_funding(
            100,
            &[(16, 0.0001), (32, -0.0002), (48, 0.00015)],
        );
        let (sum_ref, n_buckets) =
            ts_reference_funding_walk(pos.entry_time, exit_time, &funding, bar0_open, BAR_DUR_30M);
        assert_eq!(n_buckets, 3);
        let expected_sum = 0.0001 - 0.0002 + 0.00015;
        assert!((sum_ref - expected_sum).abs() < 1e-15);
        let r = compute_eff_pnl_with_funding(
            &pos,
            104.0,
            &cfg,
            Some(exit_time),
            Some(&funding),
            bar0_open,
            BAR_DUR_30M,
        );
        let expected_raw = 0.04 - expected_sum;
        assert!(
            (r.raw_pnl - expected_raw).abs() < 1e-12,
            "raw_pnl={} expected={}",
            r.raw_pnl,
            expected_raw
        );
    }

    #[test]
    fn funding_parity_short_position_symmetric() {
        let cfg = base_cfg();
        let mut pos = make_pos(PositionSide::Short, 100.0);
        let bar0_open = (1_700_000_000_000_i64 / EIGHT_H_MS) * EIGHT_H_MS;
        pos.entry_time = bar0_open + BAR_DUR_30M;
        let exit_time = bar0_open + 2 * EIGHT_H_MS;
        let funding = make_funding(100, &[(16, 0.0001), (32, 0.0002)]);
        let (sum_ref, n_buckets) =
            ts_reference_funding_walk(pos.entry_time, exit_time, &funding, bar0_open, BAR_DUR_30M);
        assert_eq!(n_buckets, 2);
        assert!((sum_ref - 0.0003).abs() < 1e-15);
        let r = compute_eff_pnl_with_funding(
            &pos,
            96.0,
            &cfg,
            Some(exit_time),
            Some(&funding),
            bar0_open,
            BAR_DUR_30M,
        );
        let expected_raw = 0.04 + 0.0003;
        assert!(
            (r.raw_pnl - expected_raw).abs() < 1e-12,
            "raw_pnl={} expected={}",
            r.raw_pnl,
            expected_raw
        );
    }

    #[test]
    fn funding_parity_empty_series_identical_to_with_time() {
        let cfg = base_cfg();
        let mut pos = make_pos(PositionSide::Long, 100.0);
        pos.entry_time = 1_700_000_000_000;
        let exit_time = pos.entry_time + 86_400_000;
        let baseline = compute_eff_pnl_with_time(&pos, 104.0, &cfg, Some(exit_time));
        let with_none = compute_eff_pnl_with_funding(
            &pos,
            104.0,
            &cfg,
            Some(exit_time),
            None,
            pos.entry_time,
            BAR_DUR_30M,
        );
        assert_eq!(baseline.raw_pnl, with_none.raw_pnl);
        assert_eq!(baseline.eff_pnl, with_none.eff_pnl);
        let empty: Vec<Option<f64>> = vec![];
        let with_empty = compute_eff_pnl_with_funding(
            &pos,
            104.0,
            &cfg,
            Some(exit_time),
            Some(&empty),
            pos.entry_time,
            BAR_DUR_30M,
        );
        assert_eq!(baseline.raw_pnl, with_empty.raw_pnl);
        assert_eq!(baseline.eff_pnl, with_empty.eff_pnl);
    }

    #[test]
    fn funding_parity_exit_equals_entry_yields_zero_funding() {
        let cfg = base_cfg();
        let mut pos = make_pos(PositionSide::Long, 100.0);
        let bar0_open = (1_700_000_000_000_i64 / EIGHT_H_MS) * EIGHT_H_MS;
        pos.entry_time = bar0_open + 60_000;
        let exit_time = pos.entry_time;
        let funding = make_funding(50, &[(0, 0.0001), (16, 0.0002)]);
        let (_, n_buckets) =
            ts_reference_funding_walk(pos.entry_time, exit_time, &funding, bar0_open, BAR_DUR_30M);
        assert_eq!(n_buckets, 0);
        let r = compute_eff_pnl_with_funding(
            &pos,
            104.0,
            &cfg,
            Some(exit_time),
            Some(&funding),
            bar0_open,
            BAR_DUR_30M,
        );
        assert!((r.raw_pnl - 0.04).abs() < 1e-12);
        // Entry-on-boundary, exit==entry: exactly 1 bucket visited.
        pos.entry_time = bar0_open;
        let exit_time_b = pos.entry_time;
        let (sum_b, n_b) =
            ts_reference_funding_walk(pos.entry_time, exit_time_b, &funding, bar0_open, BAR_DUR_30M);
        assert_eq!(n_b, 1);
        assert!((sum_b - 0.0001).abs() < 1e-15);
        let r_b = compute_eff_pnl_with_funding(
            &pos,
            104.0,
            &cfg,
            Some(exit_time_b),
            Some(&funding),
            bar0_open,
            BAR_DUR_30M,
        );
        assert!((r_b.raw_pnl - (0.04 - 0.0001)).abs() < 1e-12);
    }

    #[test]
    fn funding_parity_reference_walker_matches_engine_across_random_cases() {
        let cfg = base_cfg();
        let bar0_open = (1_700_000_000_000_i64 / EIGHT_H_MS) * EIGHT_H_MS;
        let funding = make_funding(
            200,
            &[
                (16, 0.00007),
                (32, -0.00015),
                (48, 0.00022),
                (64, -0.00009),
                (80, 0.00004),
            ],
        );
        let cases: &[(PositionSide, i64, i64)] = &[
            (PositionSide::Long, BAR_DUR_30M, 4 * EIGHT_H_MS),
            (PositionSide::Long, 0, EIGHT_H_MS),
            (PositionSide::Short, BAR_DUR_30M * 3, 2 * EIGHT_H_MS),
            (PositionSide::Short, EIGHT_H_MS / 2, 3 * EIGHT_H_MS),
            (PositionSide::Long, 7 * EIGHT_H_MS / 8, 5 * EIGHT_H_MS),
            (PositionSide::Long, 0, 0),
        ];
        for (i, (dir, entry_off, exit_off)) in cases.iter().enumerate() {
            let mut pos = make_pos(*dir, 100.0);
            pos.entry_time = bar0_open + entry_off;
            let exit_time = bar0_open + exit_off;
            let exit_price = match dir {
                PositionSide::Long => 104.0,
                PositionSide::Short => 96.0,
            };
            let (sum_ref, _) = ts_reference_funding_walk(
                pos.entry_time,
                exit_time,
                &funding,
                bar0_open,
                BAR_DUR_30M,
            );
            let sign = match dir {
                PositionSide::Long => 1.0,
                PositionSide::Short => -1.0,
            };
            let expected_raw = 0.04 - sign * sum_ref;
            let r = compute_eff_pnl_with_funding(
                &pos,
                exit_price,
                &cfg,
                Some(exit_time),
                Some(&funding),
                bar0_open,
                BAR_DUR_30M,
            );
            assert!(
                (r.raw_pnl - expected_raw).abs() < 1e-12,
                "case {}: raw_pnl={} expected={}",
                i,
                r.raw_pnl,
                expected_raw
            );
        }
    }
}
