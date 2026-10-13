// The Add picker for Six: suggestions first, or a place to look (a Matrix box, Forecast days, a
// project, a tag, Flagged). Typing searches there, and one link widens it to every open card. Tick
// several and add once, up to the free places; a card already on the day is shown but can't be ticked.
// The last place looked is remembered on this device, with the last projects and tags opened.
// Keys: ↑ ↓ move, space ticks (with the search empty), ⏎ adds the ticked ones (else the lit row),
// Tab the next place to look, ⌫ back out of a project or tag (with the search empty), e edits the lit
// row, Esc closes. The gear at the end of a row (or holding it, or right-clicking it) opens the card's
// editor over the picker; the list redraws when it saves.
import { db, esc, byId, isOpen, toast, $, taskSort, tagsFor, tagLabel, sortedTags } from './state.js';
import { isAvailable, cardBlockers, isSequenceBlocked, sequentialHead, projectOf } from './availability.js';
import { rankNow } from './whatnow.js';
import { BOXES } from './matrix.js';
import { matrixBoxes } from './views/matrix.js';
import { startOfToday, addDays, isDeferred, fmtDate } from './dates.js';
import { dayKey, isWaiting, waitingPerson } from './gtd.js';
import { openEditor } from './editors/task.js';

const SOURCES = [['suggested', 'Suggested'], ['matrix', 'Matrix'], ['forecast', 'Forecast'], ['projects', 'Projects'], ['tags', 'Tags'], ['flagged', 'Flagged']];
const FORECAST = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week']];
const KEY = 'todo.six.pick';
const DAY = 86400000;

const pref = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const remember = (patch) => { try { localStorage.setItem(KEY, JSON.stringify({ ...pref(), ...patch })); } catch { /* private mode: this time only */ } };
const recent = (kind, id) => { const p = pref(); const list = [id, ...(p[kind] || []).filter((x) => x !== id)].slice(0, 3); remember({ [kind]: list }); };
const projName = (t) => (t.project_id ? (byId(db.projects, t.project_id) || {}).name || '' : t.in_inbox ? 'Inbox' : '');
const words = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const hits = (list, q, text = (t) => `${t.title} ${projName(t)}`) => { const w = words(q); return w.length ? list.filter((t) => w.every((x) => text(t).toLowerCase().includes(x))) : list; };
const chip = (text, cls = '') => `<span class="chip ${cls}">${esc(text)}</span>`;
const dayLabel = (d) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric' });
const shortDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
// A card that could be picked: open, an action (not a daily checkbox or a bucket of steps).
const pickable = (t) => isOpen(t) && !t.daily && !t.steps_single;

// Why a card isn't next: what it waits for, the step before it, a date, a person.
function laterWhy(t) {
  const waits = cardBlockers(t);
  if (waits.length) return `waits for “${waits[0].title}”`;
  if (isWaiting(t)) { const p = waitingPerson(t); return p ? `waiting for ${p.name}` : 'waiting for someone'; }
  if (isDeferred(t)) return `deferred until ${fmtDate(t.defer_at)}`;
  if (isSequenceBlocked(t)) {
    const parent = t.parent_id && byId(db.tasks, t.parent_id);
    const prev = parent && parent.steps_in_order ? db.tasks.filter((x) => x.parent_id === parent.id && isOpen(x) && !x.daily).sort(taskSort)[0] : (projectOf(t) ? sequentialHead(projectOf(t)) : null);
    return prev && prev.id !== t.id ? `after “${prev.title}”` : 'after the step before';
  }
  const p = projectOf(t);
  if (p && p.status !== 'active') return `project ${p.status === 'on_hold' ? 'on hold' : p.status}`;
  return 'not yet';
}
// Next (could be done now) and Later (with why), in list order.
function nextLater(list) {
  const next = list.filter(isAvailable);
  const later = list.filter((t) => !next.includes(t)).map((t) => ({ t, why: laterWhy(t) }));
  return { next, later };
}

