// R67-r18 audit fix: previously root not-found.tsx was missing → Next.js
// served its built-in 404 page (mismatched dark glassmorphic design + leaks
// Next.js fingerprint). Now rendered with the same visual shell as the
// route-level error.tsx files.

export default function NotFound() {
  return (
    <div
      className="page-container"
      style={{ textAlign: "center", paddingTop: "80px" }}
    >
      <h1 style={{ fontSize: "1.5rem", marginBottom: "12px" }}>
        Page not found
      </h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "24px" }}>
        The page you tried to open doesn&apos;t exist or has been moved.
      </p>
      <a href="/" className="btn btn-primary">
        Back to Dashboard
      </a>
    </div>
  );
}
