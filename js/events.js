// Your own events (an airshow, a trip, an appointment): held here, shown in Forecast on every day
// they cover, and sent out in the private calendar feed so they reach your phone. Not actions.
// Timed events have instants; an all-day event runs from local midnight of its first day to local
// midnight after its last day (exclusive, as iCalendar does it). Archived, never deleted.
import { db, app, sb, run, syncRow, toast, byId, esc } from './state.js';
import { distanceM, fmtDistance } from './geo.js';
import { activePlace } from './places.js';
import { loadMaps } from './maps.js';

export const EVENT_COLOR = '#7F77DD';
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const liveEvents = () => (db.events || []).filter((e) => !e.archived_at);
// The card an event came from (open, or fetched with the events if it's done), if any.
export const cardOf = (taskId) => (taskId ? byId(db.tasks, taskId) || byId(db.eventTasks || [], taskId) || null : null);
// A quiet "from" link on an event row; opens the card.
export function fromHtml(taskId) {
  const t = cardOf(taskId);
  return t ? `<button type="button" class="ev-from" data-task="${t.id}" title="Open the card this came from">↩ ${esc(t.title)}</button>` : '';
}

// The local days an event covers, first to last.
export function eventDays(e) {
  const start = new Date(e.starts_at);
  const last = key(new Date(Math.max(Date.parse(e.starts_at), Date.parse(e.ends_at) - 1)));
  const out = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()), i = 0; key(d) <= last && i < 62; i++) { out.push(key(d)); d.setDate(d.getDate() + 1); }
  return out;
}

// Events between two day keys (inclusive), shaped like a subscribed calendar's (js/ics.js
// eventsBetween) so Forecast shows both the same way; `own` and `id` mark ours as editable.
export function ownEvents(fromKey, toKey) {
  const out = [];
  liveEvents().forEach((e) => {
    const days = eventDays(e).filter((d) => d >= fromKey && d <= toKey);
    if (!days.length) return;
    const p = e.project_id && byId(db.projects, e.project_id);
    out.push({ id: e.id, own: true, uid: `${e.id}@todotooling.com`, title: e.title, location: e.location, url: e.url, allDay: e.all_day,
      start: e.starts_at, end: e.ends_at, days, busy: true, calendar: p ? p.name : null, color: EVENT_COLOR, task_id: e.task_id || null, raw: e });
  });
  return out.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
}

// ---------- distance: from you (location on), else from the place chosen in Settings ----------
export function distanceOrigin() {
  if (app.here) return { lat: app.here.lat, lng: app.here.lng, kind: 'here' };
  const p = activePlace((app.settings || {}).distance_place_id);
  return p ? { lat: p.lat, lng: p.lng, kind: 'place', name: p.name } : null;
}
const originKey = (o) => `${o.lat.toFixed(2)},${o.lng.toFixed(2)}`; // about a kilometre: a new key means "you moved"
export const eventDistanceM = (e) => { const o = distanceOrigin(); return o && e.lat != null && e.lng != null ? distanceM(o, e) : null; };
export const fmtDrive = (min) => (min < 60 ? `${min} min drive` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''} drive`);
// "23 mi · 35 min drive" for a row's meta line ('' when nothing is known).
export function distanceText(e) {
  const d = eventDistanceM(e);
  if (d == null) return '';
  const o = distanceOrigin();
  const drive = e.drive_minutes != null && e.drive_from === originKey(o) ? ` · ${fmtDrive(e.drive_minutes)}` : '';
  return `${fmtDistance(d)}${drive}`;
}

// Location text → { lat, lng } through Google's geocoder (null when unknown, offline or in tests).
export async function geocodeText(text) {
  if (!String(text || '').trim()) return null;
  if (window.__geocode) return window.__geocode(text); // tests
  const maps = await loadMaps();
  if (!maps) return null;
  try {
    const { results } = await new maps.Geocoder().geocode({ address: text });
    const r = results && results[0];
    return r ? { lat: r.geometry.location.lat(), lng: r.geometry.location.lng() } : null;
  } catch { return null; }
}
// Driving minutes from an origin to an event (Routes API; the browser key allows it for this site).
async function routeMinutes(origin, dest) {
  if (window.__routeMinutes) return window.__routeMinutes(origin, dest); // tests
  if (!window.GOOGLE_MAPS_KEY || window.__noMaps || !navigator.onLine) return null;
  try {
    const ll = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': window.GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'routes.duration' },
      body: JSON.stringify({ origin: ll(origin), destination: ll(dest), travelMode: 'DRIVE' }),
    });
    if (!res.ok) return null;
    const { routes } = await res.json();
    return routes && routes[0] && routes[0].duration ? Math.round(parseInt(routes[0].duration, 10) / 60) : null;
  } catch { return null; }
}
// After a render: fill in drive times that are missing or were measured from somewhere else, a few at
// a time, saving each on the event (so every device has it) and re-rendering as they arrive.
const driving = new Set();
export async function refreshDriveTimes(events, { limit = 6 } = {}) {
  const o = distanceOrigin();
  if (!o) return;
  const key = originKey(o);
  const todo = events.filter((e) => e.lat != null && e.lng != null && !(e.drive_minutes != null && e.drive_from === key) && !driving.has(e.id)).slice(0, limit);
  for (const e of todo) {
    driving.add(e.id);
    try {
      const min = await routeMinutes(o, e);
      if (min != null && byId(db.events, e.id)) await updateEvent(e, { drive_minutes: min, drive_from: key });
    } catch { /* next time */ } finally { driving.delete(e.id); }
  }
}

export async function insertEvent(fields) {
  const [row] = await run(sb.from('events').insert(fields).select());
  (db.events = db.events || []).push(row);
  app.render();
  return row;
}
export async function updateEvent(e, fields) {
  const [row] = await run(sb.from('events').update(fields).eq('id', e.id).select());
  syncRow('events', e, row);
  app.render();
  return row;
}
export async function archiveEvent(e) {
  await updateEvent(e, { archived_at: new Date().toISOString() });
  toast(`Removed “${e.title}”`, [{ label: 'Undo', run: () => updateEvent(e, { archived_at: null }) }]);
}