export function openSixPicker({ key, which, free, listed, other, onAdd, onClose = () => {} }) {
  const dlg = $('#sheet2');
  const saved = pref();
  const st = { source: SOURCES.some(([k]) => k === saved.source) ? saved.source : 'suggested', sub: saved.sub || {}, projectId: null, tagId: null, q: '', ticked: [], active: 0, everywhere: false, held: false };
  const end = { today: (() => { const d = startOfToday(); d.setHours(23, 59, 59, 999); return d; })() };
  end.day = which === 'tomorrow' ? addDays(end.today, 1) : end.today;
  const onDay = (t) => (listed.has(t.id) ? which : other.ids.includes(t.id) ? other.which : null);
  const rank = (t) => (listed.has(t.id) ? [...listed].indexOf(t.id) + 1 : other.ids.indexOf(t.id) + 1);
  const ord = (n) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n - 1] || `${n}th`;

  // ---------- what each place shows: groups of rows ----------
  const row = (t, extra = []) => ({ t, chips: [projName(t) ? chip(projName(t)) : '', ...extra].filter(Boolean) });
  const dueChip = (t) => (t.due_at ? chip(new Date(t.due_at) < startOfToday() ? 'overdue' : new Date(t.due_at) <= end.today ? 'due today' : `due ${shortDay(t.due_at)}`, 'red') : '');
  const flagChip = (t) => (t.flagged ? chip('🚩 flagged') : '');
  const suggested = () => {
    const avail = db.tasks.filter((t) => pickable(t) && isAvailable(t) && !t.in_inbox && !listed.has(t.id));
    const due = avail.filter((t) => t.due_at && new Date(t.due_at) <= end.day).sort((a, b) => a.due_at.localeCompare(b.due_at));
    const dueIds = new Set(due.map((t) => t.id));
    const flagged = avail.filter((t) => t.flagged && !dueIds.has(t.id));
    const flagIds = new Set(flagged.map((t) => t.id));
    const next = rankNow(avail.filter((t) => !dueIds.has(t.id) && !flagIds.has(t.id)), { projects: db.projects, goals: db.goals || [], endOfToday: end.day, limit: 5 }).items;
    return [
      { label: which === 'today' ? 'Overdue and due today' : 'Overdue and due by tomorrow', rows: due.slice(0, 8).map((t) => row(t, [dueChip(t), flagChip(t)])) },
      { label: 'Flagged', rows: flagged.slice(0, 8).map((t) => row(t, [dueChip(t), flagChip(t)])) },
      { label: 'What now? would pick next', rows: next.map(({ t, reasons }) => row(t, reasons.filter((r) => r.kind !== 'time').slice(0, 2).map((r) => chip(r.text)))) },
    ].filter((g) => g.rows.length);
  };
  const matrix = () => {
    const box = BOXES.find((b) => b.key === (st.sub.matrix || 'do')) || BOXES[0];
    const list = (matrixBoxes()[box.key] || []).filter((x) => pickable(x.t));
    return [{ label: `${box.label} · ${box.hint.split(':')[0].toLowerCase()}`, hint: 'sorted as the Matrix sorts them', rows: list.map((x) => row(x.t, (x.why || []).slice(0, 3).map((w) => chip(w, /overdue|due/.test(w) ? 'red' : '')))) }];
  };
  const forecast = () => {
    const sub = st.sub.forecast || 'today';
    const t0 = startOfToday();
    const span = sub === 'overdue' ? [new Date(0), new Date(t0.getTime() - 1)] : sub === 'today' ? [t0, end.today] : sub === 'tomorrow' ? [addDays(t0, 1), addDays(end.today, 1)] : [t0, addDays(end.today, 6)];
    const within = (iso) => iso && new Date(iso) >= span[0] && new Date(iso) <= span[1];
    const list = db.tasks.filter((t) => pickable(t) && !t.in_inbox && (within(t.due_at) || within(t.planned_at)));
    const when = (t) => (within(t.due_at) ? new Date(t.due_at) : new Date(t.planned_at));
    list.sort((a, b) => when(a) - when(b));
    const chips = (t) => [within(t.due_at) ? chip(sub === 'overdue' ? `due ${fmtDate(t.due_at)}` : `due ${shortDay(t.due_at)}`, 'red') : '', within(t.planned_at) ? chip(sub === 'overdue' ? `planned ${fmtDate(t.planned_at)}` : `planned ${shortDay(t.planned_at)}`, 'acc') : '', flagChip(t)];
    if (sub !== 'week') return [{ label: FORECAST.find(([k]) => k === sub)[1], rows: list.map((t) => row(t, chips(t))) }];
    const days = new Map();
    list.forEach((t) => { const k = dayKey(when(t)); if (!days.has(k)) days.set(k, []); days.get(k).push(t); });
    return [...days.entries()].map(([k, ts]) => ({ label: dayLabel(new Date(`${k}T12:00:00`)), hint: `${ts.filter((t) => within(t.due_at)).length} due · ${ts.filter((t) => !within(t.due_at)).length} planned`, rows: ts.map((t) => row(t, chips(t))) }));
  };
  const inside = (list) => {
    const { next, later } = nextLater(list.filter(pickable));
    return [
      { label: 'Next', hint: 'what could be done now', rows: next.map((t) => row(t, [dueChip(t), flagChip(t), t.estimate_minutes ? chip(`${t.estimate_minutes} min`) : ''])) },
      { label: 'Later', hint: 'not yet, and why', rows: later.map(({ t, why }) => ({ ...row(t, [chip(why)]), later: true })) },
    ].filter((g) => g.rows.length);
  };
  const project = () => inside(db.tasks.filter((t) => t.project_id === st.projectId).sort(taskSort));
  const tag = () => { const ids = new Set([st.tagId, ...db.tags.filter((g) => g.parent_id === st.tagId).map((g) => g.id)]); return inside(db.tasks.filter((t) => tagsFor(t.id).some((g) => ids.has(g.id))).sort(taskSort)); };
  const flagged = () => inside(db.tasks.filter((t) => t.flagged && !t.in_inbox));
  const everywhere = () => {
    const all = db.tasks.filter(pickable);
    const found = hits(all, st.q).sort(taskSort).slice(0, 80);
    const groups = new Map();
    found.forEach((t) => { const k = projName(t) || 'Loose cards'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    return [...groups.entries()].map(([name, ts]) => ({ label: name, rows: ts.map((t) => row(t, [dueChip(t), flagChip(t)])) }));
  };
  const groupsFor = () => {
    if (st.everywhere || (st.source === 'suggested' && words(st.q).length)) return everywhere();
    const g = st.source === 'suggested' ? suggested() : st.source === 'matrix' ? matrix() : st.source === 'forecast' ? forecast() : st.source === 'projects' ? project() : st.source === 'tags' ? tag() : flagged();
    if (!words(st.q).length) return g;
    return g.map((x) => ({ ...x, rows: x.rows.filter((r) => hits([r.t], st.q).length) })).filter((x) => x.rows.length);
  };
  const choosing = () => (st.source === 'projects' && !st.projectId) || (st.source === 'tags' && !st.tagId);
  const placeName = () => (st.source === 'suggested' ? '' : st.source === 'matrix' ? `Matrix › ${(BOXES.find((b) => b.key === (st.sub.matrix || 'do')) || BOXES[0]).label}` : st.source === 'forecast' ? FORECAST.find(([k]) => k === (st.sub.forecast || 'today'))[1].toLowerCase() : st.source === 'projects' ? (st.projectId ? (byId(db.projects, st.projectId) || {}).name : 'projects') : st.source === 'tags' ? (st.tagId ? tagLabel(byId(db.tags, st.tagId)) : 'tags') : 'flagged');

  // ---------- drawing ----------
  const chipsHtml = () => {
    const main = `<div class="sp-chips" role="tablist" aria-label="Where to look">${SOURCES.map(([k, l]) => `<button type="button" class="sp-chip ${st.source === k ? 'on' : ''}" role="tab" aria-selected="${st.source === k}" data-sp-source="${k}">${l}</button>`).join('')}</div>`;
    const sub = st.source === 'matrix' ? BOXES.map((b) => [b.key, b.label]) : st.source === 'forecast' ? FORECAST : null;
    const cur = st.source === 'matrix' ? st.sub.matrix || 'do' : st.sub.forecast || 'today';
    const subs = sub ? `<div class="sp-chips sub" role="tablist">${sub.map(([k, l]) => `<button type="button" class="sp-chip ${cur === k ? 'on' : ''}" role="tab" aria-selected="${cur === k}" data-sp-sub="${k}">${l}</button>`).join('')}</div>` : '';
    let crumb = '';
    if (st.source === 'projects' && st.projectId) {
      const p = byId(db.projects, st.projectId) || {};
      const open = db.tasks.filter((t) => t.project_id === p.id && isOpen(t) && !t.daily);
      const kind = p.kind === 'sequential' ? 'in order' : p.kind === 'single' ? 'single actions' : 'parallel';
      crumb = `<div class="sp-crumb"><button type="button" class="link-btn" data-sp-back>‹ All projects</button><span class="hint">·</span><b>${esc(p.name)}</b></div>
        <div class="sp-proj">${p.outcome ? `<b>Done looks like:</b> ${esc(p.outcome)} · ` : ''}<b>${open.length} open</b> · ${kind}${open.filter(isWaiting).length ? ` · <b>${open.filter(isWaiting).length} waiting</b>` : ''}</div>`;
    } else if (st.source === 'tags' && st.tagId) {
      crumb = `<div class="sp-crumb"><button type="button" class="link-btn" data-sp-back>‹ All tags</button><span class="hint">·</span><b>${esc(tagLabel(byId(db.tags, st.tagId)))}</b></div>`;
    } else if (choosing()) {
      const kind = st.source === 'projects' ? 'projects' : 'tags';
      const rec = (saved[kind] || []).map((id) => (kind === 'projects' ? byId(db.projects, id) : byId(db.tags, id))).filter(Boolean);
      crumb = rec.length ? `<div class="sp-crumb"><span class="hint">Recent:</span>${rec.map((x) => `<button type="button" class="link-btn" data-sp-open="${x.id}">${esc(kind === 'projects' ? x.name : tagLabel(x))}</button>`).join('')}</div>` : '';
    }
    return main + subs + crumb;
  };
  const listHtml = () => {
    if (choosing()) {
      const kind = st.source === 'projects' ? 'projects' : 'tags';
      const items = kind === 'projects'
        ? hits(db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold').sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1)), st.q, (p) => p.name)
        : hits(sortedTags(), st.q, (g) => tagLabel(g));
      const count = (x) => (kind === 'projects' ? db.tasks.filter((t) => t.project_id === x.id && isOpen(t) && !t.daily).length : db.taskTags.filter((l) => l.tag_id === x.id).map((l) => byId(db.tasks, l.task_id)).filter((t) => t && isOpen(t)).length);
      st.rows = items.slice(0, 60);
      return st.rows.map((x, i) => `<li><button type="button" class="po-item ${i === st.active ? 'act' : ''}" data-sp-open="${x.id}">${esc(kind === 'projects' ? x.name : tagLabel(x))}<span class="hint"> · ${count(x)} open${kind === 'projects' && x.status === 'on_hold' ? ' · on hold' : ''}</span></button></li>`).join('')
        + (items.length ? (items.length > 60 ? '<li class="hint">Keep typing to narrow it down…</li>' : '') : `<li class="hint">No ${kind} match.</li>`);
    }
    const groups = groupsFor();
    st.rows = groups.flatMap((g) => g.rows);
    if (!st.rows.length) return `<li class="hint">${words(st.q).length ? 'No matching cards here.' : st.source === 'suggested' ? 'Nothing to suggest. Type to search every open card.' : 'Nothing here right now.'}</li>`;
    let i = -1;
    return groups.map((g) => `<li class="po-group sp-group">${esc(g.label)}${g.hint ? `<span class="hint">${esc(g.hint)}</span>` : ''}</li>${g.rows.map((r) => {
      i += 1;
      const day = onDay(r.t);
      const on = st.ticked.includes(r.t.id);
      return `<li class="sp-row ${day ? 'off' : ''} ${r.later ? 'later' : ''} ${i === st.active ? 'act' : ''}" data-sp-row="${r.t.id}">
        <button type="button" class="sp-tick ${on ? 'on' : ''}" data-sp-tick="${r.t.id}" aria-label="${on ? 'Ticked' : 'Tick'}" ${day ? 'disabled' : ''}>✓</button>
        <div class="sp-main"><div class="sp-title">${esc(r.t.title)}</div><div class="sp-meta">${r.chips.join('')}${day ? chip(`on ${day} already · ${ord(rank(r.t))}`) : ''}</div></div>
        <button type="button" class="sp-gear" data-sp-edit="${r.t.id}" aria-label="Edit this card" title="Edit">⚙</button></li>`;
    }).join('')}`).join('');
  };
  const footHtml = () => {
    const n = st.ticked.length;
    const keys = `<span class="sp-keys"> · <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>space</kbd> tick · <kbd>⏎</kbd> add · <kbd>e</kbd> edit · <kbd>tab</kbd> next place</span>`;
    const wide = words(st.q).length && st.source !== 'suggested' ? (st.everywhere ? `<button type="button" class="link-btn" data-sp-narrow>Back to ${esc(placeName())}</button>` : '<button type="button" class="link-btn" data-sp-wide>Search everywhere instead</button>') : '';
    return `${wide ? `<p class="sp-wide">${wide}</p>` : ''}<div class="sp-foot"><span class="hint">${n ? `${n} ticked · ` : ''}${free} place${free === 1 ? '' : 's'} free${keys}</span><button type="button" class="btn" data-sp-cancel>Cancel</button><button type="button" class="btn primary" data-sp-add ${n ? '' : 'disabled'}>Add${n ? ` ${n}` : ''} to ${which}</button></div>`;
  };
  const draw = () => {
    const search = $('[data-sp-search]', dlg);
    search.placeholder = choosing() ? `Find a ${st.source === 'projects' ? 'project' : 'tag'}…` : st.everywhere ? 'Search everywhere…' : st.source === 'suggested' ? 'Search anything…' : `Search in ${placeName()}…`;
    $('[data-sp-chips]', dlg).innerHTML = chipsHtml();
    $('[data-sp-list]', dlg).innerHTML = listHtml();
    $('[data-sp-foot]', dlg).innerHTML = footHtml();
    const act = $('.act', dlg); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  };

  // ---------- doing ----------
  const close = () => { dlg.classList.remove('sp-wide'); dlg.close(); onClose(); };
  const add = () => {
    const ids = st.ticked.length ? st.ticked : (st.rows[st.active] && st.rows[st.active].t && !onDay(st.rows[st.active].t) ? [st.rows[st.active].t.id] : []);
    if (!ids.length) return;
    remember({ source: st.source, sub: st.sub });
    close();
    onAdd(ids);
  };
  const toggle = (id) => {
    const t = byId(db.tasks, id);
    if (!t || onDay(t)) return;
    if (st.ticked.includes(id)) st.ticked = st.ticked.filter((x) => x !== id);
    else if (st.ticked.length >= free) { toast(free === 1 ? 'Only one place free' : `Only ${free} places free`); return; }
    else st.ticked.push(id);
    st.active = Math.max(0, st.rows.findIndex((r) => r.t && r.t.id === id));
    draw();
  };
  const open = (id) => { if (st.source === 'projects') { st.projectId = id; recent('projects', id); } else { st.tagId = id; recent('tags', id); } st.q = ''; $('[data-sp-search]', dlg).value = ''; st.active = 0; st.everywhere = false; draw(); };
  // The card's editor over the picker: on save the list is drawn again (a title, flag or project may have
  // changed, or the card may no longer belong here); either way focus comes back to the search.
  const editCard = (id) => {
    const t = byId(db.tasks, id);
    if (!t) return;
    openEditor(t, {}, { onSaved: () => { st.ticked = st.ticked.filter((x) => byId(db.tasks, x) && isOpen(byId(db.tasks, x))); draw(); setTimeout(() => search.focus(), 0); }, onClose: () => setTimeout(() => search.focus(), 0) });
  };
  const setSource = (k) => { st.source = k; st.projectId = null; st.tagId = null; st.everywhere = false; st.active = 0; remember({ source: k, sub: st.sub }); draw(); };

  dlg.innerHTML = `<form method="dialog" class="part-of-picker six-pick">
    <div class="sp-head"><h2>Add to ${which}</h2><span class="hint">${free} place${free === 1 ? '' : 's'} free</span></div>
    <p class="hint" style="margin:0">Suggestions first, or pick where to look. Typing searches there.</p>
    <input type="search" data-sp-search aria-label="Search cards" autocomplete="off">
    <div data-sp-chips></div>
    <ul class="po-list sp-list" data-sp-list></ul>
    <div data-sp-foot></div></form>`;
  dlg.classList.add('sp-wide');
  const search = $('[data-sp-search]', dlg);
  search.oninput = () => { st.q = search.value; st.active = 0; draw(); };
  const form = dlg.querySelector('form');
  form.onclick = (e) => {
    if (st.held) { st.held = false; return; } // the click that ends a hold is not a tick
    const el = (sel) => e.target.closest(sel);
    if (el('[data-sp-cancel]')) { close(); return; }
    if (el('[data-sp-add]')) { add(); return; }
    if (el('[data-sp-source]')) { setSource(el('[data-sp-source]').dataset.spSource); return; }
    if (el('[data-sp-sub]')) { st.sub = { ...st.sub, [st.source]: el('[data-sp-sub]').dataset.spSub }; st.active = 0; remember({ sub: st.sub }); draw(); return; }
    if (el('[data-sp-back]')) { st.projectId = null; st.tagId = null; st.q = ''; search.value = ''; st.active = 0; draw(); search.focus(); return; }
    if (el('[data-sp-open]')) { open(el('[data-sp-open]').dataset.spOpen); search.focus(); return; }
    if (el('[data-sp-wide]')) { st.everywhere = true; st.active = 0; draw(); search.focus(); return; }
    if (el('[data-sp-narrow]')) { st.everywhere = false; st.active = 0; draw(); search.focus(); return; }
    if (el('[data-sp-edit]')) { editCard(el('[data-sp-edit]').dataset.spEdit); return; }
    if (el('[data-sp-tick]')) { toggle(el('[data-sp-tick]').dataset.spTick); return; }
    const r = el('[data-sp-row]'); if (r) toggle(r.dataset.spRow);
  };
  // Hold a row for half a second (without moving) to edit the card; a right-click does the same.
  let hold = null;
  const endHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
  form.addEventListener('pointerdown', (e) => {
    const r = e.target.closest('[data-sp-row]');
    if (!r || e.button !== 0 || e.target.closest('[data-sp-edit]')) return; // the gear is a plain click
    endHold();
    hold = { id: r.dataset.spRow, x: e.clientX, y: e.clientY, timer: setTimeout(() => { hold = null; st.held = true; editCard(r.dataset.spRow); }, 500) };
  });
  form.addEventListener('pointermove', (e) => { if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) endHold(); });
  form.addEventListener('pointerup', endHold);
  form.addEventListener('pointercancel', endHold);
  form.addEventListener('contextmenu', (e) => { const r = e.target.closest('[data-sp-row]'); if (r) { e.preventDefault(); endHold(); editCard(r.dataset.spRow); } });
  form.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'e' && !search.value && !choosing()) { e.preventDefault(); const r = st.rows[st.active]; if (r && r.t) editCard(r.t.id); return; }
    if (e.key === 'Tab') { e.preventDefault(); const i = SOURCES.findIndex(([k]) => k === st.source); setSource(SOURCES[(i + (e.shiftKey ? SOURCES.length - 1 : 1)) % SOURCES.length][0]); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = st.rows.length; if (n) { st.active = (st.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; draw(); } return; }
    if (e.key === 'Enter') { e.preventDefault(); if (choosing()) { const x = st.rows[st.active]; if (x) open(x.id); } else add(); return; }
    if (e.key === ' ' && !search.value && !choosing()) { e.preventDefault(); const r = st.rows[st.active]; if (r && r.t) toggle(r.t.id); return; }
    if (e.key === 'Backspace' && !search.value && (st.projectId || st.tagId)) { e.preventDefault(); st.projectId = null; st.tagId = null; st.active = 0; draw(); }
  };
  draw();
  dlg.showModal();
  search.focus();
}
