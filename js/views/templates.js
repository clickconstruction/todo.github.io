// Project templates in the app: the Templates list (under Projects), New project → from a template
// (fill the blanks, pick the date, see the preview), Save a project as a template, and the template
// editor (#template/<id>): an outline of actions with relative dates, blanks and a schedule.
import { db, app, sb, run, esc, byId, syncRow, toast, openSheet, bySort, sortedTags, tagLabel, $ } from '../state.js';
import { bodyFromProject, blanksOf, preview, flatten, nest, countActions, offsetLabel, describeSchedule, validateBody, STARTERS, dayKey, MAX_DEPTH } from '../templates.js';
import { localTz } from '../repeat.js';
import { loadAll } from '../data.js';
import { PROJECT_KINDS } from '../availability.js';

const liveTemplates = () => (db.templates || []).filter((t) => !t.archived_at).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
const fmtDay = (key) => (key ? new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const todayKey = () => dayKey(new Date(), localTz());
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

// ---------- data ----------
async function insertTemplate(fields) {
  const sort = Math.max(-1, ...(db.templates || []).map((t) => t.sort || 0)) + 1;
  const [row] = await run(sb.from('project_templates').insert({ ...fields, sort }).select());
  (db.templates = db.templates || []).push(row);
  return row;
}
async function updateTemplate(t, fields) {
  const [row] = await run(sb.from('project_templates').update(fields).eq('id', t.id).select());
  return syncRow('templates', t, row);
}
export async function createFromTemplate(t, { anchorKey, vars, folderId, name }) {
  const pid = await run(sb.rpc('create_from_template', { template: t.id, anchor: anchorKey, vars, name: name || null, folder: folderId || null, tz: localTz() }));
  await loadAll();
  return Array.isArray(pid) ? pid[0] : pid;
}

// ---------- Projects view: Templates section ----------
export function templatesSectionHtml() {
  const list = liveTemplates();
  const archived = (db.templates || []).filter((t) => t.archived_at);
  return `<div class="folder-title templates-title"><span>📋 Templates</span><span class="folder-actions"><button class="icon-btn" data-act="new-template" aria-label="New template">+</button></span></div>
    ${list.length ? list.map((t) => `<a class="group-row" href="#template/${t.id}"><span class="dot"></span><span class="group-main"><span>${esc(t.icon)} ${esc(t.name)}</span>
      <span class="group-sub">${plural(countActions(t.body), 'action')}${t.schedule ? ` · 🔁 ${esc(describeSchedule(t.schedule))}` : ''}</span></span></a>`).join('')
    : '<p class="empty" style="padding:8px 0">Save a project you repeat (a new job, a trip, a monthly close) as a template: tap 📋 on the project, or + here.</p>'}
    ${archived.length ? `<p class="view-sub"><button class="link-btn muted" data-act="toggle-archived-templates">${app.showArchivedTemplates ? 'Hide' : 'Show'} ${plural(archived.length, 'archived template')}</button></p>
      ${app.showArchivedTemplates ? archived.map((t) => `<a class="group-row muted" href="#template/${t.id}"><span class="dot"></span><span class="group-main"><span>${esc(t.icon)} ${esc(t.name)} (archived)</span></span></a>`).join('') : ''}` : ''}`;
}

// ---------- New project: blank or from a template ----------
export function openNewProject(folderId = null, openBlank) {
  const list = liveTemplates();
  if (!list.length) { openBlank(); return; }
  const sheet = openSheet(`<form method="dialog" class="tpl-pick"><h2>New project</h2>
    <button type="button" class="template" data-blank><span class="persp-icon">➕</span><span class="persp-main"><span class="persp-name">Blank project</span></span></button>
    <p class="field-label">From a template</p>
    <ul class="template-list">${list.map((t) => `<li><button type="button" class="template" data-use-template="${t.id}"><span class="persp-icon">${esc(t.icon)}</span>
      <span class="persp-main"><span class="persp-name">${esc(t.name)}</span><span class="persp-sub">${plural(countActions(t.body), 'action')}${t.body.kind && t.body.kind !== 'parallel' ? ` · ${t.body.kind.replace('_', ' ')}` : ''}</span></span></button></li>`).join('')}</ul>
    <div class="actions"><div class="right"><button class="btn">Cancel</button></div></div></form>`);
  sheet.querySelector('form').onclick = (e) => {
    if (e.target.closest('[data-blank]')) { openBlank(); return; }
    const b = e.target.closest('[data-use-template]');
    if (b) openUseTemplate(byId(db.templates, b.dataset.useTemplate), { folderId });
  };
  sheet.showModal();
}

// ---------- Use a template: blanks, date, folder, preview ----------
export function openUseTemplate(t, { folderId = null } = {}) {
  const blanks = blanksOf(t.body);
  const anchor = t.body.anchor === 'due' ? 'due' : 'start';
  const state = { vars: Object.fromEntries(blanks.map((b) => [b.name, b.default || ''])), anchorKey: todayKey(), folderId: folderId || t.folder_id || '' };
  const folders = db.folders.filter((f) => !f.archived_at).sort(bySort);
  const sheet = openSheet('');
  const previewHtml = () => {
    const pv = preview(t.body, { anchorKey: state.anchorKey, vars: state.vars });
    const missing = blanks.filter((b) => !String(state.vars[b.name] || '').trim()).map((b) => b.name);
    return `<p class="tpl-preview-name"><b>${esc(pv.name)}</b>${pv.due ? ` <span class="hint">due ${esc(fmtDay(pv.due))}</span>` : ''}</p>
      <ul class="tpl-preview">${pv.actions.slice(0, 10).map((a) => `<li style="--depth:${a.depth - 1}"><span>${esc(a.title)}</span>
        <span class="hint">${[a.defer && `from ${fmtDay(a.defer)}`, a.planned && `planned ${fmtDay(a.planned)}`, a.due && `due ${fmtDay(a.due)}`, a.flagged && '⚑', a.estimate_minutes && `${a.estimate_minutes}m`].filter(Boolean).map(esc).join(' · ')}</span></li>`).join('')}
        ${pv.actions.length > 10 ? `<li class="hint">+ ${pv.actions.length - 10} more</li>` : ''}</ul>
      ${missing.length ? `<p class="hint">Fill in ${missing.map((m) => `«${esc(m)}»`).join(', ')} (or it stays blank).</p>` : ''}`;
  };
  sheet.innerHTML = `<form method="dialog" class="tpl-use" data-tpl-use>
    <h2>${esc(t.icon)} ${esc(t.name)}</h2>
    ${blanks.map((b) => `<label>${esc(b.name)}<input type="text" data-var="${esc(b.name)}" value="${esc(state.vars[b.name])}" autocomplete="off"></label>`).join('')}
    <label>${anchor === 'due' ? 'Due date' : 'Start date'}<input type="date" name="anchor" value="${state.anchorKey}" required></label>
    <label>Folder<select name="folder"><option value="">No folder</option>${folders.map((f) => `<option value="${f.id}" ${f.id === state.folderId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
    <div class="tpl-preview-box" data-preview>${previewHtml()}</div>
    <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><div class="right"><button type="submit" class="btn primary">Create project</button></div></div></form>`;
  const form = sheet.querySelector('form');
  const refresh = () => { $('[data-preview]', form).innerHTML = previewHtml(); };
  form.oninput = (e) => {
    if (e.target.dataset.var !== undefined) state.vars[e.target.dataset.var] = e.target.value;
    if (e.target.name === 'anchor' && e.target.value) state.anchorKey = e.target.value;
    refresh();
  };
  form.onchange = (e) => { if (e.target.name === 'folder') state.folderId = e.target.value; };
  form.onclick = (e) => { if (e.target.closest('[data-cancel]')) sheet.close(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const pid = await createFromTemplate(t, { anchorKey: state.anchorKey, vars: state.vars, folderId: state.folderId });
      sheet.close();
      location.hash = `#project/${pid}`;
      app.render();
      toast(`Created from “${t.name}”`);
    } catch { btn.disabled = false; btn.textContent = 'Create project'; }
  };
  if (!sheet.open) sheet.showModal();
  const first = form.querySelector('[data-var]');
  if (first) first.focus();
}

