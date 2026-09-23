// Shared state and small helpers. All data for the signed-in user is loaded into
// `db`; views render from it, and writes go to Supabase first, then update `db`.
// Cross-module hooks (render, caches) live on `app` to avoid circular imports.

export const sb = window.sb;
export const $ = (sel, root = document) => root.querySelector(sel);

export const db = { tasks: [], projects: [], folders: [], tags: [], taskTags: [], projectTags: [] };

export const app = {
  user: null,
  render: () => {},
  doneCache: null, // { key, rows } for the Done view
  searchExtra: [], // completed/dropped search matches fetched from the server
  showInactive: false, // Projects view: show completed/dropped projects and archived folders
  reorder: null, // project id currently in reorder mode
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const byId = (list, id) => list.find((x) => x.id === id);
// loadAll() replaces db arrays when the app regains focus, so an object captured
// when a sheet opened may be stale by the time it saves. Write through by id.
export const syncRow = (key, stale, row) => Object.assign(byId(db[key], row.id) || stale, row);

export const isOpen = (t) => !t.completed_at && !t.dropped_at;
// Keep just-completed tasks visible (struck through) until the next reload, so Undo has context.
const sessionStart = new Date();
export const visible = (t) => isOpen(t) || (t.completed_at && new Date(t.completed_at) > sessionStart);

export const taskSort = (a, b) => (a.sort - b.sort) || (new Date(a.created_at) - new Date(b.created_at));
export const bySort = (a, b) => a.sort - b.sort || a.name.localeCompare(b.name);
export const PROJECT_STATUSES = [['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['dropped', 'Dropped']];

export const tagsFor = (taskId) => db.taskTags.filter((x) => x.task_id === taskId).map((x) => byId(db.tags, x.tag_id)).filter(Boolean);
export const tagLabel = (tag) => {
  const parent = tag.parent_id && byId(db.tags, tag.parent_id);
  return parent ? `${parent.name} : ${tag.name}` : tag.name;
};
export const sortedTags = () => {
  const roots = db.tags.filter((t) => !t.parent_id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return roots.flatMap((r) => [r, ...db.tags.filter((t) => t.parent_id === r.id).sort((a, b) => a.name.localeCompare(b.name))]);
};

export function toast(msg, actions) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  const list = [].concat(actions || []);
  list.forEach((action) => {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.run(); };
    el.appendChild(b);
  });
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, list.length ? 6000 : 2500);
}

export async function run(promise) {
  const { data, error } = await promise;
  if (error) { toast(error.message); throw error; }
  return data;
}

// Every sheet (editors, quick entry, token) shares one <dialog>; each opener starts compact.
export function openSheet(html) {
  const sheet = $('#sheet');
  sheet.classList.remove('full');
  sheet.innerHTML = html;
  return sheet;
}
