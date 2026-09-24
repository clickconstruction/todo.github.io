// Full Review queue (pure; shared by the app and the MCP server). A flat list would be 8,000 cards, so:
//   1. anything that looks consequential comes first, one card each: flagged, dated, has a gain, or its
//      words suggest it matters (estate, insurance, taxes, health, legal, family…), however old
//   2. then big clusters as one group card each (a project with GROUP_MIN+ open actions left)
//   3. then the rest, one card each, project by project
// Only open "leaf" actions (not groups of steps, not already in Someday) are reviewed.
export const GROUP_MIN = 12;
const IMPORTANT = /\b(end[- ]of[- ]life|estate|last will|my will|a will|living trust|family trust|funeral|burial|beneficiar\w*|power of attorney|insurance|tax(es)?|irs|health|doctor|dentist|medical|surgery|prescription|legal|lawyer|attorney|lawsuit|court|contract|passport|licen[cs]e|registration|mortgage|loan|debt|bank|retirement|401k|ira|pension|social security|kids?|children|daughter|son|wife|husband|deadline|renew\w*|expir\w*|password|backup)\b/i;

const open = (t) => !t.completed_at && !t.dropped_at;
const touched = (t) => Math.max(Date.parse(t.updated_at || 0) || 0, Date.parse(t.created_at || 0) || 0);

// Why a card was pulled forward (or '' if it wasn't).
export function priorityReason(t, project) {
  if (t.flagged || (project && project.flagged)) return 'flagged';
  if (t.due_at) return 'has a due date';
  if (t.planned_at) return 'planned';
  if (t.gain) return 'has a gain';
  const m = `${t.title || ''} ${t.notes || ''}`.match(IMPORTANT);
  return m ? `mentions “${m[0].toLowerCase()}”` : '';
}

// scope: { import_id } | { project_id } | { all: true }, optionally { min_age_days }
export function reviewCandidates({ tasks = [], projects = [], tags = [], taskTags = [], scope = {}, now = Date.now() }) {
  const someday = tags.find((g) => !g.parent_id && /^someday/i.test(g.name));
  const parked = new Set(someday ? taskTags.filter((x) => x.tag_id === someday.id).map((x) => x.task_id) : []);
  const hasKids = new Set(tasks.filter((t) => t.parent_id && open(t)).map((t) => t.parent_id));
  const minAge = Number(scope.min_age_days) || 0;
  return tasks.filter((t) => open(t) && !hasKids.has(t.id) && !parked.has(t.id)
    && (scope.import_id ? t.import_id === scope.import_id : scope.project_id ? t.project_id === scope.project_id : true)
    && (!minAge || (now - touched(t)) / 86400000 >= minAge));
}

// → [{ kind: 'task', task_id, priority, sort } | { kind: 'group', grp: { label, key, task_ids, proposal }, sort }]
export function buildQueue(data) {
  const { projects = [], groupMin = GROUP_MIN } = data;
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const list = reviewCandidates(data);
  const prio = []; const rest = [];
  list.forEach((t) => (priorityReason(t, byProject.get(t.project_id)) ? prio : rest).push(t));
  const rank = (t) => (t.flagged ? 0 : t.due_at ? 1 : t.planned_at ? 2 : t.gain ? 3 : 4);
  prio.sort((a, b) => rank(a) - rank(b) || String(a.due_at || '').localeCompare(String(b.due_at || '')) || touched(b) - touched(a));
  const clusters = new Map();
  rest.forEach((t) => { const k = t.project_id || ''; if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(t); });
  const groups = []; const singles = [];
  clusters.forEach((ts, k) => {
    if (k && ts.length >= groupMin) groups.push({ label: `${(byProject.get(k) || {}).name || 'Project'}`, key: `project:${k}`, project_id: k, task_ids: ts.sort((a, b) => touched(b) - touched(a)).map((t) => t.id), proposal: { op: 'someday' } });
    else singles.push(...ts);
  });
  groups.sort((a, b) => b.task_ids.length - a.task_ids.length);
  const pname = (t) => ((byProject.get(t.project_id) || {}).name || '~');
  singles.sort((a, b) => pname(a).localeCompare(pname(b)) || touched(b) - touched(a));
  let sort = 0;
  return [
    ...prio.map((t) => ({ kind: 'task', task_id: t.id, priority: true, sort: ++sort })),
    ...groups.map((g) => ({ kind: 'group', grp: g, priority: false, sort: ++sort })),
    ...singles.map((t) => ({ kind: 'task', task_id: t.id, priority: false, sort: ++sort })),
  ];
}

// What a group card's proposal does, in words.
export function proposalText(p = {}, n = 0) {
  if (p.op === 'drop') return `Drop all ${n}`;
  if (p.op === 'park') return 'Put the project on hold';
  if (p.op === 'keep_newest') return `Keep the ${p.keep ?? 20} newest; the rest → Someday`;
  return `All ${n} → Someday`;
}
