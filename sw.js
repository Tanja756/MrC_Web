const CACHE = 'mrc-v2';
const ASSETS = [
  '/static/style.css',
  '/static/css/tasks.css',
  '/static/css/warehouse.css',
  '/static/js/core.js',
  '/static/js/app.js',
  '/static/js/tasks.js',
  '/static/js/warehouse.js',
  '/static/js/stock-transfers.js',
  '/static/js/ppr.js',
  '/static/js/references.js',
  '/static/js/route.js',
  '/static/js/fn.js',
  '/static/icon.png',
  '/static/icon-512.png',
  '/static/fun-effects/confetti/effect.css',
  '/static/fun-effects/confetti/effect.js',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/flatpickr',
  'https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css',
  'https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css',
  'https://cdn.jsdelivr.net/npm/flatpickr/dist/l10n/ru.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname === 'cdn.jsdelivr.net' || url.pathname.startsWith('/static/')) {
    e.respondWith(cacheFirst(e.request));
  } else {
    e.respondWith(networkFirst(e.request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response(null, { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.headers.get('accept')?.includes('json')) {
      return new Response(JSON.stringify({error: 'Offline'}), { status: 503, headers: {'Content-Type': 'application/json'} });
    }
    return new Response(null, { status: 503, statusText: 'Service Unavailable' });
  }
}

self.addEventListener('push', e => {
  let data = { title: 'Mr.Check', body: '' };
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/static/icon.png',
      badge: '/static/icon.png',
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
