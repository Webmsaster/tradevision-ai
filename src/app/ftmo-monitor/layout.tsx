/**
 * Gate /ftmo-monitor behind FTMO_MONITOR_ENABLED env flag.
 *
 * Without the flag, the page returns 404 (same as the /api/ftmo-state route).
 * This prevents leaking personal trading performance on public deployments.
 *
 * Local dev / VPS where the bot runs:
 *   FTMO_MONITOR_ENABLED=1 npm run dev
 *
 * Production (Vercel etc.): leave the env var unset → page is 404.
 */
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { Metadata } from "next";

// R67-r20 audit fix: explicit noindex for the monitor page even when the
// env-flag gate is open. Robots.txt R15 already disallows the path; the
// meta tag covers crawlers that ignore robots.txt.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// R1-A8 audit fix (Multi-Account State Mgmt round 1): mirror /dashboard/drift
// — without `force-dynamic`, Next.js 15 bakes the FTMO_MONITOR_ENABLED check
// at build time. Build with the flag unset → page is hard-baked 404 forever
// at runtime. See memory `feedback_drift_dashboard_build_flag.md`.
export const dynamic = "force-dynamic";

export default function FtmoMonitorLayout({
  children,
}: {
  children: ReactNode;
}) {
  const enabled =
    process.env.FTMO_MONITOR_ENABLED === "1" ||
    process.env.FTMO_MONITOR_ENABLED === "true";
  if (!enabled) notFound();
  return <>{children}</>;
}
