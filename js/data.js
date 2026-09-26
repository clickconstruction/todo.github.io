// Reads and writes. Every write goes to Supabase first, then updates `db`.
import { sb, db, app, run, syncRow, toast, byId, isOpen, taskSort, onHoldTagFor } from './state.js';
import { loadSettings } from './prefs.js';
import { openCompletionNote } from './editors/completion.js';
import { saveReminders, refreshReminders } from './editors/notifyField.js';
import { uploadFiles } from './editors/attachField.js';
import { ancestors, descendants, stepsOf } from './tree.js';
import { isAvailable } from './availability.js';

const OUTBOX_KEY = 'todo.outbox';

// The API returns at most 1,000 rows a request: big tables are read a page at a time, in key order.
const PAGE = 1000;
async function every(query, ...keys) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = query();
    keys.forEach((k) => { q = q.order(k); });
    const rows = await run(q.range(from, from + PAGE - 1));
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function loadAll() {
  const since = new Date(Date.now() - 86400000).toISOString();
  const [tasks, projects, folders, tags, taskTags, projectTags, places, notifications, attachments, perspectives, templates, calendars, people, references, weeklyReviews, areas, goals, checklists, checklistRuns, dailyReviews, imports, slipbox, reviewSessions, taskWaits, events] = await Promise.all([
    every(() => sb.from('tasks').select('*').or(`and(completed_at.is.null,dropped_at.is.null),completed_at.gte.${since}`), 'id'),
    every(() => sb.from('projects').select('*'), 'id'),
    every(() => sb.from('folders').select('*'), 'id'),
    every(() => sb.from('tags').select('*'), 'id'),
    every(() => sb.from('task_tags').select('*'), 'task_id', 'tag_id'),
    every(() => sb.from('project_tags').select('*'), 'project_id', 'tag_id'),
    run(sb.from('places').select('*')),
    run(sb.from('notifications').select('*')),
    run(sb.from('attachments').select('*').is('archived_at', null)),
    run(sb.from('perspectives').select('*').order('sort')),
    run(sb.from('project_templates').select('*').order('sort')),
    run(sb.from('calendars').select('*').order('sort')),
    run(sb.from('people').select('*').order('sort')),
    run(sb.from('reference_items').select('*').is('archived_at', null)),
    run(sb.from('weekly_reviews').select('*').order('started_at', { ascending: false }).limit(30)),
    run(sb.from('areas').select('*').order('sort')),
    run(sb.from('goals').select('*').order('sort')),
    run(sb.from('checklists').select('*').order('sort')),
    run(sb.from('checklist_runs').select('*').order('started_at', { ascending: false }).limit(300)),
    run(sb.from('daily_reviews').select('*').order('day', { ascending: false }).limit(60)),
    run(sb.from('imports').select('*').order('created_at', { ascending: false }).limit(20)),
    every(() => sb.from('slipbox_notes').select('*').is('archived_at', null), 'id'),
    run(sb.from('review_sessions').select('id,title,status,current_item,created_at').eq('status', 'active').order('created_at', { ascending: false }).limit(10)),
    every(() => sb.from('task_waits').select('*'), 'task_id', 'waits_for'),
    every(() => sb.from('events').select('*').is('archived_at', null), 'id'),
  ]);
  Object.assign(db, { tasks, projects, folders, tags, taskTags, projectTags, places, notifications, attachments, perspectives, templates, calendars, people, references, weeklyReviews, areas, goals, checklists, checklistRuns, dailyReviews, imports, slipbox, reviewSessions, taskWaits, events });
  // Cards that events point at but that aren't loaded any more (completed a while ago): fetched so the link still reads.
  const linked = [...new Set(events.map((e) => e.task_id).filter((id) => id && !byId(tasks, id)))];
  db.eventTasks = linked.length ? await run(sb.from('tasks').select('*').in('id', linked.slice(0, 1000))) : [];
  await loadSettings();
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
function queueCapture(title, gain = '') {
  const box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
  box.push({ title, gain: gain || '', created_at: new Date().toISOString() });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
}
export async function flushOutbox() {
  let box;
  try { box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { box = []; }
  if (!box.length || !navigator.onLine) return;
  const { data, error } = await sb.from('tasks').insert(box.map((b) => ({ title: b.title, gain: b.gain || '', created_at: b.created_at }))).select();
  if (error) return;
  localStorage.removeItem(OUTBOX_KEY);
  db.tasks.push(...data);
  toast(`Synced ${data.length} offline capture${data.length === 1 ? '' : 's'}`);
}

export async function capture(title, extra = {}) {
  title = title.trim();
  if (!title) return null;
  if (!navigator.onLine) {
    queueCapture(title, extra.gain);
    toast('Saved offline; will sync when back online');
    return null;
  }
  // New project actions go to the end (order matters in sequential projects).
  if (extra.project_id && extra.sort === undefined) {
    extra.sort = Math.max(-1, ...db.tasks.filter((t) => t.project_id === extra.project_id && !t.parent_id).map((t) => t.sort || 0)) + 1;
  }
  const [row] = await run(sb.from('tasks').insert({ title, ...extra }).select());
  db.tasks.push(row);
  app.render();
  return row;
}

// Rows the database created on its own since `since` (the next occurrence of a repeating
// action or project, with its tags); merged into db. Returns the new tasks and projects.
export async function pullNewSince(since) {
  const [tasks, projects] = await Promise.all([
    run(sb.from('tasks').select('*').gte('created_at', since)),
    run(sb.from('projects').select('*').gte('created_at', since)),
  ]);
  const freshT = tasks.filter((t) => !byId(db.tasks, t.id));
  const freshP = projects.filter((p) => !byId(db.projects, p.id));
  db.tasks.push(...freshT);
  db.projects.push(...freshP);
  const [tt, pt] = await Promise.all([
    freshT.length ? run(sb.from('task_tags').select('*').in('task_id', freshT.map((t) => t.id))) : [],
    freshP.length ? run(sb.from('project_tags').select('*').in('project_id', freshP.map((p) => p.id))) : [],
  ]);
  db.taskTags.push(...tt);
  db.projectTags.push(...pt);
  return { tasks: freshT, projects: freshP };
}

const fmtNext = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export async function setCompleted(task, done) {
  const completed_at = done ? new Date().toISOString() : null;
  const repeating = done && task.repeat_rule;
  const openBefore = ancestors(task).filter(isOpen).map((a) => a.id);
  const since = new Date(Date.now() - 2000).toISOString();
  const project = task.project_id && byId(db.projects, task.project_id);
  const projectWasOpen = project && ['active', 'on_hold'].includes(project.status);
  const blockedBefore = done ? new Set(waitersOf(task).filter((w) => !isAvailable(w)).map((w) => w.id)) : new Set();
  const [row] = await run(sb.from('tasks').update({ completed_at }).eq('id', task.id).select());
  task = syncRow('tasks', task, row);
  const next = repeating ? (await pullNewSince(since)).tasks.find((t) => t.title === task.title && !t.completed_at) : null;
  await afterTaskWrite(task);
  app.doneCache = null;
  app.render();
  if (!done) return;
  // The database may have completed the project too ("complete with last action").
  const projectDone = projectWasOpen && byId(db.projects, task.project_id).status === 'completed';
  const nextAt = next && (next.due_at || next.planned_at || next.defer_at);
  // Finishing the last step completes the level(s) above: celebrate the biggest one.
  const finished = done ? ancestors(task).filter((a) => a.completed_at && openBefore.includes(a.id)) : [];
  const elephant = finished[finished.length - 1];
  const freed = waitersOf(task).filter((w) => blockedBefore.has(w.id) && isAvailable(w));
  const freedMsg = freed.length ? ` · now available: ${freed.length === 1 ? `“${freed[0].title}”` : `${freed.length} cards`}` : '';
  const msg = (elephant ? `🎉 Last step done · “${elephant.title}” is complete` : projectDone ? `Completed · “${project.name}” is done too` : next ? `Completed · next one ${nextAt ? fmtNext(nextAt) : 'is ready'}` : 'Completed') + freedMsg;
  toast(msg, [{ label: task.gain ? 'Did you gain it?' : 'Add note', run: () => openCompletionNote(task) },
    { label: 'Undo', run: () => undoComplete(task, projectDone && project, next, repeating) }]);
}

// Undo also retires the next occurrence a repeat created (dropped, since nothing is deleted)
// and gives the reopened action its repeat back.
async function undoComplete(task, reopenProject, next, rule) {
  if (next) {
    const [r] = await run(sb.from('tasks').update({ dropped_at: new Date().toISOString() }).eq('id', next.id).select());
    syncRow('tasks', next, r);
  }
  await setCompleted(task, false);
  if (rule) await updateTask(byId(db.tasks, task.id) || task, { repeat_rule: rule });
  if (reopenProject) await updateProject(byId(db.projects, reopenProject.id), { status: 'active' });
}

// Add a sub-action under an action (making it a group). Children inherit the project.
export async function addSubAction(parent, title) {
  const [row] = await breakDown(parent, [title]);
  return row || null;
}

// ---------- steps ----------
// Add steps to a task (the database puts them in the task's project and out of the Inbox).
export async function breakDown(parent, titles, { inOrder } = {}) {
  const clean = titles.map((t) => String(t || '').trim()).filter(Boolean);
  const base = Math.max(-1, ...db.tasks.filter((t) => t.parent_id === parent.id).map((t) => t.sort || 0)) + 1;
  let rows = [];
  if (clean.length) {
    rows = await run(sb.from('tasks').insert(clean.map((title, i) => ({ title, parent_id: parent.id, project_id: parent.project_id, in_inbox: false, sort: base + i }))).select());
    db.tasks.push(...rows);
  }
  if (inOrder !== undefined && !!inOrder !== !!parent.steps_in_order) {
    const [r] = await run(sb.from('tasks').update({ steps_in_order: !!inOrder }).eq('id', parent.id).select());
    syncRow('tasks', parent, r);
  }
  if (rows.length) await afterTaskWrite(rows[0]); // new open steps reopen a finished parent
  app.render();
  return rows;
}

// Put a task under another (or at the top level with null). Steps come along; the database
// checks loops and depth, and moves the task into the new parent's project.
export async function moveUnder(task, parent, { sort } = {}) {
  const oldAncestors = ancestors(task);
  const fields = { parent_id: parent ? parent.id : null };
  fields.sort = sort ?? (parent ? Math.max(-1, ...stepsOf(parent).map((t) => t.sort || 0)) + 1 : task.sort);
  if (!parent) fields.in_inbox = !task.project_id && !db.taskTags.some((x) => x.task_id === task.id);
  const [row] = await run(sb.from('tasks').update(fields).eq('id', task.id).select());
  syncRow('tasks', task, row);
  await Promise.all([afterTaskWrite(task), oldAncestors.length ? refreshTasks(oldAncestors.map((a) => a.id)) : null]);
  app.render();
  return row;
}

// Reorder mode ⇥: become the last step of the open sibling just above.
export async function indentTask(task) {
  const sibs = db.tasks.filter((t) => t.project_id === task.project_id && (t.parent_id || null) === (task.parent_id || null) && isOpen(t)
    && (task.project_id || t.in_inbox === task.in_inbox)).sort(taskSort);
  const above = sibs[sibs.findIndex((t) => t.id === task.id) - 1];
  if (!above) { toast('Nothing above to put it under'); return; }
  try { await moveUnder(task, above); } catch { /* the database explains (depth) in a toast */ }
}

// Reorder mode ⇤: move up a level, just after its old parent.
export async function outdentTask(task) {
  const parent = task.parent_id && byId(db.tasks, task.parent_id);
  if (!parent) return;
  const grand = parent.parent_id ? byId(db.tasks, parent.parent_id) : null;
  await moveUnder(task, grand, { sort: (parent.sort || 0) + 0.5 });
}

// The steps become a project's actions; the task is dropped with a note (nothing is deleted).
export async function convertToProject(task) {
  const pid = await run(sb.rpc('convert_to_project', { task_id: task.id }));
  await loadAll();
  app.render();
  return Array.isArray(pid) ? pid[0] : pid;
}

// ---------- waits for ----------
// Cards waiting for this one (or for anything in its tree, which closes with it).
export function waitersOf(task) {
  const tree = [task, ...descendants(task)].map((t) => t.id);
  const ids = new Set((db.taskWaits || []).filter((w) => tree.includes(w.waits_for)).map((w) => w.task_id));
  return db.tasks.filter((t) => ids.has(t.id) && isOpen(t));
}
// Link a card to one it waits for; the database refuses loops and a card's own steps (toast).
export async function addWait(task, other) {
  const rows = await run(sb.from('task_waits').insert({ task_id: task.id, waits_for: other.id }).select());
  db.taskWaits.push(...rows);
  app.render();
}
export async function removeWait(task, otherId) {
  await run(sb.from('task_waits').delete().eq('task_id', task.id).eq('waits_for', otherId));
  db.taskWaits = db.taskWaits.filter((w) => !(w.task_id === task.id && w.waits_for === otherId));
  app.render();
}

// Review: stamp the project as reviewed now; the database derives next_review_at.
export const markReviewed = (project) => updateProject(project, { last_reviewed_at: new Date().toISOString() });

// Apply the same change to many tasks at once, with one Undo that restores each task's old values.
export async function bulkUpdate(tasks, fieldsFor, label) {
  if (!tasks.length) return;
  const before = tasks.map((t) => ({ t, old: Object.fromEntries(Object.keys(fieldsFor(t)).map((k) => [k, t[k]])) }));
  await Promise.all(tasks.map(async (t) => {
    const [row] = await run(sb.from('tasks').update(fieldsFor(t)).eq('id', t.id).select());
    syncRow('tasks', t, row);
  }));
  app.render();
  toast(label, { label: 'Undo', run: async () => {
    await Promise.all(before.map(async ({ t, old }) => {
      const [row] = await run(sb.from('tasks').update(old).eq('id', t.id).select());
      syncRow('tasks', t, row);
    }));
    app.render();
  } });
}

// Move an action up/down among its siblings (same project and parent), renumbering sort.
export async function moveTask(task, dir) {
  const siblings = db.tasks.filter((t) => t.project_id === task.project_id && (t.parent_id || null) === (task.parent_id || null) && isOpen(t)).sort(taskSort);
  const i = siblings.findIndex((t) => t.id === task.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= siblings.length) return;
  [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
  const changed = siblings.map((t, sort) => ({ t, sort })).filter(({ t, sort }) => t.sort !== sort);
  await Promise.all(changed.map(async ({ t, sort }) => {
    const [row] = await run(sb.from('tasks').update({ sort }).eq('id', t.id).select());
    syncRow('tasks', t, row);
  }));
  app.render();
}

// Refresh what database triggers may have changed: every ancestor (a finished last step completes
// the level above, all the way up), every step below (closed with their parent, or moved with it
// to another project) and the project (complete with last action).
export async function afterTaskWrite(task) {
  const tree = [task, ...ancestors(task), ...descendants(task)].map((t) => t.id);
  const waiters = (db.taskWaits || []).filter((w) => tree.includes(w.waits_for)).map((w) => w.task_id);
  const ids = [...new Set([...tree.slice(1), ...waiters])];
  await Promise.all([
    ids.length ? refreshTasks(ids) : null,
    task.project_id ? refreshProject(task.project_id) : null,
  ]);
}

export async function saveTask(task, fields, tagIds) {
  const reminders = fields.notifications;
  const files = fields.attachments_pending;
  delete fields.notifications; // kept in their own tables
  delete fields.attachments_pending;
  // Anything with no project, no tags, no parent action and no person (waiting on / agenda) lives in the
  // Inbox, so nothing falls out of every list. A tickled item stays in the Inbox (hidden until its day).
  const eff = (k) => (k in fields ? fields[k] : task ? task[k] : null);
  fields.in_inbox = !!eff('tickler') || !(fields.project_id || fields.parent_id || tagIds.length || eff('waiting_on') || eff('agenda_for'));
  let row;
  const since = new Date(Date.now() - 2000).toISOString();
  const completesRepeat = task && !task.completed_at && fields.completed_at && (fields.repeat_rule || task.repeat_rule);
  if (task) {
    [row] = await run(sb.from('tasks').update(fields).eq('id', task.id).select());
    syncRow('tasks', task, row);
    if (completesRepeat) await pullNewSince(since); // the database made the next occurrence
  } else {
    [row] = await run(sb.from('tasks').insert(fields).select());
    db.tasks.push(row);
  }
  await setLinks('task_tags', 'taskTags', 'task_id', row.id, tagIds);
  await saveReminders('task_id', row.id, reminders);
  if (files && files.length) await uploadFiles('task_id', row.id, files);
  await refreshReminders('task_id', row.id);
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

// Move a repeating action to its next occurrence without completing it (database function).
export async function skipOccurrence(task, after = () => {}) {
  const before = { defer_at: task.defer_at, planned_at: task.planned_at, due_at: task.due_at, repeat_rule: task.repeat_rule };
  const row = await run(sb.rpc('repeat_skip', { task_id: task.id }));
  const saved = syncRow('tasks', task, Array.isArray(row) ? row[0] : row);
  after();
  app.render();
  toast('Skipped to the next occurrence', { label: 'Undo', run: async () => {
    const [r] = await run(sb.from('tasks').update(before).eq('id', saved.id).select());
    syncRow('tasks', saved, r);
    app.render();
  } });
}

export async function updateTag(tag, fields) {
  const [row] = await run(sb.from('tags').update(fields).eq('id', tag.id).select());
  syncRow('tags', tag, row);
  app.render();
  return row;
}

// Put a tag on hold (parks its actions), drop it (retire it) or make it active again; with Undo.
export async function setTagStatus(tag, status) {
  const before = tag.status || 'active';
  if (!tag || before === status) return;
  await updateTag(tag, { status });
  const parked = status === 'on_hold' ? db.tasks.filter((t) => isOpen(t) && onHoldTagFor(t)).length : 0;
  const msg = status === 'on_hold' ? `⏸ “${tag.name}” is on hold${parked ? ` · ${parked} action${parked === 1 ? '' : 's'} parked` : ''}`
    : status === 'dropped' ? `“${tag.name}” dropped: hidden from tag pickers` : `“${tag.name}” is active again`;
  toast(msg, [{ label: 'Undo', run: () => updateTag(byId(db.tags, tag.id), { status: before }) }]);
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
  const since = new Date(Date.now() - 2000).toISOString();
  const repeating = project.repeat_rule && fields.status === 'completed' && project.status !== 'completed';
  const [row] = await run(sb.from('projects').update(fields).eq('id', project.id).select());
  syncRow('projects', project, row);
  if (repeating) {
    const { projects } = await pullNewSince(since);
    const copy = projects[0];
    if (copy) toast(`Completed · “${copy.name}” starts again${copy.due_at || copy.defer_at ? ` ${fmtNext(copy.due_at || copy.defer_at)}` : ''}`);
  }
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
