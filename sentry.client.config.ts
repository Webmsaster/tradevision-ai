/**
 * R67-Final (2026-05-07): Sentry browser-side init.
 *
 * DSN-conditional: if NEXT_PUBLIC_SENTRY_DSN is unset, this file is a
 * complete no-op. Builds, tests, and runtime all succeed without a DSN.
 *
 * `sanitizeEvent` reuses the existing `redactSensitive` helper so any
 * Telegram tokens / JWTs / Bearer headers / Supabase tokens that end up
 * inside Sentry events are scrubbed before transport.
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
    sendDefaultPii: false,
    beforeSend: (event) => sanitizeEvent(event),
    // 2026-05-15 (Audit-Round-5 / Agent #7 WARNUNG): breadcrumbs (XHR/fetch
    // URLs, console-calls, navigation) bypass `beforeSend` entirely. A
    // `fetch("/api/x?token=eyJ…")` landed in Sentry with the full token in
    // the breadcrumb URL until this hook started scrubbing them too.
    beforeBreadcrumb: (b) => {
      try {
        if (b.data && typeof b.data === "object") {
          for (const k of Object.keys(b.data)) {
            const v = (b.data as Record<string, unknown>)[k];
            if (typeof v === "string") {
              (b.data as Record<string, unknown>)[k] = redactSensitive(v);
            }
          }
        }
        if (typeof b.message === "string") {
          b.message = redactSensitive(b.message);
        }
      } catch {
        // never block a breadcrumb on scrubbing failure
      }
      return b;
    },
    // Performance-transactions also carry URL/path. Same scrubbing.
    beforeSendTransaction: (tx) => {
      try {
        if (typeof tx.transaction === "string") {
          tx.transaction = redactSensitive(tx.transaction);
        }
      } catch {
        // best-effort
      }
      return tx;
    },
  });
}
