// Calendar feeds for Forecast. Browsers can't read Google/iCloud/Outlook iCal links (no CORS), so
// the app asks this Worker: POST /calendar/fetch {id} (a saved calendar) or {url} (checking a new
// link before saving). The Worker fetches the feed (https only, 10s, 10 MB), keeps it ~10 minutes,
// and returns the raw .ics; the app parses it (js/ics.js). Only calendar data is ever returned.
// Agents manage the saved calendars with the calendars tool below.
import { parseCalendar, eventsBetween } from '../../js/ics.js';

const MAX_BYTES = 10 * 1024 * 1024;
const TTL = 600;

export function normalizeUrl(u) {
  const s = String(u || '').trim().replace(/^webcal:\/\//i, 'https://');
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  return url.toString();
}

const friendly = (status) => ({
  401: 'The calendar asked for a password. Use the private (secret) iCal link instead.',
  403: 'The calendar refused the request. The link may have been reset: copy the private iCal link again.',
  404: 'That link doesn’t exist any more. It may have been reset: copy the private iCal link again.',
}[status] || `The calendar server answered ${status}.`);

// → { ok, text } or { ok: false, error }
export async function fetchFeed(rawUrl, ctx, { sha256Hex }) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, error: 'Use an https:// or webcal:// calendar link.' };
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`https://mcp.todotooling.com/__calendar/${await sha256Hex(url)}`);
  if (cache) { const hit = await cache.match(key); if (hit) return { ok: true, text: await hit.text(), cached: true }; }
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'TodoTooling-Calendar/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'The calendar took too long to answer.' : 'Couldn’t reach that calendar link.' };
  }
  if (!res.ok) return { ok: false, error: friendly(res.status) };
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return { ok: false, error: 'That calendar is larger than 10 MB.' };
  const text = await res.text();
  if (text.length > MAX_BYTES) return { ok: false, error: 'That calendar is larger than 10 MB.' };
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) return { ok: false, error: 'That link isn’t a calendar feed (.ics). Use the private iCal address.' };
  if (cache) ctx.waitUntil(cache.put(key, new Response(text, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': `max-age=${TTL}` } })));
  return { ok: true, text };
}

export async function handleCalendarFetch(request, env, ctx, { rest, json, sha256Hex, cors }) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in first' }, 401);
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return json({ error: 'Your session expired. Reload the app.' }, 401);
  const { id: userId } = await who.json();
  let body = {};
  try { body = await request.json(); } catch { /* none */ }
  let url = body.url;
  if (body.id) {
    if (!/^[0-9a-f-]{36}$/i.test(body.id)) return json({ error: 'Bad calendar id' }, 400);
    const [row] = await rest(`calendars?user_id=eq.${userId}&id=eq.${body.id}&archived_at=is.null&select=url`);
    if (!row) return json({ error: 'Calendar not found' }, 404);
    url = row.url;
  }
  const out = await fetchFeed(url, ctx, { sha256Hex });
  if (!out.ok) return json({ error: out.error }, 422);
  return new Response(out.text, { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}

// Calendars for agents: what Settings → Calendars does in the app. A link goes in (add, update url)
// and is checked first, as the app does; it never comes back out: a private iCal link is a secret.
const COLORS = ['#1D9E75', '#7F77DD', '#D85A30', '#378ADD', '#D4537E', '#BA7517', '#639922', '#888780']; // as js/calendars.js
const SAFE = 'id,name,color,enabled,sort,last_ok_at,last_error,event_count,archived_at';

export function calendarsTools({ sha256Hex }) {
  const shape = (c) => ({ id: c.id, name: c.name, color: c.color, shown_in_forecast: !!c.enabled, events: c.event_count ?? undefined, last_ok: c.last_ok_at || undefined, error: c.last_error || undefined, archived: c.archived_at ? true : undefined });
  const color = (v) => { const s = String(v || '').trim(); if (!/^#[0-9A-Fa-f]{6}$/.test(s)) throw new Error('color is a hex colour like #378ADD'); return s; };
  const name = (v) => { const s = String(v || '').trim().slice(0, 100); if (!s) throw new Error('name is required'); return s; };
  // → { url, count, name } for a link that answers with a calendar; throws the reason otherwise.
  const check = async (api, raw) => {
    const url = normalizeUrl(raw);
    if (!url || url.length > 2000) throw new Error('Use an https:// or webcal:// calendar link.');
    const got = await fetchFeed(url, api.ctx || { waitUntil() {} }, { sha256Hex });
    if (!got.ok) throw new Error(got.error);
    const cal = parseCalendar(got.text, { tz: api.tz });
    return { url, count: cal.events.length, name: cal.name };
  };
  return [{
    name: 'calendars',
    description: `The user's subscribed calendars (Settings → Calendars): private iCal links from Google, iCloud or Outlook whose events show in Forecast. Their own events are the events tool; this is other calendars they follow.
actions: list {include_archived?} · add {url, name?, color?} (the link is checked first; name defaults to the calendar's own) · update {id or name, new_name?, color?, enabled? (false hides it from Forecast), url? (a replacement link, checked first)} · remove {id or name} (archived, never deleted) · restore {id}.
Links are private: you can save one the user gives you, but they are never returned.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'restore'], default: 'list' },
      id: { type: 'string' }, name: { type: 'string', description: 'add: what to call it; update/remove: which calendar (or pass id)' },
      new_name: { type: 'string' }, url: { type: 'string', description: 'The private iCal link (https:// or webcal://)' },
      color: { type: 'string', description: 'Hex colour, e.g. #378ADD' }, enabled: { type: 'boolean' }, include_archived: { type: 'boolean' },
    } },
    async run(api, a) {
      const action = a.action || 'list';
      const all = await api.q(`calendars?${api.u}&order=sort.asc&select=${SAFE}`);
      const live = all.filter((c) => !c.archived_at);
      const find = (pool) => {
        if (a.id) { const c = all.find((x) => x.id === a.id); if (!c) throw new Error('Calendar not found'); return c; }
        const key = String(a.name || '').trim().toLowerCase();
        if (!key) throw new Error('id or name is required');
        const hits = pool.filter((x) => x.name.toLowerCase() === key);
        if (hits.length !== 1) throw new Error(hits.length ? `More than one calendar is called "${a.name}". Pass its id.` : `No calendar called "${a.name}".`);
        return hits[0];
      };
      const patch = async (c, body) => shape((await api.q(`calendars?${api.u}&id=eq.${c.id}&select=${SAFE}`, { method: 'PATCH', prefer: 'return=representation', body }))[0]);
      if (action === 'add') {
        const got = await check(api, a.url);
        const row = { user_id: api.userId, name: name(a.name || got.name || 'Calendar'), url: got.url, enabled: true, color: a.color ? color(a.color) : COLORS[live.length % COLORS.length],
          sort: Math.max(-1, ...all.map((c) => c.sort || 0)) + 1, last_ok_at: new Date().toISOString(), event_count: got.count };
        const [c] = await api.q(`calendars?select=${SAFE}`, { method: 'POST', prefer: 'return=representation', body: row });
        return { ...shape(c), next: 'Its events now show in Forecast.' };
      }
      if (action === 'update') {
        const c = find(live);
        const body = {};
        if (a.new_name !== undefined) body.name = name(a.new_name);
        if (a.color !== undefined) body.color = color(a.color);
        if (a.enabled !== undefined) body.enabled = !!a.enabled;
        if (a.url !== undefined) { const got = await check(api, a.url); Object.assign(body, { url: got.url, last_ok_at: new Date().toISOString(), last_error: null, event_count: got.count }); }
        if (!Object.keys(body).length) throw new Error('Nothing to change');
        return patch(c, body);
      }
      if (action === 'remove') return { ...(await patch(find(live), { archived_at: new Date().toISOString() })), next: 'Removed (archived). calendars restore with this id brings it back.' };
      if (action === 'restore') return patch(find(all.filter((c) => c.archived_at)), { archived_at: null });
      return { calendars: (a.include_archived ? all : live).map(shape) };
    },
  }];
}

// For the MCP forecast: the user's enabled calendars' events between two days (never the links).
export async function calendarEvents(api, fromKey, toKey, ctx, { sha256Hex }) {
  const cals = await api.q(`calendars?${api.u}&archived_at=is.null&enabled=is.true&order=sort.asc&select=id,name,url,color`);
  const events = []; const errors = [];
  for (const c of cals) {
    try {
      const got = await fetchFeed(c.url, ctx || { waitUntil() {} }, { sha256Hex });
      if (!got.ok) { errors.push({ calendar: c.name, error: got.error }); continue; }
      eventsBetween(parseCalendar(got.text, { tz: api.tz }), fromKey, toKey, { tz: api.tz, calendar: c.name })
        .forEach((e) => events.push({ ...e, color: c.color }));
    } catch (e) { errors.push({ calendar: c.name, error: 'Calendar unavailable right now.' }); }
  }
  return { events, errors };
}
