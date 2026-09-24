// The Weekly Review: Get Clear, Get Current, Get Creative (js/weekly.js lists the steps). Each step
// opens the screen that does the job; steps with nothing to do count as done on their own. Progress
// is saved (weekly_reviews), so a review started on the phone can be finished on the laptop.
import { db, app, sb, run, syncRow, esc, byId, isOpen, visible, taskSort, toast } from '../state.js';
import { startOfToday, addDays, fmtDate } from '../dates.js';
import { STAGES, STEPS, STALE_DAYS, streak, reviewDue } from '../weekly.js';
import { taskList, projectRow } from '../rows.js';
import { isAvailable } from '../availability.js';
import { nextAction } from '../availability.js';
import { isDueForReview } from './review.js';
import { calendarEvents, liveCalendars, fmtEventTime, calendarsLoading } from '../calendars.js';
import { clarifyQueue } from './clarify.js';
import { waitingFor, followUpDue, isTickled, somedayItems, isSomeday, dayKey } from '../gtd.js';
import { waitingRow } from './gtd.js';
import { sweepHtml } from './sweep.js';
import { somedayListHtml } from './someday.js';

// ---------- the review row ----------
export const openReview = () => (db.weeklyReviews || []).find((r) => !r.completed_at && !r.abandoned_at) || null;
export const lastCompleted = () => (db.weeklyReviews || []).filter((r) => r.completed_at).sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0] || null;
export const isWeeklyDue = () => {
  const s = app.settings || {};
  const last = lastCompleted();
  return reviewDue({ reviewDay: s.review_day ?? 5, reviewMinutes: s.review_minutes ?? 900, lastCompleted: last && last.completed_at });
};
export const weeklyStreak = () => streak((db.weeklyReviews || []).map((r) => r.completed_at));

async function startReview() {
  const cur = openReview();
  if (cur) return cur;
  const [row] = await run(sb.from('weekly_reviews').insert({}).select());
  (db.weeklyReviews = db.weeklyReviews || []).unshift(row);
  return row;
}
async function patchReview(r, fields) {
  const [row] = await run(sb.from('weekly_reviews').update(fields).eq('id', r.id).select());
  return syncRow('weeklyReviews', r, row);
}
export async function markStep(key, done = true) {
  const r = openReview() || await startReview();
  const steps = { ...(r.steps || {}) };
  if (done) steps[key] = { done_at: new Date().toISOString(), n: ctx().count[key] ?? null };
  else delete steps[key];
  await patchReview(r, { steps });
}

// ---------- what each step has to go through ----------
export function staleActions() {
  const cutoff = Date.now() - STALE_DAYS * 86400000;
  return db.tasks.filter((t) => isOpen(t) && !t.in_inbox && !t.waiting_on && !t.agenda_for && !isTickled(t) && !isSomeday(t)
    && new Date(t.updated_at || t.created_at).getTime() < cutoff && (!t.project_id || ['active'].includes((byId(db.projects, t.project_id) || {}).status)))
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
}
export const stuckProjects = () => db.projects.filter((p) => p.status === 'active' && !nextAction(p));
function ctx() {
  const inbox = clarifyQueue().length;
  const stale = staleActions().length;
  const waiting = waitingFor().filter(isOpen);
  const dueFollow = waiting.filter(followUpDue).length;
  const projectsDue = db.projects.filter(isDueForReview).length;
  const stuck = stuckProjects().length;
  const some = somedayItems();
  const count = { inbox, stale, waiting: waiting.length, projects: projectsDue + stuck, someday: some.tasks.length + some.projects.length };
  // Nothing to do = done without a click.
  const auto = { inbox: inbox === 0, stale: stale === 0, waiting: dueFollow === 0, projects: projectsDue === 0 && stuck === 0 };
  const note = {
    inbox: inbox ? `${inbox} to clarify` : 'empty',
    stale: stale ? `${stale}` : 'none',
    waiting: waiting.length ? `${waiting.length}${dueFollow ? ` · ${dueFollow} to follow up` : ' · none due'}` : 'nothing',
    projects: [projectsDue && `${projectsDue} due`, stuck && `${stuck} stuck`].filter(Boolean).join(' · ') || 'all current',
    someday: `${count.someday}`,
  };
  return { count, auto, note };
}
export function stepStatus(r = openReview()) {
  const c = ctx();
  return STEPS.map((s) => {
    const done = !!(r && r.steps && r.steps[s.key]) || !!c.auto[s.key];
    return { ...s, done, auto: !(r && r.steps && r.steps[s.key]) && !!c.auto[s.key], note: c.note[s.key] || '', mins: s.minutes(c.count[s.key] || 0) };
  });
}

