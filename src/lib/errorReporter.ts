/**
 * R67-Final (2026-05-07): lightweight error-reporter facade.
 *
 * Goal: keep observability code Sentry-COMPATIBLE without pulling in the
 * heavy `@sentry/nextjs` dependency. The shape of `captureException` /
 * `captureMessage` mirrors Sentry's API so swapping in the real client
 * later is a one-line change in this module — call-sites stay untouched.
 *
 * Behaviour:
 *   - Dev / test → console.error (loud, with stack).
 *   - Prod (NEXT_PUBLIC + server)  → POST to `/api/log-error`. The route
 *     redacts known token patterns, then console.warns to Vercel logs
 *     (which a real Sentry/Datadog forwarder can tail).
 *
 * Both the client (browser) and server (route handler / RSC) call into
 * this module. We pick the transport based on `typeof window`.
 *
 * This is intentionally fire-and-forget: a failed log POST must never
 * cascade into the user-visible error path.
 */

import { redactToken } from "@/utils/telegramNotify";

export type CaptureLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface CaptureContext {
  /** Free-form tags that downstream Sentry/Datadog can index on. */
  tags?: Record<string, string>;
  /** Larger structured payload — request body, props, etc. */
  extra?: Record<string, unknown>;
  /** Where the error originated (component name, route, util). */
  source?: string;
}

interface ErrorReportPayload {
  type: "exception" | "message";
  level: CaptureLevel;
  message: string;
  stack?: string;
  name?: string;
  source?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  url?: string;
  userAgent?: string;
  ts: number;
}

const IS_DEV =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";
const IS_TEST =
  typeof process !== "undefined" &&
  (process.env.NODE_ENV === "test" || process.env.VITEST === "true");

/**
 * Redact obvious token patterns from any string before it leaves the
 * process. We re-use `redactToken` (Telegram-token shape) and also strip
 * generic `Bearer xxxx` headers and JWT-shaped strings.
 */
// 2026-05-15 (Audit-Round-5 / Agent #7 WARNUNG): case-insensitive Bearer
// (lowercase variant `bearer xxx` from 3rd-party SDK stack-traces was missed)
// + extra generic patterns for OpenAI / Stripe / GitHub / Anthropic /
// password / api_key / client_secret in error messages.
const BEARER_RE = /[Bb]earer\s+[A-Za-z0-9._\-]+/g;
const JWT_RE = /eyJ[A-Za-z0-9._\-]{20,}/g;
// R67-RR5-Round2 audit fix (MED): opaque Supabase token shapes that
// don't match JWT/Bearer. refresh_token is a 20+-char base64url after
// `refresh_token=` / `refresh_token: `; PAT (`sbp_...`) and project
// secret (`sb-secret-...`) are long-lived account-takeover primitives.
const SUPABASE_PAT_RE = /\bsbp?_[A-Za-z0-9]{20,}\b/g;
const SUPABASE_SECRET_RE = /\bsb-secret-[A-Za-z0-9]{20,}\b/g;
const REFRESH_TOKEN_RE = /(refresh[_-]?token)["'=:\s]+([A-Za-z0-9._\-]{20,})/gi;
const ACCESS_TOKEN_RE = /(access[_-]?token)["'=:\s]+([A-Za-z0-9._\-]{20,})/gi;
// 2026-05-15 (Audit-Round-5 / Agent #7 WARNUNG): vendor key prefixes.
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{16,}\b/g;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g;
const STRIPE_LIVE_KEY_RE = /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{20,}\b/g;
const GITHUB_TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const GENERIC_SECRET_RE =
  /(api[_-]?key|password|client[_-]?secret|secret)["'=:\s]+([^\s,"'}]{8,})/gi;
// PII: route-path UUIDs (e.g. /api/trades/<uuid>/edit) — DSGVO concern.
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function redactSensitive(s: string): string {
  if (!s) return s;
  let out = redactToken(s);
  out = out.replace(BEARER_RE, "Bearer <REDACTED>");
  out = out.replace(JWT_RE, "<REDACTED_JWT>");
  // Anthropic prefix matches `sk-…` too, so run the more specific one first.
  out = out.replace(ANTHROPIC_KEY_RE, "<REDACTED_ANTHROPIC>");
  out = out.replace(STRIPE_LIVE_KEY_RE, "<REDACTED_STRIPE_LIVE>");
  out = out.replace(GITHUB_TOKEN_RE, "<REDACTED_GITHUB>");
  out = out.replace(OPENAI_KEY_RE, "<REDACTED_OPENAI>");
  out = out.replace(SUPABASE_PAT_RE, "<REDACTED_SBP>");
  out = out.replace(SUPABASE_SECRET_RE, "<REDACTED_SB_SECRET>");
  out = out.replace(REFRESH_TOKEN_RE, "$1=<REDACTED>");
  out = out.replace(ACCESS_TOKEN_RE, "$1=<REDACTED>");
  out = out.replace(GENERIC_SECRET_RE, "$1=<REDACTED>");
  out = out.replace(UUID_RE, "<uuid>");
  return out;
}

/**
 * 2026-05-24 Wave9 MED FIX (Agent 2): `extra` was passed through verbatim
 * to the /api/log-error sink. Callers using `captureException(err, {
 * extra: { email, sessionToken, ... } })` would exfiltrate PII/secrets
 * past the message+stack redact pipeline. Walk string-valued keys and
 * apply the same redactSensitive() pipeline; other types pass through
 * (already serialized safely upstream).
 */
function redactExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    out[k] = typeof v === "string" ? redactSensitive(v) : v;
  }
  return out;
}

function buildExceptionPayload(
  err: unknown,
  ctx: CaptureContext | undefined,
): ErrorReportPayload {
  const e =
    err instanceof Error
      ? err
      : new Error(typeof err === "string" ? err : JSON.stringify(err));
  return {
    type: "exception",
    level: "error",
    name: e.name,
    message: redactSensitive(e.message ?? "(no message)"),
    stack: e.stack ? redactSensitive(e.stack).slice(0, 4000) : undefined,
    source: ctx?.source,
    tags: ctx?.tags,
    extra: redactExtra(ctx?.extra),
    url:
      typeof window !== "undefined" && window.location
        ? window.location.href
        : undefined,
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    ts: Date.now(),
  };
}

function buildMessagePayload(
  msg: string,
  level: CaptureLevel,
  ctx: CaptureContext | undefined,
): ErrorReportPayload {
  return {
    type: "message",
    level,
    message: redactSensitive(msg),
    source: ctx?.source,
    tags: ctx?.tags,
    extra: redactExtra(ctx?.extra),
    url:
      typeof window !== "undefined" && window.location
        ? window.location.href
        : undefined,
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    ts: Date.now(),
  };
}

// R67-RR5-Round2 audit fix (HIGH): client-side token-bucket throttle.
// Without this, a render-loop firing 1000 errors/sec saturates the
// browser sendBeacon queue (~64KB total pooled) and the keepalive-fetch
// quota — actual root-cause errors get DROPPED while noise accumulates.
// 10 reports per 10s is plenty: anything beyond is duplicate noise from
// a runaway loop; the real signal is in the first few captures.
const CLIENT_RATE_WINDOW_MS = 10_000;
const CLIENT_RATE_MAX = 10;
let clientRateBucket: number[] = [];

function clientThrottled(now: number): boolean {
  clientRateBucket = clientRateBucket.filter(
    (t) => now - t < CLIENT_RATE_WINDOW_MS,
  );
  if (clientRateBucket.length >= CLIENT_RATE_MAX) return true;
  clientRateBucket.push(now);
  return false;
}

export const __resetClientRateBucketForTests = (): void => {
  clientRateBucket = [];
};

/**
 * R67-Final (2026-05-07): if Sentry was initialised on the page (the
 * client config sets `(window as any).__SENTRY__`), delegate the report
 * to Sentry's SDK instead of POSTing to our in-house `/api/log-error`.
 *
 * The check is structural — we don't `import @sentry/nextjs` here so
 * call-sites of this module stay tree-shake-friendly when Sentry is
 * not enabled. We dynamically import only when the SDK is present.
 */
function sentryLoaded(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __SENTRY__?: unknown }).__SENTRY__
  );
}

