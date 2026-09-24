// Task editor: one form builder used by the pop-up sheet (phones, new items) and by the
// desktop inspector panel (edits in place, saving as you go). Plus quick entry.
import { sb, db, app, $, esc, byId, run, syncRow, toast, openSheet, isOpen, taskSort, tagsFor, onHoldTagFor, tagLabel } from '../state.js';
import { fromDateInput, fromDateTimeInput, HOURS, quickDate } from '../dates.js';
import { dateField, estimateField, dateTimeField, stampsHtml, wireQuickButtons } from '../components.js';
import { saveTask, capture } from '../data.js';
import { tagPickerHtml, wireTagPicker } from './tagPicker.js';
import { locationFieldHtml, wireLocationField } from './place.js';
import { placeFor } from '../places.js';
import { repeatFieldHtml, wireRepeatField } from './repeatField.js';
import { notifyFieldHtml, wireNotifyField, remindersFor } from './notifyField.js';
import { attachFieldHtml, wireAttachField, uploadFiles } from './attachField.js';
import { historyFieldHtml, wireHistoryField } from './historyField.js';
import { skipOccurrence } from '../data.js';
import { stepsFieldHtml, partOfFieldHtml, wireStepsFields } from './steps.js';
import { openBreakdown } from './breakdown.js';
import { section, prop, propInline, wireProps } from './props.js';
import { ENERGY, ENERGY_ICON, livePeople } from '../gtd.js';
import { checklistFieldHtml, wireChecklistField } from '../views/checklists.js';
import { openSchedule, addToGoogle, addToApple, scheduledLabel } from './schedule.js';
import { openDelegate, openTickle } from './gtd.js';
import { gainFieldHtml, wireGainField, offerPlacement } from './gainField.js';
import { splitGain } from '../gain.js';

