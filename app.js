// Todo Tooling: GTD inbox, today, projects and tags on Supabase.
// All data for the signed-in user is loaded into `db` and views render from it;
// writes go to Supabase first, then update `db` and re-render.
(function () {
  'use strict';

  const sb = window.sb;
  const $ = (sel, root = document) => root.querySelector(sel);
  const OUTBOX_KEY = 'todo.outbox';

  const db = { tasks: [], projects: [], folders: [], tags: [], taskTags: [] };
  let user = null;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const byId = (list, id) => list.find((x) => x.id === id);
  // loadAll() replaces db arrays when the app regains focus, so an object captured
  // when a sheet opened may be stale by the time it saves. Write through by id.
  const syncRow = (key, stale, row) => Object.assign(byId(db[key], row.id) || stale, row);
  const isOpen = (t) => !t.completed_at && !t.dropped_at;
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
  const isOverdue = (t) => t.due_at && new Date(t.due_at) < startOfToday();
  const isDueToday = (t) => t.due_at && new Date(t.due_at) <= endOfToday();
  const isDeferred = (t) => t.defer_at && new Date(t.defer_at) > new Date();

  function fmtDate(iso) {
    const d = new Date(iso);
    const today = startOfToday();
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }
  // <input type=date> value <-> timestamptz. Due dates land at 5pm local, defer dates at midnight.
  const toDateInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fromDateInput = (v, hour) => {
    if (!v) return null;
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d, hour).toISOString();
  };

  const tagsFor = (taskId) => db.taskTags.filter((x) => x.task_id === taskId).map((x) => byId(db.tags, x.tag_id)).filter(Boolean);
  const tagLabel = (tag) => {
    const parent = tag.parent_id && byId(db.tags, tag.parent_id);
    return parent ? `${parent.name} : ${tag.name}` : tag.name;
  };
  const sortedTags = () => {
    const roots = db.tags.filter((t) => !t.parent_id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    return roots.flatMap((r) => [r, ...db.tags.filter((t) => t.parent_id === r.id).sort((a, b) => a.name.localeCompare(b.name))]);
  };
  const taskSort = (a, b) => (a.sort - b.sort) || (new Date(a.created_at) - new Date(b.created_at));

  function toast(msg, actions) {
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
  const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  async function run(promise) {
    const { data, error } = await promise;
    if (error) { toast(error.message); throw error; }
    return data;
  }

  // ---------- data ----------
  async function loadAll() {
    const since = new Date(Date.now() - 86400000).toISOString();
    const [tasks, projects, folders, tags, taskTags] = await Promise.all([
      run(sb.from('tasks').select('*').or(`and(completed_at.is.null,dropped_at.is.null),completed_at.gte.${since}`)),
      run(sb.from('projects').select('*')),
      run(sb.from('folders').select('*')),
      run(sb.from('tags').select('*')),
      run(sb.from('task_tags').select('*')),
    ]);
    Object.assign(db, { tasks, projects, folders, tags, taskTags });
  }

  // Captures made offline wait in localStorage and are sent on the next load.
  function queueCapture(title) {
    const box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    box.push({ title, created_at: new Date().toISOString() });
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
  }
  async function flushOutbox() {
    let box;
    try { box = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { box = []; }
    if (!box.length || !navigator.onLine) return;
    const { data, error } = await sb.from('tasks').insert(box.map((b) => ({ title: b.title, created_at: b.created_at }))).select();
    if (error) return;
    localStorage.removeItem(OUTBOX_KEY);
    db.tasks.push(...data);
    toast(`Synced ${data.length} offline capture${data.length === 1 ? '' : 's'}`);
  }

  async function capture(title, extra = {}) {
    title = title.trim();
    if (!title) return;
    if (!navigator.onLine) {
      queueCapture(title);
      toast('Saved offline; will sync when back online');
      return;
    }
    const [row] = await run(sb.from('tasks').insert({ title, ...extra }).select());
    db.tasks.push(row);
    render();
  }

  async function setCompleted(task, done) {
    const completed_at = done ? new Date().toISOString() : null;
    const [row] = await run(sb.from('tasks').update({ completed_at }).eq('id', task.id).select());
    task = syncRow('tasks', task, row);
    render();
    doneCache = null;
    if (done) toast('Completed', [{ label: 'Add note', run: () => openCompletionNote(task) }, { label: 'Undo', run: () => setCompleted(task, false) }]);
  }

  // Optional note about how/why something got done; completed_at already records when.
  function openCompletionNote(task) {
    const sheet = $('#sheet');
    sheet.classList.remove('full');
    sheet.innerHTML = `<form method="dialog" id="done-note">
      <h2>✓ ${esc(task.title)}</h2>
      <p class="view-sub" style="margin:0">Completed ${esc(fmtDateTime(task.completed_at))}</p>
      <label>Completion note<textarea name="note" placeholder="Outcome, who you spoke to, what's next…">${esc(task.completion_note || '')}</textarea></label>
      <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Skip</button><button type="submit" class="btn primary">Save note</button></div></div>
    </form>`;
    $('[data-cancel]', sheet).onclick = () => sheet.close();
    $('#done-note', sheet).onsubmit = async (e) => {
      e.preventDefault();
      const completion_note = e.target.elements.note.value.trim();
      sheet.close();
      const [row] = await run(sb.from('tasks').update({ completion_note }).eq('id', task.id).select());
      syncRow('tasks', task, row);
      doneCache = null;
      render();
    };
    sheet.showModal();
    $('[name=note]', sheet).focus();
  }

  async function saveTask(task, fields, tagIds) {
    fields.in_inbox = !(fields.project_id || tagIds.length) && (task ? task.in_inbox : true);
    let row;
    if (task) {
      [row] = await run(sb.from('tasks').update(fields).eq('id', task.id).select());
      syncRow('tasks', task, row);
    } else {
      [row] = await run(sb.from('tasks').insert(fields).select());
      db.tasks.push(row);
    }
    const current = db.taskTags.filter((x) => x.task_id === row.id).map((x) => x.tag_id);
    const add = tagIds.filter((id) => !current.includes(id));
    const remove = current.filter((id) => !tagIds.includes(id));
    if (add.length) {
      const rows = await run(sb.from('task_tags').insert(add.map((tag_id) => ({ task_id: row.id, tag_id }))).select());
      db.taskTags.push(...rows);
    }
    if (remove.length) {
      await run(sb.from('task_tags').delete().eq('task_id', row.id).in('tag_id', remove));
      db.taskTags = db.taskTags.filter((x) => !(x.task_id === row.id && remove.includes(x.tag_id)));
    }
    render();
  }

  async function deleteTask(task) {
    await run(sb.from('tasks').delete().eq('id', task.id));
    db.tasks = db.tasks.filter((t) => t.id !== task.id && t.parent_id !== task.id);
    db.taskTags = db.taskTags.filter((x) => x.task_id !== task.id);
    render();
  }

  // "Waiting : Hiro" creates (or reuses) parent tag "Waiting" and child "Hiro".
  async function ensureTag(label) {
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

  const PROJECT_STATUSES = [['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['dropped', 'Dropped']];
  const bySort = (a, b) => a.sort - b.sort || a.name.localeCompare(b.name);

  // Project editor sheet: create or edit name, folder (with inline "New folder…"), status and notes.
  function openProjectEditor(project, defaults = {}) {
    const p = project || { name: '', folder_id: null, status: 'active', notes: '', ...defaults };
    const sheet = $('#sheet');
    sheet.classList.remove('full');
    const folderOptions = db.folders.filter((f) => !f.archived_at || f.id === p.folder_id).sort(bySort)
      .map((f) => `<option value="${f.id}" ${f.id === p.folder_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    sheet.innerHTML = `<form method="dialog" id="project-form">
      <h2>${project ? 'Edit project' : 'New project'}</h2>
      <input type="text" name="name" value="${esc(p.name)}" placeholder="Outcome, e.g. Launch todotooling.com" required autocomplete="off">
      <label>Folder
        <select name="folder_id"><option value="">No folder</option>${folderOptions}<option value="__new">+ New folder…</option></select></label>
      <input type="text" name="new_folder" placeholder="New folder name" autocomplete="off" hidden>
      ${project ? `<label>Status<select name="status">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      <label>Notes<textarea name="notes" placeholder="Purpose, what done looks like…">${esc(p.notes)}</textarea></label>
      ${project ? '<p class="view-sub" style="margin:0">Projects are never deleted. Mark it Completed or Dropped to archive it.</p>' : ''}
      <div class="actions">
        <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
      </div>
    </form>`;
    const form = $('#project-form', sheet);
    const newFolder = form.elements.new_folder;
    form.elements.folder_id.onchange = (e) => {
      newFolder.hidden = e.target.value !== '__new';
      newFolder.required = !newFolder.hidden;
      if (!newFolder.hidden) newFolder.focus();
    };
    $('[data-cancel]', sheet).onclick = () => sheet.close();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      let folder_id = f.get('folder_id') || null;
      if (folder_id === '__new') {
        const folder = await insertFolder(f.get('new_folder'));
        if (!folder) return;
        folder_id = folder.id;
      }
      const fields = { name: f.get('name').trim(), folder_id, notes: f.get('notes') };
      if (project) fields.status = f.get('status');
      if (!fields.name) return;
      sheet.close();
      if (project) return updateProject(project, fields);
      const [row] = await run(sb.from('projects').insert({ ...fields, sort: db.projects.length }).select());
      db.projects.push(row);
      location.hash = `#project/${row.id}`;
    };
    sheet.showModal();
    if (!project) form.elements.name.focus();
  }

  async function insertFolder(name) {
    name = (name || '').trim();
    if (!name) return null;
    const existing = db.folders.find((f) => !f.archived_at && f.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const [row] = await run(sb.from('folders').insert({ name, sort: db.folders.length }).select());
    db.folders.push(row);
    return row;
  }

  // Folder sheet: create, rename, archive/unarchive. Folders are never deleted, and a
  // folder can only be archived once it has no active or on-hold projects (the database enforces this too).
  function openFolderEditor(folder) {
    const sheet = $('#sheet');
    sheet.classList.remove('full');
    const inside = folder ? db.projects.filter((p) => p.folder_id === folder.id) : [];
    const live = inside.filter((p) => p.status === 'active' || p.status === 'on_hold');
    let archiveControl = '';
    if (folder && folder.archived_at) {
      archiveControl = '<button type="button" class="btn" data-archive="off">Unarchive folder</button>';
    } else if (folder) {
      archiveControl = live.length
        ? `<p class="view-sub" style="margin:0">To archive this folder, first move or complete its ${live.length} active project${live.length === 1 ? '' : 's'}.</p>`
        : '<button type="button" class="btn" data-archive="on">Archive folder</button>';
    }
    sheet.innerHTML = `<form method="dialog" id="folder-form">
      <h2>${folder ? 'Edit folder' : 'New folder'}</h2>
      <input type="text" name="name" value="${esc(folder ? folder.name : '')}" placeholder="e.g. PRIORITIES, Click Construction, Personal" required autocomplete="off">
      ${folder ? `<p class="view-sub" style="margin:0">${inside.length} project${inside.length === 1 ? '' : 's'} in this folder${folder.archived_at ? ' · archived' : ''}</p>` : ''}
      <div class="actions">
        ${archiveControl}
        <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
      </div>
    </form>`;
    const form = $('#folder-form', sheet);
    $('[data-cancel]', sheet).onclick = () => sheet.close();
    const archive = $('[data-archive]', sheet);
    if (archive) archive.onclick = async () => {
      const archived_at = archive.dataset.archive === 'on' ? new Date().toISOString() : null;
      sheet.close();
      const [row] = await run(sb.from('folders').update({ archived_at }).eq('id', folder.id).select());
      syncRow('folders', folder, row);
      toast(archived_at ? `Archived "${folder.name}"` : `Unarchived "${folder.name}"`);
      render();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) return;
      sheet.close();
      if (folder) {
        const [row] = await run(sb.from('folders').update({ name }).eq('id', folder.id).select());
        syncRow('folders', folder, row);
      } else {
        await insertFolder(name);
      }
      render();
    };
    sheet.showModal();
    form.elements.name.focus();
  }

  async function createTag() {
    const label = prompt('Tag name (use "Parent : Child" to nest, e.g. Waiting : Hiro)');
    if (!label) return;
    await ensureTag(label);
    render();
  }
  async function updateProject(project, fields) {
    const [row] = await run(sb.from('projects').update(fields).eq('id', project.id).select());
    syncRow('projects', project, row);
    render();
  }

  // ---------- rendering ----------
  function taskRow(t, { showProject = true } = {}) {
    const done = !!t.completed_at;
    const project = t.project_id && byId(db.projects, t.project_id);
    const tags = tagsFor(t.id);
    const meta = [];
    if (showProject && project) meta.push(`<span>🗂️ ${esc(project.name)}</span>`);
    tags.forEach((tag) => meta.push(`<span class="chip">${esc(tagLabel(tag))}</span>`));
    if (t.defer_at && isDeferred(t)) meta.push(`<span>⏸ ${esc(fmtDate(t.defer_at))}</span>`);
    if (t.due_at) meta.push(`<span class="meta-due ${isOverdue(t) ? 'overdue' : ''}">📅 ${esc(fmtDate(t.due_at))}</span>`);
    if (t.flagged) meta.push('<span class="meta-flag">⚑</span>');
    if (t.notes) meta.push('<span>📝</span>');
    const checkCls = ['check', done && 'done', t.flagged && 'flagged', isOverdue(t) && 'overdue'].filter(Boolean).join(' ');
    return `<li class="row ${done ? 'completed' : ''} ${t.parent_id ? 'row-sub' : ''}" data-task="${t.id}">
      <button class="${checkCls}" data-check="${t.id}" aria-label="${done ? 'Mark incomplete' : 'Complete'}">✓</button>
      <div class="row-main"><div class="row-title">${esc(t.title)}</div>${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}</div>
    </li>`;
  }
  const taskList = (tasks, opts) => tasks.length ? `<ul class="list">${tasks.map((t) => taskRow(t, opts)).join('')}</ul>` : '';

  // Keep just-completed tasks visible (struck through) until the next reload, so Undo has context.
  const visible = (t) => isOpen(t) || (t.completed_at && new Date(t.completed_at) > sessionStart);
  const sessionStart = new Date();

  function viewInbox() {
    const items = db.tasks.filter((t) => t.in_inbox && !t.parent_id && visible(t)).sort(taskSort);
    const open = items.filter(isOpen).length;
    return `<div class="view-head"><h1 class="inbox">Inbox</h1></div>
      <p class="view-sub">${open} item${open === 1 ? '' : 's'} to clarify</p>
      <form class="capture" data-capture><input type="text" name="title" placeholder="Capture anything…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
      ${taskList(items) || '<p class="empty">Inbox zero. Nice.</p>'}`;
  }

  function viewToday() {
    const open = db.tasks.filter((t) => visible(t) && !isDeferred(t));
    const overdue = open.filter((t) => isOpen(t) && isOverdue(t)).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
    const today = open.filter((t) => t.due_at && !isOverdue(t) && isDueToday(t)).sort(taskSort);
    const flagged = open.filter((t) => t.flagged && !(t.due_at && isDueToday(t))).sort(taskSort);
    const d = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    let html = `<div class="view-head"><h1 class="today">Today</h1></div><p class="view-sub">${esc(d)}</p>`;
    if (overdue.length) html += `<h2 class="section-title">Overdue · ${overdue.length}</h2>${taskList(overdue)}`;
    if (today.length) html += `<h2 class="section-title">Due today</h2>${taskList(today)}`;
    if (flagged.length) html += `<h2 class="section-title">Flagged</h2>${taskList(flagged)}`;
    if (!overdue.length && !today.length && !flagged.length) html += '<p class="empty">Nothing due or flagged. Pick from a project or tag.</p>';
    return html;
  }

  function projectCounts(p) {
    const tasks = db.tasks.filter((t) => t.project_id === p.id && isOpen(t));
    return { open: tasks.length, overdue: tasks.filter(isOverdue).length };
  }
  function projectRow(p) {
    const c = projectCounts(p);
    const muted = p.status !== 'active';
    const count = c.overdue ? `<span class="count due">${c.overdue}</span>` : `<span class="count">${c.open || ''}</span>`;
    return `<a class="group-row ${muted ? 'muted' : ''}" href="#project/${p.id}"><span class="dot"></span><span>${esc(p.name)}${p.status === 'active' ? '' : ` (${PROJECT_STATUSES.find(([v]) => v === p.status)[1].toLowerCase()})`}</span>${count}</a>`;
  }

  let showInactive = false;

  function viewProjects() {
    const isLive = (p) => p.status === 'active' || p.status === 'on_hold';
    const shown = db.projects.filter((p) => showInactive || isLive(p));
    const liveCount = db.projects.filter(isLive).length;
    const archivedFolders = db.folders.filter((f) => f.archived_at).length;
    const inactiveCount = db.projects.length - liveCount;
    const hiddenLabel = [inactiveCount && `${inactiveCount} completed/dropped`, archivedFolders && `${archivedFolders} archived folder${archivedFolders === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    const folderHead = (f) => `<div class="folder-title ${f.archived_at ? 'muted' : ''}"><span>${f.archived_at ? '🗄️' : '📁'} ${esc(f.name)}${f.archived_at ? ' (archived)' : ''}</span>
      <span class="folder-actions">${f.archived_at ? '' : `<button class="icon-btn" data-add-project="${f.id}" aria-label="New project in ${esc(f.name)}">+</button>`}<button class="icon-btn" data-edit-folder="${f.id}" aria-label="Edit folder ${esc(f.name)}">✎</button></span></div>`;
    let html = `<div class="view-head"><h1>Projects</h1><span><button class="btn small" data-act="new-folder">+ Folder</button> <button class="btn small primary" data-act="new-project">+ Project</button></span></div>
      <p class="view-sub">${liveCount} active project${liveCount === 1 ? '' : 's'}${hiddenLabel ? ` · <a href="#projects" data-act="toggle-inactive">${showInactive ? 'hide' : 'show'} ${hiddenLabel}</a>` : ''}</p>`;
    db.folders.filter((f) => showInactive || !f.archived_at).sort(bySort).forEach((f) => {
      const ps = shown.filter((p) => p.folder_id === f.id).sort(bySort);
      html += folderHead(f) + (ps.map(projectRow).join('') || '<p class="empty" style="padding:8px 0">No projects</p>');
    });
    const loose = shown.filter((p) => !p.folder_id || !byId(db.folders, p.folder_id)).sort(bySort);
    if (loose.length) html += `${db.folders.length ? '<div class="folder-title"><span>No folder</span></div>' : ''}${loose.map(projectRow).join('')}`;
    if (!db.projects.length) html += '<p class="empty">No projects yet. A project is any outcome that takes more than one action.</p>';
    return html;
  }

  function viewProject(id) {
    const p = byId(db.projects, id);
    if (!p) return '<a class="back" href="#projects">‹ Projects</a><p class="empty">Project not found.</p>';
    const tasks = db.tasks.filter((t) => t.project_id === p.id && visible(t)).sort(taskSort);
    const top = tasks.filter((t) => !t.parent_id);
    const ordered = top.flatMap((t) => [t, ...tasks.filter((s) => s.parent_id === t.id)]);
    const folder = p.folder_id && byId(db.folders, p.folder_id);
    return `<a class="back" href="#projects">‹ Projects${folder ? ` / 📁 ${esc(folder.name)}` : ''}</a>
      <div class="view-head"><h1>${esc(p.name)}</h1><button class="btn small" data-edit-project="${p.id}">Edit</button></div>
      ${p.notes ? `<p class="view-sub" style="white-space:pre-wrap">${esc(p.notes)}</p>` : ''}
      <p class="view-sub"><select data-project-status="${p.id}" style="width:auto;padding:6px 10px">${PROJECT_STATUSES.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></p>
      <form class="capture" data-capture data-project="${p.id}"><input type="text" name="title" placeholder="Add an action to ${esc(p.name)}…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
      ${taskList(ordered, { showProject: false }) || '<p class="empty">No actions. What is the very next physical step?</p>'}
      <p class="view-sub" style="margin-top:20px"><a href="#done/all/${p.id}">✓ Completed in this project →</a></p>`;
  }

  // ---------- Done: review completed items by timeframe and project ----------
  const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['lastweek', 'Last week'],
    ['month', 'This month'], ['lastmonth', 'Last month'], ['30d', 'Last 30 days'], ['all', 'All time'], ['custom', 'Custom…']];
  let doneCache = null; // { key, rows }

  function rangeBounds(range, from, to) {
    const d0 = startOfToday();
    const day = (n) => { const d = new Date(d0); d.setDate(d.getDate() + n); return d; };
    const monday = day(-((d0.getDay() + 6) % 7));
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    switch (range) {
      case 'today': return [d0, day(1)];
      case 'yesterday': return [day(-1), d0];
      case 'week': return [monday, day(1)];
      case 'lastweek': return [addDays(monday, -7), monday];
      case 'month': return [new Date(d0.getFullYear(), d0.getMonth(), 1), day(1)];
      case 'lastmonth': return [new Date(d0.getFullYear(), d0.getMonth() - 1, 1), new Date(d0.getFullYear(), d0.getMonth(), 1)];
      case '30d': return [day(-29), day(1)];
      case 'custom': {
        const a = from ? new Date(from + 'T00:00') : day(-6);
        const b = to ? addDays(new Date(to + 'T00:00'), 1) : day(1);
        return [a, b];
      }
      default: return [null, null];
    }
  }

  async function loadDone(key, range, projectId, from, to) {
    const [start, end] = rangeBounds(range, from, to);
    let q = sb.from('tasks').select('*').not('completed_at', 'is', null).order('completed_at', { ascending: false }).limit(1000);
    if (start) q = q.gte('completed_at', start.toISOString());
    if (end) q = q.lt('completed_at', end.toISOString());
    if (projectId === 'none') q = q.is('project_id', null);
    else if (projectId && projectId !== 'all') q = q.eq('project_id', projectId);
    const rows = await run(q);
    doneCache = { key, rows };
    render();
  }

  function viewDone(range = 'week', projectId = 'all', from = '', to = '') {
    const key = [range, projectId, from, to].join('/');
    if (!doneCache || doneCache.key !== key) { loadDone(key, range, projectId, from, to); }
    const rows = doneCache && doneCache.key === key ? doneCache.rows : null;
    const projectOpts = db.projects.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}${p.status === 'active' ? '' : ' (' + p.status.replace('_', ' ') + ')'}</option>`).join('');
    let html = `<div class="view-head"><h1 class="done">Done</h1></div>
      <div class="done-filters">
        <select data-done="range">${RANGES.map(([v, l]) => `<option value="${v}" ${v === range ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select data-done="project"><option value="all">All projects</option><option value="none" ${projectId === 'none' ? 'selected' : ''}>No project</option>${projectOpts}</select>
        ${range === 'custom' ? `<input type="date" data-done="from" value="${esc(from)}"><input type="date" data-done="to" value="${esc(to)}">` : ''}
      </div>`;
    if (!rows) return html + '<p class="empty">Loading…</p>';
    if (!rows.length) return html + '<p class="empty">Nothing completed in this timeframe.</p>';
    // Per-project tally: tap one to filter.
    const tally = {};
    rows.forEach((t) => { const k = t.project_id || 'none'; tally[k] = (tally[k] || 0) + 1; });
    const projectName = (id) => (id === 'none' ? 'No project' : (byId(db.projects, id) || {}).name || 'Unknown project');
    html += `<p class="view-sub">${rows.length} completed${rows.length === 1000 ? '+' : ''} · ${Object.keys(tally).length} project${Object.keys(tally).length === 1 ? '' : 's'}</p>`;
    if (projectId === 'all' && Object.keys(tally).length > 1) {
      html += `<div class="tally">${Object.entries(tally).sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `<a class="chip" href="#done/${range}/${id}${range === 'custom' ? `/${from}/${to}` : ''}">${esc(projectName(id))} · ${n}</a>`).join('')}</div>`;
    }
    // Group by local calendar day.
    let lastDay = '';
    html += '<ul class="list">';
    rows.forEach((t) => {
      const d = new Date(t.completed_at);
      const dayKey = d.toDateString();
      if (dayKey !== lastDay) {
        lastDay = dayKey;
        const n = rows.filter((x) => new Date(x.completed_at).toDateString() === dayKey).length;
        html += `</ul><h2 class="section-title">${esc(d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))} · ${n}</h2><ul class="list">`;
      }
      const project = t.project_id && byId(db.projects, t.project_id);
      html += `<li class="row completed-row" data-done-task="${t.id}">
        <span class="check done">✓</span>
        <div class="row-main"><div class="row-title">${esc(t.title)}</div>
          <div class="row-meta"><span>${esc(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span>${project ? `<span>🗂️ ${esc(project.name)}</span>` : ''}</div>
          ${t.completion_note ? `<div class="done-note">${esc(t.completion_note)}</div>` : ''}</div></li>`;
    });
    return html + '</ul>';
  }

  function viewTags() {
    const list = sortedTags();
    const rows = list.map((tag) => {
      const n = db.taskTags.filter((x) => x.tag_id === tag.id && (() => { const t = byId(db.tasks, x.task_id); return t && isOpen(t); })()).length;
      return `<a class="group-row ${tag.parent_id ? 'tag-child' : ''}" href="#tag/${tag.id}"><span>🏷️ ${esc(tag.name)}</span><span class="count">${n || ''}</span></a>`;
    }).join('');
    return `<div class="view-head"><h1 class="tags">Tags</h1><button class="btn small primary" data-act="new-tag">+ Tag</button></div>
      <p class="view-sub">Contexts, people and waiting-fors. A task can have several.</p>
      ${rows || '<p class="empty">No tags yet. Try Laptop, Phone, Errands, or Waiting : Person.</p>'}`;
  }

  function viewTag(id) {
    const tag = byId(db.tags, id);
    if (!tag) return '<a class="back" href="#tags">‹ Tags</a><p class="empty">Tag not found.</p>';
    const ids = new Set([tag.id, ...db.tags.filter((t) => t.parent_id === tag.id).map((t) => t.id)]);
    const taskIds = new Set(db.taskTags.filter((x) => ids.has(x.tag_id)).map((x) => x.task_id));
    const tasks = db.tasks.filter((t) => taskIds.has(t.id) && visible(t)).sort(taskSort);
    return `<a class="back" href="#tags">‹ Tags</a>
      <div class="view-head"><h1 class="tags">${esc(tagLabel(tag))}</h1></div>
      <p class="view-sub">${tasks.filter(isOpen).length} open</p>
      ${taskList(tasks) || '<p class="empty">Nothing tagged here.</p>'}`;
  }

  // ---------- settings: agent access tokens ----------
  const MCP_URL = 'https://mcp.todotooling.com/mcp';
  const CAPTURE_EMAIL = 'inbox@todotooling.com';
  let apiTokens = null;
  let emailSenders = [];
  let tokensLoading = false;

  async function loadTokens() {
    if (tokensLoading) return;
    tokensLoading = true;
    try {
      [apiTokens, emailSenders] = await Promise.all([
        run(sb.from('api_tokens').select('id,name,token_hint,last_used_at,created_at').order('created_at')),
        run(sb.from('email_senders').select('id,email').order('created_at')),
      ]);
    } finally { tokensLoading = false; }
    render();
  }

  function viewSettings() {
    if (apiTokens === null) { loadTokens(); }
    const rows = (apiTokens || []).map((t) => `<li class="row" style="cursor:default">
        <div class="row-main"><div class="row-title">${esc(t.name)} <span class="chip">…${esc(t.token_hint)}</span></div>
        <div class="row-meta"><span>Created ${esc(fmtDate(t.created_at))}</span><span>${t.last_used_at ? `Last used ${esc(fmtDate(t.last_used_at))}` : 'Never used'}</span></div></div>
        <button class="btn small danger" data-revoke="${t.id}">Revoke</button></li>`).join('');
    return `<div class="view-head"><h1>Settings</h1></div>
      <p class="view-sub">Signed in as ${esc(user.email)}</p>
      <h2 class="section-title">Agent access (MCP)</h2>
      <p class="view-sub">Tokens let AI agents like Claude read and update your todos through <code>${MCP_URL}</code>. Each token has full access to your account; revoke any you no longer use.</p>
      <button class="btn primary" data-act="new-token">Create token</button>
      ${apiTokens === null ? '<p class="empty">Loading…</p>' : rows ? `<ul class="list" style="margin-top:12px">${rows}</ul>` : '<p class="empty">No tokens yet.</p>'}
      <h2 class="section-title">Email capture</h2>
      <p class="view-sub">Forward or send anything to <b>${CAPTURE_EMAIL}</b> and it lands in your Inbox (subject becomes the title, body the notes). Only mail from these addresses is accepted:</p>
      <ul class="list">${emailSenders.map((e) => `<li class="row" style="cursor:default"><div class="row-main"><div class="row-title">${esc(e.email)}</div></div>
        <button class="btn small danger" data-remove-sender="${e.id}">Remove</button></li>`).join('')}</ul>
      <form class="capture" data-add-sender style="margin-top:12px"><input type="email" name="email" placeholder="Add another address you send from" autocomplete="off"><button class="btn">Add</button></form>
      <h2 class="section-title">Account</h2>
      <button class="btn" data-act="sign-out">Sign out</button>`;
  }

  async function createToken() {
    const name = prompt('Name this token (e.g. "Claude Code on MacBook")');
    if (!name || !name.trim()) return;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = 'tt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await run(sb.from('api_tokens').insert({ name: name.trim(), token_hash, token_hint: token.slice(-4) }));
    await loadTokens();
    const cmd = `claude mcp add --transport http todotooling ${MCP_URL} --header "Authorization: Bearer ${token}"`;
    const sheet = $('#sheet');
    sheet.classList.remove('full');
    sheet.innerHTML = `<form method="dialog">
      <h2>Token created</h2>
      <p class="view-sub" style="margin:0">Copy it now. It won't be shown again.</p>
      <label>Token<textarea readonly rows="2" onclick="this.select()">${esc(token)}</textarea></label>
      <label>Claude Code command<textarea readonly rows="4" onclick="this.select()">${esc(cmd)}</textarea></label>
      <div class="actions"><div class="right"><button type="button" class="btn" data-copy>Copy command</button><button class="btn primary">Done</button></div></div>
    </form>`;
    $('[data-copy]', sheet).onclick = async () => { await navigator.clipboard.writeText(cmd); toast('Copied'); };
    sheet.showModal();
  }

  async function revokeToken(id) {
    if (!confirm('Revoke this token? Agents using it will lose access immediately.')) return;
    await run(sb.from('api_tokens').delete().eq('id', id));
    await loadTokens();
  }

  function render() {
    const [view, ...args] = (location.hash.slice(1) || 'inbox').split('/');
    const views = { inbox: viewInbox, today: viewToday, projects: viewProjects, project: viewProject, tags: viewTags, tag: viewTag, settings: viewSettings, done: viewDone };
    $('#view').innerHTML = (views[view] || viewInbox)(...args);
    const tab = { project: 'projects', tag: 'tags' }[view] || view;
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === tab));
    const inboxCount = db.tasks.filter((t) => t.in_inbox && !t.parent_id && isOpen(t)).length;
    const dueCount = db.tasks.filter((t) => isOpen(t) && isDueToday(t)).length;
    $('#badge-inbox').textContent = inboxCount || '';
    $('#badge-today').textContent = dueCount || '';
    if ('setAppBadge' in navigator) (inboxCount + dueCount ? navigator.setAppBadge(inboxCount + dueCount) : navigator.clearAppBadge()).catch(() => {});
  }

  // ---------- task editor sheet ----------
  function openEditor(task, defaults = {}) {
    const t = task || { title: '', notes: '', project_id: null, flagged: false, defer_at: null, due_at: null, ...defaults };
    const selected = new Set(task ? tagsFor(task.id).map((x) => x.id) : []);
    const projects = db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold' || p.id === t.project_id)
      .sort((a, b) => a.name.localeCompare(b.name));
    const sheet = $('#sheet');
    sheet.classList.remove('full');
    sheet.innerHTML = `<form method="dialog" id="editor">
      <h2>${task ? 'Edit item' : 'New item'}</h2>
      <input type="text" name="title" value="${esc(t.title)}" placeholder="What is it?" required autocomplete="off">
      <label>Project
        <select name="project_id"><option value="">${task && task.in_inbox ? 'None (stays in Inbox)' : 'None'}</option>
          ${projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></label>
      <label>Tags <div class="tag-picker" id="tag-picker"></div>
        <input type="text" id="new-tag" placeholder="New tag (Enter). e.g. Laptop, Waiting : Hiro" autocomplete="off"></label>
      <div class="grid2">
        <label>Defer until<input type="date" name="defer_at" value="${toDateInput(t.defer_at)}"></label>
        <label>Due<input type="date" name="due_at" value="${toDateInput(t.due_at)}"></label>
      </div>
      <label class="flag-toggle"><input type="checkbox" name="flagged" ${t.flagged ? 'checked' : ''}> Flagged</label>
      <label class="notes-field">Notes<textarea name="notes" placeholder="Links, details…">${esc(t.notes)}</textarea></label>
      ${t.completed_at ? `<div class="done-box"><b>✓ Completed ${esc(fmtDateTime(t.completed_at))}</b>
        <label>Completion note<textarea name="completion_note" placeholder="Outcome, who you spoke to, what's next…">${esc(t.completion_note || '')}</textarea></label></div>` : ''}
      <div class="actions">
        ${task ? '<button type="button" class="btn danger" data-del>Delete</button>' : ''}
        <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
      </div>
    </form>`;

    const drawTags = () => {
      $('#tag-picker', sheet).innerHTML = sortedTags().map((tag) =>
        `<button type="button" class="tag-toggle ${selected.has(tag.id) ? 'on' : ''}" data-tag="${tag.id}">${esc(tagLabel(tag))}</button>`).join('');
    };
    drawTags();
    $('#tag-picker', sheet).onclick = (e) => {
      const b = e.target.closest('[data-tag]');
      if (!b) return;
      selected.has(b.dataset.tag) ? selected.delete(b.dataset.tag) : selected.add(b.dataset.tag);
      drawTags();
    };
    $('#new-tag', sheet).onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const tag = await ensureTag(e.target.value);
      if (tag) { selected.add(tag.id); e.target.value = ''; drawTags(); }
    };
    $('[data-cancel]', sheet).onclick = () => sheet.close();
    const del = $('[data-del]', sheet);
    if (del) del.onclick = async () => { if (confirm('Delete this item?')) { sheet.close(); await deleteTask(task); } };
    $('#editor', sheet).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const fields = {
        title: f.get('title').trim(),
        notes: f.get('notes'),
        project_id: f.get('project_id') || null,
        flagged: f.get('flagged') === 'on',
        defer_at: fromDateInput(f.get('defer_at'), 0),
        due_at: fromDateInput(f.get('due_at'), 17),
      };
      if (f.has('completion_note')) fields.completion_note = f.get('completion_note').trim();
      if (!fields.title) return;
      doneCache = null;
      sheet.close();
      await saveTask(task, fields, [...selected]);
    };
    // Long notes (e.g. a forwarded email) earn the whole screen; re-check as the user types.
    const notes = $('[name=notes]', sheet);
    const fitNotes = () => sheet.classList.toggle('full', notesAreLong(notes.value));
    notes.addEventListener('input', fitNotes);
    fitNotes();
    sheet.showModal();
    if (!task) $('[name=title]', sheet).focus();
  }

  const notesAreLong = (text) => text.length > 280 || text.split('\n').length > 8;

  function openQuickEntry() {
    const sheet = $('#sheet');
    sheet.classList.remove('full');
    sheet.innerHTML = `<form method="dialog" id="quick">
      <h2>Capture to Inbox</h2>
      <input type="text" name="title" placeholder="What's on your mind?" required autocomplete="off" enterkeyhint="done">
      <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div>
    </form>`;
    $('[data-cancel]', sheet).onclick = () => sheet.close();
    $('#quick', sheet).onsubmit = async (e) => {
      e.preventDefault();
      const title = new FormData(e.target).get('title');
      sheet.close();
      await capture(title);
      if (location.hash !== '#inbox') toast('Captured to Inbox');
    };
    sheet.showModal();
    $('[name=title]', sheet).focus();
  }

  // ---------- events ----------
  $('#view').addEventListener('click', (e) => {
    const check = e.target.closest('[data-check]');
    if (check) {
      e.stopPropagation();
      const t = byId(db.tasks, check.dataset.check);
      if (t) setCompleted(t, !t.completed_at);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      ({ 'new-project': () => openProjectEditor(null), 'new-folder': () => openFolderEditor(null), 'toggle-inactive': () => { showInactive = !showInactive; render(); }, 'new-tag': createTag, 'new-token': createToken, 'sign-out': () => sb.auth.signOut() })[act.dataset.act]();
      return;
    }
    const editFolder = e.target.closest('[data-edit-folder]');
    if (editFolder) { openFolderEditor(byId(db.folders, editFolder.dataset.editFolder)); return; }
    const addProject = e.target.closest('[data-add-project]');
    if (addProject) { openProjectEditor(null, { folder_id: addProject.dataset.addProject }); return; }
    const editProject = e.target.closest('[data-edit-project]');
    if (editProject) { openProjectEditor(byId(db.projects, editProject.dataset.editProject)); return; }
    const removeSender = e.target.closest('[data-remove-sender]');
    if (removeSender) {
      if (confirm('Stop accepting email capture from this address?')) {
        run(sb.from('email_senders').delete().eq('id', removeSender.dataset.removeSender)).then(loadTokens);
      }
      return;
    }
    const revoke = e.target.closest('[data-revoke]');
    if (revoke) { revokeToken(revoke.dataset.revoke); return; }
    const doneRow = e.target.closest('[data-done-task]');
    if (doneRow) {
      const t = byId(db.tasks, doneRow.dataset.doneTask) || (doneCache && byId(doneCache.rows, doneRow.dataset.doneTask));
      if (t) openEditor(t);
      return;
    }
    const row = e.target.closest('[data-task]');
    if (row) openEditor(byId(db.tasks, row.dataset.task));
  });
  $('#view').addEventListener('submit', async (e) => {
    const senderForm = e.target.closest('[data-add-sender]');
    if (senderForm) {
      e.preventDefault();
      const email = senderForm.elements.email.value.trim().toLowerCase();
      if (!email) return;
      await run(sb.from('email_senders').insert({ email }));
      await loadTokens();
      return;
    }
    const form = e.target.closest('[data-capture]');
    if (!form) return;
    e.preventDefault();
    const input = form.elements.title;
    const title = input.value;
    input.value = '';
    const extra = form.dataset.project ? { project_id: form.dataset.project, in_inbox: false } : {};
    await capture(title, extra);
    const again = $('[data-capture] input');
    if (again) again.focus();
  });
  $('#view').addEventListener('change', (e) => {
    const doneCtl = e.target.closest('[data-done]');
    if (doneCtl) {
      const [, range = 'week', projectId = 'all', from = '', to = ''] = location.hash.slice(1).split('/');
      const next = { range, projectId, from, to, [{ range: 'range', project: 'projectId', from: 'from', to: 'to' }[doneCtl.dataset.done]]: doneCtl.value };
      location.hash = `#done/${next.range}/${next.projectId}${next.range === 'custom' ? `/${next.from}/${next.to}` : ''}`;
      return;
    }
    const sel = e.target.closest('[data-project-status]');
    if (sel) updateProject(byId(db.projects, sel.dataset.projectStatus), { status: sel.value });
  });
  $('#fab').onclick = openQuickEntry;
  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !$('#sheet').open && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      openQuickEntry();
    }
  });
  // Pick up changes made on another device when the app comes back to the foreground.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && user) { await flushOutbox(); await loadAll(); render(); }
  });
  window.addEventListener('online', async () => { if (user) { await flushOutbox(); render(); } });

  // ---------- auth ----------
  const authMsg = (m) => { $('#auth-msg').textContent = m; };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    authMsg('Signing in…');
    const { error } = await sb.auth.signInWithPassword({ email: $('#auth-email').value, password: $('#auth-password').value });
    authMsg(error ? error.message : '');
  };
  $('#auth-signup').onclick = async () => {
    if (!$('#auth-form').reportValidity()) return;
    authMsg('Creating account…');
    const { data, error } = await sb.auth.signUp({
      email: $('#auth-email').value,
      password: $('#auth-password').value,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) return authMsg(error.message);
    authMsg(data.session ? '' : 'Check your email to confirm, then sign in here.');
  };

  async function showApp(session) {
    user = session ? session.user : null;
    apiTokens = null;
    $('#auth').hidden = !!user;
    $('#app').hidden = !user;
    if (!user) return;
    await loadAll();
    await flushOutbox();
    render();
  }

  if (!sb) { document.body.textContent = 'Supabase is not configured.'; return; }
  let lastUserId;
  sb.auth.onAuthStateChange((_event, session) => {
    const id = session ? session.user.id : null;
    if (id === lastUserId) return;
    lastUserId = id;
    setTimeout(() => showApp(session), 0);
  });

  // The shell is served cache-first, so skip the worker on localhost to keep edits visible while developing.
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && !isLocal) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
