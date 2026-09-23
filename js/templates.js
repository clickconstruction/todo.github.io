// Project templates: build a template body from a project, list its blanks, preview what a new
// project would look like, and the starter templates. Pure (no DOM, no imports): shared by the app
// and the MCP server. The database function create_from_template() does the real creating.
//
// body = { name, notes, kind, complete_with_last, flagged, review_every, review_unit, estimate_minutes, tag_ids,
//          project_defer / project_planned / project_due (day offsets), blanks: [{ name, default }],
//          actions: [{ title, notes, tag_ids, flagged, estimate_minutes, defer, planned, due, steps_in_order, steps }] }

export const BUILT_IN_BLANKS = ['Date', 'Month', 'Year'];
export const MAX_DEPTH = 4;

// ---------- dates (local calendar days in a time zone) ----------
export function dayKey(value, tz) {
  const d = value instanceof Date ? value : new Date(value);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const toUTC = (key) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
export const daysBetween = (fromKey, toKey) => Math.round((toUTC(toKey) - toUTC(fromKey)) / 86400000);
export const addDays = (key, n) => new Date(toUTC(key) + n * 86400000).toISOString().slice(0, 10);

// ---------- from a project ----------
// data = { project, tasks (all of the project's), projectTags, taskTags }
// anchor: 'start' (days after the start: the project's defer date, else its earliest date) or
//         'due' (days before the deadline: the project's due date, else its latest due date).
// blanks: [{ find: 'Jones', name: 'Client' }] turn that text into «Client» everywhere.
export function bodyFromProject(data, { anchor = 'start', blanks = [], tz = 'UTC' } = {}) {
  const { project: p } = data;
  const open = data.tasks.filter((t) => !t.completed_at && !t.dropped_at);
  const dates = [p.defer_at, p.planned_at, p.due_at, ...open.flatMap((t) => [t.defer_at, t.planned_at, t.due_at])].filter(Boolean).map((d) => dayKey(d, tz)).sort();
  const dues = [p.due_at, ...open.map((t) => t.due_at)].filter(Boolean).map((d) => dayKey(d, tz)).sort();
  const anchorKey = anchor === 'due' ? (p.due_at ? dayKey(p.due_at, tz) : dues[dues.length - 1]) : (p.defer_at ? dayKey(p.defer_at, tz) : dates[0]);
  const off = (d) => (d && anchorKey ? daysBetween(anchorKey, dayKey(d, tz)) : null);
  const clean = (s) => blanks.reduce((acc, b) => (b.find && b.name ? acc.split(b.find).join(`«${b.name}»`) : acc), String(s || ''));
  const tagsOf = (id, links, key) => links.filter((l) => l[key] === id).map((l) => l.tag_id);
  const kids = (parentId) => open.filter((t) => (t.parent_id || null) === parentId && (parentId || t.project_id === p.id))
    .sort((a, b) => (a.sort - b.sort) || String(a.created_at).localeCompare(String(b.created_at)));
  const node = (t, depth) => {
    const a = { title: clean(t.title) };
    if (t.notes) a.notes = clean(t.notes);
    const tags = tagsOf(t.id, data.taskTags, 'task_id');
    if (tags.length) a.tag_ids = tags;
    if (t.flagged) a.flagged = true;
    if (t.estimate_minutes) a.estimate_minutes = t.estimate_minutes;
    ['defer', 'planned', 'due'].forEach((k) => { const o = off(t[`${k}_at`]); if (o !== null) a[k] = o; });
    if (t.steps_in_order) a.steps_in_order = true;
    const steps = depth < MAX_DEPTH ? kids(t.id).map((c) => node(c, depth + 1)) : [];
    if (steps.length) a.steps = steps;
    return a;
  };
  const body = {
    name: clean(p.name), notes: clean(p.notes), kind: p.kind || 'parallel', complete_with_last: !!p.complete_with_last, flagged: !!p.flagged,
    review_every: p.review_every || 1, review_unit: p.review_unit || 'week', anchor,
    tag_ids: tagsOf(p.id, data.projectTags, 'project_id'),
    blanks: blanks.filter((b) => b.name).map((b) => ({ name: b.name, default: '' })),
    actions: kids(null).map((t) => node(t, 1)),
  };
  if (p.estimate_minutes) body.estimate_minutes = p.estimate_minutes;
  ['defer', 'planned', 'due'].forEach((k) => { const o = off(p[`${k}_at`]); if (o !== null) body[`project_${k}`] = o; });
  return { body, anchorKey };
}

// ---------- blanks ----------
export function blanksOf(body) {
  const found = new Set();
  JSON.stringify(body).replace(/«([^«»]{1,40})»/g, (_, n) => { found.add(n); return ''; });
  const declared = (body.blanks || []).filter((b) => b && b.name);
  const names = [...new Set([...declared.map((b) => b.name), ...found])].filter((n) => !BUILT_IN_BLANKS.includes(n));
  return names.map((name) => ({ name, default: (declared.find((b) => b.name === name) || {}).default || '' }));
}

export function fill(text, vars, anchorKey) {
  const d = anchorKey ? new Date(`${anchorKey}T12:00:00Z`) : null;
  const built = d ? { Date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), Month: d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }), Year: String(d.getUTCFullYear()) } : {};
  return String(text || '').replace(/«([^«»]{1,40})»/g, (m, n) => (vars[n] !== undefined && vars[n] !== '' ? vars[n] : built[n] !== undefined ? built[n] : m));
}

