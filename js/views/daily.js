// Daily review. Morning, "Start your day": the calendar first (hard landscape), then must-dos, then up
// to 3 things for today (planned today; "Fit in" makes a time block). Evening, "Shut down": capture,
// carry over what didn't happen, a glance at tomorrow. One row per day (daily_reviews).
import { db, app, sb, run, syncRow, esc, byId, isOpen, toast } from '../state.js';
import { startOfToday, addDays, atDefaultTime, endOfToday, fmtDate } from '../dates.js';
import { isAvailable } from '../availability.js';
import { rankNow } from '../whatnow.js';
import { calendarEvents, liveCalendars, fmtEventTime } from '../calendars.js';
import { dayKey, followUpDue, isWaiting, waitingPerson, messageLink, returnedFromTickler, isTickled } from '../gtd.js';
import { openLink } from '../editors/gtd.js';
import { openSchedule, slotsFor } from '../editors/schedule.js';
import { splitGain } from '../gain.js';
import { capture } from '../data.js';

export const MAX_FOCUS = 3;
const todayKey = () => dayKey(startOfToday());
export const rowFor = (key = todayKey()) => (db.dailyReviews || []).find((r) => r.day === key) || null;
async function ensureRow() {
  const cur = rowFor();
  if (cur) return cur;
  const [row] = await run(sb.from('daily_reviews').insert({ day: todayKey() }).select());
  (db.dailyReviews = db.dailyReviews || []).unshift(row);
  return row;
}
async function patchRow(fields) {
  const r = await ensureRow();
  const [row] = await run(sb.from('daily_reviews').update(fields).eq('id', r.id).select());
  return syncRow('dailyReviews', r, row);
}
// Consecutive days you started (today or ending yesterday).
export function dailyStreak() {
  const days = new Set((db.dailyReviews || []).filter((r) => r.started_at).map((r) => r.day));
  let d = startOfToday();
  if (!days.has(dayKey(d))) d = addDays(d, -1);
  let n = 0;
  while (days.has(dayKey(d))) { n += 1; d = addDays(d, -1); }
  return n;
}

