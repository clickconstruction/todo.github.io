// Your own events (an airshow, a trip, an appointment): held here, shown in Forecast on every day
// they cover, and sent out in the private calendar feed so they reach your phone. Not actions.
// Timed events have instants; an all-day event runs from local midnight of its first day to local
// midnight after its last day (exclusive, as iCalendar does it). Archived, never deleted.
import { db, app, sb, run, syncRow, toast, byId } from './state.js';

export const EVENT_COLOR = '#7F77DD';
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const liveEvents = () => (db.events || []).filter((e) => !e.archived_at);

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
      start: e.starts_at, end: e.ends_at, days, busy: true, calendar: p ? p.name : null, color: EVENT_COLOR });
  });
  return out.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
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
