import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Analytics | TradeVision AI",
  description:
    "Deep dive into your trading performance with charts, statistics, and breakdowns by pair, day, and hour.",
  robots: { index: false, follow: false }, // R67-r20: backup for robots.txt R15.
};

export default function AnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
