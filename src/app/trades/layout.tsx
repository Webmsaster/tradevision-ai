import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Trades | TradeVision AI',
  description: 'Manage your trades — add, edit, filter, and review your complete trading history.',
};

export default function TradesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
