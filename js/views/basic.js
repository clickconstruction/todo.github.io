// Inbox, Today, Tags and Tag views.
import { db, esc, byId, isOpen, visible, taskSort, sortedTags, tagLabel, effectiveTagIds } from '../state.js';
import { isOverdue, isDueToday, isDeferred, isPlannedByToday } from '../dates.js';
import { taskList } from '../rows.js';

export function viewInbox() {
  const items = db.tasks.filter((t) => t.in_inbox && !t.parent_id && visible(t)).sort(taskSort);
  const open = items.filter(isOpen).length;
  return `<div class="view-head"><h1 class="inbox">Inbox</h1></div>
    <p class="view-sub">${open} item${open === 1 ? '' : 's'} to clarify</p>
    <form class="capture" data-capture><input type="text" name="title" placeholder="Capture anything…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${taskList(items) || '<p class="empty">Inbox zero. Nice.</p>'}`;
}

export function viewToday() {
  const open = db.tasks.filter((t) => visible(t) && !isDeferred(t));
  const overdue = open.filter((t) => isOpen(t) && isOverdue(t)).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  const today = open.filter((t) => t.due_at && !isOverdue(t) && isDueToday(t)).sort(taskSort);
  const planned = open.filter((t) => isOpen(t) && isPlannedByToday(t) && !isDueToday(t)).sort((a, b) => new Date(a.planned_at) - new Date(b.planned_at));
  const flagged = open.filter((t) => t.flagged && !(t.due_at && isDueToday(t)) && !planned.includes(t)).sort(taskSort);
  const d = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  let html = `<div class="view-head"><h1 class="today">Today</h1></div><p class="view-sub">${esc(d)}</p>`;
  if (overdue.length) html += `<h2 class="section-title">Overdue · ${overdue.length}</h2>${taskList(overdue)}`;
  if (today.length) html += `<h2 class="section-title">Due today</h2>${taskList(today)}`;
  if (planned.length) html += `<h2 class="section-title">Planned · ${planned.length}</h2>${taskList(planned)}`;
  if (flagged.length) html += `<h2 class="section-title">Flagged</h2>${taskList(flagged)}`;
  if (!overdue.length && !today.length && !planned.length && !flagged.length) html += '<p class="empty">Nothing due or flagged. Pick from a project or tag.</p>';
  return html;
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
  const tasks = db.tasks.filter((t) => visible(t) && [...effectiveTagIds(t)].some((id) => ids.has(id))).sort(taskSort);
  const projects = db.projects.filter((p) => ['active', 'on_hold'].includes(p.status) && db.projectTags.some((x) => x.project_id === p.id && ids.has(x.tag_id)));
  return `<a class="back" href="#tags">‹ Tags</a>
    <div class="view-head"><h1 class="tags">${esc(tagLabel(tag))}</h1></div>
    <p class="view-sub">${tasks.filter(isOpen).length} open${projects.length ? ` · includes actions from ${projects.map((p) => `<a href="#project/${p.id}">${esc(p.name)}</a>`).join(', ')} (tagged project)` : ''}</p>
    ${taskList(tasks) || '<p class="empty">Nothing tagged here.</p>'}`;
}
