// Full Review (#full/<session>): one card at a time, full screen, with Claude alongside. You talk to
// Claude in another window; it reads the same current card over the MCP (full_review), annotates it and
// decides it with you, and the card here updates live (Realtime, with a polling fallback). Keys 1–4
// decide, s skips, u undoes. Every decision can be undone; nothing is deleted.
import { db, app, sb, run, esc, byId, toast, syncRow, tagsFor, tagLabel, isOpen } from '../state.js';
import { loadAll, refreshTasks } from '../data.js';
import { fmtDate } from '../dates.js';
import { buildQueue, priorityReason, proposalText } from '../review.js';

const F = () => (app.fr ||= { id: null, session: null, items: [], byId: new Map(), undo: [], loading: false });
const n = (x) => Number(x || 0).toLocaleString();
const RECENT = 2 * 60000; // a field Claude changed in the last two minutes is highlighted
const PAGE = 1000;
// The live connection and the poll live here, not in app.fr, so they're always stopped (even if app.fr is reset).
const L = { channel: null, poll: null };

// ---------- start ----------
export async function startFullReview(scope, title) {
  const items = buildQueue({ tasks: db.tasks, projects: db.projects, tags: db.tags, taskTags: db.taskTags, scope });
  if (!items.length) { toast('Nothing to review here: every open action is already sorted.'); return null; }
  const [session] = await run(sb.from('review_sessions').insert({ title: title || 'Full Review', scope }).select());
  for (let i = 0; i < items.length; i += 500) {
    await run(sb.from('review_items').insert(items.slice(i, i + 500).map((x) => ({ session_id: session.id, sort: x.sort, kind: x.kind, task_id: x.task_id || null, grp: x.grp || null, priority: !!x.priority }))));
  }
  const [first] = await run(sb.from('review_items').select('id').eq('session_id', session.id).order('sort').limit(1));
  await run(sb.from('review_sessions').update({ current_item: first.id }).eq('id', session.id));
  location.hash = `#full/${session.id}`;
  return session.id;
}
// Latest unfinished session for a scope (to offer Resume).
export async function activeSession(scopeKey, scopeVal) {
  const rows = await run(sb.from('review_sessions').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(20));
  return rows.find((s) => s.scope && s.scope[scopeKey] === scopeVal) || null;
}

