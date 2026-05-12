#![no_main]

use libfuzzer_sys::fuzz_target;

// Try parsing arbitrary input as an EngineState — must never panic, only Err.
fuzz_target!(|data: &[u8]| {
    let _ = serde_json::from_slice::<ftmo_engine_core::state::EngineState>(data);
});
