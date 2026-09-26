// Schedule it: free slots between calendar events, and scheduled actions as calendar events (.ics
// for Apple, a pre-filled Google Calendar link, and the private feed the Worker serves). Pure.

const MIN = 60000;

// Free gaps in [from, to) around busy blocks ({ start, end } ISO), at least `need` minutes long.
export function freeSlots(busy, from, to, need = 30, { step = 15 } = {}) {
  const round = (t) => Math.ceil(t / (step * MIN)) * step * MIN; // start on the quarter hour
  const blocks = busy.map((b) => [Date.parse(b.start), Date.parse(b.end || b.start)]).filter(([s, e]) => e > from && s < to).sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = round(Math.max(from, Date.now() - 0));
  for (const [s, e] of [...blocks, [to, to]]) {
    if (s - cur >= need * MIN) out.push({ start: new Date(cur).toISOString(), end: new Date(Math.min(s, to)).toISOString(), minutes: Math.round((Math.min(s, to) - cur) / MIN) });
    cur = Math.max(cur, round(e));
  }
  return out;
}

// Busy blocks for a day: timed calendar events (not "free"/transparent) and other scheduled actions.
export function busyBlocks(events, tasks, skipId = null) {
  return [
    ...events.filter((e) => !e.allDay && e.busy !== false).map((e) => ({ start: e.start, end: e.end || e.start })),
    ...tasks.filter((t) => t.id !== skipId && t.scheduled_at && !t.completed_at && !t.dropped_at)
      .map((t) => ({ start: t.scheduled_at, end: new Date(Date.parse(t.scheduled_at) + (t.scheduled_minutes || 30) * MIN).toISOString() })),
  ];
}

const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines over 75 octets are folded (RFC 5545).
const fold = (line) => { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ` ${s.slice(74)}`; } out.push(s); return out.join('\r\n'); };

export function eventOf(t, { project = null, appUrl = 'https://todotooling.com/' } = {}) {
  const start = t.scheduled_at;
  const end = new Date(Date.parse(start) + (t.scheduled_minutes || t.estimate_minutes || 30) * MIN).toISOString();
  const link = `${appUrl}#task/${t.id}`;
  return { uid: `${t.id}@todotooling.com`, start, end, title: `${t.completed_at ? '✓ ' : ''}${t.title}`, details: [project && `Project: ${project}`, t.notes && t.notes.slice(0, 500), link].filter(Boolean).join('\n\n'), link, updated: t.updated_at || t.created_at || start };
}

// One of your own events (js/events.js) as a feed entry. All-day: DATE values, end exclusive, in the
// user's time zone (dayKey turns an instant into that zone's YYYY-MM-DD).
export function ownEventOf(ev, { project = null, dayKey, appUrl = 'https://todotooling.com/' } = {}) {
  const link = `${appUrl}#forecast/${dayKey(ev.starts_at)}`;
  return { uid: `${ev.id}@todotooling.com`, allDay: !!ev.all_day, start: ev.all_day ? dayKey(ev.starts_at) : ev.starts_at, end: ev.all_day ? dayKey(ev.ends_at) : ev.ends_at,
    title: ev.title, location: ev.location || '', details: [project && `Project: ${project}`, ev.notes && ev.notes.slice(0, 500), ev.url, link].filter(Boolean).join('\n\n'), link: ev.url || link, updated: ev.updated_at || ev.created_at };
}

export function icsCalendar(events, { name = 'Todo Tooling' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Todo Tooling//Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`,
    'X-PUBLISHED-TTL:PT15M', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M'];
  for (const e of events) {
    const when = (k, v) => (e.allDay ? `${k};VALUE=DATE:${String(v).replace(/-/g, '')}` : `${k}:${icsDate(v)}`);
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${icsDate(e.updated)}`, when('DTSTART', e.start), when('DTEND', e.end),
      `SUMMARY:${icsText(e.title)}`, `DESCRIPTION:${icsText(e.details)}`, ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []), `URL:${e.link}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// Google Calendar's "create event" page, pre-filled (the user presses Save).
export const googleCalendarUrl = (e) => `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(e.title)}&dates=${icsDate(e.start)}/${icsDate(e.end)}&details=${encodeURIComponent(e.details)}`;
