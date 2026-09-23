// OmniFocus import: read what OmniFocus gives us (its own script output, a TaskPaper export or a
// CSV export) and turn it into one payload for the database function import_omnifocus().
// Pure (no DOM, no imports): shared by the app and the MCP server.
//
// Payload (every item carries a stable ref, so importing twice never duplicates):
//   folders:  [{ ref, name, sort, created_at }]
//   tags:     [{ ref, name, parent_ref, depth, sort, created_at, status }]
//   projects: [{ ref, name, folder_ref, notes, status, kind, complete_with_last, flagged, defer_at, planned_at,
//                due_at, estimate_minutes, repeat_rule, review_every, review_unit, last_reviewed_at, next_review_at,
//                completed_at, created_at, updated_at, tag_refs, sort }]
//   tasks:    [{ ref, title, notes, project_ref, parent_ref, depth, in_inbox, flagged, defer_at, planned_at, due_at,
//                estimate_minutes, repeat_rule, steps_in_order, completed_at, dropped_at, created_at, updated_at, tag_refs, sort }]

export const MAX_DEPTH = 4;

// ---------- the OmniFocus script (Omni Automation; read-only) ----------
// Runs inside OmniFocus (Mac or iPhone/iPad), reads folders, tags, projects and actions, and copies
// them to the clipboard as JSON. Every property is read defensively so older versions still work.
export const OMNI_SCRIPT = `(() => {
  const get = (f, d = null) => { try { const v = f(); return v === undefined ? d : v; } catch (e) { return d; } };
  const iso = (d) => (d && d.toISOString ? d.toISOString() : null);
  const key = (o) => get(() => o.id.primaryKey);
  const rule = (o) => { const r = get(() => o.repetitionRule); if (!r) return null; return { rule: get(() => r.ruleString), method: String(get(() => r.method, '')), schedule: String(get(() => r.scheduleType, '')), anchor: String(get(() => r.anchorDateKey, '')) }; };
  const dated = (o) => ({ added: iso(get(() => o.added)), modified: iso(get(() => o.modified)) });
  const out = { format: 'todotooling-omnifocus', version: 1, exported_at: new Date().toISOString(), app: get(() => app.name + ' ' + app.userVersion.versionString), folders: [], tags: [], projects: [], tasks: [] };
  const task = (t, container, parent) => {
    out.tasks.push(Object.assign({ id: key(t), name: get(() => t.name, ''), note: get(() => t.note, ''), project: container, parent: parent,
      inbox: get(() => t.inInbox, false), flagged: get(() => t.flagged, false), defer: iso(get(() => t.deferDate)), planned: iso(get(() => t.plannedDate)),
      due: iso(get(() => t.dueDate)), estimate: get(() => t.estimatedMinutes), completed: iso(get(() => t.completionDate)), dropped: iso(get(() => t.dropDate)),
      sequential: get(() => t.sequential, false), tags: get(() => t.tags.map(key), []), repeat: rule(t),
      attachments: get(() => t.attachments.length, 0), notifications: get(() => t.notifications.length, 0) }, dated(t)));
    get(() => t.children, []).forEach((c) => task(c, container, key(t)));
  };
  get(() => flattenedFolders, []).forEach((f) => out.folders.push(Object.assign({ id: key(f), name: get(() => f.name, ''), parent: get(() => key(f.parent)), dropped: get(() => f.status === Folder.Status.Dropped, false) }, dated(f))));
  get(() => flattenedTags, []).forEach((g) => out.tags.push(Object.assign({ id: key(g), name: get(() => g.name, ''), parent: get(() => key(g.parent)),
    status: get(() => (g.status === Tag.Status.OnHold ? 'on_hold' : g.status === Tag.Status.Dropped ? 'dropped' : 'active'), 'active') }, dated(g))));
  get(() => flattenedProjects, []).forEach((p) => {
    const s = get(() => p.status);
    const ri = get(() => p.reviewInterval);
    out.projects.push(Object.assign({ id: key(p), name: get(() => p.name, ''), note: get(() => p.note, ''), folder: get(() => key(p.parentFolder)),
      status: s === Project.Status.OnHold ? 'on_hold' : s === Project.Status.Done ? 'completed' : s === Project.Status.Dropped ? 'dropped' : 'active',
      sequential: get(() => p.sequential, false), singleActions: get(() => p.containsSingletonActions, false), autoComplete: get(() => p.completedByChildren, false),
      flagged: get(() => p.flagged, false), defer: iso(get(() => p.deferDate)), planned: iso(get(() => p.plannedDate)), due: iso(get(() => p.dueDate)),
      estimate: get(() => p.estimatedMinutes), completed: iso(get(() => p.completionDate)), dropped: iso(get(() => p.dropDate)),
      review: ri ? { steps: get(() => ri.steps, 1), unit: get(() => ri.unit, 'weeks') } : null, lastReview: iso(get(() => p.lastReviewDate)), nextReview: iso(get(() => p.nextReviewDate)),
      tags: get(() => p.tags.map(key), []), repeat: rule(p), attachments: get(() => p.task.attachments.length, 0) }, dated(p)));
    (get(() => p.children) || get(() => p.task.children, [])).forEach((c) => task(c, key(p), null));
  });
  Array.from(get(() => inbox, [])).forEach((t) => task(t, null, null));
  Pasteboard.general.string = JSON.stringify(out);
  const open = out.tasks.filter((t) => !t.completed && !t.dropped).length;
  const count = (k, one) => k + ' ' + one + (k === 1 ? '' : 's');
  new Alert('Copied for Todo Tooling', count(out.projects.length, 'project') + ', ' + count(open, 'open action') + ' and ' + count(out.tags.length, 'tag') + ' are on the clipboard. Go back to Todo Tooling and tap Paste.').show();
})();`;

