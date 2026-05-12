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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

/// R29-R7 funding-rate point: `{ "t": fundingTime_ms, "r": fundingRate }`.
/// Files under `scripts/cache_bakeoff/{SYMBOL}_funding.json` follow this shape.
#[allow(dead_code)]
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct FundingPt {
    pub t: i64,
    pub r: f64,
}

/// Load `{dir}/{symbol}_funding.json` if it exists. Returns `Ok(None)`
/// when the file is missing — callers should treat that as "no filter
/// data available" and fall through (the gate becomes dormant).
#[allow(dead_code)]
pub fn load_funding(dir: &Path, symbol: &str) -> Result<Option<Vec<FundingPt>>> {
    let p = dir.join(format!("{symbol}_funding.json"));
    if !p.exists() {
        return Ok(None);
    }
    let f = File::open(&p).with_context(|| format!("opening {}", p.display()))?;
    let pts: Vec<FundingPt> = serde_json::from_reader(BufReader::new(f))
        .with_context(|| format!("parsing funding JSON in {}", p.display()))?;
    Ok(Some(pts))
}

/// Forward-fill funding rates onto a candle openTime sequence. For each
/// candle at time `c.open_time`, find the largest fundingTime ≤ openTime
/// — that's the funding-rate active during the candle (paid every 8h cycle).
/// Returns `None` for candles before the first funding event.
///
/// Mirrors `alignFunding` in `scripts/_r29Round7Shard.ts:61-77`.
#[allow(dead_code)]
pub fn align_funding(candles: &[Candle], funding: &[FundingPt]) -> Vec<Option<f64>> {
    let mut out = Vec::with_capacity(candles.len());
    let mut f_idx = 0usize;
    let mut cur: Option<f64> = None;
    for c in candles {
        let t = c.open_time;
        while f_idx < funding.len() && funding[f_idx].t <= t {
            cur = Some(funding[f_idx].r);
            f_idx += 1;
        }
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candle(t: i64) -> Candle {
        Candle::new(t, 1.0, 1.0, 1.0, 1.0, 0.0)
    }

    #[test]
    fn align_funding_forward_fills() {
        // Funding events at t=10, 20, 30 → rates 0.1, 0.2, 0.3.
        let funding = vec![
            FundingPt { t: 10, r: 0.1 },
            FundingPt { t: 20, r: 0.2 },
            FundingPt { t: 30, r: 0.3 },
        ];
        // Candles at t=5 (no event yet), t=15 (event 1), t=25 (event 2),
        // t=35 (event 3), t=40 (still event 3).
        let candles: Vec<Candle> = [5, 15, 25, 35, 40].iter().map(|t| candle(*t)).collect();
        let aligned = align_funding(&candles, &funding);
        assert_eq!(
            aligned,
            vec![None, Some(0.1), Some(0.2), Some(0.3), Some(0.3)]
        );
    }

    #[test]
    fn align_funding_handles_exact_match() {
        // Event-time == openTime → that candle should see the rate
        // (TS uses ≤ not <).
        let funding = vec![FundingPt { t: 100, r: 0.5 }];
        let candles = vec![candle(100), candle(101)];
        let aligned = align_funding(&candles, &funding);
        assert_eq!(aligned, vec![Some(0.5), Some(0.5)]);
    }

    #[test]
    fn align_funding_empty_funding_returns_none() {
        let candles: Vec<Candle> = (0..5).map(candle).collect();
        let aligned = align_funding(&candles, &[]);
        assert_eq!(aligned, vec![None; 5]);
    }
}
