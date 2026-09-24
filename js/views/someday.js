// Someday/Maybe: everything parked under the Someday tag (by category: Someday : Travel…) plus
// on-hold projects. Activate makes it a next action (or an active project); Revisit on… puts it in
// the tickler; Drop drops it. Items parked 6+ months ask "still want this?".
import { db, app, sb, run, syncRow, esc, byId, toast, openSheet, $, tagsFor } from '../state.js';
import { SOMEDAY_OLD_DAYS } from '../weekly.js';
import { somedayItems, somedayRoot, somedayCategories, parkedSince, daysSince, activateSomeday, somedayLink } from '../gtd.js';
import { setLinks } from '../data.js';
import { openTickle } from '../editors/gtd.js';
import { tagPickerHtml, wireTagPicker } from '../editors/tagPicker.js';

const ago = (days) => (days < 14 ? `${days} day${days === 1 ? '' : 's'}` : days < 60 ? `${Math.round(days / 7)} weeks` : days < 365 ? `${Math.round(days / 30)} months` : `${(days / 365).toFixed(1).replace('.0', '')} years`);

export function somedayListHtml() {
  const { tasks, projects } = somedayItems();
  const root = somedayRoot();
  const groups = new Map();
  tasks.forEach((t) => {
    const link = somedayLink(t);
    const tag = link && byId(db.tags, link.tag_id);
    const k = tag && root && tag.id !== root.id ? tag.name : 'Someday';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  const row = (t) => {
    const days = daysSince(parkedSince(t));
    const p = t.project_id && byId(db.projects, t.project_id);
    return `<li class="row sd-row" data-task="${t.id}"><div class="row-main"><div class="row-title">${esc(t.title)}</div>
      <div class="row-meta">${p ? `<span>🗂️ ${esc(p.name)}</span>` : ''}<span>parked ${ago(days)}</span>${days >= SOMEDAY_OLD_DAYS ? '<span class="chip sd-old">still want this?</span>' : ''}</div></div>
      <span class="row-actions"><button class="btn small primary" data-someday="activate" data-id="${t.id}">Activate</button>
      <button class="btn small" data-someday="revisit" data-id="${t.id}">Revisit on…</button><button class="btn small" data-someday="drop" data-id="${t.id}">Drop</button></span></li>`;
  };
  const prow = (p) => {
    const days = daysSince(p.updated_at || p.created_at);
    const n = db.tasks.filter((t) => t.project_id === p.id && !t.completed_at && !t.dropped_at).length;
    return `<li class="row sd-row"><div class="row-main"><a class="row-title" href="#project/${p.id}">${esc(p.name)}</a>
      <div class="row-meta"><span>${n} action${n === 1 ? '' : 's'}</span><span>on hold ${ago(days)}</span>${days >= SOMEDAY_OLD_DAYS ? '<span class="chip sd-old">still want this?</span>' : ''}</div></div>
      <span class="row-actions"><button class="btn small primary" data-someday="activate-project" data-id="${p.id}">Activate</button><button class="btn small" data-someday="drop-project" data-id="${p.id}">Drop</button></span></li>`;
  };
  const sections = [...groups.entries()].sort(([a], [b]) => (a === 'Someday') - (b === 'Someday') || a.localeCompare(b))
    .map(([k, list]) => `<h2 class="section-title">${esc(k)} · ${list.length}</h2><ul class="list">${list.sort((a, b) => String(parkedSince(a)).localeCompare(String(parkedSince(b)))).map(row).join('')}</ul>`).join('');
  const old = [...tasks.filter((t) => daysSince(parkedSince(t)) >= SOMEDAY_OLD_DAYS), ...projects.filter((p) => daysSince(p.updated_at || p.created_at) >= SOMEDAY_OLD_DAYS)].length;
  return `${old ? `<p class="view-sub">${old} parked 6+ months. Still want ${old === 1 ? 'it' : 'them'}?</p>` : ''}
    ${sections}
    ${projects.length ? `<h2 class="section-title">Projects on hold · ${projects.length}</h2><ul class="list">${projects.map(prow).join('')}</ul>` : ''}
    ${!tasks.length && !projects.length ? '<p class="empty">Nothing parked. In Clarify, choose Someday for anything you might want to do one day.</p>' : ''}
    <form class="capture" data-someday-add><input type="text" name="title" placeholder="Someday I’d like to…" autocomplete="off" enterkeyhint="done"><button class="btn">Add</button></form>`;
}

export function viewSomeday() {
  const { tasks, projects } = somedayItems();
  return `<div class="view-head"><h1 class="someday">Someday/Maybe</h1><span class="cl-count">${tasks.length + projects.length}</span></div>
    <p class="view-sub">Things you might do one day, out of your action lists. Look through them in the Weekly Review.</p>
    ${somedayListHtml()}`;
}

// Activate: where does it go? (project and/or tags), then it's a next action.
function openActivate(t) {
  const projects = db.projects.filter((p) => ['active', 'on_hold'].includes(p.status)).sort((a, b) => a.name.localeCompare(b.name));
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet activate-form"><h2>Activate</h2><p class="gtd-item">${esc(t.title)}</p>
    <label>Project<select name="project_id"><option value="">No project</option>${projects.map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    ${tagPickerHtml('where can you do it?')}
    <p class="form-error" hidden data-err>Pick a project or a tag, or send it to the Inbox.</p>
    <div class="actions"><button type="button" class="btn" data-inbox>To the Inbox</button><div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Activate</button></div></div></form>`);
  const form = $('form', sheet);
  const someIds = new Set([somedayRoot() && somedayRoot().id, ...somedayCategories().map((g) => g.id)]);
  const picked = wireTagPicker(form, tagsFor(t.id).map((g) => g.id).filter((id) => !someIds.has(id)));
  $('[data-cancel]', form).onclick = () => sheet.close();
  $('[data-inbox]', form).onclick = async () => { sheet.close(); await activateSomeday(t, { tagIds: [] }); app.render(); toast('In the Inbox to clarify'); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const project_id = form.elements.project_id.value || null;
    const tagIds = picked().filter((id) => !someIds.has(id));
    if (!project_id && !tagIds.length) { $('[data-err]', form).hidden = false; return; }
    sheet.close();
    await activateSomeday(t, { project_id, tagIds });
    app.render();
    toast(`Activated “${t.title}”`);
  };
  sheet.showModal();
}

export async function somedayAction(el) {
  const a = el.dataset.someday;
  const t = byId(db.tasks, el.dataset.id);
  const p = byId(db.projects, el.dataset.id);
  const patchT = async (fields) => { const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select()); syncRow('tasks', t, row); app.render(); };
  const patchP = async (fields) => { const [row] = await run(sb.from('projects').update(fields).eq('id', p.id).select()); syncRow('projects', p, row); app.render(); };
  if (a === 'activate' && t) openActivate(t);
  else if (a === 'revisit' && t) {
    openTickle(t, { title: 'Revisit on…', onDone: async () => {
      // Back in the Inbox on that day, out of Someday.
      const ids = new Set([somedayRoot() && somedayRoot().id, ...somedayCategories().map((g) => g.id)]);
      await setLinks('task_tags', 'taskTags', 'task_id', t.id, tagsFor(t.id).map((g) => g.id).filter((id) => !ids.has(id)));
      app.render();
    } });
  } else if (a === 'drop' && t) { await patchT({ dropped_at: new Date().toISOString() }); toast(`Dropped “${t.title}”`, [{ label: 'Undo', run: () => patchT({ dropped_at: null }) }]); }
  else if (a === 'activate-project' && p) { await patchP({ status: 'active' }); toast(`“${p.name}” is active`, [{ label: 'Undo', run: () => patchP({ status: 'on_hold' }) }]); }
  else if (a === 'drop-project' && p) { if (!confirm(`Drop the project “${p.name}”?`)) return; await patchP({ status: 'dropped' }); toast(`Dropped “${p.name}”`, [{ label: 'Undo', run: () => patchP({ status: 'on_hold' }) }]); }
}

export function somedaySubmit(e) {
  const form = e.target.closest('[data-someday-add]');
  if (!form) return false;
  e.preventDefault();
  const title = form.elements.title.value.trim();
  if (!title) return true;
  form.elements.title.value = '';
  (async () => {
    const [row] = await run(sb.from('tasks').insert({ title, in_inbox: false }).select());
    db.tasks.push(row);
    const { makeSomeday } = await import('../gtd.js');
    await makeSomeday(row);
    app.render();
    const again = document.querySelector('[data-someday-add] input'); if (again) again.focus();
  })();
  return true;
}
export const somedayCount = () => { const { tasks, projects } = somedayItems(); return tasks.length + projects.length; };
