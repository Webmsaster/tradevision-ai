import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Insights | TradeVision AI',
  description: 'AI-powered pattern detection identifies revenge trading, tilt, overtrading, and positive habits in your trading.',
};

export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
