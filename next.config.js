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
          // R60 audit: extend the deny-list to also block USB / serial /
          // payment / FLoC-Topics — none are used by the journal UI and
          // disabling them shrinks the attack surface for compromised
          // 3rd-party scripts.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), interest-cohort=(), browsing-topics=()' },
          { key: 'X-XSS-Protection', value: '0' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // Round 54 (Finding #3): CSP is now set per-request from
          // `middleware.ts` so we can attach a fresh `nonce-XYZ` to
          // script-src on every request (replacing the previous
          // `'unsafe-inline'`). Keeping the CSP here would override
          // the dynamic one. See middleware.ts:34 for the full policy.
        ],
      },
    ];
  },
};

module.exports = nextConfig;
