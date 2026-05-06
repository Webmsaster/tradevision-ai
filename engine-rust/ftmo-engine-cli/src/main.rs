use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use ftmo_engine_core::engine::WindowInput;
use ftmo_engine_core::{run_window, EngineConfig};

mod loader;

fn main() -> Result<()> {
    let cfg = EngineConfig::r28_v6_passlock_template();
    println!("ftmo-engine v{} — Phase 1 scaffolding", env!("CARGO_PKG_VERSION"));
    println!("config: {} (start_balance={})", cfg.label, cfg.start_balance);

    let mut bars = BTreeMap::new();

    // Optional: pass `--candles <SYMBOL_TF.json>` to wire a real candle file.
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--candles" => {
                let path = args.next().ok_or_else(|| anyhow!("--candles needs a path"))?;
                let p = PathBuf::from(&path);
                let symbol = p
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| anyhow!("could not derive symbol from path"))?
                    .to_string();
                let candles = loader::load_candles_json(&p)?;
                println!("loaded {} candles for {}", candles.len(), symbol);
                bars.insert(symbol, candles);
            }
            other => return Err(anyhow!("unknown arg: {other}")),
        }
    }

    let result = run_window(WindowInput { config: &cfg, bars_by_symbol: bars });
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
