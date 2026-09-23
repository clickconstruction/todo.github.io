// Reads and writes. Every write goes to Supabase first, then updates `db`.
import { sb, db, app, run, syncRow, toast, byId } from './state.js';
import { openCompletionNote } from './editors/completion.js';

const OUTBOX_KEY = 'todo.outbox';

export async function loadAll() {
  const since = new Date(Date.now() - 86400000).toISOString();
  const [tasks, projects, folders, tags, taskTags, projectTags] = await Promise.all([
    run(sb.from('tasks').select('*').or(`and(completed_at.is.null,dropped_at.is.null),completed_at.gte.${since}`)),
    run(sb.from('projects').select('*')),
    run(sb.from('folders').select('*')),
    run(sb.from('tags').select('*')),
    run(sb.from('task_tags').select('*')),
    run(sb.from('project_tags').select('*')),
  ]);
  Object.assign(db, { tasks, projects, folders, tags, taskTags, projectTags });
}

// Some writes fire database triggers (group completion, complete-with-last-action,
// review dates), so re-read the rows they can touch.
export async function refreshTasks(ids) {
  if (!ids.length) return;
  const rows = await run(sb.from('tasks').select('*').in('id', ids));
  rows.forEach((row) => { if (byId(db.tasks, row.id)) syncRow('tasks', null, row); else db.tasks.push(row); });
}
export async function refreshProject(id) {
  if (!id) return;
  const [row] = await run(sb.from('projects').select('*').eq('id', id));
  if (row) syncRow('projects', row, row);
}

// Captures made offline wait in localStorage and are sent on the next load.
function queueCapture(title) {
  const box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
  box.push({ title, created_at: new Date().toISOString() });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
}
export async function flushOutbox() {
  let box;
  try { box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { box = []; }
  if (!box.length || !navigator.onLine) return;
  const { data, error } = await sb.from('tasks').insert(box.map((b) => ({ title: b.title, created_at: b.created_at }))).select();
  if (error) return;
  localStorage.removeItem(OUTBOX_KEY);
  db.tasks.push(...data);
  toast(`Synced ${data.length} offline capture${data.length === 1 ? '' : 's'}`);
}

export async function capture(title, extra = {}) {
  title = title.trim();
  if (!title) return;
  if (!navigator.onLine) {
    queueCapture(title);
    toast('Saved offline; will sync when back online');
    return;
  }
  const [row] = await run(sb.from('tasks').insert({ title, ...extra }).select());
  db.tasks.push(row);
  app.render();
}

export async function setCompleted(task, done) {
  const completed_at = done ? new Date().toISOString() : null;
  const [row] = await run(sb.from('tasks').update({ completed_at }).eq('id', task.id).select());
  task = syncRow('tasks', task, row);
  await afterTaskWrite(task);
  app.doneCache = null;
  app.render();
  if (done) toast('Completed', [{ label: 'Add note', run: () => openCompletionNote(task) }, { label: 'Undo', run: () => setCompleted(task, false) }]);
}

// Refresh what database triggers may have changed: the parent group and the project.
export async function afterTaskWrite(task) {
  await Promise.all([
    task.parent_id ? refreshTasks([task.parent_id]) : null,
    task.project_id ? refreshProject(task.project_id) : null,
  ]);
}

export async function saveTask(task, fields, tagIds) {
  // Anything with no project, no tags and no parent action lives in the Inbox, so nothing falls out of every list.
  fields.in_inbox = !(fields.project_id || fields.parent_id || tagIds.length);
  let row;
  if (task) {
    [row] = await run(sb.from('tasks').update(fields).eq('id', task.id).select());
    syncRow('tasks', task, row);
  } else {
    [row] = await run(sb.from('tasks').insert(fields).select());
    db.tasks.push(row);
  }
  await setLinks('task_tags', 'taskTags', 'task_id', row.id, tagIds);
  await afterTaskWrite(row);
  app.render();
  return row;
}

// Replace the tag links of one task or project (task_tags / project_tags).
export async function setLinks(table, key, idCol, ownerId, tagIds) {
  const current = db[key].filter((x) => x[idCol] === ownerId).map((x) => x.tag_id);
  const add = tagIds.filter((id) => !current.includes(id));
  const remove = current.filter((id) => !tagIds.includes(id));
  if (add.length) {
    const rows = await run(sb.from(table).insert(add.map((tag_id) => ({ [idCol]: ownerId, tag_id }))).select());
    db[key].push(...rows);
  }
  if (remove.length) {
    await run(sb.from(table).delete().eq(idCol, ownerId).in('tag_id', remove));
    db[key] = db[key].filter((x) => !(x[idCol] === ownerId && remove.includes(x.tag_id)));
  }
}

// "Waiting : Hiro" creates (or reuses) parent tag "Waiting" and child "Hiro".
export async function ensureTag(label) {
  const parts = label.split(':').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let parent = null;
  for (const name of parts.slice(0, 2)) {
    let tag = db.tags.find((t) => t.name.toLowerCase() === name.toLowerCase() && (t.parent_id || null) === (parent ? parent.id : null));
    if (!tag) {
      [tag] = await run(sb.from('tags').insert({ name, parent_id: parent ? parent.id : null, sort: db.tags.length }).select());
      db.tags.push(tag);
    }
    parent = tag;
  }
  return parent;
}

export async function createTag() {
  const label = prompt('Tag name (use "Parent : Child" to nest, e.g. Waiting : Hiro)');
  if (!label) return;
  await ensureTag(label);
  app.render();
}

export async function insertFolder(name) {
  name = (name || '').trim();
  if (!name) return null;
  const existing = db.folders.find((f) => !f.archived_at && f.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const [row] = await run(sb.from('folders').insert({ name, sort: db.folders.length }).select());
  db.folders.push(row);
  return row;
}

export async function updateProject(project, fields) {
  const [row] = await run(sb.from('projects').update(fields).eq('id', project.id).select());
  syncRow('projects', project, row);
  app.render();
  return row;
}

export async function updateTask(task, fields) {
  const [row] = await run(sb.from('tasks').update(fields).eq('id', task.id).select());
  syncRow('tasks', task, row);
  await afterTaskWrite(row);
  app.render();
  return row;
}
