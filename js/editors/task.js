// Task editor: one form builder used by the pop-up sheet (phones, new items) and by the
// desktop inspector panel (edits in place, saving as you go). Plus quick entry.
import { sb, db, app, $, esc, byId, run, syncRow, toast, openSheet, isOpen, taskSort, tagsFor } from '../state.js';
import { fmtDateTime, fromDateInput, HOURS } from '../dates.js';
import { dateField, estimateField, wireQuickButtons } from '../components.js';
import { saveTask, capture, addSubAction } from '../data.js';
import { tagPickerHtml, wireTagPicker } from './tagPicker.js';

const notesAreLong = (text) => text.length > 280 || text.split('\n').length > 8;

function taskFieldsHtml(t, task) {
  const projects = db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold' || p.id === t.project_id)
    .sort((a, b) => a.name.localeCompare(b.name));
  return `
    <input type="text" name="title" value="${esc(t.title)}" placeholder="What is it?" required autocomplete="off" aria-label="Title">
    <label>Project
      <select name="project_id"><option value="">${task && task.in_inbox ? 'None (stays in Inbox)' : 'None'}</option>
        ${projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></label>
    ${tagPickerHtml()}
    ${dateField('defer_at', 'Defer until', t.defer_at)}
    ${dateField('planned_at', 'Planned', t.planned_at)}
    ${dateField('due_at', 'Due', t.due_at)}
    ${estimateField(t.estimate_minutes)}
    <label>Subtask of<select name="parent_id"></select></label>
    <label class="flag-toggle"><input type="checkbox" name="flagged" ${t.flagged ? 'checked' : ''}> Flagged</label>
    <label class="notes-field">Notes<textarea name="notes" placeholder="Links, details…">${esc(t.notes)}</textarea></label>
    ${task ? `<label>Status<select name="status">
        <option value="open" ${!t.completed_at && !t.dropped_at ? 'selected' : ''}>Open</option>
        <option value="completed" ${t.completed_at ? 'selected' : ''}>Completed</option>
        <option value="dropped" ${t.dropped_at && !t.completed_at ? 'selected' : ''}>Dropped</option></select></label>
      <div class="done-box" data-done-box ${t.completed_at ? '' : 'hidden'}><b>✓ Completed ${t.completed_at ? esc(fmtDateTime(t.completed_at)) : 'when you save'}</b>
        <label>Completion note<textarea name="completion_note" placeholder="Outcome, who you spoke to, what's next…">${esc(t.completion_note || '')}</textarea></label></div>
      ${t.dropped_at ? `<p class="view-sub" style="margin:0">Dropped ${esc(fmtDateTime(t.dropped_at))}</p>` : ''}` : ''}`;
}

const secondaryButtons = (task) => `
  ${task && isOpen(task) ? '<button type="button" class="btn danger" data-drop>Drop</button>' : ''}
  ${task && isOpen(task) && task.project_id && !task.parent_id ? '<button type="button" class="btn" data-sub>+ Sub-action</button>' : ''}`;

