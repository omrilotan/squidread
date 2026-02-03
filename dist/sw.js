const CACHE_NAME = 'squidread-shell-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3/dist/epub.min.js',
];

self.addEventListener('install', (event) => {
  console.info('[squidread-sw] install');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Cache assets individually to avoid the entire install failing if one fails
        return Promise.allSettled(
          ASSETS.map((url) => 
            cache.add(url).catch((err) => {
              console.warn('[squidread-sw] Failed to cache asset:', url, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
      .catch((err) => console.error('[squidread-sw] Install failed:', err))
  );
});

self.addEventListener('activate', (event) => {
  console.info('[squidread-sw] activate');
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Don't intercept blob URLs or data URLs - let them pass through
  if (request.url.startsWith('blob:') || request.url.startsWith('data:')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        console.debug('[squidread-sw] cache hit:', request.url);
        return cached;
      }
      console.debug('[squidread-sw] fetch:', request.url);
      return fetch(request).catch(() => {
        // Fallback for offline or failed requests
        console.warn('[squidread-sw] fetch failed:', request.url);
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
