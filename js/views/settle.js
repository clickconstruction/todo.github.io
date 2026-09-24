// Settle in (#settle/<import>): sort what an import brought, biggest levers first. Bulk choices run in
// the database (settle_apply) with one Undo each (settle_undo); cards handle the rest one at a time.
// Only the import's own rows are touched. Progress is kept on the import (imports.settle).
import { db, app, sb, run, syncRow, esc, byId, toast, isOpen } from '../state.js';
import { loadAll } from '../data.js';
import { startOfToday, atDefaultTime, fmtDate } from '../dates.js';
import { STEPS, settleData, spreadReviews } from '../settle.js';
import { taskList } from '../rows.js';
import { peopleFromWaitingTags } from '../gtd.js';
import { areasFromFolders } from './horizons.js';

const n = (x) => Number(x || 0).toLocaleString();
const imp = (id) => (db.imports || []).find((i) => i.id === id) || null;
const data = (id) => settleData({ importId: id, tasks: db.tasks, projects: db.projects, tags: db.tags, taskTags: db.taskTags, projectTags: db.projectTags });
const S = () => (app.settleUi ||= { lastOp: null, cardUndo: [] });
const age = (t) => { const d = Math.floor((Date.now() - Math.max(Date.parse(t.updated_at || 0) || 0, Date.parse(t.created_at || 0) || 0)) / 86400000); return d >= 730 ? `${Math.round(d / 365)} years` : d >= 60 ? `${Math.round(d / 30)} months` : `${d} days`; };

// ---------- progress (kept on the import) ----------
const prog = (i) => ({ steps: {}, kept: [], ...(i && i.settle ? i.settle : {}) });
async function saveProg(id, patch) {
  const i = imp(id);
  const next = { ...prog(i), ...patch };
  const [row] = await run(sb.from('imports').update({ settle: next }).eq('id', id).select());
  if (i) Object.assign(i, row);
}
export async function markStep(id, key, count = null) {
  const p = prog(imp(id));
  await saveProg(id, { steps: { ...p.steps, [key]: { done_at: new Date().toISOString(), n: count } } });
}
const kept = (id) => new Set(prog(imp(id)).kept);
async function keep(id, ids) { const p = prog(imp(id)); await saveProg(id, { kept: [...new Set([...p.kept, ...ids])].slice(-2000) }); }

// ---------- apply a bulk choice, refresh what changed, offer Undo ----------
export async function apply(id, op, args, label) {
  const res = await run(sb.rpc('settle_apply', { batch: id, op, args }));
  await loadAll();
  S().lastOp = { op_id: res.op_id, label: `${label}: ${n(res.changed)}`, changed: res.changed, hash: location.hash };
  app.render();
  toast(`${label} · ${n(res.changed)}`, [{ label: 'Undo', run: () => undo(res.op_id) }]);
  return res;
}
async function undo(opId) {
  const r = await run(sb.rpc('settle_undo', { op_id: opId }));
  await loadAll();
  if (S().lastOp && S().lastOp.op_id === opId) S().lastOp = null;
  app.render();
  toast(`Undone · ${n(r.restored)} put back`);
}

// ---------- the checklist ----------
function stepState(id, d) {
  const p = prog(imp(id));
  const k = kept(id);
  const left = {
    inbox: d.inbox.length,
    old: d.old.filter((b) => !k.has(`old:${b.key}`)).reduce((s, b) => s + b.ids.length, 0),
    big: d.big.filter((b) => !k.has(`big:${b.id}`)).length,
    projects: d.projects.filter((x) => !k.has(`p:${x}`)).length,
    overdue: d.overdue.filter((x) => !k.has(x)).length,
    flagged: d.flagged.length,
    reviews: d.reviewsDue.length,
    tags: d.unusedTags.length,
    areas: (db.areas || []).filter((a) => !a.archived_at).length ? 0 : db.folders.filter((f) => !f.archived_at && f.import_id === id).length,
    check: d.inexact.length,
  };
  return STEPS.map(([key, title, hint]) => ({ key, title, hint, left: left[key], done: !!p.steps[key] || !left[key] }));
}

