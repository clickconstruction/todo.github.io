// Perspective editor: start from a template, then edit rules written as plain-English rows, with
// a live preview of what matches. Rules can nest (all / any / none of…).
import { db, $, esc, byId, openSheet, sortedTags, tagLabel, bySort, isOpen, toast, app } from '../state.js';
import { FLAG_RULES, DATE_FIELDS, DATE_WHEN, SHOW, GROUP_BY, SORT_BY, TEMPLATES, validate } from '../perspective-engine.js';
import { runPerspective, savePerspective, archivePerspective, duplicatePerspective, fromTemplate, summaryOf, freeName, rulesForCurrentView } from '../perspectives.js';
import { getFilter } from '../filter.js';

const ICONS = ['🔭', '📞', '⚡', '☀️', '⏰', '⏳', '🧊', '💻', '🏠', '🚗', '🛒', '💼', '🔧', '💡', '❤️', '📚'];
const opt = (list, v) => list.map(([k, l]) => `<option value="${k}" ${String(v) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const TYPES = [...FLAG_RULES, ['tag', 'Tagged'], ['project', 'In project'], ['folder', 'In folder'], ['date', 'Date'], ['duration', 'Duration'], ['text', 'Title or notes contain'], ['group', 'Group of rules…']];
const MATCH = [['all', 'all'], ['any', 'any'], ['none', 'none']];

function defaultRule(type) {
  switch (type) {
    case 'tag': return { type, tags: [] };
    case 'project': return { type, projects: [] };
    case 'folder': return { type, folders: [] };
    case 'date': return { type, field: 'due', when: 'next', days: 7 };
    case 'duration': return { type, op: 'max', minutes: 15 };
    case 'text': return { type, contains: '' };
    case 'group': return { match: 'any', rules: [{ type: 'flagged' }] };
    default: return { type };
  }
}

// Choices for tag / project / folder rules.
const CHOICES = {
  tags: () => sortedTags().map((g) => [g.id, tagLabel(g)]),
  projects: () => db.projects.filter((p) => ['active', 'on_hold'].includes(p.status)).sort(bySort).map((p) => [p.id, p.name]),
  folders: () => db.folders.filter((f) => !f.archived_at).sort(bySort).map((f) => [f.id, f.name]),
};
const labelOf = (key, id) => {
  if (key === 'tags') { const g = byId(db.tags, id); return g ? tagLabel(g) : '(missing tag)'; }
  const x = byId(key === 'projects' ? db.projects : db.folders, id);
  return x ? x.name + ((x.archived_at || ['completed', 'dropped'].includes(x.status)) ? ' (archived)' : '') : '(missing)';
};

function chips(r, path, key, noun) {
  const have = r[key] || [];
  const left = CHOICES[key]().filter(([id]) => !have.includes(id));
  return `<span class="rule-chips">${have.map((id) => `<span class="chip">${esc(labelOf(key, id))}<button type="button" class="chip-x" data-chip-remove="${path}" data-key="${key}" data-id="${id}" aria-label="Remove ${esc(labelOf(key, id))}">✕</button></span>`).join('')}
    ${left.length ? `<select data-chip-add="${path}" data-key="${key}" aria-label="Add a ${noun}"><option value="">${have.length ? `or another ${noun}…` : `Choose a ${noun}…`}</option>${opt(left, '')}</select>` : ''}</span>`;
}

function ruleHtml(r, path) {
  const type = Array.isArray(r.rules) ? 'group' : r.type;
  let params = '';
  if (type === 'tag') params = chips(r, path, 'tags', 'tag') + `<label class="rule-inline"><input type="checkbox" data-rule-field="${path}" data-key="sub" ${r.sub === false ? '' : 'checked'}> incl. sub-tags</label>`;
  else if (type === 'project') params = chips(r, path, 'projects', 'project');
  else if (type === 'folder') params = chips(r, path, 'folders', 'folder');
  else if (type === 'date') {
    params = `<select data-rule-field="${path}" data-key="field" aria-label="Which date">${opt(DATE_FIELDS, r.field)}</select>
      <select data-rule-field="${path}" data-key="when" data-restructure aria-label="Condition">${opt(DATE_WHEN, r.when)}</select>
      ${['next', 'past'].includes(r.when) ? `<input type="number" min="1" max="3650" step="1" class="rule-num" data-rule-field="${path}" data-key="days" value="${esc(r.days || 7)}" aria-label="Days"> days` : ''}
      ${['before', 'after'].includes(r.when) ? `<input type="date" data-rule-field="${path}" data-key="date" value="${esc(r.date || '')}" aria-label="Date">` : ''}`;
  } else if (type === 'duration') {
    params = `<select data-rule-field="${path}" data-key="op" aria-label="At most or at least">${opt([['max', 'is at most'], ['min', 'is at least']], r.op)}</select>
      <input type="number" min="1" max="10000" step="1" class="rule-num" data-rule-field="${path}" data-key="minutes" value="${esc(r.minutes || 15)}" aria-label="Minutes"> min`;
  } else if (type === 'text') {
    params = `<input type="text" class="rule-text" data-rule-field="${path}" data-key="contains" value="${esc(r.contains || '')}" placeholder="words" aria-label="Words">`;
  }
  const group = type === 'group' ? `<div class="rule-group">Match <select data-rule-match="${path}" aria-label="Match">${opt(MATCH, r.match)}</select> of:${listHtml(r, path)}</div>` : '';
  return `<li class="rule ${type === 'group' ? 'is-group' : ''}"><div class="rule-line">
      <select data-rule-type="${path}" aria-label="Rule type">${opt(TYPES, type)}</select>${params}
      <button type="button" class="icon-btn rule-x" data-rule-remove="${path}" aria-label="Remove rule">✕</button></div>${group}</li>`;
}

const listHtml = (g, path) => `<ul class="rule-list">${(g.rules || []).map((r, i) => ruleHtml(r, path === '' ? String(i) : `${path}.${i}`)).join('')}</ul>
  <div class="rule-add"><button type="button" class="btn small" data-rule-add="${path}">+ Rule</button><button type="button" class="btn small" data-rule-add="${path}" data-group>+ Group</button></div>`;

function previewHtml(draft) {
  const r = runPerspective({ ...draft, id: null }, { remember: false });
  const open = r.tasks.filter(isOpen);
  return `<div class="persp-preview-head"><b>${open.length}</b> match${open.length === 1 ? '' : 'es'} now · <span class="hint">${esc(summaryOf(draft))}</span></div>
    ${r.warnings.map((w) => `<p class="persp-warning">⚠️ ${esc(w)}</p>`).join('')}
    <ul class="persp-preview-list">${open.slice(0, 6).map((t) => `<li>${esc(t.title)}</li>`).join('')}${open.length > 6 ? `<li class="hint">and ${open.length - 6} more</li>` : ''}</ul>`;
}

// ---------- template picker ----------
export function openNewPerspective() {
  const sheet = openSheet(`<form method="dialog" class="persp-templates"><h2>New perspective</h2><p class="hint" style="margin:0">Start from a template, then change anything.</p>
    <ul class="template-list">${TEMPLATES.map((t) => { const d = fromTemplate(t.key); return `<li><button type="button" class="template" data-template="${t.key}"><span class="persp-icon" aria-hidden="true">${esc(t.icon)}</span><span class="persp-main"><span class="persp-name">${esc(t.key === 'blank' ? 'Blank' : t.name)}</span><span class="persp-sub">${esc(t.key === 'blank' ? 'Build your own rules' : summaryOf(d))}</span></span></button></li>`; }).join('')}</ul>
    <div class="actions"><div class="right"><button class="btn">Cancel</button></div></div></form>`);
  sheet.querySelector('form').onclick = (e) => {
    const b = e.target.closest('[data-template]');
    if (b) openPerspectiveEditor(null, fromTemplate(b.dataset.template));
  };
  sheet.showModal();
}

// From any view's filter: "Save as perspective".
export const saveCurrentViewAsPerspective = () => openPerspectiveEditor(null, rulesForCurrentView(getFilter()));

// ---------- editor ----------
export function openPerspectiveEditor(p, seed) {
  const src = p || seed || fromTemplate('blank');
  const draft = JSON.parse(JSON.stringify({ name: src.name, icon: src.icon || '🔭', rules: src.rules || { v: 1, match: 'all', rules: [] }, options: { show: 'available', group_by: 'project', sort_by: 'project', layout: 'tree', ...(src.options || {}) }, badge: !!src.badge }));
  const at = (path) => (path === '' ? draft.rules : path.split('.').reduce((g, i) => g.rules[Number(i)], draft.rules));
  const parentOf = (path) => { const parts = path.split('.'); const i = Number(parts.pop()); return [at(parts.join('.')), i]; };

  const sheet = openSheet('');
  sheet.classList.add('full');
  const draw = () => {
    sheet.innerHTML = `<form method="dialog" class="persp-editor" novalidate>
      <h2>${p ? 'Edit perspective' : 'New perspective'}</h2>
      <div class="persp-name-row"><input name="name" value="${esc(draft.name)}" placeholder="Name" aria-label="Name" maxlength="100" required></div>
      <div class="icon-row" role="radiogroup" aria-label="Icon">${ICONS.map((i) => `<button type="button" class="icon-pick ${draft.icon === i ? 'on' : ''}" data-icon="${i}" role="radio" aria-checked="${draft.icon === i}" aria-label="Icon ${i}">${i}</button>`).join('')}</div>
      <fieldset class="rules-box"><legend>Rules</legend>
        <div class="rule-top">Show <select data-opt="show" aria-label="Show">${opt(SHOW, draft.options.show)}</select> items that match <select data-rule-match="" aria-label="Match">${opt(MATCH, draft.rules.match || 'all')}</select> of:</div>
        ${listHtml(draft.rules, '')}
      </fieldset>
      <fieldset class="rules-box"><legend>Display</legend>
        <div class="persp-opts">
          <label>Group by <select data-opt="group_by">${opt(GROUP_BY, draft.options.group_by)}</select></label>
          <label>Sort by <select data-opt="sort_by">${opt(SORT_BY, draft.options.sort_by)}</select></label>
          <label>Steps <select data-opt="layout">${opt([['tree', 'Nested under their task'], ['flat', 'As a flat list']], draft.options.layout)}</select></label>
        </div>
        <label class="flag-toggle"><input type="checkbox" name="badge" ${draft.badge ? 'checked' : ''}> Show a count in the sidebar</label>
      </fieldset>
      <div class="persp-preview" data-preview aria-live="polite">${previewHtml(draft)}</div>
      <div class="actions">${p ? '<button type="button" class="btn danger-text" data-persp-archive>Archive</button>' : ''}<button type="button" class="btn" data-cancel>Cancel</button>
        <div class="right"><button type="submit" class="btn primary">${p ? 'Save' : 'Create'}</button></div></div>
    </form>`;
  };
  const preview = () => { const box = $('[data-preview]', sheet); if (box) box.innerHTML = previewHtml(draft); };
  draw();

  // #sheet is shared: a handler left over from an earlier editor must not act on another form.
  const mine = (e) => !!(e.target && e.target.closest && e.target.closest('form.persp-editor'));
  sheet.oninput = (e) => {
    if (!mine(e)) return;
    const el = e.target;
    if (el.name === 'name') { draft.name = el.value; return; }
    if (el.dataset.ruleField !== undefined && ['number', 'text', 'date'].includes(el.type)) {
      const r = at(el.dataset.ruleField);
      r[el.dataset.key] = el.type === 'number' ? Math.max(1, Math.round(Number(el.value) || 1)) : el.value;
      preview();
    }
  };
  sheet.onchange = (e) => {
    if (!mine(e)) return;
    const el = e.target;
    if (el.dataset.opt) { draft.options[el.dataset.opt] = el.value; preview(); return; }
    if (el.name === 'badge') { draft.badge = el.checked; return; }
    if (el.dataset.ruleMatch !== undefined) { at(el.dataset.ruleMatch).match = el.value; preview(); return; }
    if (el.dataset.ruleType !== undefined) {
      const [g, i] = parentOf(el.dataset.ruleType);
      g.rules[i] = defaultRule(el.value);
      draw();
      return;
    }
    if (el.dataset.chipAdd !== undefined && el.value) {
      const r = at(el.dataset.chipAdd);
      r[el.dataset.key] = [...(r[el.dataset.key] || []), el.value];
      draw();
      return;
    }
    if (el.dataset.ruleField !== undefined) {
      const r = at(el.dataset.ruleField);
      r[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.restructure !== undefined) { if (['next', 'past'].includes(r.when) && !r.days) r.days = 7; draw(); } else preview();
    }
  };
  sheet.onclick = async (e) => {
    if (!mine(e)) return;
    const t = e.target;
    const icon = t.closest('[data-icon]');
    if (icon) { draft.icon = icon.dataset.icon; sheet.querySelectorAll('[data-icon]').forEach((b) => { b.classList.toggle('on', b === icon); b.setAttribute('aria-checked', b === icon); }); return; }
    const add = t.closest('[data-rule-add]');
    if (add) {
      const g = at(add.dataset.ruleAdd);
      g.rules.push(defaultRule(add.dataset.group !== undefined ? 'group' : 'flagged'));
      draw();
      return;
    }
    const rm = t.closest('[data-rule-remove]');
    if (rm) { const [g, i] = parentOf(rm.dataset.ruleRemove); g.rules.splice(i, 1); draw(); return; }
    const cx = t.closest('[data-chip-remove]');
    if (cx) { const r = at(cx.dataset.chipRemove); r[cx.dataset.key] = (r[cx.dataset.key] || []).filter((id) => id !== cx.dataset.id); draw(); return; }
    if (t.closest('[data-cancel]')) { sheet.close(); return; }
    if (t.closest('[data-persp-archive]') && p) {
      if (!confirm(`Archive “${p.name}”? You can restore it from Perspectives.`)) return;
      sheet.close();
      await archivePerspective(p);
      toast(`Archived “${p.name}”`, [{ label: 'Undo', run: async () => { await archivePerspective(p, false); app.render(); } }]);
      location.hash = '#perspectives';
      app.render();
    }
  };
  sheet.onsubmit = async (e) => {
    if (!mine(e)) return;
    e.preventDefault();
    draft.name = String(draft.name || '').trim();
    if (!draft.name) { toast('Give it a name'); $('[name=name]', sheet).focus(); return; }
    if (!p && draft.name !== freeName(draft.name)) { toast(`You already have “${draft.name}”`); return; }
    const errors = validate({ rules: draft.rules, options: draft.options });
    if (errors.length) { toast(errors[0]); return; }
    try {
      const row = await savePerspective(p, { name: draft.name, icon: draft.icon, rules: draft.rules, options: draft.options, badge: draft.badge });
      sheet.close();
      location.hash = `#perspective/${row.id}`;
      app.render();
    } catch { /* toast shown */ }
  };
  sheet.addEventListener('close', () => { sheet.oninput = null; sheet.onchange = null; sheet.onclick = null; sheet.onsubmit = null; }, { once: true });
  if (!sheet.open) sheet.showModal();
  if (!p) $('[name=name]', sheet).select();
}

