// View filter (the "eye"): which actions a list shows, remembered per viewer.
//   show: available (can do now) | remaining (all open) | all (open, completed, dropped)
//   fits: 0 (any) or a number of minutes; only actions estimated at or under it
import { sb, app, run, isOpen, visible } from './state.js';
import { isAvailable } from './availability.js';
import { byDistance } from './places.js';

const KEY = 'todo.filter';
const DEFAULT = { show: 'remaining', fits: 0, sort: 'default' };
let filter;
try { filter = { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { filter = { ...DEFAULT }; }
export const getFilter = () => filter;

export function setFilter(patch) {
  filter = { ...filter, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(filter)); } catch { /* private mode */ }
  app.closedCache = null;
}

const SHOW = [['available', 'Available'], ['remaining', 'Remaining'], ['all', 'All']];
const SORTS = [['default', 'Default order'], ['distance', 'Nearest first']];
const FITS = [[0, 'Any time'], [5, '≤ 5 min'], [15, '≤ 15 min'], [30, '≤ 30 min'], [60, '≤ 1 hour']];

export const filterBar = (extra = '') => `<div class="filter-bar" role="group" aria-label="View filter">
  <label><span aria-hidden="true">👁</span><select data-filter="show" aria-label="Show">${SHOW.map(([v, l]) => `<option value="${v}" ${filter.show === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <label><span aria-hidden="true">⏱</span><select data-filter="fits" aria-label="Fits in">${FITS.map(([v, l]) => `<option value="${v}" ${Number(filter.fits) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  ${extra}
  ${app.here ? `<label><span aria-hidden="true">↕</span><select data-filter="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}" ${filter.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
  <button type="button" class="btn small save-persp" data-act="save-perspective" title="Save this view as a perspective">🔭 Save view</button>
</div>`;

// "Nearest first" (needs a location fix); otherwise the list's own order.
export const sortTasks = (tasks, fallback) => (filter.sort === 'distance' && app.here ? byDistance(tasks, fallback) : [...tasks].sort(fallback));

export function passes(t) {
  // Just-completed items stay visible (struck through) until reload so Undo has context.
  if (!isOpen(t)) return filter.show === 'all' || visible(t);
  if (filter.show === 'available' && !isAvailable(t)) return false;
  const fits = Number(filter.fits);
  if (fits && !(t.estimate_minutes && t.estimate_minutes <= fits)) return false;
  return true;
}

// Keep every ancestor visible (as context) when any of its steps pass.
export function applyFilter(tasks) {
  const byIdMap = new Map(tasks.map((t) => [t.id, t]));
  const shown = new Set(tasks.filter(passes).map((t) => t.id));
  [...shown].forEach((id) => {
    let p = byIdMap.get(id);
    for (let i = 0; i < 10 && p && p.parent_id; i++) { shown.add(p.parent_id); p = byIdMap.get(p.parent_id); }
  });
  return tasks.filter((t) => shown.has(t.id));
}

// How many were hidden only because they have no estimate (so "fits in" isn't silently lossy).
export function hiddenForNoEstimate(tasks) {
  if (!Number(filter.fits)) return 0;
  return tasks.filter((t) => isOpen(t) && !t.estimate_minutes).length;
}

export const filterNote = (tasks) => {
  const n = hiddenForNoEstimate(tasks);
  return n ? `<p class="view-sub filter-note">${n} without an estimate hidden by “fits in”.</p>` : '';
};

// "All" includes completed and dropped items, which aren't all loaded locally.
// key identifies the list; query builds the Supabase request for closed rows.
export function closedFor(key, query) {
  if (filter.show !== 'all') return [];
  const cached = app.closedCache;
  if (cached && cached.key === key) return cached.rows;
  app.closedCache = { key, rows: [] }; // placeholder while loading, so we fetch once
  run(query(sb.from('tasks').select('*').or('completed_at.not.is.null,dropped_at.not.is.null').order('updated_at', { ascending: false }).limit(300)))
    .then((rows) => { if (app.closedCache && app.closedCache.key === key) { app.closedCache.rows = rows; app.render(); } })
    .catch(() => { app.closedCache = null; });
  return [];
}

// Merge closed rows into a local list without duplicates.
export const withClosed = (tasks, closed) => {
  const ids = new Set(tasks.map((t) => t.id));
  return [...tasks, ...closed.filter((t) => !ids.has(t.id))];
};
