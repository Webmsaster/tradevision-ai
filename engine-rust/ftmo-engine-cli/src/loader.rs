//! Candle loaders. JSON is the production cache format
//! (`scripts/cache_bakeoff/{SYMBOL}_{TF}.json`); CSV support reads
//! Binance-style `klines`-export rows (no header).

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use anyhow::{Context, Result};
use ftmo_engine_core::Candle;

/// 2026-05-23 Wave2 helper. Inspects `path` mtime and:
/// - WARN-only when age >= ENGINE_CACHE_WARN_DAYS (default 7);
/// - HARD-FAIL (anyhow Err on caller) when ENGINE_CACHE_STRICT=1 AND
///   age >= ENGINE_CACHE_STRICT_DAYS (default 14).
/// Silent no-op when path mtime is unreadable or env vars unset.
fn cache_age_check(path: &Path) {
    let warn_days: u64 = std::env::var("ENGINE_CACHE_WARN_DAYS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7);
    let strict = std::env::var("ENGINE_CACHE_STRICT").unwrap_or_default() == "1";
    let strict_days: u64 = std::env::var("ENGINE_CACHE_STRICT_DAYS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(14);
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(modified) = meta.modified() {
            if let Ok(age) = std::time::SystemTime::now().duration_since(modified) {
                let age_days = age.as_secs() / 86_400;
                if strict && age_days >= strict_days {
                    eprintln!(
                        "[loader] FATAL: cache {} is {}d old (>= ENGINE_CACHE_STRICT_DAYS={}). \
                         Run scripts/cache_updater.py before re-running.",
                        path.display(), age_days, strict_days
                    );
                    std::process::exit(2);
                }
                if age_days >= warn_days {
                    eprintln!(
                        "[loader] WARN: cache {} is {}d old (>= {}d). Consider rerunning \
                         scripts/cache_updater.py before trusting these results.",
                        path.display(), age_days, warn_days
                    );
                }
            }
        }
    }
}


pub fn load_candles_json(path: &Path) -> Result<Vec<Candle>> {
    let f = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let reader = BufReader::new(f);
    // 2026-05-23 Wave2 fix (KRIT — Champion-Debunk #5 repeats): cache-age
    // gate. Without this an N-day-stale cache silently feeds backtests, which
    // is exactly the failure mode that produced the 2026-05-05 stale-cache
    // disaster (+17pp inflated R28_V6 claim). WARN at 7d, HARD-FAIL when
    // `ENGINE_CACHE_STRICT=1` is set in env (used in CI + overnight hunters).
    cache_age_check(path);
    let mut candles: Vec<Candle> = serde_json::from_reader(reader)
        .with_context(|| format!("parsing JSON candles in {}", path.display()))?;
    // 2026-05-13 Codex Round 8 HIGH FIX: filter non-final tail bars. 9/24
    // cache files have `isFinal: false` at last index (mid-bar live-write).
    // TS `ftmoLiveSignalV4Wrapper.ts:68` filters; Rust didn't → last-window
    // detector saw partial OHLC of in-progress candle → non-deterministic
    // signal on step=1 sweeps last window.
    let before = candles.len();
    candles.retain(|c| c.is_final);
    let dropped_nonfinal = before - candles.len();
    if dropped_nonfinal > 0 {
        eprintln!(
            "[loader] dropped {dropped_nonfinal} non-final tail bar(s) from {}",
            path.display()
        );
    }
    // 2026-05-16 Round 8 HIGH FIX: reject candles with NaN/Inf/negative-price/
    // inverted HL. Detectors compute `(high-low)/close`; NaN propagates as
    // false on all comparisons → signals silently dormant. Same failure mode
    // the R7 funding/top_ls/cb_premium guards prevent, but one layer deeper.
    let before2 = candles.len();
    candles.retain(|c| {
        c.open.is_finite()
            && c.high.is_finite()
            && c.low.is_finite()
            && c.close.is_finite()
            && c.high >= c.low
            && c.close > 0.0
            && c.open > 0.0
    });
    let dropped_corrupt = before2 - candles.len();
    if dropped_corrupt > 0 {
        eprintln!(
            "[loader] dropped {dropped_corrupt} corrupt (NaN/Inf/inverted-HL/non-positive) bar(s) from {}",
            path.display()
        );
    }
    // 2026-05-16 Round 8 MED FIX: bar-duration consistency. Pre-fix only the
    // first two bars defined `bar_dur_ms` for funding/cb_premium/top_ls/
    // stablecoin alignment. A 5m-vs-30m silent concat-bug would calibrate
    // alignment on the first delta and miscount everything after. Warn loudly
    // if >0.5% of bars deviate from the modal delta.
    if candles.len() >= 3 {
        let mut deltas: Vec<i64> = candles
            .windows(2)
            .map(|w| w[1].open_time - w[0].open_time)
            .collect();
        // Modal delta via simple sort+middle (deterministic).
        let mut sorted = deltas.clone();
        sorted.sort_unstable();
        let modal = sorted[sorted.len() / 2];
        deltas.retain(|&d| d != modal);
        let off_count = deltas.len();
        let off_pct = (off_count as f64) / (candles.len() - 1).max(1) as f64;
        if off_pct > 0.005 {
            eprintln!(
                "[loader] WARN: bar-duration drift in {} — {off_count} of {} deltas differ from modal {modal}ms ({:.2}%). Possible concat-bug (5m+30m mix).",
                path.display(),
                candles.len() - 1,
                off_pct * 100.0
            );
        }
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
    // 2026-05-23 Wave2 fix: gate funding cache age too (Champion-Debunk #5
    // root cause was stale funding + stale candles combined).
    cache_age_check(&p);
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
    // 2026-05-23 Wave2 fix: funding cursor assumes monotone-increasing `t`.
    // An out-of-order entry would silently drop all later events
    // (`funding[f_idx].t < upper` fails on the spike, cursor stuck) →
    // ~all-bar-NaN funding for the rest of the series. debug_assert traps in
    // tests + dev builds without runtime cost in release.
    debug_assert!(
        funding.windows(2).all(|w| w[0].t <= w[1].t),
        "align_funding: funding must be monotonically sorted by t"
    );
    for c in candles {
        let t = c.open_time;
        // Boundary-INCLUSIVE: events at [t, t + bar_dur) belong to THIS bar.
        let upper = t + bar_dur_ms;
        while f_idx < funding.len() && funding[f_idx].t < upper {
            // 2026-05-15 (Audit-Round-7 / Agent #5 KRIT): is_finite() guard
            // mirrors `align_stablecoin_supply` (line 333). Upstream cache
            // can emit NaN/Inf for transient feed errors; without this guard
            // the NaN propagates through `cur` to every subsequent bar
            // (sticky) and silently poisons funding-cost deduction —
            // funding-aware detectors see NaN comparisons (always false) and
            // become dormant.
            if funding[f_idx].r.is_finite() {
                cur = Some(funding[f_idx].r);
            }
            f_idx += 1;
        }
        out.push(cur);
    }
    out
}


/// 2026-05-14 Detector #36 — Top-Trader Long/Short Ratio sample. Mirrors
/// the Binance `/futures/data/topLongShortAccountRatio` JSON shape:
/// `{ "t": eventTime_ms, "r": longShortRatio }`. Stored under
/// `scripts/cache_bakeoff/{SYMBOL}_top_ls.json`.
#[allow(dead_code)]
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct TopLsPt {
    pub t: i64,
    pub r: f64,
}

/// Load `{dir}/{symbol}_top_ls.json` if present, else `Ok(None)`. Callers
/// treat None as "no top-trader L/S data for this asset" and the voter
/// becomes dormant (mirrors `load_funding`).
#[allow(dead_code)]
pub fn load_top_ls(dir: &Path, symbol: &str) -> Result<Option<Vec<TopLsPt>>> {
    let p = dir.join(format!("{symbol}_top_ls.json"));
    if !p.exists() {
        return Ok(None);
    }
    let f = File::open(&p).with_context(|| format!("opening {}", p.display()))?;
    let pts: Vec<TopLsPt> = serde_json::from_reader(BufReader::new(f))
        .with_context(|| format!("parsing top-LS JSON in {}", p.display()))?;
    Ok(Some(pts))
}

/// Forward-fill top-trader L/S samples onto candle openTimes. Boundary
/// semantics match `align_funding` post-Codex-Round-8: any event with
/// timestamp `t ∈ [bar_start, bar_start + bar_dur)` is attributed to that
/// bar. Returns `None` for candles before the first sample.
#[allow(dead_code)]
pub fn align_top_ls(candles: &[Candle], pts: &[TopLsPt]) -> Vec<Option<f64>> {
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
        let upper = t + bar_dur_ms;
        while f_idx < pts.len() && pts[f_idx].t < upper {
            // 2026-05-15 (Audit-Round-7 / Agent #5 KRIT): is_finite() guard.
            // Same rationale as align_funding above.
            if pts[f_idx].r.is_finite() {
                cur = Some(pts[f_idx].r);
            }
            f_idx += 1;
        }
        out.push(cur);
    }
    out
}

/// 2026-05-14 Detector #34 — Coinbase-Binance Premium per-bar point. One
/// record per bar:
///   `{ "t": openTime_ms, "premium_pct": (cb_close - bn_close) / bn_close }`
/// Files under `scripts/cache_bakeoff/{SYMBOL}_cb_premium.json` follow this
/// shape (TS ingest script writes the cache; Rust just consumes).
#[allow(dead_code)]
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct CbPremiumPt {
    pub t: i64,
    pub premium_pct: f64,
}

/// Load `{dir}/{symbol}_cb_premium.json` if it exists. Returns `Ok(None)`
/// when the file is missing — callers should treat that as "no Coinbase
/// premium data available" and fall through (the gate becomes dormant
/// rather than hard-failing the sweep). Mirrors `load_funding` shape.
#[allow(dead_code)]
pub fn load_cb_premium(dir: &Path, symbol: &str) -> Result<Option<Vec<CbPremiumPt>>> {
    let p = dir.join(format!("{symbol}_cb_premium.json"));
    if !p.exists() {
        return Ok(None);
    }
    let f = File::open(&p).with_context(|| format!("opening {}", p.display()))?;
    let pts: Vec<CbPremiumPt> = serde_json::from_reader(BufReader::new(f))
        .with_context(|| format!("parsing CB-premium JSON in {}", p.display()))?;
    Ok(Some(pts))
}

/// Align CB-premium samples onto a candle openTime sequence. Each candle
/// at openTime `t` receives the LATEST premium sample whose timestamp lies
/// in `[t, t + bar_dur)`, with forward-fill on later bars (the most recent
/// observed premium carries forward until a new sample lands). Returns
/// `None` for candles strictly before the first observed sample.
///
/// Bar duration is derived from `candles[1].open_time - candles[0].open_time`,
/// falling back to 30min when only one candle is supplied — mirrors the
/// `align_funding` shape exactly so the integration is straightforward.
///
/// LOOKAHEAD safety: a candle never receives a premium sample whose
/// timestamp is BEYOND `bar_start + bar_dur` (i.e. lies in a future bar).
#[allow(dead_code)]
pub fn align_cb_premium(candles: &[Candle], pts: &[CbPremiumPt]) -> Vec<Option<f64>> {
    let mut out = Vec::with_capacity(candles.len());
    let mut p_idx = 0usize;
    let mut cur: Option<f64> = None;
    let bar_dur_ms: i64 = if candles.len() >= 2 {
        (candles[1].open_time - candles[0].open_time).max(1)
    } else {
        30 * 60 * 1000
    };
    for c in candles {
        let t = c.open_time;
        let upper = t + bar_dur_ms;
        while p_idx < pts.len() && pts[p_idx].t < upper {
            // 2026-05-15 (Audit-Round-7 / Agent #5 KRIT): is_finite() guard.
            // Mirrors align_stablecoin_supply and the funding/top_ls fixes
            // above. NaN/Inf in upstream cache → silent voter dormancy.
            if pts[p_idx].premium_pct.is_finite() {
                cur = Some(pts[p_idx].premium_pct);
            }
            p_idx += 1;
        }
        out.push(cur);
    }
    out
}

/// 2026-05-14 Detector #22 — DefiLlama daily stablecoin-supply aggregate
/// point. Source endpoint `/stablecoincharts/all?stablecoin=1` returns one
/// record per day in `{ "date": unix_seconds_str, "totalCirculatingUSD": {...}
/// }` format upstream; the cache-builder converts to the canonical
/// `{ "t": unix_ms, "supply_usd": float }` shape and persists to
/// `data/macro/usdt_supply_daily.json`. Single global file (not per-symbol)
/// because USDT supply is one macro time-series consumed by every asset's
/// regime voter.
#[allow(dead_code)]
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct StablecoinSupplyPt {
    pub t: i64,
    pub supply_usd: f64,
}

/// 2026-05-14 Detector #22 — load `{dir}/macro/usdt_supply_daily.json` if it
/// exists. Returns `Ok(None)` when the file is missing so callers can fall
/// back to "no data → voter dormant" (analog to `load_funding`). The `dir`
/// argument is the cache root; the relative `macro/usdt_supply_daily.json`
/// path keeps the macro feed segregated from per-symbol caches.
#[allow(dead_code)]
pub fn load_stablecoin_supply(dir: &Path) -> Result<Option<Vec<StablecoinSupplyPt>>> {
    let p = dir.join("macro").join("usdt_supply_daily.json");
    if !p.exists() {
        return Ok(None);
    }
    let f = File::open(&p).with_context(|| format!("opening {}", p.display()))?;
    let pts: Vec<StablecoinSupplyPt> = serde_json::from_reader(BufReader::new(f))
        .with_context(|| format!("parsing stablecoin-supply JSON in {}", p.display()))?;
    Ok(Some(pts))
}

/// Forward-fill DefiLlama daily stablecoin-supply points onto a candle
/// openTime sequence. For each candle at time `c.open_time`, find the largest
/// sample-time strictly before `c.open_time + bar_dur` — same boundary-
/// inclusive semantic as `align_funding`. Returns `None` for candles before
/// the first sample. Non-finite `supply_usd` values are filtered at this edge
/// so downstream detectors never see NaN.
#[allow(dead_code)]
pub fn align_stablecoin_supply(
    candles: &[Candle],
    pts: &[StablecoinSupplyPt],
) -> Vec<Option<f64>> {
    let mut out = Vec::with_capacity(candles.len());
    let mut p_idx = 0usize;
    let mut cur: Option<f64> = None;
    let bar_dur_ms: i64 = if candles.len() >= 2 {
        (candles[1].open_time - candles[0].open_time).max(1)
    } else {
        30 * 60 * 1000
    };
    for c in candles {
        let t = c.open_time;
        let upper = t + bar_dur_ms;
        while p_idx < pts.len() && pts[p_idx].t < upper {
            if pts[p_idx].supply_usd.is_finite() {
                cur = Some(pts[p_idx].supply_usd);
            }
            p_idx += 1;
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

    // 2026-05-14 Detector #22 — stablecoin supply alignment mirrors funding
    // semantics (boundary-inclusive forward-fill on `[bar_start, bar_start +
    // bar_dur)`).
    #[test]
    fn align_stablecoin_supply_forward_fills() {
        let pts = vec![
            StablecoinSupplyPt { t: 10, supply_usd: 1.0e11 },
            StablecoinSupplyPt { t: 30, supply_usd: 1.05e11 },
        ];
        let candles: Vec<Candle> = [5, 15, 25, 35, 45].iter().map(|t| candle(*t)).collect();
        let aligned = align_stablecoin_supply(&candles, &pts);
        // bar_dur = 10. bar@5 covers [5,15) → captures sample @10. bar@15
        // covers [15,25) — no sample → carries 1.0e11. bar@25 covers [25,35)
        // → captures @30. Subsequent bars carry forward 1.05e11.
        assert_eq!(
            aligned,
            vec![Some(1.0e11), Some(1.0e11), Some(1.05e11), Some(1.05e11), Some(1.05e11)]
        );
    }

    #[test]
    fn align_stablecoin_supply_filters_non_finite_input() {
        // Upstream cache bug occasionally emits NaN — must be rejected at the
        // loader edge so detectors never see NaN through align.
        let pts = vec![
            StablecoinSupplyPt { t: 10, supply_usd: f64::NAN },
            StablecoinSupplyPt { t: 20, supply_usd: 9.5e10 },
        ];
        let candles: Vec<Candle> = [5, 15, 25].iter().map(|t| candle(*t)).collect();
        let aligned = align_stablecoin_supply(&candles, &pts);
        assert_eq!(aligned, vec![None, Some(9.5e10), Some(9.5e10)]);
    }

    #[test]
    fn align_stablecoin_supply_empty_pts_returns_none() {
        let candles: Vec<Candle> = (0..3).map(candle).collect();
        assert_eq!(align_stablecoin_supply(&candles, &[]), vec![None; 3]);
    }

    // 2026-05-14 Detector #34 — alignment shape tests for CB-premium loader.

    #[test]
    fn align_cb_premium_forward_fills() {
        // bar_dur derives from candles[1] - candles[0]. Use stride 10 so the
        // semantics match `align_funding_forward_fills`.
        let pts = vec![
            CbPremiumPt { t: 10, premium_pct: 0.0015 },
            CbPremiumPt { t: 20, premium_pct: 0.0025 },
            CbPremiumPt { t: 30, premium_pct: 0.0035 },
        ];
        let candles: Vec<Candle> = [5, 15, 25, 35, 45].iter().map(|t| candle(*t)).collect();
        let aligned = align_cb_premium(&candles, &pts);
        assert_eq!(
            aligned,
            vec![
                Some(0.0015),
                Some(0.0025),
                Some(0.0035),
                Some(0.0035),
                Some(0.0035),
            ]
        );
    }

    #[test]
    fn align_cb_premium_empty_pts_returns_none() {
        let candles: Vec<Candle> = (0..5).map(candle).collect();
        let aligned = align_cb_premium(&candles, &[]);
        assert_eq!(aligned, vec![None; 5]);
    }

    #[test]
    fn align_cb_premium_no_pre_event_returns_none() {
        let pts = vec![CbPremiumPt { t: 100, premium_pct: 0.005 }];
        let candles: Vec<Candle> = [10, 20, 30, 100, 110].iter().map(|t| candle(*t)).collect();
        let aligned = align_cb_premium(&candles, &pts);
        assert_eq!(aligned, vec![None, None, None, Some(0.005), Some(0.005)]);
    }
}
