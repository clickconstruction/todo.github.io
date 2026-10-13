// The Add picker for Six: suggestions first, or a place to look (a Matrix box, Forecast days, Projects,
// Tags, Flagged). Typing searches there, and one link widens it to every open card. Tick several and
// add once, up to the free places; a card already on the day is shown but can't be ticked.
// Projects and Tags are a tree: every project (or tag) is a row that opens in place to Next (what could
// be done now) and Later (not yet, and why), with Later closed to start; a closed row still shows how many
// of its cards are ticked. What is open is remembered on this device, as is the last place looked.
// Keys: ↑ ↓ move, ← → close and open, space ticks (with the search empty; on a project it opens or
// closes it), ⏎ adds the ticked ones (else the lit card; on a project it opens or closes it), Tab the
// next place to look, e edits the lit card, Esc closes. The gear at the end of a card (or holding it,
// or right-clicking it) opens the card's editor over the picker; the list redraws when it saves.
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

const pref = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const remember = (patch) => { try { localStorage.setItem(KEY, JSON.stringify({ ...pref(), ...patch })); } catch { /* private mode: this time only */ } };
const projName = (t) => (t.project_id ? (byId(db.projects, t.project_id) || {}).name || '' : t.in_inbox ? 'Inbox' : '');
const folderName = (p) => (p.folder_id ? (byId(db.folders || [], p.folder_id) || {}).name || '' : '');
const words = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text, w) => w.every((x) => String(text || '').toLowerCase().includes(x));
const hits = (list, q, text = (t) => `${t.title} ${projName(t)}`) => { const w = words(q); return w.length ? list.filter((t) => matches(text(t), w)) : list; };
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
  const st = { source: SOURCES.some(([k]) => k === saved.source) ? saved.source : 'suggested', sub: saved.sub || {}, q: '', ticked: [], active: 0, everywhere: false, held: false,
    open: { projects: new Set(saved.openProjects || []), tags: new Set(saved.openTags || []) }, later: new Set(), rows: [] };
  const end = { today: (() => { const d = startOfToday(); d.setHours(23, 59, 59, 999); return d; })() };
  end.day = which === 'tomorrow' ? addDays(end.today, 1) : end.today;
  const onDay = (t) => (listed.has(t.id) ? which : other.ids.includes(t.id) ? other.which : null);
  const rank = (t) => (listed.has(t.id) ? [...listed].indexOf(t.id) + 1 : other.ids.indexOf(t.id) + 1);
  const ord = (n) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n - 1] || `${n}th`;
  const treeSource = () => st.source === 'projects' || st.source === 'tags';

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
  const flagged = () => {
    const { next, later } = nextLater(db.tasks.filter((t) => t.flagged && !t.in_inbox && pickable(t)));
    return [
      { label: 'Next', hint: 'what could be done now', rows: next.map((t) => row(t, [dueChip(t), t.estimate_minutes ? chip(`${t.estimate_minutes} min`) : ''])) },
      { label: 'Later', hint: 'not yet, and why', rows: later.map(({ t, why }) => ({ ...row(t, [chip(why)]), later: true })) },
    ].filter((g) => g.rows.length);
  };
  const everywhere = () => {
    const found = hits(db.tasks.filter(pickable), st.q).sort(taskSort).slice(0, 80);
    const groups = new Map();
    found.forEach((t) => { const k = projName(t) || 'Loose cards'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    return [...groups.entries()].map(([name, ts]) => ({ label: name, rows: ts.map((t) => row(t, [dueChip(t), flagChip(t)])) }));
  };
  const groupsFor = () => {
    if (st.everywhere || (st.source === 'suggested' && words(st.q).length)) return everywhere();
    const g = st.source === 'suggested' ? suggested() : st.source === 'matrix' ? matrix() : st.source === 'forecast' ? forecast() : flagged();
    if (!words(st.q).length) return g;
    return g.map((x) => ({ ...x, rows: x.rows.filter((r) => hits([r.t], st.q).length) })).filter((x) => x.rows.length);
  };
  // The tree's nodes: every project (active first, A to Z, the folder beside it) or every tag (a tag's
  // cards include its children's), each with its pickable cards in list order.
  const nodes = () => {
    if (st.source === 'projects') {
      return db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold')
        .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1))
        .map((p) => ({ id: p.id, name: p.name, side: folderName(p), onHold: p.status === 'on_hold', kind: p.kind === 'sequential' ? 'in order' : p.kind === 'single' ? 'single actions' : 'parallel', cards: db.tasks.filter((t) => t.project_id === p.id && pickable(t)).sort(taskSort) }));
    }
    return sortedTags().map((g) => {
      const ids = new Set([g.id, ...db.tags.filter((x) => x.parent_id === g.id).map((x) => x.id)]);
      return { id: g.id, name: tagLabel(g), side: '', cards: db.tasks.filter((t) => pickable(t) && tagsFor(t.id).some((x) => ids.has(x.id))).sort(taskSort) };
    });
  };
  const placeName = () => (st.source === 'suggested' ? '' : st.source === 'matrix' ? `Matrix › ${(BOXES.find((b) => b.key === (st.sub.matrix || 'do')) || BOXES[0]).label}` : st.source === 'forecast' ? FORECAST.find(([k]) => k === (st.sub.forecast || 'today'))[1].toLowerCase() : st.source);

  // ---------- drawing ----------
  const cardHtml = (r, i) => {
    const day = onDay(r.t);
    const on = st.ticked.includes(r.t.id);
    return `<li class="sp-row ${day ? 'off' : ''} ${r.later ? 'later' : ''} ${i === st.active ? 'act' : ''}" data-sp-row="${r.t.id}">
      <button type="button" class="sp-tick ${on ? 'on' : ''}" data-sp-tick="${r.t.id}" aria-label="${on ? 'Ticked' : 'Tick'}" ${day ? 'disabled' : ''}>✓</button>
      <div class="sp-main"><div class="sp-title">${esc(r.t.title)}</div><div class="sp-meta">${r.chips.join('')}${day ? chip(`on ${day} already · ${ord(rank(r.t))}`) : ''}</div></div>
      <button type="button" class="sp-gear" data-sp-edit="${r.t.id}" aria-label="Edit this card" title="Edit">⚙</button></li>`;
  };
  const chipsHtml = () => {
    const main = `<div class="sp-chips" role="tablist" aria-label="Where to look">${SOURCES.map(([k, l]) => `<button type="button" class="sp-chip ${st.source === k ? 'on' : ''}" role="tab" aria-selected="${st.source === k}" data-sp-source="${k}">${l}</button>`).join('')}</div>`;
    const sub = st.source === 'matrix' ? BOXES.map((b) => [b.key, b.label]) : st.source === 'forecast' ? FORECAST : null;
    const cur = st.source === 'matrix' ? st.sub.matrix || 'do' : st.sub.forecast || 'today';
    return main + (sub ? `<div class="sp-chips sub" role="tablist">${sub.map(([k, l]) => `<button type="button" class="sp-chip ${cur === k ? 'on' : ''}" role="tab" aria-selected="${cur === k}" data-sp-sub="${k}">${l}</button>`).join('')}</div>` : '');
  };
  // The tree. With a search, only what matches: a node whose name matches shows all its cards; otherwise
  // a node shows just its matching cards; either way it is open for the look.
  const treeHtml = () => {
    const w = words(st.q);
    const opened = st.open[st.source];
    const out = []; st.rows = [];
    const push = (r) => { st.rows.push(r); return st.rows.length - 1; };
    let shown = 0;
    nodes().forEach((n) => {
      const nameHit = w.length && matches(n.name, w);
      const cards = w.length && !nameHit ? n.cards.filter((t) => matches(t.title, w)) : n.cards;
      if (w.length && !nameHit && !cards.length) return;
      shown += 1;
      const isOpenNode = w.length ? true : opened.has(n.id);
      const ticked = n.cards.filter((t) => st.ticked.includes(t.id)).length;
      const i = push({ node: n.id });
      out.push(`<li class="sp-node ${isOpenNode ? 'open' : ''} ${n.onHold ? 'hold' : ''} ${i === st.active ? 'act' : ''}" data-sp-node="${n.id}"><span class="sp-chev">${isOpenNode ? '▾' : '▸'}</span><span class="sp-node-name">${esc(n.name)}</span><span class="hint"> · ${n.cards.length} open${n.onHold ? ' · on hold' : ''}</span>${ticked ? chip(`${ticked} ticked`, 'acc') : ''}${n.side ? `<span class="sp-folder">${esc(n.side)}</span>` : ''}</li>`);
      if (!isOpenNode) return;
      const { next, later } = nextLater(cards);
      const laterOpen = st.later.has(n.id) || (w.length && !next.length);
      const parts = [];
      const j = push({ sec: n.id, which: 'next' });
      parts.push(`<li class="sp-sec ${j === st.active ? 'act' : ''}" data-sp-sec="next" data-id="${n.id}"><span class="sp-chev">▾</span>Next<span class="hint"> · ${next.length}${n.kind ? ` · ${n.kind}` : ''} · what could be done now</span></li>`);
      next.forEach((t) => { const k = push({ t }); parts.push(cardHtml(row(t, [dueChip(t), flagChip(t), t.estimate_minutes ? chip(`${t.estimate_minutes} min`) : '']), k)); });
      if (!next.length) parts.push('<li class="hint sp-none">Nothing could be done now.</li>');
      if (later.length) {
        const l = push({ sec: n.id, which: 'later' });
        parts.push(`<li class="sp-sec ${l === st.active ? 'act' : ''}" data-sp-sec="later" data-id="${n.id}"><span class="sp-chev">${laterOpen ? '▾' : '▸'}</span>Later<span class="hint"> · ${later.length} · not yet, and why</span></li>`);
        if (laterOpen) later.forEach(({ t, why }) => { const k = push({ t, later: true }); parts.push(cardHtml({ ...row(t, [chip(why)]), later: true }, k)); });
      }
      out.push(`<li class="sp-box"><ul>${parts.join('')}</ul></li>`);
    });
    if (!shown) return `<li class="hint">${w.length ? `No ${st.source} match.` : `No ${st.source} yet.`}</li>`;
    return out.join('');
  };
  const listHtml = () => {
    if (treeSource() && !st.everywhere) return treeHtml();
    const groups = groupsFor();
    st.rows = groups.flatMap((g) => g.rows);
    if (!st.rows.length) return `<li class="hint">${words(st.q).length ? 'No matching cards here.' : st.source === 'suggested' ? 'Nothing to suggest. Type to search every open card.' : 'Nothing here right now.'}</li>`;
    let i = -1;
    return groups.map((g) => `<li class="po-group sp-group">${esc(g.label)}${g.hint ? `<span class="hint">${esc(g.hint)}</span>` : ''}</li>${g.rows.map((r) => { i += 1; return cardHtml(r, i); }).join('')}`).join('');
  };
  const footHtml = () => {
    const n = st.ticked.length;
    const keys = `<span class="sp-keys"> · <kbd>↑</kbd> <kbd>↓</kbd> move${treeSource() ? ' · <kbd>←</kbd> <kbd>→</kbd> close, open' : ''} · <kbd>space</kbd> tick · <kbd>⏎</kbd> add · <kbd>e</kbd> edit · <kbd>tab</kbd> next place</span>`;
    const wide = words(st.q).length && st.source !== 'suggested' ? (st.everywhere ? `<button type="button" class="link-btn" data-sp-narrow>Back to ${esc(placeName())}</button>` : '<button type="button" class="link-btn" data-sp-wide>Search everywhere instead</button>') : '';
    return `${wide ? `<p class="sp-wide">${wide}</p>` : ''}<div class="sp-foot"><span class="hint">${n ? `${n} ticked · ` : ''}${free} place${free === 1 ? '' : 's'} free${keys}</span><button type="button" class="btn" data-sp-cancel>Cancel</button><button type="button" class="btn primary" data-sp-add ${n ? '' : 'disabled'}>Add${n ? ` ${n}` : ''} to ${which}</button></div>`;
  };
  const draw = () => {
    const search = $('[data-sp-search]', dlg);
    search.placeholder = st.everywhere ? 'Search everywhere…' : st.source === 'suggested' ? 'Search anything…' : treeSource() ? `Search in ${st.source}: a name or a card…` : `Search in ${placeName()}…`;
    $('[data-sp-chips]', dlg).innerHTML = chipsHtml();
    $('[data-sp-list]', dlg).innerHTML = listHtml();
    $('[data-sp-foot]', dlg).innerHTML = footHtml();
    const act = $('.act', dlg); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  };

  // ---------- doing ----------
  const close = () => { dlg.classList.remove('sp-wide'); dlg.close(); onClose(); };
  const add = () => {
    const lit = st.rows[st.active];
    const ids = st.ticked.length ? st.ticked : (lit && lit.t && !onDay(lit.t) ? [lit.t.id] : []);
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
  const saveOpen = () => remember({ openProjects: [...st.open.projects].slice(-40), openTags: [...st.open.tags].slice(-40) });
  const setNode = (id, open) => { const s = st.open[st.source]; if (open === undefined) open = !s.has(id); if (open) s.add(id); else s.delete(id); saveOpen(); st.active = Math.max(0, st.rows.findIndex((r) => r.node === id)); draw(); };
  const setLater = (id, open) => { if (open === undefined) open = !st.later.has(id); if (open) st.later.add(id); else st.later.delete(id); st.active = Math.max(0, st.rows.findIndex((r) => r.sec === id && r.which === 'later')); draw(); };
  const setSource = (k) => { st.source = k; st.everywhere = false; st.active = 0; remember({ source: k, sub: st.sub }); draw(); };
  // The card's editor over the picker: on save the list is drawn again (a title, flag or project may have
  // changed, or the card may no longer belong here); either way focus comes back to the search.
  const editCard = (id) => {
    const t = byId(db.tasks, id);
    if (!t) return;
    openEditor(t, {}, { onSaved: () => { st.ticked = st.ticked.filter((x) => byId(db.tasks, x) && isOpen(byId(db.tasks, x))); draw(); setTimeout(() => search.focus(), 0); }, onClose: () => setTimeout(() => search.focus(), 0) });
  };
  // The lit row, from the keys: a card ticks; a project or a section opens or closes (← from a card
  // closes its project).
  const act = (r, dir) => {
    if (!r) return;
    if (r.node) setNode(r.node, dir === undefined ? undefined : dir === 'open');
    else if (r.sec) { if (r.which === 'later') setLater(r.sec, dir === undefined ? undefined : dir === 'open'); else if (dir === 'close') setNode(r.sec, false); }
    else if (r.t && dir === 'close') { const p = projectOf(r.t); if (st.source === 'projects' && p) setNode(p.id, false); }
    else if (r.t && dir === undefined) toggle(r.t.id);
  };

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
    if (el('[data-sp-node]')) { setNode(el('[data-sp-node]').dataset.spNode); return; }
    if (el('[data-sp-sec]')) { const s = el('[data-sp-sec]'); if (s.dataset.spSec === 'later') setLater(s.dataset.id); else setNode(s.dataset.id, false); return; }
    if (el('[data-sp-wide]')) { st.everywhere = true; st.active = 0; draw(); search.focus(); return; }
    if (el('[data-sp-narrow]')) { st.everywhere = false; st.active = 0; draw(); search.focus(); return; }
    if (el('[data-sp-edit]')) { editCard(el('[data-sp-edit]').dataset.spEdit); return; }
    if (el('[data-sp-tick]')) { toggle(el('[data-sp-tick]').dataset.spTick); return; }
    const r = el('[data-sp-row]'); if (r) toggle(r.dataset.spRow);
  };
  // Hold a card for half a second (without moving) to edit it; a right-click does the same.
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
    if (e.key === 'e' && !search.value) { e.preventDefault(); const r = st.rows[st.active]; if (r && r.t) editCard(r.t.id); return; }
    if (e.key === 'Tab') { e.preventDefault(); const i = SOURCES.findIndex(([k]) => k === st.source); setSource(SOURCES[(i + (e.shiftKey ? SOURCES.length - 1 : 1)) % SOURCES.length][0]); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = st.rows.length; if (n) { st.active = (st.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; draw(); } return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && treeSource() && !search.value) { e.preventDefault(); act(st.rows[st.active], e.key === 'ArrowRight' ? 'open' : 'close'); return; }
    if (e.key === 'Enter') { e.preventDefault(); const r = st.rows[st.active]; if (r && (r.node || r.sec)) act(r); else add(); return; }
    if (e.key === ' ' && !search.value) { e.preventDefault(); act(st.rows[st.active]); }
  };
  draw();
  dlg.showModal();
  search.focus();
}
