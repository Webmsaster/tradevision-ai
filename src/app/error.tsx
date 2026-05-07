"use client";

// R67-r18 audit fix (WARNUNG): never render raw `error.message` in
// production. Client-side errors can leak Supabase URLs, JWT fragments,
// or internal paths. We surface the (already-sanitised by Next) `digest`
// for support correlation but only show the raw message in dev.
const IS_DEV = process.env.NODE_ENV === "development";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const userMsg = IS_DEV
    ? error.message || "An unexpected error occurred."
    : "An unexpected error occurred.";
  return (
    <div
      className="page-container"
      style={{ textAlign: "center", paddingTop: "80px" }}
    >
      <h1 style={{ fontSize: "1.5rem", marginBottom: "12px" }}>
        Something went wrong
      </h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "24px" }}>
        {userMsg}
      </p>
      {error.digest && (
        <p
          style={{
            color: "var(--text-muted)",
            marginBottom: "16px",
            fontSize: "0.85rem",
          }}
        >
          Error reference: <code>{error.digest}</code>
        </p>
      )}
      <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
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
