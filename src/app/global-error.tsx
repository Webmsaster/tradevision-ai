'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0a0a1a',
          color: '#e0e0e0',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div
          style={{
            textAlign: 'center',
            padding: '48px 32px',
            maxWidth: '480px',
            borderRadius: '16px',
            backgroundColor: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <h1 style={{ fontSize: '1.5rem', marginBottom: '12px' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#888', marginBottom: '24px' }}>
            {error.message || 'A critical error occurred.'}
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button
              onClick={reset}
              style={{
                padding: '10px 24px',
                borderRadius: '8px',
                border: 'none',
                backgroundColor: '#6c5ce7',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '0.95rem',
              }}
            >
              Try Again
            </button>
            <a
              href="/"
              style={{
                padding: '10px 24px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.2)',
                backgroundColor: 'transparent',
                color: '#e0e0e0',
                cursor: 'pointer',
                fontSize: '0.95rem',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Go to Dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
