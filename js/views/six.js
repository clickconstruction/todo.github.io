// Six: the Ivy Lee list. Up to six cards for the day, in order; the first open one is Now, the rest
// wait under Then, and finished ones stay in place, crossed out. Today's and tomorrow's lists are the
// Daily review's focus rows (daily_reviews.focus), so both screens show the same list. What was left of
// the day before comes over to the top of today once (six_carry in the database; Undo is six_uncarry),
// and from the evening hour (Settings → Weekly and daily review) the view opens on tomorrow. Add offers
// suggestions first (overdue and due, flagged, what What now? would pick) and searches every open card.
// Keys: d done, n not now, t tomorrow, a add.
import { db, app, sb, run, syncRow, esc, byId, isOpen, toast, $, taskSort } from '../state.js';
import { setCompleted } from '../data.js';
import { startOfToday, addDays, atDefaultTime, isOverdue, fmtDate } from '../dates.js';
import { isAvailable } from '../availability.js';
import { rankNow } from '../whatnow.js';
import { dayKey } from '../gtd.js';
import { gainOf } from '../gain.js';
import { titleHtml } from '../rows.js';
import { rowFor } from './daily.js';

export const SIX = 6;
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const S = () => (app.six ||= { carried: null });
const dayOf = (key) => new Date(`${key}T12:00:00`);
const endOfDay = (key) => { const d = dayOf(key); d.setHours(23, 59, 59, 999); return d; };
const keyOf = (which) => dayKey(which === 'tomorrow' ? addDays(startOfToday(), 1) : startOfToday());
export const eveningMinutes = () => Number((app.settings && app.settings.six_evening_minutes) ?? 960);
export const isEvening = (d = new Date()) => d.getHours() * 60 + d.getMinutes() >= eveningMinutes();
const whichOf = (arg) => (arg === 'tomorrow' || arg === 'today' ? arg : isEvening() ? 'tomorrow' : 'today');
const eveningLabel = () => { const d = new Date(); d.setHours(0, eveningMinutes(), 0, 0); return d.toLocaleTimeString(undefined, eveningMinutes() % 60 ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' }); };
const fmtHM = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// The day's list: the ids on its row that are still loaded cards.
export const listOf = (key) => ((rowFor(key) || {}).focus || []).filter((id) => byId(db.tasks, id));
const tasksOf = (key) => listOf(key).map((id) => byId(db.tasks, id));
const projName = (t) => (t.project_id ? (byId(db.projects, t.project_id) || {}).name || '' : t.in_inbox ? 'Inbox' : '');

async function ensureRow(key) {
  const cur = rowFor(key);
  if (cur) return cur;
  const [row] = await run(sb.from('daily_reviews').insert({ day: key }).select());
  (db.dailyReviews = db.dailyReviews || []).unshift(row);
  return row;
}
function syncReview(row) {
  const r = Array.isArray(row) ? row[0] : row;
  if (!r) return null;
  const old = rowFor(r.day);
  if (old) return syncRow('dailyReviews', old, r);
  (db.dailyReviews = db.dailyReviews || []).unshift(r);
  return r;
}
async function setList(key, focus) {
  const r = await ensureRow(key);
  const [row] = await run(sb.from('daily_reviews').update({ focus }).eq('id', r.id).select());
  return syncRow('dailyReviews', r, row);
}
// On a day's list means planned for that day, so Forecast and Today agree with it.
async function planFor(t, key) {
  if (t.planned_at && dayKey(new Date(t.planned_at)) === key) return;
  const [row] = await run(sb.from('tasks').update({ planned_at: atDefaultTime(dayOf(key), 'planned_at').toISOString() }).eq('id', t.id).select());
  syncRow('tasks', t, row);
}
// What was left of the day before comes to the top of today, once: asked of the database the first
// time today's list is shown. The carried cards are then planned today.
function carryToday(key) {
  const s = S();
  if (s.carried === key) return;
  s.carried = key;
  run(sb.rpc('six_carry', { p_day: key })).then(async (row) => {
    const r = syncReview(row);
    if (!r) return;
    for (const id of r.carried || []) { const t = byId(db.tasks, id); if (t) await planFor(t, key); }
    app.render();
  }).catch(() => {});
}

// ---------- the screen ----------
function chips(t, carriedIn) {
  const out = [];
  const name = projName(t);
  if (name) out.push(`<span class="chip">${esc(name)}</span>`);
  if (t.due_at && isOpen(t)) out.push(`<span class="chip red">${isOverdue(t) ? 'overdue' : new Date(t.due_at) <= endOfDay(dayKey(startOfToday())) ? 'due today' : `due ${esc(fmtDate(t.due_at))}`}</span>`);
  if (t.flagged && isOpen(t)) out.push('<span class="chip">🚩 flagged</span>');
  if (carriedIn) out.push('<span class="chip">from yesterday</span>');
  if (t.estimate_minutes) out.push(`<span class="chip">${t.estimate_minutes} min</span>`);
  return out.join('');
}
// The gain is why it ranks where it does: the card's own, Claude's draft (kept with one tap), or its
// project's purpose; written from here when there is none.
function gainLine(t) {
  const g = gainOf(t, db.projects);
  if (!g) return `<span class="hint six-nogain">Gain · not written yet.</span> <button type="button" class="link-btn" data-task="${t.id}">Write it</button>`;
  if (g.suggested) return `<span class="chip sug">Claude suggested</span> ${esc(g.text)} <button type="button" class="link-btn" data-six="keep-gain" data-id="${t.id}">Keep</button>`;
  return `→ ${esc(g.text)}${g.own ? '' : ` <span class="hint">· from ${esc(g.project)}</span>`}`;
}
function nowCard(t, i, n, carriedIn) {
  return `<section class="six-now" aria-label="Now">
    <div class="six-now-head"><span class="six-label">Now · ${i + 1} of ${n}</span><span class="row-meta">${chips(t, carriedIn)}</span></div>
    <h2 class="six-now-title" data-task="${t.id}">${titleHtml(t.title)}</h2>
    <p class="six-gain">${gainLine(t)}</p>
    <div class="six-now-btns"><button type="button" class="btn primary" data-six="done" data-id="${t.id}">Done</button><button type="button" class="btn" data-six="bottom" data-id="${t.id}">Not now, to the bottom</button><button type="button" class="btn" data-six="tomorrow" data-id="${t.id}">Tomorrow</button><button type="button" class="btn link" data-task="${t.id}">Edit details</button></div>
  </section>`;
}
function rowHtml(t, i, n, which, carriedIn) {
  const open = isOpen(t);
  const other = which === 'today' ? 'tomorrow' : 'today';
  const state = open ? '' : t.dropped_at ? '<span class="chip">dropped</span>' : `<span class="chip ok">done${t.completed_at ? ` ${esc(fmtHM(t.completed_at))}` : ''}</span>`;
  return `<div class="six-row ${open ? '' : 'done'}">
    <button type="button" class="check ${open ? (isOverdue(t) ? 'overdue' : t.flagged ? 'flagged' : '') : 'done'}" data-six="${open ? 'done' : 'reopen'}" data-id="${t.id}" aria-label="${open ? 'Done' : 'Done; tap to reopen'}">✓</button>
    <span class="six-num">${i + 1}</span>
    <div class="row-main" data-task="${t.id}"><div class="row-title">${titleHtml(t.title)}</div><div class="row-meta">${chips(t, carriedIn)}${state}</div>${open ? `<p class="six-gain">${gainLine(t)}</p>` : ''}</div>
    ${open ? `<span class="six-ctl"><button type="button" class="six-ib" data-six="up" data-id="${t.id}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="six-ib" data-six="down" data-id="${t.id}" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn small" data-six="${other}" data-id="${t.id}">${other === 'tomorrow' ? 'Tomorrow' : 'Today'}</button><button type="button" class="six-ib" data-six="remove" data-id="${t.id}" aria-label="Take off the list">×</button></span>` : ''}
  </div>`;
}

export function viewSix(arg) {
  const which = whichOf(arg);
  const key = keyOf(which);
  const r = rowFor(key);
  if (which === 'today' && !(r && r.carried_at)) carryToday(key);
  const items = tasksOf(key);
  const open = items.filter(isOpen);
  const now = which === 'today' ? open[0] : null;
  const carried = new Set(which === 'today' && r ? (r.carried || []).filter((id) => items.some((t) => t.id === id)) : []);
  const doneN = items.length - open.length;
  let thenShown = false;
  const body = items.map((t, i) => {
    if (t === now) return nowCard(t, i, items.length, carried.has(t.id));
    let head = '';
    if (now && isOpen(t) && !thenShown) { thenShown = true; head = '<p class="six-then">Then</p>'; }
    return head + rowHtml(t, i, items.length, which, carried.has(t.id));
  }).join('');
  const full = items.length >= SIX;
  const tab = (w, label) => `<a href="#six/${w}" role="tab" class="${which === w ? 'on' : ''}" aria-selected="${which === w}">${label}</a>`;
  return `<div class="view-head"><h1 class="six">Six</h1><span class="six-seg" role="tablist" aria-label="Which day">${tab('today', 'Today')}${tab('tomorrow', 'Tomorrow')}</span></div>
    <p class="view-sub">${esc(dayOf(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))} · ${items.length ? `${doneN} of ${items.length} done` : 'nothing picked yet'} <span class="hint">· from ${esc(eveningLabel())}, Tomorrow opens first</span></p>
    ${carried.size ? `<div class="six-carried" role="status"><span>${carried.size === 1 ? 'One came over from yesterday and sits' : `${carried.size} came over from yesterday and sit`} at the top.</span><button type="button" class="link-btn" data-six="uncarry">Undo</button></div>` : ''}
    ${items.length ? body : '<div class="six-empty">Six things, in order. Work the first until it is finished, then the second. What is left tonight goes to the top of tomorrow.</div>'}
    ${which === 'today' && items.length && !open.length ? '<p class="six-all">All done ✓</p>' : ''}
    <div class="cl-bar six-foot"><button type="button" class="btn" data-six="add" ${full ? 'disabled' : ''}>＋ Add${full ? '' : ` the ${ORD[items.length]}`}</button><span class="hint">${full ? 'Six is the limit. Finish one, or send one to tomorrow.' : `${items.length} of ${SIX}`}</span></div>
    <p class="hint six-keys"><kbd>d</kbd> done · <kbd>n</kbd> not now · <kbd>t</kbd> tomorrow · <kbd>a</kbd> add</p>`;
}

// ---------- adding ----------
// Suggestions first (overdue and due, flagged, then what What now? would pick), and typing searches
// every open card, grouped by project, like the "waits for" picker.
function openAddPicker(key, which) {
  const dlg = $('#sheet2');
  const listed = new Set(listOf(key));
  const end = endOfDay(key);
  const all = db.tasks.filter((t) => isOpen(t) && !t.daily && !listed.has(t.id));
  const avail = all.filter((t) => isAvailable(t) && !t.in_inbox);
  const due = avail.filter((t) => t.due_at && new Date(t.due_at) <= end).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const dueIds = new Set(due.map((t) => t.id));
  const flagged = avail.filter((t) => t.flagged && !dueIds.has(t.id));
  const flagIds = new Set(flagged.map((t) => t.id));
  const next = rankNow(avail.filter((t) => !dueIds.has(t.id) && !flagIds.has(t.id)), { projects: db.projects, goals: db.goals || [], endOfToday: end, limit: 5 }).items.map((x) => x.t);
  const item = (t) => `<li><button type="button" class="po-item" data-six-pick="${t.id}">${esc(t.title)}${projName(t) ? `<span class="hint"> · ${esc(projName(t))}</span>` : ''}</button></li>`;
  const group = (label, list) => (list.length ? `<li class="po-group">${label}</li>${list.slice(0, 8).map(item).join('')}` : '');
  const draw = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let html;
    if (!words.length) {
      html = group(which === 'today' ? 'Overdue and due today' : 'Overdue and due by tomorrow', due) + group('Flagged', flagged) + group('What now? would pick next', next);
      if (!html) html = '<li class="hint">Nothing to suggest. Type to search every open card.</li>';
    } else {
      const hits = all.filter((t) => words.every((w) => `${t.title} ${projName(t)}`.toLowerCase().includes(w))).sort(taskSort);
      const groups = new Map();
      hits.slice(0, 80).forEach((t) => { const k = projName(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
      html = [...groups.entries()].map(([name, list]) => `<li class="po-group">${name ? `🗂️ ${esc(name)}` : '📥 Loose cards'}</li>${list.map(item).join('')}`).join('')
        + (hits.length ? (hits.length > 80 ? '<li class="hint">Keep typing to narrow it down…</li>' : '') : '<li class="hint">No matching cards.</li>');
    }
    $('[data-six-list]', dlg).innerHTML = html;
  };
  dlg.innerHTML = `<form method="dialog" class="part-of-picker six-pick"><h2>Add to ${which === 'today' ? 'today' : 'tomorrow'}</h2>
    <p class="hint" style="margin:0">Suggestions first. Type to search every open card.</p>
    <input type="search" data-six-search placeholder="Search anything…" aria-label="Search cards" autocomplete="off">
    <ul class="po-list" data-six-list></ul>
    <div class="actions"><div class="right"><button type="button" class="btn" data-six-cancel>Cancel</button></div></div></form>`;
  draw('');
  const search = $('[data-six-search]', dlg);
  search.oninput = () => draw(search.value);
  dlg.querySelector('form').onclick = async (e) => {
    if (e.target.closest('[data-six-cancel]')) { dlg.close(); return; }
    const b = e.target.closest('[data-six-pick]');
    if (!b) return;
    dlg.close();
    await addTo(key, byId(db.tasks, b.dataset.sixPick));
  };
  dlg.showModal();
  search.focus();
}
async function addTo(key, t) {
  if (!t) return;
  const list = listOf(key);
  if (list.length >= SIX) { toast('Six is the limit'); return; }
  if (list.includes(t.id)) return;
  await setList(key, [...list, t.id]);
  await planFor(t, key);
  toast(`Added as the ${ORD[list.length]}`);
  app.render();
}

// ---------- actions and keys ----------
export async function sixAction(el) {
  const a = el.dataset.six;
  const which = whichOf(location.hash.split('/')[1]);
  const key = keyOf(which);
  const t = el.dataset.id && byId(db.tasks, el.dataset.id);
  const list = listOf(key);
  const i = t ? list.indexOf(t.id) : -1;
  const move = (arr, from, to) => { const x = [...arr]; const [v] = x.splice(from, 1); x.splice(to, 0, v); return x; };
  if (a === 'add') { openAddPicker(key, which); return; }
  if (a === 'uncarry') { syncReview(await run(sb.rpc('six_uncarry', { p_day: key }))); toast('Yesterday’s leftovers are off today’s list'); app.render(); return; }
  if (!t) return;
  if (a === 'done') { await setCompleted(t, true); return; } // it redraws and says so
  if (a === 'reopen') { await setCompleted(t, false); return; }
  if (a === 'keep-gain') { const [row] = await run(sb.from('tasks').update({ gain_by: null }).eq('id', t.id).select()); syncRow('tasks', t, row); toast('Gain kept'); app.render(); return; }
  if (a === 'up' && i > 0) await setList(key, move(list, i, i - 1));
  else if (a === 'down' && i >= 0 && i < list.length - 1) await setList(key, move(list, i, i + 1));
  else if (a === 'bottom' && i >= 0) await setList(key, move(list, i, list.length - 1));
  else if (a === 'remove' && i >= 0) await setList(key, list.filter((id) => id !== t.id));
  else if ((a === 'tomorrow' || a === 'today') && i >= 0) {
    const toKey = keyOf(a);
    if (toKey === key) return;
    const target = listOf(toKey);
    if (target.length >= SIX) { toast(`${a === 'tomorrow' ? 'Tomorrow' : 'Today'} already has six`); return; }
    await setList(key, list.filter((id) => id !== t.id));
    await setList(toKey, [...target, t.id]);
    await planFor(t, toKey);
    toast(`Moved to ${a}`);
  }
  app.render();
}
export function sixKey(e) {
  if (!location.hash.startsWith('#six')) return false;
  if ($('#sheet2') && $('#sheet2').open) return false;
  const el = document.activeElement;
  const inClosedSheet = el && el.closest && el.closest('dialog') && !el.closest('dialog').open; // focus left behind in a sheet that has closed isn't typing
  if (el && !inClosedSheet && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable)) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const press = (sel) => { const b = document.querySelector(sel); if (b && !b.disabled) { e.preventDefault(); b.click(); return true; } return false; };
  if (e.key === 'a') return press('[data-six="add"]');
  if (e.key === 'd') return press('.six-now [data-six="done"]');
  if (e.key === 'n') return press('.six-now [data-six="bottom"]');
  if (e.key === 't') return press('.six-now [data-six="tomorrow"]');
  return false;
}
