// Alerts setup: notifications while the app is open, and background alerts on iPhone via a
// Shortcuts "Arrive"/"Leave" automation that calls the server with a location key (a token
// that can only trigger alerts). The key is kept on this device so the URLs can be shown again.
import { sb, db, app, esc, run, toast } from '../state.js';
import { activePlaces, placeFor } from '../places.js';
import { alertsPermission, enableAlerts } from '../alerts.js';
import { resetSettings } from './settings.js';

const GEO_URL = 'https://mcp.todotooling.com/geo';
const KEY_STORE = 'todo.geo.key';
let pushState = null; // null (unknown) | 'on' | 'off' | 'unsupported'
let checking = false;

const isIOS = () => /iPhone|iPad/.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && !!navigator.serviceWorker.controller;
const storedKey = () => { try { return localStorage.getItem(KEY_STORE); } catch { return null; } };

async function checkPush() {
  if (checking) return;
  checking = true;
  try {
    if (!pushSupported()) { pushState = 'unsupported'; return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    pushState = sub ? 'on' : 'off';
  } catch { pushState = 'unsupported'; } finally { checking = false; app.render(); }
}

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

const url = (key, place, event) => `${GEO_URL}?t=${encodeURIComponent(key)}&place=${place.id}&event=${event}`;

export function viewAlerts() {
  if (pushState === null) checkPush();
  const perm = alertsPermission();
  const key = storedKey();
  const places = activePlaces().map((p) => ({ p, ev: neededEvents(p) })).sort((a, b) => b.ev.length - a.ev.length || a.p.name.localeCompare(b.p.name));
  const needsInstall = isIOS() && !isStandalone();

  const step = (n, done, title, body) => `<li class="step ${done ? 'done' : ''}"><span class="step-n">${done ? '✓' : n}</span><div><b>${title}</b>${body}</div></li>`;
  const placeRows = places.map(({ p, ev }) => `<li class="alert-place">
      <div class="row-title">📍 ${esc(p.name)} <span class="hint">${ev.length ? `needs: ${ev.map((e) => (e === 'arrive' ? 'Arrive' : 'Leave')).join(' + ')}` : 'no actions ask for alerts here yet'}</span></div>
      ${key ? `<div class="alert-urls">${['arrive', 'leave'].map((e) => `<button class="btn small ${ev.includes(e) ? 'primary' : ''}" data-copy-geo="${esc(url(key, p, e))}">Copy ${e === 'arrive' ? 'Arrive' : 'Leave'} URL</button>`).join('')}</div>` : ''}
    </li>`).join('');

  return `<a class="back" href="#nearby">‹ Nearby</a>
    <div class="view-head"><h1 class="nearby">Alerts</h1></div>
    <p class="view-sub">Get told about actions when you arrive at, leave, or are near a place.</p>

    <h2 class="section-title">While the app is open</h2>
    <p class="view-sub">${perm === 'granted' ? '✓ Notifications are on. With the app open, alerts appear as you move.'
      : perm === 'denied' ? 'Notifications are blocked for Todo Tooling. Turn them on in your browser or iPhone Settings → Notifications.'
      : perm === 'unsupported' ? (needsInstall ? 'On iPhone, notifications work once Todo Tooling is on your Home Screen (below).' : 'This browser can’t show notifications; alerts appear inside the app.')
      : 'Alerts show inside the app. Turn on notifications to also get them when the app isn’t in front.'}</p>
    ${perm === 'default' ? '<button class="btn primary" data-act="enable-alerts">Turn on notifications</button>' : ''}

    <h2 class="section-title">In the background (iPhone)</h2>
    <p class="view-sub">Web apps can’t watch your location when closed, but iPhone Shortcuts can: an automation runs when you arrive or leave, and Todo Tooling sends you a notification listing that place’s actions.</p>
    <ol class="steps">
      ${step(1, !needsInstall, 'Install the app', needsInstall ? '<p>In Safari tap Share → Add to Home Screen, then open Todo Tooling from your Home Screen and come back here.</p>' : (isIOS() ? '<p>Running as an installed app.</p>' : '<p>Only needed on iPhone.</p>'))}
      ${step(2, pushState === 'on', 'Get notifications on this phone', pushState === 'on' ? '<p>This device will receive background alerts.</p>'
        : pushState === 'unsupported' ? '<p>Open the installed app on your iPhone (iOS 16.4 or later) to turn this on.</p>'
        : '<p>Needed so the server can reach this phone.</p><button class="btn primary" data-act="subscribe-push">Turn on for this phone</button>')}
      ${step(3, !!key, 'Create a location key', key ? '<p>Saved on this device. It can only trigger alerts; revoke it any time in Settings.</p><button class="btn link" data-act="create-geo-key">Replace key</button> <span class="hint">(then update your automations)</span>'
        : '<p>A key that can do nothing but send you alerts (it can’t read or change your todos).</p><button class="btn primary" data-act="create-geo-key">Create location key</button>')}
      ${step(4, false, 'Send a test', `<p>Check that a notification reaches this phone.</p><button class="btn" data-act="test-alert" ${key ? '' : 'disabled'}>Send test notification</button>`)}
      ${step(5, false, 'Add an automation per place', `<p>In the <b>Shortcuts</b> app: <b>Automation</b> → <b>+</b> → <b>Arrive</b> (or Leave) → choose the place’s location → <b>Run Immediately</b> → <b>Next</b> → <b>New Blank Automation</b> → add <b>Get Contents of URL</b> → paste the URL below → <b>Done</b>.</p>
        ${places.length ? `<ul class="alert-places">${placeRows}</ul>` : '<p class="hint">Add a place first.</p>'}
        ${key ? '' : '<p class="hint">Create a location key (step 3) to get the URLs.</p>'}`)}
    </ol>`;
}

export async function subscribePush() {
  try {
    if (!pushSupported()) { toast('Open the installed app to turn on background alerts'); return; }
    const perm = await enableAlerts();
    if (perm !== 'granted') { toast('Notifications were not allowed'); app.render(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = Uint8Array.from(atob(window.VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((window.VAPID_PUBLIC_KEY.length + 3) % 4)), (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const j = sub.toJSON();
    const existing = await run(sb.from('push_subscriptions').select('id').eq('endpoint', j.endpoint));
    if (!existing.length) {
      const device = isIOS() ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Browser';
      await run(sb.from('push_subscriptions').insert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device }));
    }
    pushState = 'on';
    toast('This phone will get background alerts');
  } catch (e) {
    toast(`Couldn’t turn on alerts: ${e.message}`);
  }
  app.render();
}

export async function createGeoKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'tt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const device = isIOS() ? 'iPhone' : 'this device';
  await run(sb.from('api_tokens').insert({ name: `Location alerts (${device})`, token_hash, token_hint: token.slice(-4), scope: 'geo' }));
  try { localStorage.setItem(KEY_STORE, token); } catch { toast('Private mode: copy the URLs now; the key can’t be saved.'); }
  resetSettings(); // Settings lists tokens; reload it next time it's shown
  app.render();
}

export async function testAlert() {
  const key = storedKey();
  if (!key) return;
  try {
    const res = await fetch(`${GEO_URL}?t=${encodeURIComponent(key)}&event=test`);
    const body = await res.json();
    if (!res.ok) { toast(body.error || `Test failed (${res.status})`); return; }
    toast(body.sent ? `Sent to ${body.sent} device${body.sent === 1 ? '' : 's'}` : body.note || 'No devices to send to');
  } catch { toast('Couldn’t reach the alert server'); }
}

export async function copyGeoUrl(el) {
  try { await navigator.clipboard.writeText(el.dataset.copyGeo); toast('URL copied: paste it into “Get Contents of URL”'); } catch { prompt('Copy this URL', el.dataset.copyGeo); }
}

export const resetAlerts = () => { pushState = null; };