// ---------- flat rows ⇄ nested actions (the outline editor works on rows) ----------
export function flatten(actions, depth = 1, out = []) {
  (actions || []).forEach((a) => { const { steps, ...rest } = a; out.push({ ...rest, depth }); flatten(steps, depth + 1, out); });
  return out;
}
export function nest(rows) {
  const root = []; const stack = [{ depth: 0, steps: root }];
  rows.forEach((r) => {
    const { depth, ...a } = r;
    const d = Math.max(1, Math.min(MAX_DEPTH, depth || 1, stack[stack.length - 1].depth + 1));
    while (stack.length > 1 && stack[stack.length - 1].depth >= d) stack.pop();
    const parent = stack[stack.length - 1];
    parent.steps.push(a);
    a.steps = [];
    stack.push({ depth: d, steps: a.steps, node: a });
  });
  const prune = (list) => list.forEach((a) => { if (!a.steps.length) delete a.steps; else prune(a.steps); });
  prune(root);
  return root;
}
export const countActions = (body) => flatten(body.actions).filter((a) => String(a.title || '').trim()).length;

// ---------- preview ----------
// What create_from_template() would make on anchorKey with these values: [{ title, depth, dates }]
export function preview(body, { anchorKey, vars = {} } = {}) {
  const at = (o) => (typeof o === 'number' && anchorKey ? addDays(anchorKey, o) : null);
  return {
    name: fill(body.name, vars, anchorKey),
    due: at(body.project_due),
    actions: flatten(body.actions).filter((a) => String(a.title || '').trim()).map((a) => ({
      title: fill(a.title, vars, anchorKey), depth: a.depth, defer: at(a.defer), planned: at(a.planned), due: at(a.due),
      flagged: !!a.flagged, estimate_minutes: a.estimate_minutes || null, tag_ids: a.tag_ids || [],
    })),
  };
}

export const offsetLabel = (o, anchor = 'start') => (typeof o !== 'number' ? '' : o === 0 ? (anchor === 'due' ? 'on the due date' : 'on the start day')
  : o > 0 ? `${o} day${o === 1 ? '' : 's'} after ${anchor === 'due' ? 'the due date' : 'the start'}` : `${-o} day${o === -1 ? '' : 's'} before ${anchor === 'due' ? 'the due date' : 'the start'}`);

export const describeSchedule = (s) => {
  if (!s) return '';
  const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[s.unit] || s.unit;
  return `Every ${s.every > 1 ? `${s.every} ${unit}s` : unit}${s.start ? ` from ${s.start}` : ''}`;
};

export function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body must be an object'];
  if (!Array.isArray(body.actions)) errors.push('actions must be a list');
  if (body.kind && !['parallel', 'sequential', 'single_actions'].includes(body.kind)) errors.push('kind: parallel, sequential or single_actions');
  const walk = (list, depth) => (list || []).forEach((a, i) => {
    if (!a || typeof a !== 'object') { errors.push(`action ${i + 1}: must be an object`); return; }
    ['defer', 'planned', 'due'].forEach((k) => { if (a[k] !== undefined && a[k] !== null && !Number.isInteger(a[k])) errors.push(`“${a.title}”: ${k} is a whole number of days`); });
    if (depth > MAX_DEPTH && a.steps && a.steps.length) errors.push(`“${a.title}”: steps go ${MAX_DEPTH} levels deep`);
    walk(a.steps, depth + 1);
  });
  walk(body.actions, 1);
  return errors;
}

// ---------- starters ----------
export const STARTERS = [
  { key: 'job', name: 'New job setup', icon: '🔨', body: {
    name: '«Client» job', kind: 'sequential', review_every: 1, review_unit: 'week', anchor: 'start', project_due: 30,
    blanks: [{ name: 'Client', default: '' }],
    actions: [
      { title: 'Site visit with «Client»', due: 0, estimate_minutes: 60 },
      { title: 'Send estimate to «Client»', due: 2, estimate_minutes: 30 },
      { title: 'Signed contract and deposit', due: 7 },
      { title: 'Permits', steps_in_order: true, steps: [{ title: 'Apply for permit', due: 9 }, { title: 'Pick up permit', due: 14 }] },
      { title: 'Order materials', due: 10 },
      { title: 'Schedule inspection', due: 25 },
      { title: 'Final walkthrough with «Client»', due: 30 },
      { title: 'Send final invoice', due: 30 },
    ] } },
  { key: 'trip', name: 'Trip prep', icon: '🧳', body: {
    name: 'Trip to «Destination»', kind: 'parallel', anchor: 'due', project_due: 0, review_every: 1, review_unit: 'week',
    blanks: [{ name: 'Destination', default: '' }],
    actions: [
      { title: 'Book travel', due: -30 }, { title: 'Book lodging', due: -30 }, { title: 'Arrange pet/house sitter', due: -14 },
      { title: 'Hold mail', due: -3 }, { title: 'Pack', due: -1, steps: [{ title: 'Chargers and adapters' }, { title: 'Medications' }, { title: 'Documents and IDs' }] },
      { title: 'Check in online', due: -1 },
    ] } },
  { key: 'review', name: 'Weekly review', icon: '🔁', body: {
    name: 'Weekly review «Date»', kind: 'sequential', anchor: 'start', project_due: 0, review_every: 1, review_unit: 'week',
    actions: [
      { title: 'Get clear', steps: [{ title: 'Empty the Inbox' }, { title: 'Clear email and messages' }, { title: 'Collect loose papers and notes' }] },
      { title: 'Get current', steps: [{ title: 'Review the last and next two weeks of calendar' }, { title: 'Review Waiting for' }, { title: 'Review projects (Review tab)' }] },
      { title: 'Get creative', steps: [{ title: 'Review Someday' }, { title: 'Any new projects or ideas?' }] },
    ] } },
];