// ---------- Save a project as a template ----------
export function openSaveAsTemplate(project) {
  const tasks = db.tasks.filter((x) => x.project_id === project.id);
  const data = { project, tasks, projectTags: db.projectTags, taskTags: db.taskTags };
  const state = { name: project.name, anchor: project.due_at && !project.defer_at ? 'due' : 'start', blanks: [{ find: '', name: '' }] };
  const sheet = openSheet('');
  const summary = () => {
    const { body, anchorKey } = bodyFromProject(data, { anchor: state.anchor, blanks: state.blanks, tz: localTz() });
    const n = countActions(body);
    const skipped = tasks.filter((x) => x.completed_at || x.dropped_at).length;
    return `${plural(n, 'action')} with their steps, tags, durations and notes${skipped ? ` (${skipped} completed or dropped left out)` : ''}.
      ${anchorKey ? `Dates count from ${state.anchor === 'due' ? 'the due date' : 'the start'} (${esc(fmtDay(anchorKey))} here).` : 'No dates to carry over.'}
      ${state.blanks.some((b) => b.find && b.name) ? `<br>Name becomes: <b>${esc(body.name)}</b>` : ''}`;
  };
  sheet.innerHTML = `<form method="dialog" class="tpl-save" data-tpl-save>
    <h2>Save as template</h2>
    <label>Template name<input type="text" name="name" value="${esc(state.name)}" required autocomplete="off"></label>
    <div class="field"><span class="field-label">Dates count from</span><div class="segmented" role="radiogroup" aria-label="Dates count from">
      <label><input type="radio" name="anchor" value="start" ${state.anchor === 'start' ? 'checked' : ''}><span>The start</span></label>
      <label><input type="radio" name="anchor" value="due" ${state.anchor === 'due' ? 'checked' : ''}><span>The due date</span></label></div></div>
    <div class="field"><span class="field-label">Words to fill in each time <span class="hint">e.g. the client’s name</span></span>
      <div data-blanks>${blankRows(state.blanks)}</div></div>
    <p class="hint" data-summary>${summary()}</p>
    <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><div class="right"><button type="submit" class="btn primary">Save template</button></div></div></form>`;
  const form = sheet.querySelector('form');
  const refresh = () => { $('[data-summary]', form).innerHTML = summary(); };
  form.oninput = (e) => {
    const el = e.target;
    if (el.name === 'name') state.name = el.value;
    if (el.dataset.blankI !== undefined) { state.blanks[+el.dataset.blankI][el.dataset.k] = el.value; }
    refresh();
  };
  form.onchange = (e) => { if (e.target.name === 'anchor') { state.anchor = e.target.value; refresh(); } };
  form.onclick = (e) => {
    if (e.target.closest('[data-cancel]')) { sheet.close(); return; }
    if (e.target.closest('[data-blank-add]')) { state.blanks.push({ find: '', name: '' }); $('[data-blanks]', form).innerHTML = blankRows(state.blanks); }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!state.name.trim()) return;
    const { body } = bodyFromProject(data, { anchor: state.anchor, blanks: state.blanks, tz: localTz() });
    const row = await insertTemplate({ name: state.name.trim(), icon: '📋', folder_id: project.folder_id || null, body });
    sheet.close();
    toast(`Saved template “${row.name}”`, [{ label: 'Open', run: () => { location.hash = `#template/${row.id}`; } }]);
    app.render();
  };
  sheet.showModal();
}
const blankRows = (blanks) => blanks.map((b, i) => `<div class="blank-row">Replace <input type="text" data-blank-i="${i}" data-k="find" value="${esc(b.find)}" placeholder="Jones" aria-label="Text to replace">
  with <input type="text" data-blank-i="${i}" data-k="name" value="${esc(b.name)}" placeholder="Client" aria-label="Blank name"></div>`).join('')
  + '<button type="button" class="link-btn" data-blank-add>+ Another</button>';

