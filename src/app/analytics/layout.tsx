import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Analytics | TradeVision AI',
  description: 'Deep dive into your trading performance with charts, statistics, and breakdowns by pair, day, and hour.',
};

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
