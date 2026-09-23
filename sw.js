// App-shell service worker: precache the shell, serve it cache-first, and
// leave Supabase API traffic to the network. Bump VERSION on every deploy
// that changes a shell file so clients pick up the new copy.
const VERSION = 'v21';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'js/main.js',
  'js/state.js',
  'js/dates.js',
  'js/data.js',
  'js/rows.js',
  'js/components.js',
  'js/availability.js',
  'js/filter.js',
  'js/inspector.js',
  'js/router.js',
  'js/views/basic.js',
  'js/views/forecast.js',
  'js/views/review.js',
  'js/views/projects.js',
  'js/views/search.js',
  'js/views/done.js',
  'js/views/settings.js',
  'js/editors/task.js',
  'js/editors/project.js',
  'js/editors/completion.js',
  'js/editors/tagPicker.js',
  'config.js',
  'supabase-client.js',
  'vendor/supabase-js-2.108.0.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'favicon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache (GitHub Pages sends max-age=600), so a new
  // version never gets stored with stale copies of files from the previous deploy.
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
