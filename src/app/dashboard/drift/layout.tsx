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
