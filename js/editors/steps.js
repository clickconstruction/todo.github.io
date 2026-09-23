// Editor pieces for steps: the "Steps" section (progress, Break it down, Do in order, Turn into
// project) and the "Part of" field with a searchable picker to move a task under another one.
import { db, $, esc, byId, isOpen, taskSort, toast } from '../state.js';
import { stepsOf, progress, ancestors, canNestUnder, depthOf, MAX_DEPTH } from '../tree.js';
import { openBreakdown } from './breakdown.js';
import { convertToProject } from '../data.js';

const pathOf = (t) => ancestors(t).reverse().map((a) => a.title).concat(t.title).join(' › ');

export function stepsFieldHtml(task) {
  if (!task) {
    return `<fieldset class="steps-field"><legend>Steps</legend>
      <p class="hint" style="margin:0">Too big to do in one go? Split it into small steps.</p>
      <button type="button" class="btn" data-breakdown>🪜 Break it down</button></fieldset>`;
  }
  const kids = stepsOf(task);
  const deepest = depthOf(task) >= MAX_DEPTH;
  if (!kids.length) {
    return `<fieldset class="steps-field"><legend>Steps</legend>
      <p class="hint" style="margin:0">${deepest ? 'Steps can go 4 levels deep; this is the deepest.' : 'Too big to do in one go? Split it into small steps.'}</p>
      ${deepest || !isOpen(task) ? '' : '<button type="button" class="btn" data-breakdown>🪜 Break it down</button>'}</fieldset>`;
  }
  const p = progress(task);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return `<fieldset class="steps-field"><legend>Steps · ${p.done} of ${p.total} done</legend>
    <div class="step-progress" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <ol class="steps-mini">${kids.map((k) => `<li class="${k.completed_at ? 'done' : k.dropped_at ? 'dropped' : ''}">${esc(k.title)}${stepsOf(k).length ? ` <span class="hint">· ${progress(k).done}/${progress(k).total}</span>` : ''}</li>`).join('')}</ol>
    <label class="flag-toggle"><input type="checkbox" name="steps_in_order" ${task.steps_in_order ? 'checked' : ''}> Do in order <span class="hint">only the next step is available</span></label>
    <div class="steps-actions">
      ${isOpen(task) && !deepest ? '<button type="button" class="btn small" data-breakdown>🪜 Add or edit steps</button>' : ''}
      ${isOpen(task) ? '<button type="button" class="btn small" data-to-project>📁 Turn into a project</button>' : ''}
    </div></fieldset>`;
}

export function partOfFieldHtml(t) {
  const parent = t.parent_id && byId(db.tasks, t.parent_id);
  return `<div class="field part-of"><span class="field-label">Part of</span>
    <input type="hidden" name="parent_id" value="${esc(t.parent_id || '')}">
    <div class="part-of-row"><span data-part-of-label class="${parent ? '' : 'hint'}">${parent ? esc(pathOf(parent)) : 'Nothing (it stands on its own)'}</span>
      <button type="button" class="btn small" data-part-of>${parent ? 'Change' : 'Make it a step of…'}</button></div></div>`;
}

