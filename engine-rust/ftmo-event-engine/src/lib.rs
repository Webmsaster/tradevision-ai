//! 2026-05-17 Event-driven backtest engine — SKELETON.
//!
//! Discrete-Event Simulator with priority-queue ordering. Replaces synchronous
//! bar-by-bar polling in `ftmo-engine-core/src/harness.rs`.
//!
//! Events (sorted by ts then by event-type-priority):
//!   - BarClose { ts, symbol, candle }
//!   - SignalEmit { ts, symbol, direction, voter_set }
//!   - FillExecuted { ts, symbol, price, size }
//!   - RiskBreach { ts, type: DailyLoss | TotalLoss }
//!   - FundingDeduct { ts, symbol, amount }
//!   - PassLockTriggered { ts }
//!
//! Lookahead-safe by construction: BarClose[i] MUST be emitted before
//! Signal[i+1] in queue order.
//!
//! STATUS: Skeleton only. Full impl = 5-8 days. Tests in `tests/`.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Debug, Clone)]
pub enum EventType {
    BarClose {
        symbol: String,
        close_price: f64,
        high: f64,
        low: f64,
    },
    SignalEmit {
        symbol: String,
        side: PositionSide,
    },
    FillExecuted {
        symbol: String,
        price: f64,
        size: f64,
    },
    RiskBreach {
        breach_type: BreachType,
    },
    FundingDeduct {
        symbol: String,
        amount: f64,
    },
    PassLockTriggered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionSide {
    Long,
    Short,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreachType {
    DailyLoss,
    TotalLoss,
}

#[derive(Debug, Clone)]
pub struct TimedEvent {
    pub ts_ms: i64,
    pub priority: u8, // tie-break: lower priority fires first at same ts
    pub event: EventType,
}

impl PartialEq for TimedEvent {
    fn eq(&self, other: &Self) -> bool {
        self.ts_ms == other.ts_ms && self.priority == other.priority
    }
}
impl Eq for TimedEvent {}
impl PartialOrd for TimedEvent {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for TimedEvent {
    fn cmp(&self, other: &Self) -> Ordering {
        // BinaryHeap is max-heap; we want min-heap by ts → reverse
        other
            .ts_ms
            .cmp(&self.ts_ms)
            .then(other.priority.cmp(&self.priority))
    }
}

pub struct EventBus {
    queue: BinaryHeap<TimedEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            queue: BinaryHeap::new(),
        }
    }
    pub fn push(&mut self, evt: TimedEvent) {
        self.queue.push(evt);
    }
    pub fn pop(&mut self) -> Option<TimedEvent> {
        self.queue.pop()
    }
    pub fn len(&self) -> usize {
        self.queue.len()
    }
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_ordered_by_timestamp() {
        let mut bus = EventBus::new();
        bus.push(TimedEvent {
            ts_ms: 3000,
            priority: 0,
            event: EventType::PassLockTriggered,
        });
        bus.push(TimedEvent {
            ts_ms: 1000,
            priority: 0,
            event: EventType::PassLockTriggered,
        });
        bus.push(TimedEvent {
            ts_ms: 2000,
            priority: 0,
            event: EventType::PassLockTriggered,
        });
        assert_eq!(bus.pop().unwrap().ts_ms, 1000);
        assert_eq!(bus.pop().unwrap().ts_ms, 2000);
        assert_eq!(bus.pop().unwrap().ts_ms, 3000);
    }

    #[test]
    fn same_ts_uses_priority_tiebreak() {
        let mut bus = EventBus::new();
        bus.push(TimedEvent {
            ts_ms: 1000,
            priority: 5,
            event: EventType::PassLockTriggered,
        });
        bus.push(TimedEvent {
            ts_ms: 1000,
            priority: 1,
            event: EventType::PassLockTriggered,
        });
        // Lower priority fires first at same ts
        assert_eq!(bus.pop().unwrap().priority, 1);
        assert_eq!(bus.pop().unwrap().priority, 5);
    }

    #[test]
    fn lookahead_invariant_bar_before_signal() {
        // BarClose[i] (priority 0) must fire before SignalEmit[i] (priority 1) at same ts
        let mut bus = EventBus::new();
        bus.push(TimedEvent {
            ts_ms: 1000,
            priority: 1,
            event: EventType::SignalEmit {
                symbol: "BTC".into(),
                side: PositionSide::Long,
            },
        });
        bus.push(TimedEvent {
            ts_ms: 1000,
            priority: 0,
            event: EventType::BarClose {
                symbol: "BTC".into(),
                close_price: 100.0,
                high: 101.0,
                low: 99.0,
            },
        });
        let first = bus.pop().unwrap();
        match first.event {
            EventType::BarClose { .. } => {}
            _ => panic!("BarClose must fire first"),
        }
    }
}
