import { NextResponse } from "next/server";
import { isRateLimited } from "@/utils/distributedRateLimit";
import { redactSensitive } from "@/lib/errorReporter";

/**
 * R67-Final (2026-05-07): observability sink for the `errorReporter`
 * facade. Receives exception/message reports from the browser, redacts
 * any token patterns that slipped past the client-side scrubber, and
 * console.warns to Vercel logs. A real Sentry / Datadog / Logtail
 * forwarder can tail those logs without touching call-sites.
 *
 * Hardening:
 *   - Rate-limited at 30/min/IP via the shared distributedRateLimit
 *     helper (Upstash Redis when configured, in-memory fallback) — same
 *     pattern as `/api/csp-report`.
 *   - Body capped at 16 KB to keep an attacker from flooding logs with
 *     MB-sized payloads. Stack traces fit easily in 4 KB.
 *   - Returns 204 in all success paths (no body, no info-leak surface).
 *   - All ingested strings pass through `redactSensitive` again as a
 *     defence-in-depth (the client redacts, but a malicious client could
 *     POST raw tokens directly).
 *   - x-forwarded-for fallback so non-Vercel deploys don't collapse
 *     reports onto a single "unknown" rate-limit bucket.
 */

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELD_LEN = 4000;

// Whitelist of known payload fields. Anything else is dropped to avoid
// log-poisoning (e.g. a malicious client trying to inject ANSI escape
// sequences into server logs via an unexpected field).
const ALLOWED_TOP_FIELDS = new Set([
  "type",
  "level",
  "message",
  "stack",
  "name",
  "source",
  "tags",
  "extra",
  "url",
  "userAgent",
  "ts",
]);

const ALLOWED_LEVELS = new Set(["fatal", "error", "warning", "info", "debug"]);

function clampString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return redactSensitive(v).slice(0, MAX_FIELD_LEN);
}

function sanitizePayload(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!ALLOWED_TOP_FIELDS.has(k)) continue;
    if (k === "tags" || k === "extra") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const inner: Record<string, unknown> = {};
        // shallow scrub — extra/tags should not be deeply nested
        for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
          if (typeof iv === "string") {
            inner[ik] = redactSensitive(iv).slice(0, MAX_FIELD_LEN);
          } else if (
            typeof iv === "number" ||
            typeof iv === "boolean" ||
            iv === null
          ) {
            inner[ik] = iv;
          } else {
            // stringify nested objects so they don't break console.warn
            try {
              inner[ik] = redactSensitive(JSON.stringify(iv)).slice(
                0,
                MAX_FIELD_LEN,
              );
            } catch {
              // skip un-stringifiable values
            }
          }
        }
        out[k] = inner;
      }
    } else if (k === "level") {
      const lvl = typeof v === "string" ? v : "error";
      out.level = ALLOWED_LEVELS.has(lvl) ? lvl : "error";
    } else if (k === "ts") {
      out.ts = typeof v === "number" && Number.isFinite(v) ? v : Date.now();
    } else if (k === "type") {
      out.type = v === "message" ? "message" : "exception";
    } else {
      const clamped = clampString(v);
      if (clamped !== undefined) out[k] = clamped;
    }
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  // R67-RR5-Round2 audit fix (HIGH): same-origin gate. Without this, any
  // cross-site page can POST log entries via simple-CORS (text/plain
  // bypasses preflight) and flood Vercel logs / log-drains with
  // attacker-controlled strings. We accept origin OR referer matching
  // our deployment host. sendBeacon DOES set Origin so same-origin POSTs
  // from the app pass; cross-site won't.
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const host = request.headers.get("host");
  const allowedHostFromEnv =
    process.env.VERCEL_URL || process.env.NEXT_PUBLIC_SITE_URL;
  const allowedHosts = new Set<string>();
  if (host) allowedHosts.add(host.toLowerCase());
  if (allowedHostFromEnv) {
    try {
      const parsed = allowedHostFromEnv.startsWith("http")
        ? new URL(allowedHostFromEnv)
        : new URL(`https://${allowedHostFromEnv}`);
      allowedHosts.add(parsed.host.toLowerCase());
    } catch {
      /* ignore malformed env */
    }
  }
  let originHost = "";
  if (origin) {
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      /* malformed origin → treat as untrusted */
    }
  }
  let refererHost = "";
  if (referer) {
    try {
      refererHost = new URL(referer).host.toLowerCase();
    } catch {
      /* malformed referer → treat as untrusted */
    }
  }
  const sameOrigin =
    (originHost && allowedHosts.has(originHost)) ||
    (!origin && refererHost && allowedHosts.has(refererHost));
  if (!sameOrigin) {
    return new NextResponse(null, { status: 403 });
  }

  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  if (await isRateLimited("log-error", ip, { windowMs: 60_000, maxHits: 30 })) {
    return new NextResponse(null, { status: 429 });
  }

  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 413 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new NextResponse(null, { status: 400 });
    }
    const safe = sanitizePayload(parsed);
    if (!safe) {
      return new NextResponse(null, { status: 400 });
    }
    // console.warn so Vercel surfaces it at WARN level — a Sentry /
    // Datadog log-drain can pick it up without an SDK install. We slice
    // the JSON to keep the log line bounded even if MAX_FIELD_LEN got
    // bypassed somehow.
    console.warn("[errorReporter:ingest]", JSON.stringify(safe).slice(0, 8000));
  } catch {
    // never leak parse details to caller
    return new NextResponse(null, { status: 400 });
  }
  return new NextResponse(null, { status: 204 });
}
