'use client';

export default function ImportError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page-container" style={{ textAlign: 'center', paddingTop: '80px' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '12px' }}>Failed to load import</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
        {error.message || 'An unexpected error occurred.'}
      </p>
      <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
        <button className="btn btn-primary" onClick={reset}>
          Try Again
        </button>
        <a href="/" className="btn btn-ghost">
          Back to Dashboard
        </a>
      </div>
    </div>
  );
}