export const omniRunUrl = () => `omnifocus://localhost/omnijs-run?script=${encodeURIComponent(OMNI_SCRIPT)}`;

// ---------- helpers ----------
function hash(s) { // FNV-1a, for refs of items without OmniFocus ids (TaskPaper/CSV)
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const clean = (s) => String(s ?? '').replace(/\u0000/g, '').trim();
const clampMinutes = (m) => { const n = Math.round(Number(m)); return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : null; };

// "2026-09-25 17:00" (a local time in tz) → ISO. Plain dates get the given hour.
function tzOffsetMs(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
}
export function localToIso(text, tz, defaultHour = 0) {
  const s = clean(text);
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && !isNaN(Date.parse(s.replace(' ', 'T')))) return new Date(s.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T').replace(/ ([+-]\d{4})$/, '$1')).toISOString();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (!m) { const d = Date.parse(s); return isNaN(d) ? null : new Date(d).toISOString(); }
  let hh = m[4] !== undefined ? +m[4] : defaultHour;
  if (m[7]) hh = (hh % 12) + (/pm/i.test(m[7]) ? 12 : 0);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], hh, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  const once = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(once, tz)).toISOString();
}

// "30m", "1h", "1h 30m", "90" → minutes
export function parseEstimate(s) {
  const t = clean(s).toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return clampMinutes(t);
  let total = 0; let hit = false;
  t.replace(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|d|days?|w|weeks?)/g, (_, n, u) => {
    hit = true;
    const v = Number(n);
    total += u[0] === 'h' ? v * 60 : u[0] === 'd' ? v * 480 : u[0] === 'w' ? v * 2400 : v;
    return '';
  });
  return hit ? clampMinutes(total) : null;
}

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// OmniFocus repeat (an iCalendar RRULE plus a method) → our repeat rule. Returns { rule, exact }.
export function repeatFrom(ruleString, method, tz) {
  if (!ruleString) return { rule: null, exact: true };
  const parts = Object.fromEntries(String(ruleString).replace(/^RRULE:/i, '').split(';').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k.toUpperCase(), v || '']; }));
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year', HOURLY: null, MINUTELY: null }[String(parts.FREQ || '').toUpperCase()];
  if (!unit) return { rule: null, exact: false };
  const rule = { every: Math.max(1, Math.min(999, parseInt(parts.INTERVAL || '1', 10) || 1)), unit, from: 'assigned', n: 1, tz };
  const m = String(method || '').toLowerCase();
  if (/after|completion|defer|start|due ?date|duedate|deferuntil/.test(m) && !/fixed/.test(m)) rule.from = 'completion';
  let exact = true;
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',').map((d) => d.trim().toUpperCase());
    if (unit === 'week' && days.every((d) => d in DAYS)) rule.weekdays = days.map((d) => DAYS[d]).sort();
    else if (unit === 'day' && days.every((d) => d in DAYS)) { rule.unit = 'week'; rule.every = 1; rule.weekdays = days.map((d) => DAYS[d]).sort(); }
    else exact = false; // e.g. "2nd Tuesday of the month"
  }
  ['BYMONTHDAY', 'BYSETPOS', 'BYMONTH', 'BYYEARDAY', 'BYWEEKNO', 'BYHOUR', 'BYMINUTE'].forEach((k) => { if (parts[k]) exact = false; });
  if (parts.COUNT) rule.end_count = Math.max(1, parseInt(parts.COUNT, 10) || 1);
  if (parts.UNTIL) { const u = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/); if (u) rule.end_until = `${u[1]}-${u[2]}-${u[3]}`; }
  return { rule, exact };
}

