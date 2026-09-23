// Forecast: a day strip (Past · Today · next 6 days · Future) of what's due, planned,
// or becoming available. Replaces the old Today view. Past has one-tap triage for the
// classic "everything is overdue" problem: turn fake deadlines into plans.
import { db, esc, isOpen, visible, taskSort, onHoldTagFor } from '../state.js';
import { startOfToday, addDays, sameDay, dayStart, isDeferred } from '../dates.js';
import { taskList, projectRow } from '../rows.js';
import { filterBar, passes, sortTasks } from '../filter.js';
import { isFlaggedTask } from './basic.js';

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

const projectsOn = (day, projects) => projects.filter((p) => [p.due_at, p.planned_at].some((iso) => iso && sameDay(dayStart(iso), day)));
const projectSection = (title, list) => (list.length ? `<h2 class="section-title">${title} · ${list.length}</h2><div class="group-list">${list.map(projectRow).join('')}</div>` : '');

export const forecastBadgeCount = () => {
  const end = addDays(startOfToday(), 1);
  return db.tasks.filter((t) => isOpen(t) && t.due_at && new Date(t.due_at) < end && !onHoldTagFor(t)).length // parked items don't nag
    + db.projects.filter((p) => ['active', 'on_hold'].includes(p.status) && p.due_at && new Date(p.due_at) < end).length;
};

export function viewForecast(selected = 'today') {
  const { today, tasks, overdue, plannedPast, days, future, liveProjects, overdueProjects } = forecastData();
  const pastCount = overdue.length + plannedPast.length + overdueProjects.length;
  const cell = (id, label, sub, n, cls = '') => `<a class="fc-day ${selected === id ? 'on' : ''} ${cls}" href="#forecast/${id}" aria-current="${selected === id}">
    <span class="fc-label">${label}</span><span class="fc-sub">${sub}</span><b class="fc-n">${n || ''}</b></a>`;
  const strip = [
    cell('past', 'Past', '', pastCount, overdue.length ? 'late' : ''),
    ...days.map((d, i) => {
      const it = dayItems(d, tasks.filter(isOpen));
      const n = it.due.length + it.planned.length + projectsOn(d, liveProjects).length;
      return cell(i === 0 ? 'today' : key(d), i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }), d.getDate(), n, it.due.length && i === 0 ? 'due' : '');
    }),
    cell('future', 'Future', '', future.length),
  ].join('');

  let body = '';
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
    if (isToday && pastCount) body += `<a class="fc-banner" href="#forecast/past">${overdue.length ? `<b>${overdue.length} overdue</b>` : ''}${overdue.length && plannedPast.length ? ' · ' : ''}${plannedPast.length ? `${plannedPast.length} planned earlier` : ''} → triage</a>`;
    body += section('Due', it.due);
    body += section('Planned', it.planned);
    body += projectSection('Projects', projectsOn(day, liveProjects));
    body += section(isToday ? 'Available today' : 'Becomes available', it.available);
    if (isToday) {
      const dated = new Set([...it.due, ...it.planned, ...it.available].map((t) => t.id));
      body += section('Flagged', db.tasks.filter((t) => isOpen(t) && !isDeferred(t) && isFlaggedTask(t) && !dated.has(t.id)));
    }
    if (!body.replace(/<a class="fc-banner"[\s\S]*?<\/a>/, '').trim()) body += `<p class="empty">Nothing due or planned ${isToday ? 'today' : 'this day'}.</p>`;
  }

  const title = selected === 'today' ? `Today · ${today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`
    : selected === 'past' ? 'Past' : selected === 'future' ? 'Later' : new Date(selected + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return `<div class="view-head"><h1 class="today">Forecast</h1></div>
    <nav class="fc-strip" aria-label="Days">${strip}</nav>
    ${filterBar()}
    <p class="view-sub">${esc(title)}</p>
    ${body}`;
}
