/**
 * HTTP fetch helper with timeout + bounded retry/backoff.
 *
 * Round 56 (Fix 3): macro-indicator loaders (CoinGecko, Coinmetrics,
 * Bybit, Deribit, Hyperliquid, OKX, Coinbase, Binance funding) all used
 * bare `fetch()` with no timeout, no retry, and no respect for 429
 * Retry-After. A single hung CoinGecko request would block the macro
 * dashboard indefinitely; a transient 429 would fail-hard.
 *
 * This helper normalises all macro fetches:
 *   - 8s default timeout via AbortSignal.timeout
 *   - Up to `maxRetries` retries (default 2) with exponential backoff
 *     (1000 * 2 ** retry ms), gated on transient errors (network, 429,
 *     5xx). 4xx other than 429 are NOT retried — those are caller bugs.
 *   - Honours `Retry-After` header on 429 (parsed as seconds OR HTTP date).
 *   - Throws the original error on final failure (no semantic change vs
 *     existing throw-on-failure pattern in callers).
 *   - Returns parsed JSON typed as T.
 */

export interface FetchJsonRetryOptions {
  /** Per-request timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Maximum retry attempts after the initial try. Default 2 = 3 calls total. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (1000 → 1s, 2s, 4s …). Default 1000. */
  retryAfterMs?: number;
  /** Optional fetch init forwarded verbatim (method, body, headers). */
  init?: Omit<RequestInit, "signal">;
  /** Optional sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT = 8_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF = 1_000;
/** Hard cap so a malicious server can't make us sleep forever. */
const MAX_RETRY_AFTER_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

function isTransientStatus(status: number): boolean {
  // 429 Too Many Requests + 5xx server errors are retryable.
  return status === 429 || (status >= 500 && status < 600);
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortError + TimeoutError are surfaced by AbortSignal.timeout. Both
  // count as transient — the next retry gets a fresh signal.
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  // Node's fetch wraps DNS / reset / network errors as TypeError
  // ("fetch failed"). Also retryable.
  if (err.name === "TypeError") return true;
  return false;
}

/**
 * Parses a Retry-After response header. Returns ms to wait, or null if the
 * header is missing/invalid. Supports both delta-seconds and HTTP-date
 * formats per RFC 7231 §7.1.3.
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  // delta-seconds form (positive integer)
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  // HTTP-date form
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - now;
    if (delta <= 0) return 0;
    return Math.min(delta, MAX_RETRY_AFTER_MS);
  }
  return null;
}

/**
 * Fetches a URL and parses the response as JSON, with timeout + bounded
 * exponential retry. Throws the last seen error on final failure.
 */
export async function fetchJsonWithRetry<T>(
  url: string,
  opts: FetchJsonRetryOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseBackoff = opts.retryAfterMs ?? DEFAULT_BACKOFF;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown = new Error("fetchJsonWithRetry: no attempts made");
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts.init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(
          `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        );
        // Retry only on 429 / 5xx, otherwise fail fast.
        if (!isTransientStatus(res.status) || attempt === maxRetries) {
          throw err;
        }
        const retryAfter =
          res.status === 429
            ? parseRetryAfter(res.headers.get("retry-after"))
            : null;
        const wait = retryAfter ?? baseBackoff * 2 ** attempt;
        lastErr = err;
        await sleep(wait);
        continue;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      // Errors thrown synchronously above for non-retryable HTTP statuses
      // re-throw immediately (we already burned this attempt).
      if (err instanceof Error && err.message.startsWith("HTTP ")) {
        // Non-retryable HTTP error — propagate.
        if (attempt === maxRetries) throw err;
        const transient = /^HTTP (?:429|5\d\d) /.test(err.message) ?? false;
        if (!transient) throw err;
        await sleep(baseBackoff * 2 ** attempt);
        continue;
      }
      if (!isRetryableNetworkError(err) || attempt === maxRetries) {
        throw err;
      }
      await sleep(baseBackoff * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
