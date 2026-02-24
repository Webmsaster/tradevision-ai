'use client';

import { useEffect } from 'react';

// Registers the service worker for PWA offline support
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('SW registered:', registration.scope);
      })
      .catch((error) => {
        console.warn('SW registration failed:', error);
      });
  }, []);

  return null;
}
