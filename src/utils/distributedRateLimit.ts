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
 * Uses Upstash's pipeline endpoint to do INCR + EXPIRE atomically in a
 * single round-trip.
 */
async function upstashIncr(
  cfg: { url: string; token: string },
  key: string,
  ttlSec: number,
): Promise<number | null> {
  try {
    // Pipeline body is JSON array of command-arrays.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800); // tight budget
    const resp = await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(ttlSec)],
      ]),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const body = (await resp.json()) as Array<{ result: number | string }>;
    const incrResult = body[0]?.result;
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
  },
};