// ---------- overview ----------
const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function viewWeekly(step) {
  if (step === 'summary') return summaryHtml();
  if (step) return stepView(step);
  const r = openReview();
  const st = stepStatus(r);
  const last = lastCompleted();
  const s = app.settings || {};
  const left = st.filter((x) => !x.done).reduce((n, x) => n + x.mins, 0);
  const doneN = st.filter((x) => x.done).length;
  const rows = STAGES.map(([stage, label]) => `<h2 class="section-title">${label}</h2><div class="wk-steps">${st.filter((x) => x.stage === stage).map((x) => `<a class="wk-step ${x.done ? 'done' : ''}" href="#weekly/${x.key}">
      <span class="wk-check" aria-hidden="true">${x.done ? '✓' : ''}</span><span class="wk-title">${esc(x.title)}${x.note ? ` <span class="hint">· ${esc(x.note)}</span>` : ''}</span>
      <span class="hint">${x.done ? (x.auto ? 'nothing to do' : 'done') : `${x.mins} min`}</span></a>`).join('')}</div>`).join('');
  const streakN = weeklyStreak();
  const meta = [last ? `Last review ${fmtDate(last.completed_at)}` : 'No review yet', streakN > 1 ? `${streakN}-week streak` : '', `Review day: ${DAYS[s.review_day ?? 5]}`].filter(Boolean).join(' · ');
  const stale = r && Date.now() - new Date(r.started_at) > 6 * 86400000;
  return `<div class="view-head"><h1 class="review">Weekly Review</h1><span class="head-actions"><a class="btn small" href="#review" title="Review projects only">Projects only</a></span></div>
    <p class="view-sub">${esc(meta)}</p>
    ${r ? `<div class="wk-head"><div class="cl-progress"><i style="width:${Math.round((doneN / st.length) * 100)}%"></i></div>
      <p class="view-sub">${doneN} of ${st.length} steps${left ? ` · about ${left} min left` : ''} · started ${esc(fmtWhen(r.started_at))}${stale ? ' · <button class="link-btn" data-weekly="restart">Start over</button>' : ''}</p></div>`
    : `<div class="wk-intro"><p>Get clear, get current, get creative: about ${st.reduce((n, x) => n + (x.done ? 0 : x.mins), 0)} minutes this week. Steps with nothing to do are already ticked.</p>
      <button class="btn primary" data-weekly="start">Start the Weekly Review</button></div>`}
    ${rows}
    ${r ? `<div class="wk-finish"><button class="btn ${doneN === st.length ? 'primary' : ''}" data-weekly="finish">${doneN === st.length ? 'Finish the review' : 'Finish now'}</button></div>` : ''}
    ${recentHtml()}`;
}

function recentHtml() {
  const done = (db.weeklyReviews || []).filter((r) => r.completed_at).slice(0, 5);
  if (!done.length) return '';
  return `<h2 class="section-title">Recent reviews</h2><ul class="list wk-recent">${done.map((r) => `<li class="row"><div class="row-main"><div class="row-title">${esc(fmtDate(r.completed_at))}</div>
    <div class="row-meta">${esc(statsLine(r.stats))}</div></div></li>`).join('')}</ul>`;
}
const statsLine = (x = {}) => [x.captured != null && `${x.captured} captured`, x.completed != null && `${x.completed} done`, x.projects_reviewed != null && `${x.projects_reviewed} projects reviewed`, x.minutes != null && `${x.minutes} min`].filter(Boolean).join(' · ') || 'Completed';

