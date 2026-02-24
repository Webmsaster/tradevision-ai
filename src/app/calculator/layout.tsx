import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Risk Calculator | TradeVision AI',
  description: 'Calculate position size, risk-reward ratio, and liquidation price for your trades.',
};

export default function CalculatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