async function delegateToSentry(payload: ErrorReportPayload): Promise<boolean> {
  try {
    const Sentry = await import("@sentry/nextjs");
    const ctx = {
      tags: payload.tags,
      extra: payload.extra,
      level: payload.level as "fatal" | "error" | "warning" | "info" | "debug",
    };
    if (payload.type === "exception") {
      const err = new Error(payload.message);
      if (payload.name) err.name = payload.name;
      if (payload.stack) err.stack = payload.stack;
      Sentry.captureException(err, ctx);
    } else {
      Sentry.captureMessage(payload.message, ctx);
    }
    return true;
  } catch {
    return false;
  }
}

async function transmit(payload: ErrorReportPayload): Promise<void> {
  // Dev / test: just log loudly. Don't open network at all.
  if (IS_DEV || IS_TEST) {
    if (payload.type === "exception") {
      console.error(
        `[errorReporter] ${payload.name ?? "Error"} (${payload.source ?? "unknown"}): ${payload.message}`,
        payload.stack ? `\n${payload.stack}` : "",
      );
    } else {
      console.error(
        `[errorReporter:${payload.level}] ${payload.message}`,
        payload.extra ?? "",
      );
    }
    return;
  }

  // R67-Final: if Sentry is loaded on the page, delegate to it. This
  // is the migration switch — when DSN is set the SDK takes over the
  // pipeline; when it's unset the existing /api/log-error path runs.
  if (sentryLoaded()) {
    const ok = await delegateToSentry(payload);
    if (ok) return;
    // fall through to sendBeacon if the dynamic import failed
  }

  // R67-RR5-Round2: drop excess reports before they hit sendBeacon —
  // saturated queues silently drop real errors otherwise.
  if (clientThrottled(Date.now())) return;

  // Prod: POST to the log-error route. Use sendBeacon when available —
  // it survives page-unload (router navigation, tab close) which a fetch
  // would otherwise abort.
  try {
    const body = JSON.stringify(payload);
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      typeof window !== "undefined"
    ) {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon("/api/log-error", blob);
      if (ok) return;
      // fall through to fetch if sendBeacon refused (size cap / disabled)
    }
    // We deliberately don't `await` long: the caller is on an error path.
    void fetch("/api/log-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // swallow — a failed log POST must not cascade.
    });
  } catch {
    // swallow — observability is best-effort.
  }
}

/**
 * Sentry-compatible: report an exception. Safe to call from anywhere
 * (client, server, RSC). Never throws.
 */
export function captureException(err: unknown, ctx?: CaptureContext): void {
  try {
    void transmit(buildExceptionPayload(err, ctx));
  } catch {
    // last-resort: swallow.
  }
}

/**
 * Sentry-compatible: report a free-form message at a given severity.
 */
export function captureMessage(
  msg: string,
  level: CaptureLevel = "info",
  ctx?: CaptureContext,
): void {
  try {
    void transmit(buildMessagePayload(msg, level, ctx));
  } catch {
    // swallow.
  }
}

// ---------------------------------------------------------------------
// Test-only helpers — vitest imports these to inspect transmit shape.
// ---------------------------------------------------------------------
export const __testInternals = {
  buildExceptionPayload,
  buildMessagePayload,
  redactSensitive,
};