// Waiting on someone (with a follow-up day), or something to discuss with them (Agenda).
function waitingFieldHtml(t, task) {
  const people = livePeople();
  const opts = (sel) => `<option value="">Nobody</option>${[...people, ...(db.people || []).filter((p) => p.archived_at && p.id === sel)].map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  return `<div class="waiting-field">
    <label>Waiting on <span class="hint">someone else’s move; not your next action</span><select name="waiting_on">${opts(t.waiting_on)}</select></label>
    <div data-follow-box ${t.waiting_on ? '' : 'hidden'}>${dateField('follow_up_at', 'Follow up', t.follow_up_at)}</div>
    <label>Discuss with <span class="hint">on their Agenda</span><select name="agenda_for">${opts(t.agenda_for)}</select></label>
    ${task && isOpen(task) ? '<button type="button" class="btn small" data-delegate-task>⏳ Delegate with a message…</button>' : ''}
    ${people.length ? '' : '<p class="hint">People are added when you delegate, or in Waiting For.</p>'}
  </div>`;
}

const notesAreLong = (text) => text.length > 280 || text.split('\n').length > 8;

// Layout: title (with complete + flag), notes, Steps, then sections of rows that open to edit
// (Organize, Dates, Repeat and alerts, and Status/files/history). See ./props.js.
function taskFieldsHtml(t, task, { inspector = false } = {}) {
  const projects = db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold' || p.id === t.project_id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const done = !!t.completed_at;
  return `
    <div class="title-row">
      ${inspector && task ? `<button type="button" class="check ${done ? 'done' : ''} ${t.flagged ? 'flagged' : ''}" data-check="${task.id}" aria-label="${done ? 'Mark incomplete' : 'Complete'}">✓</button>` : ''}
      <input type="text" name="title" value="${esc(t.title)}" placeholder="What is it?" required autocomplete="off" aria-label="Title">
      <label class="flag-pill" title="Flag"><input type="checkbox" name="flagged" ${t.flagged ? 'checked' : ''}><span aria-hidden="true">⚑</span><span class="sr-only">Flagged</span></label>
    </div>
    ${gainFieldHtml(t)}
    ${task && isOpen(task) && onHoldTagFor(task) ? `<p class="hold-note">⏸ Not available: tag <a href="#tag/${onHoldTagFor(task).id}">“${esc(tagLabel(onHoldTagFor(task)))}”</a> is on hold.</p>` : ''}
    <label class="notes-field"><span class="sr-only">Notes</span><textarea name="notes" placeholder="Notes" rows="2">${esc(t.notes)}</textarea></label>
    ${stepsFieldHtml(task)}
    ${checklistFieldHtml(task)}
    ${section('organize', 'Organize', `
      ${partOfFieldHtml(t)}
      ${propInline('Project', `<select name="project_id"><option value="">${task && task.in_inbox ? 'None (Inbox)' : 'None'}</option>
        ${projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><span class="prop-val follows" data-project-follows hidden></span>`)}
      ${prop('tags', 'Tags', tagPickerHtml())}
      ${prop('waiting', 'Waiting on', waitingFieldHtml(t, task))}
      ${propInline('Energy', `<select name="energy"><option value="">None</option>${ENERGY.map(([v, l]) => `<option value="${v}" ${t.energy === v ? 'selected' : ''}>${ENERGY_ICON[v]} ${l}</option>`).join('')}</select>`)}`)}
    ${section('dates', 'Dates', `
      ${prop('defer_at', 'Defer until', dateField('defer_at', 'Defer until', t.defer_at))}
      ${prop('planned_at', 'Planned', dateField('planned_at', 'Planned', t.planned_at))}
      ${prop('due_at', 'Due', dateField('due_at', 'Due', t.due_at))}
      ${prop('estimate', 'Duration', estimateField(t.estimate_minutes))}
      ${task && isOpen(task) ? `<div class="sched-row"><span class="prop-label">Scheduled</span><span class="sched-val">${task.scheduled_at ? `⏰ ${esc(scheduledLabel(task))} · ${task.scheduled_minutes || 30} min` : '<span class="hint">Not on your calendar</span>'}</span>
        <span class="sched-btns"><button type="button" class="btn small" data-sched-open>${task.scheduled_at ? 'Change' : 'Schedule it'}</button>${task.scheduled_at ? '<button type="button" class="btn small" data-sched-google>Add to Google</button><button type="button" class="btn small" data-sched-apple>Apple</button>' : ''}</span></div>` : ''}`)}
    ${section('alerts', 'Repeat and alerts', `
      ${prop('repeat', 'Repeat', repeatFieldHtml(t, { skippable: !!task && isOpen(task) }))}
      ${prop('notify', 'Notifications', notifyFieldHtml())}
      ${prop('location', 'Location', locationFieldHtml(t, { inherited: task ? placeFor({ ...task, place_id: null }) : null }))}`)}
    ${task ? section('more', 'Status, files and history', `
      ${propInline('Status', `<select name="status">
        <option value="open" ${!t.completed_at && !t.dropped_at ? 'selected' : ''}>Open</option>
        <option value="completed" ${t.completed_at ? 'selected' : ''}>Completed</option>
        <option value="dropped" ${t.dropped_at && !t.completed_at ? 'selected' : ''}>Dropped</option></select>`)}
      <div class="done-box" data-done-box ${t.completed_at ? '' : 'hidden'}>
        ${t.completed_at ? dateTimeField('completed_at_edit', '✓ Completed', t.completed_at) : '<b>✓ Completed when you save</b>'}
        <label>Completion note<textarea name="completion_note" placeholder="Outcome, who you spoke to, what's next…">${esc(t.completion_note || '')}</textarea></label></div>
      <div data-dropped-box ${t.dropped_at && !t.completed_at ? '' : 'hidden'}>${t.dropped_at ? dateTimeField('dropped_at_edit', 'Dropped', t.dropped_at) : ''}</div>
      ${attachFieldHtml()}
      ${historyFieldHtml(task)}`) : section('files', 'Files', attachFieldHtml())}
    ${task ? stampsHtml(task) : ''}`;
}

const secondaryButtons = (task) => `
  ${task && isOpen(task) ? '<button type="button" class="btn danger" data-drop>Drop</button><button type="button" class="btn" data-tickle-task title="Out of sight until a day, then back in the Inbox">Tickle…</button>' : ''}
`;

// Wire behaviour shared by sheet and panel; returns collect() → { fields, tagIds } or null.
function wireTaskForm(form, t, task, onTagsChange, stepsOpts = {}) {
  wireQuickButtons(form);
  wireProps(form);
  const selectedTags = wireTagPicker(form, task ? tagsFor(task.id).map((x) => x.id) : [], onTagsChange);

  const collectSteps = wireStepsFields(form, t, task, { onChange: onTagsChange, ...stepsOpts });
  const collectLocation = wireLocationField(form, onTagsChange);
  const collectRepeat = wireRepeatField(form, t, onTagsChange);
  const collectReminders = wireNotifyField(form, remindersFor('task_id', task && task.id), onTagsChange);
  const collectGain = wireGainField(form, t, 'task', onTagsChange);
  const collectFiles = wireAttachField(form, 'task_id', task && task.id);
  wireHistoryField(form, 'task_id', task && task.id);
  wireChecklistField(form, task);
  const cur = () => (task && byId(db.tasks, task.id)) || task;
  const so = $('[data-sched-open]', form); if (so && task) so.onclick = () => openSchedule(cur());
  const sg = $('[data-sched-google]', form); if (sg && task) sg.onclick = () => addToGoogle(cur());
  const sa = $('[data-sched-apple]', form); if (sa && task) sa.onclick = () => addToApple(cur());
  const waitSel = form.elements.waiting_on;
  if (waitSel) waitSel.addEventListener('change', () => {
    $('[data-follow-box]', form).hidden = !waitSel.value;
    const fu = form.elements.follow_up_at; // a week from today unless you pick a day
    if (waitSel.value && !fu.value) { fu.value = quickDate('', '+1w'); fu.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  const del = $('[data-delegate-task]', form);
  if (del && task) del.onclick = () => openDelegate(byId(db.tasks, task.id) || task);
  const tk = $('[data-tickle-task]', form);
  if (tk && task) tk.onclick = () => openTickle(byId(db.tasks, task.id) || task);
  const skip = $('[data-skip-occurrence]', form);
  if (skip && task) skip.onclick = () => skipOccurrence(task, () => { const sheet = form.closest('dialog'); if (sheet) sheet.close(); });
  if (form.elements.status) {
    form.elements.status.addEventListener('change', () => {
      $('[data-done-box]', form).hidden = form.elements.status.value !== 'completed';
      $('[data-dropped-box]', form).hidden = form.elements.status.value !== 'dropped';
    });
  }

  return () => {
    const f = new FormData(form);
    const fields = {
      title: (f.get('title') || '').trim(),
      notes: f.get('notes'),
      ...collectGain(),
      project_id: form.elements.project_id.value || null, // read directly: it's disabled while it's a step
      ...collectSteps(),
      flagged: f.get('flagged') === 'on',
      defer_at: fromDateInput(f.get('defer_at'), HOURS.defer_at),
      planned_at: fromDateInput(f.get('planned_at'), HOURS.planned_at),
      due_at: fromDateInput(f.get('due_at'), HOURS.due_at),
      estimate_minutes: f.get('estimate_minutes') === '' ? null : Math.max(0, Math.round(Number(f.get('estimate_minutes')))),
      energy: f.get('energy') || null,
      waiting_on: f.get('waiting_on') || null,
      follow_up_at: f.get('waiting_on') ? fromDateInput(f.get('follow_up_at'), 9) : null,
      agenda_for: f.get('agenda_for') || null,
      ...collectLocation(),
      repeat_rule: collectRepeat(),
      notifications: collectReminders(),
      attachments_pending: collectFiles(),
    };
    if (f.has('status')) {
      const status = f.get('status');
      const cur = (task && byId(db.tasks, task.id)) || t;
      // Completed / dropped times are editable (backdate something you did yesterday).
      const editedDone = f.get('completed_at_edit') ? fromDateTimeInput(f.get('completed_at_edit')) : null;
      const editedDrop = f.get('dropped_at_edit') ? fromDateTimeInput(f.get('dropped_at_edit')) : null;
      fields.completed_at = status === 'completed' ? (editedDone || cur.completed_at || new Date().toISOString()) : null;
      fields.dropped_at = status === 'dropped' ? (editedDrop || cur.dropped_at || new Date().toISOString()) : null;
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
  // A new item can be broken down right away: save it first, then open the steps sheet.
  const collect = wireTaskForm(form, t, task, undefined, { onBeforeBreakdown: () => { form.dataset.thenBreakdown = '1'; form.requestSubmit(); } });
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  // Items are dropped, never deleted: Drop saves the form with status "dropped" (restore via Status → Open).
  const drop = $('[data-drop]', sheet);
  if (drop) drop.onclick = () => { form.elements.status.value = 'dropped'; form.requestSubmit(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = collect();
    if (!data) return;
    sheet.close();
    const row = await saveWithDropUndo(task, data.fields, data.tagIds);
    if (form.dataset.thenBreakdown && row) openBreakdown(byId(db.tasks, row.id) || row);
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
    ${taskFieldsHtml(task, task, { inspector: true })}
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
      form.dispatchEvent(new Event('saved')); // refresh an open History
    } finally { delete container.dataset.saving; }
  };
  const soon = () => { clearTimeout(timer); state.textContent = 'Editing…'; timer = setTimeout(save, 400); };
  const collect = wireTaskForm(form, task, task, soon);
  form.addEventListener('change', soon);
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  const drop = $('[data-drop]', form);
  if (drop) drop.onclick = () => { form.elements.status.value = 'dropped'; save(); };
  form.flushSave = () => (timer ? save() : Promise.resolve());
}

// opts.heading / opts.onCaptured(row): e.g. Full Review adds the capture to the review as a later card.
export function openQuickEntry(opts = {}) {
  const sheet = openSheet(`<form method="dialog" id="quick">
    <h2>${esc(opts.heading || 'Capture to Inbox')}</h2>
    <input type="text" name="title" placeholder="What's on your mind?" autocomplete="off" enterkeyhint="next">
    <label class="gain-quick"><span class="gain-label"><span aria-hidden="true">✦</span> What do I gain?</span>
      <input type="text" name="gain" maxlength="500" placeholder="Optional · say why it’s worth doing" autocomplete="off" enterkeyhint="done"></label>
    <div class="actions quick-media"><label class="btn" title="Take or choose a photo">📷 Photo<input type="file" accept="image/*" capture="environment" data-quick-file hidden></label>
      <label class="btn" title="Attach a file">📎 File<input type="file" multiple data-quick-file hidden></label>
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div>
  </form>`);
  const form = $('#quick', sheet);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    // "Idea → gain" in the title works too.
    const split = splitGain(f.get('title'));
    const gain = String(f.get('gain') || '').trim() || split.gain;
    if (!split.title) { form.elements.title.focus(); return; }
    sheet.close();
    const row = await capture(split.title, gain ? { gain } : {});
    if (opts.onCaptured) { await opts.onCaptured(row); return; }
    if (row) offerPlacement(row, location.hash === '#inbox' ? '' : 'Captured to Inbox'); // in the Inbox, only when it fits somewhere
    else if (location.hash !== '#inbox') toast('Captured to Inbox');
  };
  // A photo or file: an Inbox item with it attached (titled "Photo · 3:42 PM" unless you typed one).
  form.querySelectorAll('[data-quick-file]').forEach((input) => input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) return;
    if (!navigator.onLine) { toast('Photos and files need a connection'); return; }
    const typed = String(form.elements.title.value || '').trim();
    const title = typed || (files[0].type.startsWith('image/') ? `Photo · ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : files[0].name);
    sheet.close();
    const [row] = await run(sb.from('tasks').insert({ title: title.slice(0, 300), in_inbox: true }).select());
    db.tasks.push(row);
    app.render();
    const up = await uploadFiles('task_id', row.id, files);
    app.render();
    if (opts.onCaptured) { await opts.onCaptured(row); return; }
    toast(`Captured with ${up.length} ${files[0].type.startsWith('image/') && up.length === 1 ? 'photo' : `file${up.length === 1 ? '' : 's'}`}`);
  }));
  sheet.showModal();
  $('[name=title]', sheet).focus();
}
