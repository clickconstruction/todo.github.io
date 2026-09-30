// Full Review (#full/<session>): one card at a time, full screen, with Claude alongside. You talk to
// Claude in another window; it reads the same current card over the MCP (full_review), annotates it and
// decides it with you, and the card here updates live (Realtime, with a polling fallback). Keys 1–4
// decide, s skips, u undoes. Every decision can be undone; nothing is deleted.
// "Keep Claude ahead" (review_sessions.draft_ahead): a box in the header. While it is ticked and Claude is
// running, Claude keeps a suggestion waiting on each of the next cards, so a card has one when you reach it.
import { describeDaily, isDaily, isWeekly, summary as dailySummary, dailyPreview } from '../dailies.js';
import { describe } from '../repeat.js';
import { treeChangeHtml, treeWithout } from './tree.js';
import { db, app, sb, run, esc, byId, toast, syncRow, tagsFor, tagLabel, isOpen, openSheet, $ } from '../state.js';
import { loadAll, refreshTasks } from '../data.js';
import { fmtDate } from '../dates.js';
import { buildQueue, priorityReason, proposalText } from '../review.js';
import { folderButton, shortPath } from '../folders.js';

const F = () => (app.fr ||= { id: null, session: null, items: [], byId: new Map(), peek: null, loading: false });

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
const AHEAD = 10; // Keep Claude ahead: how many cards past the current one (as mcp/src/fullreview.js)
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
async function loadSession(id, { draw = true } = {}) {
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
  if (draw) app.render();
}

// A reload lands on the card, not on a blank page: the review and the current card's action are a few small
// reads, so they go first and the card shows while the library (thousands of actions) loads behind it.
export async function quickReview(id) {
  const f = F();
  document.body.classList.add('fr-mode');
  const view = $('#view'); if (view && !view.innerHTML.trim()) view.innerHTML = '<p class="empty">Loading your review…</p>';
  try {
    await loadSession(id, { draw: false });
    const cur = f.session && f.session.current_item && f.byId.get(f.session.current_item);
    if (!app.libraryLoading) return; // the library got there first
    if (cur && cur.kind === 'task') {
      await refreshCard(cur);
      const t = byId(db.tasks, cur.task_id);
      const tagIds = db.taskTags.filter((x) => x.task_id === cur.task_id).map((x) => x.tag_id).filter((x) => !byId(db.tags, x));
      const [tags, projects] = await Promise.all([
        tagIds.length ? run(sb.from('tags').select('*').in('id', tagIds)) : [],
        t && t.project_id && !byId(db.projects, t.project_id) ? run(sb.from('projects').select('*').eq('id', t.project_id)) : [],
      ]);
      if (!app.libraryLoading) return;
      tags.forEach((g) => { if (!byId(db.tags, g.id)) db.tags.push(g); });
      projects.forEach((p) => { if (!byId(db.projects, p.id)) db.projects.push(p); });
    } else if (cur && cur.kind === 'group') {
      const ids = ((cur.grp && cur.grp.task_ids) || []).slice(0, 200);
      if (ids.length) await refreshTasks(ids);
    }
    if (app.libraryLoading) app.render();
  } catch { /* the full load follows and shows what went wrong */ }
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
  refreshPresence();
  const cur = s && s.current_item;
  if (cur) { const [it] = await run(sb.from('review_items').select('*').eq('id', cur)); if (it) await onItem(it); }
  if (s && s.draft_ahead) await refreshAhead();
}
// Keep Claude ahead: the next cards, and how many already have a suggestion waiting.
function aheadOf(cur) {
  const next = cur ? F().items.filter((x) => x.status === 'pending' && x.sort > cur.sort).slice(0, AHEAD) : [];
  return { next, drafted: next.filter((x) => pending(x)).length };
}
// Their suggestions, read fresh: live updates usually bring them, and this is the safety net.
async function refreshAhead() {
  const f = F();
  const ids = aheadOf(f.session && f.byId.get(f.session.current_item)).next.map((x) => x.id);
  if (!ids.length) return;
  const rows = await run(sb.from('review_items').select('id,status,suggestion,updated_at').in('id', ids));
  let changed = false;
  rows.forEach((row) => { const old = f.byId.get(row.id); if (old && old.updated_at !== row.updated_at) { Object.assign(old, row); changed = true; } });
  if (changed) redraw();
}
// Landing on the next card: its action fresh and, while keeping ahead, the card itself, so a suggestion
// drafted a moment ago is on it when it shows.
async function arrive(it) {
  const f = F();
  const [, rows] = await Promise.all([refreshCard(it), f.session && f.session.draft_ahead ? run(sb.from('review_items').select('*').eq('id', it.id)) : []]);
  if (rows[0]) Object.assign(it, rows[0]);
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
  const left = moved ? f.session.current_item : null;
  const key = (x) => `${x.agent_seen_at}|${x.agent_status}|${x.status}|${!!x.draft_ahead}`;
  const before = f.session && key(f.session);
  f.session = row;
  if (moved) { const it = f.byId.get(row.current_item); if (it) await refreshCard(it); }
  // The card just left was decided somewhere (here, another device, Claude): fetch it, so Undo and Back know.
  if (left) { const [was] = await run(sb.from('review_items').select('*').eq('id', left)); if (was) { const old = f.byId.get(was.id); if (old) Object.assign(old, was); } }
  if (moved || !quiet || before !== key(row)) redraw();
}
async function refreshCard(it) {
  if (it.kind === 'task' && it.task_id) {
    await refreshTasks([it.task_id]);
    const steps = await run(sb.from('tasks').select('*').eq('parent_id', it.task_id)); // a Submit can add steps; an Undo drops them
    steps.forEach((row) => { if (byId(db.tasks, row.id)) syncRow('tasks', null, row); else db.tasks.push(row); });
    const links = await run(sb.from('task_tags').select('*').eq('task_id', it.task_id));
    db.taskTags = db.taskTags.filter((x) => x.task_id !== it.task_id).concat(links);
  }
}
// Re-render unless you're typing somewhere (a field left focused in a sheet that has closed isn't typing).
function redraw() {
  const el = document.activeElement || {};
  const sheet = el.closest && el.closest('dialog');
  if (!/INPUT|TEXTAREA|SELECT/.test(el.tagName || '') || (sheet && !sheet.open)) app.render();
}

