/**
 * R67-Final (2026-05-07): Sentry Edge runtime init.
 *
 * DSN-conditional: if NEXT_PUBLIC_SENTRY_DSN is unset, this file is a
 * complete no-op. Builds, tests, and runtime all succeed without a DSN.
 */

import * as Sentry from "@sentry/nextjs";
import type { ErrorEvent } from "@sentry/nextjs";

import { redactSensitive } from "@/lib/errorReporter";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

function sanitizeEvent(event: ErrorEvent): ErrorEvent | null {
  try {
    if (typeof event.message === "string") {
      event.message = redactSensitive(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (typeof ex.value === "string") {
          ex.value = redactSensitive(ex.value);
        }
      }
    }
    if (event.extra) {
      for (const k of Object.keys(event.extra)) {
        const v = event.extra[k];
        if (typeof v === "string") {
          event.extra[k] = redactSensitive(v);
        }
      }
    }
    if (event.tags) {
      for (const k of Object.keys(event.tags)) {
        const v = event.tags[k];
        if (typeof v === "string") {
          event.tags[k] = redactSensitive(v);
        }
      }
    }
  } catch {
    // never let scrubbing fail an event — best-effort.
  }
  return event;
}

if (DSN) {
  Sentry.init({
    dsn: DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: (event) => sanitizeEvent(event),
  });
}
