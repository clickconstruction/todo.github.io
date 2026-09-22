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

  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = () => { el.hidden = true; action.run(); };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, action ? 5000 : 2500);
  }

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
    Object.assign(task, row);
    render();
    if (done) toast('Completed', { label: 'Undo', run: () => setCompleted(task, false) });
  }

  async function saveTask(task, fields, tagIds) {
    fields.in_inbox = !(fields.project_id || tagIds.length) && (task ? task.in_inbox : true);
    let row;
    if (task) {
      [row] = await run(sb.from('tasks').update(fields).eq('id', task.id).select());
      Object.assign(task, row);
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

  async function createProject() {
    const name = prompt('Project name');
    if (!name || !name.trim()) return;
    let folder_id = null;
    if (db.folders.length) {
      const names = db.folders.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
      const pick = prompt(`Folder (number, or leave blank for none):\n${names}`);
      const f = db.folders[Number(pick) - 1];
      if (f) folder_id = f.id;
    }
    const [row] = await run(sb.from('projects').insert({ name: name.trim(), folder_id, sort: db.projects.length }).select());
    db.projects.push(row);
    location.hash = `#project/${row.id}`;
  }
  async function createFolder() {
    const name = prompt('Folder name');
    if (!name || !name.trim()) return;
    const [row] = await run(sb.from('folders').insert({ name: name.trim(), sort: db.folders.length }).select());
    db.folders.push(row);
    render();
  }
  async function createTag() {
    const label = prompt('Tag name (use "Parent : Child" to nest, e.g. Waiting : Hiro)');
    if (!label) return;
    await ensureTag(label);
    render();
  }
  async function updateProject(project, fields) {
    const [row] = await run(sb.from('projects').update(fields).eq('id', project.id).select());
    Object.assign(project, row);
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
    return `<a class="group-row ${muted ? 'muted' : ''}" href="#project/${p.id}"><span class="dot"></span><span>${esc(p.name)}${p.status === 'on_hold' ? ' (on hold)' : ''}</span>${count}</a>`;
  }

  function viewProjects() {
    const live = db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold');
    const bySort = (a, b) => a.sort - b.sort || a.name.localeCompare(b.name);
    let html = `<div class="view-head"><h1>Projects</h1><span><button class="btn small" data-act="new-folder">+ Folder</button> <button class="btn small primary" data-act="new-project">+ Project</button></span></div>
      <p class="view-sub">${live.length} active project${live.length === 1 ? '' : 's'}</p>`;
    db.folders.slice().sort(bySort).forEach((f) => {
      const ps = live.filter((p) => p.folder_id === f.id).sort(bySort);
      html += `<div class="folder-title"><span>📁 ${esc(f.name)}</span></div>${ps.map(projectRow).join('') || '<p class="empty" style="padding:8px 0">No projects</p>'}`;
    });
    const loose = live.filter((p) => !p.folder_id || !byId(db.folders, p.folder_id)).sort(bySort);
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
    const statuses = [['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['dropped', 'Dropped']];
    return `<a class="back" href="#projects">‹ Projects</a>
      <div class="view-head"><h1>${esc(p.name)}</h1></div>
      <p class="view-sub"><select data-project-status="${p.id}" style="width:auto;padding:6px 10px">${statuses.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></p>
      <form class="capture" data-capture data-project="${p.id}"><input type="text" name="title" placeholder="Add an action to ${esc(p.name)}…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
      ${taskList(ordered, { showProject: false }) || '<p class="empty">No actions. What is the very next physical step?</p>'}`;
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

  function render() {
    const [view, id] = (location.hash.slice(1) || 'inbox').split('/');
    const views = { inbox: viewInbox, today: viewToday, projects: viewProjects, project: viewProject, tags: viewTags, tag: viewTag };
    $('#view').innerHTML = (views[view] || viewInbox)(id);
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
      <label>Notes<textarea name="notes" placeholder="Links, details…">${esc(t.notes)}</textarea></label>
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
      if (!fields.title) return;
      sheet.close();
      await saveTask(task, fields, [...selected]);
    };
    sheet.showModal();
    if (!task) $('[name=title]', sheet).focus();
  }

  function openQuickEntry() {
    const sheet = $('#sheet');
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
      ({ 'new-project': createProject, 'new-folder': createFolder, 'new-tag': createTag })[act.dataset.act]();
      return;
    }
    const row = e.target.closest('[data-task]');
    if (row) openEditor(byId(db.tasks, row.dataset.task));
  });
  $('#view').addEventListener('submit', async (e) => {
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
    const sel = e.target.closest('[data-project-status]');
    if (sel) updateProject(byId(db.projects, sel.dataset.projectStatus), { status: sel.value });
  });
  $('#fab').onclick = openQuickEntry;
  $('#sign-out').onclick = () => sb.auth.signOut();
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
