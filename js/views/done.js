// Done: review completed items by timeframe and project.
import { sb, db, app, esc, byId, run } from '../state.js';
import { startOfToday, addDays } from '../dates.js';

const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['lastweek', 'Last week'],
  ['month', 'This month'], ['lastmonth', 'Last month'], ['30d', 'Last 30 days'], ['all', 'All time'], ['custom', 'Custom…']];

export function rangeBounds(range, from, to) {
  const d0 = startOfToday();
  const day = (n) => addDays(d0, n);
  const monday = day(-((d0.getDay() + 6) % 7));
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
  app.doneCache = { key, rows };
  app.render();
}

export function viewDone(range = 'week', projectId = 'all', from = '', to = '') {
  const key = [range, projectId, from, to].join('/');
  if (!app.doneCache || app.doneCache.key !== key) { loadDone(key, range, projectId, from, to); }
  const rows = app.doneCache && app.doneCache.key === key ? app.doneCache.rows : null;
  const projectOpts = db.projects.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}${p.status === 'active' ? '' : ' (' + p.status.replace('_', ' ') + ')'}</option>`).join('');
  let html = `<div class="view-head"><h1 class="done">Done</h1></div>
    <div class="done-filters">
      <select data-done="range" aria-label="When">${RANGES.map(([v, l]) => `<option value="${v}" ${v === range ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select data-done="project" aria-label="Project"><option value="all">All projects</option><option value="none" ${projectId === 'none' ? 'selected' : ''}>No project</option>${projectOpts}</select>
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

// Filter controls rewrite the hash; the router re-renders.
export function onDoneFilterChange(ctl) {
  const [, range = 'week', projectId = 'all', from = '', to = ''] = location.hash.slice(1).split('/');
  const next = { range, projectId, from, to, [{ range: 'range', project: 'projectId', from: 'from', to: 'to' }[ctl.dataset.done]]: ctl.value };
  location.hash = `#done/${next.range}/${next.projectId}${next.range === 'custom' ? `/${next.from}/${next.to}` : ''}`;
}
