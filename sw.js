/* Service worker: mette in cache il guscio dell'app.
   I dati di mercato NON vengono mai messi in cache — un prezzo vecchio
   è peggio di un prezzo assente.

   Strategia divisa in due:
   - Pagine e script "vivi" (app.html, index.html, rafox-*.js, e qualunque
     navigazione): RETE PRIMA, con la cache solo come ripiego se sei offline.
     Così un nuovo deploy si vede al primo caricamento, non al secondo.
   - Risorse statiche che cambiano raramente (icone, manifest): CACHE PRIMA,
     con aggiornamento silenzioso in background — qui la velocità conta più
     della freschezza immediata. */

const CACHE = 'rafox-v16';

const APP_FILES = ['app.html', 'index.html', 'rafox-market.js', 'rafox-api.js'];
const STATIC_FILES = ['manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const SHELL = [...APP_FILES, ...STATIC_FILES];

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

  // Origini esterne (font, CDN dei grafici): lasciate al comportamento
  // normale del browser, il service worker non se ne occupa.
  if (url.origin !== self.location.origin) return;

  const isAppFile = req.mode === 'navigate' ||
                     APP_FILES.some(f => url.pathname.endsWith(f));

  if (isAppFile) {
    // Guscio "vivo": prova sempre la rete per prima. Solo se la rete
    // fallisce (offline, o telefono senza segnale) si ripiega sull'ultima
    // copia salvata, per non lasciare l'app completamente inutilizzabile.
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Risorse statiche: cache first, con aggiornamento in background.
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
});