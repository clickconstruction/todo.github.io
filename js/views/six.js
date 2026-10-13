// Six: the Ivy Lee list. Up to six cards for the day, in order; the first open one is Now, the rest
// wait under Then, and finished ones stay in place, crossed out. Today's and tomorrow's lists are the
// Daily review's focus rows (daily_reviews.focus), so both screens show the same list. What was left of
// the day before comes over to the top of today once (six_carry in the database; Undo is six_uncarry),
// and from the evening hour (Settings → Weekly and daily review) the view opens on tomorrow. Add is the
// picker in js/six-picker.js: suggestions, or a place to look, and a search; several cards at once.
// Keys: d done, n not now, t tomorrow, a add.
// The screen answers at once: a move changes the list here and redraws, and the write follows; if the
// write fails the rows are read back and the toast says why. While the view is open it listens for
// changes made elsewhere (Claude's six tool, another device): live updates when available, a poll either way.
import { db, app, sb, run, syncRow, esc, byId, isOpen, toast, $ } from '../state.js';
import { setCompleted, refreshTasks, capture, setLinks } from '../data.js';
import { startOfToday, addDays, atDefaultTime, isOverdue, fmtDate } from '../dates.js';
import { dayKey } from '../gtd.js';
import { gainOf } from '../gain.js';
import { titleHtml } from '../rows.js';
import { rowFor } from './daily.js';
import { openSixPicker } from '../six-picker.js';

export const SIX = 6;
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const S = () => (app.six ||= { carried: null, flash: new Set(), inserting: {} });
const L = { poll: null, channel: null }; // the live connection lives outside app.six, so it is always stopped
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
const move = (arr, from, to) => { const x = [...arr]; const [v] = x.splice(from, 1); x.splice(to, 0, v); return x; };

// ---------- the list, here first, then in the database ----------
// put() changes a day's list in memory (a day with no row yet gets one, written on the first save);
// save() writes what the list is now. A failed write reads the rows back, so the screen is honest.
function put(key, focus) {
  let r = rowFor(key);
  if (!r) { r = { id: null, day: key, focus: [], carried: [], carried_at: null, started_at: null, shutdown_at: null }; (db.dailyReviews = db.dailyReviews || []).unshift(r); }
  r.focus = focus;
  return r;
}
async function save(key) {
  const s = S();
  const r = rowFor(key);
  if (!r) return;
  try {
    if (!r.id) {
      s.inserting[key] ||= run(sb.from('daily_reviews').insert({ day: key, focus: r.focus }).select()).then(([row]) => { Object.assign(r, row); delete s.inserting[key]; }).catch((e) => { delete s.inserting[key]; throw e; });
      await s.inserting[key];
    }
    const [row] = await run(sb.from('daily_reviews').update({ focus: r.focus }).eq('id', r.id).select());
    syncRow('dailyReviews', r, row);
  } catch {
    await reload([key]);
    app.render();
  }
}
async function reload(keys) {
  const rows = await run(sb.from('daily_reviews').select('*').in('day', keys));
  keys.forEach((key) => { const have = rows.find((x) => x.day === key); const local = rowFor(key); if (have) { if (local) Object.assign(local, have); else db.dailyReviews.unshift(have); } else if (local && !local.id) db.dailyReviews.splice(db.dailyReviews.indexOf(local), 1); });
}
// On a day's list means planned for that day, so Forecast and Today agree with it.
async function planFor(t, key) {
  if (t.planned_at && dayKey(new Date(t.planned_at)) === key) return;
  const [row] = await run(sb.from('tasks').update({ planned_at: atDefaultTime(dayOf(key), 'planned_at').toISOString() }).eq('id', t.id).select());
  syncRow('tasks', t, row);
}
// A card that just moved, landed or arrived lights up briefly on the next draw.
const flash = (...ids) => { const s = S(); ids.forEach((id) => s.flash.add(id)); };
// What was left of the day before comes to the top of today, once: asked of the database the first
// time today's list is shown. The carried cards are then planned today.
function carryToday(key) {
  const s = S();
  if (s.carried === key) return;
  s.carried = key;
  run(sb.rpc('six_carry', { p_day: key })).then(async (row) => {
    const r = syncReview(row);
    if (!r) return;
    flash(...(r.carried || []));
    for (const id of r.carried || []) { const t = byId(db.tasks, id); if (t) await planFor(t, key); }
    app.render();
  }).catch(() => {});
}
function syncReview(row) {
  const r = Array.isArray(row) ? row[0] : row;
  if (!r) return null;
  const old = rowFor(r.day);
  if (old) return Object.assign(old, r);
  (db.dailyReviews = db.dailyReviews || []).unshift(r);
  return r;
}

