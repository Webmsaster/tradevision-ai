import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
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

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // R61 Lighthouse fix: middleware.ts emits a per-request CSP with a
  // strict `script-src 'self' 'nonce-XYZ' 'strict-dynamic'`. The R60
  // theme-init inline script must carry the matching nonce, otherwise
  // the browser blocks it and (a) the FOUC fix is silently disabled and
  // (b) Lighthouse best-practices drops via `errors-in-console`. Next.js
  // does NOT auto-nonce dangerouslySetInnerHTML, so we read the nonce
  // from the `x-nonce` request header (set in middleware.ts) and apply
  // it explicitly.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // `suppressHydrationWarning` is REQUIRED on <html>: the R60 inline
    // script in <head> sets `data-theme` synchronously based on
    // localStorage / prefers-color-scheme BEFORE React hydrates — that
    // creates a legitimate attribute diff which React would otherwise
    // throw a #418 hydration error for. (`data-theme` is intentionally
    // NOT pre-rendered: doing so would force every SSR response into one
    // theme and re-introduce FOUC for the other half of users.)
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Round 60 audit fix: set data-theme SYNCHRONOUSLY before first
            paint to prevent dark→light FOUC for light-theme users. Falls
            through localStorage → prefers-color-scheme → default 'dark'. */}
        <script
          nonce={nonce}
          // Audited inline script: theme bootstrap to prevent FOUC, served
          // with strict CSP nonce (see middleware.ts).
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('tradevision-theme');if(t!=='dark'&&t!=='light'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','dark')}",
          }}
        />
      </head>
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
