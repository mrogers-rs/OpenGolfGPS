// Service worker: app shell precached, satellite tiles cache-first, everything else network-first.
// The precache list and version below are filled in at build time (see vite.config.ts).
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = 'shell-' + VERSION;
const TILES = 'tiles-v1'; // keep in sync with src/tiles.ts

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname.endsWith('arcgisonline.com')) {
    e.respondWith(
      caches.open(TILES).then(async (c) => {
        const hit = await c.match(req.url, { ignoreVary: true });
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req.url, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.origin === location.origin) {
    // Navigations: try network (to pick up new versions), fall back to the cached shell.
    if (req.mode === 'navigate') {
      e.respondWith(fetch(req).catch(() => caches.match('/index.html', { ignoreVary: true })));
      return;
    }
    e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || fetch(req)));
  }
});