// ---------- detect ----------
export function detectFormat(text) {
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (t.startsWith('{')) return 'json';
  const first = t.split(/\r?\n/)[0] || '';
  if (/^"?(task id|id)"?\s*,/i.test(first) || (first.split(',').length > 4 && /name/i.test(first) && /type|project/i.test(first))) return 'csv';
  if (/^\s*(-\s|.+:\s*$)/m.test(t)) return 'taskpaper';
  return 'unknown';
}

// ---------- OmniFocus script JSON ----------
function fromOmniJSON(data, tz) {
  const warn = [];
  const ref = (id) => (id ? `of:${id}` : null);
  const out = { source: 'omnifocus', folders: [], tags: [], projects: [], tasks: [], warn, stats: { attachments: 0, notifications: 0, onHoldTags: 0, inexactRepeats: 0 } };
  // Folders are flat here: nested folders become "Parent › Child".
  const fById = new Map((data.folders || []).map((f) => [f.id, f]));
  const fPath = (f) => { const names = []; for (let x = f, i = 0; x && i < 8; i++) { names.unshift(clean(x.name) || 'Folder'); x = fById.get(x.parent); } return names.join(' › '); };
  const droppedFolder = (id) => { for (let x = fById.get(id), i = 0; x && i < 8; i++) { if (x.dropped) return true; x = fById.get(x.parent); } return false; };
  (data.folders || []).forEach((f, i) => out.folders.push({ ref: ref(f.id), name: fPath(f), sort: i, created_at: f.added || null }));
  const tById = new Map((data.tags || []).map((g) => [g.id, g]));
  const tDepth = (g) => { let d = 1; for (let x = tById.get(g.parent), i = 0; x && i < 8; i++) { d++; x = tById.get(x.parent); } return d; };
  (data.tags || []).forEach((g, i) => {
    if (g.status === 'on_hold') out.stats.onHoldTags++;
    out.tags.push({ ref: ref(g.id), name: clean(g.name) || 'Tag', parent_ref: ref(g.parent), depth: tDepth(g), sort: i, created_at: g.added || null, status: ['on_hold', 'dropped'].includes(g.status) ? g.status : 'active' });
  });
  const rep = (r) => (r ? repeatFrom(r.rule, r.method || r.schedule, tz) : { rule: null, exact: true });
  (data.projects || []).forEach((p, i) => {
    const r = p.review;
    const unit = r && String(r.unit || '').toLowerCase().replace(/s$/, '');
    out.stats.attachments += p.attachments || 0;
    out.projects.push({
      ref: ref(p.id), name: clean(p.name) || 'Untitled project', folder_ref: ref(p.folder), notes: p.note || '',
      status: droppedFolder(p.folder) && ['active', 'on_hold'].includes(p.status) ? 'dropped' : (p.status || 'active'),
      kind: p.singleActions ? 'single_actions' : p.sequential ? 'sequential' : 'parallel', complete_with_last: !!p.autoComplete, flagged: !!p.flagged,
      defer_at: p.defer, planned_at: p.planned, due_at: p.due, estimate_minutes: clampMinutes(p.estimate), repeat_rule: rep(p.repeat).rule, _repeat_inexact: !rep(p.repeat).exact,
      review_every: r ? Math.max(1, Math.min(999, Math.round(r.steps) || 1)) : 1, review_unit: ['day', 'week', 'month', 'year'].includes(unit) ? unit : 'week',
      last_reviewed_at: p.lastReview || null, next_review_at: p.nextReview || null, completed_at: p.status === 'completed' ? (p.completed || p.modified || null) : p.status === 'dropped' ? (p.dropped || p.modified || null) : null,
      created_at: p.added || null, updated_at: p.modified || null, tag_refs: (p.tags || []).map(ref), sort: i,
      _repeat_note: p.repeat && p.repeat.rule ? p.repeat.rule : '',
    });
  });
  (data.tasks || []).forEach((t, i) => {
    out.stats.attachments += t.attachments || 0;
    out.stats.notifications += t.notifications || 0;
    out.tasks.push({
      ref: ref(t.id), title: clean(t.name) || 'Untitled', notes: t.note || '', project_ref: ref(t.project), parent_ref: ref(t.parent),
      in_inbox: !t.project && !t.parent ? true : !!t.inbox, flagged: !!t.flagged, defer_at: t.defer, planned_at: t.planned, due_at: t.due,
      estimate_minutes: clampMinutes(t.estimate), repeat_rule: rep(t.repeat).rule, _repeat_inexact: !rep(t.repeat).exact, steps_in_order: !!t.sequential,
      completed_at: t.completed || null, dropped_at: t.completed ? null : (t.dropped || null),
      created_at: t.added || null, updated_at: t.modified || null, tag_refs: (t.tags || []).map(ref), sort: i,
      _repeat_note: t.repeat && t.repeat.rule ? t.repeat.rule : '',
    });
  });
  return out;
}

