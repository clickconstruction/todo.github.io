// Preferences.
//   Account (user_settings; shared with the MCP server, templates and imports): the time of day
//   plain dates land at, the Forecast tag, and the time zone (kept current from this device).
//   This device (localStorage): Focus, the folders/projects the app is narrowed to.
import { db, app, sb, run, byId, toast } from './state.js';
import { setDefaultTimes } from './dates.js';
import { localTz } from './repeat.js';

export const DEFAULT_SETTINGS = { due_minutes: 1020, defer_minutes: 0, planned_minutes: 540, forecast_tag_id: null, timezone: null };

export async function loadSettings() {
  let row = null;
  try { [row] = await run(sb.from('user_settings').select('*')); } catch { row = null; }
  app.settings = { ...DEFAULT_SETTINGS, ...(row || {}) };
  app.settingsSaved = !!row;
  setDefaultTimes(app.settings);
  // Keep the account's zone current, so agents and schedules use it (quietly, only when it changed).
  const tz = localTz();
  if (app.settings.timezone !== tz) saveSettings({ timezone: tz }, { quiet: true }).catch(() => {});
  return app.settings;
}

export async function saveSettings(fields, { quiet = false } = {}) {
  const [row] = app.settingsSaved
    ? await run(sb.from('user_settings').update(fields).eq('user_id', app.user.id).select())
    : await run(sb.from('user_settings').insert({ ...fields }).select());
  app.settingsSaved = true;
  app.settings = { ...DEFAULT_SETTINGS, ...(row || { ...app.settings, ...fields }) };
  setDefaultTimes(app.settings);
  if (!quiet) toast('Saved');
  return app.settings;
}

export const minutesToInput = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const inputToMinutes = (v) => { const [h, m] = String(v || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };
export const fmtMinutes12 = (m) => new Date(2000, 0, 1, 0, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// ---------- Focus (this device) ----------
const FOCUS_KEY = 'todo.focus';
let focus;
try { focus = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null'); } catch { focus = null; }
export const getFocus = () => (focus && (focus.folders.length || focus.projects.length) ? focus : null);
export function setFocus(next) {
  focus = next && ((next.folders || []).length || (next.projects || []).length) ? { folders: [...new Set(next.folders || [])], projects: [...new Set(next.projects || [])] } : null;
  try { if (focus) localStorage.setItem(FOCUS_KEY, JSON.stringify(focus)); else localStorage.removeItem(FOCUS_KEY); } catch { /* private mode */ }
  app.closedCache = null;
  app.perspectiveClosed = null;
}
// Projects in focus: the chosen ones plus every project in a chosen folder.
export function focusedProjectIds() {
  const f = getFocus();
  if (!f) return null;
  const ids = new Set(f.projects);
  db.projects.forEach((p) => { if (p.folder_id && f.folders.includes(p.folder_id)) ids.add(p.id); });
  return ids;
}
export function focusLabel() {
  const f = getFocus();
  if (!f) return '';
  const names = [...f.folders.map((id) => (byId(db.folders, id) || {}).name), ...f.projects.map((id) => (byId(db.projects, id) || {}).name)].filter(Boolean);
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(' and ') || 'nothing';
}

// Run fn with db narrowed to the focus (views read db directly, so this is the one place it happens).
export function withFocus(fn) {
  const ids = focusedProjectIds();
  if (!ids) return fn();
  const saved = { tasks: db.tasks, projects: db.projects, folders: db.folders };
  const f = getFocus();
  db.projects = saved.projects.filter((p) => ids.has(p.id));
  db.tasks = saved.tasks.filter((t) => t.project_id && ids.has(t.project_id));
  db.folders = saved.folders.filter((x) => f.folders.includes(x.id) || db.projects.some((p) => p.folder_id === x.id));
  try { return fn(); } finally { Object.assign(db, saved); }
}