// ---------- New template: starters, or blank ----------
export function openNewTemplate() {
  const have = new Set(liveTemplates().map((t) => t.name.toLowerCase()));
  const sheet = openSheet(`<form method="dialog" class="tpl-pick"><h2>New template</h2>
    <p class="hint" style="margin:0">Tip: the quickest way is 📋 (Save as template) on a project you’ve already set up.</p>
    <ul class="template-list">${STARTERS.map((s) => `<li><button type="button" class="template" data-starter="${s.key}" ${have.has(s.name.toLowerCase()) ? 'disabled' : ''}><span class="persp-icon">${s.icon}</span>
      <span class="persp-main"><span class="persp-name">${esc(s.name)}</span><span class="persp-sub">${plural(countActions(s.body), 'action')}${have.has(s.name.toLowerCase()) ? ' · already added' : ''}</span></span></button></li>`).join('')}
      <li><button type="button" class="template" data-starter="blank"><span class="persp-icon">📋</span><span class="persp-main"><span class="persp-name">Blank template</span><span class="persp-sub">Build it action by action</span></span></button></li></ul>
    <div class="actions"><div class="right"><button class="btn">Cancel</button></div></div></form>`);
  sheet.querySelector('form').onclick = async (e) => {
    const b = e.target.closest('[data-starter]');
    if (!b || b.disabled) return;
    const s = STARTERS.find((x) => x.key === b.dataset.starter);
    const row = await insertTemplate(s ? { name: s.name, icon: s.icon, body: JSON.parse(JSON.stringify(s.body)) } : { name: 'New template', body: { name: 'New project', kind: 'parallel', anchor: 'start', actions: [{ title: '' }] } });
    sheet.close();
    location.hash = `#template/${row.id}`;
  };
  sheet.showModal();
}

