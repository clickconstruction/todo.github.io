// Search: live local results for open items, plus completed/dropped matches from the server.
import { sb, db, app, $, esc, byId, isOpen, taskSort, tagLabel, effectiveTagIds } from '../state.js';
import { taskList } from '../rows.js';

let searchSeq = 0;
const searchTerms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matchesAll = (hay, terms) => { const h = hay.toLowerCase(); return terms.every((w) => h.includes(w)); };
const taskHaystack = (t) => [t.title, t.notes, t.completion_note, (byId(db.projects, t.project_id) || {}).name,
  ...[...effectiveTagIds(t)].map((id) => byId(db.tags, id)).filter(Boolean).map(tagLabel)].join(' ');

function searchResultsHtml(q) {
  const terms = searchTerms(q);
  if (!terms.length) return '<p class="empty">Search actions, notes, projects, folders and tags.</p>';
  const open = db.tasks.filter((t) => isOpen(t) && matchesAll(taskHaystack(t), terms)).sort(taskSort);
  const projects = db.projects.filter((p) => matchesAll(p.name + ' ' + p.notes, terms));
  const folders = db.folders.filter((f) => matchesAll(f.name, terms));
  const tags = db.tags.filter((tg) => matchesAll(tagLabel(tg), terms));
  const closed = app.searchExtra.filter((t) => !isOpen(t) && matchesAll(taskHaystack(t), terms));
  let html = '';
  if (projects.length || folders.length || tags.length) {
    html += `<div class="tally">${[
      ...folders.map((f) => `<a class="chip" href="#projects">📁 ${esc(f.name)}${f.archived_at ? ' (archived)' : ''}</a>`),
      ...projects.map((p) => `<a class="chip" href="#project/${p.id}">🗂️ ${esc(p.name)}${p.status === 'active' ? '' : ' (' + p.status.replace('_', ' ') + ')'}</a>`),
      ...tags.map((tg) => `<a class="chip" href="#tag/${tg.id}">🏷️ ${esc(tagLabel(tg))}</a>`),
    ].join('')}</div>`;
  }
  if (open.length) html += `<h2 class="section-title">Open · ${open.length}</h2>${taskList(open)}`;
  if (closed.length) html += `<h2 class="section-title">Completed & dropped · ${closed.length}</h2>${taskList(closed)}`;
  return html || '<p class="empty">No matches.</p>';
}

// Completed/dropped items aren't all loaded locally, so ask the server.
async function searchServer(q) {
  const seq = ++searchSeq;
  const terms = searchTerms(q).map((w) => w.replace(/[,()*%\\]/g, '')).filter(Boolean);
  if (!terms.length) { app.searchExtra = []; return; }
  let query = sb.from('tasks').select('*').or('completed_at.not.is.null,dropped_at.not.is.null').order('updated_at', { ascending: false }).limit(100);
  // Each word must match the title, notes, completion note, project name or a tag (a parent tag covers its children).
  terms.forEach((w) => {
    const conds = [`title.ilike.*${w}*`, `notes.ilike.*${w}*`, `completion_note.ilike.*${w}*`];
    const projectIds = db.projects.filter((p) => p.name.toLowerCase().includes(w)).map((p) => p.id);
    const tagIds = db.tags.filter((tg) => tagLabel(tg).toLowerCase().includes(w)).map((tg) => tg.id);
    const taggedIds = [...new Set(db.taskTags.filter((x) => tagIds.includes(x.tag_id)).map((x) => x.task_id))];
    if (projectIds.length) conds.push(`project_id.in.(${projectIds.join(',')})`);
    if (taggedIds.length) conds.push(`id.in.(${taggedIds.slice(0, 300).join(',')})`);
    query = query.or(conds.join(','));
  });
  const { data, error } = await query;
  if (error || seq !== searchSeq) return;
  app.searchExtra = data;
  const box = $('#search-results');
  if (box) box.innerHTML = searchResultsHtml($('#search-input').value);
}

export function viewSearch(q = '') {
  q = decodeURIComponent(q);
  setTimeout(() => {
    const input = $('#search-input');
    if (input && document.activeElement !== input) { input.focus(); input.setSelectionRange(q.length, q.length); }
  }, 0);
  if (q) searchServer(q);
  return `<div class="view-head"><h1>Search</h1></div>
    <input type="search" id="search-input" value="${esc(q)}" placeholder="Search everything…" autocomplete="off" enterkeyhint="search">
    <div id="search-results" style="margin-top:12px">${searchResultsHtml(q)}</div>`;
}

let searchTimer;
export function onSearchInput(input) {
  const q = input.value;
  history.replaceState(null, '', `#search/${encodeURIComponent(q)}`);
  $('#search-results').innerHTML = searchResultsHtml(q);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchServer(q), 250);
}
