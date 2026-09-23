// Project and folder editor sheets. Nothing is deleted: projects are completed/dropped,
// folders archived (only once they hold no active or on-hold projects; the database enforces this too).
import { sb, db, app, $, esc, byId, run, syncRow, toast, openSheet, bySort, PROJECT_STATUSES } from '../state.js';
import { insertFolder, updateProject, setLinks } from '../data.js';
import { tagPickerHtml, wireTagPicker } from './tagPicker.js';
import { PROJECT_KINDS } from '../availability.js';

function projectFieldsHtml(p, project) {
  const folderOptions = db.folders.filter((f) => !f.archived_at || f.id === p.folder_id).sort(bySort)
    .map((f) => `<option value="${f.id}" ${f.id === p.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  return `
    <input type="text" name="name" value="${esc(p.name)}" placeholder="Outcome, e.g. Launch todotooling.com" required autocomplete="off" aria-label="Project name">
    <label>Folder
      <select name="folder_id"><option value="">No folder</option>${folderOptions}<option value="__new">+ New folder…</option></select></label>
    <input type="text" name="new_folder" placeholder="New folder name" autocomplete="off" hidden>
    <div class="field"><span class="field-label">Type</span>
      <div class="segmented" role="radiogroup" aria-label="Project type">
        ${PROJECT_KINDS.map(([v, l, hint]) => `<label title="${esc(hint)}"><input type="radio" name="kind" value="${v}" ${p.kind === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div></div>
    <p class="view-sub kind-hint" style="margin:0">${esc(PROJECT_KINDS.find(([v]) => v === p.kind)[2])}</p>
    <label class="flag-toggle"><input type="checkbox" name="complete_with_last" ${p.complete_with_last ? 'checked' : ''}> Complete project when its last action is done</label>
    <label class="flag-toggle"><input type="checkbox" name="flagged" ${p.flagged ? 'checked' : ''}> Flagged <span class="hint">its actions show in Flagged</span></label>
    ${tagPickerHtml('actions inherit these')}
    ${project ? `<label>Status<select name="status">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    <label>Notes<textarea name="notes" placeholder="Purpose, what done looks like…">${esc(p.notes)}</textarea></label>
    ${project ? '<p class="view-sub" style="margin:0">Projects are never deleted. Mark it Completed or Dropped to archive it.</p>' : ''}`;
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
      complete_with_last: f.get('complete_with_last') === 'on', flagged: f.get('flagged') === 'on' };
    if (project) fields.status = f.get('status');
    return fields.name ? { fields, tagIds: selectedTags() } : null;
  };
}

async function saveProject(project, { fields, tagIds }) {
  await setLinks('project_tags', 'projectTags', 'project_id', project.id, tagIds);
  return updateProject(byId(db.projects, project.id) || project, fields);
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