// ---------- Template editor (#template/<id>) ----------
const E = { id: null, rows: [], open: -1, timer: null, saved: '' };
function load(t) {
  if (E.id === t.id && E.version === t.updated_at) return;
  E.id = t.id; E.version = t.updated_at; E.rows = flatten(t.body.actions); E.open = -1;
  if (!E.rows.length) E.rows = [{ title: '', depth: 1 }];
}
const tagChoices = () => sortedTags().map((g) => [g.id, tagLabel(g)]);

function rowHtml(r, i, anchor) {
  const tags = (r.tag_ids || []).map((id) => byId(db.tags, id)).filter(Boolean);
  const meta = [r.defer != null && `from ${offsetShort(r.defer)}`, r.planned != null && `planned ${offsetShort(r.planned)}`, r.due != null && `due ${offsetShort(r.due)}`,
    r.flagged && '⚑', r.estimate_minutes && `${r.estimate_minutes}m`, r.steps_in_order && 'in order', ...tags.map((g) => tagLabel(g))].filter(Boolean);
  const open = E.open === i;
  const num = (k, label) => `<label>${label}<span class="tpl-off"><input type="number" step="1" data-row-k="${k}" data-row="${i}" value="${r[k] ?? ''}" placeholder="—"> <span class="hint">${esc(offsetLabel(r[k], anchor) || 'no date')}</span></span></label>`;
  return `<li class="tpl-row ${open ? 'open' : ''}" style="--depth:${r.depth - 1}">
    <div class="tpl-line"><input type="text" class="tpl-title" data-row="${i}" data-row-k="title" value="${esc(r.title || '')}" placeholder="Action" aria-label="Action ${i + 1}" enterkeyhint="next">
      <button type="button" class="icon-btn" data-row-more="${i}" aria-expanded="${open}" aria-label="Details">${open ? '▾' : '⋯'}</button></div>
    ${meta.length && !open ? `<div class="tpl-meta">${meta.map(esc).join(' · ')}</div>` : ''}
    ${open ? `<div class="tpl-details">
      <div class="tpl-offs">${num('defer', 'Defer')}${num('planned', 'Planned')}${num('due', 'Due')}</div>
      <div class="tpl-flags"><label class="flag-toggle"><input type="checkbox" data-row="${i}" data-row-k="flagged" ${r.flagged ? 'checked' : ''}> Flagged</label>
        <label class="flag-toggle"><input type="checkbox" data-row="${i}" data-row-k="steps_in_order" ${r.steps_in_order ? 'checked' : ''}> Steps in order</label>
        <label>Duration <input type="number" min="0" step="1" data-row="${i}" data-row-k="estimate_minutes" value="${r.estimate_minutes || ''}" placeholder="min" class="tpl-min"></label></div>
      <div class="rule-chips">${tags.map((g) => `<span class="chip">${esc(tagLabel(g))}<button type="button" class="chip-x" data-row-untag="${i}" data-id="${g.id}" aria-label="Remove ${esc(tagLabel(g))}">✕</button></span>`).join('')}
        <select data-row-tag="${i}" aria-label="Add a tag"><option value="">+ Tag</option>${tagChoices().filter(([id]) => !(r.tag_ids || []).includes(id)).map(([id, l]) => `<option value="${id}">${esc(l)}</option>`).join('')}</select></div>
      <textarea data-row="${i}" data-row-k="notes" placeholder="Notes" rows="2">${esc(r.notes || '')}</textarea>
      <div class="tpl-moves"><button type="button" class="icon-btn" data-row-move="${i}" data-dir="-1" aria-label="Move up">▲</button><button type="button" class="icon-btn" data-row-move="${i}" data-dir="1" aria-label="Move down">▼</button>
        <button type="button" class="icon-btn" data-row-indent="${i}" aria-label="Make it a step of the action above" ${r.depth >= MAX_DEPTH || i === 0 ? 'disabled' : ''}>⇥</button><button type="button" class="icon-btn" data-row-outdent="${i}" aria-label="Move up a level" ${r.depth <= 1 ? 'disabled' : ''}>⇤</button>
        <button type="button" class="btn small danger-text" data-row-remove="${i}">Remove from template</button></div>
    </div>` : ''}</li>`;
}
const offsetShort = (o) => (o === 0 ? 'day 0' : o > 0 ? `+${o}d` : `${o}d`);

