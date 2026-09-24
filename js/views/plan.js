// Plan it: David Allen's Natural Planning Model for one project. Full: why (purpose, principles) →
// done looks like → brainstorm → organize → next actions. Quick: done looks like → brainstorm →
// next actions. The plan is saved on the project as you go; Create builds it all in one step
// (apply_project_plan) and one Undo takes it back (undo_project_plan).
import { db, app, sb, run, syncRow, esc, byId, isOpen, taskSort, toast } from '../state.js';
import { loadAll } from '../data.js';
import { fmtDate } from '../dates.js';

const STEPS = { full: [['why', 'Why'], ['outcome', 'Done looks like'], ['brainstorm', 'Brainstorm'], ['organize', 'Organize'], ['next', 'Next actions']], quick: [['outcome', 'Done looks like'], ['brainstorm', 'Brainstorm'], ['next', 'Next actions']] };
const PRINCIPLE_PROMPTS = [['Budget', 'Budget: '], ['Deadline', 'Done by '], ['Quality', 'Quality: '], ['Who must agree', 'Needs OK from '], ['Won’t do', 'We won’t ']];
const NUDGES = ['Who’s involved?', 'What do you need to find out?', 'What could go wrong?', 'What will it cost?', 'What materials or tools?', 'Who needs to know?', 'What’s the first thing you’d do?'];
const uid = () => Math.random().toString(36).slice(2, 9);

// The working plan for a project (from the saved one, or new).
function planFor(p) {
  if (app.plan && app.plan.pid === p.id) return app.plan;
  const saved = p.plan || {};
  const open = db.tasks.filter((t) => t.project_id === p.id && isOpen(t)).length;
  app.plan = { pid: p.id, mode: saved.mode || (open >= 5 ? 'full' : 'quick'), step: saved.step || 0, ideas: saved.ideas || [], groups: saved.groups || [], next: saved.next || {}, applied: saved.applied || null, sel: null, nudge: '' };
  return app.plan;
}
let saveTimer;
function savePlan(pl, now = false) {
  clearTimeout(saveTimer);
  const go = async () => {
    const p = byId(db.projects, pl.pid);
    if (!p) return;
    const plan = { mode: pl.mode, step: pl.step, ideas: pl.ideas, groups: pl.groups, next: pl.next, ...(pl.applied ? { applied: pl.applied } : {}) };
    const [row] = await run(sb.from('projects').update({ plan }).eq('id', p.id).select());
    syncRow('projects', p, row);
  };
  if (now) return go();
  saveTimer = setTimeout(go, 500);
  return null;
}
async function saveField(p, fields) { const [row] = await run(sb.from('projects').update(fields).eq('id', p.id).select()); syncRow('projects', p, row); }

const bucketOf = (i) => i.bucket || 'action';
const inBucket = (pl, b) => pl.ideas.filter((i) => (b === 'action' ? !i.bucket || i.bucket === 'action' : i.bucket === b));
const targets = (pl) => [['project', 'This project', inBucket(pl, 'action')], ...pl.groups.map((g) => [g.id, g.name, inBucket(pl, `g:${g.id}`)])].filter(([, , l]) => l.length);
const nextOf = (pl, scope, list) => list.find((i) => i.id === pl.next[scope]) || list[0];