// The prompt that starts (or, after a break, resumes) this review with Claude in any chat that has the
// Todo Tooling tools: the session, the link, and how you work together.
export const resumePrompt = (s) => `Let's continue my Full Review in Todo Tooling (session ${s.id}, app: ${location.origin}/#full/${s.id}).

Use the full_review tool (Todo Tooling MCP). Start with action "status" and tell me the current card.

How we work: I tell you what to do with each card in a few words. You turn it into a suggestion (action "suggest") on the current card, and I press Submit in the app. When I say "submit" (for example "submit, next card"), press Submit for me (action "submit"). Only apply changes directly if I say "just do it". Name the card in every reply, because I may have moved on in the app. Draft ahead with "upcoming" and "suggest" when I ask. Nothing gets deleted; drop means drop.

Keep ahead${s.draft_ahead ? ' (it is on now)' : ''}: when status says draft_ahead is on (the "Keep Claude ahead" box in the app), keep a suggestion waiting on each of the next ${AHEAD} cards without being asked. Draft the ones status lists as missing ("upcoming", then "suggest" with items), then check status again about every 30 seconds for as long as it stays on (in Claude Code: /loop, or a scheduled wake-up). Leave the card I'm on alone unless I ask, and stop when I untick it.`;

// ---------- undo and looking back ----------
// Undo follows the review, not this tab: it takes back the card decided last, whoever decided it (you here,
// you on another device, Claude pressing Submit for you), and it still knows after a reload. Pressed again it
// takes back the one before. Back looks at decided cards without changing anything.
const isDecided = (x) => (x.status === 'reviewed' || x.status === 'skipped') && !!x.reviewed_at;
const decidedList = () => F().items.filter(isDecided).sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)));
const short = (text, max = 38) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
function cardTitle(it) {
  if (!it) return '';
  if (it.kind === 'group') return (it.grp && it.grp.label) || 'Similar actions';
  const t = byId(db.tasks, it.task_id);
  return t ? t.title : '';
}
// What an Undo gave back, in words, from the card's own record of how things were (review_items.before).
function restoredText(it, t) {
  const out = [];
  const same = (a, b) => (a || null) === (b || null) || (a && b && Date.parse(a) === Date.parse(b));
  (it.before || []).forEach((e) => {
    if (e.t === 'fields' && t) {
      if (e.title !== t.title) out.push('its title');
      if ('notes' in e && (e.notes || '') !== (t.notes || '')) out.push('its notes');
      if ((e.gain || '') !== (t.gain || '')) out.push('its gain');
      if ((e.project_id || null) !== (t.project_id || null)) out.push('its project');
      if (!same(e.due_at, t.due_at)) out.push(e.due_at ? `due ${when(e.due_at)}` : 'no due date');
      if (!same(e.planned_at, t.planned_at)) out.push(e.planned_at ? `planned ${when(e.planned_at)}` : 'no planned date');
      if (!same(e.defer_at, t.defer_at)) out.push(e.defer_at ? `deferred to ${when(e.defer_at)}` : 'no defer date');
      if (!!e.flagged !== !!t.flagged) out.push(e.flagged ? 'its flag' : 'no flag');
      const now = tagsFor(t.id).map((g) => g.id).sort().join(); if ((e.tags || []).slice().sort().join() !== now) out.push('its tags');
    }
    if (e.t === 'daily') out.push(e.daily ? 'its daily setting' : e.repeat_rule ? 'its repeat, not daily' : 'not daily');
    if (e.t === 'tree') { const k = (e.goals || []).length + (e.tasks || []).length; out.push(`the tech tree (${k ? `${k} new item${k === 1 ? '' : 's'} taken back` : 'its new links taken back'})`); }
    if (e.t === 'steps') out.push(`the ${n((e.ids || []).length)} added step${(e.ids || []).length === 1 ? '' : 's'} dropped`);
    if (e.t === 'checklist') out.push(e.prev ? 'its earlier checklist' : 'no checklist');
    if (e.t === 'task' && (it.decision === 'done' || it.decision === 'drop')) out.push('open again');
    if (e.t === 'someday_tag') out.push('out of Someday');
    if (e.t === 'reading') out.push('off Reading & watching');
    if (e.t === 'slipbox') out.push('its Slipbox note archived');
  });
  return [...new Set(out)];
}
async function undoCard(id) {
  const f = F(); const s = f.session;
  const [row] = await run(sb.from('review_items').select('*').eq('id', id));
  if (!row || !isDecided(row)) { if (row && f.byId.get(id)) Object.assign(f.byId.get(id), row); f.peek = null; app.render(); toast('That card is already undecided'); return; }
  if (f.byId.get(id)) Object.assign(f.byId.get(id), row);
  const heavy = row.kind === 'group' || (row.before || []).some((e) => e.t === 'tree' || e.t === 'expanded' || (e.t === 'someday_tag' && (e.ids || []).length > 1));
  if (row.kind === 'task') await refreshCard(row); // how it is now, to say what comes back
  const title = cardTitle(row);
  const back = row.kind === 'task' ? restoredText(row, byId(db.tasks, row.task_id)) : [];
  const label = DECISION_LABEL[row.decision] || row.decision || 'decided';
  await run(sb.rpc('review_undo', { item: id }));
  f.peek = null;
  if (heavy) { await loadAll(); await loadSession(s.id); } else {
    // Only this card changed: its row, its action, the session's place. No need to read the whole review again.
    const [[it], [ses]] = await Promise.all([run(sb.from('review_items').select('*').eq('id', id)), run(sb.from('review_sessions').select('*').eq('id', s.id))]);
    if (it && f.byId.get(id)) Object.assign(f.byId.get(id), it);
    if (ses) f.session = ses;
    await refreshCard(row);
    if ((row.before || []).some((e) => e.t === 'checklist')) db.checklists = await run(sb.from('checklists').select('*').order('sort'));
    if (row.decision === 'slipbox') db.slipbox = await run(sb.from('slipbox_notes').select('*').is('archived_at', null));
    app.render();
  }
  toast(`Undone “${short(cardTitle(row) || title, 44)}”: ${label.replace(/^→ /, '')} taken back${back.length ? ` · ${back.slice(0, 4).join(', ')}${back.length > 4 ? '…' : ''} restored` : ''}`);
}
// Back / Forward through the decided cards, newest first; past the newest is the current card again.
async function look(dir) {
  const f = F(); const list = decidedList();
  const i = f.peek ? list.findIndex((x) => x.id === f.peek) : -1;
  const j = i + (dir === 'back' ? 1 : -1);
  if (dir === 'back' && j >= list.length) { toast('That’s the first card you decided'); return; }
  f.peek = j < 0 ? null : list[j].id;
  if (f.peek) await refreshCard(list[j]); // it may have been closed a while ago and not be loaded
  app.render();
}
function lookingBar(it, list) {
  const i = list.findIndex((x) => x.id === it.id);
  const groupLater = it.kind === 'group' && i > 0; // a group's Undo is only safe while nothing was decided after it
  return `<div class="fr-look" role="status"><span><b>Looking back</b> · ${esc(DECISION_LABEL[it.decision] || it.decision || 'decided')}${it.decided_by === 'agent' ? ' by Claude' : ''} · ${esc(ago(it.reviewed_at))} <span class="hint">· ${n(i + 1)} back of ${n(list.length)}</span></span>
    <span class="fr-look-btns"><button class="btn small" data-fr="undo" data-id="${it.id}" ${groupLater ? 'disabled title="Undo the cards decided after this group first"' : ''}>↶ Undo this card</button><button class="btn small primary" data-fr="look-now">Current card →</button></span></div>`;
}

