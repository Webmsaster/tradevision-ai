//! Autonomous parameter-tuning for ftmo-sweep. Random search + local
//! refinement around top-K, followed by a strict-pass validation pass.
//!
//! Pipeline:
//!  1. Random phase — broad coverage of the parameter space.
//!  2. Refine phase — Gaussian perturbation around current top-K leaderboard.
//!  3. Validate phase — re-run top-N with `--strict-pass` to filter overfit.
//!
//! The crate exposes both a library (used by integration tests) and the
//! `ftmo-hunter` binary (the CLI entry-point in `main.rs`).

pub mod archive;
pub mod search;
pub mod space;
pub mod trial;
