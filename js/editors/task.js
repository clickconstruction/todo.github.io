// Task editor sheet and quick entry.
import { sb, db, app, $, esc, byId, run, syncRow, toast, openSheet, isOpen, taskSort, tagsFor, tagLabel, sortedTags } from '../state.js';
import { fmtDateTime, toDateInput, fromDateInput } from '../dates.js';
import { saveTask, ensureTag, capture } from '../data.js';

const notesAreLong = (text) => text.length > 280 || text.split('\n').length > 8;

export function openEditor(task, defaults = {}) {
  const t = task || { title: '', notes: '', project_id: null, flagged: false, defer_at: null, due_at: null, ...defaults };
  const selected = new Set(task ? tagsFor(task.id).map((x) => x.id) : []);
  const projects = db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold' || p.id === t.project_id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const sheet = openSheet(`<form method="dialog" id="editor">
    <h2>${task ? 'Edit item' : 'New item'}</h2>
    <input type="text" name="title" value="${esc(t.title)}" placeholder="What is it?" required autocomplete="off">
    <label>Project
      <select name="project_id"><option value="">${task && task.in_inbox ? 'None (stays in Inbox)' : 'None'}</option>
        ${projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></label>
    <label>Tags <div class="tag-picker" id="tag-picker"></div>
      <input type="text" id="new-tag" placeholder="New tag (Enter). e.g. Laptop, Waiting : Hiro" autocomplete="off"></label>
    <div class="grid2">
      <label>Defer until<input type="date" name="defer_at" value="${toDateInput(t.defer_at)}"></label>
      <label>Due<input type="date" name="due_at" value="${toDateInput(t.due_at)}"></label>
    </div>
    <label>Subtask of<select name="parent_id"></select></label>
    <label class="flag-toggle"><input type="checkbox" name="flagged" ${t.flagged ? 'checked' : ''}> Flagged</label>
    <label class="notes-field">Notes<textarea name="notes" placeholder="Links, details…">${esc(t.notes)}</textarea></label>
    ${task ? `<label>Status<select name="status">
        <option value="open" ${!t.completed_at && !t.dropped_at ? 'selected' : ''}>Open</option>
        <option value="completed" ${t.completed_at ? 'selected' : ''}>Completed</option>
        <option value="dropped" ${t.dropped_at && !t.completed_at ? 'selected' : ''}>Dropped</option></select></label>
      <div class="done-box" id="done-box" ${t.completed_at ? '' : 'hidden'}><b>✓ Completed ${t.completed_at ? esc(fmtDateTime(t.completed_at)) : 'when you save'}</b>
        <label>Completion note<textarea name="completion_note" placeholder="Outcome, who you spoke to, what's next…">${esc(t.completion_note || '')}</textarea></label></div>
      ${t.dropped_at ? `<p class="view-sub" style="margin:0">Dropped ${esc(fmtDateTime(t.dropped_at))}</p>` : ''}` : ''}
    <div class="actions">
      ${task && isOpen(task) ? '<button type="button" class="btn danger" data-drop>Drop</button>' : ''}
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>
  </form>`);
  const form = $('#editor', sheet);

  const drawTags = () => {
    $('#tag-picker', sheet).innerHTML = sortedTags().map((tag) =>
      `<button type="button" class="tag-toggle ${selected.has(tag.id) ? 'on' : ''}" data-tag="${tag.id}">${esc(tagLabel(tag))}</button>`).join('');
  };
  drawTags();
  $('#tag-picker', sheet).onclick = (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    selected.has(b.dataset.tag) ? selected.delete(b.dataset.tag) : selected.add(b.dataset.tag);
    drawTags();
  };
  $('#new-tag', sheet).onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = await ensureTag(e.target.value);
    if (tag) { selected.add(tag.id); e.target.value = ''; drawTags(); }
  };

  // "Subtask of": top-level actions in the chosen project (not this item or its own subtasks).
  const drawParents = () => {
    const pid = form.elements.project_id.value;
    const options = pid ? db.tasks.filter((x) => x.project_id === pid && !x.parent_id && (isOpen(x) || x.id === t.parent_id) && (!task || (x.id !== task.id && x.parent_id !== task.id))) : [];
    const current = t.parent_id && options.some((x) => x.id === t.parent_id) ? t.parent_id : '';
    form.elements.parent_id.innerHTML = `<option value="">${pid ? 'None (top-level action)' : 'Choose a project first'}</option>` +
      options.sort(taskSort).map((x) => `<option value="${x.id}" ${x.id === current ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
    form.elements.parent_id.disabled = !pid;
  };
  drawParents();
  form.elements.project_id.addEventListener('change', drawParents);
  if (form.elements.status) {
    form.elements.status.onchange = () => { $('#done-box', sheet).hidden = form.elements.status.value !== 'completed'; };
  }
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  // Items are dropped, never deleted: Drop saves the form with status "dropped" (restore via Status → Open).
  const drop = $('[data-drop]', sheet);
  if (drop) drop.onclick = () => { form.elements.status.value = 'dropped'; form.requestSubmit(); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const fields = {
      title: f.get('title').trim(),
      notes: f.get('notes'),
      project_id: f.get('project_id') || null,
      parent_id: f.get('parent_id') || null,
      flagged: f.get('flagged') === 'on',
      defer_at: fromDateInput(f.get('defer_at'), 0),
      due_at: fromDateInput(f.get('due_at'), 17),
    };
    if (f.has('status')) {
      const status = f.get('status');
      fields.completed_at = status === 'completed' ? (t.completed_at || new Date().toISOString()) : null;
      fields.dropped_at = status === 'dropped' ? (t.dropped_at || new Date().toISOString()) : null;
      fields.completion_note = status === 'completed' ? (f.get('completion_note') || '').trim() : (t.completion_note || '');
    }
    if (!fields.title) return;
    app.doneCache = null;
    sheet.close();
    const wasDropped = !!(task && task.dropped_at); // saveTask updates task in place, so read it first
    await saveTask(task, fields, [...selected]);
    if (task && fields.dropped_at && !wasDropped) {
      const saved = byId(db.tasks, task.id) || task;
      toast('Dropped', { label: 'Undo', run: async () => {
        const [row] = await run(sb.from('tasks').update({ dropped_at: null }).eq('id', saved.id).select());
        syncRow('tasks', saved, row);
        app.render();
      } });
    }
  };

  // Long notes (e.g. a forwarded email) earn the whole screen; re-check as the user types.
  const notes = $('[name=notes]', sheet);
  const fitNotes = () => sheet.classList.toggle('full', notesAreLong(notes.value));
  notes.addEventListener('input', fitNotes);
  fitNotes();
  sheet.showModal();
  if (!task) form.elements.title.focus();
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
