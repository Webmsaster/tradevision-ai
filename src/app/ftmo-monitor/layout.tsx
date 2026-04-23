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
