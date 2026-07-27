'use strict';

/* =========================================================================
 * Service worker - app shell caching for offline / installable use.
 *
 * All paths here are RELATIVE to this file's own location. Since this file
 * is registered as `./sw.js` from wherever index.html lives (the GitHub
 * Pages project subpath, e.g. /investment-dashboard/), relative strings
 * passed to fetch()/cache.addAll() resolve against that same subpath - never
 * against the domain root. Do not change any of these to leading-slash
 * absolute paths, or the site breaks under the subpath.
 *
 * Strategy:
 *   - Same-origin app shell (HTML/CSS/JS/JSON/icons): cache-first, so the
 *     dashboard opens instantly and works fully offline once visited.
 *   - Cross-origin CDN libs (fonts, Chart.js, jsVectorMap): stale-while-
 *     revalidate - serve the cached copy immediately if present (fast,
 *     works offline), then refetch in the background to keep it current.
 * ===================================================================== */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `investment-dashboard-${CACHE_VERSION}`;

// Required app-shell files - if any of these fail to fetch, installation
// fails (they're what makes the app usable at all).
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './data/etf-holdings/CSPX.json',
  './data/etf-holdings/VUAA.json',
  './data/etf-holdings/LSMC.json',
  './data/etf-holdings/NIFTYBEES.json',
  './data/etf-holdings/84X0.json',
  './data/etf-holdings/EXUS.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Best-effort CDN assets - precached opportunistically (via {mode:'no-cors'}
// so a missing CORS header doesn't reject the fetch), but a failure here
// must NOT fail the whole install; the fetch handler's
// stale-while-revalidate will pick these up on first real use instead.
const CDN_SHELL = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/jsvectormap@1.7.0/dist/jsvectormap.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jsvectormap@1.7.0/dist/jsvectormap.min.js',
  'https://cdn.jsdelivr.net/npm/jsvectormap@1.7.0/dist/maps/world.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      // cache.add()/addAll() REJECT opaque (no-cors) responses outright -
      // only cache.put() accepts them, so cross-origin CDN assets must be
      // fetched manually and put individually. Wrapped so one CDN being
      // briefly unreachable can't fail the whole install.
      await Promise.allSettled(
        CDN_SHELL.map(async (url) => {
          const response = await fetch(url, { mode: 'no-cors' });
          await cache.put(url, response);
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request, { mode: 'no-cors' })
    .then((response) => {
      cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await networkPromise) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Navigations (e.g. opening the app fresh) should fall back to the
  // cached shell page when offline, even if the exact URL wasn't cached.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await cacheFirst(request);
        } catch {
          return (await caches.match('./index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(isSameOrigin ? cacheFirst(request) : staleWhileRevalidate(request));
});
