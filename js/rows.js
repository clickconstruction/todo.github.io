// List row renderers shared by the views.
import { db, esc, byId, tagsFor, tagLabel, isOpen, PROJECT_STATUSES } from './state.js';
import { fmtDate, isOverdue, isDeferred, isPlannedPast } from './dates.js';

export function taskRow(t, { showProject = true } = {}) {
  const done = !!t.completed_at;
  const project = t.project_id && byId(db.projects, t.project_id);
  const tags = tagsFor(t.id);
  const meta = [];
  if (showProject && project) meta.push(`<span>🗂️ ${esc(project.name)}</span>`);
  tags.forEach((tag) => meta.push(`<span class="chip">${esc(tagLabel(tag))}</span>`));
  if (t.defer_at && isDeferred(t)) meta.push(`<span>⏸ ${esc(fmtDate(t.defer_at))}</span>`);
  if (t.planned_at && isOpen(t)) meta.push(`<span class="meta-planned ${isPlannedPast(t) ? 'past' : ''}" title="Planned">🗓 ${esc(fmtDate(t.planned_at))}</span>`);
  if (t.due_at) meta.push(`<span class="meta-due ${isOverdue(t) ? 'overdue' : ''}">📅 ${esc(fmtDate(t.due_at))}</span>`);
  if (t.flagged) meta.push('<span class="meta-flag">⚑</span>');
  if (t.dropped_at && !t.completed_at) meta.push('<span class="chip">Dropped</span>');
  if (t.notes) meta.push('<span>📝</span>');
  const checkCls = ['check', done && 'done', t.flagged && 'flagged', isOverdue(t) && 'overdue'].filter(Boolean).join(' ');
  return `<li class="row ${done || t.dropped_at ? 'completed' : ''} ${t.parent_id ? 'row-sub' : ''}" data-task="${t.id}">
    <button class="${checkCls}" data-check="${t.id}" aria-label="${done ? 'Mark incomplete' : 'Complete'}">✓</button>
    <div class="row-main"><div class="row-title">${esc(t.title)}</div>${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}</div>
  </li>`;
}

export const taskList = (tasks, opts) => (tasks.length ? `<ul class="list">${tasks.map((t) => taskRow(t, opts)).join('')}</ul>` : '');

export function projectCounts(p) {
  const tasks = db.tasks.filter((t) => t.project_id === p.id && isOpen(t));
  return { open: tasks.length, overdue: tasks.filter(isOverdue).length };
}

export function projectRow(p) {
  const c = projectCounts(p);
  const muted = p.status !== 'active';
  const count = c.overdue ? `<span class="count due">${c.overdue}</span>` : `<span class="count">${c.open || ''}</span>`;
  return `<a class="group-row ${muted ? 'muted' : ''}" href="#project/${p.id}"><span class="dot"></span><span>${esc(p.name)}${p.status === 'active' ? '' : ` (${PROJECT_STATUSES.find(([v]) => v === p.status)[1].toLowerCase()})`}</span>${count}</a>`;
}
