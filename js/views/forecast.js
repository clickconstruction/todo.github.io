// Forecast: a day strip (Past · Today · next 6 days · Future) of what's due, planned,
// or becoming available. Replaces the old Today view. Past has one-tap triage for the
// classic "everything is overdue" problem: turn fake deadlines into plans.
import { db, app, esc, isOpen, visible, taskSort, onHoldTagFor, byId, tagLabel, effectiveTagIds } from '../state.js';
import { startOfToday, addDays, sameDay, dayStart, isDeferred } from '../dates.js';
import { taskList, projectRow } from '../rows.js';
import { filterBar, passes, sortTasks } from '../filter.js';
import { isFlaggedTask } from './basic.js';
import { weeklyBanner } from './weekly.js';
import { dailyBanner } from './daily.js';
import { followUpDue, isWaiting, livePeople, agendaFor, mentions } from '../gtd.js';
import { calendarEvents, calendarErrors, liveCalendars, fmtEventTime } from '../calendars.js';

const DAYS_AHEAD = 6;
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Buckets for one day: due that day, planned that day, deferred until that day.
function dayItems(day, tasks) {
  const on = (iso) => iso && sameDay(dayStart(iso), day);
  return {
    due: tasks.filter((t) => on(t.due_at)),
    planned: tasks.filter((t) => on(t.planned_at) && !on(t.due_at)),
    available: tasks.filter((t) => on(t.defer_at) && !on(t.due_at) && !on(t.planned_at)),
  };
}

export function forecastData() {
  const today = startOfToday();
  // Lists include just-completed items (struck through) so Undo has context; counts use open items.
  const tasks = db.tasks.filter(visible);
  const overdue = tasks.filter((t) => isOpen(t) && t.due_at && new Date(t.due_at) < today).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  const plannedPast = tasks.filter((t) => isOpen(t) && t.planned_at && new Date(t.planned_at) < today && !overdue.includes(t))
    .sort((a, b) => new Date(a.planned_at) - new Date(b.planned_at));
  const days = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => addDays(today, i));
  const horizon = addDays(today, DAYS_AHEAD + 1);
  const future = tasks.filter((t) => isOpen(t) && [t.due_at, t.planned_at].some((iso) => iso && new Date(iso) >= horizon))
    .sort((a, b) => new Date(a.due_at || a.planned_at) - new Date(b.due_at || b.planned_at));
  // Projects with their own dates show alongside actions.
  const liveProjects = db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold');
  const overdueProjects = liveProjects.filter((p) => p.due_at && new Date(p.due_at) < today);
  return { today, tasks, overdue, plannedPast, days, future, liveProjects, overdueProjects };
}

// Settings → Dates → "Always show in Today": open, not deferred, not parked actions with that tag (or a sub-tag).
export function forecastTag() { const id = app.settings && app.settings.forecast_tag_id; return id ? byId(db.tags, id) : null; }
export function forecastTagTasks(tasks = db.tasks) {
  const tag = forecastTag();
  if (!tag) return [];
  const ids = new Set([tag.id, ...db.tags.filter((g) => g.parent_id === tag.id).map((g) => g.id)]);
  return tasks.filter((t) => isOpen(t) && !isDeferred(t) && !onHoldTagFor(t) && [...effectiveTagIds(t)].some((x) => ids.has(x)));
}

const projectsOn = (day, projects) => projects.filter((p) => [p.due_at, p.planned_at].some((iso) => iso && sameDay(dayStart(iso), day)));
const projectSection = (title, list) => (list.length ? `<h2 class="section-title">${title} · ${list.length}</h2><div class="group-list">${list.map(projectRow).join('')}</div>` : '');

export const forecastBadgeCount = () => {
  const end = addDays(startOfToday(), 1);
  return db.tasks.filter((t) => isOpen(t) && t.due_at && new Date(t.due_at) < end && !onHoldTagFor(t)).length // parked items don't nag
    + db.projects.filter((p) => ['active', 'on_hold'].includes(p.status) && p.due_at && new Date(p.due_at) < end).length;
};

const fmtHM = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s/g, '').toLowerCase();
const eventRow = (e) => `<li class="cal-event ${e.busy ? '' : 'free'}" style="--cal:${esc(e.color)}">
  <span class="cal-time">${esc(fmtEventTime(e))}</span><span class="cal-main"><span class="cal-title">${esc(e.title)}</span>
  ${e.location || e.calendar ? `<span class="cal-meta">${[e.location, e.calendar].filter(Boolean).map((x) => esc(x.split('\n')[0])).join(' · ')}</span>` : ''}${agendaHtml(e)}</span></li>`;
