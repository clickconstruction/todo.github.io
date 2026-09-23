// Location alerts while the app is open: arriving at, leaving, or being near a place with
// actions that ask for it. One notification per place and event, listing its actions.
// (Background alerts on iPhone come from a Shortcuts automation through the server.)
//
// Guards against GPS noise: a fix worse than 1 km is ignored; you're "inside" within the
// radius and only "outside" once past radius + a margin (no flapping at the edge); the first
// fix after launch never counts as arriving; "nearby" repeats at most every 4 hours.
import { db, app, isOpen, toast } from './state.js';
import { distanceM, onLocation } from './geo.js';
import { placeFor } from './places.js';
import { isDeferred } from './dates.js';

const KEY = 'todo.geo.alerts';
const NEARBY_EVERY = 4 * 3600e3;
let memo;
try { memo = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { memo = null; }
if (!memo || typeof memo !== 'object') memo = { inside: {}, nearbyAt: {} };
// Tests start from a clean slate.
export const resetAlertState = () => { memo = { inside: {}, nearbyAt: {} }; };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(memo)); } catch { /* private mode */ } };

export const alertsPermission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
export async function enableAlerts() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

// Evaluate one position; returns the notifications it produced (for tests).
export function evaluate(here, now = Date.now()) {
  if (!here || here.accuracy > 1000) return [];
  const margin = Math.max(25, Math.min(here.accuracy || 0, 200) / 2);
  const fired = new Map(); // `${placeId}:${event}` -> { place, event, tasks }
  const add = (place, event, t) => {
    const k = `${place.id}:${event}`;
    if (!fired.has(k)) fired.set(k, { place, event, tasks: [] });
    fired.get(k).tasks.push(t);
  };
  const seen = new Set();
  db.tasks.forEach((t) => {
    if (!isOpen(t) || isDeferred(t)) return;
    const loc = placeFor(t);
    if (!loc || !loc.trigger) return;
    const key = `${t.id}:${loc.place.id}:${loc.radius}`;
    seen.add(key);
    const d = distanceM(here, loc.place);
    const prev = memo.inside[key];
    const inside = d <= loc.radius ? true : d > loc.radius + margin ? false : !!prev;
    if (loc.trigger === 'arrive' && prev === false && inside) add(loc.place, 'arrive', t);
    if (loc.trigger === 'leave' && prev === true && !inside) add(loc.place, 'leave', t);
    if (loc.trigger === 'nearby' && inside && now - (memo.nearbyAt[t.id] || 0) > NEARBY_EVERY) {
      add(loc.place, 'nearby', t);
      memo.nearbyAt[t.id] = now;
    }
    memo.inside[key] = inside;
  });
  Object.keys(memo.inside).forEach((k) => { if (!seen.has(k)) delete memo.inside[k]; }); // forget finished actions
  save();
  const out = [...fired.values()];
  out.forEach(notify);
  return out;
}

const VERB = { arrive: 'You’re at', leave: 'You left', nearby: 'Near' };
function notify({ place, event, tasks }) {
  const title = `📍 ${VERB[event]} ${place.name}`;
  const names = tasks.map((t) => t.title);
  const body = names.slice(0, 3).join('\n') + (names.length > 3 ? `\n+${names.length - 3} more` : '');
  const url = `#nearby/${place.id}`;
  if (window.__notify) { window.__notify({ title, body, url }); return; } // tests
  const inApp = () => toast(`${title}: ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`, { label: 'Show', run: () => { location.hash = url; } });
  // Looking at the app: a toast is enough. Otherwise (another window/tab focused) use a system notification.
  if (alertsPermission() !== 'granted' || (document.visibilityState === 'visible' && document.hasFocus())) { inApp(); return; }
  const opts = { body, tag: `place:${place.id}:${event}`, data: { url }, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' };
  const viaWorker = navigator.serviceWorker && navigator.serviceWorker.controller
    ? navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts))
    : Promise.reject(new Error('no worker'));
  viaWorker.catch(() => {
    try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); location.hash = url; }; } catch { inApp(); }
  });
}

onLocation((here) => { if (app.user) evaluate(here); });
