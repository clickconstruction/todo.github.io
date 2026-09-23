// Alerts setup, built to be easy on an iPhone:
//   1. Add to Home Screen (iPhone only allows notifications from installed web apps)
//   2. One "Turn on alerts" button: notification permission, register this device for push,
//      create the location key (kept on the device, never shown), location access, test push
//   3. One Shortcuts automation per place: a "Set up" button copies the link, opens a short
//      guide with an "Open Shortcuts" button, and you tick it off.
// The location key is an api_token with scope 'geo': it can only trigger alerts.
import { sb, db, app, $, esc, run, toast, openSheet } from '../state.js';
import { activePlaces, placeFor } from '../places.js';
import { alertsPermission } from '../alerts.js';
import { requestLocation } from '../geo.js';
import { resetSettings } from './settings.js';

const GEO_URL = 'https://mcp.todotooling.com/geo';
const KEY_STORE = 'todo.geo.key';
const DONE_STORE = 'todo.geo.done'; // { "<placeId>:arrive": true } automations the user ticked off
let pushState = null; // null (unknown) | 'on' | 'off' | 'unsupported'
let busy = null; // progress lines while "Turn on alerts" runs
let checking = false;

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const storedKey = () => { try { return localStorage.getItem(KEY_STORE); } catch { return null; } };
const doneMap = () => { try { return JSON.parse(localStorage.getItem(DONE_STORE) || '{}'); } catch { return {}; } };
const setDone = (k, v) => { const m = doneMap(); if (v) m[k] = true; else delete m[k]; try { localStorage.setItem(DONE_STORE, JSON.stringify(m)); } catch { /* private mode */ } };

// The worker may not control the page on the very first launch after installing: wait for it.
const workerReady = () => Promise.race([navigator.serviceWorker.ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error('the app is still installing. Close it, reopen it, and try again')), 8000))]);

async function checkPush() {
  if (checking) return;
  checking = true;
  try {
    if (window.__pushState) { pushState = window.__pushState; return; } // tests
    if (!canPush() || location.hostname === 'localhost') { pushState = 'unsupported'; return; }
    const reg = await workerReady();
    pushState = (await reg.pushManager.getSubscription()) && alertsPermission() === 'granted' ? 'on' : 'off';
  } catch { pushState = 'off'; } finally { checking = false; app.render(); }
}
export const alertsReady = () => pushState === 'on' && !!storedKey();

// Which automations each place needs, from the alerts its actions ask for.
function neededEvents(place) {
  const ev = new Set();
  db.tasks.forEach((t) => {
    const loc = placeFor(t);
    if (!loc || loc.place !== place || t.completed_at || t.dropped_at) return;
    if (loc.trigger === 'arrive' || loc.trigger === 'nearby') ev.add('arrive');
    if (loc.trigger === 'leave') ev.add('leave');
  });
  return [...ev];
}
const geoUrl = (key, placeId, event) => `${GEO_URL}?t=${encodeURIComponent(key)}&place=${placeId}&event=${event}`;

// iOS Share icon, drawn so people recognize what to tap.
const SHARE = '<svg class="ios-share" viewBox="0 0 24 24" width="20" height="20" role="img" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 11H5v10h14V11h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

