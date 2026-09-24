// Matrix (#matrix, #matrix/<box>): your available actions in the four Eisenhower boxes, sorted from
// what the app already knows (js/matrix.js). ★/☆ corrects one; each box has one fitting move:
//   Do → plan for today · Schedule → a planned date · Delegate → Waiting For · Park → Someday/Maybe
// A lens, not a system: nothing new to fill in, and What now? stays how you pick what to do.
import { db, app, sb, run, esc, byId, toast, syncRow, isOpen } from '../state.js';
import { refreshTasks } from '../data.js';
import { isAvailable } from '../availability.js';
import { followUpDue, isWaiting } from '../gtd.js';
import { BOXES, makeMatrix, boxSort } from '../matrix.js';
import { atDefaultTime, toDateInput, fromDateInput, HOURS, isPlannedByToday, startOfToday } from '../dates.js';
import { saveSettings } from '../prefs.js';

const M = () => (app.mx ||= { keep: new Set() });
const SHOW = 300; // rows drawn in a box's list
const urgentDays = () => Number((app.settings || {}).matrix_urgent_days) || 7;

// { do: [{t, why, important}], schedule, delegate, park }
export function matrixBoxes() {
  const classify = makeMatrix({ projects: db.projects, goals: db.goals || [], urgentDays: urgentDays() });
  const out = Object.fromEntries(BOXES.map((b) => [b.key, []]));
  db.tasks.forEach((t) => {
    if (!isOpen(t) || t.in_inbox || t.reading_state) return;
    const late = !!(followUpDue(t) && isWaiting(t));
    if (!late && !isAvailable(t)) return;
    const c = classify(t, { waitingLate: late });
    out[c.box].push({ t, ...c });
  });
  Object.values(out).forEach((list) => list.sort((a, b) => boxSort(a.t, b.t)));
  return out;
}
export const parkCount = () => matrixBoxes().park.length;

const plannedToday = (t) => t.planned_at && isPlannedByToday(t) && new Date(t.planned_at) >= startOfToday();
const star = (x) => `<button class="mx-star ${x.important ? 'on' : ''}" data-mx="star" data-id="${x.t.id}" aria-label="${x.important ? 'Important: tap for not important' : 'Not important: tap to mark important'}" title="${x.important ? 'Important' : 'Mark important'}">${x.important ? '★' : '☆'}</button>`;
const item = (x, extra = '') => `<div class="mx-it">${star(x)}<span class="mx-main"><button class="link-btn mx-t" data-task="${x.t.id}">${esc(x.t.title)}</button><span class="mx-why">${esc(x.why.join(' · '))}${x.t.important !== null && x.t.important !== undefined ? ` · <button class="link-btn" data-mx="auto" data-id="${x.t.id}">auto</button>` : ''}</span></span>${extra}</div>`;

function box(b, list) {
  const unplanned = list.filter((x) => !x.t.planned_at).length;
  const more = list.length > 3 ? `+ ${(list.length - 3).toLocaleString()} more` : '';
  const note = b.key === 'schedule' && unplanned ? `${more ? `${more} · ` : ''}${unplanned.toLocaleString()} without a planned date` : b.key === 'park' && list.length ? `${more ? `${more} · ` : ''}star any you want to keep live` : more;
  const move = !list.length ? ''
    : b.key === 'do' ? (list.some((x) => !plannedToday(x.t)) ? `<button class="btn small" data-mx="plan-all">${b.move}</button>` : '<span class="hint">All planned for today ✓</span>')
    : `<a class="btn small" href="#matrix/${b.key}">${b.key === 'park' ? 'Park in Someday/Maybe…' : `${b.move}…`}</a>`;
  return `<section class="mx-box${b.key === 'schedule' ? ' key' : ''}" data-box="${b.key}">
    <a class="mx-bh" href="#matrix/${b.key}"><b>${b.label}</b>${b.key === 'schedule' ? '<span class="chip mx-pill">the one that matters</span>' : ''}<span class="mx-q">${b.urgent ? 'Urgent' : 'Not urgent'} · ${b.important ? 'important' : 'not important'}</span><span class="mx-n">${list.length.toLocaleString()}</span></a>
    ${list.length ? list.slice(0, 3).map((x) => item(x)).join('') : `<p class="hint">${b.key === 'do' ? 'Nothing urgent and important. Good.' : 'Empty.'}</p>`}
    ${note ? `<p class="mx-more">${note}</p>` : ''}
    <div class="mx-move">${move}</div></section>`;
}

