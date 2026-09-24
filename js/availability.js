// What can be worked on right now. The MCP server mirrors these rules (mcp/src/index.js).
//   available = open, not deferred (nor any ancestor), its project is active and not
//               deferred, it has no open steps of its own, and nothing ahead of it in an
//               ordered container blocks it.
//               No on-hold tag parks it (its own, its project's or a parent task's), and it isn't
//               waiting on someone or on someone's agenda.
//   ordered containers: a sequential project (only its first open top-level item goes) and a
//               task with "do steps in order" (only its first open step goes). Blocking is
//               checked at every level up the tree.
import { db, isOpen, taskSort, tagStatus } from './state.js';
import { isDeferred } from './dates.js';
import { makeWaiting } from './perspective-engine.js';

// Waiting on someone / on an agenda (shared rule), cached until people or tag links change.
let waitMemo = { key: null, fn: null };
export function waitingRule() {
  const key = `${(db.people || []).length}|${db.taskTags.length}|${(db.people || []).map((p) => `${p.id}:${p.tag_id}:${p.archived_at ? 1 : 0}`).join(',')}`;
  if (waitMemo.key !== key) waitMemo = { key, fn: makeWaiting({ people: db.people || [], taskTags: db.taskTags }) };
  return waitMemo.fn;
}

export const PROJECT_KINDS = [
  ['parallel', 'Parallel', 'Every action is available at once'],
  ['sequential', 'Sequential', 'Only the next action is available'],
  ['single_actions', 'Single actions', 'A list of unrelated actions (e.g. Errands)'],
];

// Lookups built once per screen draw (a synchronous pass), not once per task: with thousands of
// actions a per-task scan of every task and tag link made lists take seconds. Dropped after the
// current pass (microtask), or sooner if the task or tag-link lists change size.
let IX = null;
function ix() {
  const key = `${db.tasks.length}|${db.taskTags.length}|${db.tags.length}|${(db.projectTags || []).length}|${db.projects.length}`;
  if (IX && IX.key === key && IX.tasks === db.tasks && IX.links === db.taskTags) return IX;
  const kids = new Map(); const anyKids = new Set(); const projTop = new Map(); const tasks = new Map();
  db.tasks.forEach((t) => {
    tasks.set(t.id, t);
    if (t.parent_id) anyKids.add(t.parent_id);
    if (!isOpen(t)) return;
    if (t.parent_id) { if (!kids.has(t.parent_id)) kids.set(t.parent_id, []); kids.get(t.parent_id).push(t); }
    else if (t.project_id) { if (!projTop.has(t.project_id)) projTop.set(t.project_id, []); projTop.get(t.project_id).push(t); }
  });
  kids.forEach((l) => l.sort(taskSort)); projTop.forEach((l) => l.sort(taskSort));
  const held = new Map(db.tags.filter((g) => tagStatus(g) === 'on_hold').map((g) => [g.id, g]));
  const taskTags = new Map(); db.taskTags.forEach((x) => { if (!taskTags.has(x.task_id)) taskTags.set(x.task_id, []); taskTags.get(x.task_id).push(x.tag_id); });
  const projTags = new Map(); (db.projectTags || []).forEach((x) => { if (!projTags.has(x.project_id)) projTags.set(x.project_id, []); projTags.get(x.project_id).push(x.tag_id); });
  const projects = new Map(db.projects.map((p) => [p.id, p]));
  IX = { key, tasks: db.tasks, links: db.taskTags, byTask: tasks, kids, anyKids, projTop, held, taskTags, projTags, projects };
  queueMicrotask(() => { IX = null; });
  return IX;
}
const taskById = (id) => (id ? ix().byTask.get(id) : null);
// The on-hold tag parking this action: its own tags, its project's, or a parent task's (as onHoldTagFor).
function heldBy(t) {
  const x = ix();
  if (!x.held.size) return null;
  for (let n = t, i = 0; n && i < 8; i++) {
    for (const id of x.taskTags.get(n.id) || []) if (x.held.has(id)) return x.held.get(id);
    for (const id of (n.project_id && x.projTags.get(n.project_id)) || []) if (x.held.has(id)) return x.held.get(id);
    n = taskById(n.parent_id);
  }
  return null;
}
export const projectOf = (t) => (t.project_id ? ix().projects.get(t.project_id) || null : null);
const openSteps = (t) => ix().kids.get(t.id) || [];
export const isGroup = (t) => ix().anyKids.has(t.id);

// First open top-level item in a sequential project (null if none).
export function sequentialHead(project) {
  return (ix().projTop.get(project.id) || [])[0] || null;
}

// Waiting its turn: somewhere up the tree an ordered container has an earlier open item.
export function isSequenceBlocked(t) {
  let node = t;
  for (let i = 0; i < 10 && node; i++) {
    const parent = taskById(node.parent_id);
    if (parent) {
      if (parent.steps_in_order) {
        const first = openSteps(parent)[0];
        if (first && first.id !== node.id) return true;
      }
      node = parent;
    } else {
      const p = projectOf(node);
      if (p && p.kind === 'sequential') {
        const head = sequentialHead(p);
        if (head && head.id !== node.id) return true;
      }
      return false;
    }
  }
  return false;
}

export function isBlocked(t) {
  if (openSteps(t).length) return true; // has steps: do the steps
  return isSequenceBlocked(t);
}

function ancestorDeferred(t) {
  let p = taskById(t.parent_id);
  for (let i = 0; i < 10 && p; i++) {
    if (isDeferred(p)) return true;
    p = taskById(p.parent_id);
  }
  return false;
}

export function isAvailable(t) {
  if (!isOpen(t) || isDeferred(t) || ancestorDeferred(t)) return false;
  const p = projectOf(t);
  if (p && (p.status !== 'active' || isDeferred(p))) return false; // a deferred project hides its actions
  if (heldBy(t)) return false; // parked by an on-hold tag
  if (waitingRule()(t)) return false; // someone else's move (Waiting For), or for a meeting (Agenda)
  return !isBlocked(t);
}

// The project's next available action, in project order (depth-first through steps).
export function nextAction(project) {
  const open = db.tasks.filter((t) => t.project_id === project.id && isOpen(t));
  const walk = (list) => {
    for (const t of list.sort(taskSort)) {
      if (isAvailable(t)) return t;
      const hit = walk(open.filter((c) => c.parent_id === t.id));
      if (hit) return hit;
    }
    return null;
  };
  return walk(open.filter((t) => !t.parent_id));
}
