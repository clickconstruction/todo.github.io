// Calendar feeds for Forecast. Browsers can't read Google/iCloud/Outlook iCal links (no CORS), so
// the app asks this Worker: POST /calendar/fetch {id} (a saved calendar) or {url} (checking a new
// link before saving). The Worker fetches the feed (https only, 10s, 10 MB), keeps it ~10 minutes,
// and returns the raw .ics; the app parses it (js/ics.js). Only calendar data is ever returned.
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