// ---------- one step ----------
function stepView(key) {
  const i = STEPS.findIndex((s) => s.key === key);
  if (i < 0) return viewWeekly();
  const step = STEPS[i];
  const st = stepStatus().find((x) => x.key === key);
  const stageLabel = STAGES.find(([k]) => k === step.stage)[1];
  return `<a class="back" href="#weekly">‹ Weekly Review</a>
    <div class="view-head"><h1 class="review wk-h1">${esc(step.title)}</h1><span class="cl-count">${i + 1} of ${STEPS.length}</span></div>
    <div class="cl-progress"><i style="width:${Math.round(((i + (st.done ? 1 : 0)) / STEPS.length) * 100)}%"></i></div>
    <p class="view-sub">${esc(stageLabel)} · ${esc(step.hint)}</p>
    ${STEP_BODY[key]()}
    <div class="wk-foot">${i > 0 ? `<a class="btn" href="#weekly/${STEPS[i - 1].key}">‹ Back</a>` : '<span></span>'}
      ${key === 'new' ? '<button class="btn primary" data-weekly="finish">Finish the review</button>' : `<button class="btn primary" data-weekly="step-done" data-step="${key}">${st.done && st.auto ? 'Next' : 'Step done'} →</button>`}</div>`;
}

const captureBox = (placeholder, note = '') => `<form class="capture" data-wk-capture ${note ? `data-note="${esc(note)}"` : ''}><input type="text" name="title" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>`;
const capturedSince = () => { const r = openReview(); return r ? db.tasks.filter((t) => t.in_inbox && isOpen(t) && t.created_at >= r.started_at && !isTickled(t)).sort(taskSort) : []; };

