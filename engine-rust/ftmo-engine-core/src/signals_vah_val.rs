//! 2026-05-17 Volume Profile VAH/VAL Breakout voter.
//! Long if close > VAH (Value Area High), Short if close < VAL.
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct VahValParams {
    pub window: usize,
    pub n_buckets: usize,
    pub va_pct: f64,
}
impl Default for VahValParams {
    fn default() -> Self {
        Self {
            window: 200,
            n_buckets: 50,
            va_pct: 0.70,
        }
    }
}

pub fn compute_vah_val_vote(candles: &[Candle], p: &VahValParams) -> Option<PositionSide> {
    // 2026-05-24 Codex audit LOW FIX: n_buckets=0 caused (a) division-by-zero
    // at L24 producing Inf bucket_size, (b) `vec![0.0; 0]` empty bucket_vol,
    // and (c) `p.n_buckets - 1` underflow on usize → PANIC inside .min().
    if p.window < 20 || p.n_buckets == 0 || candles.len() < p.window + 3 {
        return None;
    }
    let i = candles.len() - 2;
    if i < p.window {
        return None;
    }
    let lo = i + 1 - p.window;
    let bars: Vec<&Candle> = candles[lo..=i].iter().collect();
    let lows: Vec<f64> = bars
        .iter()
        .filter_map(|c| if c.low.is_finite() { Some(c.low) } else { None })
        .collect();
    let highs: Vec<f64> = bars
        .iter()
        .filter_map(|c| {
            if c.high.is_finite() {
                Some(c.high)
            } else {
                None
            }
        })
        .collect();
    if lows.is_empty() || highs.is_empty() {
        return None;
    }
    let price_min = lows.iter().cloned().fold(f64::INFINITY, f64::min);
    let price_max = highs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if price_max <= price_min {
        return None;
    }
    let bucket_size = (price_max - price_min) / p.n_buckets as f64;
    if bucket_size <= 0.0 {
        return None;
    }
    let mut bucket_vol = vec![0.0_f64; p.n_buckets];
    for c in &bars {
        if !c.close.is_finite() || !c.volume.is_finite() {
            continue;
        }
        let b = (((c.close - price_min) / bucket_size).floor() as usize).min(p.n_buckets - 1);
        bucket_vol[b] += c.volume;
    }
    let total_vol: f64 = bucket_vol.iter().sum();
    if total_vol <= 0.0 {
        return None;
    }
    // Sort buckets desc by volume, accumulate to va_pct
    let mut sorted: Vec<(usize, f64)> = bucket_vol
        .iter()
        .enumerate()
        .map(|(i, v)| (i, *v))
        .collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut included = std::collections::HashSet::new();
    let mut acc = 0.0;
    for (idx, vol) in &sorted {
        included.insert(*idx);
        acc += vol;
        if acc >= total_vol * p.va_pct {
            break;
        }
    }
    let included_idx: Vec<usize> = included.iter().copied().collect();
    let val_bucket = *included_idx.iter().min().unwrap();
    let vah_bucket = *included_idx.iter().max().unwrap();
    let val = price_min + val_bucket as f64 * bucket_size;
    let vah = price_min + (vah_bucket + 1) as f64 * bucket_size;
    let close_now = candles[i].close;
    if close_now > vah {
        Some(PositionSide::Long)
    } else if close_now < val {
        Some(PositionSide::Short)
    } else {
        None
    }
}
