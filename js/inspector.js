// Desktop inspector (≥1100px): a right-hand panel that edits the selected action or
// project in place. Phones and narrower windows keep using the pop-up sheet.
import { db, app, $, byId } from './state.js';
import { renderTaskInspector } from './editors/task.js';
import { renderProjectInspector } from './editors/project.js';

const WIDE = window.matchMedia('(min-width: 1100px)');
// Tests can pin the mode (dev/smoke.js): __forceWide / __forceSheet.
export const isWide = () => (window.__forceWide ? true : window.__forceSheet ? false : WIDE.matches);
const panel = () => $('#inspector');

export function select(type, id) {
  const form = panel() && $('form', panel());
  const flush = form && form.flushSave ? form.flushSave() : null; // don't lose pending edits
  app.selected = { type, id };
  Promise.resolve(flush).then(() => { highlight(); renderInspector(true); });
}

export function clearSelection() {
  app.selected = null;
  highlight();
  renderInspector(true);
}

function highlight() {
  document.querySelectorAll('#view .row.selected').forEach((el) => el.classList.remove('selected'));
  const s = app.selected;
  if (s && s.type === 'task') {
    const row = document.querySelector(`#view [data-task="${s.id}"]`);
    if (row) row.classList.add('selected');
  }
}

// Current project page, if any (its project shows in the inspector when nothing is selected).
const pageProject = () => {
  const [view, id] = location.hash.slice(1).split('/');
  return view === 'project' || view === 'review' ? byId(db.projects, id || (app.review && app.review.current)) : null;
};

// Identifies what the panel is showing; the editors update it after their own saves.
export const inspectorKey = (type, row) => `${type}:${row.id}:${row.updated_at}`;

// Re-render after data changes, but never while the user is typing in the panel.
export function renderInspector(force = false) {
  const el = panel();
  if (!el) return;
  el.hidden = !isWide();
  document.body.classList.toggle('has-inspector', isWide());
  if (!isWide()) return;
  // Skip while typing in the panel, or while the panel's own save is re-rendering the app.
  if (!force && (el.contains(document.activeElement) || el.dataset.saving)) { highlight(); return; }
  const s = app.selected;
  const task = s && s.type === 'task' && byId(db.tasks, s.id);
  const project = s && s.type === 'project' ? byId(db.projects, s.id) : !task && pageProject();
  const key = task ? inspectorKey('t', task) : project ? inspectorKey('p', project) : 'none';
  if (!force && el.dataset.key === key) { highlight(); return; }
  el.dataset.key = key;
  if (task) renderTaskInspector(el, task);
  else if (project) renderProjectInspector(el, project);
  else el.innerHTML = `<div class="inspector-empty"><p>Select an action to inspect it here.</p><p class="hint">↑ ↓ to move · Esc to clear · ⌘↵ to save now</p></div>`;
  highlight();
}

// ↑/↓ move the selection through the visible rows.
export function moveSelection(dir) {
  const rows = [...document.querySelectorAll('#view [data-task]')];
  if (!rows.length) return;
  const cur = app.selected && app.selected.type === 'task' ? rows.findIndex((r) => r.dataset.task === app.selected.id) : -1;
  const next = rows[Math.min(rows.length - 1, Math.max(0, cur + dir))];
  select('task', next.dataset.task);
  next.scrollIntoView({ block: 'nearest' });
}

WIDE.addEventListener('change', () => renderInspector(true));
