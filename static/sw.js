const CACHE = 'mrcheck-v1';
const STATIC_CACHE = 'mrcheck-static-v1';

const STATIC_URLS = [
  '/static/style.css',
  '/static/dashboard.js',
  '/static/tasks.js',
  '/static/ppr.js',
  '/static/icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== STATIC_CACHE).map(k => caches.delete(k)))
    )
  );
  clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  if (STATIC_URLS.some(s => url.pathname === s) || url.pathname === '/sw.js') {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fetchPromise = fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fetchPromise = fetch(request).then(response => {
            if (response.ok) {
              const copy = response.clone();
              cache.put(request, copy);
            }
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }
});
