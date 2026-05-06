//! Detector-side filter helpers — port of the small numerical filters that
//! gate signals inside `detectAsset` in `ftmoDaytrade24h.ts`. Each filter is
//! a pure function so it can be reused by future signal sources without
//! pulling in the entire detector.
//!
//! Indexing matches the indicator convention: `out[i]` aligns with
//! `candles[i]`. Early bars before the warm-up period return `None`.

use crate::candle::Candle;
use crate::indicators::{ema, rsi};
use crate::position::PositionSide;

/// RSI confluence gate. Returns true if the signal at bar `i` is allowed
/// given the current RSI band. Following the V4 convention:
///   - long  → require `rsi[i] <= long_max`  (oversold-confirmation)
///   - short → require `rsi[i] >= short_min` (overbought-confirmation)
/// Either bound being `None` disables that side.
pub fn rsi_filter_allows(
    rsi_value: Option<f64>,
    side: PositionSide,
    long_max: Option<f64>,
    short_min: Option<f64>,
) -> bool {
    let Some(v) = rsi_value else { return false };
    if !v.is_finite() {
        return false;
    }
    match side {
        PositionSide::Long => long_max.map(|max| v <= max).unwrap_or(true),
        PositionSide::Short => short_min.map(|min| v >= min).unwrap_or(true),
    }
}

/// Convenience: build the RSI series and call `rsi_filter_allows` on the
/// last bar.
pub fn rsi_filter_for_last_bar(
    candles: &[Candle],
    period: usize,
    side: PositionSide,
    long_max: Option<f64>,
    short_min: Option<f64>,
) -> bool {
    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let series = rsi(&closes, period);
    let last = series.last().copied().unwrap_or(None);
    rsi_filter_allows(last, side, long_max, short_min)
}

/// Average Directional Index (ADX). Returns the smoothed ADX series with the
/// usual Wilder convention. Output is `Some(value)` once `i + 1 ≥ 2*period`
/// (TR seed + ADX seed).
pub fn adx(candles: &[Candle], period: usize) -> Vec<Option<f64>> {
    let n = candles.len();
    let mut out: Vec<Option<f64>> = vec![None; n];
    if period == 0 || n < period * 2 + 1 {
        return out;
    }
    // True range, +DM, -DM per bar.
    let mut tr = vec![0.0f64; n];
    let mut plus_dm = vec![0.0f64; n];
    let mut minus_dm = vec![0.0f64; n];
    for i in 1..n {
        let cur = &candles[i];
        let prev = &candles[i - 1];
        let high_diff = cur.high - prev.high;
        let low_diff = prev.low - cur.low;
        plus_dm[i] = if high_diff > low_diff && high_diff > 0.0 {
            high_diff
        } else {
            0.0
        };
        minus_dm[i] = if low_diff > high_diff && low_diff > 0.0 {
            low_diff
        } else {
            0.0
        };
        tr[i] = (cur.high - cur.low)
            .max((cur.high - prev.close).abs())
            .max((cur.low - prev.close).abs());
    }
    // Wilder-smooth TR / +DM / -DM.
    let mut atr_w = tr[1..=period].iter().sum::<f64>();
    let mut plus_w = plus_dm[1..=period].iter().sum::<f64>();
    let mut minus_w = minus_dm[1..=period].iter().sum::<f64>();
    let mut dx_series = Vec::with_capacity(n);
    let plus_di = 100.0 * plus_w / atr_w.max(1e-12);
    let minus_di = 100.0 * minus_w / atr_w.max(1e-12);
    let dx0 = if (plus_di + minus_di) > 0.0 {
        100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    } else {
        0.0
    };
    dx_series.push(dx0);
    for i in (period + 1)..n {
        atr_w = atr_w - atr_w / period as f64 + tr[i];
        plus_w = plus_w - plus_w / period as f64 + plus_dm[i];
        minus_w = minus_w - minus_w / period as f64 + minus_dm[i];
        let plus_di = 100.0 * plus_w / atr_w.max(1e-12);
        let minus_di = 100.0 * minus_w / atr_w.max(1e-12);
        let dx = if (plus_di + minus_di) > 0.0 {
            100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di)
        } else {
            0.0
        };
        dx_series.push(dx);
    }
    // Smooth DX with Wilder over `period` to get ADX.
    if dx_series.len() < period {
        return out;
    }
    let mut adx_val = dx_series[..period].iter().sum::<f64>() / period as f64;
    // R67 audit (Round 3): Wilder ADX seed lands at bar `2*period-1`, NOT
    // `2*period`. DX[0] corresponds to candle[period], so DX[period-1] →
    // candle[2*period-1]. The mean of DX[0..period] is the ADX value at
    // the index of the LAST DX-value in the seed window (= 2*period-1).
    // TS engine uses `adxArr[2*period-1]` (indicators.ts:256) — Rust was
    // off-by-one too late, breaking parity for any path that recomputes
    // ADX from candles (signals_r28v6 detect_r28_v6 calls this).
    let first_idx = period * 2 - 1;
    if first_idx < n {
        out[first_idx] = Some(adx_val);
    }
    for (k, &dx) in dx_series.iter().enumerate().skip(period) {
        let i = first_idx + (k - period + 1);
        if i >= n {
            break;
        }
        adx_val = (adx_val * (period as f64 - 1.0) + dx) / period as f64;
        out[i] = Some(adx_val);
    }
    out
}

