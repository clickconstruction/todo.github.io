// Inbox, Today, Tags and Tag views.
import { db, esc, byId, isOpen, visible, taskSort, sortedTags, tagLabel, effectiveTagIds } from '../state.js';
import { taskList, treeList } from '../rows.js';
import { flattenTree, descendants } from '../tree.js';
import { filterBar, applyFilter, closedFor, withClosed, filterNote, sortTasks } from '../filter.js';
import { isAvailable } from '../availability.js';
import { activePlace } from '../places.js';
import { alertsNudge } from './alerts.js';

export function viewInbox() {
  const items = db.tasks.filter((t) => t.in_inbox && !t.parent_id && visible(t)).sort(taskSort);
  const open = items.filter(isOpen).length;
  // Inbox items can be broken into steps before they're clarified: show them as a tree.
  const withSteps = items.flatMap((t) => [t, ...descendants(t).filter(visible)]);
  return `${alertsNudge()}<div class="view-head"><h1 class="inbox">Inbox</h1></div>
    <p class="view-sub">${open} item${open === 1 ? '' : 's'} to clarify</p>
    <form class="capture" data-capture><input type="text" name="title" placeholder="Capture anything…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${treeList(flattenTree(withSteps)) || '<p class="empty">Inbox zero. Nice.</p>'}`;
}

export function viewTags() {
  const rows = sortedTags().map((tag) => {
    const n = db.tasks.filter((t) => isOpen(t) && effectiveTagIds(t).has(tag.id)).length;
    return `<a class="group-row ${tag.parent_id ? 'tag-child' : ''}" href="#tag/${tag.id}"><span>🏷️ ${esc(tag.name)}</span><span class="count">${n || ''}</span></a>`;
  }).join('');
  return `<div class="view-head"><h1 class="tags">Tags</h1><button class="btn small primary" data-act="new-tag">+ Tag</button></div>
    <p class="view-sub">Contexts, people and waiting-fors. A task can have several.</p>
    ${rows || '<p class="empty">No tags yet. Try Laptop, Phone, Errands, or Waiting : Person.</p>'}`;
}

export function viewTag(id) {
  const tag = byId(db.tags, id);
  if (!tag) return '<a class="back" href="#tags">‹ Tags</a><p class="empty">Tag not found.</p>';
  const ids = new Set([tag.id, ...db.tags.filter((t) => t.parent_id === tag.id).map((t) => t.id)]);
  const projects = db.projects.filter((p) => ['active', 'on_hold'].includes(p.status) && db.projectTags.some((x) => x.project_id === p.id && ids.has(x.tag_id)));
  const tagged = (t) => [...effectiveTagIds(t)].some((x) => ids.has(x));
  const local = db.tasks.filter(tagged);
  const directIds = db.taskTags.filter((x) => ids.has(x.tag_id)).map((x) => x.task_id);
  const taggedProjectIds = db.projectTags.filter((x) => ids.has(x.tag_id)).map((x) => x.project_id);
  const conds = [directIds.length && `id.in.(${directIds.slice(0, 300).join(',')})`, taggedProjectIds.length && `project_id.in.(${taggedProjectIds.join(',')})`].filter(Boolean);
  const closed = conds.length ? closedFor(`tag:${id}`, (q) => q.or(conds.join(','))) : [];
  const tasks = sortTasks(applyFilter(withClosed(local, closed)), taskSort);
  return `<a class="back" href="#tags">‹ Tags</a>
    <div class="view-head"><h1 class="tags">${esc(tagLabel(tag))}</h1><button class="btn small" data-edit-tag="${tag.id}">${activePlace(tag.place_id) ? `📍 ${esc(activePlace(tag.place_id).name)}` : 'Edit'}</button></div>
    ${filterBar()}${filterNote(local)}
    <p class="view-sub">${local.filter(isOpen).length} open${projects.length ? ` · includes actions from ${projects.map((p) => `<a href="#project/${p.id}">${esc(p.name)}</a>`).join(', ')} (tagged project)` : ''}</p>
    ${taskList(tasks) || (local.some(isOpen) ? '<p class="empty">Nothing matches this filter.</p>' : '<p class="empty">Nothing tagged here.</p>')}`;
}

// Flagged: flagged actions plus every action in a flagged project, grouped by project.
export const isFlaggedTask = (t) => t.flagged || !!(t.project_id && (byId(db.projects, t.project_id) || {}).flagged);
export const flaggedBadgeCount = () => db.tasks.filter((t) => isFlaggedTask(t) && isAvailable(t)).length;

export function viewFlagged() {
  const local = db.tasks.filter(isFlaggedTask);
  const flaggedProjects = db.projects.filter((p) => p.flagged).map((p) => p.id);
  const closed = closedFor('flagged', (q) => q.or(['flagged.is.true', flaggedProjects.length && `project_id.in.(${flaggedProjects.join(',')})`].filter(Boolean).join(',')));
  const tasks = sortTasks(applyFilter(withClosed(local, closed)), taskSort);
  const groups = new Map();
  tasks.forEach((t) => { const k = t.project_id || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  const sections = [...groups.entries()].sort(([a], [b]) => (!a) - (!b) || ((byId(db.projects, a) || {}).name || '').localeCompare((byId(db.projects, b) || {}).name || ''))
    .map(([pid, list]) => {
      const p = pid && byId(db.projects, pid);
      const title = p ? `<a href="#project/${p.id}">${p.flagged ? '⚑ ' : ''}${esc(p.name)}</a>` : 'No project';
      return `<h2 class="section-title">${title} · ${list.length}</h2>${taskList(list, { showProject: false })}`;
    }).join('');
  return `<div class="view-head"><h1 class="flagged">Flagged</h1></div>
    ${filterBar()}${filterNote(local)}
    <p class="view-sub">${local.filter(isOpen).length} open · flag an action, or a whole project, to bring it here</p>
    ${sections || (local.some(isOpen) ? '<p class="empty">Nothing matches this filter.</p>' : '<p class="empty">Nothing flagged. Tap ⚑ on anything that matters now.</p>')}`;
}
