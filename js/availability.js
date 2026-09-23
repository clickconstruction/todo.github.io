// What can be worked on right now. The MCP server mirrors these rules (mcp/src/index.js).
//   available = open, not deferred (nor any ancestor), its project is active and not
//               deferred, it has no open steps of its own, and nothing ahead of it in an
//               ordered container blocks it.
//   ordered containers: a sequential project (only its first open top-level item goes) and a
//               task with "do steps in order" (only its first open step goes). Blocking is
//               checked at every level up the tree.
import { db, byId, isOpen, taskSort } from './state.js';
import { isDeferred } from './dates.js';

export const PROJECT_KINDS = [
  ['parallel', 'Parallel', 'Every action is available at once'],
  ['sequential', 'Sequential', 'Only the next action is available'],
  ['single_actions', 'Single actions', 'A list of unrelated actions (e.g. Errands)'],
];

export const projectOf = (t) => (t.project_id ? byId(db.projects, t.project_id) : null);
const openSteps = (t) => db.tasks.filter((c) => c.parent_id === t.id && isOpen(c));
export const isGroup = (t) => db.tasks.some((c) => c.parent_id === t.id);

// First open top-level item in a sequential project (null if none).
export function sequentialHead(project) {
  const top = db.tasks.filter((t) => t.project_id === project.id && !t.parent_id && isOpen(t)).sort(taskSort);
  return top[0] || null;
}

// Waiting its turn: somewhere up the tree an ordered container has an earlier open item.
export function isSequenceBlocked(t) {
  let node = t;
  for (let i = 0; i < 10 && node; i++) {
    const parent = node.parent_id && byId(db.tasks, node.parent_id);
    if (parent) {
      if (parent.steps_in_order) {
        const first = openSteps(parent).sort(taskSort)[0];
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
  let p = t.parent_id && byId(db.tasks, t.parent_id);
  for (let i = 0; i < 10 && p; i++) {
    if (isDeferred(p)) return true;
    p = p.parent_id && byId(db.tasks, p.parent_id);
  }
  return false;
}

export function isAvailable(t) {
  if (!isOpen(t) || isDeferred(t) || ancestorDeferred(t)) return false;
  const p = projectOf(t);
  if (p && (p.status !== 'active' || isDeferred(p))) return false; // a deferred project hides its actions
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
