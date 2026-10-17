// EchoMap Service Worker
// Cache version identifier — update this when modifying cached assets
const CACHE_NAME = 'echomap-v3';

// All paths are relative to support hosting under repository subpaths (e.g., GitHub Pages)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/ui/coordinates.js',
  './src/ui/session-model.js',
  './src/ui/floorplan.js',
  './src/ui/app.js'
];

// Install: Pre-cache core app shell
// Note: Do NOT call self.skipWaiting() here to avoid mixing old pages with new scripts.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Pre-caching app shell version:', CACHE_NAME);
        return cache.addAll(PRECACHE_ASSETS);
      })
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

// Message listener: Safe update trigger invoked by user tap
self.addEventListener('message', (event) => {
  if (event.data && (event.data.action === 'skipWaiting' || event.data.type === 'SKIP_WAITING')) {
    console.log('[SW] skipWaiting requested via message');
    self.skipWaiting();
  }
});

// Helper: Determine if request is for the HTML document / navigation
function isIndexHtmlRequest(request) {
  if (request.mode === 'navigate') {
    return true;
  }
  try {
    const url = new URL(request.url);
    return (
      url.pathname.endsWith('/index.html') ||
      url.pathname.endsWith('/') ||
      url.pathname === ''
    );
  } catch (err) {
    return false;
  }
}

// Fetch: Network-first for index.html (with cache fallback); Cache-first for other assets
self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  if (isIndexHtmlRequest(event.request)) {
    // Network-First with Cache Fallback for index.html
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            return caches.match('./index.html');
          });
        })
    );
  } else {
    // Cache-First with Network Fallback for static assets
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
  }
});