// ---------- load and stay live ----------
async function loadSession(id) {
  const f = F();
  f.loading = true;
  try {
    const [session] = await run(sb.from('review_sessions').select('*').eq('id', id));
    const items = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await run(sb.from('review_items').select('*').eq('session_id', id).order('sort').order('id').range(from, from + PAGE - 1));
      items.push(...rows);
      if (rows.length < PAGE) break;
    }
    Object.assign(f, { id, session: session || null, items, byId: new Map(items.map((x) => [x.id, x])) });
    listen(id);
  } finally { f.loading = false; }
  app.render();
}
function listen(id) {
  const f = F();
  stopListening();
  // Realtime when available; a poll either way (cheap: the session row and the current card).
  if (sb.channel) {
    try {
      L.channel = sb.channel(`full-review-${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'review_items', filter: `session_id=eq.${id}` }, (p) => onItem(p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'review_sessions', filter: `id=eq.${id}` }, (p) => onSession(p.new))
        // Poll fast until live updates are confirmed, then slowly as a safety net.
        .subscribe((status) => { if (status === 'SUBSCRIBED' && L.poll && !window.__frPollMs) { clearInterval(L.poll); L.poll = setInterval(poll, 15000); } });
    } catch { L.channel = null; }
  }
  L.poll = setInterval(poll, window.__frPollMs || 3000);
}
export function stopListening() {
  if (L.channel) { try { sb.removeChannel(L.channel); } catch { /* ignore */ } L.channel = null; }
  if (L.poll) { clearInterval(L.poll); L.poll = null; }
}
async function poll() {
  const f = F();
  if (!f.id || !location.hash.startsWith(`#full/${f.id}`)) { stopListening(); return; }
  const [s] = await run(sb.from('review_sessions').select('*').eq('id', f.id));
  if (s) await onSession(s, { quiet: true });
  const cur = s && s.current_item;
  if (cur) { const [it] = await run(sb.from('review_items').select('*').eq('id', cur)); if (it) await onItem(it); }
}
async function onItem(row) {
  const f = F();
  if (!row || !row.id) return;
  const old = f.byId.get(row.id);
  if (old && old.updated_at === row.updated_at) return;
  if (old) Object.assign(old, row); else { f.items.push(row); f.items.sort((a, b) => a.sort - b.sort); f.byId.set(row.id, row); }
  // Claude changed the action behind this card: fetch it (and its tags) fresh.
  if (row.id === (f.session && f.session.current_item)) await refreshCard(row);
  redraw();
}
async function onSession(row, { quiet = false } = {}) {
  const f = F();
  if (!row) return;
  const moved = f.session && f.session.current_item !== row.current_item;
  const before = f.session && `${f.session.agent_seen_at}|${f.session.agent_status}|${f.session.status}`;
  f.session = row;
  if (moved) { const it = f.byId.get(row.current_item); if (it) await refreshCard(it); }
  if (moved || !quiet || before !== `${row.agent_seen_at}|${row.agent_status}|${row.status}`) redraw();
}
async function refreshCard(it) {
  if (it.kind === 'task' && it.task_id) {
    await refreshTasks([it.task_id]);
    const links = await run(sb.from('task_tags').select('*').eq('task_id', it.task_id));
    db.taskTags = db.taskTags.filter((x) => x.task_id !== it.task_id).concat(links);
  }
}
// Re-render unless you're typing somewhere.
function redraw() { if (!/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) app.render(); }

// ---------- view ----------
const claudeHere = (s) => s && s.agent_seen_at && Date.now() - Date.parse(s.agent_seen_at) < 90000;
const fresh = (it, field) => it.changed && it.changed[field] && Date.now() - Date.parse(it.changed[field]) < RECENT;
const mark = (it, field, html) => (fresh(it, field) ? `<span class="fr-new">${html}</span>` : html);
// When it was added (edits during the review don't make it look new).
const added = (t) => { const ms = Date.parse(t.created_at || 0) || 0; if (!ms) return ''; const d = Math.floor((Date.now() - ms) / 86400000); return d >= 730 ? `added ${Math.round(d / 365)} years ago` : d >= 60 ? `added ${Math.round(d / 30)} months ago` : d >= 1 ? `added ${d} day${d === 1 ? '' : 's'} ago` : 'added today'; };

function taskCard(it) {
  const t = byId(db.tasks, it.task_id);
  if (!t) return '<div class="fr-card"><p class="hint">This action isn’t loaded (it may be closed).</p></div>';
  const p = t.project_id && byId(db.projects, t.project_id);
  const why = it.priority ? priorityReason(t, p) : '';
  const tags = tagsFor(t.id).filter((g) => !/^someday/i.test(g.name));
  const row = (label, field, html) => `<div class="fr-field"><b>${label}</b><span>${mark(it, field, html)}</span></div>`;
  return `<div class="fr-card">
    <div class="fr-meta">${why ? `<span class="chip fr-why">★ ${esc(why)}</span>` : ''}<span>${esc(added(t))}</span>${t.in_inbox ? '<span>Inbox</span>' : ''}${isOpen(t) ? '' : '<span class="chip">closed</span>'}</div>
    <h2 class="fr-title">${mark(it, 'title', esc(t.title))}</h2>
    ${row('Gain', 'gain', t.gain ? `<span class="gain-text">${esc(t.gain)}</span>${t.gain_by === 'agent' ? ' <span class="chip sug">Claude suggested</span>' : ''}` : '<span class="hint">not written yet</span>')}
    ${row('Project', 'project', p ? esc(p.name) : '<span class="hint">none</span>')}
    ${row('When', 'dates', [t.planned_at && `planned ${esc(fmtDate(t.planned_at))}`, t.due_at && `due ${esc(fmtDate(t.due_at))}`, t.defer_at && `from ${esc(fmtDate(t.defer_at))}`].filter(Boolean).join(' · ') || '<span class="hint">no dates</span>')}
    ${row('Tags', 'tags', tags.length ? tags.map((g) => `<span class="chip">${esc(tagLabel(g))}</span>`).join(' ') : '<span class="hint">none</span>')}
    ${t.flagged ? row('Flag', 'flagged', '<span class="chip flagged-chip">⚑ Flagged</span>') : ''}
    ${t.notes ? `<details class="fr-notes"><summary>Notes</summary><p>${esc(t.notes.slice(0, 1200))}${t.notes.length > 1200 ? '…' : ''}</p></details>` : ''}
    ${it.note ? `<p class="fr-claude"><b>Claude:</b> ${esc(it.note)}</p>` : ''}
    <div class="fr-btns">${[['keep', 'Keep'], ['someday', 'Someday'], ['done', 'Done'], ['drop', 'Drop']].map(([d, l], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-fr="decide" data-decision="${d}"><kbd>${i + 1}</kbd> ${l}</button>`).join('')}</div>
    <p class="hint fr-edit"><button class="link-btn" data-task="${t.id}">Edit details</button></p>
  </div>`;
}
function groupCard(it) {
  const g = it.grp || {};
  const ts = (g.task_ids || []).map((x) => byId(db.tasks, x)).filter(Boolean);
  const times = ts.map((t) => Math.max(Date.parse(t.updated_at || 0) || 0, Date.parse(t.created_at || 0) || 0)).filter(Boolean);
  const yr = (ms) => new Date(ms).getFullYear();
  return `<div class="fr-card">
    <div class="fr-meta"><span class="chip">Group · ${n(ts.length)} actions</span>${times.length ? `<span>${yr(Math.min(...times))}–${yr(Math.max(...times))}</span>` : ''}</div>
    <h2 class="fr-title">${esc(g.label || 'Similar actions')}</h2>
    <ul class="fr-sample">${ts.slice(0, 6).map((t) => `<li>${esc(t.title)}</li>`).join('')}${ts.length > 6 ? `<li class="hint">+ ${n(ts.length - 6)} more</li>` : ''}</ul>
    <div class="fr-field"><b>Proposal</b><span>${mark(it, 'proposal', esc(proposalText(g.proposal, ts.length)))}</span></div>
    ${it.note ? `<p class="fr-claude"><b>Claude:</b> ${esc(it.note)}</p>` : ''}
    <div class="fr-btns">${[['accept', 'Accept'], ['one_by_one', 'One by one'], ['keep_all', 'Keep all'], ['skip', 'Skip']].map(([d, l], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-fr="decide" data-decision="${d}"><kbd>${i + 1}</kbd> ${l}</button>`).join('')}</div>
  </div>`;
}

export function viewFullReview(id) {
  const f = F();
  if (!id) return '<p class="empty">Start a Full Review from Settle in or a project’s ⋯ menu.</p>';
  if (f.id !== id && !f.loading) { loadSession(id); return '<p class="empty">Loading your review…</p>'; }
  if (!f.session) return f.loading ? '<p class="empty">Loading your review…</p>' : '<p class="empty">That review isn’t here.</p>';
  const s = f.session;
  const live = f.items.filter((x) => x.status !== 'void');
  const done = live.filter((x) => x.status === 'reviewed').length;
  const skipped = live.filter((x) => x.status === 'skipped').length;
  const cur = s.current_item && f.byId.get(s.current_item);
  const pos = cur ? live.filter((x) => x.sort <= cur.sort).length : live.length;
  const here = claudeHere(s);
  const head = `<div class="fr-head"><div><b>${esc(s.title)}</b> <span class="hint">· ${n(pos)} of ${n(live.length)} · ${n(done)} reviewed${skipped ? ` · ${n(skipped)} skipped` : ''}</span></div>
      <span class="fr-pres ${here ? 'on' : ''}">${here ? `<i></i>Claude is here${s.agent_status ? ` · ${esc(s.agent_status)}` : ''}` : `<button class="link-btn" data-fr="invite">Review with Claude</button>`}</span>
      <a class="icon-btn fr-close" href="#${esc((s.scope && s.scope.import_id) ? `settle/${s.scope.import_id}` : s.scope && s.scope.project_id ? `project/${s.scope.project_id}` : 'inbox')}" aria-label="Close" title="Close (Esc)">✕</a></div>
    <div class="cl-progress"><i style="width:${live.length ? Math.round((done / live.length) * 100) : 0}%"></i></div>`;
  if (!cur) {
    return `<div class="fr">${head}<div class="cl-done"><div class="cl-big">✓</div><h2>All reviewed</h2>
      <p>${n(done)} decided${skipped ? `, ${n(skipped)} skipped` : ''}.</p>
      <p>${skipped ? '<button class="btn" data-fr="reopen-skipped">Go through the skipped ones</button> ' : ''}${f.undo.length ? '<button class="btn" data-fr="undo">↶ Undo last</button>' : ''}</p></div></div>`;
  }
  return `<div class="fr">${head}
    ${cur.kind === 'group' ? groupCard(cur) : taskCard(cur)}
    <div class="cl-bar"><button class="btn small" data-fr="undo" ${f.undo.length ? '' : 'disabled'}>↶ Undo</button><span class="hint cl-keys">1–4 decide · s skip · u undo · Esc close</span><button class="btn small" data-fr="decide" data-decision="skip">Skip →</button></div></div>`;
}

// ---------- actions ----------
export async function fullReviewAction(el) {
  const f = F();
  const a = el.dataset.fr;
  const s = f.session;
  if (a === 'invite') {
    const text = `Let's do my Full Review together in Todo Tooling. Use the full_review tool with session ${s.id}: read the current card, ask me what I gain from it and where it belongs, annotate it (gain, project, dates, tags, a one-line note), and decide it with me. Pull anything important forward.`;
    try { await navigator.clipboard.writeText(text); toast('Copied: paste it to Claude to start'); } catch { toast(text); }
    return;
  }
  if (a === 'reopen-skipped') {
    await run(sb.from('review_items').update({ status: 'pending' }).eq('session_id', s.id).eq('status', 'skipped'));
    const first = f.items.filter((x) => x.status === 'skipped').sort((x, y) => x.sort - y.sort)[0];
    f.items.forEach((x) => { if (x.status === 'skipped') x.status = 'pending'; });
    await run(sb.from('review_sessions').update({ current_item: first.id, status: 'active', finished_at: null }).eq('id', s.id));
    await loadSession(s.id);
    return;
  }
  if ((a === 'undo' || a === 'decide') && f.busy) return; // one decision at a time (fast key presses)
  if (a === 'undo' || a === 'decide') { f.busy = true; try { await act(a, el); } finally { f.busy = false; } }
}
async function act(a, el) {
  const f = F();
  const s = f.session;
  if (a === 'undo') {
    const last = f.undo.pop();
    if (!last) return;
    await run(sb.rpc('review_undo', { item: last.id }));
    if (last.bulk) await loadAll(); else await refreshCard(last);
    await loadSession(s.id);
    toast('Undone');
    return;
  }
  if (a === 'decide') {
    const cur = s && f.byId.get(s.current_item);
    if (!cur || el.disabled) return;
    const decision = el.dataset.decision;
    el.disabled = true;
    const r = await run(sb.rpc('review_decide', { item: cur.id, decision, by: 'user' }));
    const bulk = cur.kind === 'group' && decision === 'accept';
    f.undo.push({ id: cur.id, kind: cur.kind, task_id: cur.task_id, bulk });
    if (bulk) await loadAll(); else if (cur.kind === 'task') await refreshCard(cur);
    if (decision === 'one_by_one' || bulk) await loadSession(s.id);
    else {
      cur.status = decision === 'skip' ? 'skipped' : 'reviewed'; cur.decision = decision;
      f.session = { ...s, current_item: r.next, status: r.next ? 'active' : 'done' };
      const nx = r.next && f.byId.get(r.next);
      if (nx) await refreshCard(nx);
      app.render();
    }
  }
}

// Keys on the review screen: 1–4 decide, s skip, u undo, Esc close.
export function fullReviewKey(e) {
  if (!location.hash.startsWith('#full/') || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return false;
  const btns = [...document.querySelectorAll('.fr-btns [data-fr="decide"]')];
  if (/^[1-4]$/.test(e.key) && btns[Number(e.key) - 1]) { e.preventDefault(); btns[Number(e.key) - 1].click(); return true; }
  if (e.key === 's') { const b = document.querySelector('.cl-bar [data-decision="skip"]'); if (b) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'u') { const b = document.querySelector('[data-fr="undo"]'); if (b && !b.disabled) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'Escape') { const c = document.querySelector('.fr-close'); if (c) { e.preventDefault(); location.hash = c.getAttribute('href'); return true; } }
  return false;
}