export function viewTemplate(id) {
  const t = byId(db.templates || [], id);
  if (!t) return '<a class="back" href="#projects">‹ Projects</a><p class="empty">Template not found.</p>';
  load(t);
  const b = t.body;
  const anchor = b.anchor === 'due' ? 'due' : 'start';
  const blanks = blanksOf({ ...b, actions: nest(E.rows) });
  const errors = validateBody({ ...b, actions: nest(E.rows) });
  const used = db.projects.filter((p) => p.template_id === t.id).length;
  return `<a class="back" href="#projects">‹ Projects</a>
    <div class="view-head tpl-head"><h1>${esc(t.icon)} <span class="tpl-kind">Template</span></h1>
      <span class="head-actions"><span class="save-state" data-tpl-state aria-live="polite">${esc(E.saved)}</span>
      ${t.archived_at ? `<button class="btn small" data-tpl-restore="${t.id}">Restore</button>` : `<button class="btn primary small" data-tpl-use="${t.id}">Create a project</button>`}</span></div>
    ${t.archived_at ? '<p class="persp-warning">This template is archived.</p>' : ''}
    <form class="tpl-editor" data-tpl-editor="${t.id}" onsubmit="return false">
      <label class="prop prop-inline">Template name<input type="text" data-tpl-k="tname" value="${esc(t.name)}" autocomplete="off"></label>
      <label class="prop prop-inline">Project name<input type="text" data-tpl-body="name" value="${esc(b.name || '')}" placeholder="«Client» remodel" autocomplete="off"></label>
      <p class="hint">Write «Client» (or any «Word») for a blank you fill in each time. «Date», «Month» and «Year» fill themselves.</p>
      <div class="tpl-settings">
        <label>Type <select data-tpl-body="kind">${PROJECT_KINDS.map(([v, l]) => `<option value="${v}" ${(b.kind || 'parallel') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Dates count from <select data-tpl-body="anchor"><option value="start" ${anchor === 'start' ? 'selected' : ''}>the start</option><option value="due" ${anchor === 'due' ? 'selected' : ''}>the due date</option></select></label>
        <label>Project due <span class="tpl-off"><input type="number" step="1" data-tpl-body="project_due" value="${b.project_due ?? ''}" placeholder="—" class="tpl-min"> <span class="hint">days</span></span></label>
        <label>Review every <span class="tpl-off"><input type="number" min="1" step="1" data-tpl-body="review_every" value="${b.review_every || 1}" class="tpl-min">
          <select data-tpl-body="review_unit" aria-label="Review unit">${['day', 'week', 'month', 'year'].map((u) => `<option value="${u}" ${(b.review_unit || 'week') === u ? 'selected' : ''}>${u}s</option>`).join('')}</select></span></label>
      </div>
      ${blanks.length ? `<fieldset class="rules-box"><legend>Blanks</legend>${blanks.map((bl) => `<label class="prop prop-inline">«${esc(bl.name)}» default
        <input type="text" data-tpl-blank="${esc(bl.name)}" value="${esc(bl.default)}" placeholder="asked each time"></label>`).join('')}</fieldset>` : ''}
      <fieldset class="rules-box"><legend>Actions · ${countActions({ actions: nest(E.rows) })}</legend>
        <ol class="tpl-rows">${E.rows.map((r, i) => rowHtml(r, i, anchor)).join('')}</ol>
        <button type="button" class="btn small" data-row-add>+ Action</button>
        <p class="hint">Enter adds the next action. ⋯ for dates (days from ${anchor === 'due' ? 'the due date' : 'the start'}), tags, duration and nesting.</p>
      </fieldset>
      <fieldset class="rules-box"><legend>Automatically</legend>
        <label class="flag-toggle"><input type="checkbox" data-tpl-sched-on ${t.schedule ? 'checked' : ''}> Create a project on a schedule</label>
        ${t.schedule ? `<div class="tpl-settings"><label>Every <span class="tpl-off"><input type="number" min="1" step="1" data-tpl-sched="every" value="${t.schedule.every}" class="tpl-min">
          <select data-tpl-sched="unit" aria-label="Schedule unit">${['day', 'week', 'month', 'year'].map((u) => `<option value="${u}" ${t.schedule.unit === u ? 'selected' : ''}>${u}s</option>`).join('')}</select></span></label>
          <label>Starting <input type="date" data-tpl-sched="start" value="${esc(t.schedule.start || '')}"></label></div>
          <p class="hint">${t.next_run_at ? `Next: ${esc(new Date(t.next_run_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}, using the blanks’ defaults.` : 'Saving…'}</p>` : ''}
      </fieldset>
      ${errors.map((x) => `<p class="persp-warning">⚠️ ${esc(x)}</p>`).join('')}
      <p class="hint">${used ? `${plural(used, 'project')} made from this template. ` : ''}${t.archived_at ? '' : `<button type="button" class="link-btn muted" data-tpl-archive="${t.id}">Archive template</button>`}</p>
    </form>`;
}

// Save the editor into the template (debounced while typing).
function saveSoon(t, now = false) {
  clearTimeout(E.timer);
  const go = async () => {
    const body = { ...t.body, actions: nest(E.rows.filter((r, i, a) => String(r.title || '').trim() || i === a.length - 1)) };
    body.blanks = blanksOf(body);
    E.saved = 'Saving…';
    const el = document.querySelector('[data-tpl-state]'); if (el) el.textContent = E.saved;
    const row = await updateTemplate(t, { body });
    E.version = row.updated_at; E.saved = 'Saved ✓';
    const el2 = document.querySelector('[data-tpl-state]'); if (el2) el2.textContent = E.saved;
  };
  if (now) return go();
  E.timer = setTimeout(go, 500);
  return null;
}

const current = () => { const f = document.querySelector('[data-tpl-editor]'); return f && byId(db.templates || [], f.dataset.tplEditor); };
const rerender = () => { app.render(); };
const focusRow = (i) => setTimeout(() => { const el = document.querySelector(`.tpl-title[data-row="${i}"]`); if (el) el.focus(); }, 0);

document.addEventListener('input', (e) => {
  const t = current(); if (!t || !e.target.closest('[data-tpl-editor]')) return;
  const el = e.target;
  if (el.dataset.row !== undefined && el.dataset.rowK) {
    const r = E.rows[+el.dataset.row];
    const k = el.dataset.rowK;
    if (el.type === 'checkbox') return;
    if (['defer', 'planned', 'due', 'estimate_minutes'].includes(k)) { const v = el.value === '' ? null : Math.round(Number(el.value)); if (v === null || (k === 'estimate_minutes' && v <= 0)) delete r[k]; else r[k] = v; }
    else r[k] = el.value;
    saveSoon(t);
    return;
  }
  if (el.dataset.tplBody) {
    const k = el.dataset.tplBody;
    const v = ['project_due', 'review_every'].includes(k) ? (el.value === '' ? undefined : Math.round(Number(el.value))) : el.value;
    t.body = { ...t.body, [k]: v };
    if (v === undefined) delete t.body[k];
    saveSoon(t);
    return;
  }
  if (el.dataset.tplK === 'tname') { clearTimeout(E.nameTimer); E.nameTimer = setTimeout(() => el.value.trim() && updateTemplate(t, { name: el.value.trim() }), 500); return; }
  if (el.dataset.tplBlank !== undefined) {
    const blanks = blanksOf(t.body).map((b) => (b.name === el.dataset.tplBlank ? { ...b, default: el.value } : b));
    t.body = { ...t.body, blanks };
    saveSoon(t);
  }
});
document.addEventListener('change', async (e) => {
  const t = current(); if (!t || !e.target.closest('[data-tpl-editor]')) return;
  const el = e.target;
  if (el.dataset.row !== undefined && el.type === 'checkbox') { const r = E.rows[+el.dataset.row]; if (el.checked) r[el.dataset.rowK] = true; else delete r[el.dataset.rowK]; saveSoon(t); rerender(); return; }
  if (el.dataset.rowTag !== undefined && el.value) { const r = E.rows[+el.dataset.rowTag]; r.tag_ids = [...(r.tag_ids || []), el.value]; saveSoon(t); rerender(); return; }
  if (el.dataset.tplBody === 'kind' || el.dataset.tplBody === 'anchor' || el.dataset.tplBody === 'review_unit') { await saveSoon(t, true); rerender(); return; }
  if (el.dataset.tplSchedOn !== undefined) {
    await updateTemplate(t, { schedule: el.checked ? { every: 1, unit: 'month', start: todayKey(), tz: localTz() } : null });
    rerender(); return;
  }
  if (el.dataset.tplSched) {
    const s = { ...(t.schedule || {}), tz: localTz() };
    s[el.dataset.tplSched] = el.dataset.tplSched === 'every' ? Math.max(1, Math.round(Number(el.value) || 1)) : el.value;
    await updateTemplate(t, { schedule: s });
    rerender();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList.contains('tpl-title')) return;
  const t = current(); if (!t) return;
  e.preventDefault();
  const i = +e.target.dataset.row;
  E.rows.splice(i + 1, 0, { title: '', depth: E.rows[i].depth });
  saveSoon(t); rerender(); focusRow(i + 1);
});
document.addEventListener('click', async (e) => {
  const el = e.target;
  const use = el.closest('[data-tpl-use]');
  if (use) { await saveSoon(byId(db.templates, use.dataset.tplUse), true); openUseTemplate(byId(db.templates, use.dataset.tplUse)); return; }
  const restore = el.closest('[data-tpl-restore]');
  if (restore) { await updateTemplate(byId(db.templates, restore.dataset.tplRestore), { archived_at: null }); rerender(); return; }
  const arch = el.closest('[data-tpl-archive]');
  if (arch) {
    const t = byId(db.templates, arch.dataset.tplArchive);
    await updateTemplate(t, { archived_at: new Date().toISOString() });
    toast(`Archived “${t.name}”`, [{ label: 'Undo', run: async () => { await updateTemplate(t, { archived_at: null }); rerender(); } }]);
    location.hash = '#projects';
    return;
  }
  const t = current(); if (!t || !el.closest('[data-tpl-editor]')) return;
  const idx = (attr) => +el.closest(`[${attr}]`).getAttribute(attr);
  if (el.closest('[data-row-add]')) { E.rows.push({ title: '', depth: 1 }); rerender(); focusRow(E.rows.length - 1); return; }
  if (el.closest('[data-row-more]')) { const i = idx('data-row-more'); E.open = E.open === i ? -1 : i; rerender(); return; }
  if (el.closest('[data-row-untag]')) { const i = idx('data-row-untag'); E.rows[i].tag_ids = (E.rows[i].tag_ids || []).filter((x) => x !== el.closest('[data-row-untag]').dataset.id); saveSoon(t); rerender(); return; }
  if (el.closest('[data-row-remove]')) { const i = idx('data-row-remove'); const d = E.rows[i].depth; let j = i + 1; while (j < E.rows.length && E.rows[j].depth > d) j++; E.rows.splice(i, j - i); if (!E.rows.length) E.rows.push({ title: '', depth: 1 }); E.open = -1; saveSoon(t); rerender(); return; }
  if (el.closest('[data-row-indent]')) { const i = idx('data-row-indent'); if (i > 0 && E.rows[i].depth < MAX_DEPTH && E.rows[i].depth <= E.rows[i - 1].depth) { E.rows[i].depth++; saveSoon(t); rerender(); } return; }
  if (el.closest('[data-row-outdent]')) { const i = idx('data-row-outdent'); if (E.rows[i].depth > 1) { E.rows[i].depth--; saveSoon(t); rerender(); } return; }
  if (el.closest('[data-row-move]')) {
    const i = idx('data-row-move'); const dir = +el.closest('[data-row-move]').dataset.dir; const j = i + dir;
    if (j < 0 || j >= E.rows.length) return;
    [E.rows[i], E.rows[j]] = [E.rows[j], E.rows[i]];
    E.rows = nest(E.rows).length ? flatten(nest(E.rows)) : E.rows; // keep depths valid
    E.open = j; saveSoon(t); rerender();
  }
});

export const templateCount = () => liveTemplates().length;
export { openNewTemplate as newTemplate };
