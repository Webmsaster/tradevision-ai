/**
 * Gate /dashboard/drift behind FTMO_MONITOR_ENABLED env flag (same gate as
 * the existing /ftmo-monitor and /api/ftmo-state). Without the flag the page
 * returns 404 to avoid leaking trading state in public deployments.
 *
 * Local dev / VPS where the bot runs:
 *   FTMO_MONITOR_ENABLED=1 npm run dev
 */
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { Metadata } from "next";

// R67-r20 audit fix: noindex meta even when env-flag gate is open.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// R1-A8 audit fix (Multi-Account State Mgmt round 1): Next.js 15 prerenders
// route layouts at build time unless `dynamic = "force-dynamic"` is set.
// Without this, FTMO_MONITOR_ENABLED is evaluated ONCE at `npm run build`
// — if the flag is unset there, every runtime request returns a hard-baked
// 404 even when the runtime env IS set. This is the exact symptom documented
// in memory `feedback_drift_dashboard_build_flag.md`. Force-dynamic moves
// the env check to per-request time so PM2 / systemd / Vercel-build-flag
// flips actually take effect without a rebuild.
export const dynamic = "force-dynamic";

export default function DriftDashboardLayout({
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