// ---------- view ----------
// Claude only acts when you message it, so "connected" is about the conversation, not a live socket:
//   here: acted in the last 90 s (working on your card now) · along: checked in within 45 min (the chat
//   is going; it knows your card) · away: longer, or never (paste the prompt to bring it back).
const claudeSeen = (s) => {
  const ms = s && s.agent_seen_at ? Date.now() - Date.parse(s.agent_seen_at) : Infinity;
  return ms < 90000 ? 'here' : ms < 45 * 60000 ? 'along' : 'away';
};
function presenceHtml(s) {
  const st = claudeSeen(s);
  if (st === 'here') return `<i></i>Claude is here${s.agent_status ? ` · ${esc(s.agent_status)}` : ''}`;
  if (st === 'along') { const m = Math.max(1, Math.round((Date.now() - Date.parse(s.agent_seen_at)) / 60000)); return `<i class="along"></i>Claude is following along · checked in ${m} min ago`; }
  return s && s.agent_seen_at ? 'Claude hasn’t checked in lately' : 'Claude isn’t connected';
}
// Keep the line current between redraws (the minutes tick, "here" fades to "following along").
function refreshPresence() {
  const el = document.querySelector('.fr-pres'); const s = F().session;
  if (!el || !s) return;
  const st = claudeSeen(s);
  el.className = `fr-pres ${st === 'away' ? '' : 'on'} ${st}`;
  const html = presenceHtml(s); if (el.innerHTML !== html) el.innerHTML = html;
  const copy = document.querySelector('.fr-copy'); if (copy) copy.classList.toggle('primary', st === 'away');
}
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
    if (s.task_notes && s.task_notes !== (t.notes || '')) row('📝', notesRow(it, s.task_notes, t.notes || ''));
    if ('gain' in s && s.gain !== (t.gain || '')) row('✦', `Gain: <span class="gain-text">${esc(s.gain || 'none')}</span>${s.gain_suggested ? ' <span class="chip sug">Claude’s words</span>' : ''}`);
    if ('project_id' in s && s.project_id !== t.project_id) row('🗂', `Project: ${esc(s.project_name || 'none')}${p ? ` <span class="sg-old">${esc(p.name)}</span>` : ''}`);
    [['planned', 'planned_at', 'Planned'], ['due', 'due_at', 'Due'], ['defer', 'defer_at', 'Defer until']].forEach(([k, col, l]) => { if (k in s && s[k] !== t[col]) row('🗓', `${l}: ${s[k] ? esc(when(s[k])) : 'clear'}${t[col] ? ` <span class="sg-old">${esc(when(t[col]))}</span>` : ''}`); });
    if ('flagged' in s && !!s.flagged !== !!t.flagged) row('⚑', s.flagged ? 'Flag it' : 'Unflag');
    if ('folder' in s && (s.folder || null) !== (t.folder_path || null)) row('📂', s.folder ? `Folder: <span class="fr-folder">${esc(shortPath(s.folder))}</span>${folderButton(s.folder, { label: 'Open', cls: 'link-btn' })}${t.folder_path ? ` <span class="sg-old">${esc(shortPath(t.folder_path))}</span>` : ''}` : 'Remove the folder');
    if (s.add_tag_labels && s.add_tag_labels.length) row('🏷', `Add tags: ${s.add_tag_labels.map(esc).join(', ')}`);
    if (s.remove_tag_labels && s.remove_tag_labels.length) row('🏷', `Remove tags: ${s.remove_tag_labels.map(esc).join(', ')}`);
    if (Array.isArray(s.steps) && s.steps.length && ['keep', 'someday'].includes(s.decision)) {
      const n = countSteps(s.steps);
      row('🪜', `Break it down: ${n} step${n === 1 ? '' : 's'}${s.steps_in_order ? ', in order' : ''}${n > s.steps.length ? ' <span class="hint">(nested)</span>' : ''}${stepsOf(t).length ? ` <span class="hint">(after the ${stepsOf(t).length} it has)</span>` : ''}${stepsHtml(s.steps)}`);
    }
    if (s.daily && s.decision === 'keep') row('🔂', `${s.daily.every === 'week' ? 'Make it a weekly check' : 'Make it daily'}: <b>${esc(describeDaily(s.daily))}</b> <span class="hint">a checkbox that starts fresh each ${s.daily.every === 'week' ? 'review' : 'day'}</span>${t.repeat_rule || t.due_at || t.planned_at ? ` <span class="sg-old">${esc([t.repeat_rule && describe(t.repeat_rule), t.due_at && `due ${when(t.due_at)}`, t.planned_at && `planned ${when(t.planned_at)}`].filter(Boolean).join(' · '))}</span>` : ''}${dailyPreview(s.title || t.title, s.daily)}`);
    if (s.tree && Array.isArray(s.tree.items) && s.tree.items.length && ['keep', 'someday'].includes(s.decision)) row('🌳', treeChangeHtml(s.tree));
    if (s.checklist && ['keep', 'someday'].includes(s.decision)) {
      const ck = s.checklist;
      const list = Array.isArray(ck.items) ? ck.items : [];
      let sec = null;
      const lis = list.map((i) => `${(i.section || '') !== sec ? (sec = i.section || '', i.section ? `<li class="sg-sec">${esc(i.section)}</li>` : '') : ''}<li>${esc(i.text)}</li>`).join('');
      const n = ck.id ? ck.count : list.length;
      row('☑', `Checklist: <b>${esc(ck.name)}</b> · ${n} item${n === 1 ? '' : 's'}${ck.reflect ? ', a line on each every run' : ''}${ck.id ? ' <span class="hint">(your existing one)</span>' : ''}${ck.complete_action === false ? ' <span class="hint">· ticking all doesn’t complete it</span>' : ''}${lis ? `<ul class="sg-steps sg-check">${lis}</ul>` : ''}`);
    }
    row('✓', `<b>${esc(DECISION_LABEL[s.decision] || s.decision)}</b>${s.decision === 'keep' ? ` in ${esc(s.project_name || (p ? p.name : 'no project'))}` : ''}`);
  }
  return `<div class="sg-bar" role="group" aria-label="Suggested by Claude">
    <div class="sg-h"><span>✦ Suggested by Claude${s.ahead ? ' <span class="chip">drafted ahead</span>' : ', from what you said'}</span><span class="hint">${esc(ago(s.at))}</span></div>
    ${rows.join('')}${s.note ? `<p class="sg-note">${esc(s.note)}</p>` : ''}
    <div class="sg-btns"><button class="btn primary" data-fr="submit">Submit <kbd>⏎</kbd></button><button class="btn" data-fr="edit-suggestion">Edit</button><button class="btn" data-fr="dismiss">Dismiss</button></div>
  </div>`;
}

