// Projects list (by folder) and the single-project view.
import { db, app, esc, byId, isOpen, taskSort, bySort, projectTagsFor, tagLabel, PROJECT_STATUSES } from '../state.js';
import { projectRow, treeList } from '../rows.js';
import { flattenTree } from '../tree.js';
import { PROJECT_KINDS, nextAction } from '../availability.js';
import { filterBar, applyFilter, closedFor, withClosed, filterNote } from '../filter.js';

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
  const local = db.tasks.filter((t) => t.project_id === p.id);
  const all = withClosed(local, closedFor(`project:${p.id}`, (q) => q.eq('project_id', p.id)));
  const tasks = applyFilter(all).sort(taskSort);
  const entries = flattenTree(tasks);
  const ordered = entries.map((e) => e.t);
  const folder = p.folder_id && byId(db.folders, p.folder_id);
  return `<a class="back" href="#projects">‹ Projects${folder ? ` / 📁 ${esc(folder.name)}` : ''}</a>
    <div class="view-head"><h1>${esc(p.name)}</h1><button class="btn small" data-edit-project="${p.id}">Edit</button></div>
    ${p.notes ? `<p class="view-sub" style="white-space:pre-wrap">${esc(p.notes)}</p>` : ''}
    <p class="view-sub project-props"><select data-project-status="${p.id}" style="width:auto;padding:6px 10px">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="chip" title="${esc(PROJECT_KINDS.find(([v]) => v === p.kind)[2])}">${PROJECT_KINDS.find(([v]) => v === p.kind)[1]}</span>
      ${p.complete_with_last ? '<span class="chip" title="Completes when its last action is done">Auto-complete</span>' : ''}
      <button class="flag-btn ${p.flagged ? 'on' : ''}" data-flag-project="${p.id}" aria-pressed="${!!p.flagged}" title="${p.flagged ? 'Unflag project' : 'Flag project'}">⚑</button>
      ${projectTagsFor(p.id).map((tg) => `<a class="chip" href="#tag/${tg.id}">🏷️ ${esc(tagLabel(tg))}</a>`).join('')}
      ${ordered.filter((t) => !t.completed_at).length > 1 ? `<button class="btn small" data-act="toggle-reorder">${app.reorder === p.id ? 'Done reordering' : 'Reorder'}</button>` : ''}</p>
    ${filterBar()}${filterNote(local)}
    <form class="capture" data-capture data-project="${p.id}"><input type="text" name="title" placeholder="Add an action to ${esc(p.name)}…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${treeList(entries, { showProject: false, markNext: p.status === 'active' ? nextAction(p) : null, reorder: app.reorder === p.id }) || (local.some(isOpen) ? '<p class="empty">Nothing matches this filter.</p>' : '<p class="empty">No actions. What is the very next physical step?</p>')}
    <p class="view-sub" style="margin-top:20px"><a href="#done/all/${p.id}">✓ Completed in this project →</a></p>`;
}
