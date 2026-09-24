// Inbox, Today, Tags and Tag views.
import { db, esc, byId, isOpen, visible, taskSort, sortedTags, tagLabel, effectiveTagIds, tagStatus } from '../state.js';
import { isTickled, ticklerItems } from '../gtd.js';
import { taskList, treeList } from '../rows.js';
import { flattenTree, descendants } from '../tree.js';
import { filterBar, applyFilter, closedFor, withClosed, filterNote, sortTasks } from '../filter.js';
import { isAvailable } from '../availability.js';
import { activePlace } from '../places.js';
import { alertsNudge } from './alerts.js';

export function viewInbox() {
  // Tickled items wait (hidden) until their day, then come back marked 📆.
  const items = db.tasks.filter((t) => t.in_inbox && !t.parent_id && visible(t) && !isTickled(t)).sort(taskSort);
  const open = items.filter(isOpen).length;
  const waitingInTickler = ticklerItems().length;
  // Inbox items can be broken into steps before they're clarified: show them as a tree.
  const withSteps = items.flatMap((t) => [t, ...descendants(t).filter(visible)]);
  return `${alertsNudge()}<div class="view-head"><h1 class="inbox">Inbox</h1>${open ? '<a class="btn small primary" href="#clarify">Process Inbox</a>' : ''}</div>
    <p class="view-sub">${open} item${open === 1 ? '' : 's'} to clarify${waitingInTickler ? ` · <a href="#tickler">${waitingInTickler} in the tickler</a>` : ''} · <a href="#sweep">Mind sweep</a></p>
    <form class="capture" data-capture><input type="text" name="title" placeholder="Capture anything…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${treeList(flattenTree(withSteps)) || '<p class="empty">Inbox zero. Nice.</p>'}`;
}

export function viewTags() {
  const row = (tag) => {
    const n = db.tasks.filter((t) => isOpen(t) && effectiveTagIds(t).has(tag.id)).length;
    const st = tagStatus(tag);
    return `<a class="group-row ${tag.parent_id ? 'tag-child' : ''} ${st !== 'active' ? 'muted' : ''}" href="#tag/${tag.id}"><span>🏷️ ${esc(tag.name)}${st === 'on_hold' ? ' <span class="chip hold">⏸ on hold</span>' : ''}</span><span class="count">${n || ''}</span></a>`;
  };
  const rows = sortedTags().map(row).join('');
  const dropped = sortedTags({ dropped: true }).filter((t) => tagStatus(t) === 'dropped');
  const held = sortedTags().filter((t) => t.status === 'on_hold').length;
  return `<div class="view-head"><h1 class="tags">Tags</h1><button class="btn small primary" data-act="new-tag">+ Tag</button></div>
    <p class="view-sub">Contexts, people and waiting-fors. A task can have several.${held ? ' Actions with an on-hold tag are parked: not available until the tag is active again.' : ' Put a tag like Someday on hold to park all its actions at once.'}</p>
    ${rows || '<p class="empty">No tags yet. Try Laptop, Phone, Errands, or Waiting : Person.</p>'}
    ${dropped.length ? `<details class="dropped-tags"><summary class="section-title">Dropped · ${dropped.length}</summary>${dropped.map(row).join('')}</details>` : ''}`;
}

// Active / On hold / Dropped, with what each means.
const TAG_STATUSES = [['active', 'Active', 'Its actions are available as usual.'], ['on_hold', 'On hold', 'Its actions are parked: not available anywhere until it’s active again.'], ['dropped', 'Dropped', 'Retired: hidden from tag pickers and the Tags list. It stays on old actions and doesn’t hold them.']];
const tagStatusHtml = (tag) => {
  const own = tag.status || 'active';
  const inherited = tagStatus(tag) !== own && tagStatus(tag) !== 'active' ? byId(db.tags, tag.parent_id) : null;
  return `<div class="tag-status"><div class="segmented" role="radiogroup" aria-label="Tag status">
      ${TAG_STATUSES.map(([v, l]) => `<label><input type="radio" name="tag_status" value="${v}" data-tag-status="${tag.id}" ${own === v ? 'checked' : ''}><span>${v === 'on_hold' ? '⏸ ' : ''}${l}</span></label>`).join('')}
    </div><p class="hint">${esc(TAG_STATUSES.find(([v]) => v === own)[2])}${inherited ? ` Its parent “${esc(inherited.name)}” is ${tagStatus(tag) === 'on_hold' ? 'on hold' : 'dropped'}, so this one is too.` : ''}</p></div>`;
};

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
    <div class="view-head"><h1 class="tags">${esc(tagLabel(tag))}${tagStatus(tag) === 'on_hold' ? ' <span class="chip hold">⏸ on hold</span>' : ''}</h1><button class="btn small" data-edit-tag="${tag.id}">${activePlace(tag.place_id) ? `📍 ${esc(activePlace(tag.place_id).name)}` : 'Edit'}</button></div>
    ${tagStatusHtml(tag)}
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
