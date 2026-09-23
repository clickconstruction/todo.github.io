// iCalendar (.ics) reading for Forecast: parse a calendar feed (Google, iCloud, Outlook "secret" or
// published links) and list the events between two days, with recurring events expanded.
// Pure (no DOM, no imports): used by the MCP server (which fetches the feeds) and tests.
//
// Handles: folded lines, escaped text, all-day and multi-day events, UTC / TZID / floating times,
// RRULE (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY incl. 1MO / -1FR,
// BYMONTHDAY, BYMONTH, BYSETPOS), EXDATE, RDATE, moved or edited occurrences (RECURRENCE-ID)
// and cancelled events. Windows zone names (Outlook) map to IANA names.

// ---------- lines and properties ----------
function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
function parseLine(line) {
  // NAME;PARAM=VALUE;PARAM="quoted:value":VALUE (the first ':' outside quotes splits)
  let q = false; let i = 0;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
  if (i >= line.length) return null;
  const head = line.slice(0, i); const value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [head];
  const name = parts[0].toUpperCase();
  const params = {};
  parts.slice(1).forEach((p) => { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ''); });
  return { name, params, value };
}
const unescapeText = (v) => String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// ---------- time zones ----------
const WINDOWS_ZONES = {
  'Pacific Standard Time': 'America/Los_Angeles', 'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago', 'Eastern Standard Time': 'America/New_York', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'E. Europe Standard Time': 'Europe/Bucharest', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
  'Central America Standard Time': 'America/Guatemala', 'Mexico Standard Time': 'America/Mexico_City', 'Canada Central Standard Time': 'America/Regina',
};
const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
export function zoneFor(tzid, fallback) {
  if (!tzid) return fallback;
  const clean = tzid.replace(/^\/[^/]*\//, '').replace(/^"|"$/g, ''); // "/mozilla.org/.../America/Chicago" style prefixes
  if (validZone(clean)) return clean;
  if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean];
  return fallback;
}
const FMT = new Map(); // one formatter per zone (creating them is the slow part)
const fmt = (tz, withTime) => {
  const k = `${tz}|${withTime}`;
  if (!FMT.has(k)) FMT.set(k, new Intl.DateTimeFormat('en-US', withTime ? { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' } : { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return FMT.get(k);
};
function offsetMs(ms, tz) {
  const p = Object.fromEntries(fmt(tz, true).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
}
// Wall-clock time (as a UTC-based "naive" ms) in tz → real UTC ms.
export function wallToUtc(naive, tz) {
  if (!tz || tz === 'UTC') return naive;
  const first = naive - offsetMs(naive, tz);
  return naive - offsetMs(first, tz);
}
const naiveOf = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo, d, h, mi, s);
const parts = (naive) => { const x = new Date(naive); return { y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), s: x.getUTCSeconds(), dow: x.getUTCDay() }; };
export const dayKeyIn = (ms, tz) => {
  const p = Object.fromEntries(fmt(tz, false).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

// A DATE / DATE-TIME value → { allDay, naive (wall time), tz (null = UTC) }
function parseWhen(prop, fallbackTz) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const allDay = prop.params.VALUE === 'DATE' || m[4] === undefined;
  const naive = naiveOf(+m[1], +m[2] - 1, +m[3], allDay ? 0 : +m[4], allDay ? 0 : +m[5], allDay ? 0 : +(m[6] || 0));
  const tz = allDay ? null : m[7] ? 'UTC' : zoneFor(prop.params.TZID, fallbackTz);
  return { allDay, naive, tz };
}
const utcOf = (w) => (w.allDay ? w.naive : wallToUtc(w.naive, w.tz));

function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---------- parse ----------
export function parseCalendar(text, { tz = 'UTC' } = {}) {
  const lines = unfold(text);
  const cal = { name: null, tz: null, events: [] };
  let ev = null; let depth = 0; let inOther = 0;
  for (const raw of lines) {
    if (!raw) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      depth++;
      if (p.value.toUpperCase() === 'VEVENT' && !ev) ev = { props: {}, multi: {} };
      else if (p.value.toUpperCase() !== 'VCALENDAR') inOther++;
      continue;
    }
    if (p.name === 'END') {
      depth--;
      if (p.value.toUpperCase() === 'VEVENT' && ev && !inOther) { cal.events.push(ev); ev = null; }
      else if (p.value.toUpperCase() !== 'VCALENDAR' && inOther) inOther--;
      continue;
    }
    if (inOther) continue; // VALARM, VTIMEZONE internals…
    if (ev) {
      if (['EXDATE', 'RDATE'].includes(p.name)) (ev.multi[p.name] = ev.multi[p.name] || []).push(p);
      else ev.props[p.name] = p;
    } else if (p.name === 'X-WR-CALNAME') cal.name = unescapeText(p.value);
    else if (p.name === 'X-WR-TIMEZONE') cal.tz = zoneFor(p.value, null);
  }
  const floating = cal.tz || tz;
  cal.events = cal.events.map((e) => {
    const start = parseWhen(e.props.DTSTART, floating);
    if (!start) return null;
    let endMs;
    const end = parseWhen(e.props.DTEND, floating);
    const dur = e.props.DURATION ? parseDuration(e.props.DURATION.value) : null;
    const startMs = utcOf(start);
    if (end) endMs = utcOf(end);
    else if (dur !== null) endMs = startMs + dur;
    else endMs = start.allDay ? startMs + 86400000 : startMs;
    const list = (name) => (e.multi[name] || []).flatMap((pp) => pp.value.split(',').map((v) => parseWhen({ ...pp, value: v }, floating)).filter(Boolean));
    return {
      uid: e.props.UID ? e.props.UID.value : null,
      title: unescapeText(e.props.SUMMARY ? e.props.SUMMARY.value : '(No title)') || '(No title)',
      location: e.props.LOCATION ? unescapeText(e.props.LOCATION.value) : '',
      url: e.props.URL ? e.props.URL.value : '',
      status: e.props.STATUS ? e.props.STATUS.value.toUpperCase() : '',
      transparent: e.props.TRANSP ? e.props.TRANSP.value.toUpperCase() === 'TRANSPARENT' : false,
      start, startMs, durationMs: Math.max(0, endMs - startMs),
      rrule: e.props.RRULE ? parseRRule(e.props.RRULE.value) : null,
      exdates: list('EXDATE'), rdates: list('RDATE'),
      recurrenceId: e.props['RECURRENCE-ID'] ? parseWhen(e.props['RECURRENCE-ID'], floating) : null,
    };
  }).filter(Boolean);
  return cal;
}

const DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseRRule(v) {
  const r = Object.fromEntries(v.split(';').filter(Boolean).map((kv) => { const [k, x] = kv.split('='); return [k.toUpperCase(), x || '']; }));
  return {
    freq: (r.FREQ || '').toUpperCase(), interval: Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null, until: r.UNTIL || null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((x) => { const m = x.trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { n: m[1] ? +m[1] : 0, dow: DAY[m[2]] } : null; }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number).filter(Boolean) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map((x) => +x - 1) : null,
    bysetpos: r.BYSETPOS ? r.BYSETPOS.split(',').map(Number) : null,
  };
}

// ---------- recurrence ----------
const daysIn = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
// Days (1..31) of a month matching BYDAY entries like MO, 1MO, -1FR.
function monthDaysByDay(y, mo, byday) {
  const n = daysIn(y, mo); const out = new Set();
  byday.forEach(({ n: ord, dow }) => {
    const hits = [];
    for (let d = 1; d <= n; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === dow) hits.push(d);
    if (!ord) hits.forEach((d) => out.add(d));
    else { const d = ord > 0 ? hits[ord - 1] : hits[hits.length + ord]; if (d) out.add(d); }
  });
  return [...out].sort((a, b) => a - b);
}
const withSetPos = (list, setpos) => (!setpos ? list : setpos.map((p) => (p > 0 ? list[p - 1] : list[list.length + p])).filter((x) => x !== undefined).sort((a, b) => a - b));

// Occurrence start times (UTC ms) of a recurring event, from its start up to `toMs`.
function occurrences(ev, fromMs, toMs) {
  const r = ev.rrule;
  const { start } = ev;
  const sp = parts(start.naive);
  const tz = start.tz;
  const toUtcMs = (naive) => (start.allDay ? naive : wallToUtc(naive, tz));
  let untilMs = null;
  if (r.until) { const u = parseWhen({ value: r.until, params: {} }, tz || 'UTC'); if (u) untilMs = u.allDay ? u.naive + 86399999 : utcOf(u); }
  if (untilMs !== null && untilMs < fromMs - 2 * 86400000) return []; // ended before the window
  const out = [];
  let count = 0;
  const early = fromMs - 3 * 86400000 - ev.durationMs; // wall times this early can't touch the window
  const push = (naive) => {
    if (naive < start.naive) return true;
    if (naive < early) { count++; return r.count === null || count < r.count; } // just count it
    const ms = toUtcMs(naive);
    if (untilMs !== null && ms > untilMs) return false;
    if (r.count !== null && count >= r.count) return false;
    count++;
    out.push(ms);
    return ms <= toMs;
  };
  const at = (y, mo, d) => naiveOf(y, mo, d, sp.h, sp.mi, sp.s);
  const LIMIT = 20000; // periods (a daily event for ~50 years)
  for (let i = 0, guard = 0; guard < LIMIT; i++, guard++) {
    let cands = [];
    if (r.freq === 'DAILY') {
      const base = start.naive + i * r.interval * 86400000;
      const b = parts(base);
      if ((!r.bymonth || r.bymonth.includes(b.mo)) && (!r.byday || r.byday.some((x) => x.dow === b.dow)) && (!r.bymonthday || r.bymonthday.includes(b.d))) cands = [at(b.y, b.mo, b.d)];
    } else if (r.freq === 'WEEKLY') {
      const weekStart = start.naive - ((sp.dow + 6) % 7) * 86400000 + i * r.interval * 7 * 86400000; // Monday of the week
      const dows = r.byday ? r.byday.map((x) => x.dow) : [sp.dow];
      cands = dows.map((dow) => { const b = parts(weekStart + ((dow + 6) % 7) * 86400000); return at(b.y, b.mo, b.d); }).sort((a, b) => a - b);
    } else if (r.freq === 'MONTHLY') {
      const mIndex = sp.mo + i * r.interval;
      const y = sp.y + Math.floor(mIndex / 12); const mo = ((mIndex % 12) + 12) % 12;
      if (!r.bymonth || r.bymonth.includes(mo)) {
        let days;
        if (r.bymonthday) days = r.bymonthday.map((d) => (d > 0 ? d : daysIn(y, mo) + d + 1)).filter((d) => d >= 1 && d <= daysIn(y, mo));
        else if (r.byday) days = monthDaysByDay(y, mo, r.byday);
        else days = sp.d <= daysIn(y, mo) ? [sp.d] : [];
        cands = withSetPos([...new Set(days)].sort((a, b) => a - b), r.bysetpos).map((d) => at(y, mo, d));
      }
    } else if (r.freq === 'YEARLY') {
      const y = sp.y + i * r.interval;
      const months = r.bymonth || [sp.mo];
      months.forEach((mo) => {
        let days;
        if (r.bymonthday) days = r.bymonthday.map((d) => (d > 0 ? d : daysIn(y, mo) + d + 1)).filter((d) => d >= 1 && d <= daysIn(y, mo));
        else if (r.byday) days = monthDaysByDay(y, mo, r.byday);
        else days = sp.d <= daysIn(y, mo) ? [sp.d] : [];
        days.forEach((d) => cands.push(at(y, mo, d)));
      });
      cands.sort((a, b) => a - b);
    } else {
      return [ev.startMs];
    }
    for (const c of cands) if (!push(c)) return out;
  }
  return out;
}

// ---------- events in a range ----------
// Everything that touches [fromKey, toKey] (inclusive days, in tz), recurring events expanded.
// → [{ uid, title, location, allDay, start (ISO), end (ISO), days: ['YYYY-MM-DD', …] }] sorted.
export function eventsBetween(cal, fromKey, toKey, { tz = 'UTC', calendar = null } = {}) {
  const fromMs = wallToUtc(Date.parse(`${fromKey}T00:00:00Z`), tz);
  const toMs = wallToUtc(Date.parse(`${toKey}T00:00:00Z`) + 86400000, tz) - 1;
  const byUid = new Map();
  cal.events.forEach((e) => { const k = e.uid || Math.random().toString(36); if (!byUid.has(k)) byUid.set(k, { master: null, overrides: [] }); const g = byUid.get(k); if (e.recurrenceId) g.overrides.push(e); else if (!g.master || e.rrule) g.master = e; });
  const out = [];
  const add = (e, startMs, source = e) => {
    if (source.status === 'CANCELLED') return;
    const endMs = startMs + source.durationMs;
    const allDay = source.start.allDay;
    // All-day times are dates: compare as days, not instants.
    const firstDay = allDay ? new Date(startMs).toISOString().slice(0, 10) : dayKeyIn(startMs, tz);
    const lastDay = allDay ? new Date(Math.max(startMs, endMs - 1)).toISOString().slice(0, 10) : dayKeyIn(Math.max(startMs, endMs - 1), tz);
    if (lastDay < fromKey || firstDay > toKey) return;
    const days = [];
    for (let d = firstDay, i = 0; d <= lastDay && i < 62; i++) { if (d >= fromKey && d <= toKey) days.push(d); d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10); }
    out.push({ uid: source.uid, title: source.title, location: source.location, url: source.url, allDay, calendar,
      start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), days, busy: !source.transparent });
  };
  byUid.forEach(({ master, overrides }) => {
    const moved = new Map(overrides.map((o) => [utcOf(o.recurrenceId), o]));
    if (!master) { overrides.forEach((o) => add(o, o.startMs)); return; }
    if (!master.rrule && !master.rdates.length) { add(master, master.startMs); overrides.forEach((o) => add(o, o.startMs)); return; }
    const ex = new Set(master.exdates.map(utcOf));
    const exDays = new Set(master.exdates.filter((x) => x.allDay).map((x) => new Date(x.naive).toISOString().slice(0, 10)));
    const starts = master.rrule ? occurrences(master, fromMs, toMs) : [master.startMs];
    master.rdates.forEach((r) => starts.push(utcOf(r)));
    [...new Set(starts)].sort((a, b) => a - b).forEach((ms) => {
      if (ex.has(ms) || (master.start.allDay && exDays.has(new Date(ms).toISOString().slice(0, 10)))) return;
      const o = moved.get(ms);
      if (o) { moved.delete(ms); add(master, o.startMs, o); } else add(master, ms);
    });
    moved.forEach((o) => add(master, o.startMs, o)); // edited occurrences outside the rule
  });
  return out.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
}
