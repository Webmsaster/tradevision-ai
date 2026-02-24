'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page-container" style={{ textAlign: 'center', paddingTop: '80px' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '12px' }}>Something went wrong</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
        {error.message || 'An unexpected error occurred.'}
      </p>
      <button className="btn btn-primary" onClick={reset}>
        Try Again
      </button>
    </div>
  );
}