// ⋯ on a perspective.
export function openPerspectiveMenu(p) {
  const sheet = openSheet(`<form method="dialog" class="more-sheet"><h2>${esc(p.icon)} ${esc(p.name)}</h2>
    <nav class="more-links">
      <button type="button" data-m="edit"><span>✏️</span>Edit rules</button>
      <button type="button" data-m="badge"><span>🔢</span>${p.badge ? 'Hide the count' : 'Show a count in the sidebar'}</button>
      <button type="button" data-m="dup"><span>📄</span>Duplicate</button>
      <button type="button" data-m="archive"><span>🗄️</span>Archive</button>
    </nav>
    <div class="actions"><div class="right"><button class="btn">Close</button></div></div></form>`);
  sheet.querySelector('form').onclick = async (e) => {
    const m = e.target.closest('[data-m]');
    if (!m) return;
    sheet.close();
    if (m.dataset.m === 'edit') openPerspectiveEditor(p);
    if (m.dataset.m === 'badge') { await savePerspective(p, { badge: !p.badge }); app.render(); }
    if (m.dataset.m === 'dup') { const row = await duplicatePerspective(p); location.hash = `#perspective/${row.id}`; app.render(); }
    if (m.dataset.m === 'archive') {
      await archivePerspective(p);
      toast(`Archived “${p.name}”`, [{ label: 'Undo', run: async () => { await archivePerspective(p, false); app.render(); } }]);
      location.hash = '#perspectives';
      app.render();
    }
  };
  sheet.showModal();
}