function eventsHtml(fromKey, toKey, past) {
  if (!liveCalendars().some((c) => c.enabled)) return `<p class="empty small">No calendars connected. Look through your calendar app now, or add one in <a href="#settings">Settings → Calendars</a>.</p>${captureBox(past ? 'A follow-up from last week…' : 'Something to prepare…')}`;
  const events = calendarEvents(fromKey, toKey).filter((e) => (past ? true : true));
  const byDay = new Map();
  events.forEach((e) => { const d = e.days[0] < fromKey ? fromKey : e.days[0]; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e); });
  const days = [...byDay.keys()].sort((a, b) => (past ? b.localeCompare(a) : a.localeCompare(b)));
  if (!days.length) return `<p class="empty small">${calendarsLoading() ? 'Loading your calendars…' : 'Nothing on your calendar.'}</p>${captureBox('Anything else?')}`;
  return `<p class="hint">Tap an event to capture a ${past ? 'follow-up' : 'to-do'} for it.</p>${days.map((d) => `<h2 class="section-title">${esc(new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</h2>
    <ul class="list cal-list">${byDay.get(d).map((e) => `<li class="cal-event wk-ev" style="--cal:${esc(e.color)}"><details><summary><span class="cal-time">${esc(fmtEventTime(e))}</span><span class="cal-title">${esc(e.title)}</span></summary>
      ${captureBox(past ? `Follow-up for “${e.title}”…` : `To do before “${e.title}”…`, `From your calendar: ${e.title} (${d})`)}</details></li>`).join('')}</ul>`).join('')}`;
}

const STEP_BODY = {
  papers: () => `<ul class="wk-tips"><li>Paper inbox, desk, truck, pockets, wallet</li><li>Receipts and business cards</li><li>Notes on your phone, voice memos, photos of whiteboards</li><li>Email you flagged or starred elsewhere</li></ul>
    <p class="hint">Capture anything that needs doing; it goes to the Inbox and you’ll clarify it in step 3.</p>${captureBox('Capture something…')}
    ${taskList(capturedSince()) || ''}`,
  sweep: () => sweepHtml({ embedded: true }),
  inbox: () => {
    const n = clarifyQueue().length;
    return n ? `<div class="wk-card"><p class="wk-big">${n}</p><p>item${n === 1 ? '' : 's'} to clarify</p><a class="btn primary" href="#clarify">Process Inbox</a></div>`
      : '<div class="wk-card"><p class="wk-big">✓</p><p>Your Inbox is empty.</p></div>';
  },
  past: () => eventsHtml(dayKey(addDays(startOfToday(), -14)), dayKey(addDays(startOfToday(), -1)), true),
  next: () => eventsHtml(dayKey(startOfToday()), dayKey(addDays(startOfToday(), 21)), false),
  stale: () => {
    const list = staleActions();
    if (!list.length) return '<div class="wk-card"><p class="wk-big">✓</p><p>Every action has been touched in the last 60 days.</p></div>';
    return `<p class="view-sub">${list.length} not touched in ${STALE_DAYS}+ days. Still true?</p>${list.slice(0, 40).map((t) => {
      const p = t.project_id && byId(db.projects, t.project_id);
      const days = Math.floor((Date.now() - new Date(t.updated_at || t.created_at)) / 86400000);
      return `<div class="wk-stale" data-task-card="${t.id}"><b>${esc(t.title)}</b><span class="hint">${p ? `${esc(p.name)} · ` : ''}${days} days${isAvailable(t) ? '' : ' · not available now'}</span>
        <span class="row-actions"><button class="btn small" data-stale="keep" data-id="${t.id}">Keep</button><button class="btn small" data-stale="done" data-id="${t.id}">Done</button>
        <button class="btn small" data-stale="someday" data-id="${t.id}">Someday</button><button class="btn small" data-stale="drop" data-id="${t.id}">Drop</button></span></div>`;
    }).join('')}${list.length > 40 ? `<p class="hint">${list.length - 40} more after these.</p>` : ''}`;
  },
  waiting: () => {
    const list = waitingFor().filter(visible).sort((a, b) => (followUpDue(b) - followUpDue(a)) || String(a.follow_up_at || '9').localeCompare(String(b.follow_up_at || '9')));
    return list.length ? `<ul class="list">${list.map(waitingRow).join('')}</ul><p class="hint"><a href="#waiting">Open Waiting For</a> for agendas and people.</p>` : '<div class="wk-card"><p class="wk-big">✓</p><p>You’re not waiting on anyone.</p></div>';
  },
  projects: () => {
    const due = db.projects.filter(isDueForReview).length;
    const stuck = stuckProjects();
    return `${due ? `<div class="wk-card"><p class="wk-big">${due}</p><p>project${due === 1 ? '' : 's'} due for review</p><a class="btn primary" href="#review">Review projects</a></div>` : '<div class="wk-card"><p class="wk-big">✓</p><p>No projects due for review.</p></div>'}
      ${stuck.length ? `<h2 class="section-title">Stuck · ${stuck.length} <span class="hint">no next action</span></h2>${stuck.map((p) => `<div class="wk-stuck">${projectRow(p)}
        <form class="capture" data-capture data-project="${p.id}"><input type="text" name="title" placeholder="Next action for ${esc(p.name)}…" autocomplete="off" enterkeyhint="done"><button class="btn">Add</button></form></div>`).join('')}` : ''}`;
  },
  someday: () => somedayListHtml({ embedded: true }),
  new: () => `${captureBox('An idea, a project, something you’d like to do…')}${taskList(capturedSince().filter((t) => { const r = openReview(); return r && (!r.steps.someday || t.created_at >= r.steps.someday.done_at); })) || '<p class="hint">Captures go to the Inbox; they’ll be there to clarify next time.</p>'}`,
};

// ---------- finish ----------
export async function finishReview() {
  const r = openReview();
  if (!r) { location.hash = '#weekly'; return; }
  const since = r.started_at;
  const stats = {
    captured: db.tasks.filter((t) => t.created_at >= since).length,
    completed: db.tasks.filter((t) => t.completed_at && t.completed_at >= since).length,
    projects_reviewed: db.projects.filter((p) => p.last_reviewed_at && p.last_reviewed_at >= since).length,
    minutes: Math.max(1, Math.round((Date.now() - new Date(since)) / 60000)),
    steps_done: Object.keys(r.steps || {}).length,
  };
  if (stats.minutes > 24 * 60) delete stats.minutes; // spread over days: the clock time isn't meaningful
  await patchReview(r, { completed_at: new Date().toISOString(), stats });
  app.weeklyJust = r.id;
  location.hash = '#weekly/summary';
}

function summaryHtml() {
  const r = (app.weeklyJust && byId(db.weeklyReviews || [], app.weeklyJust)) || lastCompleted();
  if (!r) return viewWeekly();
  const x = r.stats || {};
  const n = weeklyStreak();
  const card = (v, l) => (v == null ? '' : `<div class="wk-stat"><b>${v}</b><span>${l}</span></div>`);
  return `<div class="cl-done"><div class="cl-big">🧭</div><h2>Review done</h2>
    <p>${n > 1 ? `${n} weeks in a row. ` : ''}Your system is current: everything captured, clarified and in its place.</p></div>
    <div class="wk-stats">${card(x.captured, 'captured')}${card(x.completed, 'completed')}${card(x.projects_reviewed, 'projects reviewed')}${card(x.minutes, 'minutes')}</div>
    <p class="wk-finish"><a class="btn primary" href="#forecast">Plan next week in Forecast</a> <a class="btn" href="#weekly">Weekly Review</a></p>`;
}

// ---------- clicks and forms ----------
export async function weeklyAction(el) {
  const a = el.dataset.weekly;
  if (a === 'start') { await startReview(); app.render(); return; }
  if (a === 'restart') {
    const r = openReview();
    if (r && confirm('Set this review aside and start a new one?')) { await patchReview(r, { abandoned_at: new Date().toISOString() }); await startReview(); app.render(); }
    return;
  }
  if (a === 'finish') {
    const left = stepStatus().filter((x) => !x.done).length;
    if (left && !confirm(`${left} step${left === 1 ? '' : 's'} not done. Finish anyway?`)) return;
    await finishReview();
    return;
  }
  if (a === 'step-done') {
    const key = el.dataset.step;
    const st = stepStatus().find((x) => x.key === key);
    if (!st.done || !st.auto) await markStep(key);
    const next = stepStatus().find((x) => !x.done && STEPS.findIndex((s) => s.key === x.key) > STEPS.findIndex((s) => s.key === key)) || stepStatus().find((x) => !x.done);
    location.hash = next ? `#weekly/${next.key}` : '#weekly';
    app.render();
  }
}

export async function staleAction(el) {
  const t = byId(db.tasks, el.dataset.id);
  if (!t) return;
  const patch = async (fields) => { const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select()); syncRow('tasks', t, row); };
  const kind = el.dataset.stale;
  if (kind === 'keep') await patch({ title: t.title }); // touched: not stale for another 60 days
  else if (kind === 'done') await patch({ completed_at: new Date().toISOString() });
  else if (kind === 'drop') { await patch({ dropped_at: new Date().toISOString() }); toast(`Dropped “${t.title}”`, [{ label: 'Undo', run: async () => { await patch({ dropped_at: null }); app.render(); } }]); }
  else if (kind === 'someday') { const { makeSomeday } = await import('../gtd.js'); await makeSomeday(t); toast('Moved to Someday/Maybe'); }
  app.render();
}

export function weeklySubmit(e) {
  const form = e.target.closest('[data-wk-capture]');
  if (!form) return false;
  e.preventDefault();
  const title = form.elements.title.value.trim();
  if (!title) return true;
  form.elements.title.value = '';
  import('../data.js').then(({ capture }) => capture(title, form.dataset.note ? { notes: form.dataset.note } : {})).then(() => {
    toast('Captured to the Inbox');
    const again = document.querySelector('[data-wk-capture] input');
    if (again && !form.closest('details')) again.focus();
  });
  return true;
}

// Forecast → Today and the sidebar: is it time?
export const weeklyBanner = () => (isWeeklyDue() && (new Date().getDay() === ((app.settings || {}).review_day ?? 5) || openReview())
  ? `<a class="fc-banner wk-banner" href="#weekly">🧭 ${openReview() ? 'Finish your Weekly Review' : 'It’s Weekly Review day'} →</a>` : '');
