use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailReason {
    DailyLoss,
    TotalLoss,
    GiveBack,
    InsufficientDays,
    Time,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowResult {
    pub passed: bool,
    pub fail_reason: Option<FailReason>,
    pub final_equity_pct: f64,
    pub max_drawdown_pct: f64,
    pub days_to_pass: Option<u32>,
    pub trades_taken: u32,
    pub max_single_loss_pct: f64,
}