// ---------- TaskPaper (File → Export → TaskPaper, or Copy as TaskPaper) ----------
function fromTaskPaper(text, tz) {
  const warn = [];
  const out = { source: 'taskpaper', folders: [], tags: [], projects: [], tasks: [], warn, stats: { attachments: 0, notifications: 0, onHoldTags: 0, inexactRepeats: 0, unknownAttrs: {} } };
  const tagRefs = new Map();
  const tagRef = (label) => {
    const parts = label.split(/\s*:\s*/).map(clean).filter(Boolean);
    let parent = null; let path = '';
    parts.forEach((name, i) => {
      path = path ? `${path} : ${name}` : name;
      const key = path.toLowerCase();
      if (!tagRefs.has(key)) { const r = `tp-tag:${hash(key)}`; tagRefs.set(key, r); out.tags.push({ ref: r, name, parent_ref: parent, depth: i + 1, sort: out.tags.length }); }
      parent = tagRefs.get(key);
    });
    return parent;
  };
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const indentOf = (l) => { const m = l.match(/^[\t ]*/)[0]; return (m.match(/\t/g) || []).length + Math.floor(m.replace(/\t/g, '').length / 4); };
  const stack = []; // { indent, kind: 'folder'|'inbox'|'project'|'task', item, path }
  let last = null;
  const attrsOf = (s) => {
    const attrs = {};
    const title = s.replace(/(^|\s)@([\w-]+)(?:\(([^)]*)\))?/g, (_, sp, k, v) => { attrs[k.toLowerCase()] = v === undefined ? true : v; return ''; }).trim();
    return { title, attrs };
  };
  const KNOWN = new Set(['tags', 'context', 'due', 'defer', 'start', 'planned', 'done', 'dropped', 'flagged', 'estimate', 'parallel', 'autodone', 'repeat-rule', 'repeat-method', 'repeat-schedule', 'repeat-anchor', 'review-interval', 'last-review']);
  lines.forEach((raw) => {
    if (!raw.trim()) return;
    const indent = indentOf(raw);
    const line = raw.trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const up = stack[stack.length - 1];
    const item = line.match(/^-\s+(.*)$/);
    if (!item && /:\s*(@.*)?$/.test(line) && !/^https?:/i.test(line)) { // a heading: Inbox or a folder
      const name = line.replace(/:\s*(@.*)?$/, '').trim();
      if (/^inbox$/i.test(name)) { stack.push({ indent, kind: 'inbox' }); last = null; return; }
      const path = [...stack.filter((s) => s.kind === 'folder').map((s) => s.name), name].join(' › ');
      const f = { ref: `tp-folder:${hash(path.toLowerCase())}`, name: path, sort: out.folders.length };
      out.folders.push(f);
      stack.push({ indent, kind: 'folder', name, item: f });
      last = null;
      return;
    }
    if (!item) { if (last) last.notes = last.notes ? `${last.notes}\n${line}` : line; return; } // note line
    const { title, attrs } = attrsOf(item[1]);
    Object.keys(attrs).forEach((k) => { if (!KNOWN.has(k)) out.stats.unknownAttrs[k] = (out.stats.unknownAttrs[k] || 0) + 1; });
    const tagLabels = [attrs.tags, attrs.context].filter((v) => typeof v === 'string').flatMap((v) => v.split(',')).map(clean).filter(Boolean);
    const common = {
      flagged: !!attrs.flagged, defer_at: localToIso(attrs.defer || attrs.start, tz), planned_at: localToIso(attrs.planned, tz, 9), due_at: localToIso(attrs.due, tz, 17),
      estimate_minutes: parseEstimate(attrs.estimate), tag_refs: tagLabels.map(tagRef),
    };
    const rr = attrs['repeat-rule'] ? repeatFrom(attrs['repeat-rule'], attrs['repeat-method'], tz) : { rule: null, exact: true };
    const repeat = rr.rule;
    common._repeat_inexact = !rr.exact;
    const container = stack.slice().reverse().find((s) => s.kind === 'project' || s.kind === 'task' || s.kind === 'inbox' || s.kind === 'folder');
    const isProject = attrs.parallel !== undefined || attrs.autodone !== undefined || !container || container.kind === 'folder';
    const path = [...stack.map((s) => s.name || (s.item && (s.item.name || s.item.title)) || s.kind), title].join('/');
    const done = attrs.done ? (localToIso(attrs.done === true ? '' : attrs.done, tz, 12) || new Date().toISOString()) : null;
    const dropped = !done && attrs.dropped ? (localToIso(attrs.dropped === true ? '' : attrs.dropped, tz, 12) || new Date().toISOString()) : null;
    if (isProject && (!container || container.kind === 'folder')) {
      const folder = stack.slice().reverse().find((s) => s.kind === 'folder');
      const p = { ref: `tp-project:${hash(path.toLowerCase())}`, name: title || 'Untitled project', folder_ref: folder ? folder.item.ref : null, notes: '',
        status: done ? 'completed' : dropped ? 'dropped' : 'active', kind: attrs.parallel === 'false' ? 'sequential' : 'parallel', complete_with_last: attrs.autodone === 'true',
        ...common, repeat_rule: repeat, review_every: 1, review_unit: 'week', last_reviewed_at: null, completed_at: done || dropped, sort: out.projects.length, _repeat_note: attrs['repeat-rule'] || '' };
      out.projects.push(p);
      stack.push({ indent, kind: 'project', item: p });
      last = p;
      return;
    }
    const parentTask = up && up.kind === 'task' ? up.item : null;
    const project = stack.slice().reverse().find((s) => s.kind === 'project');
    const t = { ref: `tp-task:${hash(path.toLowerCase())}`, title: title || 'Untitled', notes: '', project_ref: project ? project.item.ref : null, parent_ref: parentTask ? parentTask.ref : null,
      in_inbox: !project && !parentTask, ...common, repeat_rule: repeat, steps_in_order: attrs.parallel === 'false', completed_at: done, dropped_at: dropped, sort: out.tasks.length, _repeat_note: attrs['repeat-rule'] || '' };
    out.tasks.push(t);
    stack.push({ indent, kind: 'task', item: t });
    last = t;
  });
  const unknown = Object.entries(out.stats.unknownAttrs);
  if (unknown.length) warn.push(`Ignored ${unknown.map(([k, n]) => `@${k} (${n})`).join(', ')}.`);
  warn.push('TaskPaper files don’t include review schedules or repeat details in every OmniFocus version. “Copy from OmniFocus” brings everything.');
  return out;
}

