const CACHE_NAME = 'thirtyone-cache-v11';
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
    './js/audioCues.js',
    './js/cardMoves.js',
    './js/tableWager.js',
    './js/invite.js',
    './js/pwa.js',
    './js/stats.js',
    './js/debtWatch.js'
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
