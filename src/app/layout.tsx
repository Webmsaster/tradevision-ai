import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import './layout.css';
import Sidebar from '@/components/Sidebar';
import ThemeProvider from '@/components/ThemeProvider';
import { AuthProvider } from '@/lib/auth-context';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700']
});

export const metadata: Metadata = {
  title: 'TradeVision AI | Trading Journal & Performance Analyzer',
  description: 'AI-powered trading journal that helps traders analyze performance, identify systematic mistakes, and improve their edge through data-driven insights.',
  keywords: ['trading journal', 'performance analyzer', 'AI trading', 'crypto trading', 'trade tracker'],
  authors: [{ name: 'TradeVision AI' }],
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'TradeVision AI | Trading Journal',
    description: 'AI-powered trading journal and performance analyzer',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          <ThemeProvider>
            <div className="app-layout">
              <Sidebar />
              <main className="main-content">
                {children}
              </main>
            </div>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