// A scheduled action in the day: tick it off right there, tap to open it.
const schedRow = (t) => { const p = t.project_id && byId(db.projects, t.project_id); const end = Date.parse(t.scheduled_at) + (t.scheduled_minutes || 30) * 60000; return `<li class="cal-event sched ${t.completed_at ? 'done' : ''}" data-task="${t.id}">
  <span class="cal-time">${esc(fmtHM(Date.parse(t.scheduled_at)))}–${esc(fmtHM(end))}</span><span class="cal-main"><span class="cal-title">${esc(t.title)}</span>
  <span class="cal-meta">scheduled · ${t.scheduled_minutes || 30} min${p ? ` · ${esc(p.name)}` : ''}</span></span>
  <button class="check ${t.completed_at ? 'done' : ''}" data-check="${t.id}" aria-label="${t.completed_at ? 'Mark incomplete' : 'Complete'}">✓</button></li>`; };
const freeRow = (a, b) => `<li class="cal-free"><span class="cal-time">${esc(fmtHM(a))}</span><span class="hint">Free until ${esc(fmtHM(b))} · ${Math.round((b - a) / 60000)} min</span></li>`;

// Agenda items for the people named in an event's title ("1:1 with Jodi"), so they're there when you meet.
function agendaHtml(e) {
  const hits = livePeople().filter((p) => mentions(p, e.title) && agendaFor(p).length);
  return hits.map((p) => `<a class="cal-agenda" href="#person/${p.id}">🗣 ${esc(p.name)}: ${agendaFor(p).slice(0, 3).map((t) => esc(t.title)).join(' · ')}${agendaFor(p).length > 3 ? ` · +${agendaFor(p).length - 3}` : ''}</a>`).join('');
}