export function viewSettle(id, step, a, b) {
  const i = imp(id);
  if (!i) return '<a class="back" href="#import">‹ Import</a><p class="empty">That import isn’t here (it may have been undone).</p>';
  if (step === 'cards') return cardsHtml(id, a, b);
  if (step) return stepHtml(id, step);
  const d = data(id);
  const st = stepState(id, d);
  const doneN = st.filter((x) => x.done).length;
  const sub = (x) => ({ inbox: `${x.left} to clarify`, old: `${n(x.left)} action${x.left === 1 ? '' : 's'}`, big: `${x.left} project${x.left === 1 ? '' : 's'}`, projects: `${x.left} to decide`,
    overdue: `${x.left}`, flagged: `${x.left}`, reviews: `${x.left} due`, tags: `${x.left} unused`, areas: `${x.left} folders`, check: `${x.left} repeat${x.left === 1 ? '' : 's'}` }[x.key]);
  return `<a class="back" href="#import">‹ Import</a>
    <div class="view-head"><h1 class="settle">Settle in</h1></div>
    <p class="view-sub">${esc(i.source === 'omnifocus' || !i.source ? 'OmniFocus' : i.source)} import · ${esc(fmtDate(i.created_at))} · only what it added</p>
    <div class="fr-start"><div><b>Full Review</b><p class="hint">Go through it one card at a time, with Claude alongside in another window. Important things first; big clusters as one card.</p></div>
      <button class="btn primary" data-fr-start="import" data-id="${id}" data-title="Full Review · OmniFocus import">Start</button></div>
    <div class="st-live"><span class="hint">Live actions</span><span><b>${n(d.total)}</b> <span class="hint">→</span> <b class="ok">${n(d.live)}</b></span></div>
    <div class="cl-progress"><i style="width:${Math.round((doneN / st.length) * 100)}%"></i></div>
    <div class="wk-steps">${st.map((x) => `<a class="wk-step ${x.done ? 'done' : ''}" href="#settle/${id}/${x.key}"><span class="wk-check" aria-hidden="true">${x.done ? '✓' : ''}</span>
      <span class="wk-title">${esc(x.title)} <span class="hint">· ${x.done && !x.left ? 'nothing left' : esc(sub(x))}</span></span></a>`).join('')}</div>
    <p class="hint">Live = open actions not parked in Someday, in active projects. Every choice has an Undo.</p>`;
}

const foot = (id, key) => {
  const i = STEPS.findIndex(([k]) => k === key);
  const next = STEPS[i + 1];
  return `<div class="wk-foot"><a class="btn" href="#settle/${id}">‹ Checklist</a><button class="btn primary" data-settle="step-done" data-id="${id}" data-step="${key}" data-next="${next ? next[0] : ''}">${next ? `Done · ${esc(next[1])} →` : 'Done'}</button></div>`;
};
const lastOpHtml = () => { const o = S().lastOp; return o && o.hash === location.hash ? `<div class="st-op">✓ ${esc(o.label)} · <button class="link-btn" data-settle="undo" data-op="${o.op_id}">Undo</button></div>` : ''; };

