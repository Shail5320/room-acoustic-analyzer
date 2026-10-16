// EchoMap Service Worker
// Cache version identifier — update this when modifying cached assets
const CACHE_NAME = 'echomap-v1';

// All paths are relative to support hosting under repository subpaths (e.g., GitHub Pages)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Install: Pre-cache core app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Pre-caching app shell version:', CACHE_NAME);
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate: Prune stale caches from previous versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting stale cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Cache-first strategy for app shell assets with network fallback
self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // Only cache valid basic same-origin responses
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});
