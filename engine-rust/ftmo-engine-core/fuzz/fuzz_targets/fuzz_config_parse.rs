#![no_main]

use libfuzzer_sys::fuzz_target;

// Try parsing arbitrary input as an EngineConfig — must never panic.
fuzz_target!(|data: &[u8]| {
    let _ = serde_json::from_slice::<ftmo_engine_core::config::EngineConfig>(data);
});
