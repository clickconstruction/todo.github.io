// Project and folder editor sheets. Nothing is deleted: projects are completed/dropped,
// folders archived (only once they hold no active or on-hold projects; the database enforces this too).
import { sb, db, app, $, esc, run, syncRow, toast, openSheet, bySort, PROJECT_STATUSES } from '../state.js';
import { insertFolder, updateProject } from '../data.js';
import { PROJECT_KINDS } from '../availability.js';

export function openProjectEditor(project, defaults = {}) {
  const p = project || { name: '', folder_id: null, status: 'active', kind: 'parallel', complete_with_last: false, notes: '', ...defaults };
  const folderOptions = db.folders.filter((f) => !f.archived_at || f.id === p.folder_id).sort(bySort)
    .map((f) => `<option value="${f.id}" ${f.id === p.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const sheet = openSheet(`<form method="dialog" id="project-form">
    <h2>${project ? 'Edit project' : 'New project'}</h2>
    <input type="text" name="name" value="${esc(p.name)}" placeholder="Outcome, e.g. Launch todotooling.com" required autocomplete="off">
    <label>Folder
      <select name="folder_id"><option value="">No folder</option>${folderOptions}<option value="__new">+ New folder…</option></select></label>
    <input type="text" name="new_folder" placeholder="New folder name" autocomplete="off" hidden>
    <div class="field"><span class="field-label" id="kind-label">Type</span>
      <div class="segmented" role="radiogroup" aria-labelledby="kind-label">
        ${PROJECT_KINDS.map(([v, l, hint]) => `<label title="${esc(hint)}"><input type="radio" name="kind" value="${v}" ${p.kind === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div></div>
    <p class="view-sub kind-hint" style="margin:0">${esc(PROJECT_KINDS.find(([v]) => v === p.kind)[2])}</p>
    <label class="flag-toggle"><input type="checkbox" name="complete_with_last" ${p.complete_with_last ? 'checked' : ''}> Complete project when its last action is done</label>
    ${project ? `<label>Status<select name="status">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    <label>Notes<textarea name="notes" placeholder="Purpose, what done looks like…">${esc(p.notes)}</textarea></label>
    ${project ? '<p class="view-sub" style="margin:0">Projects are never deleted. Mark it Completed or Dropped to archive it.</p>' : ''}
    <div class="actions">
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>
  </form>`);
  const form = $('#project-form', sheet);
  const newFolder = form.elements.new_folder;
  form.elements.folder_id.onchange = (e) => {
    newFolder.hidden = e.target.value !== '__new';
    newFolder.required = !newFolder.hidden;
    if (!newFolder.hidden) newFolder.focus();
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'kind') $('.kind-hint', sheet).textContent = PROJECT_KINDS.find(([v]) => v === e.target.value)[2];
  });
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    let folder_id = f.get('folder_id') || null;
    if (folder_id === '__new') {
      const folder = await insertFolder(f.get('new_folder'));
      if (!folder) return;
      folder_id = folder.id;
    }
    const fields = { name: f.get('name').trim(), folder_id, notes: f.get('notes'), kind: f.get('kind') || 'parallel', complete_with_last: f.get('complete_with_last') === 'on' };
    if (project) fields.status = f.get('status');
    if (!fields.name) return;
    sheet.close();
    if (project) return updateProject(project, fields);
    const [row] = await run(sb.from('projects').insert({ ...fields, sort: db.projects.length }).select());
    db.projects.push(row);
    location.hash = `#project/${row.id}`;
  };
  sheet.showModal();
  if (!project) form.elements.name.focus();
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
