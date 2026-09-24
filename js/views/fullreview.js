// Full Review (#full/<session>): one card at a time, full screen, with Claude alongside. You talk to
// Claude in another window; it reads the same current card over the MCP (full_review), annotates it and
// decides it with you, and the card here updates live (Realtime, with a polling fallback). Keys 1–4
// decide, s skips, u undoes. Every decision can be undone; nothing is deleted.
import { db, app, sb, run, esc, byId, toast, syncRow, tagsFor, tagLabel, isOpen, openSheet } from '../state.js';
import { loadAll, refreshTasks } from '../data.js';
import { fmtDate } from '../dates.js';
import { buildQueue, priorityReason, proposalText } from '../review.js';

const F = () => (app.fr ||= { id: null, session: null, items: [], byId: new Map(), undo: [], loading: false });

// "Which one?": a line per choice under the buttons; the one you hover or tab to lights up.
// Shown until you hide it (remembered on this device); "? Which one" brings it back.
export const GUIDE = [
  ['keep', 'Keep', 'You still mean to do it, and there’s a next step you could take.'],
  ['someday', 'Someday', 'You might want it one day, but you’re not committing now.'],
  ['done', 'Done', 'It already happened, or you did it and never ticked it off.'],
  ['drop', 'Drop', 'You no longer care about it, or it’s out of date. Nothing is deleted.'],
  ['reading', 'Reading & watching', 'Something someone else made that you haven’t read, watched or listened to yet.'],
  ['slipbox', 'Slipbox', 'An idea that’s already in your head, which you could write in a sentence or two in your own words.'],
  ['skip', 'Skip', 'Not sure yet. It comes back at the end.'],
];
const guideHidden = () => { if (app.frGuideOff !== undefined) return app.frGuideOff; try { return localStorage.getItem('tt.frGuide') === 'off'; } catch { return false; } };
const guide = () => (guideHidden()
  ? '<p class="fr-guide-off"><button class="link-btn" data-fr="guide-show">? Which one</button></p>'
  : `<div class="fr-guide"><div class="fr-guide-h"><span>Which one?</span><button class="link-btn" data-fr="guide-hide">Hide guide</button></div>
    ${GUIDE.map(([d, l, t]) => `<div class="fr-g" data-g="${d}"><b>${l}</b><span>${t}</span></div>`).join('')}</div>`);
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
  db.reviewSessions = [{ ...session, current_item: first.id }, ...(db.reviewSessions || []).filter((x) => x.id !== session.id)];
  location.hash = `#full/${session.id}`;
  return session.id;
}
// Latest unfinished session for a scope (to offer Resume).
export async function activeSession(scopeKey, scopeVal) {
  const rows = await run(sb.from('review_sessions').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(20));
  return rows.find((s) => s.scope && s.scope[scopeKey] === scopeVal) || null;
}

