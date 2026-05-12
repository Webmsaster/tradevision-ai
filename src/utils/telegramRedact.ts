/**
 * Token-shape redaction shared by the TS Telegram senders:
 *   - scripts/ftmoSignalAlert.test.ts
 *   - scripts/driftTelegram.ts
 *
 * Both senders previously defined an inline `redactToken(s, token)` that:
 *   1. Literally replaces the known `token` (if non-empty) with `***`.
 *   2. Regex-redacts any Telegram-shaped token (`<8-12 digits>:<20+ url-safe>`)
 *      that may leak via proxy-encoded or wrapped error messages.
 *
 * Splitting this out lets us cover the redaction logic with a unit test
 * (R4-A1) instead of relying on the cron-job end-to-end test.
 *
 * Distinct from `telegramNotify.redactToken` which uses a `/bot…` URL-prefix
 * pattern; that one targets bot-API URLs specifically and leaves bare token
 * occurrences alone. This module is the more permissive, sender-side guard.
 */

const TOKEN_RE = /\d{8,12}:[A-Za-z0-9_-]{20,}/g;

export function redactToken(s: string, token?: string): string {
  if (!s) return s;
  let out = s;
  if (token) out = out.split(token).join("***");
  out = out.replace(TOKEN_RE, "***");
  return out;
}
