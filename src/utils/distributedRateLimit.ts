/**
 * Round 54 (Finding #2): distributed rate-limit primitive used by
 * `/api/auth/callback`. Vercel runs N warm serverless instances in
 * parallel and an in-memory `Map<ip, hits[]>` is per-instance, so the
 * effective rate is `RATE_MAX_HITS × N` per IP — defeating the throttle
 * during a real spray.
 *
 * Strategy:
 *   - If `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set,
 *     use the Upstash REST API (atomic INCR + EXPIRE pipeline) so all
 *     instances share one counter.
 *   - Otherwise fall back to an in-memory Map and log ONCE at startup
 *     so the limitation is visible in logs (not a silent footgun).
 *   - On Upstash transport failure, fall through to in-memory rather
 *     than fail-open (login users must still be able to authenticate).
 *
 * The Upstash REST API is HTTP-only, no client lib needed; perfect for
 * Vercel edge/serverless runtimes.
 */

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 10;

// Round 56 (Finding #5): named constants for Upstash transport budget.
// Rate-limit must not delay the request path; we cap at a tight 800ms and
// refuse to retry — a slow throttle is worse than a memory fallback.
const UPSTASH_TIMEOUT_MS = 800;
const UPSTASH_MAX_RETRIES = 0; // intentional: rate-limit must not delay

// Per-instance fallback store; only used if no Upstash creds.
const memoryHits = new Map<string, number[]>();

let warnedNoUpstash = false;
function warnOnceNoUpstash(): void {
  if (warnedNoUpstash) return;
  warnedNoUpstash = true;
  // Visible in Vercel logs so the operator can wire up Upstash if the
  // bucket-per-instance limitation matters for their threat model.
  console.warn(
    "[rate-limit] UPSTASH_REDIS_REST_URL not set — using per-instance " +
      "in-memory limiter. Effective rate = limit × N warm instances.",
  );
}

// Round 56 (Finding #6): auth-fail must be loud. If Upstash returns
// 401/403 the entire shared limiter is silently broken and we fall back
// to per-instance memory — exactly the footgun this module exists to
// prevent. Log once-per-process so operators see it without spamming.
let warnedUpstashAuth = false;
function warnOnceUpstashAuth(status: number): void {
  if (warnedUpstashAuth) return;
  warnedUpstashAuth = true;
  console.error(
    `[rate-limit] Upstash auth failed (HTTP ${status}). Check ` +
      `UPSTASH_REDIS_REST_TOKEN. Falling back to in-memory limiter — ` +
      `effective rate = limit × N warm instances until fixed.`,
  );
}

function getUpstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Increments a per-IP counter in Upstash with TTL=window. Returns the
 * post-increment count, or `null` on transport failure (caller should
 * then fall back to memory).
 *
 * Round 56 (Finding #1): pipeline now uses `SET key 0 NX EX ttl` followed
 * by `INCR key`. The previous `INCR + EXPIRE` shape reset the TTL on
 * EVERY call, so under sustained spam the key never expired and the
 * counter only grew — fail-closed forever. With SET-NX, only the FIRST
 * call within the window installs the TTL; subsequent INCRs let the key
 * expire naturally on schedule. The SET stores "0" so the post-INCR
 * count starts at 1, matching the previous return semantics.
 *
 * Uses Upstash's pipeline endpoint to keep this a single round-trip.
 */
async function upstashIncr(
  cfg: { url: string; token: string },
  key: string,
  ttlSec: number,
): Promise<number | null> {
  // Round 56 (Finding #5): named constants for clarity. We do not retry
  // (UPSTASH_MAX_RETRIES = 0) — a delayed rate-limit defeats the point.
  void UPSTASH_MAX_RETRIES; // referenced for documentation/lint
  try {
    // Pipeline body is JSON array of command-arrays.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTASH_TIMEOUT_MS);
    const resp = await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        // First-hit-only TTL install. NX = only set if not exists.
        ["SET", key, "0", "NX", "EX", String(ttlSec)],
        ["INCR", key],
      ]),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      // Round 56 (Finding #6): loudly surface auth failures — silent
      // fallback to memory defeats the whole point of this module.
      if (resp.status === 401 || resp.status === 403) {
        warnOnceUpstashAuth(resp.status);
      }
      return null;
    }
    const body = (await resp.json()) as Array<{ result: number | string }>;
    // Pipeline returns results in command order: [0]=SET, [1]=INCR.
    const incrResult = body[1]?.result;
    if (typeof incrResult === "number") return incrResult;
    if (typeof incrResult === "string") {
      const n = Number(incrResult);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  } catch {
    // Network / abort / parse error → fall back.
    return null;
  }
}

function memoryCheck(
  key: string,
  now: number,
  windowMs: number,
  maxHits: number,
): boolean {
  const hits = (memoryHits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  memoryHits.set(key, hits);
  // Opportunistic GC of stale entries.
  if (memoryHits.size > 1000) {
    for (const [k, v] of memoryHits) {
      if (v.every((t) => now - t > windowMs)) memoryHits.delete(k);
    }
  }
  return hits.length > maxHits;
}

/**
 * Returns `true` if the IP has exceeded `maxHits` requests in the
 * window. The bucket key is namespaced by `bucket` so independent
 * routes (e.g. callback vs webhook) don't share a counter.
 */
export async function isRateLimited(
  bucket: string,
  ip: string,
  opts: { windowMs?: number; maxHits?: number } = {},
): Promise<boolean> {
  const windowMs = opts.windowMs ?? RATE_WINDOW_MS;
  const maxHits = opts.maxHits ?? RATE_MAX_HITS;
  const now = Date.now();

  const cfg = getUpstashConfig();
  if (cfg) {
    const ttlSec = Math.max(1, Math.ceil(windowMs / 1000));
    const key = `rl:${bucket}:${ip}`;
    const count = await upstashIncr(cfg, key, ttlSec);
    if (count !== null) {
      return count > maxHits;
    }
    // Upstash transport failed; degrade to memory but don't fail-open.
  } else {
    warnOnceNoUpstash();
  }

  return memoryCheck(`${bucket}:${ip}`, now, windowMs, maxHits);
}

// ---------------------------------------------------------------------
// Test-only helpers (not part of public API). Vitest imports them via
// the named export to reset internal state between cases.
// ---------------------------------------------------------------------
export const __testInternals = {
  resetMemory: (): void => {
    memoryHits.clear();
    warnedNoUpstash = false;
    warnedUpstashAuth = false;
  },
};
