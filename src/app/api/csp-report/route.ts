import { NextResponse } from "next/server";
import { isRateLimited } from "@/utils/distributedRateLimit";

/**
 * CSP-violation report endpoint. R67-r12 hardening (security audit
 * follow-up to r11):
 *
 *   - x-forwarded-for fallback (self-hosting behind Nginx/Caddy) so
 *     non-Vercel deploys don't collapse all reports onto a single
 *     "unknown" rate-limit bucket.
 *   - Body capped at 8 KB (text() then JSON.parse) so a misbehaving
 *     browser or a malicious POST can't flood Vercel logs with MB-sized
 *     payloads.
 *   - URL fields stripped to origin+pathname before logging — query
 *     strings can carry tokens / OAuth codes when CSP catches a
 *     navigation that should have been server-side.
 */
const MAX_BODY_BYTES = 8 * 1024;

const URL_FIELDS = new Set([
  "document-uri",
  "documentURI",
  "blocked-uri",
  "blockedURI",
  "source-file",
  "sourceFile",
  "referrer",
]);

function stripQuery(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`;
  } catch {
    return value;
  }
}

function sanitizeReport(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(sanitizeReport);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (URL_FIELDS.has(k)) {
      out[k] = stripQuery(v);
    } else if (v && typeof v === "object") {
      out[k] = sanitizeReport(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  if (
    await isRateLimited("csp-report", ip, { windowMs: 60_000, maxHits: 30 })
  ) {
    return new NextResponse(null, { status: 429 });
  }
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 413 });
    }
    const body: unknown = JSON.parse(text);
    const safe = sanitizeReport(body);
    console.warn("[csp-violation]", JSON.stringify(safe).slice(0, 500));
  } catch {
    // ignore malformed body
  }
  return new NextResponse(null, { status: 204 });
}
