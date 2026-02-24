import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Import & Export | TradeVision AI',
  description: 'Import trades from CSV or JSON, export your data, and load sample trades for demo.',
};

export default function ImportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