// Wire both; `task` is null for a new item. onChange = autosave hook (inspector).
export function wireStepsFields(form, t, task, { onChange = () => {}, onBeforeBreakdown } = {}) {
  const hidden = form.elements.parent_id;
  const label = $('[data-part-of-label]', form);
  const setParent = (p) => {
    hidden.value = p ? p.id : '';
    label.textContent = p ? pathOf(p) : 'Nothing (it stands on its own)';
    label.classList.toggle('hint', !p);
    $('[data-part-of]', form).textContent = p ? 'Change' : 'Make it a step of…';
    const proj = form.elements.project_id;
    if (proj) { // a step lives in its parent's project
      if (p) proj.value = p.project_id || '';
      proj.disabled = !!p;
      proj.title = p ? 'Steps follow the project of the task they belong to' : '';
    }
    onChange();
  };
  if (hidden.value) setParent(byId(db.tasks, hidden.value));

  const picker = $('[data-part-of]', form);
  if (picker) picker.onclick = () => openPartOfPicker(task || t, (p) => setParent(p));

  form.addEventListener('click', async (e) => {
    if (e.target.closest('[data-breakdown]')) {
      if (task) {
        // Afterwards, redraw this section in place (the editor may hold unsaved edits).
        openBreakdown(byId(db.tasks, task.id) || task, { onDone: () => {
          const box = $('.steps-field', form);
          if (box) box.outerHTML = stepsFieldHtml(byId(db.tasks, task.id) || task);
        } });
        return;
      }
      if (onBeforeBreakdown) onBeforeBreakdown(); // a new item: save it first, then break it down
      return;
    }
    if (e.target.closest('[data-to-project]') && task) {
      const n = stepsOf(task).filter(isOpen).length;
      if (!confirm(`Turn “${task.title}” into a project? Its ${n} step${n === 1 ? '' : 's'} become the project’s actions, and this task is dropped with a note (nothing is deleted).`)) return;
      const dlg = form.closest('dialog');
      if (dlg) dlg.close();
      const pid = await convertToProject(task);
      toast(`“${task.title}” is now a project`);
      if (pid) location.hash = `#project/${pid}`;
    }
  });
  return () => ({
    parent_id: hidden.value || null,
    ...(form.elements.steps_in_order ? { steps_in_order: form.elements.steps_in_order.checked } : {}),
  });
}

// Searchable list of tasks this one can go under (no loops, depth limit), grouped by project.
export function openPartOfPicker(task, onPick) {
  const dlg = $('#sheet2');
  const candidates = db.tasks.filter((x) => isOpen(x) && (task.id ? canNestUnder(task, x) : depthOf(x) < MAX_DEPTH));
  const draw = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = candidates.filter((x) => words.every((w) => pathOf(x).toLowerCase().includes(w) || ((byId(db.projects, x.project_id) || {}).name || '').toLowerCase().includes(w)));
    const groups = new Map();
    hits.sort(taskSort).slice(0, 80).forEach((x) => { const k = x.project_id || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
    $('[data-po-list]', dlg).innerHTML = `<li><button type="button" class="po-item" data-po="">⤴ Nothing: make it stand on its own</button></li>` +
      [...groups.entries()].sort(([a], [b]) => (!!a - !!b)).map(([pid, list]) => `<li class="po-group">${pid ? `🗂️ ${esc((byId(db.projects, pid) || {}).name || 'Project')}` : '📥 Inbox and loose tasks'}</li>` +
        list.map((x) => `<li><button type="button" class="po-item" data-po="${x.id}" style="--depth:${depthOf(x) - 1}">${esc(x.title)}${x.parent_id ? `<span class="hint"> in ${esc(pathOf(byId(db.tasks, x.parent_id)))}</span>` : ''}</button></li>`).join('')).join('')
      + (hits.length ? '' : '<li class="hint">No matching tasks.</li>');
  };
  dlg.innerHTML = `<form method="dialog" class="part-of-picker">
    <h2>Make it a step of…</h2>
    <p class="hint" style="margin:0">${esc(task.title || 'This item')} will move into that task’s project, with any steps of its own.</p>
    <input type="search" data-po-search placeholder="Search tasks" aria-label="Search tasks" autocomplete="off">
    <ul class="po-list" data-po-list></ul>
    <div class="actions"><div class="right"><button type="button" class="btn" data-po-cancel>Cancel</button></div></div></form>`;
  draw('');
  const search = $('[data-po-search]', dlg);
  search.oninput = () => draw(search.value);
  dlg.querySelector('form').onclick = (e) => {
    if (e.target.closest('[data-po-cancel]')) { dlg.close(); return; }
    const b = e.target.closest('[data-po]');
    if (!b) return;
    dlg.close();
    onPick(b.dataset.po ? byId(db.tasks, b.dataset.po) : null);
  };
  dlg.showModal();
  search.focus();
}
