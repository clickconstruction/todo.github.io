// App-shell service worker: precache the shell, serve it cache-first, and
// leave Supabase API traffic to the network. Bump VERSION on every deploy
// that changes a shell file so clients pick up the new copy.
// A new version installs in the background and waits; the page switches to it at a safe moment
// (js/updates.js sends SKIP_WAITING). MIN_VERSION: pages older than this switch at the next safe moment
// even mid-screen (raise it only when old code can't work with the data or has a security problem).
const VERSION = 'v73';
const MIN_VERSION = 'v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'js/main.js',
  'js/select-search.js',
  'js/state.js',
  'js/dates.js',
  'js/data.js',
  'js/rows.js',
  'js/components.js',
  'js/availability.js',
  'js/filter.js',
  'js/inspector.js',
  'js/router.js',
  'js/geo.js',
  'js/alerts.js',
  'js/places.js',
  'js/maps.js',
  'js/views/nearby.js',
  'js/views/alerts.js',
  'js/views/errands.js',
  'js/repeat.js',
  'js/editors/repeatField.js',
  'js/editors/notifyField.js',
  'js/editors/attachField.js',
  'js/editors/historyField.js',
  'js/pushResult.js',
  'js/tree.js', 'js/perspective-engine.js', 'js/perspectives.js', 'js/views/perspective.js', 'js/editors/perspective.js', 'js/editors/props.js', 'js/omnifocus-import.js', 'js/views/import.js', 'js/templates.js', 'js/views/templates.js', 'js/prefs.js', 'js/shortcuts.js', 'js/editors/focus.js', 'js/ics.js', 'js/calendars.js', 'js/gtd.js', 'js/views/gtd.js', 'js/views/clarify.js', 'js/editors/gtd.js', 'js/weekly.js', 'js/views/weekly.js', 'js/views/sweep.js', 'js/views/someday.js', 'js/whatnow.js', 'js/views/horizons.js', 'js/views/now.js', 'js/views/plan.js', 'js/views/capture.js', 'js/schedule.js', 'js/checklists.js', 'js/editors/schedule.js', 'js/views/checklists.js', 'js/views/daily.js', 'js/settle.js', 'js/views/settle.js', 'js/gain.js', 'js/editors/gainField.js', 'js/sidebar.js', 'js/updates.js', 'js/session.js', 'js/review.js', 'js/views/fullreview.js', 'js/slipbox.js', 'js/views/slipbox.js', 'js/views/reading.js',
  'js/matrix.js',
  'js/folders.js',
  'js/views/matrix.js',
  'js/editors/breakdown.js',
  'js/editors/steps.js',
  'js/editors/place.js',
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
    // Pages from before v55 don't know how to ask for the switch; for them, switch as before.
    .then(() => caches.keys())
    .then((keys) => { if (keys.some((k) => /^v\d+$/.test(k) && Number(k.slice(1)) < 55)) return self.skipWaiting(); return null; }));
});

self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'SKIP_WAITING') self.skipWaiting();
  if (m.type === 'INFO' && e.ports[0]) e.ports[0].postMessage({ version: VERSION, min: MIN_VERSION });
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'todo-share').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Shared to the app (Android / desktop Share menu): stash what came in, then open #share, where the
// app adds it to the Inbox with any files attached.
async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open('todo-share');
  const files = form.getAll('files').filter((f) => f && f.size);
  await Promise.all(files.map((f, i) => cache.put(`/__share/file/${i}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))));
  const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: files.map((f, i) => ({ i, name: f.name || `file-${i}`, type: f.type || 'application/octet-stream' })) };
  await cache.put('/__share/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect(new URL('./#share', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share')) { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});

// Location alerts: from the app (showNotification) or pushed by the server (iPhone Shortcuts automation).
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { title: 'Todo Tooling', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Todo Tooling', {
    body: msg.body || '', tag: msg.tag, data: { url: msg.url || '#nearby' }, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '#nearby', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) return win.focus().then(() => win.navigate(url));
    return self.clients.openWindow(url);
  }));
});
