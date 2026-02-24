import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Performance Report | TradeVision AI',
  description: 'Print-ready performance report with detailed trade statistics, pair analysis, and day-of-week breakdown.',
};

export default function ReportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
