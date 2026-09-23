// What can be worked on right now. The MCP server mirrors these rules (mcp/src/index.js).
//   available = open, not deferred, its project is active and not deferred, and not blocked.
//   blocked   = it's a group with open children (do the children instead), or it sits
//               in a sequential project behind the first open top-level item.
// Groups themselves are parallel: every open child of an unblocked group is available.
import { db, byId, isOpen, taskSort } from './state.js';
import { isDeferred } from './dates.js';

export const PROJECT_KINDS = [
  ['parallel', 'Parallel', 'Every action is available at once'],
  ['sequential', 'Sequential', 'Only the next action is available'],
  ['single_actions', 'Single actions', 'A list of unrelated actions (e.g. Errands)'],
];

export const projectOf = (t) => (t.project_id ? byId(db.projects, t.project_id) : null);
const openChildren = (t) => db.tasks.filter((c) => c.parent_id === t.id && isOpen(c));
export const isGroup = (t) => db.tasks.some((c) => c.parent_id === t.id);

// First open top-level item in a sequential project (null if none).
export function sequentialHead(project) {
  const top = db.tasks.filter((t) => t.project_id === project.id && !t.parent_id && isOpen(t)).sort(taskSort);
  return top[0] || null;
}

// Waiting its turn in a sequential project (behind the first open top-level item).
export function isSequenceBlocked(t) {
  const p = projectOf(t);
  if (!p || p.kind !== 'sequential') return false;
  const head = sequentialHead(p);
  const top = t.parent_id ? byId(db.tasks, t.parent_id) : t;
  return !!head && !!top && top.id !== head.id;
}

export function isBlocked(t) {
  if (openChildren(t).length) return true; // groups: do the children
  return isSequenceBlocked(t);
}

export function isAvailable(t) {
  if (!isOpen(t) || isDeferred(t)) return false;
  const p = projectOf(t);
  if (p && (p.status !== 'active' || isDeferred(p))) return false; // a deferred project hides its actions
  return !isBlocked(t);
}

// The project's next available action, in project order (groups contribute their first child).
export function nextAction(project) {
  const tasks = db.tasks.filter((t) => t.project_id === project.id && isOpen(t));
  const ordered = tasks.filter((t) => !t.parent_id).sort(taskSort)
    .flatMap((t) => [t, ...tasks.filter((c) => c.parent_id === t.id).sort(taskSort)]);
  return ordered.find(isAvailable) || null;
}
