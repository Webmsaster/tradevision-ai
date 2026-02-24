import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Login | TradeVision AI',
  description: 'Sign in or create an account to sync your trading journal across devices.',
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
