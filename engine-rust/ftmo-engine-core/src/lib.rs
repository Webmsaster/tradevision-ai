// Cosmetic-only clippy lints — the codebase uses domain-specific digit
// grouping (e.g. `100_000` for big-number readability vs `1_000_000`)
// and multi-line doc comments where strict indentation hurts readability.
#![allow(clippy::inconsistent_digit_grouping)]
#![allow(clippy::doc_lazy_continuation)]
#![allow(clippy::doc_overindented_list_items)]

pub mod candle;
pub mod config;
pub mod detector_filters;
pub mod drift;
pub mod engine;
pub mod exit;
pub mod harness;
pub mod indicators;
pub mod ml_gate;
pub mod news;
pub mod persist;
pub mod pnl;
pub mod position;
pub mod reconcile;
pub mod result;
pub mod signal;
pub mod signals_bb_zscore_mr;
pub mod signals_breakout;
pub mod signals_forex_mr;
pub mod signals_meanrev;
pub mod signals_ofi;
pub mod signals_r28v6;
pub mod signals_r29r5;
pub mod signals_regime_confluence;
pub mod signals_stablecoin_flow;
pub mod signals_stop_hunt;
pub mod signals_trend;
pub mod signals_v12;
pub mod sizing;
pub mod state;
pub mod templates;
pub mod time_util;
pub mod trade;
pub mod v5r;

pub use candle::Candle;
pub use config::{
    AdaptiveSizingTier, AssetConfig, AtrStop, BreakEven, ChandelierExit, CorrelationFilter,
    CrossAssetFilter, DailyEquityGuardian, DayProgressiveTier, DrawdownShield, EngineConfig,
    FundingRateFilter, IntradayDailyLossThrottle, KellySizing, KellyTier, LiveCaps,
    LossStreakCooldown, MeanReversionSource, PartialTakeProfit, PartialTakeProfitLevel,
    PeakDrawdownThrottle, PeakTrailingStop, PingReliability, ReentryAfterStop, TimeBoost,
    VolAdaptiveTpMult,
};
pub use engine::run_window;
pub use position::{OpenPosition, PositionSide};
pub use result::{FailReason, WindowResult};
pub use state::{
    EngineState, KellyPnl, LossStreakEntry, ReentryState, StoppedReason, SCHEMA_VERSION,
};
pub use trade::{ClosedTrade, ExitReason};