function stepHtml(id, key) {
  const d = data(id);
  const k = kept(id);
  const [, title, hint] = STEPS.find(([x]) => x === key) || [];
  if (!title) return viewSettle(id);
  let body = '';
  if (key === 'inbox') {
    body = d.inbox.length ? `<div class="wk-card"><p class="wk-big">${d.inbox.length}</p><p>from the OmniFocus Inbox</p><a class="btn primary" href="#clarify">Process Inbox</a></div>` : '<div class="wk-card"><p class="wk-big">✓</p><p>Nothing left in the Inbox.</p></div>';
  } else if (key === 'old') {
    body = d.old.map((b) => `<div class="st-row"><div class="st-main"><b>${esc(b.label)}</b><span class="hint">${n(b.ids.filter((x) => !k.has(x)).length)}${b.top.length ? ` · mostly ${b.top.map((x) => esc(x.name)).join(', ')}` : ''}</span></div>
      ${!b.ids.length ? '<span class="hint">none</span>' : k.has(`old:${b.key}`) ? '<span class="hint">kept</span>' : `<span class="st-btns"><button class="btn small primary" data-settle="old-someday" data-id="${id}" data-bucket="${b.key}">Someday</button>
      <button class="btn small" data-settle="keep" data-id="${id}" data-key="old:${b.key}">Keep</button><a class="btn small" href="#settle/${id}/cards/old/${b.key}">One by one</a></span>`}</div>`).join('')
      + '<p class="hint">Flagged, repeating and dated actions are never swept. A group goes to Someday when all its steps have.</p>';
  } else if (key === 'big') {
    body = d.big.length ? d.big.map((b) => `<div class="st-card"><b>${esc(b.name)}</b> <span class="hint">· ${n(b.open)} open${b.last ? ` · last touched ${esc(fmtDate(new Date(b.last).toISOString()))}` : ''}</span>
      ${k.has(`big:${b.id}`) ? '<p class="hint">Kept as it is.</p>' : `<div class="st-btns"><button class="btn small" data-settle="keep" data-id="${id}" data-key="big:${b.id}">Keep all</button>
      <button class="btn small primary" data-settle="big-newest" data-id="${id}" data-project="${b.id}">Keep 20 newest</button>
      <button class="btn small" data-settle="big-park" data-id="${id}" data-project="${b.id}">Park project</button>
      <a class="btn small" href="#settle/${id}/cards/project/${b.id}">Sort actions</a></div>`}</div>`).join('') : '<div class="wk-card"><p class="wk-big">✓</p><p>No project has 100+ open actions.</p></div>';
  } else if (key === 'projects') {
    const left = d.projects.filter((x) => !k.has(`p:${x}`));
    body = left.length ? `<div class="wk-card"><p class="wk-big">${left.length}</p><p>project${left.length === 1 ? '' : 's'} to decide · about ${Math.max(1, Math.round(left.length * 5 / 60))} min</p><a class="btn primary" href="#settle/${id}/cards/projects/all">Start</a></div>` : '<div class="wk-card"><p class="wk-big">✓</p><p>Every project has a decision.</p></div>';
  } else if (key === 'overdue') {
    const left = d.overdue.filter((x) => !k.has(x));
    body = left.length ? `<div class="wk-card"><p class="wk-big">${left.length}</p><p>overdue</p>
      <div class="st-btns"><button class="btn primary" data-settle="overdue-plan" data-id="${id}">Make them planned today</button><button class="btn" data-settle="overdue-clear" data-id="${id}">Clear the dates</button><a class="btn" href="#settle/${id}/cards/overdue/all">One by one</a></div></div>
      <p class="hint">Keep due dates only for real deadlines. Planned = when you mean to do it.</p>` : '<div class="wk-card"><p class="wk-big">✓</p><p>Nothing overdue.</p></div>';
  } else if (key === 'flagged') {
    const list = d.flagged.map((x) => byId(db.tasks, x)).filter(Boolean);
    body = list.length ? `<p class="hint">Tick the ones that matter now; the rest are unflagged.</p><div class="chk-list">${list.map((t) => `<label class="chk-item"><input type="checkbox" data-flag-keep="${t.id}"><span>${esc(t.title)}</span></label>`).join('')}</div>
      <div class="wk-finish"><button class="btn primary" data-settle="unflag-rest" data-id="${id}">Unflag the rest</button></div>` : '<div class="wk-card"><p class="wk-big">✓</p><p>No flags to sort.</p></div>';
  } else if (key === 'reviews') {
    body = d.reviewsDue.length ? `<div class="wk-card"><p class="wk-big">${d.reviewsDue.length}</p><p>projects due for review at once</p><button class="btn primary" data-settle="spread" data-id="${id}">Spread over 4 weeks</button></div>` : '<div class="wk-card"><p class="wk-big">✓</p><p>Reviews are spread out.</p></div>';
  } else if (key === 'tags') {
    const unused = d.unusedTags.map((x) => byId(db.tags, x)).filter(Boolean);
    const waitingKids = db.tags.filter((g) => g.parent_id && /^waiting/i.test((byId(db.tags, g.parent_id) || {}).name || '') && !(db.people || []).some((p) => p.tag_id === g.id));
    body = `${unused.length ? `<div class="st-card"><b>${unused.length} tag${unused.length === 1 ? '' : 's'} nothing uses</b><p class="hint">${unused.slice(0, 12).map((g) => esc(g.name)).join(', ')}${unused.length > 12 ? '…' : ''}</p><button class="btn small primary" data-settle="drop-tags" data-id="${id}">Retire them</button></div>` : ''}
      ${waitingKids.length ? `<div class="st-card"><b>${waitingKids.length} Waiting tag${waitingKids.length === 1 ? '' : 's'}</b><p class="hint">${waitingKids.slice(0, 8).map((g) => esc(g.name)).join(', ')}</p><button class="btn small" data-settle="people" data-id="${id}">Make them people</button></div>` : ''}
      ${!unused.length && !waitingKids.length ? '<div class="wk-card"><p class="wk-big">✓</p><p>Tags are tidy.</p></div>' : ''}`;
  } else if (key === 'areas') {
    const folders = db.folders.filter((f) => !f.archived_at);
    body = (db.areas || []).some((a) => !a.archived_at) ? '<div class="wk-card"><p class="wk-big">✓</p><p>You have areas. <a href="#horizons/areas">See them</a>.</p></div>'
      : `<div class="st-card"><b>${folders.length} folders → areas of focus</b><p class="hint">${folders.slice(0, 8).map((f) => esc(f.name)).join(', ')}</p><button class="btn small primary" data-settle="areas" data-id="${id}">Make areas from folders</button></div>`;
  } else if (key === 'check') {
    const list = d.inexact.map((x) => byId(db.tasks, x)).filter(Boolean);
    body = list.length ? `<p class="hint">These repeat a bit differently here (closest match); the original rule is at the end of each one’s notes.</p>${taskList(list)}` : '<div class="wk-card"><p class="wk-big">✓</p><p>Nothing to check.</p></div>';
  }
  return `<a class="back" href="#settle/${id}">‹ Settle in</a><div class="view-head"><h1 class="settle">${esc(title)}</h1></div>
    <p class="view-sub">${esc(hint)}</p>${lastOpHtml()}${body}${foot(id, key)}`;
}

