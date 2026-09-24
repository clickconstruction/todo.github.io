// Project and folder editor sheets. Nothing is deleted: projects are completed/dropped,
// folders archived (only once they hold no active or on-hold projects; the database enforces this too).
import { sb, db, app, $, esc, byId, run, syncRow, toast, openSheet, bySort, PROJECT_STATUSES } from '../state.js';
import { gainFieldHtml, wireGainField } from './gainField.js';
import { insertFolder, updateProject, setLinks } from '../data.js';
import { tagPickerHtml, wireTagPicker } from './tagPicker.js';
import { locationFieldHtml, wireLocationField } from './place.js';
import { repeatFieldHtml, wireRepeatField } from './repeatField.js';
import { notifyFieldHtml, wireNotifyField, remindersFor, saveReminders, refreshReminders } from './notifyField.js';
import { attachFieldHtml, wireAttachField, uploadFiles } from './attachField.js';
import { historyFieldHtml, wireHistoryField } from './historyField.js';
import { PROJECT_KINDS } from '../availability.js';
import { dateField, estimateField, dateTimeField, stampsHtml, wireQuickButtons } from '../components.js';
import { fromDateInput, fromDateTimeInput, toDateInput, fmtStamp, HOURS } from '../dates.js';
import { section, prop, propInline, wireProps } from './props.js';
import { folderFieldHtml } from '../folders.js';

export const REVIEW_UNITS = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']];