const fmtHM = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtLen = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`);
const hasCal = () => liveCalendars().some((c) => c.enabled);

// The day: timed events and time blocks in order, plus free time left (7am–7pm).
function dayHtml(key, { freeLine = true } = {}) {
  const events = hasCal() ? calendarEvents(key, key) : [];
  const blocks = db.tasks.filter((t) => t.scheduled_at && dayKey(new Date(t.scheduled_at)) === key && !t.dropped_at);
  const rows = [
    ...events.map((e) => ({ at: e.allDay ? '' : e.start, html: `<div class="dv-row"><span class="dv-t">${esc(fmtEventTime(e))}</span><span class="dv-bar" style="--cal:${esc(e.color)}"></span><span class="dv-x">${esc(e.title)}</span></div>` })),
    ...blocks.map((t) => ({ at: t.scheduled_at, html: `<div class="dv-row" data-task="${t.id}"><span class="dv-t">${esc(fmtHM(t.scheduled_at))}</span><span class="dv-bar block"></span><span class="dv-x ${t.completed_at ? 'done' : ''}">${esc(t.title)} <span class="hint">scheduled</span></span></div>` })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const free = slotsFor(key, { id: null }, 15).reduce((n, s) => n + s.minutes, 0);
  const meetings = events.filter((e) => !e.allDay).length;
  const line = [meetings && `${meetings} meeting${meetings === 1 ? '' : 's'}`, blocks.length && `${blocks.length} time block${blocks.length === 1 ? '' : 's'}`, free && `${fmtLen(free)} free`].filter(Boolean).join(' · ');
  return { html: rows.map((r) => r.html).join('') || `<p class="hint">${hasCal() ? 'Nothing on your calendar.' : 'No calendars connected (Settings → Calendars).'}</p>`, line: freeLine ? line : '', free, meetings };
}

// Must-dos: due today or overdue, follow-ups due, back from the tickler.
function mustDos() {
  const end = endOfToday();
  const due = db.tasks.filter((t) => isOpen(t) && t.due_at && new Date(t.due_at) <= end && !isWaiting(t)).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const follow = db.tasks.filter((t) => followUpDue(t) && isWaiting(t));
  const tickled = db.tasks.filter((t) => returnedFromTickler(t) && !t.parent_id);
  return { due, follow, tickled, inbox: db.tasks.filter((t) => t.in_inbox && !t.parent_id && isOpen(t) && !isTickled(t)).length };
}

// Suggestions: the What now? ranking over what you could do today (not already in focus).
function suggestions(focus) {
  const pool = db.tasks.filter((t) => isOpen(t) && !t.in_inbox && isAvailable(t) && !focus.includes(t.id));
  return rankNow(pool, { projects: db.projects, goals: db.goals || [], endOfToday: endOfToday(), limit: 5 }).items;
}

const reasonChips = (reasons) => reasons.filter((r) => r.kind !== 'time').slice(0, 2).map((r) => `<span class="chip">${esc(r.text)}</span>`).join('');

export function viewDaily(mode) {
  const hour = new Date().getHours();
  // In the evening the day's page is Shut down, if the day was started earlier (not just now).
  const r0 = rowFor();
  if (mode === 'shutdown' || (!mode && hour >= 17 && r0 && r0.started_at && new Date(r0.started_at).getHours() < 17 && !r0.shutdown_at)) return shutdownHtml();
  const r = rowFor();
  const focus = (r ? r.focus : []).filter((id) => byId(db.tasks, id));
  const day = dayHtml(todayKey());
  const m = mustDos();
  const mustN = m.due.length + m.follow.length + m.tickled.length;
  const streak = dailyStreak();
  const focusRow = (t) => `<div class="dv-pick on" data-task="${t.id}"><button class="dv-box on ${t.completed_at ? 'done' : ''}" data-daily="unfocus" data-id="${t.id}" aria-label="Remove from today">✓</button>
    <span class="dv-x ${t.completed_at ? 'done' : ''}">${esc(t.title)}${t.estimate_minutes ? ` <span class="hint">${t.estimate_minutes} min</span>` : ''}</span>
    ${t.scheduled_at ? `<span class="chip acc">⏰ ${esc(fmtHM(t.scheduled_at))}</span>` : isOpen(t) ? `<button class="btn small" data-daily="fit" data-id="${t.id}">Fit in</button>` : ''}</div>`;
  const sugs = focus.length < MAX_FOCUS ? suggestions(focus) : [];
  return `<div class="view-head"><h1 class="daily">${hour < 12 ? 'Good morning' : hour < 17 ? 'Your day' : 'This evening'}</h1><span class="cl-count">${esc(new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</span></div>
    ${r && r.started_at ? `<div class="dv-ready"><b>Ready for today</b><span class="hint">${focus.length} focus · ${esc(day.line)}${mustN ? ` · ${mustN} must-do${mustN === 1 ? '' : 's'}` : ''}</span>
      <span><a class="btn primary" href="#now">What now? →</a> ${hour >= 15 ? '<a class="btn" href="#daily/shutdown">Shut down</a>' : ''}</span></div>` : ''}
    <h2 class="section-title dv-sec">Your day <span class="hint">${esc(day.line)}</span></h2><div class="dv-day">${day.html}</div>
    <h2 class="section-title dv-sec">Must-dos <span class="hint">${mustN || 'none'}</span></h2>
    ${m.due.map((t) => `<div class="dv-row" data-task="${t.id}"><span class="dv-x">${esc(t.title)}</span><span class="chip red">${new Date(t.due_at) < startOfToday() ? 'overdue' : 'due today'}</span>${!t.planned_at || new Date(t.planned_at) > endOfToday() ? `<button class="btn small" data-daily="focus" data-id="${t.id}" ${focus.length >= MAX_FOCUS ? 'disabled' : ''}>Today</button>` : ''}</div>`).join('')}
    ${m.follow.map((t) => { const p = waitingPerson(t); return `<div class="dv-row" data-task="${t.id}"><span class="dv-x">${esc(t.title)}${p ? ` · ${esc(p.name)}` : ''}</span><span class="chip">follow up</span>${p && (p.email || p.phone) ? `<button class="btn small" data-daily="nudge" data-id="${t.id}">Nudge</button>` : ''}</div>`; }).join('')}
    ${m.tickled.map((t) => `<div class="dv-row" data-task="${t.id}"><span class="dv-x">📆 ${esc(t.title)}</span><span class="chip">from the tickler</span></div>`).join('')}
    ${m.inbox ? `<p class="hint">📥 ${m.inbox} in the Inbox · <a href="#clarify">Process</a></p>` : ''}
    <h2 class="section-title dv-sec">Today’s focus <span class="hint">${focus.length} of ${MAX_FOCUS}</span></h2>
    ${focus.map((id) => focusRow(byId(db.tasks, id))).join('') || '<p class="hint">Pick up to three things that would make today a good day.</p>'}
    ${sugs.length ? `<p class="hint dv-sug">Suggested by What now?</p>${sugs.map(({ t, reasons }) => `<div class="dv-pick" data-task="${t.id}"><button class="dv-box" data-daily="focus" data-id="${t.id}" aria-label="Add to today">＋</button>
      <span class="dv-x">${esc(t.title)}<span class="dv-why">${reasonChips(reasons)}${t.estimate_minutes ? `<span class="chip">${t.estimate_minutes} min</span>` : ''}</span></span></div>`).join('')}` : ''}
    ${r && r.started_at ? '' : '<div class="wk-finish"><button class="btn primary" data-daily="start">Start the day</button></div>'}
    <p class="hint dv-foot">${streak > 1 ? `☀️ ${streak} days in a row · ` : ''}<a href="#daily/shutdown">Shut down</a> in the evening</p>`;
}

function shutdownHtml() {
  const r = rowFor();
  const focus = (r ? r.focus : []).map((id) => byId(db.tasks, id)).filter(Boolean);
  const done = focus.filter((t) => t.completed_at).length;
  const tmr = dayKey(addDays(startOfToday(), 1));
  const day = dayHtml(tmr, { freeLine: false });
  const tEnd = addDays(endOfToday(), 1);
  const dueTmr = db.tasks.filter((t) => isOpen(t) && t.due_at && new Date(t.due_at) > endOfToday() && new Date(t.due_at) <= tEnd);
  return `<a class="back" href="#daily">‹ Today</a><div class="view-head"><h1 class="daily">Shut down</h1></div>
    ${r && r.shutdown_at ? '<div class="dv-ready"><b>Done for today 🌙</b><span class="hint">Everything is captured and carried over.</span></div>' : ''}
    <h2 class="section-title dv-sec">Anything on your mind?</h2>
    <form class="capture" data-daily-capture><input type="text" name="title" placeholder="Capture it before you stop…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    <h2 class="section-title dv-sec">Today’s focus <span class="hint">${focus.length ? `${done} of ${focus.length} done` : 'none picked'}</span></h2>
    ${focus.map((t) => (t.completed_at || t.dropped_at ? `<div class="dv-row"><span class="ok">✓</span><span class="dv-x done">${esc(t.title)}</span></div>`
      : `<div class="dv-row" data-task="${t.id}"><span>○</span><span class="dv-x">${esc(t.title)}</span><span class="dv-carry"><button class="btn small primary" data-daily="tomorrow" data-id="${t.id}">Tomorrow</button><button class="btn small" data-daily="nextweek" data-id="${t.id}">Next week</button><button class="btn small" data-daily="drop" data-id="${t.id}">Drop</button></span></div>`)).join('') || '<p class="hint">Tomorrow morning, pick up to three.</p>'}
    <h2 class="section-title dv-sec">Tomorrow <span class="hint">${esc(new Date(`${tmr}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }))}${dueTmr.length ? ` · ${dueTmr.length} due` : ''}</span></h2>
    <div class="dv-day">${day.html}</div>
    ${dueTmr.map((t) => `<div class="dv-row" data-task="${t.id}"><span class="dv-x">${esc(t.title)}</span><span class="chip red">due ${esc(fmtDate(t.due_at))}</span></div>`).join('')}
    ${r && r.shutdown_at ? '' : '<div class="wk-finish"><button class="btn primary" data-daily="shutdown">Done for today</button></div>'}`;
}

export async function dailyAction(el) {
  const a = el.dataset.daily;
  const t = el.dataset.id && byId(db.tasks, el.dataset.id);
  const patchT = async (fields) => { const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select()); syncRow('tasks', t, row); };
  const r = rowFor();
  const focus = r ? [...r.focus] : [];
  if (a === 'focus' && t) {
    if (focus.length >= MAX_FOCUS) { toast(`Up to ${MAX_FOCUS} for today`); return; }
    await patchRow({ focus: [...new Set([...focus, t.id])] });
    if (!t.planned_at || new Date(t.planned_at) > endOfToday() || new Date(t.planned_at) < startOfToday()) await patchT({ planned_at: atDefaultTime(startOfToday(), 'planned_at').toISOString() });
  } else if (a === 'unfocus' && t) await patchRow({ focus: focus.filter((id) => id !== t.id) });
  else if (a === 'fit' && t) { openSchedule(t); return; }
  else if (a === 'nudge' && t) { const p = waitingPerson(t); const link = p && messageLink(p, t, { nudge: true, via: p.email ? 'email' : 'text' }); if (link) openLink(link); return; }
  else if (a === 'start') { await patchRow({ started_at: new Date().toISOString() }); window.scrollTo(0, 0); }
  else if (a === 'tomorrow' && t) { await patchT({ planned_at: atDefaultTime(addDays(startOfToday(), 1), 'planned_at').toISOString(), scheduled_at: null, scheduled_minutes: null }); toast('Planned for tomorrow'); }
  else if (a === 'nextweek' && t) { await patchT({ planned_at: atDefaultTime(addDays(startOfToday(), 7), 'planned_at').toISOString(), scheduled_at: null, scheduled_minutes: null }); toast('Planned for next week'); }
  else if (a === 'drop' && t) { await patchT({ dropped_at: new Date().toISOString() }); toast(`Dropped “${t.title}”`, [{ label: 'Undo', run: async () => { await patchT({ dropped_at: null }); app.render(); } }]); }
  else if (a === 'shutdown') await patchRow({ shutdown_at: new Date().toISOString() });
  app.render();
}

export function dailySubmit(e) {
  const form = e.target.closest('[data-daily-capture]');
  if (!form) return false;
  e.preventDefault();
  const title = form.elements.title.value.trim();
  if (!title) return true;
  form.elements.title.value = '';
  const sg = splitGain(title);
  capture(sg.title, sg.gain ? { gain: sg.gain } : {}).then(() => { toast('Captured to the Inbox'); const i = document.querySelector('[data-daily-capture] input'); if (i) i.focus(); });
  return true;
}

// Forecast → Today: the way in (morning until started; after 5pm, shut down).
export function dailyBanner() {
  const r = rowFor();
  const hour = new Date().getHours();
  if (hour >= 17 && r && r.started_at && !r.shutdown_at) {
    const f = r.focus.map((id) => byId(db.tasks, id)).filter(Boolean);
    return `<a class="fc-banner dv-banner" href="#daily/shutdown">🌙 Shut down${f.length ? ` · ${f.filter((t) => t.completed_at).length} of ${f.length} focus done` : ''} →</a>`;
  }
  if (!r || !r.started_at) return `<a class="fc-banner dv-banner" href="#daily">☀️ ${hour < 12 ? 'Start your day' : 'Plan today'} · 2 min →</a>`;
  return '';
}