export function viewAlerts() {
  if (pushState === null) checkPush();
  const perm = alertsPermission();
  const key = storedKey();
  const ios = window.__forceIOS ?? isIOS();
  const needsInstall = ios && !(window.__forceStandalone ?? isStandalone());
  const ready = alertsReady();
  const done = doneMap();
  const places = activePlaces().map((p) => ({ p, ev: neededEvents(p) })).filter((x) => x.ev.length);
  const jobs = places.flatMap(({ p, ev }) => ev.map((e) => ({ p, e, done: !!done[`${p.id}:${e}`] })));
  const doneCount = jobs.filter((j) => j.done).length;

  const step = (n, state, title, body) => `<li class="step ${state}"><span class="step-n">${state === 'done' ? '✓' : n}</span><div><b>${title}</b>${body}</div></li>`;

  // Step 1: install
  const install = !ios
    ? step(1, 'done', 'Install', '<p>Not needed on this device. For background alerts, open <b>todotooling.com</b> on your iPhone.</p>')
    : needsInstall
      ? step(1, 'current', 'Add Todo Tooling to your Home Screen', `<p>iPhone only sends notifications to apps on your Home Screen.</p>
          <ol class="mini-steps"><li>In Safari, tap ${SHARE} <b>Share</b> (on newer iPhones it’s inside the <b>•••</b> button).</li><li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Todo</b> from your Home Screen. This page opens by itself.</li></ol>`)
      : step(1, 'done', 'Installed', '<p>Running from your Home Screen.</p>');

  // Step 2: one button
  let turnOn;
  if (busy) {
    turnOn = step(2, 'current', 'Turning on alerts…', `<ul class="progress">${busy.map(([ok, text]) => `<li>${ok === true ? '✓' : ok === false ? '✕' : '…'} ${esc(text)}</li>`).join('')}</ul>`);
  } else if (ready) {
    turnOn = step(2, 'done', 'Alerts are on', `<p>This ${ios ? 'iPhone' : 'device'} gets notifications for places and reminders.</p>
      <button class="btn small" data-act="test-alert">Send a test notification</button>`);
  } else if (needsInstall) {
    turnOn = step(2, 'waiting', 'Turn on alerts', '<p>Available after step 1.</p>');
  } else if (perm === 'denied') {
    turnOn = step(2, 'current', 'Notifications are blocked', ios
      ? '<p>Open iPhone <b>Settings</b> → <b>Notifications</b> → <b>Todo</b> → turn on <b>Allow Notifications</b>. Then come back and tap below.</p><button class="btn primary big" data-act="alerts-on">Try again</button>'
      : '<p>Allow notifications for todotooling.com in your browser’s site settings, then tap below.</p><button class="btn primary big" data-act="alerts-on">Try again</button>');
  } else if (!canPush() && !window.__pushState) {
    turnOn = step(2, 'waiting', 'Turn on alerts', `<p>${ios ? 'Needs iOS 16.4 or later (Settings → General → Software Update).' : 'This browser can’t receive notifications.'}</p>`);
  } else {
    turnOn = step(2, 'current', 'Turn on alerts', `<p>One tap. Your ${ios ? 'iPhone' : 'browser'} will ask to allow notifications, then location. Tap <b>Allow</b> both times.</p>
      <button class="btn primary big" data-act="alerts-on">🔔 Turn on alerts</button>`);
  }

  // Step 3: automations
  let autos;
  if (!ios) {
    autos = step(3, 'waiting', 'Arrive / leave alerts', '<p>These come from iPhone Shortcuts, so set them up on your iPhone. While this page is open, alerts also work here.</p>');
  } else if (!jobs.length) {
    autos = step(3, ready ? 'current' : 'waiting', 'Arrive / leave alerts', '<p>No places need one yet. Give an action (or a tag) a place and pick <b>Arriving</b>, <b>Leaving</b> or <b>Nearby</b> under Location. It will show up here.</p>');
  } else {
    autos = step(3, doneCount === jobs.length ? 'done' : ready ? 'current' : 'waiting', `Arrive / leave alerts · ${doneCount} of ${jobs.length} set up`,
      `<p>For each place, add one iPhone Shortcuts automation (about a minute each). ${ready ? '' : 'Finish step 2 first.'}</p>
      <ul class="alert-jobs">${jobs.map(({ p, e, done: d }) => `<li class="${d ? 'done' : ''}">
        <span>${d ? '✅' : e === 'arrive' ? '📍' : '🚪'} <b>${e === 'arrive' ? 'Arrive at' : 'Leave'}</b> ${esc(p.name)}</span>
        <button class="btn small ${d ? '' : 'primary'}" data-setup-auto="${p.id}:${e}" ${ready ? '' : 'disabled'}>${d ? 'Redo' : 'Set up'}</button></li>`).join('')}</ul>`);
  }

  return `<a class="back" href="#nearby">‹ Nearby</a>
    <div class="view-head"><h1 class="nearby">Alerts</h1></div>
    <p class="view-sub">Get a notification when you arrive at or leave a place with something to do there, and for the reminders you add to actions.</p>
    <ol class="steps">${install}${turnOn}${autos}</ol>
    ${ready ? '<p class="hint">Not getting notifications? iPhone <b>Settings</b> → <b>Notifications</b> → <b>Todo</b>: Allow Notifications, and check your Focus modes.</p>' : ''}
    ${key ? '<details class="alerts-advanced"><summary>Advanced</summary><p class="hint">Your location key only triggers alerts; it can’t read or change your todos. It’s listed in Settings as “Location alerts”.</p><button class="btn small" data-act="replace-geo-key">Replace location key</button> <span class="hint">(then redo each automation)</span></details>' : ''}`;
}