// New notes in a suggestion: where they go (the card's Notes), how much there is, what they replace, and the
// text itself to check and copy before Submit: open when short, folded behind its first line when long.
const sizeOf = (text) => { const l = text.split('\n').length; return `${n(l)} line${l === 1 ? '' : 's'} · ${n(text.length)} characters`; };
const firstLine = (text, max = 70) => { const l = (text.split('\n').find((x) => x.trim()) || '').trim(); return l.length > max ? `${l.slice(0, max)}…` : l; };
const notesAreShort = (text) => text.length <= 600 && text.split('\n').length <= 12;
function notesRow(it, text, old) {
  const f = F();
  const open = f.notesOpen && f.notesOpen.id === it.id ? f.notesOpen.open : notesAreShort(text);
  return `Notes: <b>${sizeOf(text)}</b> <span class="hint">→ this card’s Notes</span> <button class="link-btn sg-copy" data-fr="copy-notes">⧉ Copy</button>
    <span class="sg-replaces hint">${old ? `Replaces the notes it has (${sizeOf(old)}): <span class="sg-old">${esc(firstLine(old))}</span>` : 'It has no notes now.'}</span>
    <details class="sg-notes-d" ${open ? 'open' : ''}><summary data-fr="notes-toggle"><span class="sg-notes-show">Show the text</span><span class="sg-notes-hide">Hide the text</span><span class="sg-prev"> · ${esc(firstLine(text))}</span></summary><span class="sg-notes">${esc(text)}</span></details>`;
}

