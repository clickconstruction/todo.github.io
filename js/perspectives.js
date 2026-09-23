// Perspectives in the app: run them over the local data (with the shared engine), keep
// completed/dropped rows when a perspective needs them, and save changes.
import { db, app, sb, run, syncRow, byId, isOpen, visible, toast } from './state.js';
import { isAvailable } from './availability.js';
import { evaluate, describe, validate, TEMPLATES, instantiate } from './perspective-engine.js';

export const livePerspectives = () => db.perspectives.filter((p) => !p.archived_at).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
export const perspectiveData = (tasks = db.tasks) => ({ tasks, projects: db.projects, folders: db.folders, tags: db.tags, taskTags: db.taskTags, projectTags: db.projectTags, people: db.people || [] });
export const summaryOf = (p) => describe(p, perspectiveData());

// Does it look at completed or dropped items? Then the local open-only data isn't enough.
const needsClosed = (p) => ['completed', 'dropped', 'all'].includes((p.options || {}).show) || JSON.stringify(p.rules || {}).includes('"completed"');

// Completed/dropped rows for perspectives, fetched once per minute at most.
function closedRows(p) {
  if (!needsClosed(p)) return [];
  const c = app.perspectiveClosed;
  if (c && Date.now() - c.at < 60000) return c.rows;
  app.perspectiveClosed = { at: Date.now(), rows: c ? c.rows : [] };
  run(sb.from('tasks').select('*').or('completed_at.not.is.null,dropped_at.not.is.null').order('updated_at', { ascending: false }).limit(500))
    .then((rows) => { app.perspectiveClosed = { at: Date.now(), rows }; app.render(); })
    .catch(() => { app.perspectiveClosed = null; });
  return app.perspectiveClosed.rows;
}

// Items shown last time stay (struck through) after you complete them, so Undo has context.
const shown = new Map();
export function runPerspective(p, { remember = true } = {}) {
  const local = db.tasks;
  const ids = new Set(local.map((t) => t.id));
  const tasks = [...local, ...closedRows(p).filter((t) => !ids.has(t.id))];
  const before = shown.get(p.id) || new Set();
  const result = evaluate(p, perspectiveData(tasks), { available: isAvailable, keep: (t) => !isOpen(t) && visible(t) && before.has(t.id) });
  if (remember && p.id) shown.set(p.id, new Set(result.tasks.map((t) => t.id)));
  return result;
}

// Badge = open matches (only for perspectives with "show a count" on).
export const badgeCount = (p) => (p.badge ? runPerspective(p, { remember: false }).tasks.filter(isOpen).length : 0);

export async function savePerspective(p, fields) {
  const errors = validate({ rules: fields.rules, options: fields.options });
  if (errors.length) { toast(errors[0]); throw new Error(errors.join('; ')); }
  if (p && p.id) {
    const [row] = await run(sb.from('perspectives').update(fields).eq('id', p.id).select());
    return syncRow('perspectives', p, row);
  }
  const sort = Math.max(-1, ...db.perspectives.map((x) => x.sort || 0)) + 1;
  const [row] = await run(sb.from('perspectives').insert({ ...fields, sort }).select());
  db.perspectives.push(row);
  return row;
}

export async function archivePerspective(p, archived = true) {
  const [row] = await run(sb.from('perspectives').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', p.id).select());
  syncRow('perspectives', p, row);
  return row;
}

// A name that isn't taken ("Calls", "Calls 2", …).
export function freeName(name) {
  const taken = new Set(livePerspectives().map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
  return `${name} ${Date.now()}`;
}

export const fromTemplate = (key) => {
  const t = instantiate(TEMPLATES.find((x) => x.key === key) || TEMPLATES[TEMPLATES.length - 1], db.tags);
  return { ...t, name: freeName(t.name) };
};

export async function duplicatePerspective(p) {
  const row = await savePerspective(null, { name: freeName(`${p.name} copy`), icon: p.icon, rules: p.rules, options: p.options, badge: p.badge });
  return row;
}

export async function movePerspective(p, dir) {
  const list = livePerspectives();
  const i = list.findIndex((x) => x.id === p.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await Promise.all(list.map(async (x, sort) => {
    if (x.sort === sort) return;
    const [row] = await run(sb.from('perspectives').update({ sort }).eq('id', x.id).select());
    syncRow('perspectives', x, row);
  }));
}

// "Save as perspective" from a view's filter: turn what's on screen into rules.
export function rulesForCurrentView(filter) {
  const [view, arg] = (location.hash.slice(1) || 'inbox').split('/');
  const rules = [];
  let name = 'New perspective';
  if (view === 'project' && byId(db.projects, arg)) { rules.push({ type: 'project', projects: [arg] }); name = byId(db.projects, arg).name; }
  else if (view === 'tag' && byId(db.tags, arg)) { rules.push({ type: 'tag', tags: [arg] }); name = byId(db.tags, arg).name; }
  else if (view === 'flagged') { rules.push({ type: 'flagged' }); name = 'Flagged'; }
  else if (view === 'inbox') { rules.push({ type: 'inbox' }); name = 'Inbox'; }
  else if (view === 'forecast') { rules.push({ match: 'any', rules: [{ type: 'overdue' }, { type: 'date', field: 'due', when: 'next', days: 7 }, { type: 'date', field: 'planned', when: 'next', days: 7 }] }); name = 'This week'; }
  if (Number(filter.fits)) { rules.push({ type: 'duration', op: 'max', minutes: Number(filter.fits) }); name += ` ≤ ${filter.fits}m`; }
  return { name: freeName(name), icon: '🔭', rules: { v: 1, match: 'all', rules }, options: { show: filter.show || 'available', group_by: view === 'project' ? 'none' : 'project', sort_by: 'project', layout: 'tree' } };
}
