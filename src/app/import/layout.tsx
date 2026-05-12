import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Import & Export | TradeVision AI",
  description:
    "Import trades from CSV or JSON, export your data, and load sample trades for demo.",
  robots: { index: false, follow: false }, // R67-r20: backup for robots.txt R15.
};

export default function ImportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
