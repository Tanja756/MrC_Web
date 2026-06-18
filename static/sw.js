const CACHE = 'mrcheck-v3';
const STATIC_CACHE = 'mrcheck-static-v3';

const STATIC_URLS = [
  '/static/style.css',
  '/static/css/tasks.css',
  '/static/css/warehouse.css',
  '/static/js/core.js',
  '/static/js/app.js',
  '/static/js/tasks.js',
  '/static/js/ppr.js',
  '/static/js/warehouse.js',
  '/static/js/stock-transfers.js',
  '/static/icon.png',
  '/static/icon-512.png',
  '/manifest.json',
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

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/tasks') || caches.match('/login')
      )
    );
  }
});

// ====== НОВЫЙ ОБРАБОТЧИК PUSH ======
self.addEventListener('push', function(event) {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'Уведомление', body: '' };
  }
  const title = data.title || 'Уведомление';
  const body = data.body || '';
  const options = {
    body: body,
    icon: '/static/icon.png',          // если есть иконка, иначе уберите или оставьте
    data: {
      url: '/tasks'                    // куда перейти при клике
    }
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ====== НОВЫЙ ОБРАБОТЧИК КЛИКА ======
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.openWindow(url)
  );
});