// A suggestion's steps: titles, or {title, steps, in_order} that nest.
const countSteps = (list) => list.reduce((n, x) => n + 1 + (x && typeof x === 'object' && Array.isArray(x.steps) ? countSteps(x.steps) : 0), 0);
const stepsHtml = (list) => `<ol class="sg-steps">${list.map((x) => { const o = x && typeof x === 'object' ? x : { title: x }; return `<li>${esc(o.title)}${o.in_order ? ' <span class="hint">in order</span>' : ''}${Array.isArray(o.steps) && o.steps.length ? stepsHtml(o.steps) : ''}</li>`; }).join('')}</ol>`;

// Steps (a task's own open steps, in order), shown on the card; done ones counted.
const stepsOf = (t) => db.tasks.filter((c) => c.parent_id === t.id && isOpen(c)).sort((a, b) => (a.sort - b.sort) || String(a.created_at).localeCompare(String(b.created_at)));
function stepsRow(t, row) {
  const open = stepsOf(t);
  const done = db.tasks.filter((c) => c.parent_id === t.id && c.completed_at).length;
  if (!open.length && !done) return '';
  const pct = Math.round((done / (done + open.length)) * 100);
  return row('Steps', 'steps', `<span class="hint">${done ? `${n(done)} done · ` : ''}${n(open.length)} to go${t.steps_in_order ? ' · in order' : ''}</span>
    <div class="step-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${done + open.length}" aria-valuenow="${done}" aria-label="${done} of ${done + open.length} steps done"><i style="width:${pct}%"></i></div><ol class="fr-steps">${open.slice(0, 12).map((c) => `<li>${esc(c.title)}</li>`).join('')}${open.length > 12 ? `<li class="hint">+ ${n(open.length - 12)} more</li>` : ''}</ol>`);
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
    ${isDaily(t) ? row(isWeekly(t) ? 'Every week' : 'Every day', 'daily', `${esc(describeDaily(t.daily))}${dailySummary(t) ? ` <span class="hint">${esc(dailySummary(t))}</span>` : ''}`) : t.repeat_rule ? row('Repeats', 'repeat', esc(describe(t.repeat_rule))) : ''}
    ${t.flagged ? row('Flag', 'flagged', '<span class="chip flagged-chip">⚑ Flagged</span>') : ''}
    ${t.folder_path ? row('Folder', 'folder', `<span class="fr-folder">${esc(shortPath(t.folder_path))}</span>${folderButton(t.folder_path)}`) : ''}
    ${stepsRow(t, row)}
    ${t.notes ? `<details class="fr-notes" ${t.notes.length <= 600 || fresh(it, 'notes') ? 'open' : ''}><summary>Notes</summary><p>${mark(it, 'notes', esc(t.notes))}</p></details>` : ''}
    ${it.note ? `<p class="fr-claude"><b>Claude:</b> ${esc(it.note)}</p>` : ''}
    ${suggestionBar(it, t)}
    <div class="fr-btns ${pending(it) ? 'fr-btns-quiet' : ''}">${[['keep', 'Keep'], ['someday', 'Someday'], ['done', 'Done'], ['drop', 'Drop']].map(([d, l], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-fr="decide" data-decision="${d}"><kbd>${i + 1}</kbd> ${l}</button>`).join('')}</div>
    <div class="fr-btns2 ${pending(it) ? 'fr-btns-quiet' : ''}"><button class="btn small" data-fr="decide" data-decision="reading" title="Something to read, watch or listen to: onto Reading &amp; watching (up next)"><kbd>5</kbd> → Reading &amp; watching</button><button class="btn small" data-fr="decide" data-decision="slipbox" title="An idea to think with, not an action: a fleeting note in your slipbox"><kbd>6</kbd> → Slipbox</button></div>
    <p class="hint fr-edit"><button class="link-btn" data-fr="breakdown">🪜 Break it down <kbd>B</kbd></button> · <button class="link-btn" data-task="${t.id}">Edit details</button></p>
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
  const seen = claudeSeen(s);
  const decided = decidedList();
  if (f.peek && !decided.some((x) => x.id === f.peek)) f.peek = null; // undone meanwhile
  const peek = f.peek && f.byId.get(f.peek);
  const last = decided[0];
  const undoBtn = (cls = 'btn small') => `<button class="${cls}" data-fr="undo" ${last ? `title="Take back the last decision (U)"` : 'disabled'}>↶ Undo${last && cardTitle(last) ? `: ${esc(short(cardTitle(last)))}` : ''}</button>`;
  const ah = aheadOf(cur);
  const aheadBox = `<label class="fr-ahead" title="While Claude is running, it keeps a suggestion waiting on each of the next ${AHEAD} cards, so a card has one when you reach it"><input type="checkbox" data-fr-ahead ${s.draft_ahead ? 'checked' : ''}> Keep Claude ahead${s.draft_ahead && ah.next.length ? ` <span class="hint">${ah.drafted} of ${ah.next.length} drafted</span>` : ''}</label>`;
  const backBtn = `<button class="btn small" data-fr="look-back" ${decided.length && (!peek || decided[decided.length - 1].id !== peek.id) ? '' : 'disabled'} title="Look at the card before, without changing anything (←)">← Back</button>`;
  const head = `<div class="fr-head"><div><b>${esc(s.title)}</b> <span class="hint">· ${n(pos)} of ${n(live.length)} · ${n(done)} reviewed${skipped ? ` · ${n(skipped)} skipped` : ''}</span></div>
      <span class="fr-pres ${seen === 'away' ? '' : 'on'} ${seen}">${presenceHtml(s)}</span>
      ${aheadBox}
      <button class="btn small fr-copy${seen === 'away' ? ' primary' : ''}" data-fr="invite" title="Copy the prompt that starts or resumes this review with Claude">⧉ Prompt for Claude</button>
      <a class="icon-btn fr-close" href="#${esc((s.scope && s.scope.import_id) ? `settle/${s.scope.import_id}` : s.scope && s.scope.project_id ? `project/${s.scope.project_id}` : 'inbox')}" aria-label="Close" title="Close (Esc)">✕</a></div>
    <div class="cl-progress"><i style="width:${live.length ? Math.round((done / live.length) * 100) : 0}%"></i></div>${app.libraryLoading ? '<p class="hint fr-loading" role="status">Loading the rest of your library…</p>' : ''}`;
  if (!cur) {
    return `<div class="fr">${head}<button class="fab fr-fab" data-fr="capture" aria-label="Capture an idea (added to this review)">+</button><div class="cl-done"><div class="cl-big">✓</div><h2>All reviewed</h2>
      <p>${n(done)} decided${skipped ? `, ${n(skipped)} skipped` : ''}.</p>
      <p>${skipped ? '<button class="btn" data-fr="reopen-skipped">Go through the skipped ones</button> ' : ''}${last && !peek ? `${backBtn} ${undoBtn('btn')}` : ''}</p></div>${peek ? `${lookingBar(peek, decided)}<div class="fr-looking">${peek.kind === 'group' ? groupCard(peek) : taskCard(peek)}</div><div class="cl-bar">${backBtn}<span class="hint cl-keys">← back · → forward · u undo this card</span><button class="btn small" data-fr="look-forward">Forward →</button></div>` : ''}</div>`;
  }
  if (peek) {
    return `<div class="fr">${head}${lookingBar(peek, decided)}
    <div class="fr-looking">${peek.kind === 'group' ? groupCard(peek) : taskCard(peek)}</div>
    <div class="cl-bar">${backBtn}<span class="hint cl-keys">← back · → forward · u undo this card · Esc close</span><button class="btn small" data-fr="look-forward">Forward →</button></div></div>`;
  }
  return `<div class="fr">${head}
    <button class="fab fr-fab" data-fr="capture" aria-label="Capture an idea (added to this review)" title="Capture an idea: it's added to this review as a later card (N)">+</button>
    ${cur.kind === 'group' ? groupCard(cur) : taskCard(cur)}
    <div class="cl-bar"><span class="fr-back-undo">${backBtn}${undoBtn()}</span><span class="hint cl-keys">1–6 decide · s skip · u undo · ← back · b break down · n capture · Esc close</span><button class="btn small" data-fr="decide" data-decision="skip">Skip →</button></div></div>`;
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
const copyPrompt = async () => { try { await navigator.clipboard.writeText(resumePrompt(F().session)); toast('Copied: paste it into Claude'); } catch { const b = document.querySelector('[data-fr="invite"]'); if (b) b.click(); } };
// The "Keep Claude ahead" box. Claude only acts while its chat is running, so turning it on says how to start it.
export async function fullReviewChange(e) {
  const box = e.target.closest('[data-fr-ahead]');
  const f = F();
  if (!box || !f.session) return;
  const on = box.checked;
  box.blur(); // a focused box would hold back live redraws and the number keys
  try { await run(sb.from('review_sessions').update({ draft_ahead: on }).eq('id', f.session.id)); } catch { app.render(); return; }
  f.session = { ...f.session, draft_ahead: on };
  app.render();
  if (on) toast(`Claude keeps the next ${AHEAD} cards drafted while it’s running. Paste the prompt once to start it.`, { label: 'Copy prompt', run: copyPrompt });
  else toast('Claude stops drafting ahead');
}
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
  if (a === 'tree-drop') { // leave one new item out of what the suggestion adds to the tech tree
    const cur = s && f.byId.get(s.current_item);
    const sug = cur && pending(cur);
    if (!sug || !sug.tree) return;
    const tree = treeWithout(sug.tree, Number(el.dataset.i));
    const next = { ...sug }; if (tree.items.length) next.tree = tree; else delete next.tree;
    await run(sb.from('review_items').update({ suggestion: next }).eq('id', cur.id));
    cur.suggestion = next;
    app.render();
    return;
  }
  if (a === 'capture') { captureIntoReview(); return; }
  if (a === 'look-back' || a === 'look-forward') { await look(a === 'look-back' ? 'back' : 'forward'); return; }
  if (a === 'look-now') { f.peek = null; app.render(); return; }
  // Looking back changes nothing: the card's own buttons belong to the current card, so they do nothing here.
  if (f.peek && a !== 'undo') return;
  if (a === 'notes-toggle') { // remembered for this card, so a live update doesn't fold it back
    const cur = s && f.byId.get(s.current_item);
    const d = el.closest('details');
    if (cur && d) f.notesOpen = { id: cur.id, open: !d.open }; // the click comes before the toggle
    return;
  }
  if (a === 'copy-notes') {
    const cur = s && f.byId.get(s.current_item);
    const sug = cur && pending(cur);
    if (!sug || !sug.task_notes) return;
    try { await navigator.clipboard.writeText(sug.task_notes); toast('Notes copied'); } catch {
      // No clipboard here: open the text and select it, ready for ⌘C.
      const d = document.querySelector('.sg-notes-d'); const box = document.querySelector('.sg-notes');
      if (d && box) { d.open = true; f.notesOpen = { id: cur.id, open: true }; const r = document.createRange(); r.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selected: copy it with ⌘C'); }
    }
    return;
  }
  if (a === 'breakdown') {
    const cur = s && f.byId.get(s.current_item);
    const t = cur && cur.kind === 'task' && byId(db.tasks, cur.task_id);
    if (!t) return;
    const { openBreakdown } = await import('../editors/breakdown.js');
    openBreakdown(t, { onDone: async () => { await refreshCard(cur); app.render(); } });
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
      openEditor({ ...t, ...(sug.title ? { title: sug.title } : {}), ...(sug.task_notes ? { notes: sug.task_notes } : {}), ...('gain' in sug ? { gain: sug.gain, gain_by: sug.gain_suggested ? 'agent' : null } : {}),
        ...('project_id' in sug ? { project_id: sug.project_id } : {}), ...('planned' in sug ? { planned_at: sug.planned } : {}), ...('due' in sug ? { due_at: sug.due } : {}),
        ...('defer' in sug ? { defer_at: sug.defer } : {}), ...('flagged' in sug ? { flagged: sug.flagged } : {}), ...(sug.daily ? { daily: sug.daily } : {}) });
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
    const reload = bulk || !!(sug.add_tag_names && sug.add_tag_names.length) || !!sug.checklist || !!sug.tree; // new tags, a new checklist, new goals and links: load them
    if (reload) await loadAll(); else if (cur.kind === 'task') await refreshCard(cur);
    if (sug.decision === 'one_by_one' || bulk) { await loadSession(s.id); return; }
    cur.status = sug.decision === 'skip' ? 'skipped' : 'reviewed'; cur.decision = sug.decision; cur.decided_by = 'user'; cur.reviewed_at = new Date().toISOString(); cur.suggestion = { ...sug, applied_at: new Date().toISOString() };
    run(sb.from('review_items').select('*').eq('id', cur.id)).then(([row]) => { if (row) Object.assign(cur, row); }).catch(() => {}); // its record of how things were, for Undo's message
    f.session = { ...s, current_item: r.next, status: r.next ? 'active' : 'done' };
    const nx = r.next && f.byId.get(r.next);
    if (nx) await arrive(nx);
    app.render();
    return;
  }
  if (a === 'undo') {
    // The card asked for (looking back), else the one decided last: asked of the database, so a decision made
    // on another device or by Claude a moment ago counts.
    let id = el.dataset.id || null;
    if (!id) { const [row] = await run(sb.from('review_items').select('*').eq('session_id', s.id).not('reviewed_at', 'is', null).order('reviewed_at', { ascending: false }).limit(1)); id = row && isDecided(row) ? row.id : null; }
    if (!id) { toast('Nothing to undo'); return; }
    await undoCard(id);
    return;
  }
  if (a === 'decide') {
    const cur = s && f.byId.get(s.current_item);
    if (!cur || el.disabled) return;
    const decision = el.dataset.decision;
    el.disabled = true;
    const r = await run(sb.rpc('review_decide', { item: cur.id, decision, by: 'user' }));
    const bulk = cur.kind === 'group' && decision === 'accept';
    if (bulk) await loadAll(); else if (cur.kind === 'task') await refreshCard(cur);
    if (decision === 'slipbox') db.slipbox = await run(sb.from('slipbox_notes').select('*').is('archived_at', null));
    if (decision === 'one_by_one' || bulk) await loadSession(s.id);
    else {
      cur.status = decision === 'skip' ? 'skipped' : 'reviewed'; cur.decision = decision; cur.decided_by = 'user'; cur.reviewed_at = new Date().toISOString();
      f.session = { ...s, current_item: r.next, status: r.next ? 'active' : 'done' };
      const nx = r.next && f.byId.get(r.next);
      if (nx) await arrive(nx);
      app.render();
    }
  }
}

// Keys on the review screen: 1–6 decide, s skip, u undo, ← → look back and forward, b break down, n capture, Esc close.
export function fullReviewKey(e) {
  if (!location.hash.startsWith('#full/') || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return false;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const b = document.querySelector(`[data-fr="${e.key === 'ArrowLeft' ? 'look-back' : 'look-forward'}"]`); if (b && !b.disabled) { e.preventDefault(); b.click(); } return true; }
  if (F().peek && e.key !== 'u' && e.key !== 'Escape') return true; // looking back: only Undo, the arrows and Esc (and no other shortcut)
  if (e.key === 'n') { e.preventDefault(); captureIntoReview(); return true; }
  if (e.key === 'b') { const b = document.querySelector('[data-fr="breakdown"]'); if (b) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'Enter' && !/SUMMARY|BUTTON|A/.test(document.activeElement.tagName)) { const b = document.querySelector('[data-fr="submit"]'); if (b) { e.preventDefault(); b.click(); return true; } }
  const btns = [...document.querySelectorAll('.fr-btns [data-fr="decide"], .fr-btns2 [data-fr="decide"]')];
  if (/^[1-6]$/.test(e.key) && btns[Number(e.key) - 1]) { e.preventDefault(); btns[Number(e.key) - 1].click(); return true; }
  if (e.key === 's') { const b = document.querySelector('.cl-bar [data-decision="skip"]'); if (b) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'u') { const b = document.querySelector('[data-fr="undo"]'); if (b && !b.disabled) { e.preventDefault(); b.click(); return true; } }
  if (e.key === 'Escape') { const c = document.querySelector('.fr-close'); if (c) { e.preventDefault(); location.hash = c.getAttribute('href'); return true; } }
  return false;
}