/// Choppiness Index — quantifies how range-bound vs trending the last
/// `period` bars are. Returns `100 * log10(sum(TR) / (max(high)-min(low)))
/// / log10(period)`. Higher = choppier (range-bound), lower = trending.
pub fn choppiness_index(candles: &[Candle], period: usize) -> Vec<Option<f64>> {
    let n = candles.len();
    let mut out: Vec<Option<f64>> = vec![None; n];
    if period < 2 || n <= period {
        return out;
    }
    let mut tr = vec![0.0f64; n];
    for i in 1..n {
        let cur = &candles[i];
        let prev = &candles[i - 1];
        tr[i] = (cur.high - cur.low)
            .max((cur.high - prev.close).abs())
            .max((cur.low - prev.close).abs());
    }
    let log_p = (period as f64).log10();
    for i in period..n {
        let lo_idx = i + 1 - period;
        let sum_tr: f64 = tr[lo_idx..=i].iter().sum();
        let max_h = candles[lo_idx..=i]
            .iter()
            .map(|c| c.high)
            .fold(f64::MIN, f64::max);
        let min_l = candles[lo_idx..=i]
            .iter()
            .map(|c| c.low)
            .fold(f64::MAX, f64::min);
        let range = max_h - min_l;
        if range > 0.0 && sum_tr > 0.0 {
            out[i] = Some(100.0 * (sum_tr / range).log10() / log_p);
        }
    }
    out
}

/// Evaluate `cfg.cross_asset_filter` against a supplied candle stream for
/// the filter's symbol. Returns true if direction allowed, false otherwise.
pub fn cross_asset_filter_allows(
    filter: &crate::config::CrossAssetFilter,
    side: PositionSide,
    cross_closes: &[f64],
) -> bool {
    if cross_closes.is_empty() {
        return true; // no data = don't gate
    }
    let fast = ema(cross_closes, filter.fast_period as usize);
    let slow = ema(cross_closes, filter.slow_period as usize);
    let last_fast = fast.last().copied().flatten();
    let last_slow = slow.last().copied().flatten();
    let (Some(f), Some(s)) = (last_fast, last_slow) else {
        return false;
    };
    let trend = if f > s {
        Some(PositionSide::Long)
    } else if f < s {
        Some(PositionSide::Short)
    } else {
        None
    };
    match filter.direction.as_str() {
        "long" => trend == Some(PositionSide::Long) && side == PositionSide::Long,
        "short" => trend == Some(PositionSide::Short) && side == PositionSide::Short,
        // "any" or unknown → require trend matches signal side
        _ => trend == Some(side),
    }
}

