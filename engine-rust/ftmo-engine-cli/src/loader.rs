//! Candle loaders. JSON is the production cache format
//! (`scripts/cache_bakeoff/{SYMBOL}_{TF}.json`); CSV support reads
//! Binance-style `klines`-export rows (no header).

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use anyhow::{Context, Result};
use ftmo_engine_core::Candle;

pub fn load_candles_json(path: &Path) -> Result<Vec<Candle>> {
    let f = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let reader = BufReader::new(f);
    let candles: Vec<Candle> = serde_json::from_reader(reader)
        .with_context(|| format!("parsing JSON candles in {}", path.display()))?;
    Ok(candles)
}

/// Binance kline CSV row. Header expected:
///   `open_time,open,high,low,close,volume[,close_time,...]`
/// or no header at all (column order positional). We use `csv::ReaderBuilder`
/// with `has_headers = false` so positional reads work regardless.
pub fn load_candles_csv(path: &Path) -> Result<Vec<Candle>> {
    let f = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(BufReader::new(f));
    let mut out: Vec<Candle> = Vec::new();
    for (i, rec) in rdr.records().enumerate() {
        let rec = rec.with_context(|| format!("row {i} in {}", path.display()))?;
        if rec.len() < 6 {
            anyhow::bail!("row {i}: expected ≥6 columns, got {}", rec.len());
        }
        // Skip a header row if first column doesn't parse as a number.
        let Ok(open_time) = rec[0].parse::<i64>() else {
            if i == 0 {
                continue;
            }
            anyhow::bail!("row {i}: open_time not parseable as i64: {:?}", &rec[0]);
        };
        let mut c = Candle::new(
            open_time,
            rec[1].parse()?,
            rec[2].parse()?,
            rec[3].parse()?,
            rec[4].parse()?,
            rec[5].parse().unwrap_or(0.0),
        );
        if rec.len() >= 7 {
            c.close_time = rec[6].parse().unwrap_or(0);
        }
        out.push(c);
    }
    Ok(out)
}

/// Auto-detect: read by extension. `.json` → JSON; `.csv` or anything else → CSV.
pub fn load_candles(path: &Path) -> Result<Vec<Candle>> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("json") => load_candles_json(path),
        _ => load_candles_csv(path),
    }
}

/// Load several symbols from a directory using filename convention
/// `{SYMBOL}_{TIMEFRAME}.json` (e.g. `BTCUSDT_30m.json`).
#[allow(dead_code)]
pub fn load_basket(
    dir: &Path,
    symbols: &[&str],
    timeframe: &str,
) -> Result<std::collections::HashMap<String, Vec<Candle>>> {
    let mut out = std::collections::HashMap::new();
    for sym in symbols {
        let p = dir.join(format!("{sym}_{timeframe}.json"));
        let candles = load_candles_json(&p)?;
        out.insert((*sym).to_string(), candles);
    }
    Ok(out)
}
