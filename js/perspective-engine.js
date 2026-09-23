// Perspectives: saved views built from rules. This file is pure (no DOM, no imports) and is
// shared by the app and the MCP server (mcp/src/index.js), so both always agree on what a
// perspective shows.
//
// rules   = { v: 1, match: 'all' | 'any' | 'none', rules: [rule | group, …] }
// group   = { match: 'all' | 'any' | 'none', rules: [...] }
// rule    = { type: 'flagged' | 'inbox' | 'available' | 'overdue' | 'repeating' | 'has_notes'
//                  | 'has_steps' | 'is_step' | 'untagged' | 'no_project' | 'has_place' | 'has_estimate'
//                  | 'on_hold' (parked by an on-hold tag: its own, its project's or a parent task's) }
//         | { type: 'tag', tags: [id], sub: true }            any of these tags (sub-tags and project tags count)
//         | { type: 'project', projects: [id] }
//         | { type: 'folder', folders: [id] }
//         | { type: 'date', field: 'due'|'planned'|'defer'|'completed'|'added'|'changed',
//             when: 'overdue'|'today'|'next'|'past'|'none'|'any'|'before'|'after', days?: n, date?: 'YYYY-MM-DD' }
//         | { type: 'duration', op: 'max' | 'min', minutes: n }
//         | { type: 'text', contains: 'words' }               every word in the title or notes
// options = { show: 'available'|'remaining'|'completed'|'dropped'|'all',
//             group_by: 'none'|'project'|'folder'|'tag'|'due'|'flagged',
//             sort_by: 'project'|'due'|'planned'|'defer'|'added'|'changed'|'title'|'duration'|'completed',
//             layout: 'tree'|'flat' }

export const RULES_VERSION = 1;
export const DEFAULT_OPTIONS = { show: 'available', group_by: 'project', sort_by: 'project', layout: 'tree' };

export const FLAG_RULES = [
  ['flagged', 'Flagged'], ['available', 'Available now'], ['overdue', 'Overdue'], ['inbox', 'In the Inbox'],
  ['repeating', 'Repeating'], ['has_notes', 'Has notes'], ['has_steps', 'Has steps'], ['is_step', 'Is a step'],
  ['untagged', 'Has no tags'], ['no_project', 'Not in a project'], ['has_place', 'Has a place'], ['has_estimate', 'Has a duration'],
  ['on_hold', 'On hold (tag)'],
];
export const DATE_FIELDS = [['due', 'Due'], ['planned', 'Planned'], ['defer', 'Defer'], ['completed', 'Completed'], ['added', 'Added'], ['changed', 'Changed']];
export const DATE_WHEN = [['overdue', 'is past'], ['today', 'is today'], ['next', 'is within the next'], ['past', 'was in the last'], ['before', 'is before'], ['after', 'is after'], ['any', 'is set'], ['none', 'is not set']];
export const SHOW = [['available', 'Available'], ['remaining', 'Remaining'], ['completed', 'Completed'], ['dropped', 'Dropped'], ['all', 'All']];
export const GROUP_BY = [['project', 'Project'], ['folder', 'Folder'], ['tag', 'Tag'], ['due', 'Due date'], ['flagged', 'Flagged'], ['none', 'Nothing']];
export const SORT_BY = [['project', 'Project order'], ['due', 'Due'], ['planned', 'Planned'], ['defer', 'Defer'], ['added', 'Added (newest)'], ['changed', 'Changed (newest)'], ['completed', 'Completed (newest)'], ['duration', 'Duration (shortest)'], ['title', 'Title']];
const FIELD = { due: 'due_at', planned: 'planned_at', defer: 'defer_at', completed: 'completed_at', added: 'created_at', changed: 'updated_at' };