export function viewForecast(selected = 'today') {
  const { today, tasks, overdue, plannedPast, days, future, liveProjects, overdueProjects } = forecastData();
  const pastCount = overdue.length + plannedPast.length + overdueProjects.length;
  // Calendar events for the strip's days (loaded in the background; counts show once they arrive).
  const events = liveCalendars().some((c) => c.enabled) ? calendarEvents(key(days[0]), key(days[days.length - 1])) : [];
  const eventsOn = (k) => events.filter((e) => e.days.includes(k));
  const cell = (id, label, sub, n, cls = '', ev = 0) => `<a class="fc-day ${selected === id ? 'on' : ''} ${cls}" href="#forecast/${id}" aria-current="${selected === id}">
    <span class="fc-label">${label}</span><span class="fc-sub">${sub}</span><b class="fc-n">${n || ''}</b>${ev ? `<span class="fc-ev" title="${ev} calendar event${ev === 1 ? '' : 's'}">${ev} ev</span>` : ''}</a>`;
  const strip = [
    cell('past', 'Past', '', pastCount, overdue.length ? 'late' : ''),
    ...days.map((d, i) => {
      const it = dayItems(d, tasks.filter(isOpen));
      const tagged = i === 0 ? forecastTagTasks(tasks).filter((t) => !it.due.includes(t) && !it.planned.includes(t)).length : 0;
      const n = it.due.length + it.planned.length + projectsOn(d, liveProjects).length + tagged;
      return cell(i === 0 ? 'today' : key(d), i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }), d.getDate(), n, it.due.length && i === 0 ? 'due' : '', eventsOn(key(d)).length);
    }),
    cell('future', 'Future', '', future.length),
  ].join('');

  let body = ''; let notes = '';
  const section = (title, list, extra = '') => {
    const shown = list.filter(passes);
    return shown.length ? `<h2 class="section-title">${title} · ${shown.length}${extra}</h2>${taskList(sortTasks(shown, taskSort))}` : '';
  };

  if (selected === 'past') {
    body += section('Overdue (due)', overdue, overdue.length ? ` <button class="btn small" data-triage="due-to-planned" title="These deadlines passed. If they weren't real deadlines, keep them as plans for today.">Make planned today</button>` : '');
    body += projectSection('Overdue projects', overdueProjects);
    body += section('Planned earlier', plannedPast, plannedPast.length ? ' <button class="btn small" data-triage="planned-to-today">Move to today</button>' : '');
    if (!body) body = '<p class="empty">Nothing overdue. 🎉</p>';
  } else if (selected === 'future') {
    body = future.filter(passes).length ? taskList(future.filter(passes)) : '<p class="empty">Nothing scheduled beyond next week.</p>';
  } else {
    const day = selected === 'today' ? today : new Date(selected + 'T00:00');
    const it = dayItems(day, tasks);
    const isToday = sameDay(day, today);
    // Calendar first: the day's fixed commitments frame what the actions can fit around.
    const dayKey = key(day);
    const inStrip = days.some((d) => key(d) === dayKey);
    const dayEvents = inStrip ? eventsOn(dayKey) : (liveCalendars().some((c) => c.enabled) ? calendarEvents(dayKey, dayKey) : []);
    // The day: calendar events and scheduled actions in time order, with free gaps (today, 7am-7pm).
    const sched = tasks.filter((t) => t.scheduled_at && key(new Date(t.scheduled_at)) === dayKey && !t.dropped_at);
    const timed = [
      ...dayEvents.filter((e) => !e.allDay).map((e) => ({ at: e.start, end: e.end || e.start, html: eventRow(e) })),
      ...sched.map((t) => ({ at: t.scheduled_at, end: new Date(Date.parse(t.scheduled_at) + (t.scheduled_minutes || 30) * 60000).toISOString(), html: schedRow(t) })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const allDay = dayEvents.filter((e) => e.allDay);
    if (allDay.length || timed.length) {
      let cur = isToday ? Math.max(Date.now(), new Date(day).setHours(7, 0, 0, 0)) : null;
      const until = new Date(day).setHours(19, 0, 0, 0);
      const rows = [];
      for (const x of timed) {
        if (cur && Date.parse(x.at) - cur >= 30 * 60000 && cur < until) rows.push(freeRow(cur, Math.min(Date.parse(x.at), until)));
        rows.push(x.html);
        if (cur) cur = Math.max(cur, Date.parse(x.end));
      }
      if (cur && until - cur >= 30 * 60000 && timed.length) rows.push(freeRow(cur, until));
      body += `<h2 class="section-title">${sched.length ? 'Day' : 'Calendar'} · ${allDay.length + timed.length}</h2><ul class="list cal-list">${allDay.map(eventRow).join('')}${rows.join('')}</ul>`;
    }
    calendarErrors().forEach((c) => { body += `<p class="persp-warning">📅 ${esc(c.name)}: ${esc(c.error)} <a href="#settings">Settings</a></p>`; });
    // Nudges (start your day, weekly review, overdue) share one slim row of chips.
    if (isToday) notes += dailyBanner() + weeklyBanner();
    if (isToday && pastCount) notes += `<a class="fc-banner fc-overdue" href="#forecast/past">${overdue.length ? `<b>${overdue.length} overdue</b>` : ''}${overdue.length && plannedPast.length ? ' · ' : ''}${plannedPast.length ? `${plannedPast.length} planned earlier` : ''} → triage</a>`;
    if (isToday) notes += '<a class="fc-banner fc-now" href="#now">▶ What now?</a>';
    const follow = isToday ? db.tasks.filter((t) => followUpDue(t) && isWaiting(t)) : []; // not your actions, so the view filter doesn't apply
    if (follow.length) body += `<h2 class="section-title">Follow up · ${follow.length} <a class="btn small" href="#waiting">Waiting For</a></h2>${taskList(follow)}`;
    body += section('Due', it.due);
    body += section('Planned', it.planned.filter((t) => !(t.scheduled_at && key(new Date(t.scheduled_at)) === dayKey)));
    body += projectSection('Projects', projectsOn(day, liveProjects));
    body += section(isToday ? 'Available today' : 'Becomes available', it.available);
    if (isToday) {
      const dated = new Set([...it.due, ...it.planned, ...it.available].map((t) => t.id));
      const tag = forecastTag();
      const taggedList = forecastTagTasks(tasks).filter((t) => !dated.has(t.id));
      if (tag) body += section(`Tagged ${esc(tagLabel(tag))}`, taggedList);
      const shownTagged = new Set(taggedList.map((t) => t.id));
      body += section('Flagged', db.tasks.filter((t) => isOpen(t) && !isDeferred(t) && isFlaggedTask(t) && !dated.has(t.id) && !shownTagged.has(t.id)));
    }
    if (!body.trim()) body += `<p class="empty">Nothing due or planned ${isToday ? 'today' : 'this day'}.</p>`;
  }

  const title = selected === 'today' ? `Today · ${today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`
    : selected === 'past' ? 'Past' : selected === 'future' ? 'Later' : new Date(selected + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return `<div class="view-head"><h1 class="today">Forecast</h1></div>
    <nav class="fc-strip" aria-label="Days">${strip}</nav>
    ${filterBar()}
    <p class="view-sub">${esc(title)}</p>
    ${notes ? `<div class="fc-notes">${notes}</div>` : ''}
    ${body}`;
}