// ---------- cards: one at a time ----------
const CARD = {
  old: [['keep', 'Keep'], ['someday', 'Someday'], ['complete', 'Done'], ['drop', 'Drop']],
  project: [['keep', 'Keep'], ['someday', 'Someday'], ['complete', 'Done'], ['drop', 'Drop']],
  overdue: [['keep', 'Keep due'], ['plan', 'Plan today'], ['clear_due', 'Clear date'], ['drop', 'Drop']],
  projects: [['keep', 'Active'], ['on_hold', 'On hold'], ['completed', 'Done'], ['dropped', 'Drop']],
};
function queue(id, kind, arg) {
  const d = data(id);
  const k = kept(id);
  if (kind === 'old') { const b = d.old.find((x) => x.key === arg); return b ? b.ids.filter((x) => !k.has(x)) : []; }
  if (kind === 'project') { const b = d.big.find((x) => x.id === arg); const all = b ? b.newest : db.tasks.filter((t) => t.project_id === arg && isOpen(t)).map((t) => t.id); return all.filter((x) => !k.has(x)); }
  if (kind === 'overdue') return d.overdue.filter((x) => !k.has(x));
  if (kind === 'projects') return d.projects.filter((x) => !k.has(`p:${x}`));
  return [];
}
function cardsHtml(id, kind, arg) {
  const q = queue(id, kind, arg);
  const s = S();
  if (s.cardQueue !== `${id}/${kind}/${arg}`) Object.assign(s, { cardQueue: `${id}/${kind}/${arg}`, cardDone: 0, cardUndo: [] }); // a new pile starts fresh
  const back = kind === 'projects' ? 'projects' : kind === 'overdue' ? 'overdue' : kind === 'project' ? 'big' : 'old';
  const done = s.cardDone || 0;
  if (!q.length) return `<a class="back" href="#settle/${id}/${back}">‹ Back</a><div class="cl-done"><div class="cl-big">✓</div><h2>All sorted</h2><p><a class="btn primary" href="#settle/${id}/${back}">Back</a></p></div>`;
  const cur = q[0];
  let card = '';
  if (kind === 'projects') {
    const p = byId(db.projects, cur);
    const f = p.folder_id && byId(db.folders, p.folder_id);
    const openA = db.tasks.filter((t) => t.project_id === p.id && isOpen(t));
    const last = openA.reduce((m, t) => Math.max(m, Date.parse(t.updated_at || 0) || 0), 0);
    const next = openA.filter((t) => !t.parent_id).sort((a, b) => (a.sort - b.sort))[0];
    card = `<div class="st-cardbig"><span class="hint">${f ? `📁 ${esc(f.name)}` : 'No folder'}</span><h2>${esc(p.name)}</h2>
      <p class="hint">${openA.length} action${openA.length === 1 ? '' : 's'}${last ? ` · last activity ${esc(fmtDate(new Date(last).toISOString()))}` : ''} · ${p.status === 'on_hold' ? 'on hold now' : 'active now'}</p>
      ${next ? `<p>Next: <b>${esc(next.title)}</b></p>` : ''}
      <label class="gain-card"><span class="gain-label"><span aria-hidden="true">✦</span> What do I gain from this project?</span>
        <input type="text" data-st-gain="${p.id}" data-kind="project" value="${esc(p.purpose || '')}" maxlength="500" placeholder="Say it in one line, or skip" autocomplete="off"></label></div>
      ${f ? `<p class="hint st-folder">Whole folder “${esc(f.name)}”: <button class="link-btn" data-settle="folder" data-id="${id}" data-folder="${f.id}" data-status="active">all Active</button> · <button class="link-btn" data-settle="folder" data-id="${id}" data-folder="${f.id}" data-status="on_hold">all On hold</button></p>` : ''}`;
  } else {
    const t = byId(db.tasks, cur);
    const p = t.project_id && byId(db.projects, t.project_id);
    card = `<div class="st-cardbig"><span class="hint">${p ? `🗂 ${esc(p.name)}` : 'No project'} · ${esc(age(t))} old${t.due_at ? ` · due ${esc(fmtDate(t.due_at))}` : ''}</span><h2>${esc(t.title)}</h2>
      ${t.notes ? `<p class="hint st-notes">${esc(t.notes.slice(0, 280))}${t.notes.length > 280 ? '…' : ''}</p>` : ''}
      <label class="gain-card"><span class="gain-label"><span aria-hidden="true">✦</span> What do I gain if I do it?</span>
        <input type="text" data-st-gain="${t.id}" data-kind="task" value="${esc(t.gain || '')}" maxlength="500" placeholder="Say it in one line, or skip" autocomplete="off"></label>
      ${t.gain ? '' : '<p class="hint">Can’t say what you gain? That’s usually a Someday.</p>'}</div>`;
  }
  return `<a class="back" href="#settle/${id}/${back}">‹ Back</a>
    <div class="view-head"><h1 class="settle">One by one</h1><span class="cl-count">${n(q.length)} left${done ? ` · ${done} sorted` : ''}</span></div>
    ${card}
    <div class="st-four">${CARD[kind].map(([c, l], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-settle="card" data-id="${id}" data-kind="${kind}" data-arg="${esc(arg || '')}" data-item="${cur}" data-choice="${c}"><kbd>${i + 1}</kbd> ${esc(l)}</button>`).join('')}</div>
    <div class="cl-bar"><button class="btn small" data-settle="card-undo" ${s.cardUndo.length ? '' : 'disabled'}>↶ Undo</button><span class="hint cl-keys">1–4 decide · u undo</span><span></span></div>`;
}

async function cardChoice(el) {
  const { id, kind, item, choice } = el.dataset;
  const s = S();
  if (choice === 'keep') { await keep(id, [kind === 'projects' ? `p:${item}` : item]); s.cardUndo.push({ keep: kind === 'projects' ? `p:${item}` : item, id }); }
  else if (kind === 'projects') { const r = await run(sb.rpc('settle_apply', { batch: id, op: 'project_status', args: { ids: [item], status: choice } })); await keep(id, [`p:${item}`]); s.cardUndo.push({ op: r.op_id, keep: `p:${item}`, id }); }
  else {
    const at = atDefaultTime(startOfToday(), 'planned_at').toISOString();
    const r = await run(sb.rpc('settle_apply', { batch: id, op: choice, args: { ids: [item], ...(choice === 'plan' ? { at } : {}) } }));
    if (kind === 'overdue' && choice === 'plan') await keep(id, [item]);
    s.cardUndo.push({ op: r.op_id, id });
  }
  s.cardDone = (s.cardDone || 0) + 1;
  if (choice !== 'keep') await loadAll();
  app.render();
}
async function cardUndo() {
  const s = S();
  const last = s.cardUndo.pop();
  if (!last) return;
  if (last.op) await run(sb.rpc('settle_undo', { op_id: last.op }));
  if (last.keep) { const p = prog(imp(last.id)); await saveProg(last.id, { kept: p.kept.filter((x) => x !== last.keep) }); }
  s.cardDone = Math.max(0, (s.cardDone || 1) - 1);
  await loadAll();
  app.render();
}

// ---------- clicks ----------
export async function settleAction(el) {
  const a = el.dataset.settle;
  const id = el.dataset.id;
  const d = id ? data(id) : null;
  const at9 = atDefaultTime(startOfToday(), 'planned_at').toISOString();
  if (a === 'card') return cardChoice(el);
  if (a === 'card-undo') return cardUndo();
  if (a === 'undo') return undo(el.dataset.op);
  if (a === 'keep') { await keep(id, [el.dataset.key]); app.render(); return; }
  if (a === 'step-done') { await markStep(id, el.dataset.step); location.hash = el.dataset.next ? `#settle/${id}/${el.dataset.next}` : `#settle/${id}`; app.render(); return; }
  if (a === 'old-someday') { const b = d.old.find((x) => x.key === el.dataset.bucket); const k = kept(id); await apply(id, 'someday', { ids: b.ids.filter((x) => !k.has(x)) }, `${b.label} → Someday`); return; }
  if (a === 'big-newest') { const b = d.big.find((x) => x.id === el.dataset.project); await apply(id, 'someday', { ids: b.newest.slice(20) }, `${b.name}: kept the 20 newest`); await keep(id, [`big:${b.id}`]); app.render(); return; }
  if (a === 'big-park') { await apply(id, 'project_status', { ids: [el.dataset.project], status: 'on_hold' }, 'Parked'); await keep(id, [`big:${el.dataset.project}`]); app.render(); return; }
  if (a === 'folder') {
    const ids = d.projects.filter((x) => (byId(db.projects, x) || {}).folder_id === el.dataset.folder);
    await apply(id, 'project_status', { ids, status: el.dataset.status }, `Folder: ${el.dataset.status === 'active' ? 'all Active' : 'all On hold'}`);
    await keep(id, ids.map((x) => `p:${x}`)); app.render(); return;
  }
  if (a === 'overdue-plan') { await apply(id, 'plan', { ids: d.overdue, at: at9 }, 'Planned today'); return; }
  if (a === 'overdue-clear') { await apply(id, 'clear_due', { ids: d.overdue }, 'Dates cleared'); return; }
  if (a === 'unflag-rest') {
    const keepIds = new Set([...document.querySelectorAll('[data-flag-keep]:checked')].map((x) => x.dataset.flagKeep));
    await apply(id, 'unflag', { ids: d.flagged.filter((x) => !keepIds.has(x)) }, `Unflagged (kept ${keepIds.size})`); return;
  }
  if (a === 'spread') { await apply(id, 'review_dates', { items: spreadReviews(d.reviewsDue) }, 'Reviews spread over 4 weeks'); return; }
  if (a === 'drop-tags') { await apply(id, 'drop_tags', { ids: d.unusedTags }, 'Tags retired'); return; }
  if (a === 'people') { const k = await peopleFromWaitingTags(); toast(`Added ${k} ${k === 1 ? 'person' : 'people'}`); app.render(); return; }
  if (a === 'areas') { const k = await areasFromFolders(); toast(`Made ${k} area${k === 1 ? '' : 's'}`); app.render(); }
}