// The unfinished review to go back to: the one open in this tab if it's still active, else the newest.
export function currentReview() {
  const s = F().session;
  const live = (db.reviewSessions || []).filter((x) => x.status === 'active' && !(s && s.id === x.id && s.status !== 'active'));
  if (s && s.status === 'active') return s;
  return live[0] || null;
}
// Sidebar: shown only while a review is unfinished; "N left" once this tab has loaded it.
export function reviewNav() {
  const cur = currentReview();
  const f = F();
  const left = cur && f.session && f.session.id === cur.id ? f.items.filter((x) => x.status === 'pending').length : null;
  return { href: cur ? `#full/${cur.id}` : '#full', show: !!cur, badge: left ? `${left.toLocaleString()} left` : '' };
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

// The prompt that starts (or, after a break, resumes) this review with Claude in any chat that has the
// Todo Tooling tools: the session, the link, and how you work together.
export const resumePrompt = (s) => `Let's continue my Full Review in Todo Tooling (session ${s.id}, app: ${location.origin}/#full/${s.id}).

Use the full_review tool (Todo Tooling MCP). Start with action "status" and tell me the current card.

How we work: I tell you what to do with each card in a few words. You turn it into a suggestion (action "suggest") on the current card, and I press Submit in the app. Only apply changes directly if I say "just do it". Name the card in every reply, because I may have moved on in the app. Draft ahead with "upcoming" and "suggest" when I ask. Nothing gets deleted; drop means drop.`;

// ---------- view ----------
const claudeHere = (s) => s && s.agent_seen_at && Date.now() - Date.parse(s.agent_seen_at) < 90000;
const fresh = (it, field) => it.changed && it.changed[field] && Date.now() - Date.parse(it.changed[field]) < RECENT;
const mark = (it, field, html) => (fresh(it, field) ? `<span class="fr-new">${html}</span>` : html);
// When it was added (edits during the review don't make it look new).
const added = (t) => { const ms = Date.parse(t.created_at || 0) || 0; if (!ms) return ''; const d = Math.floor((Date.now() - ms) / 86400000); return d >= 730 ? `added ${Math.round(d / 365)} years ago` : d >= 60 ? `added ${Math.round(d / 30)} months ago` : d >= 1 ? `added ${d} day${d === 1 ? '' : 's'} ago` : 'added today'; };

// Claude's suggestion, waiting for your Submit: every change spelled out, the old value struck through.
const DECISION_LABEL = { keep: 'Keep', someday: 'Someday', done: 'Done', drop: 'Drop', skip: 'Skip', reading: '→ Reading & watching', slipbox: '→ Slipbox', accept: 'Accept', one_by_one: 'One by one', keep_all: 'Keep all' };
const pending = (it) => it.suggestion && !it.suggestion.applied_at && it.status === 'pending' ? it.suggestion : null;
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'no date');
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso || 0)) / 60000); return !iso ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
function suggestionBar(it, t) {
  const s = pending(it);
  if (!s) return '';
  const rows = [];
  const row = (icon, html) => rows.push(`<div class="sg-row"><span class="sg-i" aria-hidden="true">${icon}</span><span>${html}</span></div>`);
  if (it.kind === 'group') {
    const g = it.grp || {};
    const n = (g.task_ids || []).length;
    if (s.proposal) row('✦', `Proposal: ${esc(proposalText(s.proposal, n))} <span class="sg-old">${esc(proposalText(g.proposal, n))}</span>`);
    row('✓', `<b>${esc(DECISION_LABEL[s.decision] || s.decision)}</b>${s.decision === 'accept' ? ` · ${esc(proposalText(s.proposal || g.proposal, n))}` : ''}`);
  } else if (t) {
    const p = t.project_id && byId(db.projects, t.project_id);
    if (s.title && s.title !== t.title) row('✎', `Title: “${esc(s.title)}” <span class="sg-old">${esc(t.title)}</span>`);
    if ('gain' in s && s.gain !== (t.gain || '')) row('✦', `Gain: <span class="gain-text">${esc(s.gain || 'none')}</span>${s.gain_suggested ? ' <span class="chip sug">Claude’s words</span>' : ''}`);
    if ('project_id' in s && s.project_id !== t.project_id) row('🗂', `Project: ${esc(s.project_name || 'none')}${p ? ` <span class="sg-old">${esc(p.name)}</span>` : ''}`);
    [['planned', 'planned_at', 'Planned'], ['due', 'due_at', 'Due'], ['defer', 'defer_at', 'Defer until']].forEach(([k, col, l]) => { if (k in s && s[k] !== t[col]) row('🗓', `${l}: ${s[k] ? esc(when(s[k])) : 'clear'}${t[col] ? ` <span class="sg-old">${esc(when(t[col]))}</span>` : ''}`); });
    if ('flagged' in s && !!s.flagged !== !!t.flagged) row('⚑', s.flagged ? 'Flag it' : 'Unflag');
    if (s.add_tag_labels && s.add_tag_labels.length) row('🏷', `Add tags: ${s.add_tag_labels.map(esc).join(', ')}`);
    if (s.remove_tag_labels && s.remove_tag_labels.length) row('🏷', `Remove tags: ${s.remove_tag_labels.map(esc).join(', ')}`);
    row('✓', `<b>${esc(DECISION_LABEL[s.decision] || s.decision)}</b>${s.decision === 'keep' ? ` in ${esc(s.project_name || (p ? p.name : 'no project'))}` : ''}`);
  }
  return `<div class="sg-bar" role="group" aria-label="Suggested by Claude">
    <div class="sg-h"><span>✦ Suggested by Claude${s.ahead ? ' <span class="chip">drafted ahead</span>' : ', from what you said'}</span><span class="hint">${esc(ago(s.at))}</span></div>
    ${rows.join('')}${s.note ? `<p class="sg-note">${esc(s.note)}</p>` : ''}
    <div class="sg-btns"><button class="btn primary" data-fr="submit">Submit <kbd>⏎</kbd></button><button class="btn" data-fr="edit-suggestion">Edit</button><button class="btn" data-fr="dismiss">Dismiss</button></div>
  </div>`;
}

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
    ${suggestionBar(it, t)}
    <div class="fr-btns ${pending(it) ? 'fr-btns-quiet' : ''}">${[['keep', 'Keep'], ['someday', 'Someday'], ['done', 'Done'], ['drop', 'Drop']].map(([d, l], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-fr="decide" data-decision="${d}"><kbd>${i + 1}</kbd> ${l}</button>`).join('')}</div>
    <div class="fr-btns2 ${pending(it) ? 'fr-btns-quiet' : ''}"><button class="btn small" data-fr="decide" data-decision="reading" title="Something to read, watch or listen to: onto Reading &amp; watching (up next)"><kbd>5</kbd> → Reading &amp; watching</button><button class="btn small" data-fr="decide" data-decision="slipbox" title="An idea to think with, not an action: a fleeting note in your slipbox"><kbd>6</kbd> → Slipbox</button></div>
    <p class="hint fr-edit"><button class="link-btn" data-task="${t.id}">Edit details</button></p>
    ${guide()}
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
    ${suggestionBar(it, null)}
    <div class="fr-btns ${pending(it) ? 'fr-btns-quiet' : ''}">${[['accept', 'Accept'], ['one_by_one', 'One by one'], ['keep_all', 'Keep all'], ['skip', 'Skip']].map(([d, l], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-fr="decide" data-decision="${d}"><kbd>${i + 1}</kbd> ${l}</button>`).join('')}</div>
  </div>`;
}

export function viewFullReview(id) {
  const f = F();
  if (!id) { // #full (the sidebar): back into the review you're in the middle of
    const cur = currentReview();
    if (cur) { location.replace(`#full/${cur.id}`); return '<p class="empty">Loading your review…</p>'; }
    return '<p class="empty">No review in progress. Start a Full Review from Settle in or a project’s ⋯ menu.</p>';
  }
  if (f.id !== id && !f.loading) { loadSession(id); return '<p class="empty">Loading your review…</p>'; }
  if (!f.session) return f.loading ? '<p class="empty">Loading your review…</p>' : '<p class="empty">That review isn’t here.</p>';
  if (!L.poll) { listen(id); poll(); } // back from another screen: live again, and catch up on what changed meanwhile
  const s = f.session;
  const live = f.items.filter((x) => x.status !== 'void');
  const done = live.filter((x) => x.status === 'reviewed').length;
  const skipped = live.filter((x) => x.status === 'skipped').length;
  const cur = s.current_item && f.byId.get(s.current_item);
  const pos = cur ? live.filter((x) => x.sort <= cur.sort).length : live.length;
  const here = claudeHere(s);
  const head = `<div class="fr-head"><div><b>${esc(s.title)}</b> <span class="hint">· ${n(pos)} of ${n(live.length)} · ${n(done)} reviewed${skipped ? ` · ${n(skipped)} skipped` : ''}</span></div>
      <span class="fr-pres ${here ? 'on' : ''}">${here ? `<i></i>Claude is here${s.agent_status ? ` · ${esc(s.agent_status)}` : ''}` : 'Claude isn’t connected'}</span>
      <button class="btn small fr-copy" data-fr="invite" title="Copy the prompt that starts or resumes this review with Claude">⧉ Prompt for Claude</button>
      <a class="icon-btn fr-close" href="#${esc((s.scope && s.scope.import_id) ? `settle/${s.scope.import_id}` : s.scope && s.scope.project_id ? `project/${s.scope.project_id}` : 'inbox')}" aria-label="Close" title="Close (Esc)">✕</a></div>
    <div class="cl-progress"><i style="width:${live.length ? Math.round((done / live.length) * 100) : 0}%"></i></div>`;
  if (!cur) {
    return `<div class="fr">${head}<button class="fab fr-fab" data-fr="capture" aria-label="Capture an idea (added to this review)">+</button><div class="cl-done"><div class="cl-big">✓</div><h2>All reviewed</h2>
      <p>${n(done)} decided${skipped ? `, ${n(skipped)} skipped` : ''}.</p>
      <p>${skipped ? '<button class="btn" data-fr="reopen-skipped">Go through the skipped ones</button> ' : ''}${f.undo.length ? '<button class="btn" data-fr="undo">↶ Undo last</button>' : ''}</p></div></div>`;
  }
  return `<div class="fr">${head}
    <button class="fab fr-fab" data-fr="capture" aria-label="Capture an idea (added to this review)" title="Capture an idea: it's added to this review as a later card (N)">+</button>
    ${cur.kind === 'group' ? groupCard(cur) : taskCard(cur)}
    <div class="cl-bar"><button class="btn small" data-fr="undo" ${f.undo.length ? '' : 'disabled'}>↶ Undo</button><span class="hint cl-keys">1–6 decide · s skip · u undo · n capture · Esc close</span><button class="btn small" data-fr="decide" data-decision="skip">Skip →</button></div></div>`;
}

