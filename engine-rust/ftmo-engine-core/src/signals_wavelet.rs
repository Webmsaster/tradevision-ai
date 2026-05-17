//! 2026-05-17 Haar Wavelet Decomposition multi-scale chop-gate.
//! Skip trade in high-noise regime (high D1-energy relative to A3).
use crate::candle::Candle;
use crate::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct WaveletParams { pub window: usize, pub d1_energy_max: f64 }
impl Default for WaveletParams {
    fn default() -> Self { Self { window: 32, d1_energy_max: 0.15 } }
}

fn haar_d1(arr: &[f64]) -> Vec<f64> {
    let n = arr.len() / 2;
    (0..n).map(|i| (arr[2*i] - arr[2*i+1]) / 2.0_f64.sqrt()).collect()
}
fn haar_a1(arr: &[f64]) -> Vec<f64> {
    let n = arr.len() / 2;
    (0..n).map(|i| (arr[2*i] + arr[2*i+1]) / 2.0_f64.sqrt()).collect()
}

pub fn compute_wavelet_vote(candles: &[Candle], p: &WaveletParams) -> Option<PositionSide> {
    if p.window < 16 || p.window.count_ones() != 1 { return None; }  // must be power of 2
    if candles.len() < p.window + 3 { return None; }
    let i = candles.len() - 2;
    if i < p.window { return None; }
    let lo = i + 1 - p.window;
    let closes: Vec<f64> = (lo..=i).map(|j| candles[j].close).filter(|c| c.is_finite()).collect();
    if closes.len() != p.window { return None; }
    let a1 = haar_a1(&closes);
    let d1 = haar_d1(&closes);
    let a2 = haar_a1(&a1);
    let a3 = haar_a1(&a2);
    let e_d1: f64 = d1.iter().map(|x| x * x).sum();
    let e_a3: f64 = a3.iter().map(|x| x * x).sum();
    if e_a3 <= 0.0 { return None; }
    let energy_ratio = e_d1 / e_a3;
    if energy_ratio > p.d1_energy_max { return None; } // chop, skip
    // Trending — vote on a3 direction
    if a3.last() > a3.first() { Some(PositionSide::Long) }
    else if a3.last() < a3.first() { Some(PositionSide::Short) }
    else { None }
}