// Wire behaviour shared by sheet and panel; returns collect() → { fields, tagIds } or null.
function wireTaskForm(form, t, task, onTagsChange) {
  wireQuickButtons(form);
  const selectedTags = wireTagPicker(form, task ? tagsFor(task.id).map((x) => x.id) : [], onTagsChange);

  // "Subtask of": top-level actions in the chosen project (not this item or its own subtasks).
  const isGroupTask = task && db.tasks.some((c) => c.parent_id === task.id);
  const drawParents = () => {
    const pid = form.elements.project_id.value;
    if (isGroupTask) { // one level deep: a group can't be a sub-action
      form.elements.parent_id.innerHTML = '<option value="">This is a group (it has sub-actions)</option>';
      form.elements.parent_id.disabled = true;
      return;
    }
    const options = pid ? db.tasks.filter((x) => x.project_id === pid && !x.parent_id && (isOpen(x) || x.id === t.parent_id) && (!task || (x.id !== task.id && x.parent_id !== task.id))) : [];
    const current = t.parent_id && options.some((x) => x.id === t.parent_id) ? t.parent_id : '';
    form.elements.parent_id.innerHTML = `<option value="">${pid ? 'None (top-level action)' : 'Choose a project first'}</option>` +
      options.sort(taskSort).map((x) => `<option value="${x.id}" ${x.id === current ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
    form.elements.parent_id.disabled = !pid;
  };
  drawParents();
  form.elements.project_id.addEventListener('change', drawParents);
  if (form.elements.status) {
    form.elements.status.addEventListener('change', () => { $('[data-done-box]', form).hidden = form.elements.status.value !== 'completed'; });
  }

  return () => {
    const f = new FormData(form);
    const fields = {
      title: (f.get('title') || '').trim(),
      notes: f.get('notes'),
      project_id: f.get('project_id') || null,
      parent_id: f.get('parent_id') || null,
      flagged: f.get('flagged') === 'on',
      defer_at: fromDateInput(f.get('defer_at'), HOURS.defer_at),
      planned_at: fromDateInput(f.get('planned_at'), HOURS.planned_at),
      due_at: fromDateInput(f.get('due_at'), HOURS.due_at),
      estimate_minutes: f.get('estimate_minutes') === '' ? null : Math.max(0, Math.round(Number(f.get('estimate_minutes')))),
    };
    if (f.has('status')) {
      const status = f.get('status');
      const cur = (task && byId(db.tasks, task.id)) || t;
      fields.completed_at = status === 'completed' ? (cur.completed_at || new Date().toISOString()) : null;
      fields.dropped_at = status === 'dropped' ? (cur.dropped_at || new Date().toISOString()) : null;
      fields.completion_note = status === 'completed' ? (f.get('completion_note') || '').trim() : (cur.completion_note || '');
    }
    return fields.title ? { fields, tagIds: selectedTags() } : null;
  };
}

// Save, then offer Undo if this save dropped the item.
async function saveWithDropUndo(task, fields, tagIds) {
  const wasDropped = !!(task && task.dropped_at); // saveTask updates task in place, so read it first
  app.doneCache = null;
  const row = await saveTask(task, fields, tagIds);
  if (task && fields.dropped_at && !wasDropped) {
    const saved = byId(db.tasks, task.id) || task;
    toast('Dropped', { label: 'Undo', run: async () => {
      const [r] = await run(sb.from('tasks').update({ dropped_at: null }).eq('id', saved.id).select());
      syncRow('tasks', saved, r);
      app.render();
    } });
  }
  return row;
}

function wireSubAction(root, task, before) {
  const sub = $('[data-sub]', root);
  if (sub) sub.onclick = async () => {
    const title = prompt(`New sub-action under “${task.title}”`);
    if (!title) return;
    if (before) before();
    await addSubAction(byId(db.tasks, task.id) || task, title);
  };
}

export function openEditor(task, defaults = {}) {
  const t = task || { title: '', notes: '', project_id: null, flagged: false, defer_at: null, due_at: null, ...defaults };
  const sheet = openSheet(`<form method="dialog" id="editor">
    <h2>${task ? 'Edit item' : 'New item'}</h2>
    ${taskFieldsHtml(t, task)}
    <div class="actions">${secondaryButtons(task)}
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>
  </form>`);
  const form = $('#editor', sheet);
  const collect = wireTaskForm(form, t, task);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  wireSubAction(sheet, task, () => sheet.close());
  // Items are dropped, never deleted: Drop saves the form with status "dropped" (restore via Status → Open).
  const drop = $('[data-drop]', sheet);
  if (drop) drop.onclick = () => { form.elements.status.value = 'dropped'; form.requestSubmit(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = collect();
    if (!data) return;
    sheet.close();
    await saveWithDropUndo(task, data.fields, data.tagIds);
  };
  // Long notes (e.g. a forwarded email) earn the whole screen; re-check as the user types.
  const notes = $('[name=notes]', sheet);
  const fitNotes = () => sheet.classList.toggle('full', notesAreLong(notes.value));
  notes.addEventListener('input', fitNotes);
  fitNotes();
  sheet.showModal();
  if (!task) form.elements.title.focus();
}

// Inspector panel: same fields, no Save button; every change saves (debounced), Cmd/Ctrl+Enter saves now.
export function renderTaskInspector(container, task) {
  container.innerHTML = `<form class="inspector-form" data-inspector-task="${task.id}" novalidate>
    <div class="inspector-head"><span class="inspector-kind">Action</span><span class="save-state" aria-live="polite"></span></div>
    ${taskFieldsHtml(task, task)}
    <div class="actions">${secondaryButtons(task)}</div>
  </form>`;
  const form = $('form', container);
  const state = $('.save-state', form);
  let timer;
  const save = async () => {
    clearTimeout(timer);
    const data = collect();
    if (!data) { state.textContent = 'Title required'; return; }
    state.textContent = 'Saving…';
    container.dataset.saving = '1'; // the app re-renders during the save; the panel is already current
    try {
      const row = await saveWithDropUndo(byId(db.tasks, task.id) || task, data.fields, data.tagIds);
      container.dataset.key = `t:${row.id}:${row.updated_at}`;
      state.textContent = 'Saved ✓';
    } finally { delete container.dataset.saving; }
  };
  const soon = () => { clearTimeout(timer); state.textContent = 'Editing…'; timer = setTimeout(save, 400); };
  const collect = wireTaskForm(form, task, task, soon);
  form.addEventListener('change', soon);
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  wireSubAction(form, task);
  const drop = $('[data-drop]', form);
  if (drop) drop.onclick = () => { form.elements.status.value = 'dropped'; save(); };
  form.flushSave = () => (timer ? save() : Promise.resolve());
}

export function openQuickEntry() {
  const sheet = openSheet(`<form method="dialog" id="quick">
    <h2>Capture to Inbox</h2>
    <input type="text" name="title" placeholder="What's on your mind?" required autocomplete="off" enterkeyhint="done">
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div>
  </form>`);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  $('#quick', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const title = new FormData(e.target).get('title');
    sheet.close();
    await capture(title);
    if (location.hash !== '#inbox') toast('Captured to Inbox');
  };
  sheet.showModal();
  $('[name=title]', sheet).focus();
}
