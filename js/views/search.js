// Search: live local results for open items, plus completed/dropped matches from the server.
import { sb, db, app, $, esc, byId, isOpen, taskSort, tagLabel, effectiveTagIds } from '../state.js';
import { taskList } from '../rows.js';
import { eventRow } from './events.js';

let searchSeq = 0;
const searchTerms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matchesAll = (hay, terms) => { const h = hay.toLowerCase(); return terms.every((w) => h.includes(w)); };
const taskHaystack = (t) => [t.title, t.notes, t.gain, t.gain_cost, t.completion_note, (byId(db.projects, t.project_id) || {}).name,
  ...[...effectiveTagIds(t)].map((id) => byId(db.tags, id)).filter(Boolean).map(tagLabel)].join(' ');

// The words around the first match, with every match marked (for notes, reference and the like).
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function marked(text, terms) {
  const s = String(text || '');
  if (!terms.length) return esc(s);
  const re = new RegExp(`(${terms.map(reEsc).join('|')})`, 'gi');
  return s.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}
function snippet(text, terms, width = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  const at = Math.min(...terms.map((w) => { const i = low.indexOf(w); return i < 0 ? Infinity : i; }));
  const from = Number.isFinite(at) ? Math.max(0, at - 40) : 0; // matched in the title: the opening of the text
  return `${from > 0 ? '…' : ''}${marked(s.slice(from, from + width), terms)}${from + width < s.length ? '…' : ''}`;
}
const resultRow = (href, icon, title, text, terms, tail = '') => `<a class="group-row sr-row" href="${href}"><span class="group-main"><span>${icon} ${marked(title, terms)}${tail}</span>${text && snippet(text, terms) ? `<span class="hint sr-snip">${snippet(text, terms)}</span>` : ''}</span></a>`;

function searchResultsHtml(q) {
  const terms = searchTerms(q);
  if (!terms.length) return '<p class="empty">Search everything: actions, projects, the Slipbox, reference, events, people, places, checklists, areas and goals.</p>';
  const open = db.tasks.filter((t) => isOpen(t) && matchesAll(taskHaystack(t), terms)).sort(taskSort);
  const projects = db.projects.filter((p) => matchesAll(p.name + ' ' + p.notes, terms));
  const folders = db.folders.filter((f) => matchesAll(f.name, terms));
  const tags = db.tags.filter((tg) => matchesAll(tagLabel(tg), terms));
  const closed = app.searchExtra.filter((t) => !isOpen(t) && matchesAll(taskHaystack(t), terms));
  const live = (list) => (list || []).filter((x) => !x.archived_at);
  const notes = live(db.slipbox).filter((n) => matchesAll(`${n.title} ${n.body} ${n.source || ''}`, terms)).slice(0, 50);
  const refs = live(db.references).filter((r) => matchesAll(`${r.title} ${r.topic || ''} ${r.body || ''}`, terms)).slice(0, 50); // never the secret value
  const events = live(db.events).filter((e) => matchesAll(`${e.title} ${e.location || ''} ${e.notes || ''}`, terms)).sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 30);
  const people = live(db.people).filter((p) => matchesAll(`${p.name} ${p.email || ''} ${p.notes || ''}`, terms));
  const places = live(db.places).filter((p) => matchesAll(`${p.name} ${p.address || ''} ${p.notes || ''}`, terms));
  const checklists = live(db.checklists).filter((c) => matchesAll(`${c.name} ${(c.items || []).map((i) => i.text).join(' ')}`, terms));
  const areas = live(db.areas).filter((a) => matchesAll(`${a.name} ${a.standards || ''}`, terms));
  const goals = (db.goals || []).filter((g) => matchesAll(`${g.title} ${g.why || ''}`, terms));
  let html = '';
  if (projects.length || folders.length || tags.length || people.length || places.length || checklists.length || areas.length || goals.length) {
    html += `<div class="tally">${[
      ...folders.map((f) => `<a class="chip" href="#projects">📁 ${esc(f.name)}${f.archived_at ? ' (archived)' : ''}</a>`),
      ...projects.map((p) => `<a class="chip" href="#project/${p.id}">🗂️ ${esc(p.name)}${p.status === 'active' ? '' : ' (' + p.status.replace('_', ' ') + ')'}</a>`),
      ...tags.map((tg) => `<a class="chip" href="#tag/${tg.id}">🏷️ ${esc(tagLabel(tg))}</a>`),
      ...people.map((p) => `<a class="chip" href="#person/${p.id}">👤 ${esc(p.name)}</a>`),
      ...places.map((p) => `<a class="chip" href="#nearby/${p.id}">📍 ${esc(p.name)}</a>`),
      ...checklists.map((c) => `<a class="chip" href="#checklist/${c.id}">☑️ ${esc(c.name)}</a>`),
      ...areas.map((a) => `<a class="chip" href="#area/${a.id}">🏔️ ${esc(a.name)}</a>`),
      ...goals.map((g) => `<a class="chip" href="#goal/${g.id}">🎯 ${esc(g.title)}${g.status && g.status !== 'active' ? ` (${esc(g.status)})` : ''}</a>`),
    ].join('')}</div>`;
  }
  if (open.length) html += `<h2 class="section-title">Open · ${open.length}</h2>${taskList(open)}`;
  if (notes.length) html += `<h2 class="section-title">Slipbox · ${notes.length}</h2><div class="group-list">${notes.map((n) => resultRow(`#slipbox/${n.id}`, '🗃️', n.title, n.body, terms, ` <span class="chip">${n.kind === 'fleeting' ? 'fleeting' : 'permanent'}</span>`)).join('')}</div>`;
  if (refs.length) html += `<h2 class="section-title">Reference · ${refs.length}</h2><div class="group-list">${refs.map((r) => resultRow(`#reference/${r.id}`, r.secret_value ? '🔑' : '🗄️', r.title, [r.topic, r.body].filter(Boolean).join(' · '), terms)).join('')}</div>`;
  if (events.length) html += `<h2 class="section-title">Events · ${events.length}</h2><ul class="list cal-list ev-list">${events.map(eventRow).join('')}</ul>`;
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
    const conds = [`title.ilike.*${w}*`, `notes.ilike.*${w}*`, `gain.ilike.*${w}*`, `completion_note.ilike.*${w}*`];
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