// ---------- capture during the review ----------
// A good idea mid-review: capture it (Inbox, with its gain) and add it to the end of this review as a later card.
export async function addToReview(taskId) {
  const f = F();
  const s = f.session;
  if (!s || !taskId) return null;
  const lastSort = f.items.reduce((m, x) => Math.max(m, x.sort), 0);
  const [row] = await run(sb.from('review_items').insert({ session_id: s.id, sort: Math.floor(lastSort + 1), kind: 'task', task_id: taskId, priority: false }).select());
  f.items.push(row); f.byId.set(row.id, row);
  if (s.status === 'done' || !s.current_item) { // the review had finished: this is the next card
    await run(sb.from('review_sessions').update({ current_item: row.id, status: 'active', finished_at: null }).eq('id', s.id));
    f.session = { ...s, current_item: row.id, status: 'active' };
  }
  return row;
}
export async function captureIntoReview() {
  const { openQuickEntry } = await import('../editors/task.js');
  openQuickEntry({ heading: 'Capture · added to this review', onCaptured: async (task) => {
    if (!task) { toast('Saved offline; add it to the review once you’re back online'); return; }
    await addToReview(task.id);
    const live = F().items.filter((x) => x.status !== 'void').length;
    app.render();
    toast(`Captured · added to the review as card ${live.toLocaleString()}`);
  } });
}