// ---------- changes made elsewhere ----------
// Claude's six tool and another device write the same rows. Live updates when the client has them, and a
// poll either way (two rows and the cards on them), while the view is open.
function listen() {
  if (L.poll) return;
  L.poll = setInterval(poll, window.__sixPollMs || 20000);
  if (sb.channel && app.user) {
    try {
      L.channel = sb.channel('six').on('postgres_changes', { event: '*', schema: 'public', table: 'daily_reviews', filter: `user_id=eq.${app.user.id}` }, (p) => { if (onRow(p.new)) redraw(); }).subscribe();
    } catch { L.channel = null; }
  }
}
function stopListening() {
  if (L.channel) { try { sb.removeChannel(L.channel); } catch { /* ignore */ } L.channel = null; }
  if (L.poll) { clearInterval(L.poll); L.poll = null; }
}
// A row from elsewhere: taken if newer; cards it names that aren't loaded are fetched. True when it changed anything.
function onRow(r) {
  if (!r || !r.day) return false;
  const old = rowFor(r.day);
  if (old && old.id && old.updated_at === r.updated_at) return false;
  if (old) Object.assign(old, r); else (db.dailyReviews = db.dailyReviews || []).unshift(r);
  const missing = (r.focus || []).filter((id) => !byId(db.tasks, id));
  if (missing.length) refreshTasks(missing).then(redraw).catch(() => {});
  return true;
}
async function poll() {
  if (!location.hash.startsWith('#six')) { stopListening(); return; }
  const keys = [keyOf('today'), keyOf('tomorrow')];
  const stamp = () => keys.flatMap((k) => [((rowFor(k) || {}).updated_at || ''), ...tasksOf(k).map((t) => t.updated_at || '')]).join('|');
  const before = stamp();
  try {
    const rows = await run(sb.from('daily_reviews').select('*').in('day', keys));
    rows.forEach(onRow);
    const ids = [...new Set(keys.flatMap(listOf))];
    if (ids.length) await refreshTasks(ids);
  } catch { return; }
  if (stamp() !== before || S().dirty) redraw(); // dirty: a change that arrived while a sheet was open
}
// Typing somewhere: a field with focus, unless it is left behind in a sheet that has closed.
function typing() {
  const el = document.activeElement;
  if (!el || !el.tagName) return false;
  if (el.closest && el.closest('dialog') && !el.closest('dialog').open) return false;
  return /INPUT|TEXTAREA|SELECT/.test(el.tagName) || !!el.isContentEditable;
}
// Redraw unless a sheet is open or you're typing (a live update never pulls the screen out from under
// you); what arrived then is drawn as soon as the sheet closes.
function redraw() {
  if (!location.hash.startsWith('#six')) return;
  if ($('#sheet').open || $('#sheet2').open || typing()) { S().dirty = true; return; }
  app.render();
}
const drawIfDirty = () => { if (S().dirty && location.hash.startsWith('#six')) app.render(); };

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
const lit = (id) => (S().flash.has(id) ? ' six-lit' : '');
function nowCard(t, i, n, carriedIn) {
  return `<section class="six-now${lit(t.id)}" aria-label="Now" data-six-card="${t.id}">
    <div class="six-now-head"><span class="six-label">Now · ${i + 1} of ${n}</span><span class="row-meta">${chips(t, carriedIn)}</span></div>
    <h2 class="six-now-title" data-task="${t.id}">${titleHtml(t.title)}</h2>
    <p class="six-gain">${gainLine(t)}</p>
    <div class="six-now-btns"><button type="button" class="btn primary" data-six="done" data-id="${t.id}">Done</button><button type="button" class="btn" data-six="bottom" data-id="${t.id}">Not now, to the bottom</button><button type="button" class="btn" data-six="tomorrow" data-id="${t.id}">Tomorrow</button><button type="button" class="btn link" data-task="${t.id}">Edit details</button></div>
  </section>`;
}
// A dropped card stays in its place but isn't done: a grey ✕, and a tap brings it back.
const isDropped = (t) => !!t.dropped_at && !t.completed_at;
function rowHtml(t, i, n, which, carriedIn) {
  const open = isOpen(t);
  const dropped = isDropped(t);
  const other = which === 'today' ? 'tomorrow' : 'today';
  const state = open ? '' : dropped ? '<span class="chip">dropped</span>' : `<span class="chip ok">done${t.completed_at ? ` ${esc(fmtHM(t.completed_at))}` : ''}</span>`;
  return `<div class="six-row ${open ? '' : 'done'}${lit(t.id)}" data-six-card="${t.id}">
    <button type="button" class="check ${open ? (isOverdue(t) ? 'overdue' : t.flagged ? 'flagged' : '') : dropped ? 'dropped' : 'done'}" data-six="${open ? 'done' : dropped ? 'undrop' : 'reopen'}" data-id="${t.id}" aria-label="${open ? 'Done' : dropped ? 'Dropped; tap to bring it back' : 'Done; tap to reopen'}">${dropped ? '✕' : '✓'}</button>
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
  listen();
  const items = tasksOf(key);
  const open = items.filter(isOpen);
  const now = which === 'today' ? open[0] : null;
  const carried = new Set(which === 'today' && r ? (r.carried || []).filter((id) => items.some((t) => t.id === id)) : []);
  const doneN = items.filter((t) => t.completed_at).length; // dropped isn't done
  const droppedN = items.filter(isDropped).length;
  let thenShown = false;
  const body = items.map((t, i) => {
    if (t === now) return nowCard(t, i, items.length, carried.has(t.id));
    let head = '';
    if (now && isOpen(t) && !thenShown) { thenShown = true; head = '<p class="six-then">Then</p>'; }
    return head + rowHtml(t, i, items.length, which, carried.has(t.id));
  }).join('');
  const s = S();
  s.dirty = false;
  if (s.flash.size) setTimeout(() => s.flash.clear(), 50); // lit on this draw only
  const full = items.length >= SIX;
  const tab = (w, label) => `<a href="#six/${w}" role="tab" class="${which === w ? 'on' : ''}" aria-selected="${which === w}">${label}</a>`;
  return `<div class="view-head"><h1 class="six">Six</h1><span class="six-seg" role="tablist" aria-label="Which day">${tab('today', 'Today')}${tab('tomorrow', 'Tomorrow')}</span></div>
    <p class="view-sub">${esc(dayOf(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))} · ${items.length ? `${doneN} of ${items.length} done${droppedN ? ` · ${droppedN} dropped` : ''}` : 'nothing picked yet'} <span class="hint">· from ${esc(eveningLabel())}, Tomorrow opens first</span></p>
    ${carried.size ? `<div class="six-carried${[...carried].some((id) => s.flash.has(id)) ? ' six-in' : ''}" role="status"><span>${carried.size === 1 ? 'One came over from yesterday and sits' : `${carried.size} came over from yesterday and sit`} at the top.</span><button type="button" class="link-btn" data-six="uncarry">Undo</button></div>` : ''}
    ${items.length ? body : '<div class="six-empty">Six things, in order. Work the first until it is finished, then the second. What is left tonight goes to the top of tomorrow.</div>'}
    ${which === 'today' && items.length && !open.length ? (droppedN ? '<p class="six-all quiet">Nothing left open</p>' : '<p class="six-all">All done ✓</p>') : ''}
    <div class="cl-bar six-foot"><button type="button" class="btn" data-six="add" ${full ? 'disabled' : ''}>＋ Add${full ? '' : ` the ${ORD[items.length]}`}</button><span class="hint">${full ? 'Six is the limit. Finish one, or send one to tomorrow.' : `${items.length} of ${SIX}`}</span></div>
    <p class="hint six-keys"><kbd>d</kbd> done · <kbd>n</kbd> not now · <kbd>t</kbd> tomorrow · <kbd>a</kbd> add</p>`;
}

// ---------- adding ----------
// The picker (js/six-picker.js) hands back one or more ids: onto the end of the day's list in that order,
// off the other day's list if they were there, planned for the day.
async function addMany(key, ids, { saved } = {}) {
  const list = listOf(key);
  const fresh = ids.filter((id) => byId(db.tasks, id) && !list.includes(id)).slice(0, Math.max(0, SIX - list.length));
  if (!fresh.length) { if (list.length >= SIX) toast('Six is the limit'); return; }
  const otherKey = keyOf(key === keyOf('today') ? 'tomorrow' : 'today');
  const other = listOf(otherKey);
  const moved = fresh.filter((id) => other.includes(id));
  put(key, [...list, ...fresh]);
  if (moved.length) put(otherKey, other.filter((id) => !moved.includes(id)));
  flash(...fresh);
  const lead = saved === undefined ? 'A' : `Saved${saved ? ` to ${saved}` : ''} · a`; // a card made from the picker's search
  toast(fresh.length === 1 ? `${lead}dded as the ${ORD[list.length]}` : `${lead}dded ${fresh.length}${moved.length ? ` · ${moved.length} moved from ${otherKey === keyOf('today') ? 'today' : 'tomorrow'}` : ''}`);
  app.render();
  await Promise.all([save(key), moved.length ? save(otherKey) : null, ...fresh.map((id) => planFor(byId(db.tasks, id), key))]);
}

// A card typed into the picker that doesn't exist yet (the line as the picker read it: title, project,
// tags, due, gain): saved as Capture saves it, already planned for the day, then added after any ticked ones.
// With no project and no tags it is in the Inbox, to clarify later.
async function createAndAdd(key, a, ids) {
  const row = await capture(a.title, { planned_at: atDefaultTime(dayOf(key), 'planned_at').toISOString(), in_inbox: !a.project && !a.tags.length,
    ...(a.project ? { project_id: a.project.id } : {}), ...(a.due ? { due_at: atDefaultTime(new Date(`${a.due}T12:00:00`), 'due_at').toISOString() } : {}), ...(a.gain ? { gain: a.gain } : {}) });
  if (!row) return; // offline: capture keeps it for later and says so
  if (a.tags.length) await setLinks('task_tags', 'taskTags', 'task_id', row.id, a.tags.map((x) => x.id));
  await addMany(key, [...ids, row.id], { saved: a.project ? a.project.name : a.tags.length ? '' : 'Inbox' });
}

// ---------- actions and keys ----------
export async function sixAction(el) {
  const a = el.dataset.six;
  const which = whichOf(location.hash.split('/')[1]);
  const key = keyOf(which);
  const t = el.dataset.id && byId(db.tasks, el.dataset.id);
  const list = listOf(key);
  const i = t ? list.indexOf(t.id) : -1;
  if (a === 'add') {
    const otherWhich = which === 'today' ? 'tomorrow' : 'today';
    openSixPicker({ key, which, free: SIX - list.length, listed: new Set(list), other: { which: otherWhich, ids: listOf(keyOf(otherWhich)) }, onAdd: (ids) => addMany(key, ids), onCreate: (a, ids) => createAndAdd(key, a, ids), onClose: drawIfDirty });
    return;
  }
  if (a === 'uncarry') {
    const r = rowFor(key);
    if (!r) return;
    const gone = r.carried || [];
    put(key, list.filter((id) => !gone.includes(id))); r.carried = []; // here first; the database follows
    toast('Yesterday’s leftovers are off today’s list');
    app.render();
    try { syncReview(await run(sb.rpc('six_uncarry', { p_day: key }))); } catch { await reload([key]); }
    app.render();
    return;
  }
  if (!t) return;
  if (a === 'done' || a === 'reopen') { // the card shows it is on its way while the write runs; it redraws and says so
    const card = el.closest('.six-now, .six-row'); if (card) card.classList.add('six-busy');
    await setCompleted(t, a === 'done');
    return;
  }
  if (a === 'undrop') { // back to open, where it was on the list
    const [row] = await run(sb.from('tasks').update({ dropped_at: null }).eq('id', t.id).select());
    syncRow('tasks', t, row); flash(t.id); toast(`“${t.title}” is back`); app.render(); return;
  }
  if (a === 'keep-gain') { const [row] = await run(sb.from('tasks').update({ gain_by: null }).eq('id', t.id).select()); syncRow('tasks', t, row); toast('Gain kept'); app.render(); return; }
  if (i < 0) return;
  if (a === 'up' && i > 0) put(key, move(list, i, i - 1));
  else if (a === 'down' && i < list.length - 1) put(key, move(list, i, i + 1));
  else if (a === 'bottom') put(key, move(list, i, list.length - 1));
  else if (a === 'remove') put(key, list.filter((id) => id !== t.id));
  else if (a === 'tomorrow' || a === 'today') {
    const toKey = keyOf(a);
    if (toKey === key) return;
    const target = listOf(toKey);
    if (target.length >= SIX) { toast(`${a === 'tomorrow' ? 'Tomorrow' : 'Today'} already has six`); return; }
    put(key, list.filter((id) => id !== t.id));
    put(toKey, [...target, t.id]);
    flash(t.id);
    toast(`Moved to ${a}`);
    app.render();
    await Promise.all([save(key), save(toKey), planFor(t, toKey)]);
    return;
  } else return;
  flash(t.id);
  app.render();
  await save(key);
}
export function sixKey(e) {
  if (!location.hash.startsWith('#six')) return false;
  if ($('#sheet2') && $('#sheet2').open) return false;
  if (typing() || e.metaKey || e.ctrlKey || e.altKey) return false;
  const press = (sel) => { const b = document.querySelector(sel); if (b && !b.disabled) { e.preventDefault(); b.click(); return true; } return false; };
  if (e.key === 'a') return press('[data-six="add"]');
  if (e.key === 'd') return press('.six-now [data-six="done"]');
  if (e.key === 'n') return press('.six-now [data-six="bottom"]');
  if (e.key === 't') return press('.six-now [data-six="tomorrow"]');
  return false;
}
