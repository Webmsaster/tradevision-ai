import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import ThemeProvider from "@/components/ThemeProvider";
import ErrorBoundary from "@/components/ErrorBoundary";
import { AuthProvider } from "@/lib/auth-context";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://tradevision-ai-bay.vercel.app",
  ),
  title: "TradeVision AI | Trading Journal & Performance Analyzer",
  description:
    "AI-powered trading journal that helps traders analyze performance, identify systematic mistakes, and improve their edge through data-driven insights.",
  keywords: [
    "trading journal",
    "performance analyzer",
    "AI trading",
    "crypto trading",
    "trade tracker",
  ],
  authors: [{ name: "TradeVision AI" }],
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "TradeVision AI | Trading Journal",
    description: "AI-powered trading journal and performance analyzer",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {/* Round 58 a11y (WCAG 2.4.1): skip-to-content link must be the
            first focusable element so keyboard / screen-reader users can
            bypass the sidebar nav. Visually hidden until focused; styled
            via .skip-link in globals.css. */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <ServiceWorkerRegistration />
        <AuthProvider>
          <ThemeProvider>
            <ErrorBoundary>
              <div className="app-layout">
                <Sidebar />
                <main id="main-content" className="main-content">
                  {children}
                </main>
              </div>
            </ErrorBoundary>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
