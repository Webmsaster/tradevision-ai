/**
 * Production live-safety caps for the FTMO signal detector.
 *
 * riskFrac is account-risk fraction at stop, not raw notional exposure.
 */
export const LIVE_MAX_RISK_FRAC = 0.04;
export const LIVE_MAX_STOP_PCT = 0.05;

export function formatLiveCapsLabel(): string {
  return `${(LIVE_MAX_RISK_FRAC * 100).toFixed(0)}% risk / ${(LIVE_MAX_STOP_PCT * 100).toFixed(0)}% stop`;
}