// ---------- CSV (File → Export → CSV) ----------
function parseCsvRows(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function fromCSV(text, tz) {
  const warn = [];
  const out = { source: 'csv', folders: [], tags: [], projects: [], tasks: [], warn, stats: { attachments: 0, notifications: 0, onHoldTags: 0, inexactRepeats: 0 } };
  const [head, ...rows] = parseCsvRows(text);
  const col = (...names) => head.findIndex((h) => names.some((n) => h.trim().toLowerCase() === n));
  const C = { id: col('task id', 'id'), type: col('type'), name: col('name', 'title'), status: col('status'), project: col('project'), context: col('context'), tags: col('tags'),
    defer: col('start date', 'defer date', 'defer'), planned: col('planned date', 'planned'), due: col('due date', 'due'), done: col('completion date', 'completed'), dropped: col('drop date', 'dropped date'),
    duration: col('duration', 'estimated duration', 'estimate'), flagged: col('flagged'), notes: col('notes', 'note') };
  if (C.name < 0) { warn.push('This CSV has no Name column.'); return out; }
  const v = (r, k) => (C[k] >= 0 ? clean(r[C[k]]) : '');
  const tagRefs = new Map();
  const tagRef = (label) => {
    const parts = label.split(/\s*:\s*/).map(clean).filter(Boolean); let parent = null; let path = '';
    parts.forEach((name, i) => { path = path ? `${path} : ${name}` : name; const key = path.toLowerCase(); if (!tagRefs.has(key)) { const r = `csv-tag:${hash(key)}`; tagRefs.set(key, r); out.tags.push({ ref: r, name, parent_ref: parent, depth: i + 1, sort: out.tags.length }); } parent = tagRefs.get(key); });
    return parent;
  };
  const byId = new Map();
  const projectsByName = new Map();
  rows.forEach((r, i) => {
    const type = v(r, 'type').toLowerCase();
    const id = v(r, 'id') || String(i + 1);
    const status = v(r, 'status').toLowerCase();
    const flagged = /^(1|yes|true|flagged)$/i.test(v(r, 'flagged'));
    const tags = [v(r, 'tags'), v(r, 'context')].flatMap((x) => x.split(',')).map(clean).filter(Boolean);
    const done = localToIso(v(r, 'done'), tz, 12);
    const dropped = !done && /drop/.test(status) ? (localToIso(v(r, 'dropped'), tz, 12) || new Date().toISOString()) : null;
    const common = { flagged, defer_at: localToIso(v(r, 'defer'), tz), planned_at: localToIso(v(r, 'planned'), tz, 9), due_at: localToIso(v(r, 'due'), tz, 17),
      estimate_minutes: parseEstimate(v(r, 'duration')), tag_refs: [...new Set(tags.map(tagRef))], notes: v(r, 'notes') };
    if (type === 'project' || type === 'folder') {
      if (type === 'folder') { out.folders.push({ ref: `csv-folder:${hash(v(r, 'name').toLowerCase())}`, name: v(r, 'name'), sort: out.folders.length }); return; }
      const p = { ref: `csv-project:${hash(`${id}/${v(r, 'name')}`.toLowerCase())}`, name: v(r, 'name') || 'Untitled project', folder_ref: null, ...common,
        status: /hold/.test(status) ? 'on_hold' : done || /done|complete/.test(status) ? 'completed' : dropped ? 'dropped' : 'active', kind: 'parallel', complete_with_last: false,
        repeat_rule: null, review_every: 1, review_unit: 'week', last_reviewed_at: null, completed_at: done || dropped, sort: out.projects.length };
      out.projects.push(p);
      byId.set(id, { kind: 'project', item: p });
      projectsByName.set(p.name.toLowerCase(), p);
      return;
    }
    const parentId = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null;
    const up = parentId && byId.get(parentId);
    const projectName = v(r, 'project');
    const project = up ? (up.kind === 'project' ? up.item : out.projects.find((p) => p.ref === up.item.project_ref)) : projectName ? projectsByName.get(projectName.toLowerCase()) : null;
    const t = { ref: `csv-task:${hash(`${id}/${v(r, 'name')}`.toLowerCase())}`, title: v(r, 'name') || 'Untitled', project_ref: project ? project.ref : null,
      parent_ref: up && up.kind === 'task' ? up.item.ref : null, in_inbox: !project && !(up && up.kind === 'task'), ...common, repeat_rule: null, steps_in_order: false,
      completed_at: done, dropped_at: dropped, sort: out.tasks.length };
    out.tasks.push(t);
    byId.set(id, { kind: 'task', item: t });
  });
  warn.push('CSV exports don’t include folders, repeats or review schedules. “Copy from OmniFocus” brings everything.');
  return out;
}

export function parse(text, { tz = 'UTC' } = {}) {
  const format = detectFormat(text);
  if (format === 'json') {
    let data;
    try { data = JSON.parse(String(text).replace(/^﻿/, '')); } catch { throw new Error('That looks like JSON but couldn’t be read. Copy it again from OmniFocus.'); }
    if (data.format !== 'todotooling-omnifocus') throw new Error('That JSON didn’t come from the Todo Tooling OmniFocus script.');
    return { format, ...fromOmniJSON(data, tz) };
  }
  if (format === 'csv') return { format, ...fromCSV(text, tz) };
  if (format === 'taskpaper') return { format, ...fromTaskPaper(text, tz) };
  throw new Error('That doesn’t look like an OmniFocus export. Use “Copy from OmniFocus”, or a TaskPaper or CSV file.');
}

// ---------- prepare: filter, flatten deep nesting, order parents first ----------
// completed: 'none' | '30' | 'all'  (which completed/dropped items come along)
export function prepare(parsed, { completed = 'none', now = new Date() } = {}) {
  const cutoff = completed === 'all' ? -Infinity : completed === 'none' ? Infinity : now.getTime() - Number(completed) * 86400000;
  const closedAt = (x) => x.completed_at || x.dropped_at;
  // Closed without a date (e.g. a project in a dropped folder) only comes with "all".
  const keepClosed = (x, closed = !!closedAt(x)) => { if (!closed) return true; const at = closedAt(x); return at ? new Date(at).getTime() >= cutoff : completed === 'all'; };
  const warnings = [...parsed.warn];
  const projects = parsed.projects.filter((p) => (['active', 'on_hold'].includes(p.status) ? true : keepClosed(p, true)));
  const projectRefs = new Set(projects.map((p) => p.ref));
  const byRef = new Map(parsed.tasks.map((t) => [t.ref, t]));
  // A task comes along if it (and every task above it) passes, and its project does.
  const keep = new Map();
  const kept = (t) => {
    if (keep.has(t.ref)) return keep.get(t.ref);
    let ok = keepClosed(t) && (!t.project_ref || projectRefs.has(t.project_ref));
    if (ok && t.parent_ref) { const up = byRef.get(t.parent_ref); ok = up ? kept(up) : true; }
    keep.set(t.ref, ok);
    return ok;
  };
  let flattened = 0;
  const tasks = parsed.tasks.filter(kept).map((t) => ({ ...t }));
  const tByRef = new Map(tasks.map((t) => [t.ref, t]));
  const chain = (t) => { const up = []; for (let p = t.parent_ref && tByRef.get(t.parent_ref), i = 0; p && i < 50; i++) { up.push(p); p = p.parent_ref && tByRef.get(p.parent_ref); } return up; };
  tasks.forEach((t) => {
    if (t.parent_ref && !tByRef.has(t.parent_ref)) t.parent_ref = null; // parent was filtered out
    const up = chain(t);
    if (up.length >= MAX_DEPTH) { // deeper than 4 levels: hang it under the level-3 ancestor
      const target = up[up.length - MAX_DEPTH + 1];
      t.notes = `${t.notes ? `${t.notes}\n\n` : ''}(In OmniFocus this was under “${up[0].title}”.)`;
      t.parent_ref = target.ref;
      flattened++;
    }
  });
  tasks.forEach((t) => { t.depth = chain(t).length + 1; if (!t.parent_ref && !t.project_ref) t.in_inbox = true; if (t.parent_ref || t.project_ref) t.in_inbox = false; });
  tasks.sort((a, b) => (a.depth - b.depth) || (a.sort - b.sort));
  if (flattened) warnings.push(`${flattened} item${flattened === 1 ? ' was' : 's were'} nested deeper than 4 levels and moved up (noted on each).`);
  // Repeats we couldn't match exactly keep the original rule in the notes.
  let inexact = 0;
  const projectsOut = projects.map((p) => ({ ...p }));
  [...projectsOut, ...tasks].forEach((x) => {
    if (x._repeat_inexact && x._repeat_note) { inexact++; x.notes = `${x.notes ? `${x.notes}\n\n` : ''}(OmniFocus repeat: ${x._repeat_note})`; }
    delete x._repeat_note; delete x._repeat_inexact;
  });
  if (inexact) warnings.push(`${inexact} repeat rule${inexact === 1 ? '' : 's'} couldn’t be matched exactly; the closest match is set and the original is kept in the notes.`);
  if (parsed.stats.attachments) warnings.push(`${parsed.stats.attachments} attachment${parsed.stats.attachments === 1 ? ' stays' : 's stay'} in OmniFocus (add them here with 📎 if you need them).`);
  if (parsed.stats.notifications) warnings.push(`${parsed.stats.notifications} custom OmniFocus notification${parsed.stats.notifications === 1 ? ' isn’t' : 's aren’t'} copied; set reminders here with 🔔.`);
  if (parsed.stats.onHoldTags) warnings.push(`${parsed.stats.onHoldTags} tag${parsed.stats.onHoldTags === 1 ? ' is' : 's are'} on hold in OmniFocus and stay${parsed.stats.onHoldTags === 1 ? 's' : ''} on hold here (their actions are parked).`);
  const usedTags = new Set([...projectsOut, ...tasks].flatMap((x) => x.tag_refs || []));
  const tagByRef = new Map(parsed.tags.map((g) => [g.ref, g]));
  [...usedTags].forEach((r) => { for (let g = tagByRef.get(r), i = 0; g && i < 8; i++) { usedTags.add(g.ref); g = g.parent_ref && tagByRef.get(g.parent_ref); } });
  const tags = parsed.tags.filter((g) => usedTags.has(g.ref) || parsed.format === 'json').sort((a, b) => (a.depth - b.depth) || (a.sort - b.sort));
  const folderRefs = new Set(projectsOut.map((p) => p.folder_ref).filter(Boolean));
  const folders = parsed.folders.filter((f) => folderRefs.has(f.ref));
  const open = tasks.filter((t) => !t.completed_at && !t.dropped_at);
  const payload = { source: parsed.source, folders, tags, projects: projectsOut, tasks };
  const summary = {
    folders: folders.length, tags: tags.length, projects: projectsOut.length,
    activeProjects: projectsOut.filter((p) => p.status === 'active').length, onHoldProjects: projectsOut.filter((p) => p.status === 'on_hold').length,
    openActions: open.length, closedActions: tasks.length - open.length, inbox: open.filter((t) => t.in_inbox).length,
    repeating: [...projectsOut, ...tasks].filter((x) => x.repeat_rule).length, flagged: open.filter((t) => t.flagged).length,
    skippedClosed: parsed.tasks.length - tasks.length,
  };
  return { payload, summary, warnings, bytes: JSON.stringify(payload).length };
}

// A few lines to show in the preview: folders › projects › first actions.
export function sampleTree(payload, { projects = 4, actions = 3 } = {}) {
  const lines = [];
  const folderName = new Map(payload.folders.map((f) => [f.ref, f.name]));
  payload.projects.filter((p) => ['active', 'on_hold'].includes(p.status)).slice(0, projects).forEach((p) => {
    const acts = payload.tasks.filter((t) => t.project_ref === p.ref && !t.parent_ref && !t.completed_at && !t.dropped_at);
    lines.push({ depth: 0, text: `${p.folder_ref ? `📁 ${folderName.get(p.folder_ref)} › ` : ''}🗂️ ${p.name}`, meta: [p.kind !== 'parallel' ? p.kind.replace('_', ' ') : '', p.status === 'on_hold' ? 'on hold' : '', `${acts.length} action${acts.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') });
    acts.slice(0, actions).forEach((t) => lines.push({ depth: 1, text: t.title, meta: [t.flagged ? '⚑' : '', t.due_at ? `due ${t.due_at.slice(0, 10)}` : ''].filter(Boolean).join(' ') }));
  });
  const inbox = payload.tasks.filter((t) => t.in_inbox && !t.completed_at && !t.dropped_at).length;
  if (inbox) lines.push({ depth: 0, text: `📥 Inbox`, meta: `${inbox} item${inbox === 1 ? '' : 's'}` });
  return lines;
}

// Big libraries go in chunks (each is one database call). A task always travels with its whole
// tree (same project, or the same Inbox item), and every chunk carries the folders, tags and
// projects (already-imported ones are skipped), so any chunk can go first.
export function chunks(payload, size = 2500) {
  const byRef = new Map(payload.tasks.map((t) => [t.ref, t]));
  const rootKey = (t) => { let r = t; for (let i = 0; i < 10 && r.parent_ref && byRef.get(r.parent_ref); i++) r = byRef.get(r.parent_ref); return r.project_ref || `inbox:${r.ref}`; };
  const groups = new Map();
  payload.tasks.forEach((t) => { const k = rootKey(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  const out = [];
  let cur = [];
  [...groups.values()].forEach((g) => {
    if (cur.length && cur.length + g.length > size) { out.push(cur); cur = []; }
    cur = cur.concat(g);
  });
  if (cur.length || !out.length) out.push(cur);
  return out.map((tasks) => ({ ...payload, tasks: tasks.sort((a, b) => (a.depth - b.depth) || (a.sort - b.sort)) }));
}

// Add up per-chunk results (folders, tags and projects are counted once: the first chunk has them).
export function sumCounts(results, { dryRun = false } = {}) {
  if (!results.length) return {};
  const total = { ...results[0] };
  const add = ['tasks', 'tasks_skipped'].concat(dryRun ? ['open_tasks', 'inbox'] : []);
  results.slice(1).forEach((r) => {
    add.forEach((k) => { total[k] = (total[k] || 0) + (r[k] || 0); });
    if (!dryRun) ['open_tasks', 'inbox', 'review_due', 'import_id'].forEach((k) => { if (r[k] !== undefined) total[k] = r[k]; });
    ['folders', 'tags', 'projects', 'folders_merged', 'tags_merged', 'projects_skipped'].forEach((k) => { if (!dryRun) total[k] = (total[k] || 0) + (r[k] || 0); });
  });
  return total;
}