export function viewPlan(pid) {
  const p = byId(db.projects, pid);
  if (!p) return '<a class="back" href="#projects">‹ Projects</a><p class="empty">Project not found.</p>';
  const pl = planFor(p);
  if (pl.applied) return appliedHtml(p, pl);
  const steps = STEPS[pl.mode];
  pl.step = Math.min(pl.step, steps.length - 1);
  const [key, label] = steps[pl.step];
  return `<a class="back" href="#project/${p.id}">‹ ${esc(p.name)}</a>
    <div class="view-head"><h1 class="review">Plan it</h1><div class="segmented plan-mode" role="radiogroup" aria-label="Plan">
      ${[['quick', 'Quick'], ['full', 'Full']].map(([v, l]) => `<label><input type="radio" name="plan-mode" value="${v}" data-plan-mode ${pl.mode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
    <nav class="plan-dots" aria-label="Steps">${steps.map(([k, l], i) => `<button class="plan-dot ${i <= pl.step ? 'on' : ''} ${i === pl.step ? 'cur' : ''}" data-plan="go" data-i="${i}" aria-current="${i === pl.step}" title="${esc(l)}"><span>${i + 1}</span> ${esc(l)}</button>`).join('')}</nav>
    ${BODY[key](p, pl)}
    <div class="wk-foot">${pl.step ? `<button class="btn" data-plan="go" data-i="${pl.step - 1}">‹ Back</button>` : '<span></span>'}
      ${pl.step < steps.length - 1 ? `<button class="btn primary" data-plan="go" data-i="${pl.step + 1}">Next: ${esc(steps[pl.step + 1][1].toLowerCase())} →</button>` : ''}</div>`;
}

const BODY = {
  why: (p) => {
    const lines = String(p.principles || '').split('\n').filter((l) => l.trim());
    return `<h2 class="plan-q">Why are you doing this?</h2><p class="hint">What do you gain? It shows as the project’s gain, and its actions inherit it.</p>
      <textarea class="plan-text" data-plan-field="purpose" rows="3" placeholder="So the Smiths can use the bathroom before the holidays…">${esc(p.purpose || '')}</textarea>
      <h2 class="plan-q">Principles and boundaries</h2><p class="hint">What must be true, whatever happens?</p>
      ${lines.map((l, i) => `<div class="plan-idea"><span>${esc(l)}</span><button class="icon-btn" data-plan="rm-principle" data-i="${i}" aria-label="Remove">✕</button></div>`).join('')}
      <form class="capture" data-plan-add="principle"><input type="text" name="text" id="plan-principle" placeholder="Under $18k all in" maxlength="300" autocomplete="off" enterkeyhint="done"><button class="btn">Add</button></form>
      <div class="chip-row">${PRINCIPLE_PROMPTS.map(([l, v]) => `<button type="button" class="chip-btn" data-plan="prefix" data-v="${esc(v)}">+ ${esc(l)}</button>`).join('')}</div>`;
  },
  outcome: (p) => `<h2 class="plan-q">Picture it finished, and a big success. What do you see?</h2>
    <input type="text" class="plan-outcome" data-plan-field="outcome" value="${esc(p.outcome || '')}" maxlength="1000" placeholder="Final inspection passed, paid in full, Smiths happy" autocomplete="off">
    <p class="hint">One line. It shows at the top of the project and in Review.</p>`,
  brainstorm: (p, pl) => {
    const existing = db.tasks.filter((t) => t.project_id === p.id && isOpen(t) && !t.parent_id).sort(taskSort);
    return `<h2 class="plan-q">What comes to mind?</h2><p class="hint">Everything, in any order. Don’t judge yet.${p.outcome ? ` · Done looks like: ${esc(p.outcome)}` : ''}</p>
      ${existing.map((t) => `<div class="plan-idea old"><span>${esc(t.title)}</span><span class="hint">already in the project</span></div>`).join('')}
      ${pl.ideas.map((i) => `<div class="plan-idea"><span>${esc(i.text)}</span><button class="icon-btn" data-plan="rm-idea" data-id="${i.id}" aria-label="Remove">✕</button></div>`).join('')}
      ${pl.nudge ? `<p class="plan-nudge">${esc(pl.nudge)}</p>` : ''}
      <form class="capture" data-plan-add="idea"><input type="text" name="text" id="plan-idea" placeholder="Another idea ⏎" maxlength="500" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
      <div class="chip-row"><span class="hint">Stuck?</span>${NUDGES.map((n) => `<button type="button" class="chip-btn" data-plan="nudge" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <p class="hint">${pl.ideas.length} idea${pl.ideas.length === 1 ? '' : 's'}</p>`;
  },
  organize: (p, pl) => {
    if (!pl.ideas.some((i) => i.id === pl.sel)) pl.sel = (pl.ideas.find((i) => !i.bucket) || {}).id || null; // ready to sort
    const sel = pl.ideas.find((i) => i.id === pl.sel);
    const idea = (i) => `<button class="plan-idea pick ${i.id === pl.sel ? 'sel' : ''}" data-plan="select" data-id="${i.id}">${esc(i.text)}</button>`;
    const section = (title, list, extra = '') => (list.length ? `<h2 class="section-title">${title} · ${list.length}${extra}</h2>${list.map(idea).join('')}` : '');
    const unsorted = pl.ideas.filter((i) => !i.bucket);
    const buckets = [['action', 'Action'], ...pl.groups.map((g) => [`g:${g.id}`, esc(g.name)]), ['someday', 'Someday'], ['reference', 'Reference'], ['drop', 'Drop']];
    return `<p class="hint">Tap an idea, then where it goes. Groups become action groups with steps (like “Permits”).</p>
      ${sel ? `<div class="plan-buckets" role="group" aria-label="Move “${esc(sel.text)}” to">${buckets.map(([b, l]) => `<button class="plan-bucket ${bucketOf(sel) === b && sel.bucket ? 'on' : ''}" data-plan="bucket" data-v="${b}">${l}</button>`).join('')}
        <form class="plan-newgroup" data-plan-add="group"><input type="text" name="text" placeholder="+ Group" maxlength="120" autocomplete="off" aria-label="New group"></form></div>` : ''}
      ${section('Not sorted', unsorted)}
      ${pl.groups.map((g) => { const l = inBucket(pl, `g:${g.id}`); return `<h2 class="section-title">${esc(g.name)} · ${l.length} <button class="btn small" data-plan="order" data-id="${g.id}" aria-pressed="${!!g.in_order}">${g.in_order ? 'In order ✓' : 'In order?'}</button> <button class="btn small" data-plan="rm-group" data-id="${g.id}" aria-label="Remove group">✕</button></h2>${l.map(idea).join('') || '<p class="hint">Tap an idea, then this group.</p>'}`; }).join('')}
      ${section('Actions', pl.ideas.filter((i) => i.bucket === 'action'))}
      ${section('Someday', inBucket(pl, 'someday'))}
      ${section('Reference', inBucket(pl, 'reference'))}
      ${section('Drop', inBucket(pl, 'drop'))}
      ${!pl.groups.length ? '<form class="capture" data-plan-add="group"><input type="text" name="text" placeholder="Add a group, e.g. Permits" maxlength="120" autocomplete="off"><button class="btn">Add group</button></form>' : ''}
      ${!pl.ideas.length ? '<p class="empty small">No ideas yet. Go back to Brainstorm.</p>' : ''}`;
  },
  next: (p, pl) => {
    const ts = targets(pl);
    const c = summary(pl);
    return `<h2 class="plan-q">The very next action for each</h2><p class="hint">The first physical, visible thing you’d do.</p>
      ${ts.map(([scope, name, list]) => { const n = nextOf(pl, scope, list); return `<h2 class="section-title">${esc(name)}</h2>${list.map((i) => `<label class="plan-next"><input type="radio" name="next-${scope}" data-plan-next="${scope}" value="${i.id}" ${n && n.id === i.id ? 'checked' : ''}><span>${esc(i.text)}</span>${n && n.id === i.id ? '<span class="chip next">next</span>' : ''}</label>`).join('')}`; }).join('') || '<p class="empty small">Nothing to create yet.</p>'}
      <div class="plan-summary">${esc(c.text)}</div>
      <div class="wk-finish"><button class="btn primary" data-plan="create" ${c.total ? '' : 'disabled'}>Create</button></div>
      <p class="hint">One Undo takes it all back.</p>`;
  },
};

function summary(pl) {
  const groups = pl.groups.filter((g) => inBucket(pl, `g:${g.id}`).length).length;
  const actions = pl.ideas.filter((i) => !i.bucket || i.bucket === 'action' || i.bucket.startsWith('g:')).length;
  const some = inBucket(pl, 'someday').length;
  const refs = inBucket(pl, 'reference').length;
  const text = [groups && `${groups} group${groups === 1 ? '' : 's'}`, actions && `${actions} action${actions === 1 ? '' : 's'}`, some && `${some} in Someday`, refs && `${refs} reference item${refs === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return { total: groups + actions + some + refs, text: text ? `Creates ${text}` : 'Nothing to create yet.' };
}

function appliedHtml(p, pl) {
  const a = pl.applied;
  return `<a class="back" href="#project/${p.id}">‹ ${esc(p.name)}</a>
    <div class="cl-done"><div class="cl-big">🧭</div><h2>Planned</h2>
      <p>Created ${(a.task_ids || []).length} action${(a.task_ids || []).length === 1 ? '' : 's'}${(a.reference_ids || []).length ? ` and ${a.reference_ids.length} reference item${a.reference_ids.length === 1 ? '' : 's'}` : ''} on ${esc(fmtDate(a.at))}.</p>
      <p><a class="btn primary" href="#project/${p.id}">Open the project</a> <button class="btn" data-save-template="${p.id}">Save as template</button></p>
      <p><button class="btn small" data-plan="undo">↶ Undo the plan</button> <button class="btn small" data-plan="fresh">Plan more</button></p></div>`;
}

// ---------- events ----------
const focusSoon = (id) => setTimeout(() => { const el = document.getElementById(id); if (el && !matchMedia('(pointer: coarse)').matches) el.focus(); }, 0);
const current = () => { const pid = location.hash.split('/')[1]; const p = byId(db.projects, pid); return p ? [p, planFor(p)] : [null, null]; };

export async function planAction(el) {
  const [p, pl] = current();
  if (!p) return;
  const a = el.dataset.plan;
  if (a === 'go') { pl.step = Number(el.dataset.i); savePlan(pl); }
  else if (a === 'prefix') { const i = document.getElementById('plan-principle'); if (i) { i.value = el.dataset.v; i.focus(); } return; }
  else if (a === 'nudge') { pl.nudge = el.dataset.v; app.render(); focusSoon('plan-idea'); return; }
  else if (a === 'rm-principle') { const lines = String(p.principles || '').split('\n').filter((l) => l.trim()); lines.splice(Number(el.dataset.i), 1); await saveField(p, { principles: lines.join('\n') }); }
  else if (a === 'rm-idea') { pl.ideas = pl.ideas.filter((i) => i.id !== el.dataset.id); savePlan(pl); }
  else if (a === 'select') pl.sel = el.dataset.id;
  else if (a === 'bucket') {
    const i = pl.ideas.find((x) => x.id === pl.sel);
    if (i) { i.bucket = el.dataset.v; const next = pl.ideas.find((x) => !x.bucket); pl.sel = next ? next.id : null; savePlan(pl); }
  } else if (a === 'order') { const g = pl.groups.find((x) => x.id === el.dataset.id); if (g) { g.in_order = !g.in_order; savePlan(pl); } }
  else if (a === 'rm-group') { const id = el.dataset.id; pl.groups = pl.groups.filter((g) => g.id !== id); pl.ideas.forEach((i) => { if (i.bucket === `g:${id}`) i.bucket = null; }); savePlan(pl); }
  else if (a === 'create') {
    // In a Quick plan every idea is an action (nothing was sorted).
    await savePlan(pl, true);
    let res;
    try { res = await run(sb.rpc('apply_project_plan', { project: p.id })); } catch { return; }
    app.plan = null;
    await loadAll();
    location.hash = `#project/${p.id}`;
    app.render();
    toast(`Planned: ${res.tasks} action${res.tasks === 1 ? '' : 's'}${res.references ? `, ${res.references} reference` : ''}`, [{ label: 'Undo', run: async () => { await run(sb.rpc('undo_project_plan', { project: p.id })); app.plan = null; await loadAll(); app.render(); } }]);
    return;
  } else if (a === 'undo') { await run(sb.rpc('undo_project_plan', { project: p.id })); app.plan = null; await loadAll(); toast('Plan undone: its actions were dropped'); }
  else if (a === 'fresh') { await saveField(p, { plan: { mode: pl.mode, step: 0, ideas: [], groups: [], next: {} } }); app.plan = null; }
  app.render();
}

export function planSubmit(e) {
  const form = e.target.closest('[data-plan-add]');
  if (!form) return false;
  e.preventDefault();
  const [p, pl] = current();
  const text = form.elements.text.value.trim();
  if (!p || !text) return true;
  form.elements.text.value = '';
  const kind = form.dataset.planAdd;
  if (kind === 'idea') { pl.ideas.push({ id: uid(), text, bucket: null }); savePlan(pl); app.render(); focusSoon('plan-idea'); }
  else if (kind === 'group') {
    const g = { id: uid(), name: text, in_order: false };
    pl.groups.push(g);
    const i = pl.ideas.find((x) => x.id === pl.sel);
    if (i) { i.bucket = `g:${g.id}`; const next = pl.ideas.find((x) => !x.bucket); pl.sel = next ? next.id : null; }
    savePlan(pl); app.render();
  } else if (kind === 'principle') {
    const lines = String(p.principles || '').split('\n').filter((l) => l.trim());
    saveField(p, { principles: [...lines, text].join('\n').slice(0, 5000) }).then(() => { app.render(); focusSoon('plan-principle'); });
  }
  return true;
}

// Typing in purpose / outcome saves (debounced); choosing a next action or the mode saves the plan.
let fieldTimer;
export function planInput(e) {
  const el = e.target.closest && e.target.closest('[data-plan-field]');
  if (!el) return false;
  const [p] = current();
  if (!p) return true;
  clearTimeout(fieldTimer);
  fieldTimer = setTimeout(() => saveField(p, { [el.dataset.planField]: el.value.trim(), ...(el.dataset.planField === 'purpose' ? { purpose_by: null } : {}) }).catch(() => {}), 500);
  return true;
}
export function planChange(e) {
  const nx = e.target.closest && e.target.closest('[data-plan-next]');
  const mode = e.target.closest && e.target.closest('[data-plan-mode]');
  if (!nx && !mode) return false;
  const [p, pl] = current();
  if (!p) return true;
  if (nx) pl.next[nx.dataset.planNext] = nx.value;
  if (mode) { const key = STEPS[pl.mode][pl.step][0]; pl.mode = mode.value; const i = STEPS[pl.mode].findIndex(([k]) => k === key); pl.step = i >= 0 ? i : 0; }
  savePlan(pl);
  app.render();
  return true;
}
export const mountPlan = () => { const el = document.getElementById('plan-idea'); if (el && !matchMedia('(pointer: coarse)').matches) el.focus(); };
