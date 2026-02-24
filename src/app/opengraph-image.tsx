import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'TradeVision AI - Trading Journal & Performance Analyzer';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: 'linear-gradient(135deg, #0f1729 0%, #1a1f3a 50%, #0f1729 100%)',
          color: '#ffffff',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            marginBottom: '24px',
          }}
        >
          <svg width="64" height="64" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#00ff88" fillOpacity="0.15" />
            <path d="M8 22 L12 16 L16 19 L24 10" stroke="#00ff88" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="10" r="2" fill="#00ff88" />
          </svg>
          <div style={{ fontSize: '48px', fontWeight: 700, letterSpacing: '-1px' }}>
            TradeVision AI
          </div>
        </div>
        <div
          style={{
            fontSize: '24px',
            color: '#94a3b8',
            marginBottom: '48px',
          }}
        >
          Trading Journal & Performance Analyzer
        </div>
        <div
          style={{
            display: 'flex',
            gap: '32px',
          }}
        >
          {['AI Insights', 'Analytics', 'Risk Calculator', 'CSV Import'].map((feature) => (
            <div
              key={feature}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 16px',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                fontSize: '16px',
                color: '#cbd5e1',
              }}
            >
              {feature}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
