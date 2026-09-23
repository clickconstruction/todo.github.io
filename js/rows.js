// List row renderers shared by the views.
import { db, esc, byId, tagsFor, tagLabel, projectTagsFor, isOpen, isCollapsed, PROJECT_STATUSES } from './state.js';
import { fmtMinutes } from './components.js';
import { fmtDate, isOverdue, isDeferred, isPlannedPast } from './dates.js';
import { isSequenceBlocked, nextAction } from './availability.js';
import { placeFor, isInside } from './places.js';
import { describe } from './repeat.js';
import { distanceM, fmtDistance } from './geo.js';
import { app } from './state.js';

export function taskRow(t, { showProject = true, markNext = null, reorder = false, hierarchy = false, hasGroups = false, showPlace = true } = {}) {
  const done = !!t.completed_at;
  const project = t.project_id && byId(db.projects, t.project_id);
  const tags = tagsFor(t.id);
  const meta = [];
  if (showProject && project) meta.push(`<span>🗂️ ${esc(project.name)}</span>`);
  tags.forEach((tag) => meta.push(`<span class="chip">${esc(tagLabel(tag))}</span>`));
  if (t.defer_at && isDeferred(t)) meta.push(`<span>⏸ ${esc(fmtDate(t.defer_at))}</span>`);
  if (t.planned_at && isOpen(t)) meta.push(`<span class="meta-planned ${isPlannedPast(t) ? 'past' : ''}" title="Planned">🗓 ${esc(fmtDate(t.planned_at))}</span>`);
  if (t.due_at) meta.push(`<span class="meta-due ${isOverdue(t) ? 'overdue' : ''}">📅 ${esc(fmtDate(t.due_at))}</span>`);
  const loc = showPlace && isOpen(t) && placeFor(t);
  if (loc) {
    const d = app.here ? fmtDistance(distanceM(app.here, loc.place)) : '';
    meta.push(`<span class="meta-place ${isInside(loc) ? 'here' : ''}" title="${esc(loc.via ? `${loc.place.name} (via ${loc.via.kind} ${loc.via.label})` : loc.place.name)}">📍 ${esc(loc.place.name)}${d ? ` · ${d}` : ''}</span>`);
  }
  const bells = isOpen(t) ? db.notifications.filter((n) => n.task_id === t.id && !n.sent_at).length : 0;
  if (bells) meta.push(`<span class="meta-bell" title="${bells} notification${bells === 1 ? '' : 's'}">🔔</span>`);
  if (t.repeat_rule && isOpen(t)) meta.push(`<span class="meta-repeat" title="${esc(describe(t.repeat_rule))}">🔁</span>`);
  if (t.estimate_minutes) meta.push(`<span class="meta-estimate" title="Estimate">⏱ ${fmtMinutes(t.estimate_minutes)}</span>`);
  if (t.dropped_at && !t.completed_at) meta.push('<span class="chip">Dropped</span>');
  if (markNext && markNext.id === t.id) meta.unshift('<span class="chip next">Next</span>');
  const kids = hierarchy && !t.parent_id ? db.tasks.filter((c) => c.parent_id === t.id) : [];
  const openKids = kids.filter(isOpen).length;
  if (kids.length) meta.unshift(`<span class="chip group-count">${openKids ? `${openKids} of ${kids.length} left` : `${kids.length} done`}</span>`);
  const checkCls = ['check', done && 'done', t.flagged && 'flagged', isOverdue(t) && 'overdue'].filter(Boolean).join(' ');
  const blocked = isOpen(t) && isSequenceBlocked(t);
  const cls = [done || t.dropped_at ? 'completed' : '', t.parent_id ? 'row-sub' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
  const handles = reorder && isOpen(t) ? `<span class="reorder"><button class="icon-btn" data-move="${t.id}" data-dir="-1" aria-label="Move up">▲</button><button class="icon-btn" data-move="${t.id}" data-dir="1" aria-label="Move down">▼</button></span>` : '';
  const toggle = kids.length
    ? `<button class="disclosure" data-toggle-group="${t.id}" aria-expanded="${!isCollapsed(t.id)}" aria-label="${isCollapsed(t.id) ? 'Expand' : 'Collapse'} group">${isCollapsed(t.id) ? '▸' : '▾'}</button>`
    : hierarchy && hasGroups && !t.parent_id ? '<span class="disclosure-spacer"></span>' : '';
  const addSub = kids.length && isOpen(t) ? `<button class="icon-btn add-sub" data-add-sub="${t.id}" aria-label="Add sub-action to ${esc(t.title)}" title="Add sub-action">＋</button>` : '';
  return `<li class="row ${cls} ${kids.length ? 'group' : ''}" data-task="${t.id}">
    ${toggle}<button class="${checkCls}" data-check="${t.id}" aria-label="${done ? 'Mark incomplete' : 'Complete'}">✓</button>
    <div class="row-main"><div class="row-title">${esc(t.title)}</div>${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}</div>
    <span class="row-signals">${t.notes ? '<span class="sig-note" title="Has notes" aria-label="Has notes">📝</span>' : ''}
      ${isOpen(t) ? `<button class="flag-btn ${t.flagged ? 'on' : ''}" data-flag="${t.id}" aria-pressed="${!!t.flagged}" aria-label="${t.flagged ? 'Unflag' : 'Flag'}" title="${t.flagged ? 'Unflag' : 'Flag'}">⚑</button>` : ''}</span>
    ${handles}${reorder ? '' : addSub}
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
  const next = p.status === 'active' ? nextAction(p) : null;
  const kindIcon = { sequential: '⇣', single_actions: '☰' }[p.kind] || '';
  const dates = [
    p.defer_at && isDeferred(p) ? `<span>⏸ ${esc(fmtDate(p.defer_at))}</span>` : '',
    p.planned_at && p.status === 'active' ? `<span class="meta-planned ${isPlannedPast(p) ? 'past' : ''}">🗓 ${esc(fmtDate(p.planned_at))}</span>` : '',
    p.due_at && ['active', 'on_hold'].includes(p.status) ? `<span class="meta-due ${isOverdue(p) ? 'overdue' : ''}">📅 ${esc(fmtDate(p.due_at))}</span>` : '',
    p.estimate_minutes ? `<span class="meta-estimate">⏱ ${fmtMinutes(p.estimate_minutes)}</span>` : '',
    p.repeat_rule ? `<span class="meta-repeat" title="${esc(describe(p.repeat_rule))}">🔁</span>` : '',
  ].filter(Boolean).join('');
  return `<a class="group-row ${muted ? 'muted' : ''}" href="#project/${p.id}"><span class="dot"></span>
    <span class="group-main"><span>${p.flagged ? '<span class="meta-flag" title="Flagged">⚑</span> ' : ''}${esc(p.name)}${kindIcon ? ` <span class="kind-icon" title="${p.kind.replace('_', ' ')}">${kindIcon}</span>` : ''}${p.status === 'active' ? '' : ` (${PROJECT_STATUSES.find(([v]) => v === p.status)[1].toLowerCase()})`}</span>
    ${projectTagsFor(p.id).length ? `<span class="group-tags">${projectTagsFor(p.id).map((tg) => `<span class="chip">${esc(tagLabel(tg))}</span>`).join('')}</span>` : ''}
    ${dates ? `<span class="group-sub row-meta">${dates}</span>` : ''}
    ${next ? `<span class="group-sub">Next: ${esc(next.title)}</span>` : p.status === 'active' && c.open ? `<span class="group-sub">${isDeferred(p) ? 'Deferred' : 'No available action'}</span>` : ''}</span>${count}</a>`;
}
