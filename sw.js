const CACHE_NAME = 'focus-timer-v2.2';
const ASSETS = [
  'index.html',
  'script.js',
  'manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://unpkg.com/lucide@latest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => cachedResponse || fetch(event.request))
  );
});

/* ’Ê’mŽóMˆ— */
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SHOW_NOTIFICATION') {
    const title = event.data.title || 'Focus Timer';
    const options = {
      body: event.data.body || '',
      icon: 'https://placehold.co/192x192/171a26/74b9ff?text=FT',
      tag: event.data.tag || 'sw-persistent-notification',
      renotify: true,
      requireInteraction: true
    };

    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  }

  if (event.data.type === 'CLEAR_NOTIFICATION') {
    const tag = event.data.tag || 'sw-persistent-notification';
    event.waitUntil(
      self.registration.getNotifications({ tag }).then((notifications) => {
        notifications.forEach((notification) => notification.close());
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});