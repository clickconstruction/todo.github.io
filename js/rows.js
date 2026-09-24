// List row renderers shared by the views.
import { db, esc, byId, tagsFor, tagLabel, projectTagsFor, isOpen, isCollapsed, PROJECT_STATUSES, tagStatus, onHoldTagFor } from './state.js';
import { fmtMinutes } from './components.js';
import { fmtDate, isOverdue, isDeferred, isPlannedPast } from './dates.js';
import { isSequenceBlocked, nextAction } from './availability.js';
import { placeFor, isInside } from './places.js';
import { describe } from './repeat.js';
import { distanceM, fmtDistance } from './geo.js';
import { app } from './state.js';
import { waitingPerson, agendaPerson, followUpDue, ENERGY_ICON, returnedFromTickler, isTickled } from './gtd.js';
import { progress, nextStep, ancestors, rootOf, depthOf, heightOf, MAX_DEPTH } from './tree.js';

// Meta icons are small and monochrome: the words carry the meaning, the icon only helps scanning.
const ic = (e, sp = ' ') => `<i class="mi" aria-hidden="true">${e}</i>${sp}`;

export function taskRow(t, { showProject = true, markNext = null, reorder = false, hierarchy = false, hasGroups = false, showPlace = true, depth = 0, extra = '' } = {}) {
  const done = !!t.completed_at;
  const project = t.project_id && byId(db.projects, t.project_id);
  const tags = tagsFor(t.id);
  const meta = [];
  if (showProject && project) meta.push(`<span>${ic('🗂️')}${esc(project.name)}</span>`);
  // A step shown outside its tree (Flagged, Forecast, Nearby, search…) keeps its context.
  if (!hierarchy && t.parent_id) {
    const up = ancestors(t);
    if (up.length) meta.unshift(`<span class="meta-parent" title="${esc(up.map((a) => a.title).reverse().join(' › '))}">↳ ${esc(up[0].title)}</span>`);
  }
  tags.forEach((tag) => meta.push(tagStatus(tag) === 'on_hold' ? `<span class="chip hold" title="On hold: not available">⏸ ${esc(tagLabel(tag))}</span>` : `<span class="chip">${esc(tagLabel(tag))}</span>`));
  if (isOpen(t)) {
    const wp = (t.waiting_on || (db.people || []).some((p) => p.tag_id)) && waitingPerson(t);
    if (wp && !t.agenda_for) meta.push(`<span class="meta-wait ${followUpDue(t) ? 'late' : ''}" title="Waiting on ${esc(wp.name)}">${ic('⏳')}${esc(wp.name)}${t.follow_up_at ? ` · follow up ${esc(fmtDate(t.follow_up_at))}` : ''}</span>`);
    const ap = t.agenda_for && agendaPerson(t);
    if (ap) meta.push(`<span class="meta-agenda" title="To discuss with ${esc(ap.name)}">${ic('🗣')}${esc(ap.name)}</span>`);
    if (t.tickler && isTickled(t)) meta.push(`<span class="meta-tickler" title="In the tickler">${ic('📆')}${esc(fmtDate(t.defer_at))}</span>`);
    else if (returnedFromTickler(t)) meta.push(`<span class="meta-tickler">${ic('📆')}from the tickler</span>`);
  }
  if (t.defer_at && isDeferred(t) && !t.tickler) meta.push(`<span>${ic('⏸')}${esc(fmtDate(t.defer_at))}</span>`);
  if (t.planned_at && isOpen(t)) meta.push(`<span class="meta-planned ${isPlannedPast(t) ? 'past' : ''}" title="Planned">${ic('🗓')}${esc(fmtDate(t.planned_at))}</span>`);
  if (t.due_at) meta.push(`<span class="meta-due ${isOverdue(t) ? 'overdue' : ''}">${ic('📅')}${esc(fmtDate(t.due_at))}</span>`);
  const loc = showPlace && isOpen(t) && placeFor(t);
  if (loc) {
    const d = app.here ? fmtDistance(distanceM(app.here, loc.place)) : '';
    meta.push(`<span class="meta-place ${isInside(loc) ? 'here' : ''}" title="${esc(loc.via ? `${loc.place.name} (via ${loc.via.kind} ${loc.via.label})` : loc.place.name)}">${ic('📍')}${esc(loc.place.name)}${d ? ` · ${d}` : ''}</span>`);
  }
  const bells = isOpen(t) ? db.notifications.filter((n) => n.task_id === t.id && !n.sent_at).length : 0;
  const clips = db.attachments.filter((a) => a.task_id === t.id && !a.archived_at).length;
  if (clips) meta.push(`<span class="meta-clip" title="${clips} attachment${clips === 1 ? '' : 's'}">${ic('📎', '')}${clips > 1 ? clips : ''}</span>`);
  if (bells) meta.push(`<span class="meta-bell" title="${bells} notification${bells === 1 ? '' : 's'}">${ic('🔔', '')}</span>`);
  if (t.repeat_rule && isOpen(t)) meta.push(`<span class="meta-repeat" title="${esc(describe(t.repeat_rule))}">${ic('🔁', '')}</span>`);
  if (t.scheduled_at && isOpen(t)) { const d = new Date(t.scheduled_at); const today = new Date().toDateString() === d.toDateString(); meta.push(`<span class="meta-sched" title="Scheduled">${ic('⏰')}${esc(today ? '' : `${d.toLocaleDateString(undefined, { weekday: 'short' })} `)}${esc(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span>`); }
  const ck = t.checklist_id && isOpen(t) && (db.checklists || []).find((c) => c.id === t.checklist_id);
  if (ck) { const r = (db.checklistRuns || []).find((x) => x.checklist_id === ck.id && x.task_id === t.id && !x.finished_at); meta.push(`<span class="meta-ck" title="Checklist: ${esc(ck.name)}">${ic('☑')}${r ? (r.ticked || []).length : 0}/${ck.items.length}</span>`); }
  if (t.energy && isOpen(t)) meta.push(`<span class="meta-energy" title="${esc(t.energy)} energy">${ENERGY_ICON[t.energy] || ''}</span>`);
  if (t.estimate_minutes) meta.push(`<span class="meta-estimate" title="Estimate">${ic('⏱')}${fmtMinutes(t.estimate_minutes)}</span>`);
  if (t.dropped_at && !t.completed_at) meta.push('<span class="chip">Dropped</span>');
  // "Next": the project's next action, or the step you're on inside a do-in-order task.
  const parentTask = t.parent_id && byId(db.tasks, t.parent_id);
  const nextInOrder = hierarchy && parentTask && parentTask.steps_in_order && isOpen(t) && !isSequenceBlocked(t) && !db.tasks.some((c) => c.parent_id === t.id && isOpen(c));
  if ((markNext && markNext.id === t.id) || nextInOrder) meta.unshift('<span class="chip next">Next</span>');
  const kids = db.tasks.filter((c) => c.parent_id === t.id);
  const collapsed = isCollapsed(t.id);
  let prog = '';
  if (kids.length) {
    const p = progress(t);
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    meta.unshift(`<span class="chip group-count">${p.done} of ${p.total} done</span>${t.steps_in_order ? '<span class="chip">in order</span>' : ''}`);
    const next = isOpen(t) && (collapsed || !hierarchy) ? nextStep(t) : null;
    prog = `<div class="step-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.done}" aria-label="${p.done} of ${p.total} steps done"><i style="width:${pct}%"></i></div>
      ${next ? `<div class="step-next"><span>Next:</span> ${esc(next.title)}</div>` : ''}`;
  }
  const checkCls = ['check', done && 'done', t.flagged && 'flagged', isOverdue(t) && 'overdue'].filter(Boolean).join(' ');
  const held = isOpen(t) && onHoldTagFor(t);
  if (held && !tags.some((g) => g.id === held.id)) meta.push(`<span class="chip hold" title="On hold via ${esc(tagLabel(held))}">⏸ ${esc(tagLabel(held))}</span>`);
  const blocked = isOpen(t) && (isSequenceBlocked(t) || !!held);
  const cls = [done || t.dropped_at ? 'completed' : '', hierarchy && depth ? 'row-sub' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
  // Reorder mode: ▲▼ move among siblings; ⇥ makes it a step of the item above, ⇤ moves it up a level.
  const handles = reorder && isOpen(t) ? `<span class="reorder">
      <button class="icon-btn" data-move="${t.id}" data-dir="-1" aria-label="Move up">▲</button><button class="icon-btn" data-move="${t.id}" data-dir="1" aria-label="Move down">▼</button>
      <button class="icon-btn" data-indent="${t.id}" aria-label="Make a step of the item above" title="Make a step of the item above" ${depthOf(t) + heightOf(t) >= MAX_DEPTH ? 'disabled' : ''}>⇥</button>
      <button class="icon-btn" data-outdent="${t.id}" aria-label="Move up a level" title="Move up a level" ${t.parent_id ? '' : 'disabled'}>⇤</button></span>` : '';
  const toggle = hierarchy && kids.length
    ? `<button class="disclosure" data-toggle-group="${t.id}" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Show' : 'Hide'} steps">${collapsed ? '▸' : '▾'}</button>`
    : hierarchy && hasGroups ? '<span class="disclosure-spacer"></span>' : '';
  const addSub = kids.length && isOpen(t) ? `<button class="icon-btn add-sub" data-add-sub="${t.id}" aria-label="Add a step to ${esc(t.title)}" title="Add a step">＋</button>` : '';
  return `<li class="row ${cls} ${kids.length ? 'group' : ''}" data-task="${t.id}" style="--depth:${hierarchy ? depth : 0}">
    ${toggle}<button class="${checkCls}" data-check="${t.id}" aria-label="${done ? 'Mark incomplete' : 'Complete'}">✓</button>
    <div class="row-main"><div class="row-title">${esc(t.title)}</div>${t.gain && !done ? `<div class="row-gain">→ ${esc(t.gain)}${t.gain_by === 'agent' ? ' <span class="chip sug">Claude suggested</span>' : ''}</div>` : ''}${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}${prog}</div>
    <span class="row-signals">${t.notes ? '<span class="sig-note" title="Has notes" aria-label="Has notes">📝</span>' : ''}
      ${isOpen(t) ? `<button class="flag-btn ${t.flagged ? 'on' : ''}" data-flag="${t.id}" aria-pressed="${!!t.flagged}" aria-label="${t.flagged ? 'Unflag' : 'Flag'}" title="${t.flagged ? 'Unflag' : 'Flag'}">⚑</button>` : ''}</span>
    ${handles}${reorder ? '' : addSub}${extra}
  </li>`;
}

export const taskList = (tasks, opts) => (tasks.length ? `<ul class="list">${tasks.map((t) => taskRow(t, opts)).join('')}</ul>` : '');

// A list shown as a tree: each task followed by its steps (unless collapsed), indented by level.
export function treeList(entries, opts = {}) {
  if (!entries.length) return '';
  const hasGroups = entries.some(({ t }) => db.tasks.some((c) => c.parent_id === t.id));
  return `<ul class="list">${entries.map(({ t, depth }) => taskRow(t, { ...opts, hierarchy: true, hasGroups, depth })).join('')}</ul>`;
}

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
