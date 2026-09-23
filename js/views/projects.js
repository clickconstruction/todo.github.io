// Projects list (by folder) and the single-project view.
import { db, app, esc, byId, visible, taskSort, bySort, isCollapsed, PROJECT_STATUSES } from '../state.js';
import { taskList, projectRow } from '../rows.js';
import { PROJECT_KINDS, nextAction } from '../availability.js';

export function viewProjects() {
  const isLive = (p) => p.status === 'active' || p.status === 'on_hold';
  const shown = db.projects.filter((p) => app.showInactive || isLive(p));
  const liveCount = db.projects.filter(isLive).length;
  const archivedFolders = db.folders.filter((f) => f.archived_at).length;
  const inactiveCount = db.projects.length - liveCount;
  const hiddenLabel = [inactiveCount && `${inactiveCount} completed/dropped`, archivedFolders && `${archivedFolders} archived folder${archivedFolders === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  const folderHead = (f) => `<div class="folder-title ${f.archived_at ? 'muted' : ''}"><span>${f.archived_at ? '🗄️' : '📁'} ${esc(f.name)}${f.archived_at ? ' (archived)' : ''}</span>
    <span class="folder-actions">${f.archived_at ? '' : `<button class="icon-btn" data-add-project="${f.id}" aria-label="New project in ${esc(f.name)}">+</button>`}<button class="icon-btn" data-edit-folder="${f.id}" aria-label="Edit folder ${esc(f.name)}">✎</button></span></div>`;
  let html = `<div class="view-head"><h1>Projects</h1><span><button class="btn small" data-act="new-folder">+ Folder</button> <button class="btn small primary" data-act="new-project">+ Project</button></span></div>
    <p class="view-sub">${liveCount} active project${liveCount === 1 ? '' : 's'}${hiddenLabel ? ` · <a href="#projects" data-act="toggle-inactive">${app.showInactive ? 'hide' : 'show'} ${hiddenLabel}</a>` : ''}</p>`;
  db.folders.filter((f) => app.showInactive || !f.archived_at).sort(bySort).forEach((f) => {
    const ps = shown.filter((p) => p.folder_id === f.id).sort(bySort);
    html += folderHead(f) + (ps.map(projectRow).join('') || '<p class="empty" style="padding:8px 0">No projects</p>');
  });
  const loose = shown.filter((p) => !p.folder_id || !byId(db.folders, p.folder_id)).sort(bySort);
  if (loose.length) html += `${db.folders.length ? '<div class="folder-title"><span>No folder</span></div>' : ''}${loose.map(projectRow).join('')}`;
  if (!db.projects.length) html += '<p class="empty">No projects yet. A project is any outcome that takes more than one action.</p>';
  return html;
}

export function viewProject(id) {
  const p = byId(db.projects, id);
  if (!p) return '<a class="back" href="#projects">‹ Projects</a><p class="empty">Project not found.</p>';
  const tasks = db.tasks.filter((t) => t.project_id === p.id && visible(t)).sort(taskSort);
  const top = tasks.filter((t) => !t.parent_id);
  const ordered = top.flatMap((t) => [t, ...(isCollapsed(t.id) ? [] : tasks.filter((s) => s.parent_id === t.id))]);
  const folder = p.folder_id && byId(db.folders, p.folder_id);
  return `<a class="back" href="#projects">‹ Projects${folder ? ` / 📁 ${esc(folder.name)}` : ''}</a>
    <div class="view-head"><h1>${esc(p.name)}</h1><button class="btn small" data-edit-project="${p.id}">Edit</button></div>
    ${p.notes ? `<p class="view-sub" style="white-space:pre-wrap">${esc(p.notes)}</p>` : ''}
    <p class="view-sub project-props"><select data-project-status="${p.id}" style="width:auto;padding:6px 10px">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="chip" title="${esc(PROJECT_KINDS.find(([v]) => v === p.kind)[2])}">${PROJECT_KINDS.find(([v]) => v === p.kind)[1]}</span>
      ${p.complete_with_last ? '<span class="chip" title="Completes when its last action is done">Auto-complete</span>' : ''}
      ${ordered.filter((t) => !t.completed_at).length > 1 ? `<button class="btn small" data-act="toggle-reorder">${app.reorder === p.id ? 'Done reordering' : 'Reorder'}</button>` : ''}</p>
    <form class="capture" data-capture data-project="${p.id}"><input type="text" name="title" placeholder="Add an action to ${esc(p.name)}…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${taskList(ordered, { showProject: false, hierarchy: true, markNext: p.status === 'active' ? nextAction(p) : null, reorder: app.reorder === p.id }) || '<p class="empty">No actions. What is the very next physical step?</p>'}
    <p class="view-sub" style="margin-top:20px"><a href="#done/all/${p.id}">✓ Completed in this project →</a></p>`;
}