// Keys on the card screen: 1–4 decide, u undo.
export function settleKey(e) {
  if (!/^#settle\/[^/]+\/cards\//.test(location.hash) || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return false;
  if (/^[1-4]$/.test(e.key)) { const b = document.querySelectorAll('[data-settle="card"]')[Number(e.key) - 1]; if (b) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'u') { e.preventDefault(); cardUndo(); return true; }
  return false;
}

// The gain on a card saves as you leave the field (Enter too). Keys 1–4 don't fire while typing.
document.addEventListener('change', async (e) => {
  const el = e.target.closest && e.target.closest('[data-st-gain]');
  if (!el) return;
  const isTask = el.dataset.kind === 'task';
  const row = byId(isTask ? db.tasks : db.projects, el.dataset.stGain);
  if (!row) return;
  const text = el.value.trim().slice(0, 500);
  if (text === ((isTask ? row.gain : row.purpose) || '')) return;
  const [saved] = await run(sb.from(isTask ? 'tasks' : 'projects').update(isTask ? { gain: text, gain_by: null } : { purpose: text, purpose_by: null }).eq('id', row.id).select());
  syncRow(isTask ? 'tasks' : 'projects', row, saved);
});
document.addEventListener('keydown', (e) => {
  const el = e.target.closest && e.target.closest('[data-st-gain]');
  if (el && e.key === 'Enter') { e.preventDefault(); el.blur(); }
});
