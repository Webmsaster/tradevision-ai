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
    let mut candles: Vec<Candle> = serde_json::from_reader(reader)
        .with_context(|| format!("parsing JSON candles in {}", path.display()))?;
    // 2026-05-13 Codex Round 8 HIGH FIX: filter non-final tail bars. 9/24
    // cache files have `isFinal: false` at last index (mid-bar live-write).
    // TS `ftmoLiveSignalV4Wrapper.ts:68` filters; Rust didn't → last-window
    // detector saw partial OHLC of in-progress candle → non-deterministic
    // signal on step=1 sweeps last window.
    let before = candles.len();
    candles.retain(|c| c.is_final);
    let dropped = before - candles.len();
    if dropped > 0 {
        eprintln!(
            "[loader] dropped {dropped} non-final tail bar(s) from {}",
            path.display()
        );
    }
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
/// candle at time `c.open_time`, find the largest fundingTime in
/// `[..c.open_time + bar_dur)` — i.e. any funding event whose timestamp
/// falls INSIDE the candle's OHLC window is attributed to that candle.
/// Returns `None` for candles before the first funding event.
///
/// 2026-05-13 Codex Round 8 KRITISCH FIX: Binance funding events are
/// timestamped at the EXACT 8h boundary (00:00/08:00/16:00 UTC) but
/// occasional events drift by milliseconds. With strict `<= t` (boundary-
/// inclusive only when `funding.t == candle.open_time` EXACTLY), events
/// at `boundary + 3ms` attributed to the NEXT candle → off-by-one bar in
/// the rate-feed. ~45% of historical events on BTC/AAVE drift past the
/// strict boundary. Fix: attribute any event with `t ∈ [bar_start, bar_start
/// + bar_dur)` to this bar. Derive bar_dur from spacing[1]-spacing[0] of
/// candles; falls back to 30min if only 1 candle.
///
/// Mirrors fixed `alignFunding` in `scripts/_r29Round7Shard.ts:96-112`.
pub fn align_funding(candles: &[Candle], funding: &[FundingPt]) -> Vec<Option<f64>> {
    let mut out = Vec::with_capacity(candles.len());
    let mut f_idx = 0usize;
    let mut cur: Option<f64> = None;
    let bar_dur_ms: i64 = if candles.len() >= 2 {
        (candles[1].open_time - candles[0].open_time).max(1)
    } else {
        30 * 60 * 1000
    };
    for c in candles {
        let t = c.open_time;
        // Boundary-INCLUSIVE: events at [t, t + bar_dur) belong to THIS bar.
        let upper = t + bar_dur_ms;
        while f_idx < funding.len() && funding[f_idx].t < upper {
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
        // 2026-05-13 Codex Round 8 KRITISCH FIX test-update: new semantic
        // is "events in [bar_start, bar_start + bar_dur)" attribute to THIS
        // bar (boundary-inclusive at start). With bar_dur=10 (candles 5/15/25/...):
        //   candle@t=5  covers [5, 15) → captures event@t=10 (rate 0.1).
        //   candle@t=15 covers [15, 25) → captures event@t=20 (rate 0.2).
        //   candle@t=25 covers [25, 35) → captures event@t=30 (rate 0.3).
        //   candle@t=35 covers [35, 45) → no new event → carries forward 0.3.
        let funding = vec![
            FundingPt { t: 10, r: 0.1 },
            FundingPt { t: 20, r: 0.2 },
            FundingPt { t: 30, r: 0.3 },
        ];
        let candles: Vec<Candle> = [5, 15, 25, 35, 45].iter().map(|t| candle(*t)).collect();
        let aligned = align_funding(&candles, &funding);
        assert_eq!(
            aligned,
            vec![Some(0.1), Some(0.2), Some(0.3), Some(0.3), Some(0.3)]
        );
    }

    #[test]
    fn align_funding_no_pre_event_returns_none() {
        // Candles BEFORE the first funding event → None until event lands in window.
        let funding = vec![FundingPt { t: 100, r: 0.5 }];
        let candles: Vec<Candle> = [10, 20, 30, 100, 110].iter().map(|t| candle(*t)).collect();
        let aligned = align_funding(&candles, &funding);
        // bar_dur=10. candle@10 covers [10,20) — no event. ... candle@100 covers [100,110) — event @100.
        assert_eq!(
            aligned,
            vec![None, None, None, Some(0.5), Some(0.5)]
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
