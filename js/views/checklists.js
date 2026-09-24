// Checklists: the list (with last-run history), one checklist (run it, runs history, which action
// carries it), the editor sheet, and the checklist inside an action's editor.
import { db, app, esc, byId, openSheet, $, toast, isOpen } from '../state.js';
import { liveChecklists, parseItems, itemsToText, saveChecklist, runsFor, openRun, lastFinished, actionsWith, tick, finishRun, attach, fromSteps, fmtRun, checklistById } from '../checklists.js';

const progressOf = (cl, r) => { const n = r ? (r.ticked || []).length : 0; const total = cl.items.length; return { n, total, pct: total ? Math.round((n / total) * 100) : 0 }; };

// The items, ticked from a run, grouped by section.
export function itemsHtml(cl, r) {
  const on = new Set(r ? r.ticked || [] : []);
  let section = null;
  return cl.items.map((i) => {
    const head = (i.section || '') !== section ? (section = i.section || '', i.section ? `<h3 class="cl-sec">${esc(i.section)}</h3>` : '') : '';
    return `${head}<label class="chk-item ${on.has(i.id) ? 'on' : ''}"><input type="checkbox" data-cl-tick="${cl.id}" data-item="${i.id}" ${on.has(i.id) ? 'checked' : ''}><span>${esc(i.text)}</span></label>`;
  }).join('');
}
const barHtml = (cl, r) => { const p = progressOf(cl, r); return `<div class="cl-progress"><i style="width:${p.pct}%"></i></div><p class="hint">${p.n} of ${p.total}${r && !r.finished_at ? ` · started ${Math.max(0, Math.round((Date.now() - Date.parse(r.started_at)) / 60000))} min ago` : ''}</p>`; };

export function viewChecklists() {
  const list = liveChecklists();
  const archived = (db.checklists || []).filter((c) => c.archived_at);
  return `<div class="view-head"><h1 class="checklists">Checklists</h1><button class="btn small primary" data-ck="new">+ Checklist</button></div>
    <p class="view-sub">Routines you run again and again: a pre-job walkthrough, the van restock, month-end close. Each run starts fresh.</p>
    ${list.length ? `<ul class="list">${list.map((c) => { const on = actionsWith(c); const cur = openRun(c, null); return `<li class="row ck-row"><a class="row-main" href="#checklist/${c.id}"><div class="row-title">${esc(c.name)}</div>
      <div class="row-meta"><span>${c.items.length} item${c.items.length === 1 ? '' : 's'}</span><span>${esc(cur ? fmtRun(cur, c) : fmtRun(lastFinished(c), c))}</span>${on.length ? `<span>on “${esc(on[0].title)}”${on[0].repeat_rule ? ' 🔁' : ''}</span>` : ''}</div></a>
      <a class="btn small" href="#checklist/${c.id}">Run</a></li>`; }).join('')}</ul>` : '<p class="empty">No checklists yet. Make one, or turn any action’s steps into one (its editor → Checklist).</p>'}
    ${archived.length ? `<details class="dropped-tags"><summary class="section-title">Archived · ${archived.length}</summary><ul class="list">${archived.map((c) => `<li class="row"><a class="row-main" href="#checklist/${c.id}"><div class="row-title">${esc(c.name)}</div></a></li>`).join('')}</ul></details>` : ''}`;
}

export function viewChecklist(id) {
  const c = checklistById(id);
  if (!c) return '<a class="back" href="#checklists">‹ Checklists</a><p class="empty">Checklist not found.</p>';
  const on = actionsWith(c);
  const r = openRun(c, null);
  const history = runsFor(c).filter((x) => x.finished_at).slice(0, 5);
  return `<a class="back" href="#checklists">‹ Checklists</a>
    <div class="view-head"><h1 class="checklists">${esc(c.name)}${c.archived_at ? ' <span class="chip">archived</span>' : ''}</h1><button class="btn small" data-ck="edit" data-id="${c.id}">Edit</button></div>
    ${on.length ? `<p class="view-sub">On ${on.map((t) => `<a href="#task/${t.id}">“${esc(t.title)}”</a>${t.repeat_rule ? ' 🔁' : ''}`).join(', ')}${c.complete_action ? ' · ticking the last item completes it' : ''}</p>` : ''}
    ${barHtml(c, r)}
    <div class="chk-list">${itemsHtml(c, r) || '<p class="empty small">No items. Tap Edit to add some.</p>'}</div>
    <p class="head-actions">${r ? `<button class="btn" data-ck="finish" data-id="${c.id}">Finish now</button> <button class="btn small" data-ck="restart" data-id="${c.id}">Start over</button>` : ''}</p>
    ${history.length ? `<h2 class="section-title">Runs</h2><ul class="list ck-runs">${history.map((x) => `<li class="row"><div class="row-main"><div class="row-meta"><span>${esc(fmtRun(x, c))}</span>${x.task_id && byId(db.tasks, x.task_id) ? `<span>on “${esc(byId(db.tasks, x.task_id).title)}”</span>` : ''}</div></div></li>`).join('')}</ul>` : ''}`;
}