// Area of focus and goal (Horizons). Hidden until there's at least one of either.
function horizonsFields(p) {
  const areas = (db.areas || []).filter((a) => !a.archived_at || a.id === p.area_id).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  const goals = (db.goals || []).filter((g) => g.status === 'active' || g.id === p.goal_id).sort((a, b) => a.title.localeCompare(b.title));
  return `${areas.length ? propInline('Area', `<select name="area_id"><option value="">No area</option>${areas.map((a) => `<option value="${a.id}" ${a.id === p.area_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`) : ''}
    ${goals.length ? propInline('Serves goal', `<select name="goal_id"><option value="">No goal</option>${goals.map((g) => `<option value="${g.id}" ${g.id === p.goal_id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}</select>`) : ''}`;
}

function projectFieldsHtml(p, project) {
  const folderOptions = db.folders.filter((f) => !f.archived_at || f.id === p.folder_id).sort(bySort)
    .map((f) => `<option value="${f.id}" ${f.id === p.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  return `
    <div class="title-row">
      <input type="text" name="name" value="${esc(p.name)}" placeholder="Outcome, e.g. Launch todotooling.com" required autocomplete="off" aria-label="Project name">
      <label class="flag-pill" title="Flag (its actions show in Flagged)"><input type="checkbox" name="flagged" ${p.flagged ? 'checked' : ''}><span aria-hidden="true">⚑</span><span class="sr-only">Flagged</span></label>
    </div>
    ${gainFieldHtml(p, 'project')}
    <label class="outcome-field"><span class="field-label">Done looks like</span><input type="text" name="outcome" value="${esc(p.outcome || '')}" maxlength="1000" placeholder="Final inspection passed, paid in full" autocomplete="off"></label>
    <label class="notes-field"><span class="sr-only">Notes</span><textarea name="notes" placeholder="Notes: purpose, ideas, details…" rows="2">${esc(p.notes)}</textarea></label>
    <div class="outcome-field"><span class="field-label">Folder on your Mac</span>${folderFieldHtml(p.folder_path, p.name)}</div>
    ${section('organize', 'Organize', `
      ${propInline('Folder', `<select name="folder_id"><option value="">No folder</option>${folderOptions}<option value="__new">+ New folder…</option></select>`)}
      <input type="text" name="new_folder" placeholder="New folder name" autocomplete="off" hidden>
      ${horizonsFields(p)}
      <div class="field kind-field"><div class="segmented" role="radiogroup" aria-label="Project type">
        ${PROJECT_KINDS.map(([v, l, hint]) => `<label title="${esc(hint)}"><input type="radio" name="kind" value="${v}" ${p.kind === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div><p class="hint kind-hint" style="margin:0">${esc(PROJECT_KINDS.find(([v]) => v === p.kind)[2])}</p></div>
      <label class="flag-toggle"><input type="checkbox" name="complete_with_last" ${p.complete_with_last ? 'checked' : ''}> Complete when its last action is done</label>
      ${prop('tags', 'Tags', tagPickerHtml('actions inherit these'))}`)}
    ${section('dates', 'Dates', `
      ${prop('defer_at', 'Defer until', dateField('defer_at', 'Defer until', p.defer_at))}
      ${prop('planned_at', 'Planned', dateField('planned_at', 'Planned', p.planned_at))}
      ${prop('due_at', 'Due', dateField('due_at', 'Due', p.due_at))}
      ${prop('estimate', 'Duration', estimateField(p.estimate_minutes))}`)}
    ${section('review', 'Review', `
      ${project ? prop('next_review_at', 'Next review', dateField('next_review_at', 'Next review', p.next_review_at)) : ''}
      <label class="prop prop-inline review-every">Review every<span class="review-every">
        <input type="number" name="review_every" min="1" max="999" inputmode="numeric" value="${p.review_every || 1}" aria-label="Review every">
        <select name="review_unit" aria-label="Unit">${REVIEW_UNITS.map(([v, l]) => `<option value="${v}" ${(p.review_unit || 'week') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></span></label>
      ${project ? `<p class="hint prop-note">Last reviewed ${p.last_reviewed_at ? esc(fmtStamp(p.last_reviewed_at)) : 'never'}</p>` : ''}`)}
    ${section('alerts', 'Repeat and alerts', `
      ${prop('repeat', 'Repeat', repeatFieldHtml(p))}
      ${prop('notify', 'Notifications', notifyFieldHtml())}
      ${prop('location', 'Location', locationFieldHtml(p))}`)}
    ${project ? section('more', 'Status, files and history', `
      ${propInline('Status', `<select name="status">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${p.completed_at ? dateTimeField('completed_at_edit', p.status === 'dropped' ? 'Dropped' : 'Completed', p.completed_at) : ''}
      <p class="hint prop-note">Projects are never deleted. Mark it Completed or Dropped to archive it.</p>
      ${attachFieldHtml()}
      ${historyFieldHtml(project)}`) : section('files', 'Files', attachFieldHtml())}
    ${stampsHtml(project)}`;
}

// Shared wiring; returns collect() → Promise<{ fields, tagIds } | null> (creates a new folder if asked).
function wireProjectForm(form, project, onTagsChange) {
  const newFolder = form.elements.new_folder;
  form.elements.folder_id.addEventListener('change', (e) => {
    newFolder.hidden = e.target.value !== '__new';
    newFolder.required = !newFolder.hidden;
    if (!newFolder.hidden) newFolder.focus();
  });
  const selectedTags = wireTagPicker(form, project ? db.projectTags.filter((x) => x.project_id === project.id).map((x) => x.tag_id) : [], onTagsChange);
  const collectLocation = wireLocationField(form, onTagsChange);
  const collectGain = wireGainField(form, project || {}, 'project', onTagsChange);
  wireQuickButtons(form);
  wireProps(form);
  const collectRepeat = wireRepeatField(form, project || {}, onTagsChange);
  const collectReminders = wireNotifyField(form, remindersFor('project_id', project && project.id), onTagsChange);
  const collectFiles = wireAttachField(form, 'project_id', project && project.id);
  wireHistoryField(form, 'project_id', project && project.id);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'kind') $('.kind-hint', form).textContent = PROJECT_KINDS.find(([v]) => v === e.target.value)[2];
  });
  return async () => {
    const f = new FormData(form);
    let folder_id = f.get('folder_id') || null;
    if (folder_id === '__new') {
      const folder = await insertFolder(f.get('new_folder'));
      if (!folder) return null;
      folder_id = folder.id;
    }
    const fields = { name: (f.get('name') || '').trim(), folder_id, notes: f.get('notes'), kind: f.get('kind') || 'parallel',
      complete_with_last: f.get('complete_with_last') === 'on', flagged: f.get('flagged') === 'on', ...collectLocation(),
      outcome: String(f.get('outcome') || '').trim(), ...collectGain(),
      ...(form.elements.folder_path ? { folder_path: form.elements.folder_path.value.trim() || null } : {}) };
    if (form.elements.area_id) fields.area_id = f.get('area_id') || null;
    if (form.elements.goal_id) fields.goal_id = f.get('goal_id') || null;
    Object.assign(fields, {
      defer_at: fromDateInput(f.get('defer_at'), HOURS.defer_at),
      planned_at: fromDateInput(f.get('planned_at'), HOURS.planned_at),
      due_at: fromDateInput(f.get('due_at'), HOURS.due_at),
      estimate_minutes: f.get('estimate_minutes') === '' ? null : Math.max(0, Math.round(Number(f.get('estimate_minutes')))),
      review_every: Math.min(999, Math.max(1, Math.round(Number(f.get('review_every')) || 1))),
      review_unit: f.get('review_unit') || 'week',
      repeat_rule: collectRepeat(),
    });
    // Send the review date only when it was changed here, so an untouched date keeps following the cadence.
    if (project && f.has('next_review_at') && f.get('next_review_at') !== toDateInput(project.next_review_at)) {
      fields.next_review_at = fromDateInput(f.get('next_review_at'), 0);
    }
    if (project) fields.status = f.get('status');
    if (project && f.get('completed_at_edit') && ['completed', 'dropped'].includes(fields.status)) fields.completed_at = fromDateTimeInput(f.get('completed_at_edit'));
    return fields.name ? { fields, tagIds: selectedTags(), reminders: collectReminders(), files: collectFiles() } : null;
  };
}

async function saveProject(project, { fields, tagIds, reminders }) {
  await setLinks('project_tags', 'projectTags', 'project_id', project.id, tagIds);
  await saveReminders('project_id', project.id, reminders);
  const row = await updateProject(byId(db.projects, project.id) || project, fields);
  await refreshReminders('project_id', project.id);
  return row;
}

export function openProjectEditor(project, defaults = {}) {
  const p = project || { name: '', folder_id: null, status: 'active', kind: 'parallel', complete_with_last: false, flagged: false, notes: '', ...defaults };
  const sheet = openSheet(`<form method="dialog" id="project-form">
    <h2>${project ? 'Edit project' : 'New project'}</h2>
    ${projectFieldsHtml(p, project)}
    <div class="actions">
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>
  </form>`);
  const form = $('#project-form', sheet);
  const collect = wireProjectForm(form, project);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = await collect();
    if (!data) return;
    sheet.close();
    if (project) return saveProject(project, data);
    const [row] = await run(sb.from('projects').insert({ ...data.fields, sort: db.projects.length }).select());
    db.projects.push(row);
    await setLinks('project_tags', 'projectTags', 'project_id', row.id, data.tagIds);
    await saveReminders('project_id', row.id, data.reminders);
    if (data.files && data.files.length) await uploadFiles('project_id', row.id, data.files);
    location.hash = `#project/${row.id}`;
  };
  sheet.showModal();
  if (!project) form.elements.name.focus();
}

// Inspector panel for a project: edits in place and saves as you go.
export function renderProjectInspector(container, project) {
  container.innerHTML = `<form class="inspector-form" data-inspector-project="${project.id}" novalidate>
    <div class="inspector-head"><span class="inspector-kind">Project</span><span class="save-state" aria-live="polite"></span></div>
    ${projectFieldsHtml(project, project)}
  </form>`;
  const form = $('form', container);
  const state = $('.save-state', form);
  let timer;
  const save = async () => {
    clearTimeout(timer);
    if (form.elements.folder_id.value === '__new' && !form.elements.new_folder.value.trim()) return; // wait for a name
    const data = await collect();
    if (!data) { state.textContent = 'Name required'; return; }
    state.textContent = 'Saving…';
    container.dataset.saving = '1'; // the app re-renders during the save; the panel is already current
    try {
      const row = await saveProject(project, data);
      container.dataset.key = `p:${row.id}:${row.updated_at}`;
      state.textContent = 'Saved ✓';
      form.dispatchEvent(new Event('saved')); // refresh an open History
    } finally { delete container.dataset.saving; }
  };
  const soon = () => { clearTimeout(timer); state.textContent = 'Editing…'; timer = setTimeout(save, 400); };
  const collect = wireProjectForm(form, project, soon);
  form.addEventListener('change', soon);
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  form.flushSave = () => (timer ? save() : Promise.resolve());
}

export function openFolderEditor(folder) {
  const inside = folder ? db.projects.filter((p) => p.folder_id === folder.id) : [];
  const live = inside.filter((p) => p.status === 'active' || p.status === 'on_hold');
  let archiveControl = '';
  if (folder && folder.archived_at) {
    archiveControl = '<button type="button" class="btn" data-archive="off">Unarchive folder</button>';
  } else if (folder) {
    archiveControl = live.length
      ? `<p class="view-sub" style="margin:0">To archive this folder, first move or complete its ${live.length} active project${live.length === 1 ? '' : 's'}.</p>`
      : '<button type="button" class="btn" data-archive="on">Archive folder</button>';
  }
  const sheet = openSheet(`<form method="dialog" id="folder-form">
    <h2>${folder ? 'Edit folder' : 'New folder'}</h2>
    <input type="text" name="name" value="${esc(folder ? folder.name : '')}" placeholder="e.g. PRIORITIES, Click Construction, Personal" required autocomplete="off">
    ${folder ? `<p class="view-sub" style="margin:0">${inside.length} project${inside.length === 1 ? '' : 's'} in this folder${folder.archived_at ? ' · archived' : ''}</p>` : ''}
    <div class="actions">
      ${archiveControl}
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>
  </form>`);
  const form = $('#folder-form', sheet);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  const archive = $('[data-archive]', sheet);
  if (archive) archive.onclick = async () => {
    const archived_at = archive.dataset.archive === 'on' ? new Date().toISOString() : null;
    sheet.close();
    const [row] = await run(sb.from('folders').update({ archived_at }).eq('id', folder.id).select());
    syncRow('folders', folder, row);
    toast(archived_at ? `Archived "${folder.name}"` : `Unarchived "${folder.name}"`);
    app.render();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    sheet.close();
    if (folder) {
      const [row] = await run(sb.from('folders').update({ name }).eq('id', folder.id).select());
      syncRow('folders', folder, row);
    } else {
      await insertFolder(name);
    }
    app.render();
  };
  sheet.showModal();
  form.elements.name.focus();
}
