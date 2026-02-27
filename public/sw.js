// Service Worker for TradeVision AI - PWA Offline Support
const CACHE_VERSION = 'tradevision-v1';
const APP_SHELL_CACHE = `${CACHE_VERSION}-app-shell`;
const API_CACHE = `${CACHE_VERSION}-api`;

// App shell resources to pre-cache on install
const APP_SHELL_FILES = [
  '/',
  '/trades',
  '/analytics',
  '/calculator',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.svg',
  '/icon-512.svg',
  '/icon-192.png',
  '/icon-512.png',
];

// Install event: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => {
      return cache.addAll(APP_SHELL_FILES);
    })
  );
  // Activate immediately without waiting for old SW to finish
  self.skipWaiting();
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('tradevision-') && name !== APP_SHELL_CACHE && name !== API_CACHE)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control of all clients immediately
  self.clients.claim();
});

// Fetch event: route requests to appropriate strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip chrome-extension and other non-http requests
  if (!url.protocol.startsWith('http')) return;

  // Skip Next.js build assets — they use content hashes and are immutable
  if (url.pathname.startsWith('/_next/')) return;

  // API requests: network-first with cache fallback
  if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase')) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // Navigation requests (HTML pages): network-first so deployments take effect immediately
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, APP_SHELL_CACHE));
    return;
  }

  // Static assets (JS, CSS, images): cache-first with network fallback
  event.respondWith(cacheFirst(request, APP_SHELL_CACHE));
});

// Cache-first strategy: try cache, fall back to network, then cache the response
async function cacheFirst(request, cacheName) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    // Only cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    // If both cache and network fail, return a basic offline page
    return new Response('Offline - Please check your connection.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// Network-first strategy: try network, fall back to cache
async function networkFirst(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    // Return an empty JSON response as fallback for API requests
    return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
