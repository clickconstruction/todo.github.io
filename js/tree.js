// Steps: any action can have steps, and steps can have steps (up to MAX_DEPTH levels; the
// database enforces it). Helpers for walking that tree over db.tasks.
import { db, byId, isOpen, taskSort, isCollapsed } from './state.js';

export const MAX_DEPTH = 4;

export const stepsOf = (t, list = db.tasks) => list.filter((c) => c.parent_id === t.id).sort(taskSort);
export const hasSteps = (t) => db.tasks.some((c) => c.parent_id === t.id);

export function ancestors(t) {
  const out = [];
  let p = t.parent_id && byId(db.tasks, t.parent_id);
  while (p && out.length < 10) { out.push(p); p = p.parent_id && byId(db.tasks, p.parent_id); }
  return out; // nearest first
}
export const depthOf = (t) => ancestors(t).length + 1; // top-level = 1
export const rootOf = (t) => { const a = ancestors(t); return a.length ? a[a.length - 1] : t; };

export function descendants(t) {
  const out = [];
  const walk = (n) => stepsOf(n).forEach((c) => { out.push(c); if (out.length < 500) walk(c); });
  walk(t);
  return out;
}
// Levels below t (0 = no steps).
export const heightOf = (t) => { const kids = stepsOf(t); return kids.length ? 1 + Math.max(...kids.map(heightOf)) : 0; };

// Progress counts the smallest steps (leaves): the real units of work.
export function progress(t) {
  const leaves = descendants(t).filter((d) => !hasSteps(d));
  const live = leaves.filter((d) => !d.dropped_at || d.completed_at);
  return { done: live.filter((d) => d.completed_at).length, total: live.length };
}

// The first open leaf in order (depth-first): what to do next inside t.
export function nextStep(t) {
  for (const c of stepsOf(t).filter(isOpen)) {
    if (!hasSteps(c)) return c;
    const deeper = nextStep(c);
    if (deeper) return deeper;
  }
  return null;
}

// Flatten a list into display order: each task followed by its steps (unless collapsed),
// with a depth for indentation. `list` limits which tasks show (e.g. after a filter).
export function flattenTree(list) {
  const ids = new Set(list.map((t) => t.id));
  const roots = list.filter((t) => !t.parent_id || !ids.has(t.parent_id)).sort(taskSort);
  const out = [];
  const walk = (t, depth) => {
    out.push({ t, depth });
    if (isCollapsed(t.id)) return;
    list.filter((c) => c.parent_id === t.id).sort(taskSort).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((t) => walk(t, 0));
  return out;
}

// Can `task` be moved under `target`? (not itself, not its own step, depth within limit)
export function canNestUnder(task, target) {
  if (!target || target.id === task.id || !isOpen(target)) return false;
  if (ancestors(target).some((a) => a.id === task.id)) return false;
  return depthOf(target) + 1 + heightOf(task) <= MAX_DEPTH;
}
