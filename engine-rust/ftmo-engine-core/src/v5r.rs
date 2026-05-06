//! V5R sister-engine — port of `ftmoLiveEngineV5R.ts`.
//!
//! Structurally V4-equivalent: same data types, same step-bar pipeline.
//! V5R diverges from V4 only in honouring these config flags (all of which
//! the harness already implements):
//!   - `dailyEquityGuardian` — force-close every position when intraday MTM
//!     drops to -trigger_pct from start-of-day
//!   - `dayProgressiveSizing` — multiply asset risk by per-day tier factor
//!   - `reentryAfterStop` — one re-entry slot at sizeMult × original risk
//!   - `bypassLiveCaps` — opt-out of liveCaps clamps for true progressive sizing
//!   - `meanReversionSource` — RSI-cross-driven entries (handled by
//!     `signals_meanrev::detect_mean_reversion`)
//!
//! Therefore "porting V5R" reduces to ensuring the V5R-flagged configs are
//! recognised. This module provides a tiny audit helper + a constructor
//! template that mirrors typical V5R defaults.

use crate::config::{DailyEquityGuardian, EngineConfig, MeanReversionSource};

/// Returns true if `cfg` opts in to any V5R-specific behaviour. Used by
/// callers that want to log "V5R-mode active" or branch their detector
/// pipeline (V4 → trend, V5R → mean-rev + guardian).
pub fn is_v5r_mode(cfg: &EngineConfig) -> bool {
    cfg.daily_equity_guardian.is_some()
        || cfg.bypass_live_caps
        || cfg.day_progressive_sizing.is_some()
        || cfg.reentry_after_stop.is_some()
        || cfg.mean_reversion_source.is_some()
}

/// Default V5R-baseline config: V4 R28_V6 base + reasonable V5R defaults
/// (mirrors the V5R templates in `ftmoLiveEngineV5R.ts`).
pub fn v5r_baseline_template() -> EngineConfig {
    let mut cfg = EngineConfig::r28_v6_passlock_template();
    cfg.label = "V5R_BASELINE".into();
    cfg.daily_equity_guardian = Some(DailyEquityGuardian { trigger_pct: 0.03 });
    cfg.mean_reversion_source = Some(MeanReversionSource {
        period: 14,
        oversold: 25.0,
        overbought: 75.0,
        cooldown_bars: 8,
        size_mult: 0.5,
    });
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_v5r_mode() {
        let v4_cfg = EngineConfig::r28_v6_passlock_template();
        assert!(!is_v5r_mode(&v4_cfg));

        let v5r_cfg = v5r_baseline_template();
        assert!(is_v5r_mode(&v5r_cfg));
        assert!(v5r_cfg.daily_equity_guardian.is_some());
        assert!(v5r_cfg.mean_reversion_source.is_some());
    }
}
