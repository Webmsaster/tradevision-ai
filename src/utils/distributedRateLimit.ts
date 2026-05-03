/**
 * Round 54 (Finding #2): distributed rate-limit primitive used by
 * `/api/auth/callback`. Vercel runs N warm serverless instances in
 * parallel and an in-memory `Map<ip, hits[]>` is per-instance, so the
 * effective rate is `RATE_MAX_HITS × N` per IP — defeating the throttle
 * during a real spray.
 *
 * Strategy:
 *   - If `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set,
 *     use the Upstash REST API (atomic Lua EVAL with INCR + conditional
 *     EXPIRE) so all instances share one counter.
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

// Round 56 (Finding #5): Upstash transport budget. Rate-limit must not
// delay the request path; we cap at a tight 800ms and refuse to retry —
// a slow throttle is worse than a memory fallback.
const UPSTASH_TIMEOUT_MS = 800;

// Per-instance fallback store; only used if no Upstash creds.
const memoryHits = new Map<string, number[]>();

// Round 56 (Finding #6): auth-fail must be loud. If Upstash returns
// 401/403 the entire shared limiter is silently broken and we fall back
// to per-instance memory — exactly the footgun this module exists to
// prevent. Log once-per-process so operators see it without spamming.
const warned = { noUpstash: false, auth: false };

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
 * Round 58 (Critical Fix #1): atomic Lua EVAL. The Round 56 pipeline
 * shape (`SET NX EX` + `INCR`) sent two commands to `/pipeline`, which
 * Upstash executes SEQUENTIALLY — not as a transaction. Race window:
 * if the key happens to expire between SET-NX and INCR (TTL=1s edge,
 * or clock drift on the Upstash side), the INCR re-creates the key
 * WITHOUT a TTL → counter grows forever, fail-closed exactly like the
 * Round 54 bug. Lua scripts run atomically inside Redis (single-thread
 * execution model) so the INCR + conditional EXPIRE form one
 * indivisible operation — no race possible.
 *
 * Script: INCR; if result == 1 (we just created the key), set EXPIRE.
 */
const LUA_INCR_OR_SET =
  "local v=redis.call('INCR',KEYS[1]); " +
  "if v==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; " +
  "return v";

async function upstashIncr(
  cfg: { url: string; token: string },
  key: string,
  ttlSec: number,
): Promise<number | null> {
  // No retry: a delayed rate-limit defeats the point.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTASH_TIMEOUT_MS);
    // Upstash REST `/` endpoint with a single command body. EVAL shape:
    // ["EVAL", script, numKeys, key1, ..., arg1, ...]. Single command =
    // single round-trip, no pipeline JSON wrapper.
    const resp = await fetch(`${cfg.url}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["EVAL", LUA_INCR_OR_SET, "1", key, String(ttlSec)]),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      // Round 56 (Finding #6): loudly surface auth failures — silent
      // fallback to memory defeats the whole point of this module.
      if (resp.status === 401 || resp.status === 403) {
        if (!warned.auth) {
          warned.auth = true;
          console.error(
            `[rate-limit] Upstash auth failed (HTTP ${resp.status}). Check ` +
              `UPSTASH_REDIS_REST_TOKEN. Falling back to in-memory limiter — ` +
              `effective rate = limit × N warm instances until fixed.`,
          );
        }
      }
      return null;
    }
    // Single-command response shape: { result: number | string }.
    const body = (await resp.json()) as { result: number | string };
    const evalResult = body?.result;
    if (typeof evalResult === "number") return evalResult;
    if (typeof evalResult === "string") {
      const n = Number(evalResult);
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
    if (!warned.noUpstash) {
      warned.noUpstash = true;
      // Visible in Vercel logs so the operator can wire up Upstash if the
      // bucket-per-instance limitation matters for their threat model.
      console.warn(
        "[rate-limit] UPSTASH_REDIS_REST_URL not set — using per-instance " +
          "in-memory limiter. Effective rate = limit × N warm instances.",
      );
    }
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
    warned.noUpstash = false;
    warned.auth = false;
  },
};
