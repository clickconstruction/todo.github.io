// Checklists: reusable lists run again and again. A run records what was ticked; the next run starts
// fresh. A checklist can ride on an action (tasks.checklist_id), even a repeating one; ticking the last
// item can complete the action (complete_action).
import { db, app, sb, run, syncRow, byId } from './state.js';

export const liveChecklists = () => (db.checklists || []).filter((c) => !c.archived_at).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
const rid = () => Math.random().toString(36).slice(2, 9);

// "# Section" lines start a section; every other line is an item.
export function parseItems(text, old = []) {
  let section = '';
  const out = [];
  String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
    if (/^#+\s*/.test(l)) { section = l.replace(/^#+\s*/, '').slice(0, 100); return; }
    const t = l.replace(/^[-*•☐☑✓]\s*/, '').slice(0, 300);
    const same = old.find((o) => o.text === t && !out.some((x) => x.id === o.id)); // keep ids so runs stay ticked
    out.push({ id: same ? same.id : rid(), text: t, ...(section ? { section } : {}) });
  });
  return out.slice(0, 300);
}
export function itemsToText(items) {
  let section = '';
  return (items || []).map((i) => { const sec = i.section || ''; const head = sec && sec !== section ? `# ${sec}\n` : ''; section = sec; return head + i.text; }).join('\n');
}

export async function saveChecklist(c, fields) {
  if (c && c.id) { const [row] = await run(sb.from('checklists').update(fields).eq('id', c.id).select()); return syncRow('checklists', c, row); }
  const sort = Math.max(-1, ...(db.checklists || []).map((x) => x.sort || 0)) + 1;
  const [row] = await run(sb.from('checklists').insert({ sort, ...fields }).select());
  (db.checklists = db.checklists || []).push(row);
  return row;
}

export const runsFor = (cl) => (db.checklistRuns || []).filter((r) => r.checklist_id === cl.id).sort((a, b) => b.started_at.localeCompare(a.started_at));
export const openRun = (cl, taskId = null) => runsFor(cl).find((r) => !r.finished_at && (r.task_id || null) === (taskId || null)) || null;
export const lastFinished = (cl) => runsFor(cl).find((r) => r.finished_at) || null;
export const actionsWith = (cl) => db.tasks.filter((t) => t.checklist_id === cl.id && !t.completed_at && !t.dropped_at);

// Tick or untick an item; the run starts on the first tick. → { run, all } (all: every item ticked)
export async function tick(cl, taskId, itemId, on) {
  let r = openRun(cl, taskId);
  if (!r) {
    [r] = await run(sb.from('checklist_runs').insert({ checklist_id: cl.id, task_id: taskId || null, total: cl.items.length, ticked: [] }).select());
    (db.checklistRuns = db.checklistRuns || []).push(r);
  }
  const ids = new Set(r.ticked || []);
  if (on) ids.add(itemId); else ids.delete(itemId);
  const ticked = cl.items.map((i) => i.id).filter((id) => ids.has(id));
  const all = ticked.length === cl.items.length && cl.items.length > 0;
  const [row] = await run(sb.from('checklist_runs').update({ ticked, total: cl.items.length, ...(all ? { finished_at: new Date().toISOString() } : {}) }).eq('id', r.id).select());
  syncRow('checklistRuns', r, row);
  return { run: r, all };
}
// Finish now (some items left), or start over (the run is kept, finished as it was).
export async function finishRun(cl, taskId) {
  const r = openRun(cl, taskId);
  if (!r) return null;
  const [row] = await run(sb.from('checklist_runs').update({ finished_at: new Date().toISOString() }).eq('id', r.id).select());
  return syncRow('checklistRuns', r, row);
}

export async function attach(task, checklistId) {
  const [row] = await run(sb.from('tasks').update({ checklist_id: checklistId || null }).eq('id', task.id).select());
  syncRow('tasks', task, row);
  app.render();
  return row;
}

// A checklist from an action's steps (titles, in order), attached to it.
export async function fromSteps(task) {
  const steps = db.tasks.filter((t) => t.parent_id === task.id && !t.dropped_at).sort((a, b) => (a.sort - b.sort));
  const cl = await saveChecklist(null, { name: task.title.slice(0, 200), items: steps.map((s) => ({ id: rid(), text: s.title.slice(0, 300) })) });
  await attach(task, cl.id);
  return cl;
}

export const fmtRun = (r, cl) => {
  if (!r) return 'Never run';
  const n = (r.ticked || []).length;
  const mins = r.finished_at ? Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000) : null;
  const d = new Date(r.finished_at || r.started_at);
  const days = Math.floor((Date.now() - d) / 86400000);
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : days < 60 ? `${Math.round(days / 7)} week${Math.round(days / 7) === 1 ? '' : 's'} ago` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${r.finished_at ? 'Last run' : 'Started'} ${when} · ${n} of ${r.total || (cl ? cl.items.length : n)}${mins != null && mins < 600 ? ` · ${mins} min` : ''}`;
};
export const checklistById = (id) => byId(db.checklists || [], id);
