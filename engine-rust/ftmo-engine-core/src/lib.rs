pub mod candle;
pub mod config;
pub mod detector_filters;
pub mod engine;
pub mod exit;
pub mod drift;
pub mod harness;
pub mod indicators;
pub mod news;
pub mod persist;
pub mod reconcile;
pub mod pnl;
pub mod position;
pub mod result;
pub mod signal;
pub mod signals_breakout;
pub mod signals_meanrev;
pub mod signals_r28v6;
pub mod signals_trend;
pub mod sizing;
pub mod state;
pub mod templates;
pub mod time_util;
pub mod v5r;
pub mod trade;

pub use candle::Candle;
pub use config::{
    AdaptiveSizingTier, AssetConfig, AtrStop, BreakEven, ChandelierExit, CorrelationFilter,
    CrossAssetFilter, DailyEquityGuardian, DayProgressiveTier, DrawdownShield, EngineConfig,
    IntradayDailyLossThrottle, KellySizing, KellyTier, LiveCaps, LossStreakCooldown,
    MeanReversionSource, PartialTakeProfit, PartialTakeProfitLevel, PeakDrawdownThrottle,
    PeakTrailingStop, PingReliability, ReentryAfterStop, TimeBoost, VolAdaptiveTpMult,
};
pub use engine::run_window;
pub use position::{OpenPosition, PositionSide};
pub use result::{FailReason, WindowResult};
pub use state::{EngineState, KellyPnl, LossStreakEntry, ReentryState, StoppedReason, SCHEMA_VERSION};
pub use trade::{ClosedTrade, ExitReason};
