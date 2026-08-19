/* Service worker: mette in cache solo il guscio dell'app.
   I dati di mercato NON vengono mai messi in cache — un prezzo vecchio
   è peggio di un prezzo assente. */

const CACHE = 'rafox-v15';
const SHELL = [
  'app.html',
  'index.html',
  'rafox-market.js',
  'rafox-api.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Dati di mercato e librerie esterne: sempre dalla rete, mai dalla cache.
  const liveData = /binance|coingecko/i.test(url.hostname) ||
                   url.pathname.startsWith('/api/');
  if (liveData) return;

  // Guscio dell'app: cache first, con aggiornamento in background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req)
          .then(res => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then(c => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      })
    );
  }
});
