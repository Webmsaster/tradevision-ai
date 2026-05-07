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
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-]+/g;
const JWT_RE = /eyJ[A-Za-z0-9._\-]{20,}/g;

export function redactSensitive(s: string): string {
  if (!s) return s;
  let out = redactToken(s);
  out = out.replace(BEARER_RE, "Bearer <REDACTED>");
  out = out.replace(JWT_RE, "<REDACTED_JWT>");
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
    extra: ctx?.extra,
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
    extra: ctx?.extra,
    url:
      typeof window !== "undefined" && window.location
        ? window.location.href
        : undefined,
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    ts: Date.now(),
  };
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
