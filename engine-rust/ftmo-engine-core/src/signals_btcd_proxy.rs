// 2026-05-25 Wave5 Detector — BTC Dominance Proxy voter.
//
// Computes BTC outperformance vs the same-asset's recent move as a proxy
// for "BTC.D rising" (= alts weakening = bearish for alt-pairs) or
// "BTC.D falling" (= alts gaining = bullish for alt-pairs).
//
// True BTC.D would need BTC market_cap / total_crypto_market_cap from
// CoinGecko or similar. As a pragmatic proxy with ONLY existing OHLC data,
// we compute:
//
//   alt_return_window = (alt_close[i] - alt_close[i-window]) / alt_close[i-window]
//   btc_return_window = (btc_close[i] - btc_close[i-window]) / btc_close[i-window]
//   btc_dominance_delta = btc_return - alt_return
//
// Vote logic (for ALT-pairs only):
//   - btc_dominance_delta > threshold (BTC outperforms alt) → vote Short (alt weakens)
//   - btc_dominance_delta < -threshold (alt outperforms BTC) → vote Long (alt gains)
//   - else: abstain
//
// For BTC itself: abstain (the signal is per-alt vs BTC).
//
// Lookahead-safety:
//   - signal_idx = candles.len() - 2
//   - btc_closes aligned per-bar (passed in from external source via inputs)
//   - read btc_closes[signal_idx-window] and btc_closes[signal_idx] strictly

use crate::candle::Candle;
use crate::position::PositionSide;

#[derive(Debug, Clone, Copy)]
pub struct BtcdProxyParams {
    /// Window over which to compute the relative-performance gap.
    /// Default 48 bars (= 1 day on 30m crypto).
    pub window: usize,
    /// Minimum |btc_return - alt_return| difference to fire vote.
    /// Default 0.02 (= 2pp gap).
    pub threshold: f64,
    /// If true, this voter abstains on BTC itself (only fires on alts).
    /// Default true (BTC vs BTC is self-comparison, meaningless).
    pub skip_on_btc: bool,
}

impl BtcdProxyParams {
    pub fn default_30m_crypto() -> Self {
        Self {
            window: 48,
            threshold: 0.02,
            skip_on_btc: true,
        }
    }
}