// ---------- the one button ----------
export async function turnOnAlerts() {
  // iOS only shows the prompt when requestPermission is the first thing a tap does.
  let perm;
  try { perm = window.__notifyPerm || await Notification.requestPermission(); } catch { perm = 'denied'; }
  busy = [[perm === 'granted', perm === 'granted' ? 'Notifications allowed' : 'Notifications not allowed']];
  app.render();
  if (perm !== 'granted') { busy = null; app.render(); return; }
  const line = (text) => { busy.push([null, text]); app.render(); return (ok, t) => { busy[busy.length - 1] = [ok, t || text]; app.render(); }; };
  try {
    let fin = line(`Registering this ${isIOS() ? 'iPhone' : 'device'}`);
    await subscribeThisDevice();
    fin(true);
    if (!storedKey()) { fin = line('Creating your location key'); await createGeoKey(); fin(true); }
    fin = line('Location access');
    try { await requestLocation(); fin(true, 'Location allowed'); } catch { fin(false, 'Location not allowed (arrive/leave via Shortcuts still works)'); }
    fin = line('Sending a test notification');
    const sent = await sendTest();
    fin(sent > 0, sent > 0 ? 'Test sent: you should see it now' : 'Test not delivered');
    pushState = 'on';
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {
    toast(`Couldn’t finish: ${e.message}`);
  }
  busy = null;
  app.render();
}

async function subscribeThisDevice() {
  if (window.__fakePush) { await run(sb.from('push_subscriptions').insert(window.__fakePush)); return; } // tests
  const reg = await workerReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const k = window.VAPID_PUBLIC_KEY;
    const key = Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((k.length + 3) % 4)), (c) => c.charCodeAt(0));
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  const j = sub.toJSON();
  const existing = await run(sb.from('push_subscriptions').select('id').eq('endpoint', j.endpoint));
  if (!existing.length) {
    const device = isIOS() ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Browser';
    await run(sb.from('push_subscriptions').insert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device }));
  }
}

export async function createGeoKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'tt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await run(sb.from('api_tokens').insert({ name: `Location alerts (${isIOS() ? 'iPhone' : 'this device'})`, token_hash, token_hint: token.slice(-4), scope: 'geo' }));
  try { localStorage.setItem(KEY_STORE, token); } catch { toast('Private mode: this key can’t be saved on this device.'); }
  resetSettings(); // Settings lists tokens; reload it next time it's shown
}

export async function replaceGeoKey() {
  if (!confirm('Make a new location key? Your existing Shortcuts automations stop working until you redo them.')) return;
  await createGeoKey();
  try { localStorage.removeItem(DONE_STORE); } catch { /* ignore */ }
  toast('New key made. Redo each automation.');
  app.render();
}

async function sendTest() {
  if (window.__fakeTest) return window.__fakeTest(); // tests
  const key = storedKey();
  if (!key) return 0;
  const res = await fetch(`${GEO_URL}?t=${encodeURIComponent(key)}&event=test`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `test failed (${res.status})`);
  return body.sent || 0;
}

export async function testAlert() {
  try {
    const sent = await sendTest();
    toast(sent ? 'Test sent. You should see it now.' : 'No devices to send to. Tap “Turn on alerts” first.');
  } catch (e) { toast(`Couldn’t send: ${e.message}`); }
}

