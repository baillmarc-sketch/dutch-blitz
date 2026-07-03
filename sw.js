/* Dutch Blitz Sidecar — offline-first service worker.
   CI stamps CACHE with the commit SHA on every deploy (see the deploy
   workflow), so each release changes sw.js bytes, triggers install, and
   refetches fresh assets. Navigations are network-first so index.html
   revalidates whenever the user is online; everything else is cache-first. */
var CACHE = 'blitz-sidecar-v1'; /* %DEPLOY_STAMP% */
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './folk.css',
  './engine.js',
  './storage.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache:'reload' bypasses the HTTP cache, so a CACHE bump always
      // fetches fresh bytes instead of re-caching stale ones.
      return cache.addAll(ASSETS.map(function (url) {
        return new Request(url, { cache: 'reload' });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/** Only precached app-shell URLs are ever written to the cache at runtime. */
function isShellAsset(url) {
  var scopePath = new URL(self.registration.scope).pathname;
  var path = url.pathname;
  return ASSETS.some(function (a) {
    return path === scopePath.replace(/\/$/, '/') + a.replace(/^\.\//, '') || (a === './' && path === scopePath);
  });
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so deployed updates arrive; cached shell offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put('./index.html', copy); });
        }
        return response;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        if (response && response.ok && isShellAsset(url)) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      });
    })
  );
});
