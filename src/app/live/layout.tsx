import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live Signals — TradeVision AI",
  description:
    "Live technical-analysis signal feed for BTC, ETH, SOL and other Binance pairs. Educational only, not financial advice.",
  robots: { index: false, follow: false },
};

export default function LiveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