// ---------- actions ----------
export async function fullReviewAction(el) {
  const f = F();
  const a = el.dataset.fr;
  const s = f.session;
  if (a === 'guide-hide' || a === 'guide-show') { app.frGuideOff = a === 'guide-hide'; try { localStorage.setItem('tt.frGuide', a === 'guide-hide' ? 'off' : 'on'); } catch { /* private mode: this screen only */ } app.render(); return; }
  if (a === 'invite') {
    const text = resumePrompt(s);
    try { await navigator.clipboard.writeText(text); toast('Copied: paste it into Claude to start or resume'); return; } catch { /* no clipboard: show it to copy by hand */ }
    const sheet = openSheet(`<form method="dialog" class="fr-prompt"><h2>Prompt for Claude</h2><p class="hint">Paste this into Claude to start or resume this review.</p>
      <textarea readonly rows="9">${esc(text)}</textarea><div class="actions"><div class="right"><button class="btn primary">Done</button></div></div></form>`);
    sheet.showModal();
    const ta = sheet.querySelector('textarea'); ta.focus(); ta.select();
    return;
  }
  if (a === 'capture') { captureIntoReview(); return; }
  if (a === 'reopen-skipped') {
    await run(sb.from('review_items').update({ status: 'pending' }).eq('session_id', s.id).eq('status', 'skipped'));
    const first = f.items.filter((x) => x.status === 'skipped').sort((x, y) => x.sort - y.sort)[0];
    f.items.forEach((x) => { if (x.status === 'skipped') x.status = 'pending'; });
    await run(sb.from('review_sessions').update({ current_item: first.id, status: 'active', finished_at: null }).eq('id', s.id));
    await loadSession(s.id);
    return;
  }
  if (['undo', 'decide', 'submit'].includes(a) && f.busy) return; // one decision at a time (fast key presses)
  if (['undo', 'decide', 'submit'].includes(a)) { f.busy = true; try { await act(a, el); } finally { f.busy = false; } }
  if (a === 'dismiss' || a === 'edit-suggestion') {
    const cur = s && f.byId.get(s.current_item);
    if (!cur) return;
    const sug = pending(cur);
    await run(sb.from('review_items').update({ suggestion: null }).eq('id', cur.id));
    cur.suggestion = null;
    if (a === 'edit-suggestion' && sug && cur.kind === 'task') {
      // Open the action with Claude's values filled in; saving applies them, then you decide the card.
      const t = byId(db.tasks, cur.task_id);
      const { openEditor } = await import('../editors/task.js');
      openEditor({ ...t, ...(sug.title ? { title: sug.title } : {}), ...('gain' in sug ? { gain: sug.gain, gain_by: sug.gain_suggested ? 'agent' : null } : {}),
        ...('project_id' in sug ? { project_id: sug.project_id } : {}), ...('planned' in sug ? { planned_at: sug.planned } : {}), ...('due' in sug ? { due_at: sug.due } : {}),
        ...('defer' in sug ? { defer_at: sug.defer } : {}), ...('flagged' in sug ? { flagged: sug.flagged } : {}) });
    }
    app.render();
  }
}
async function act(a, el) {
  const f = F();
  const s = f.session;
  if (a === 'submit') {
    const cur = s && f.byId.get(s.current_item);
    const sug = cur && pending(cur);
    if (!sug) return;
    const r = await run(sb.rpc('review_apply', { item: cur.id }));
    const bulk = cur.kind === 'group' && sug.decision === 'accept';
    f.undo.push({ id: cur.id, kind: cur.kind, task_id: cur.task_id, bulk: bulk || !!(sug.add_tag_names && sug.add_tag_names.length) });
    if (bulk || (sug.add_tag_names && sug.add_tag_names.length)) await loadAll(); else if (cur.kind === 'task') await refreshCard(cur);
    if (sug.decision === 'one_by_one' || bulk) { await loadSession(s.id); return; }
    cur.status = sug.decision === 'skip' ? 'skipped' : 'reviewed'; cur.decision = sug.decision; cur.suggestion = { ...sug, applied_at: new Date().toISOString() };
    f.session = { ...s, current_item: r.next, status: r.next ? 'active' : 'done' };
    const nx = r.next && f.byId.get(r.next);
    if (nx) await refreshCard(nx);
    app.render();
    return;
  }
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
    if (decision === 'slipbox') db.slipbox = await run(sb.from('slipbox_notes').select('*').is('archived_at', null));
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
  if (e.key === 'n') { e.preventDefault(); captureIntoReview(); return true; }
  if (e.key === 'Enter') { const b = document.querySelector('[data-fr="submit"]'); if (b) { e.preventDefault(); b.click(); return true; } }
  const btns = [...document.querySelectorAll('.fr-btns [data-fr="decide"], .fr-btns2 [data-fr="decide"]')];
  if (/^[1-6]$/.test(e.key) && btns[Number(e.key) - 1]) { e.preventDefault(); btns[Number(e.key) - 1].click(); return true; }
  if (e.key === 's') { const b = document.querySelector('.cl-bar [data-decision="skip"]'); if (b) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'u') { const b = document.querySelector('[data-fr="undo"]'); if (b && !b.disabled) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'Escape') { const c = document.querySelector('.fr-close'); if (c) { e.preventDefault(); location.hash = c.getAttribute('href'); return true; } }
  return false;
}
