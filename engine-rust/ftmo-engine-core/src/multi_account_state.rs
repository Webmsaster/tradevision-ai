//! Stack-4 multi-account state wrapper (Step 1 of the refactor plan in
//! `docs/STACK4_REFACTOR_PLAN.md`).
//!
//! This module is FOUNDATIONAL ONLY — it is not yet wired into harness,
//! sweep, or live executor. It defines the data structure that future
//! sprints will use to run N independent FTMO strategies against shared
//! candle/funding feeds, with per-account equity / DL / TL / PASSLOCK /
//! mutex evaluation.
//!
//! Why a wrapper instead of `Vec<EngineState>` directly: callers need
//! O(1) lookup by `account_id` string (used in CLI flags, JSON output,
//! live-state per-account dirs), and a single place to enforce the
//! "no duplicate account_id" invariant. The internal storage stays a
//! `Vec` because typical N is 1-8 and order matters for deterministic
//! CSV output.

use crate::state::EngineState;

#[derive(Debug)]
pub struct MultiAccountState {
    /// One `EngineState` per account. Vec preserves caller insertion
    /// order so per-account CSV output stays stable across runs.
    states: Vec<(String, EngineState)>,
}

impl MultiAccountState {
    /// Create a fresh wrapper from a list of `(account_id, cfg_label)`
    /// pairs. Each account starts at equity=1.0 with no open positions.
    /// Panics on duplicate `account_id` — the invariant that callers can
    /// rely on `get(id)` returning the unique state for that id.
    pub fn initial(accounts: &[(impl AsRef<str>, impl AsRef<str>)]) -> Self {
        let mut seen: std::collections::HashSet<String> =
            std::collections::HashSet::with_capacity(accounts.len());
        let mut states = Vec::with_capacity(accounts.len());
        for (id, lbl) in accounts {
            let id_s = id.as_ref().to_string();
            assert!(
                seen.insert(id_s.clone()),
                "duplicate account_id `{}` — MultiAccountState requires unique ids",
                id_s
            );
            states.push((id_s, EngineState::initial(lbl.as_ref())));
        }
        Self { states }
    }

    /// O(N) lookup by account_id. Returns `None` when no match. N is
    /// expected to be ≤ 8 so linear scan beats a HashMap allocation.
    pub fn get(&self, account_id: &str) -> Option<&EngineState> {
        self.states
            .iter()
            .find(|(id, _)| id == account_id)
            .map(|(_, s)| s)
    }

    pub fn get_mut(&mut self, account_id: &str) -> Option<&mut EngineState> {
        self.states
            .iter_mut()
            .find(|(id, _)| id == account_id)
            .map(|(_, s)| s)
    }

    /// Iterate all `(account_id, &mut EngineState)`. Used by the
    /// per-account step_bar loop in Step 3 of the refactor.
    pub fn each_mut(&mut self) -> impl Iterator<Item = (&str, &mut EngineState)> {
        self.states.iter_mut().map(|(id, s)| (id.as_str(), s))
    }

    /// Iterate read-only — used for aggregate reporting (sum equities,
    /// count surviving accounts, etc.) without mutating any state.
    pub fn each(&self) -> impl Iterator<Item = (&str, &EngineState)> {
        self.states.iter().map(|(id, s)| (id.as_str(), s))
    }

    pub fn len(&self) -> usize {
        self.states.len()
    }

    pub fn is_empty(&self) -> bool {
        self.states.is_empty()
    }

    /// Account IDs in insertion order — useful for CSV header generation.
    pub fn account_ids(&self) -> impl Iterator<Item = &str> {
        self.states.iter().map(|(id, _)| id.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_builds_unique_accounts() {
        let m = MultiAccountState::initial(&[
            ("acct_a", "AMBER"),
            ("acct_b", "RUBIN"),
            ("acct_c", "TITANIUM"),
        ]);
        assert_eq!(m.len(), 3);
        assert!(m.get("acct_a").is_some());
        assert!(m.get("acct_b").is_some());
        assert!(m.get("acct_c").is_some());
        assert!(m.get("acct_unknown").is_none());
    }

    #[test]
    #[should_panic(expected = "duplicate account_id")]
    fn duplicate_account_id_panics() {
        let _ = MultiAccountState::initial(&[
            ("acct_a", "AMBER"),
            ("acct_a", "RUBIN"), // duplicate id → panic
        ]);
    }

    #[test]
    fn each_mut_preserves_insertion_order() {
        let mut m = MultiAccountState::initial(&[
            ("acct_a", "AMBER"),
            ("acct_b", "RUBIN"),
        ]);
        let ids: Vec<String> = m
            .each_mut()
            .map(|(id, _)| id.to_string())
            .collect();
        assert_eq!(ids, vec!["acct_a", "acct_b"]);
    }

    #[test]
    fn mutations_through_get_mut_persist() {
        let mut m = MultiAccountState::initial(&[("acct_a", "AMBER")]);
        let s = m.get_mut("acct_a").unwrap();
        let original_equity = s.equity;
        s.equity = 1.05;
        // Re-look up the same account — should see the mutation.
        assert!((m.get("acct_a").unwrap().equity - 1.05).abs() < 1e-12);
        assert_ne!(original_equity, 1.05);
    }
}