// ---------- time (in the user's timezone) ----------
function dayKey(value, tz) {
  const d = value instanceof Date ? value : new Date(value);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const addDays = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Is a task parked by an on-hold tag? (its own tags, its project's, or those of the task it's a step
// of; a sub-tag of an on-hold tag is on hold too; dropped tags never hold anything). Shared with the MCP server.
export function makeOnHold(data) {
  const tags = data.tags || [];
  if (!tags.some((g) => g.status === 'on_hold')) return () => false;
  const tagById = new Map(tags.map((g) => [g.id, g]));
  const taskById = new Map((data.tasks || []).map((t) => [t.id, t]));
  const tagsOf = new Map();
  (data.taskTags || []).forEach((l) => { const k = `t:${l.task_id}`; if (!tagsOf.has(k)) tagsOf.set(k, []); tagsOf.get(k).push(l.tag_id); });
  (data.projectTags || []).forEach((l) => { const k = `p:${l.project_id}`; if (!tagsOf.has(k)) tagsOf.set(k, []); tagsOf.get(k).push(l.tag_id); });
  const held = new Map();
  const heldTag = (id) => {
    if (held.has(id)) return held.get(id);
    let h = false;
    for (let g = tagById.get(id), i = 0; g && i < 8; i++) { if (g.status === 'dropped') { h = false; break; } if (g.status === 'on_hold') h = true; g = tagById.get(g.parent_id); }
    held.set(id, h);
    return h;
  };
  return (t) => {
    for (let n = t, i = 0; n && i < 8; i++) {
      if ((tagsOf.get(`t:${n.id}`) || []).some(heldTag) || (n.project_id && (tagsOf.get(`p:${n.project_id}`) || []).some(heldTag))) return true;
      n = n.parent_id && taskById.get(n.parent_id);
    }
    return false;
  };
}

// ---------- context ----------
// data: { tasks, projects, folders, tags, taskTags, projectTags }
// ctx:  { now: Date, tz, available(t) → bool, keep(t) → bool (always include, e.g. just completed) }
function prepare(data, ctx) {
  const now = ctx.now || new Date();
  const tz = ctx.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dayKey(now, tz);
  const taskById = new Map(data.tasks.map((t) => [t.id, t]));
  const projectById = new Map((data.projects || []).map((p) => [p.id, p]));
  const tagsOfTask = new Map();
  (data.taskTags || []).forEach((l) => { if (!tagsOfTask.has(l.task_id)) tagsOfTask.set(l.task_id, []); tagsOfTask.get(l.task_id).push(l.tag_id); });
  const tagsOfProject = new Map();
  (data.projectTags || []).forEach((l) => { if (!tagsOfProject.has(l.project_id)) tagsOfProject.set(l.project_id, []); tagsOfProject.get(l.project_id).push(l.tag_id); });
  const hasKids = new Set(data.tasks.filter((t) => t.parent_id).map((t) => t.parent_id));
  const tagParent = new Map((data.tags || []).map((g) => [g.id, g.parent_id]));
  // Own tags plus the project's tags, each with its parent tags (so "Waiting" matches "Waiting : Hiro").
  const tagSet = (t) => {
    const out = new Set();
    [...(tagsOfTask.get(t.id) || []), ...(t.project_id ? tagsOfProject.get(t.project_id) || [] : [])].forEach((id) => {
      for (let g = id, i = 0; g && i < 6; i++) { out.add(g); g = tagParent.get(g); }
    });
    return out;
  };
  const onHold = makeOnHold(data);
  return { now, tz, today, taskById, projectById, tagsOfTask, tagSet, hasKids, onHold, available: ctx.available || (() => true), keep: ctx.keep || (() => false), warnings: new Set(), data };
}

// ---------- matching ----------
const isOpen = (t) => !t.completed_at && !t.dropped_at;

function matchDate(rule, t, c) {
  const v = t[FIELD[rule.field]];
  if (!FIELD[rule.field]) { c.warnings.add(`Unknown date field “${rule.field}”`); return false; }
  if (rule.when === 'none') return !v;
  if (!v) return false;
  if (rule.when === 'any') return true;
  const key = dayKey(v, c.tz);
  const days = Math.max(0, Number(rule.days) || 0);
  switch (rule.when) {
    case 'overdue': return key < c.today; // before today, like the app's overdue
    case 'today': return key === c.today;
    case 'next': return key >= c.today && key <= addDays(c.today, days || 7);
    case 'past': return key <= c.today && key >= addDays(c.today, -(days || 7));
    case 'before': return !!rule.date && key < rule.date;
    case 'after': return !!rule.date && key > rule.date;
    default: c.warnings.add(`Unknown date condition “${rule.when}”`); return false;
  }
}

function matchRule(rule, t, c) {
  if (!rule || typeof rule !== 'object') return false;
  if (Array.isArray(rule.rules)) return matchGroup(rule, t, c);
  switch (rule.type) {
    case 'flagged': return !!t.flagged || !!(t.project_id && (c.projectById.get(t.project_id) || {}).flagged);
    case 'inbox': return !!t.in_inbox && !t.parent_id;
    case 'available': return c.available(t);
    case 'overdue': return isOpen(t) && !!t.due_at && dayKey(t.due_at, c.tz) < c.today;
    case 'repeating': return !!t.repeat_rule;
    case 'has_notes': return !!(t.notes && t.notes.trim());
    case 'has_steps': return c.hasKids.has(t.id);
    case 'is_step': return !!t.parent_id;
    case 'untagged': return !(c.tagsOfTask.get(t.id) || []).length;
    case 'no_project': return !t.project_id;
    case 'has_place': return !!t.place_id;
    case 'has_estimate': return !!t.estimate_minutes;
    case 'on_hold': return isOpen(t) && c.onHold(t);
    case 'tag': {
      const want = rule.tags || [];
      if (!want.length) { c.warnings.add('Choose a tag for the “Tagged” rule.'); return false; }
      const have = rule.sub === false ? new Set([...(c.tagsOfTask.get(t.id) || []), ...((t.project_id && c.data.projectTags.filter((l) => l.project_id === t.project_id).map((l) => l.tag_id)) || [])]) : c.tagSet(t);
      return want.some((id) => have.has(id));
    }
    case 'project': if (!(rule.projects || []).length) { c.warnings.add('Choose a project for the “In project” rule.'); return false; } return rule.projects.includes(t.project_id);
    case 'folder': {
      const p = t.project_id && c.projectById.get(t.project_id);
      if (!(rule.folders || []).length) { c.warnings.add('Choose a folder for the “In folder” rule.'); return false; } return !!(p && rule.folders.includes(p.folder_id));
    }
    case 'date': return matchDate(rule, t, c);
    case 'duration': {
      const m = Number(rule.minutes) || 0;
      if (!t.estimate_minutes) return false;
      return rule.op === 'min' ? t.estimate_minutes >= m : t.estimate_minutes <= m;
    }
    case 'text': {
      const hay = `${t.title || ''} ${t.notes || ''}`.toLowerCase();
      return String(rule.contains || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
    }
    default:
      c.warnings.add(`This perspective has a rule this version doesn’t understand (“${rule.type}”); it matches nothing.`);
      return false;
  }
}

function matchGroup(group, t, c) {
  const list = (group.rules || []).filter(Boolean);
  if (!list.length) return true;
  if (group.match === 'any') return list.some((r) => matchRule(r, t, c));
  if (group.match === 'none') return !list.some((r) => matchRule(r, t, c));
  return list.every((r) => matchRule(r, t, c));
}

function passesShow(show, t, c) {
  switch (show) {
    case 'remaining': return isOpen(t);
    case 'completed': return !!t.completed_at;
    case 'dropped': return !!t.dropped_at && !t.completed_at;
    case 'all': return true;
    default: return isOpen(t) && c.available(t);
  }
}

// ---------- sorting and grouping ----------
function sorter(by, c) {
  const asc = (f) => (a, b) => ((a[f] || '￿') < (b[f] || '￿') ? -1 : (a[f] || '￿') > (b[f] || '￿') ? 1 : 0);
  const desc = (f) => (a, b) => ((b[f] || '') < (a[f] || '') ? -1 : (b[f] || '') > (a[f] || '') ? 1 : 0);
  // Project order: projects in their order (no project first, like the Inbox), then the tree order.
  const path = (t) => {
    const chain = [];
    for (let n = t, i = 0; n && i < 8; i++) { chain.unshift(String((n.sort || 0) + 1e6).padStart(12, '0') + (n.created_at || '')); n = n.parent_id && c.taskById.get(n.parent_id); }
    const p = t.project_id && c.projectById.get(t.project_id);
    return `${p ? String((p.sort || 0) + 1e6).padStart(12, '0') : '0'}|${chain.join('/')}`;
  };
  const byProject = (a, b) => (path(a) < path(b) ? -1 : path(a) > path(b) ? 1 : 0);
  const cmp = {
    project: byProject, due: asc('due_at'), planned: asc('planned_at'), defer: asc('defer_at'),
    added: desc('created_at'), changed: desc('updated_at'), completed: desc('completed_at'),
    duration: (a, b) => (a.estimate_minutes || 1e9) - (b.estimate_minutes || 1e9),
    title: (a, b) => String(a.title).localeCompare(String(b.title)),
  }[by] || byProject;
  return (a, b) => cmp(a, b) || byProject(a, b);
}

function groupsOf(tasks, by, c) {
  if (!by || by === 'none') return [{ key: 'all', label: '', tasks }];
  const map = new Map();
  const put = (key, label, order, t) => { if (!map.has(key)) map.set(key, { key, label, order, tasks: [] }); map.get(key).tasks.push(t); };
  const tagName = (id) => {
    const parts = [];
    for (let g = id, i = 0; g && i < 6; i++) { const tag = (c.data.tags || []).find((x) => x.id === g); if (!tag) break; parts.unshift(tag.name); g = tag.parent_id; }
    return parts.join(' : ');
  };
  tasks.forEach((t) => {
    if (by === 'project') {
      const p = t.project_id && c.projectById.get(t.project_id);
      put(p ? p.id : '', p ? p.name : 'No project', p ? 1 + (p.sort || 0) : 0, t);
    } else if (by === 'folder') {
      const p = t.project_id && c.projectById.get(t.project_id);
      const f = p && p.folder_id && (c.data.folders || []).find((x) => x.id === p.folder_id);
      put(f ? f.id : '', f ? f.name : 'No folder', f ? 1 + (f.sort || 0) : 1e9, t);
    } else if (by === 'tag') {
      const own = c.tagsOfTask.get(t.id) || [];
      if (!own.length) put('', 'No tags', 1e9, t);
      own.forEach((id) => put(id, tagName(id) || 'Tag', 0, t));
    } else if (by === 'flagged') {
      const f = matchRule({ type: 'flagged' }, t, c);
      put(f ? 'flagged' : 'not', f ? 'Flagged' : 'Not flagged', f ? 0 : 1, t);
    } else if (by === 'due') {
      if (!t.due_at) { put('none', 'No due date', 9, t); return; }
      const k = dayKey(t.due_at, c.tz);
      if (k < c.today) put('overdue', 'Overdue', 0, t);
      else if (k === c.today) put('today', 'Today', 1, t);
      else if (k === addDays(c.today, 1)) put('tomorrow', 'Tomorrow', 2, t);
      else if (k <= addDays(c.today, 7)) put('week', 'Next 7 days', 3, t);
      else put('later', 'Later', 4, t);
    }
  });
  const list = [...map.values()];
  if (by === 'tag') list.sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label));
  else list.sort((a, b) => a.order - b.order);
  return list;
}

// ---------- public ----------
// Returns { tasks (matching, sorted), groups: [{key, label, tasks}], warnings: [..] }.
export function evaluate(perspective, data, ctx = {}) {
  const c = prepare(data, ctx);
  const rules = perspective.rules || { match: 'all', rules: [] };
  const options = { ...DEFAULT_OPTIONS, ...(perspective.options || {}) };
  if ((rules.v || 1) > RULES_VERSION) c.warnings.add('This perspective was made by a newer version; some rules may not apply.');
  const tasks = data.tasks.filter((t) => c.keep(t) || (passesShow(options.show, t, c) && matchGroup(rules, t, c))).sort(sorter(options.sort_by, c));
  return { tasks, groups: groupsOf(tasks, options.group_by, c), options, warnings: [...c.warnings] };
}

// Plain-English summary, e.g. "Available · tagged Phone · 15 min or less".
export function describe(perspective, data = {}) {
  const name = (list, id) => { const x = (list || []).find((y) => y.id === id); return x ? (x.name + (x.archived_at || (x.status && ['completed', 'dropped'].includes(x.status)) ? ' (archived)' : '')) : '(missing)'; };
  const tagLabel = (id) => {
    const parts = [];
    for (let g = id, i = 0; g && i < 6; i++) { const tag = (data.tags || []).find((x) => x.id === g); if (!tag) return '(missing tag)'; parts.unshift(tag.name); g = tag.parent_id; }
    return parts.join(' : ');
  };
  const or = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0] || 'any');
  const one = (r) => {
    if (!r) return '';
    if (Array.isArray(r.rules)) {
      const parts = r.rules.map(one).filter(Boolean);
      if (!parts.length) return '';
      if (r.match === 'any') return parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`;
      if (r.match === 'none') return `not ${parts.length === 1 ? parts[0] : `(${parts.join(' or ')})`}`;
      return parts.join(' · ');
    }
    const flag = FLAG_RULES.find(([k]) => k === r.type);
    if (flag) return flag[1].toLowerCase();
    switch (r.type) {
      case 'tag': return (r.tags || []).length ? `tagged ${or(r.tags.map(tagLabel))}` : 'tagged (choose)';
      case 'project': return (r.projects || []).length ? `in ${or(r.projects.map((id) => name(data.projects, id)))}` : 'in (choose a project)';
      case 'folder': return (r.folders || []).length ? `in folder ${or(r.folders.map((id) => name(data.folders, id)))}` : 'in (choose a folder)';
      case 'duration': return r.op === 'min' ? `${r.minutes} min or more` : `${r.minutes} min or less`;
      case 'text': return `contains “${r.contains || ''}”`;
      case 'date': {
        const f = (DATE_FIELDS.find(([k]) => k === r.field) || [0, r.field])[1].toLowerCase();
        const d = r.days || 7;
        return { overdue: `${f} before today`, today: `${f} today`, next: `${f} within ${d} day${d === 1 ? '' : 's'}`, past: `${f} in the last ${d} day${d === 1 ? '' : 's'}`,
          before: `${f} before ${r.date || '…'}`, after: `${f} after ${r.date || '…'}`, any: `has a ${f} date`, none: `no ${f} date` }[r.when] || f;
      }
      default: return `unknown rule “${r.type}”`;
    }
  };
  const options = { ...DEFAULT_OPTIONS, ...(perspective.options || {}) };
  const show = (SHOW.find(([k]) => k === options.show) || SHOW[0])[1];
  const top = { match: (perspective.rules || {}).match || 'all', rules: (perspective.rules || {}).rules || [] };
  const parts = top.rules.map(one).filter(Boolean);
  const body = !parts.length ? '' : top.match === 'any' ? or(parts) : top.match === 'none' ? `not ${or(parts)}` : parts.join(' · ');
  const out = [show, body].filter(Boolean).join(' · ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// Shape check for rules and options (used before saving, and to answer agents clearly).
export function validate({ rules, options } = {}) {
  const errors = [];
  const types = new Set([...FLAG_RULES.map(([k]) => k), 'tag', 'project', 'folder', 'date', 'duration', 'text']);
  const walk = (r, path, depth) => {
    if (!r || typeof r !== 'object') { errors.push(`${path}: must be an object`); return; }
    if (Array.isArray(r.rules)) {
      if (depth > 4) errors.push(`${path}: groups can nest 4 deep`);
      if (r.match && !['all', 'any', 'none'].includes(r.match)) errors.push(`${path}.match: all, any or none`);
      r.rules.forEach((x, i) => walk(x, `${path}.rules[${i}]`, depth + 1));
      return;
    }
    if (!types.has(r.type)) { errors.push(`${path}.type: unknown “${r.type}”`); return; }
    if (r.type === 'date') {
      if (!FIELD[r.field]) errors.push(`${path}.field: one of ${Object.keys(FIELD).join(', ')}`);
      if (!DATE_WHEN.some(([k]) => k === r.when)) errors.push(`${path}.when: one of ${DATE_WHEN.map(([k]) => k).join(', ')}`);
      if (['before', 'after'].includes(r.when) && !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) errors.push(`${path}.date: YYYY-MM-DD`);
    }
    if (r.type === 'duration' && !(Number(r.minutes) > 0)) errors.push(`${path}.minutes: a positive number`);
    if (r.type === 'duration' && r.op && !['max', 'min'].includes(r.op)) errors.push(`${path}.op: max or min`);
  };
  if (rules !== undefined) walk(rules, 'rules', 0);
  if (options) {
    const check = (k, list) => { if (options[k] !== undefined && !list.some(([v]) => v === options[k])) errors.push(`options.${k}: one of ${list.map(([v]) => v).join(', ')}`); };
    check('show', SHOW); check('group_by', GROUP_BY); check('sort_by', SORT_BY);
    if (options.layout !== undefined && !['tree', 'flat'].includes(options.layout)) errors.push('options.layout: tree or flat');
  }
  return errors;
}

// Starting points. Tag rules name tags; instantiate() swaps names for the user's tag ids.
export const TEMPLATES = [
  { key: 'calls', name: 'Calls', icon: '📞', rules: { v: 1, match: 'all', rules: [{ type: 'tag', tag_names: ['Phone', 'Calls'], tags: [] }] }, options: { show: 'available', group_by: 'project', sort_by: 'project', layout: 'flat' } },
  { key: 'quick', name: 'Quick wins', icon: '⚡', rules: { v: 1, match: 'all', rules: [{ type: 'duration', op: 'max', minutes: 15 }] }, options: { show: 'available', group_by: 'project', sort_by: 'duration', layout: 'flat' } },
  { key: 'today', name: 'Today', icon: '☀️', rules: { v: 1, match: 'any', rules: [{ type: 'flagged' }, { type: 'date', field: 'due', when: 'today' }, { type: 'date', field: 'planned', when: 'today' }, { type: 'overdue' }] }, options: { show: 'remaining', group_by: 'due', sort_by: 'due', layout: 'flat' } },
  { key: 'due', name: 'Due soon', icon: '⏰', rules: { v: 1, match: 'any', rules: [{ type: 'overdue' }, { type: 'date', field: 'due', when: 'next', days: 7 }] }, options: { show: 'remaining', group_by: 'due', sort_by: 'due', layout: 'flat' } },
  { key: 'waiting', name: 'Waiting for', icon: '⏳', rules: { v: 1, match: 'all', rules: [{ type: 'tag', tag_names: ['Waiting', 'Waiting for'], tags: [] }] }, options: { show: 'remaining', group_by: 'tag', sort_by: 'added', layout: 'flat' } },
  { key: 'stalled', name: 'Stalled', icon: '🧊', rules: { v: 1, match: 'none', rules: [{ type: 'date', field: 'changed', when: 'past', days: 30 }] }, options: { show: 'remaining', group_by: 'project', sort_by: 'changed', layout: 'flat' } },
  { key: 'blank', name: 'New perspective', icon: '🔭', rules: { v: 1, match: 'all', rules: [] }, options: { ...DEFAULT_OPTIONS } },
];

export function instantiate(template, tags = []) {
  const copy = JSON.parse(JSON.stringify(template));
  const fix = (r) => {
    if (Array.isArray(r.rules)) { r.rules.forEach(fix); return; }
    if (r.tag_names) {
      const hit = tags.find((g) => !g.parent_id && r.tag_names.some((n) => n.toLowerCase() === String(g.name).toLowerCase()));
      r.tags = hit ? [hit.id] : [];
      delete r.tag_names;
    }
  };
  fix(copy.rules);
  return { name: copy.name, icon: copy.icon, rules: copy.rules, options: copy.options };
}