/// Compute BTC Dominance proxy vote.
///
/// `candles` = candles of the ASSET being voted on (not BTC).
/// `btc_closes` = aligned BTC close series (length == candles.len()).
/// `source_symbol` used to detect "this asset IS BTC" (abstain).
pub fn compute_btcd_proxy_vote(
    candles: &[Candle],
    btc_closes: Option<&[f64]>,
    source_symbol: &str,
    params: &BtcdProxyParams,
) -> Option<PositionSide> {
    if params.skip_on_btc && source_symbol.starts_with("BTC") {
        return None;
    }
    let btc = btc_closes?;
    if candles.len() != btc.len() {
        return None;
    }
    if params.window == 0 || candles.len() < params.window + 2 {
        return None;
    }
    if !params.threshold.is_finite() || params.threshold <= 0.0 {
        return None;
    }

    let signal_idx = candles.len() - 2;
    if signal_idx < params.window {
        return None;
    }
    let prev_idx = signal_idx - params.window;

    let alt_now = candles[signal_idx].close;
    let alt_prev = candles[prev_idx].close;
    let btc_now = btc[signal_idx];
    let btc_prev = btc[prev_idx];

    if !alt_now.is_finite() || !alt_prev.is_finite() || alt_prev <= 0.0 {
        return None;
    }
    if !btc_now.is_finite() || !btc_prev.is_finite() || btc_prev <= 0.0 {
        return None;
    }

    let alt_return = (alt_now - alt_prev) / alt_prev;
    let btc_return = (btc_now - btc_prev) / btc_prev;
    let dominance_delta = btc_return - alt_return;

    if dominance_delta.abs() < params.threshold {
        return None;
    }

    // BTC stronger → alt weaker → Short the alt
    // BTC weaker → alt stronger → Long the alt
    if dominance_delta > 0.0 {
        Some(PositionSide::Short)
    } else {
        Some(PositionSide::Long)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(close: f64) -> Candle {
        Candle {
            open_time: 0,
            close_time: 0,
            open: close,
            high: close,
            low: close,
            close,
            volume: 0.0,
            taker_buy_volume: None,
            is_final: true,
        }
    }

    #[test]
    fn fires_short_when_btc_outperforms_alt() {
        // Alt up 1%, BTC up 5% → delta=+4% > threshold 2% → Short alt
        let alt: Vec<Candle> = (0..60).map(|i| bar(100.0 + (i as f64) * 0.017)).collect();
        let btc: Vec<f64> = (0..60).map(|i| 30000.0 + (i as f64) * 25.0).collect();
        let params = BtcdProxyParams::default_30m_crypto();
        let vote = compute_btcd_proxy_vote(&alt, Some(&btc), "ETHUSDT", &params);
        assert_eq!(vote, Some(PositionSide::Short));
    }

    #[test]
    fn fires_long_when_alt_outperforms_btc() {
        // Alt up 5%, BTC flat → delta=-5% < -threshold → Long alt
        let alt: Vec<Candle> = (0..60).map(|i| bar(100.0 + (i as f64) * 0.1)).collect();
        let btc: Vec<f64> = (0..60).map(|_| 30000.0).collect();
        let params = BtcdProxyParams::default_30m_crypto();
        let vote = compute_btcd_proxy_vote(&alt, Some(&btc), "ETHUSDT", &params);
        assert_eq!(vote, Some(PositionSide::Long));
    }

    #[test]
    fn abstains_on_small_gap() {
        // Both rising similarly → small gap → abstain
        let alt: Vec<Candle> = (0..60).map(|i| bar(100.0 + (i as f64) * 0.01)).collect();
        let btc: Vec<f64> = (0..60).map(|i| 30000.0 + (i as f64) * 3.0).collect();
        let params = BtcdProxyParams::default_30m_crypto();
        let vote = compute_btcd_proxy_vote(&alt, Some(&btc), "ETHUSDT", &params);
        assert_eq!(vote, None);
    }

    #[test]
    fn abstains_on_btc_self() {
        let alt: Vec<Candle> = (0..60).map(|i| bar(100.0 + (i as f64) * 0.1)).collect();
        let btc: Vec<f64> = (0..60).map(|_| 30000.0).collect();
        let params = BtcdProxyParams::default_30m_crypto();
        let vote = compute_btcd_proxy_vote(&alt, Some(&btc), "BTCUSDT", &params);
        assert_eq!(vote, None);
    }

    #[test]
    fn abstains_on_missing_btc() {
        let alt: Vec<Candle> = (0..60).map(|i| bar(100.0 + (i as f64) * 0.1)).collect();
        let params = BtcdProxyParams::default_30m_crypto();
        let vote = compute_btcd_proxy_vote(&alt, None, "ETHUSDT", &params);
        assert_eq!(vote, None);
    }

    #[test]
    fn lookahead_safe_no_entry_bar_read() {
        let alt: Vec<Candle> = (0..60).map(|i| bar(100.0 + (i as f64) * 0.05)).collect();
        let btc: Vec<f64> = (0..60).map(|i| 30000.0 + (i as f64) * 50.0).collect();
        let params = BtcdProxyParams::default_30m_crypto();
        let vote_a = compute_btcd_proxy_vote(&alt, Some(&btc), "ETHUSDT", &params);
        // Mutate entry bar (last) — should NOT change vote
        let mut btc_poisoned = btc.clone();
        btc_poisoned[btc.len() - 1] = 99999.0;
        let vote_b = compute_btcd_proxy_vote(&alt, Some(&btc_poisoned), "ETHUSDT", &params);
        assert_eq!(vote_a, vote_b, "entry-bar mutation must not change vote");
    }
}
