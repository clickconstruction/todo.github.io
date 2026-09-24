// Settle in: what an import brought, grouped so it can be sorted in bulk. Pure (shared by the app and
// the MCP server). Only rows of that import are looked at; everything is ids for settle_apply().
const DAY = 86400000;
export const OLD_BUCKETS = [['4y', '4+ years old', 4 * 365, Infinity], ['2y', '2–4 years', 2 * 365, 4 * 365], ['1y', '1–2 years', 365, 2 * 365]];
export const BIG_PROJECT = 100;

export const STEPS = [
  ['inbox', 'Inbox', 'Clarify what was in the OmniFocus Inbox.'],
  ['old', 'Old and undated', 'No dates, not touched in a year or more. Someday keeps them out of your lists; nothing is lost.'],
  ['big', 'Big projects', 'Projects with 100+ open actions: decide the whole thing at once.'],
  ['projects', 'Projects', 'One card each: Active, On hold, Done or Drop.'],
  ['overdue', 'Overdue', 'Real deadlines stay; the rest become plans or lose the date.'],
  ['flagged', 'Flagged', 'Flags only help when there are few. Keep the ones that matter now.'],
  ['reviews', 'Spread reviews', 'Every project arrives due for review; spread them over four weeks.'],
  ['tags', 'Tags', 'Retire tags nothing uses; turn Waiting tags into people.'],
  ['areas', 'Areas from folders', 'Your folders as areas of focus (folders stay as they are).'],
  ['check', 'Check these', 'Repeats that were matched approximately.'],
];

const open = (t) => !t.completed_at && !t.dropped_at;
const touched = (t) => Math.max(Date.parse(t.updated_at || 0) || 0, Date.parse(t.created_at || 0) || 0);

// data: { importId, tasks, projects, tags, taskTags, projectTags, now }
export function settleData({ importId, tasks = [], projects = [], tags = [], taskTags = [], projectTags = [], now = Date.now() }) {
  const mine = tasks.filter((t) => t.import_id === importId && open(t));
  const projs = projects.filter((p) => p.import_id === importId && ['active', 'on_hold'].includes(p.status));
  const projById = new Map(projects.map((p) => [p.id, p]));
  const someday = tags.find((g) => !g.parent_id && /^someday/i.test(g.name));
  const somedayIds = new Set(someday ? [someday.id, ...tags.filter((g) => g.parent_id === someday.id).map((g) => g.id)] : []);
  const parked = new Set(taskTags.filter((x) => somedayIds.has(x.tag_id)).map((x) => x.task_id));
  const hasKids = new Set(mine.filter((t) => t.parent_id).map((t) => t.parent_id));
  const live = (t) => !parked.has(t.id) && (!t.project_id || (projById.get(t.project_id) || {}).status === 'active');

  // Old and undated: leaves (not groups), no dates, not flagged or repeating, not parked, untouched for 1y+.
  const sweepable = mine.filter((t) => !hasKids.has(t.id) && !t.in_inbox && !t.flagged && !t.repeat_rule && !t.due_at && !t.defer_at && !t.planned_at && !t.scheduled_at && !parked.has(t.id));
  const old = OLD_BUCKETS.map(([key, label, from, to]) => {
    const list = sweepable.filter((t) => { const age = (now - touched(t)) / DAY; return age >= from && age < to; });
    const byProject = new Map();
    list.forEach((t) => { const k = t.project_id || ''; byProject.set(k, (byProject.get(k) || 0) + 1); });
    const top = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => ({ name: id ? (projById.get(id) || {}).name || 'Project' : 'No project', n }));
    return { key, label, ids: list.map((t) => t.id), top };
  });

  const counts = new Map();
  mine.forEach((t) => { if (t.project_id && !parked.has(t.id)) counts.set(t.project_id, (counts.get(t.project_id) || 0) + 1); });
  const lastTouched = new Map();
  mine.forEach((t) => { if (t.project_id) lastTouched.set(t.project_id, Math.max(lastTouched.get(t.project_id) || 0, touched(t))); });
  const big = projs.filter((p) => p.status === 'active' && (counts.get(p.id) || 0) >= BIG_PROJECT)
    .map((p) => ({ id: p.id, name: p.name, open: counts.get(p.id) || 0, last: lastTouched.get(p.id) || null,
      newest: mine.filter((t) => t.project_id === p.id && !parked.has(t.id) && !hasKids.has(t.id)).sort((a, b) => touched(b) - touched(a)).map((t) => t.id) }))
    .sort((a, b) => b.open - a.open);

  const endToday = new Date(now); endToday.setHours(23, 59, 59, 999);
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const overdue = mine.filter((t) => t.due_at && Date.parse(t.due_at) < startToday.getTime()).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const flagged = mine.filter((t) => t.flagged);
  const openIds = new Set(tasks.filter(open).map((t) => t.id));
  const liveProjIds = new Set(projects.filter((p) => ['active', 'on_hold'].includes(p.status)).map((p) => p.id));
  const usedTags = new Set([...taskTags.filter((x) => openIds.has(x.task_id)).map((x) => x.tag_id), ...projectTags.filter((x) => liveProjIds.has(x.project_id)).map((x) => x.tag_id)]);
  const tagParents = new Set(tags.map((g) => g.parent_id).filter(Boolean));
  const unusedTags = tags.filter((g) => g.import_id === importId && g.status !== 'dropped' && !usedTags.has(g.id) && !tagParents.has(g.id) && !somedayIds.has(g.id));
  const reviewsDue = projs.filter((p) => !p.next_review_at || Date.parse(p.next_review_at) <= now);
  const inexact = mine.filter((t) => t.repeat_rule && /OmniFocus repeat/i.test(t.notes || ''));

  return {
    inbox: mine.filter((t) => t.in_inbox && !t.parent_id).map((t) => t.id),
    old, big, overdue: overdue.map((t) => t.id), flagged: flagged.map((t) => t.id),
    projects: projs.map((p) => p.id), reviewsDue: reviewsDue.map((p) => p.id), unusedTags: unusedTags.map((g) => g.id), inexact: inexact.map((t) => t.id),
    total: mine.length, live: mine.filter(live).length,
  };
}

// Next reviews spread over `days` (default 28), a few per day, in folder order.
export function spreadReviews(projectIds, { now = Date.now(), days = 28 } = {}) {
  const n = projectIds.length;
  return projectIds.map((id, i) => { const d = new Date(now + (1 + Math.floor((i * days) / Math.max(1, n))) * DAY); d.setHours(9, 0, 0, 0); return { id, at: d.toISOString() }; });
}
