/**
 * R67-Final (2026-05-07): Next.js 15 instrumentation hook.
 *
 * This file is auto-discovered by Next.js (`next.config.js` does not
 * need to opt in for App Router on Next 15). It runs ONCE per server
 * process — both in dev (per HMR boot) and in prod (per cold start /
 * lambda warm). Use it to bootstrap server-side observability.
 *
 * Sentry is wired up as opt-in: the `sentry.{server,edge}.config.ts`
 * files are no-ops when `NEXT_PUBLIC_SENTRY_DSN` is unset, so this
 * import is safe regardless of environment.
 *
 * Docs: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
