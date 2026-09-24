// A perspective's list (#perspective/<id>) and the list of perspectives (#perspectives).
import { db, esc, byId, isOpen, taskSort, isCollapsed } from '../state.js';
import { taskRow, taskList } from '../rows.js';
import { livePerspectives, runPerspective, summaryOf, badgeCount } from '../perspectives.js';

// Tree layout: matching steps sit under their matching parent; a step whose parent didn't
// match stands on its own and shows "↳ parent" for context. Top-level order is the perspective's.
function treeRows(tasks, opts) {
  const ids = new Set(tasks.map((t) => t.id));
  const hasGroups = tasks.some((t) => db.tasks.some((c) => c.parent_id === t.id));
  const out = [];
  const walk = (t, depth) => {
    out.push(taskRow(t, { ...opts, hierarchy: depth > 0 || !t.parent_id, hasGroups, depth }));
    if (isCollapsed(t.id)) return;
    tasks.filter((c) => c.parent_id === t.id).sort(taskSort).forEach((c) => walk(c, depth + 1));
  };
  tasks.filter((t) => !t.parent_id || !ids.has(t.parent_id)).forEach((t) => walk(t, 0));
  return out.length ? `<ul class="list">${out.join('')}</ul>` : '';
}

export function viewPerspective(id) {
  const p = byId(db.perspectives, id);
  if (!p || p.archived_at) {
    return `<div class="view-head"><h1>Perspective</h1></div>
      <p class="empty">${p ? 'This perspective is archived.' : 'This perspective doesn’t exist.'} <a href="#perspectives">See your perspectives</a></p>`;
  }
  const r = runPerspective(p);
  const open = r.tasks.filter(isOpen).length;
  const opts = { showProject: r.options.group_by !== 'project' };
  const body = (list) => (r.options.layout === 'flat' ? taskList(list, opts) : treeRows(list, opts));
  const sections = r.groups.filter((g) => g.tasks.length).map((g) => {
    const head = g.label ? `<h2 class="section-title">${g.key && r.options.group_by === 'project' ? `<a href="#project/${g.key}">${esc(g.label)}</a>` : esc(g.label)} · ${g.tasks.filter(isOpen).length}</h2>` : '';
    return head + body(g.tasks);
  }).join('');
  return `<div class="view-head perspective-head"><h1><span aria-hidden="true">${esc(p.icon)}</span> ${esc(p.name)}</h1>
      <span class="head-actions"><button class="btn small" data-persp-edit="${p.id}">Edit</button><button class="btn small" data-persp-menu="${p.id}" aria-label="More actions for ${esc(p.name)}">⋯</button></span></div>
    <p class="view-sub persp-summary">${esc(summaryOf(p))} · ${open} open</p>
    ${r.warnings.map((w) => `<p class="persp-warning" role="status">⚠️ ${esc(w)}</p>`).join('')}
    ${sections || '<p class="empty">Nothing matches right now.</p>'}`;
}

export function viewPerspectives() {
  const list = livePerspectives();
  const archived = db.perspectives.filter((p) => p.archived_at);
  const row = (p, i) => `<li class="persp-row">
      <a href="#perspective/${p.id}" class="persp-link"><span class="persp-icon" aria-hidden="true">${esc(p.icon)}</span>
        <span class="persp-main"><span class="persp-name">${esc(p.name)}</span><span class="persp-sub">${esc(summaryOf(p))}</span></span>
        <span class="count">${runPerspective(p, { remember: false }).tasks.filter(isOpen).length}</span></a>
      <span class="persp-order"><button class="icon-btn" data-persp-move="${p.id}" data-dir="-1" aria-label="Move ${esc(p.name)} up" ${i ? '' : 'disabled'}>▲</button><button class="icon-btn" data-persp-move="${p.id}" data-dir="1" aria-label="Move ${esc(p.name)} down" ${i < list.length - 1 ? '' : 'disabled'}>▼</button></span>
    </li>`;
  return `<div class="view-head"><h1>Perspectives</h1><button class="btn small" data-act="new-perspective">+ New</button></div>
    <p class="view-sub">Saved views built from rules: tags, projects, dates, durations and more. Agents can use them too.</p>
    ${list.length ? `<ul class="list persp-list">${list.map(row).join('')}</ul>` : '<p class="empty">No perspectives yet. Start from a template: Calls, Quick wins, Today…</p>'}
    ${archived.length ? `<h2 class="section-title">Archived · ${archived.length}</h2><ul class="list persp-list">${archived.map((p) => `<li class="persp-row archived"><span class="persp-link"><span class="persp-icon" aria-hidden="true">${esc(p.icon)}</span><span class="persp-main"><span class="persp-name">${esc(p.name)}</span></span></span><button class="btn small" data-persp-restore="${p.id}">Restore</button></li>`).join('')}</ul>` : ''}`;
}

// Sidebar (desktop): pinned perspectives, in the Do group, with optional badges.
export const perspectiveNav = (currentId) => {
  const list = livePerspectives().filter((p) => p.pinned !== false);
  return list.map((p) => { const n = badgeCount(p); return `<a href="#perspective/${p.id}" class="nav-persp ${p.id === currentId ? 'active' : ''}"><span class="tab-icon">${esc(p.icon)}</span><span>${esc(p.name)}</span>${n ? `<b class="badge persp">${n}</b>` : ''}</a>`; }).join('');
};
