// View filter (the "eye"): which actions a list shows, remembered per viewer.
//   show: available (can do now) | remaining (all open) | all (open, completed, dropped)
//   fits: 0 (any) or a number of minutes; only actions estimated at or under it
import { sb, app, run, isOpen, visible, onHoldTagFor, esc } from './state.js';
import { isAvailable } from './availability.js';
import { byDistance } from './places.js';

const KEY = 'todo.filter';
const DEFAULT = { show: 'remaining', fits: 0, sort: 'default', energy: '' };
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
const ENERGIES = [['', 'Any energy'], ['low', '🔋 Low energy'], ['medium', '⚡ Up to medium']];
const LEVEL = { low: 1, medium: 2, high: 3 };
const FITS = [[0, 'Any time'], [5, '≤ 5 min'], [15, '≤ 15 min'], [30, '≤ 30 min'], [60, '≤ 1 hour']];

// One "View" control: closed, it names only what differs from the default (Available · ≤ 15 min);
// open, the selects and Save view. Open/closed is kept across re-renders.
let viewOpen = false;
document.addEventListener('toggle', (e) => { if (e.target.matches && e.target.matches('details.filter-bar')) viewOpen = e.target.open; }, true);
const label = (list, v) => (list.find(([x]) => String(x) === String(v)) || [0, ''])[1];
export function filterSummary() {
  return [filter.show !== DEFAULT.show && label(SHOW, filter.show), Number(filter.fits) && label(FITS, filter.fits), filter.energy && label(ENERGIES, filter.energy).replace(/^\S+\s/, ''),
    filter.sort === 'distance' && app.here && 'Nearest first'].filter(Boolean).join(' · ');
}
export const filterBar = (extra = '') => {
  const sum = filterSummary();
  return `<details class="filter-bar ${sum ? 'on' : ''}" ${viewOpen ? 'open' : ''}><summary><span class="fv-btn"><span aria-hidden="true">☰</span> View</span><span class="fv-sum">${sum ? esc(sum) : 'All open'}</span></summary>
  <div class="fv-body" role="group" aria-label="View filter">
  <label><span aria-hidden="true">👁</span><select data-filter="show" aria-label="Show">${SHOW.map(([v, l]) => `<option value="${v}" ${filter.show === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <label><span aria-hidden="true">⏱</span><select data-filter="fits" aria-label="Fits in">${FITS.map(([v, l]) => `<option value="${v}" ${Number(filter.fits) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <label><span aria-hidden="true">⚡</span><select data-filter="energy" aria-label="Energy">${ENERGIES.map(([v, l]) => `<option value="${v}" ${(filter.energy || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  ${extra}
  ${app.here ? `<label><span aria-hidden="true">↕</span><select data-filter="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}" ${filter.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
  ${sum ? '<button type="button" class="link-btn" data-act="reset-filter">Reset</button>' : ''}
  <button type="button" class="btn small save-persp" data-act="save-perspective" title="Save this view as a perspective">Save as perspective</button>
  </div></details>`;
};

// "Nearest first" (needs a location fix); otherwise the list's own order.
export const sortTasks = (tasks, fallback) => (filter.sort === 'distance' && app.here ? byDistance(tasks, fallback) : [...tasks].sort(fallback));

export function passes(t) {
  // Just-completed items stay visible (struck through) until reload so Undo has context.
  if (!isOpen(t)) return filter.show === 'all' || visible(t);
  if (filter.show === 'available' && !isAvailable(t)) return false;
  const fits = Number(filter.fits);
  if (fits && !(t.estimate_minutes && t.estimate_minutes <= fits)) return false;
  if (filter.energy && !(t.energy && LEVEL[t.energy] <= LEVEL[filter.energy])) return false;
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
export const hiddenForNoEnergy = (tasks) => (filter.energy ? tasks.filter((t) => isOpen(t) && !t.energy).length : 0);
export function hiddenForNoEstimate(tasks) {
  if (!Number(filter.fits)) return 0;
  return tasks.filter((t) => isOpen(t) && !t.estimate_minutes).length;
}

export const filterNote = (tasks) => {
  const n = hiddenForNoEstimate(tasks);
  const ne = hiddenForNoEnergy(tasks);
  const held = filter.show === 'available' ? tasks.filter((t) => isOpen(t) && onHoldTagFor(t)).length : 0;
  return [n ? `${n} without an estimate hidden by “fits in”.` : '', ne ? `${ne} without an energy level hidden by the energy filter.` : '', held ? `⏸ ${held} on hold hidden · <button class="link-btn" data-act="show-remaining">Show</button>` : '']
    .filter(Boolean).map((x) => `<p class="view-sub filter-note">${x}</p>`).join('');
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
