// Review: step through projects that are due for review (the GTD Weekly Review).
// Each project shows its properties inline, health hints with one-tap fixes, and its
// actions. "Mark Reviewed" sets last_reviewed_at; the database derives next_review_at.
import { sb, db, app, esc, byId, run, isOpen, taskSort, projectTagsFor, tagLabel, PROJECT_STATUSES, onHoldTagFor } from '../state.js';
import { fmtDate, startOfToday, addDays, isDeferred } from '../dates.js';
import { treeList } from '../rows.js';
import { flattenTree } from '../tree.js';
import { PROJECT_KINDS, nextAction } from '../availability.js';

export const REVIEW_INTERVALS = [[1, 'Daily'], [7, 'Weekly'], [14, 'Every 2 weeks'], [30, 'Monthly'], [90, 'Quarterly'], [180, 'Every 6 months'], [365, 'Yearly']];

const isReviewable = (p) => p.status === 'active' || p.status === 'on_hold';
export const isDueForReview = (p) => isReviewable(p) && p.next_review_at && new Date(p.next_review_at) <= new Date();
export const reviewDueCount = () => db.projects.filter(isDueForReview).length;

// The queue is snapshotted when a review session starts so it doesn't reshuffle as you mark projects.
export function reviewQueue() {
  const due = db.projects.filter(isDueForReview).sort((a, b) => new Date(a.next_review_at) - new Date(b.next_review_at));
  if (!app.review || !app.review.ids.length || app.review.ids.every((id) => !byId(db.projects, id))) {
    app.review = { ids: due.map((p) => p.id), reviewed: [] };
  }
  // Add projects that became due mid-session at the end.
  due.forEach((p) => { if (!app.review.ids.includes(p.id)) app.review.ids.push(p.id); });
  return app.review;
}

// Projects still to review this session. Once queued, a project stays until it's marked
// reviewed (or completed/dropped), even if an edit such as a longer interval makes it
// not-yet-due, so nothing silently falls out of the review mid-session.
export function remainingIds() {
  const q = reviewQueue();
  return q.ids.filter((id) => {
    const p = byId(db.projects, id);
    return p && !q.reviewed.includes(id) && (isReviewable(p) || id === q.current);
  });
}

// Last completion per project, fetched lazily (older completions aren't loaded locally).
function lastCompleted(projectId) {
  app.reviewStats = app.reviewStats || {};
  if (projectId in app.reviewStats) return app.reviewStats[projectId];
  app.reviewStats[projectId] = undefined;
  run(sb.from('tasks').select('completed_at').eq('project_id', projectId).not('completed_at', 'is', null).order('completed_at', { ascending: false }).limit(1))
    .then((rows) => { app.reviewStats[projectId] = rows[0] ? rows[0].completed_at : null; app.render(); })
    .catch(() => { delete app.reviewStats[projectId]; });
  return undefined;
}

// Health hints: what a reviewer should notice, each with a one-tap fix.
export function healthHints(p) {
  const open = db.tasks.filter((t) => t.project_id === p.id && isOpen(t));
  const hints = [];
  const today = startOfToday();
  if (p.status === 'active' && !open.length) {
    hints.push({ level: 'warn', text: 'No actions left. Is this project done?', fixes: [['complete', 'Complete project'], ['add', 'Add an action'], ['drop', 'Drop']] });
  } else if (p.status === 'active' && !nextAction(p)) {
    const held = open.filter((t) => onHoldTagFor(t));
    const heldTag = held.length === open.length && held.length ? onHoldTagFor(held[0]) : null;
    hints.push({ level: 'warn', text: heldTag ? `Every action is on hold (tag “${heldTag.name}”), so nothing is available now.` : open.every(isDeferred) ? 'Every action is deferred, so nothing is available now.' : 'No available next action.', fixes: heldTag ? [['hold', 'Put project on hold'], ['add', 'Add a next action']] : [['add', 'Add a next action']] });
  }
  const overdue = open.filter((t) => t.due_at && new Date(t.due_at) < today).length;
  if (overdue) hints.push({ level: 'bad', text: `${overdue} overdue`, fixes: [['forecast', 'Triage in Forecast']] });
  const stalePlans = open.filter((t) => t.planned_at && new Date(t.planned_at) < today).length;
  if (stalePlans) hints.push({ level: 'warn', text: `${stalePlans} planned date${stalePlans === 1 ? '' : 's'} slipped`, fixes: [['replan', 'Move to today']] });
  const last = lastCompleted(p.id);
  if (p.status === 'active' && last !== undefined && open.length) {
    const days = last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
    if (days === null || days >= 30) hints.push({ level: 'warn', text: days === null ? 'Nothing has ever been completed here.' : `Nothing completed in ${days} days.`, fixes: [['hold', 'Put on hold'], ['drop', 'Drop']] });
  }
  if (p.status === 'on_hold' && p.updated_at && new Date(p.updated_at) < addDays(today, -90)) {
    hints.push({ level: 'warn', text: 'On hold for 3+ months.', fixes: [['activate', 'Reactivate'], ['drop', 'Drop']] });
  }
  return hints;
}

// "Done looks like…", or a nudge to write it (the Natural Planning Model's outcome).
export const outcomeLine = (p) => (String(p.outcome || '').trim() ? `<p class="outcome-line">🎯 <span class="hint">Done looks like</span> ${esc(p.outcome)}</p>` : p.status === 'active' ? `<p class="outcome-line missing"><button class="link-btn" data-edit-project="${p.id}">🎯 What does done look like?</button></p>` : '');

