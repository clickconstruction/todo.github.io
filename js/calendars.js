// Calendars in Forecast: the saved private iCal links (Settings → Calendars), fetched through the
// MCP Worker (browsers can't read them directly) and parsed here with js/ics.js. Feeds are kept for
// 5 minutes; Forecast renders with what it has and refreshes in the background.
import { db, app, sb, run, syncRow, toast } from './state.js';
import { parseCalendar, eventsBetween } from './ics.js';
import { localTz } from './repeat.js';

export const CAL_URL = 'https://mcp.todotooling.com/calendar/fetch';
export const COLORS = ['#1D9E75', '#7F77DD', '#D85A30', '#378ADD', '#D4537E', '#BA7517', '#639922', '#888780'];
const FRESH_MS = 5 * 60 * 1000;
const feeds = new Map(); // calendar id → { at, cal, error, loading }

export const liveCalendars = () => (db.calendars || []).filter((c) => !c.archived_at).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
export const maskUrl = (u) => { try { const x = new URL(String(u).replace(/^webcal:/i, 'https:')); return `${x.host}/…/${x.pathname.split('/').pop()}`; } catch { return '…'; } };

// Raw .ics text for a saved calendar ({ id }) or a link being checked ({ url }).
export async function fetchCalendarText(body) {
  if (window.__calendarFetch) return window.__calendarFetch(body); // tests
  const { data } = await sb.auth.getSession();
  if (!data || !data.session) throw new Error('Sign in again to load calendars.');
  const res = await fetch(CAL_URL, { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { let msg = `Calendar error (${res.status})`; try { msg = (await res.json()).error || msg; } catch { /* not json */ } throw new Error(msg); }
  return res.text();
}

async function loadFeed(c) {
  const f = feeds.get(c.id) || {};
  if (f.loading) return;
  feeds.set(c.id, { ...f, loading: true });
  try {
    const cal = parseCalendar(await fetchCalendarText({ id: c.id }), { tz: localTz() });
    feeds.set(c.id, { at: Date.now(), cal, error: null });
    const status = { last_ok_at: new Date().toISOString(), last_error: null, event_count: cal.events.length };
    if (c.last_error || c.event_count !== cal.events.length || !c.last_ok_at || Date.now() - Date.parse(c.last_ok_at) > 3600000) {
      run(sb.from('calendars').update(status).eq('id', c.id).select()).then(([row]) => row && syncRow('calendars', c, row)).catch(() => {});
    }
  } catch (e) {
    feeds.set(c.id, { at: Date.now(), cal: f.cal || null, error: e.message });
    if (c.last_error !== e.message) run(sb.from('calendars').update({ last_error: e.message }).eq('id', c.id).select()).then(([row]) => row && syncRow('calendars', c, row)).catch(() => {});
  }
  app.render();
}

// Events for Forecast between two day keys (inclusive), from what's loaded; starts refreshes.
export function calendarEvents(fromKey, toKey) {
  const out = [];
  liveCalendars().filter((c) => c.enabled).forEach((c) => {
    const f = feeds.get(c.id);
    if (!f || (!f.loading && Date.now() - f.at > FRESH_MS)) loadFeed(c);
    if (f && f.cal) eventsBetween(f.cal, fromKey, toKey, { tz: localTz(), calendar: c.name }).forEach((e) => out.push({ ...e, color: c.color, calendarId: c.id }));
  });
  return out.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
}
export const calendarsLoading = () => liveCalendars().some((c) => c.enabled && (!feeds.get(c.id) || feeds.get(c.id).loading));
export const calendarErrors = () => liveCalendars().filter((c) => c.enabled && feeds.get(c.id) && feeds.get(c.id).error).map((c) => ({ name: c.name, error: feeds.get(c.id).error }));
export const forgetFeed = (id) => feeds.delete(id);

// Check a link before saving: → { name, count, upcoming: [events], error }
export async function checkLink(url) {
  const text = await fetchCalendarText({ url });
  const cal = parseCalendar(text, { tz: localTz() });
  const today = new Date(); const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const later = new Date(today.getTime() + 60 * 86400000);
  const upcoming = eventsBetween(cal, key(today), key(later), { tz: localTz() }).filter((e) => (e.allDay ? e.days[e.days.length - 1] >= key(today) : Date.parse(e.end) >= Date.now())).slice(0, 3);
  return { name: cal.name, count: cal.events.length, upcoming };
}

export async function addCalendar({ name, url, color, count = null }) {
  const sort = Math.max(-1, ...(db.calendars || []).map((c) => c.sort || 0)) + 1;
  const [row] = await run(sb.from('calendars').insert({ name, url: url.trim(), color, sort, last_ok_at: new Date().toISOString(), event_count: count }).select());
  (db.calendars = db.calendars || []).push(row);
  return row;
}
export async function updateCalendar(c, fields) {
  const [row] = await run(sb.from('calendars').update(fields).eq('id', c.id).select());
  syncRow('calendars', c, row);
  if ('url' in fields || 'archived_at' in fields) forgetFeed(c.id);
  app.render();
  return row;
}
export async function archiveCalendar(c) {
  await updateCalendar(c, { archived_at: new Date().toISOString() });
  toast(`Removed “${c.name}”`, [{ label: 'Undo', run: () => updateCalendar(c, { archived_at: null }) }]);
}

export const fmtEventTime = (e) => {
  if (e.allDay) return 'All day';
  const t = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s/g, '').toLowerCase();
  return e.end && e.end !== e.start ? `${t(e.start)}–${t(e.end)}` : t(e.start);
};
