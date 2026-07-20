const CACHE_NAME = 'focus-timer-v1.2';
const ASSETS = [
  'index.html',
  'script.js',
  'manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://unpkg.com/lucide@latest'
];

// インストール時にファイルをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// キャッシュがあればキャッシュから、なければネットワークから取得
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});

/* ============================================================
   通知の受信と制御イベント
============================================================ */
self.addEventListener('message', (event) => {
  if (!event.data) return;

  // 通知の表示命令
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const title = event.data.title || 'Focus Timer';
    const options = {
      body: event.data.body || '',
      icon: 'https://placehold.co/192x192/171a26/74b9ff?text=FT',
      tag: event.data.tag || 'sw-persistent-notification',
      renotify: event.data.renotify || false,
      silent: event.data.silent || false
    };

    self.registration.showNotification(title, options);
  }

  // 通知の消去命令
  if (event.data.type === 'CLEAR_NOTIFICATION') {
    const tag = event.data.tag || 'sw-persistent-notification';
    self.registration.getNotifications({ tag }).then((notifications) => {
      notifications.forEach((notification) => notification.close());
    });
  }
});

// 通知をタップした際にアプリを開く
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