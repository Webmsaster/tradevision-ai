/**
 * R67-Final (2026-05-07): Next.js 15 instrumentation hook.
 *
 * This file is auto-discovered by Next.js (`next.config.js` does not
 * need to opt in for App Router on Next 15). It runs ONCE per server
 * process — both in dev (per HMR boot) and in prod (per cold start /
 * lambda warm). Use it to bootstrap server-side observability.
 *
 * Currently a no-op scaffold. To activate Sentry later:
 *
 *   1. `npm install @sentry/nextjs`
 *   2. Create `sentry.server.config.ts` and `sentry.edge.config.ts`
 *      (Sentry CLI's `npx @sentry/wizard@latest -i nextjs` does this)
 *   3. Replace the bodies below with the standard Sentry pattern:
 *
 *        if (process.env.NEXT_RUNTIME === 'nodejs') {
 *          await import('./sentry.server.config');
 *        }
 *        if (process.env.NEXT_RUNTIME === 'edge') {
 *          await import('./sentry.edge.config');
 *        }
 *
 *   4. Update `src/lib/errorReporter.ts` to delegate to
 *      `Sentry.captureException` / `Sentry.captureMessage` instead of
 *      the in-house `/api/log-error` POST.
 *
 * Until then we leave the hook in place so the migration is a 4-line
 * patch, not a refactor.
 *
 * Docs: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  // TODO(observability): wire up Sentry / Datadog / OTel here.
  // Intentionally empty for now — the `errorReporter` facade in
  // `src/lib/errorReporter.ts` ships error reports via /api/log-error
  // which Vercel surfaces in build/run logs (and a log-drain forwarder
  // can ship to Sentry asynchronously without an SDK install).
}
