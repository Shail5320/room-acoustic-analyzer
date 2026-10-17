// EchoMap Service Worker
// Cache version identifier — update this when modifying cached assets
const CACHE_NAME = 'echomap-v9';

// All paths are relative to support hosting under repository subpaths (e.g., GitHub Pages)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/data/targets.json',
  './src/data/materials.json',
  './src/ui/coordinates.js',
  './src/ui/session-model.js',
  './src/ui/floorplan.js',
  './src/ui/dimensions.js',
  './src/ui/heatmap-math.js',
  './src/ui/heatmap.js',
  './src/ui/format.js',
  './src/ui/app.js',
  './src/store/storage.js',
  './src/store/export.js',
  './src/analysis/config.js',
  './src/analysis/pipeline.js',
  './src/analysis/worker.js',
  './src/analysis/run.js',
  './src/analysis/selftest.js',
  './src/analysis/treatment.js',
  './src/audio/wav.js',
  './src/audio/sweep-wav.js'
];

// Network timeout for network-first strategy (3 seconds)
const NETWORK_TIMEOUT_MS = 3000;

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

// Helper: Fetch with timeout
function fetchWithTimeout(request, timeoutMs = NETWORK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Network timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(request, { cache: 'no-cache' })
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// Fetch: Network-first with 3s timeout for ALL same-origin GET requests; fallback to cache
self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  // Don't intercept or cache cross-origin requests
  try {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
  } catch (err) {
    return;
  }

  // Network-First with 3s timeout and Cache Fallback
  event.respondWith(
    fetchWithTimeout(event.request, NETWORK_TIMEOUT_MS)
      .then((networkResponse) => {
        // Cache successful basic responses into versioned cache
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Fallback to cache on network failure or timeout
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Navigation fallback to index.html if specific navigation URL isn't cached directly
          if (isIndexHtmlRequest(event.request)) {
            return caches.match('./index.html').then((indexFallback) => {
              if (indexFallback) return indexFallback;
              return caches.match('./');
            });
          }
          return Promise.reject(new Error('Asset not found in cache'));
        });
      })
  );
});