// ---------- per-place Shortcuts guide ----------
export async function openAutomationGuide(jobKey) {
  const [placeId, event] = jobKey.split(':');
  const place = db.places.find((p) => p.id === placeId);
  const key = storedKey();
  if (!place || !key) return;
  const link = geoUrl(key, place.id, event);
  let copied = false;
  try { await navigator.clipboard.writeText(link); copied = true; } catch { /* shown below to copy by hand */ }
  const verb = event === 'arrive' ? 'Arrive' : 'Leave';
  const sheet = openSheet(`<form method="dialog" class="auto-guide">
    <h2>${verb === 'Arrive' ? '📍 Arrive at' : '🚪 Leave'} ${esc(place.name)}</h2>
    <p class="view-sub" style="margin:0">${copied ? '✓ The link is copied. Now in the Shortcuts app:' : 'Copy the link at the bottom, then in the Shortcuts app:'}</p>
    <ol class="guide">
      <li>Tap <b>Automation</b> at the bottom, then <b>+</b> (top right) or <b>New Automation</b>.</li>
      <li>Choose <b>${verb}</b>.</li>
      <li><b>Location</b> → <b>Choose</b> → search <span class="copyable" data-copy-text="${esc(place.address || place.name)}">${esc(place.address || place.name)}</span> → <b>Done</b>.</li>
      <li>Select <b>Run Immediately</b>, then <b>Next</b>.</li>
      <li>Tap <b>New Blank Automation</b> → <b>Add Action</b> → search <b>Get Contents of URL</b> and tap it.</li>
      <li>Tap the blue <b>URL</b>, <b>paste</b>, then <b>Done</b>.</li>
    </ol>
    <a class="btn primary big" href="shortcuts://" data-open-shortcuts>Open Shortcuts</a>
    <details><summary class="hint">Link (if paste didn’t work)</summary><textarea readonly rows="3" onclick="this.select()">${esc(link)}</textarea>
      <button type="button" class="btn small" data-copy-link>Copy link</button></details>
    <div class="actions"><button type="button" class="btn" data-cancel>Close</button>
      <div class="right"><button type="button" class="btn primary" data-auto-done>I added it ✓</button></div></div>
  </form>`);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  $('[data-copy-link]', sheet).onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { /* select the textarea */ } };
  // Tapping the address copies it for the location search; the link is re-copied after a moment for step 6.
  sheet.querySelectorAll('[data-copy-text]').forEach((el) => {
    el.onclick = async () => {
      try { await navigator.clipboard.writeText(el.dataset.copyText); toast('Address copied. Paste it into the location search.'); } catch { /* ignore */ }
    };
  });
  $('[data-auto-done]', sheet).onclick = () => { setDone(jobKey, true); sheet.close(); app.render(); toast(`${verb} alert set for ${place.name}`); };
  sheet.showModal();
}

// A small nudge on Inbox and Nearby until alerts are set up on an installed iPhone.
export function alertsNudge() {
  if (!isIOS() || !isStandalone() || alertsReady() || pushState === null) return '';
  try { if (localStorage.getItem('todo.alerts.nudge') === 'off') return ''; } catch { /* show */ }
  return '<div class="nudge"><a href="#alerts">🔔 <b>Turn on alerts</b> for places and reminders</a><button class="icon-btn" data-act="hide-nudge" aria-label="Hide">✕</button></div>';
}
export const hideNudge = () => { try { localStorage.setItem('todo.alerts.nudge', 'off'); } catch { /* ignore */ } app.render(); };

export const subscribePush = turnOnAlerts; // older button name
export async function copyGeoUrl(el) {
  try { await navigator.clipboard.writeText(el.dataset.copyGeo); toast('Link copied'); } catch { prompt('Copy this link', el.dataset.copyGeo); }
}
export const resetAlerts = () => { pushState = null; busy = null; };
export const primeAlerts = () => { if (pushState === null) checkPush(); };