// Why (purpose) and principles, from Plan it.
export const whyBox = (p) => {
  const lines = String(p.principles || '').split('\n').filter((l) => l.trim());
  if (!String(p.purpose || '').trim() && !lines.length) return '';
  return `<div class="plan-why">${p.purpose ? `<p><span class="hint">Why</span> ${esc(p.purpose)}</p>` : ''}${lines.length ? `<p class="plan-principles">${lines.map((l) => `<span class="chip">${esc(l)}</span>`).join('')}</p>` : ''}</div>`;
};

// Back to the Weekly Review when this is its Projects step.
const weeklyBack = (always = true) => ((db.weeklyReviews || []).some((r) => !r.completed_at && !r.abandoned_at) ? '<a class="back" href="#weekly/projects">‹ Weekly Review</a>' : always ? '<a class="back" href="#weekly">‹ Weekly Review</a>' : '');

export function viewReview(which) {
  const q = reviewQueue();
  if (which && q.ids.includes(which) && !q.reviewed.includes(which)) q.current = which;
  const remaining = remainingIds();
  if (!remaining.length) {
    const n = q.reviewed.length;
    const nextDue = db.projects.filter(isReviewable).sort((a, b) => new Date(a.next_review_at) - new Date(b.next_review_at))[0];
    return `${weeklyBack()}<div class="view-head"><h1 class="review">Review</h1></div>
      <div class="review-done"><p class="review-big">✓ All caught up</p>
      <p class="view-sub">${n ? `You reviewed ${n} project${n === 1 ? '' : 's'} this session.` : 'No projects are due for review.'}
      ${nextDue ? ` Next up: <a href="#project/${nextDue.id}">${esc(nextDue.name)}</a> ${esc(fmtDate(nextDue.next_review_at))}.` : ''}</p></div>`;
  }
  const idx = Math.max(0, remaining.indexOf(which) === -1 ? 0 : remaining.indexOf(which));
  const p = byId(db.projects, remaining[idx]);
  app.review.current = p.id;
  const folder = p.folder_id && byId(db.folders, p.folder_id);
  const tasks = db.tasks.filter((t) => t.project_id === p.id && (isOpen(t) || (t.completed_at && new Date(t.completed_at) > addDays(new Date(), -1)))).sort(taskSort);
  const entries = flattenTree(tasks);
  const hints = healthHints(p);
  const interval = REVIEW_INTERVALS.find(([d]) => d === p.review_every_days) ? p.review_every_days : 'custom';

  return `${weeklyBack(false)}<div class="review-bar">
      <h1 class="review">Review</h1>
      <span class="review-count">Project ${idx + 1} of ${remaining.length}</span>
      <span class="review-nav">
        <button class="icon-btn" data-review-go="${remaining[idx - 1] || ''}" ${idx === 0 ? 'disabled' : ''} aria-label="Previous project" title="Previous (k)">‹</button>
        <button class="icon-btn" data-review-go="${remaining[idx + 1] || ''}" ${idx === remaining.length - 1 ? 'disabled' : ''} aria-label="Next project" title="Next (j)">›</button>
      </span>
      <button class="btn primary" data-mark-reviewed="${p.id}" title="Mark reviewed (m)">Mark Reviewed</button>
    </div>
    <p class="view-sub">${folder ? `📁 ${esc(folder.name)} · ` : ''}${p.last_reviewed_at ? `Last reviewed ${esc(fmtDate(p.last_reviewed_at))}` : 'Never reviewed'} · due ${esc(fmtDate(p.next_review_at))}</p>
    <div class="view-head"><h2 class="review-title"><a href="#project/${p.id}">${p.flagged ? '<span class="meta-flag">⚑</span> ' : ''}${esc(p.name)}</a></h2>
      <button class="btn small" data-edit-project="${p.id}">Edit</button></div>
    ${outcomeLine(p)}
    ${whyBox(p)}
    ${hints.length ? `<ul class="hints">${hints.map((h) => `<li class="hint-${h.level}"><span>${esc(h.text)}</span>
      <span class="hint-fixes">${h.fixes.map(([act, label]) => `<button class="btn small" data-review-fix="${act}" data-project="${p.id}">${label}</button>`).join('')}</span></li>`).join('')}</ul>` : '<p class="hints-ok">✓ Looks healthy: it has a next action and nothing is overdue.</p>'}
    <div class="review-props">
      <label>Status<select data-project-status="${p.id}">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Type<select data-review-kind="${p.id}">${PROJECT_KINDS.map(([v, l]) => `<option value="${v}" ${p.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Review<select data-review-interval="${p.id}">${REVIEW_INTERVALS.map(([d, l]) => `<option value="${d}" ${interval === d ? 'selected' : ''}>${l}</option>`).join('')}${interval === 'custom' ? `<option value="${p.review_every_days}" selected>Every ${p.review_every_days} days</option>` : ''}</select></label>
      <button class="flag-btn ${p.flagged ? 'on' : ''}" data-flag-project="${p.id}" aria-pressed="${!!p.flagged}" title="${p.flagged ? 'Unflag project' : 'Flag project'}">⚑</button>
      ${projectTagsFor(p.id).map((tg) => `<a class="chip" href="#tag/${tg.id}">🏷️ ${esc(tagLabel(tg))}</a>`).join('')}
    </div>
    <label class="review-notes">Notes<textarea data-review-notes="${p.id}" placeholder="Purpose, what done looks like…">${esc(p.notes)}</textarea></label>
    <form class="capture" data-capture data-project="${p.id}"><input type="text" name="title" id="review-capture" placeholder="Add an action to ${esc(p.name)}…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${treeList(entries, { showProject: false, markNext: p.status === 'active' ? nextAction(p) : null }) || '<p class="empty">No actions.</p>'}`;
}
