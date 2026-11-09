const CACHE_NAME = 'thirtyone-cache-v34';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './manifest.json',
    './css/main.css',
    './css/table.css',
    './css/modals.css',
    './js/audio.js',
    './js/celebration.js',
    './js/voice.js',
    './js/ledger.js',
    './js/network.js',
    './js/ui.js',
    './js/app.js',
    './js/dealAnim.js',
    './js/muck.js',
    './js/declutter.js',
    './js/premium.js',
    './js/turnBanner.js',
    './js/celebSound.js',
    './js/dragDrop.js',
    './css/premium.css',
    './css/turnBanner.css',
    './css/dragDrop.css',
    './css/declutter.css',
    './js/audioCues.js',
    './js/cardMoves.js',
    './js/tableWager.js',
    './js/invite.js',
    './js/pwa.js',
    './js/stats.js',
    './js/debtWatch.js',
    './js/friends.js',
    './js/privateTables.js',
    './js/privateTabs.js',
    './js/rematch.js',
    './js/push.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // One missing file must not make the whole install fail
            return Promise.all(ASSETS_TO_CACHE.map((url) => cache.add(url).catch(() => null)));
        })
    );
    self.skipWaiting();
});

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

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // Only our own files. Never cache account/API calls (they carry personal data and must be live).
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/token') || url.pathname.startsWith('/api/')) return;

    event.respondWith(
        fetch(req)
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(req, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : undefined));
            })
    );
});

// ---- web push (server/push.js sends { title, body, url, tag }) ----
self.addEventListener('push', (event) => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
    event.waitUntil(self.registration.showNotification(d.title || 'Blitz 31', {
        body: d.body || '',
        tag: d.tag || 'blitz31',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: d.url || '/' }
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const c of list) {
                if ('focus' in c) { return c.focus(); }
            }
            return self.clients.openWindow(url);
        })
    );
});