export function openChecklistEditor(c, { after = () => {} } = {}) {
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet ck-form"><h2>${c ? 'Edit checklist' : 'New checklist'}</h2>
    <label>Name<input type="text" name="name" value="${esc(c ? c.name : '')}" required maxlength="200" placeholder="Van restock" autocomplete="off"></label>
    <label>Items <span class="hint">one per line · “# Section” starts a section</span><textarea name="items" rows="12" placeholder="# Fittings&#10;1/2&quot; PEX elbows&#10;Shark-bite couplings&#10;# Tools&#10;Charge the drill batteries">${esc(c ? itemsToText(c.items) : '')}</textarea></label>
    <label class="flag-toggle"><input type="checkbox" name="complete_action" ${!c || c.complete_action ? 'checked' : ''}> When it’s on an action, ticking the last item completes the action</label>
    <div class="actions">${c ? `<button type="button" class="btn danger" data-archive>${c.archived_at ? 'Restore' : 'Archive'}</button>` : ''}<div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div></form>`);
  const form = $('form', sheet);
  $('[data-cancel]', form).onclick = () => sheet.close();
  const arch = $('[data-archive]', form);
  if (arch) arch.onclick = async () => { sheet.close(); const was = c.archived_at; await saveChecklist(c, { archived_at: was ? null : new Date().toISOString() }); app.render(); if (!was) toast(`Archived “${c.name}”`, [{ label: 'Undo', run: async () => { await saveChecklist(c, { archived_at: null }); app.render(); } }]); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    sheet.close();
    const row = await saveChecklist(c, { name, items: parseItems(form.elements.items.value, c ? c.items : []), complete_action: form.elements.complete_action.checked });
    app.render();
    after(row);
  };
  sheet.showModal();
}

// ---------- inside an action's editor ----------
export function checklistFieldHtml(task) {
  if (!task) return '';
  const c = task.checklist_id && checklistById(task.checklist_id);
  const hasSteps = db.tasks.some((t) => t.parent_id === task.id && !t.dropped_at);
  if (!c) {
    const list = liveChecklists();
    if (!list.length && !hasSteps) return '';
    return `<fieldset class="ck-field" data-ck-field><legend>Checklist</legend>
      ${list.length ? `<select data-ck-attach aria-label="Add a checklist"><option value="">Add a checklist…</option>${list.map((x) => `<option value="${x.id}">${esc(x.name)} (${x.items.length})</option>`).join('')}</select>` : ''}
      ${hasSteps ? '<button type="button" class="btn small" data-ck-from-steps>Make a checklist from its steps</button>' : ''}</fieldset>`;
  }
  const r = openRun(c, task.id);
  return `<fieldset class="ck-field" data-ck-field><legend>Checklist · <a href="#checklist/${c.id}">${esc(c.name)}</a></legend>
    ${barHtml(c, r)}<div class="chk-list">${itemsHtml(c, r)}</div>
    <p class="hint">${c.complete_action && isOpen(task) ? 'Ticking the last item completes this action. ' : ''}${task.repeat_rule ? 'The next occurrence starts fresh. ' : ''}<button type="button" class="link-btn" data-ck-detach>Remove the checklist</button></p></fieldset>`;
}

export function wireChecklistField(form, task) {
  const box = form.querySelector('[data-ck-field]');
  if (!box || !task) return;
  const redraw = () => { const t = byId(db.tasks, task.id) || task; box.outerHTML = checklistFieldHtml(t); wireChecklistField(form, t); };
  box.addEventListener('change', async (e) => {
    e.stopPropagation(); // not a field of the action: don't autosave the form for it
    const at = e.target.closest('[data-ck-attach]');
    if (at && at.value) { await attach(task, at.value); redraw(); return; }
    const cb = e.target.closest('[data-cl-tick]');
    if (!cb) return;
    const c = checklistById(cb.dataset.clTick);
    const { all } = await tick(c, task.id, cb.dataset.item, cb.checked);
    redraw();
    if (all && c.complete_action && isOpen(task) && form.elements.status) {
      // Complete it through the form, so repeats, history and the inspector all see it.
      form.elements.status.value = 'completed';
      form.elements.status.dispatchEvent(new Event('change', { bubbles: true }));
      if (form.id === 'editor') form.requestSubmit();
      toast(`✓ ${c.name} done`);
    }
  });
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-ck-from-steps]')) { const c = await fromSteps(task); toast(`Checklist “${c.name}” made from its steps`); redraw(); }
    if (e.target.closest('[data-ck-detach]')) { await attach(task, null); redraw(); }
  });
}

// ---------- the checklist page ----------
export async function checklistAction(el) {
  const c = el.dataset.id && checklistById(el.dataset.id);
  const a = el.dataset.ck;
  if (a === 'new') openChecklistEditor(null, { after: (row) => { location.hash = `#checklist/${row.id}`; } });
  else if (a === 'edit' && c) openChecklistEditor(c);
  else if (a === 'finish' && c) { await finishRun(c, null); toast('Run finished'); }
  else if (a === 'restart' && c) { await finishRun(c, null); toast('Started over (the last run is kept)'); }
  app.render();
}
export async function checklistChange(e) {
  const cb = e.target.closest && e.target.closest('[data-cl-tick]');
  if (!cb || !location.hash.startsWith('#checklist/')) return false;
  const c = checklistById(cb.dataset.clTick);
  const { all } = await tick(c, null, cb.dataset.item, cb.checked);
  if (all) toast(`✓ ${c.name}: all done`);
  app.render();
  return true;
}
