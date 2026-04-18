import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Strategy Research — TradeVision AI",
  description:
    "Long-history Binance backtest with realistic costs, multi-strategy regime switching, and walk-forward parameter optimisation.",
  robots: { index: false, follow: false },
};

export default function ResearchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