/// Higher-timeframe trend filter — long allowed if HTF EMA-fast > EMA-slow
/// (uptrend). Short allowed if EMA-fast < EMA-slow (downtrend). Returns
/// `false` if EMAs are not yet defined or the trend is the wrong way.
pub fn htf_trend_allows(
    htf_closes: &[f64],
    fast_period: usize,
    slow_period: usize,
    side: PositionSide,
) -> bool {
    if htf_closes.is_empty() {
        return true; // no HTF data → don't gate
    }
    let fast = ema(htf_closes, fast_period);
    let slow = ema(htf_closes, slow_period);
    let last_fast = fast.last().copied().flatten();
    let last_slow = slow.last().copied().flatten();
    match (last_fast, last_slow) {
        (Some(f), Some(s)) => match side {
            PositionSide::Long => f > s,
            PositionSide::Short => f < s,
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(n: usize, base: f64, slope: f64) -> Vec<Candle> {
        (0..n)
            .map(|i| {
                let p = base + slope * i as f64;
                Candle::new(i as i64 * 1800_000, p, p + 0.1, p - 0.1, p, 0.0)
            })
            .collect()
    }

    #[test]
    fn rsi_filter_long_requires_oversold() {
        // RSI=20 (oversold) — long allowed if long_max=30
        assert!(rsi_filter_allows(Some(20.0), PositionSide::Long, Some(30.0), None));
        // RSI=40 — long blocked
        assert!(!rsi_filter_allows(Some(40.0), PositionSide::Long, Some(30.0), None));
        // long_max=None disables long-side filter
        assert!(rsi_filter_allows(Some(80.0), PositionSide::Long, None, None));
        // None RSI → blocked (conservative)
        assert!(!rsi_filter_allows(None, PositionSide::Long, Some(30.0), None));
    }

    #[test]
    fn rsi_filter_short_requires_overbought() {
        assert!(rsi_filter_allows(Some(80.0), PositionSide::Short, None, Some(70.0)));
        assert!(!rsi_filter_allows(Some(60.0), PositionSide::Short, None, Some(70.0)));
    }

    #[test]
    fn adx_yields_high_value_on_strong_trend() {
        let candles = ramp(60, 100.0, 0.5);
        let series = adx(&candles, 14);
        // Find first non-None.
        let last = series.iter().rev().find_map(|v| *v).expect("adx defined");
        // Strong uptrend should give large ADX.
        assert!(last > 30.0, "expected ADX>30 on monotone ramp, got {last}");
    }

    #[test]
    fn choppiness_high_on_flat_range() {
        // Flat-noise series: range = 1, total path length large → CI close to 100.
        let mut candles = Vec::new();
        for i in 0..50 {
            let t = i as i64 * 1800_000;
            let p = if i % 2 == 0 { 99.5 } else { 100.5 };
            candles.push(Candle::new(t, p, p + 0.1, p - 0.1, p, 0.0));
        }
        let ci = choppiness_index(&candles, 14);
        let last = ci.iter().rev().find_map(|v| *v).expect("CI defined");
        // Sanity: last CI should be in a sensible (0..=100) band.
        assert!(last > 50.0, "expected high CI on choppy series, got {last}");
    }

    #[test]
    fn htf_trend_allows_long_on_uptrend() {
        let closes: Vec<f64> = (0..50).map(|i| 100.0 + i as f64 * 0.5).collect();
        assert!(htf_trend_allows(&closes, 9, 21, PositionSide::Long));
        assert!(!htf_trend_allows(&closes, 9, 21, PositionSide::Short));
    }

    #[test]
    fn htf_trend_no_data_does_not_gate() {
        assert!(htf_trend_allows(&[], 9, 21, PositionSide::Long));
    }
}
