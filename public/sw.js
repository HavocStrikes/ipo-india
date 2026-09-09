/* IPO India — service worker (PWA app shell + offline fallback). Zero deps.
 *
 * Strategies:
 *   - Navigations (HTML):     network-first → cached app shell when offline.
 *   - /api/* requests:        network-first → last good response (stale beats none).
 *   - Other same-origin GETs: stale-while-revalidate (instant, refresh in background).
 *
 * Everything is keyed off the registration scope, so the same file works at
 * the domain root (workers.dev, `npm start`) and on GitHub Pages subpaths.
 */
'use strict';

const VERSION = 'v18';

const SHELL_CACHE = `ipo-shell-${VERSION}`;
const API_CACHE = `ipo-api-${VERSION}`;

self.addEventListener('install', (event) => {
  const base = new URL(self.registration.scope).pathname; // '/' or '/<repo>/'
  const shell = [
    base,
    `${base}styles.css`,
    `${base}app.js`,
    `${base}config.js`,
    `${base}manifest.webmanifest`,
    `${base}icons/icon-192.png`,
    `${base}icons/icon-512.png`,
  ];
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `cache: 'reload'` bypasses the HTTP cache so the shell is picked up fresh.
      await Promise.allSettled(shell.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, API_CACHE];
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('ipo-') && !keep.includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && /\/api\//.test(url.pathname)) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(navigate(req));
    return;
  }
  if (sameOrigin) event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await refresh) || Response.error();
}

async function navigate(req) {
  try {
    return await fetch(req);
  } catch (err) {
    // Offline: serve the exact page if previously cached, else the app shell.
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match(req, { ignoreSearch: true })) ||
      (await cache.match(self.registration.scope, { ignoreSearch: true })) ||
      Response.error()
    );
  }
}
