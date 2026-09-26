// Events: your own calendar entries (an airshow, a trip, an appointment), upcoming by month, past
// folded away. Not actions: nothing to tick off. Tap one to edit; + Event adds one. Forecast shows
// the same events by day, and its Future bucket lists the ones beyond next week.
import { db, esc, byId } from '../state.js';
import { liveEvents, eventDays, EVENT_COLOR, fromHtml, distanceText, refreshDriveTimes, distanceOrigin } from '../events.js';
import { fmtEventTime } from '../calendars.js';

const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayKey = () => key(new Date());
const lastDay = (e) => { const d = eventDays(e); return d[d.length - 1]; };
const bySoonest = (a, b) => a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title);

// "Sat, Oct 31 – Sun, Nov 1", "Sat, Oct 31" or "Sat, Oct 31 · 10:30am–4:15pm".
export function fmtWhen(e) {
  const days = eventDays(e);
  const d = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (e.all_day) return days.length > 1 ? `${d(days[0])} – ${d(days[days.length - 1])}` : d(days[0]);
  return `${d(days[0])} · ${fmtEventTime({ allDay: false, start: e.starts_at, end: e.ends_at })}`;
}
export function eventRow(e) {
  const p = e.project_id && byId(db.projects, e.project_id);
  const meta = [e.location, distanceText(e), p && p.name].filter(Boolean);
  return `<li class="cal-event own" style="--cal:${EVENT_COLOR}" data-event="${e.id}" title="Edit event">
    <span class="cal-time">${esc(fmtWhen(e))}</span><span class="cal-main"><span class="cal-title">${esc(e.title)}</span>
    ${meta.length ? `<span class="cal-meta">${meta.map((x) => esc(x.split('\n')[0])).join(' · ')}</span>` : ''}${fromHtml(e.task_id)}</span></li>`;
}

// Events still to come (or under way) on or after a day, soonest first.
export const upcomingEvents = (fromKey = todayKey()) => liveEvents().filter((e) => lastDay(e) >= fromKey).sort(bySoonest);
// The sidebar badge: how many start (or run) within the next 7 days.
export function eventsThisWeekCount() {
  const t = new Date(); const end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 6);
  return upcomingEvents().filter((e) => eventDays(e)[0] <= key(end)).length;
}

// After the list renders: drive times for what's coming up (router AFTER hook, also used by Forecast).
export const refreshEventDrives = () => refreshDriveTimes(upcomingEvents());

export function viewEvents(section) {
  const today = todayKey();
  const upcoming = upcomingEvents(today);
  const past = liveEvents().filter((e) => lastDay(e) < today).sort((a, b) => bySoonest(b, a));
  const months = new Map();
  upcoming.forEach((e) => { const m = eventDays(e)[0].slice(0, 7); if (!months.has(m)) months.set(m, []); months.get(m).push(e); });
  const label = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  let body = [...months].map(([m, list]) => `<h2 class="section-title">${esc(label(m))} · ${list.length}</h2><ul class="list cal-list ev-list">${list.map(eventRow).join('')}</ul>`).join('');
  if (!upcoming.length) body = `<p class="empty">Nothing coming up. Add an event, or ask Claude to put something on your calendar.</p>`;
  if (past.length) body += `<details class="ev-past" ${section === 'past' ? 'open' : ''}><summary class="section-title">Past · ${past.length}</summary><ul class="list cal-list ev-list">${past.slice(0, 100).map(eventRow).join('')}</ul></details>`;
  return `<div class="view-head"><h1>Events</h1><span><button class="btn small primary" data-act="new-event">+ Event</button></span></div>
    <p class="view-sub">Your own calendar entries. They show in Forecast on their days and in your calendar feed. Not actions: nothing to tick off.${(() => { const o = distanceOrigin(); return o ? ` Distances from ${o.kind === 'here' ? 'where you are' : esc(o.name)}.` : ' <a href="#nearby">Turn on location</a> to see how far each one is.'; })()}</p>
    ${body}`;
}
