// App-shell service worker: precache the shell, serve it cache-first, and
// leave Supabase API traffic to the network. Bump VERSION on every deploy
// that changes a shell file so clients pick up the new copy.
const VERSION = 'v7';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'supabase-client.js',
  'vendor/supabase-js-2.108.0.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