export function viewMatrix(key) {
  const boxes = matrixBoxes();
  if (key && boxes[key]) return boxView(BOXES.find((b) => b.key === key), boxes[key]);
  const total = Object.values(boxes).reduce((s, l) => s + l.length, 0);
  const days = urgentDays();
  const B = (k) => box(BOXES.find((b) => b.key === k), boxes[k]);
  return `<div class="view-head"><h1>Matrix</h1><span class="hint">${total.toLocaleString()} actions</span></div>
    <p class="view-sub">Urgent: overdue, due within <select class="mx-days" data-mx-days aria-label="Urgent window">${[1, 2, 3, 5, 7, 10, 14, 21, 30].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>${d === 1 ? '1 day' : d === 7 ? '1 week' : d === 14 ? '2 weeks' : d === 21 ? '3 weeks' : `${d} days`}</option>`).join('')}</select>, or a late follow-up.
      Important: flagged, in a flagged project or one serving a goal, or marked ★. Tap ☆ or ★ to correct one.</p>
    <div class="mx-grid">
      <span></span><span class="mx-axis">Urgent</span><span class="mx-axis">Not urgent</span>
      <span class="mx-vaxis">Important</span>${B('do')}${B('schedule')}
      <span class="mx-vaxis">Not important</span>${B('delegate')}${B('park')}
    </div>`;
}

function boxView(b, list) {
  const m = M();
  let top = '';
  let rows;
  if (b.key === 'do') {
    top = list.some((x) => !plannedToday(x.t)) ? `<button class="btn primary" data-mx="plan-all">${b.move}</button>` : '';
    rows = list.slice(0, SHOW).map((x) => item(x, plannedToday(x.t) ? '<span class="hint">today ✓</span>' : `<button class="btn small" data-mx="plan-one" data-id="${x.t.id}">Today</button>`));
  } else if (b.key === 'schedule') {
    const sorted = [...list].sort((x, y) => Number(!!x.t.planned_at) - Number(!!y.t.planned_at));
    rows = sorted.slice(0, SHOW).map((x) => item(x, `<input type="date" class="mx-date" data-mx-plan="${x.t.id}" value="${toDateInput(x.t.planned_at)}" aria-label="Planned date for ${esc(x.t.title)}">`));
  } else if (b.key === 'delegate') {
    rows = list.slice(0, SHOW).map((x) => item(x, isWaiting(x.t) ? '<span class="hint">waiting</span>' : `<button class="btn small" data-mx="delegate" data-id="${x.t.id}">Hand off…</button>`));
  } else {
    const n = list.slice(0, SHOW).filter((x) => !m.keep.has(x.t.id)).length;
    top = list.length ? `<button class="btn primary" data-mx="park" ${n ? '' : 'disabled'}>Park ${n.toLocaleString()} in Someday/Maybe</button>
      <button class="link-btn" data-mx="tick-all">${n === Math.min(SHOW, list.length) ? 'Untick all' : 'Tick all'}</button>` : '';
    rows = list.slice(0, SHOW).map((x) => `<label class="mx-pick"><input type="checkbox" data-mx-keep="${x.t.id}" ${m.keep.has(x.t.id) ? '' : 'checked'}>${item(x)}</label>`);
    if (list.length > SHOW) rows.push(`<p class="hint mx-rest">+ ${(list.length - SHOW).toLocaleString()} more (newer ones). Park these first, then come back for the rest.</p>`);
  }
  return `<a class="back" href="#matrix">‹ Matrix</a>
    <div class="view-head"><h1>${b.label}</h1><span class="hint">${list.length.toLocaleString()}</span></div>
    <p class="view-sub">${b.hint}${b.key === 'park' && list.length ? ' Untick any you want to keep live, or ★ it.' : ''}</p>
    ${top ? `<div class="mx-top">${top}</div>` : ''}
    ${list.length ? `<div class="mx-list">${rows.join('')}</div>${b.key !== 'park' && list.length > SHOW ? `<p class="hint mx-rest">+ ${(list.length - SHOW).toLocaleString()} more</p>` : ''}` : '<p class="empty">Nothing here.</p>'}`;
}

// ---------- writes ----------
async function setTask(id, fields) {
  const t = byId(db.tasks, id);
  const [row] = await run(sb.from('tasks').update(fields).eq('id', id).select());
  syncRow('tasks', t, row);
}
const todayIso = () => atDefaultTime(new Date(), 'planned_at').toISOString();
async function planToday(ids) {
  const before = ids.map((id) => [id, (byId(db.tasks, id) || {}).planned_at || null]);
  const at = todayIso();
  await Promise.all(ids.map((id) => setTask(id, { planned_at: at })));
  app.render();
  toast(ids.length === 1 ? 'Planned for today' : `${ids.length} planned for today`, { label: 'Undo', run: async () => { await Promise.all(before.map(([id, p]) => setTask(id, { planned_at: p }))); app.render(); } });
}
async function refreshTags(ids) {
  await refreshTasks(ids);
  const links = ids.length ? await run(sb.from('task_tags').select('*').in('task_id', ids)) : [];
  const set = new Set(ids);
  db.taskTags = db.taskTags.filter((x) => !set.has(x.task_id)).concat(links);
}
export async function park(ids) {
  const r = await run(sb.rpc('matrix_park', { ids }));
  if (r.tag && !byId(db.tags, r.tag)) { const [g] = await run(sb.from('tags').select('*').eq('id', r.tag)); if (g) db.tags.push(g); }
  const parked = r.parked || [];
  await refreshTags(parked);
  return parked;
}
async function unpark(ids) { await run(sb.rpc('matrix_unpark', { ids })); await refreshTags(ids); }

export async function matrixAction(el) {
  const a = el.dataset.mx; const id = el.dataset.id;
  const m = M();
  if (a === 'star') {
    const x = Object.values(matrixBoxes()).flat().find((y) => y.t.id === id);
    await setTask(id, { important: !(x ? x.important : false) });
    app.render();
    return;
  }
  if (a === 'auto') { await setTask(id, { important: null }); app.render(); return; }
  if (a === 'plan-one') { await planToday([id]); return; }
  if (a === 'plan-all') { await planToday(matrixBoxes().do.filter((x) => !plannedToday(x.t)).map((x) => x.t.id)); return; }
  if (a === 'delegate') { const { openDelegate } = await import('../editors/gtd.js'); openDelegate(byId(db.tasks, id), { onDone: () => app.render() }); return; }
  if (a === 'tick-all') {
    const list = matrixBoxes().park.slice(0, SHOW);
    const allTicked = list.every((x) => !m.keep.has(x.t.id));
    m.keep = allTicked ? new Set(list.map((x) => x.t.id)) : new Set();
    app.render();
    return;
  }
  if (a === 'park') {
    const ids = matrixBoxes().park.slice(0, SHOW).map((x) => x.t.id).filter((x) => !m.keep.has(x));
    if (!ids.length) return;
    el.disabled = true;
    const parked = await park(ids);
    m.keep = new Set();
    location.hash = '#matrix';
    app.render();
    toast(`${parked.length.toLocaleString()} parked in Someday/Maybe`, { label: 'Undo', run: async () => { await unpark(parked); app.render(); toast('Back on your lists'); } });
  }
}
export function matrixChange(e) {
  const days = e.target.closest && e.target.closest('[data-mx-days]');
  if (days) { saveSettings({ matrix_urgent_days: Number(days.value) }, { quiet: true }).then(() => app.render()); return true; }
  const keep = e.target.closest && e.target.closest('[data-mx-keep]');
  if (keep) { const m = M(); if (keep.checked) m.keep.delete(keep.dataset.mxKeep); else m.keep.add(keep.dataset.mxKeep); app.render(); return true; }
  const plan = e.target.closest && e.target.closest('[data-mx-plan]');
  if (plan) { setTask(plan.dataset.mxPlan, { planned_at: fromDateInput(plan.value, HOURS.planned_at) }).then(() => { app.render(); toast(plan.value ? 'Planned' : 'Planned date cleared'); }); return true; }
  return false;
}
