/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 45 (R45-CFG-low): suppress `X-Powered-By: Next.js` (framework
  // recon leak). Cheap defence-in-depth.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-XSS-Protection', value: '0' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          {
            key: 'Content-Security-Policy',
            // Phase 45 (R45-API-2): replaced `connect-src 'self' https:` (an
            // effective wildcard that defeated XSS exfil-mitigation) with an
            // explicit allow-list. Any future external service must be added
            // here intentionally instead of getting smuggled in via XSS.
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              [
                "connect-src 'self'",
                'https://*.supabase.co',
                'wss://*.supabase.co',
                'https://api.binance.com',
                'https://fapi.binance.com',
                'wss://stream.binance.com',
                'wss://stream.binance.com:9443',
                'https://query1.finance.yahoo.com',
                'https://query2.finance.yahoo.com',
                'https://stooq.com',
                'https://nfs.faireconomy.media',
              ].join(' '),
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
