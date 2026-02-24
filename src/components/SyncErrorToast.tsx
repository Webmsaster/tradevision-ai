'use client';

interface SyncErrorToastProps {
  message: string | null;
  onDismiss: () => void;
}

export default function SyncErrorToast({ message, onDismiss }: SyncErrorToastProps) {
  if (!message) return null;

  return (
    <div className="sync-error-toast" role="alert">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss" className="sync-error-dismiss">&times;</button>
    </div>
  );
}
