import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Performance Report | TradeVision AI",
  description:
    "Print-ready performance report with detailed trade statistics, pair analysis, and day-of-week breakdown.",
  robots: { index: false, follow: false }, // R67-r20: backup for robots.txt R15.
};

export default function ReportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
