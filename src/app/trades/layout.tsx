import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trades | TradeVision AI",
  description:
    "Manage your trades - add, edit, filter, and review your complete trading history.",
  // R67-r20 audit fix: defence-in-depth backup for robots.txt R15 disallow.
  // Some crawlers (Bingbot, GPTBot, scrapers) ignore robots.txt; the meta
  // robots tag is the wider-supported gate.
  robots: { index: false, follow: false },
};

export default function TradesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
