// Tech tree (Horizons → Tech tree): goals and projects linked by what they require, so doing certain
// things unlocks future things. The rules are in js/tree-rules.js (shared with the MCP) and the database
// (migration 20261103000001: no loops, nothing deleted). Locks are real for projects: a locked project
// belongs on hold, and when what it requires is achieved the tree offers to start it. Nothing locks or
// starts by itself: links found in the library, or proposed by Claude, wait dashed until you accept them.
import { db, app, sb, run, esc, byId, toast, openSheet, syncRow, isOpen, taskSort, bySort, $ } from '../state.js';
import { fmtDate } from '../dates.js';
import { buildTree, keyOf, opensWith, wouldLoop, cardTrouble, proposeFromLibrary, live } from '../tree-rules.js';

// The cards the tree needs: the ones a link names (loaded apart when they were finished a while ago).
const cardById = (id) => byId(db.tasks, id) || byId(db.treeTasks || [], id);
const linkedCards = () => [...new Set((db.treeLinks || []).filter((l) => live(l) && l.requires_kind === 'task').map((l) => l.requires_id))].map(cardById).filter(Boolean);
export const treeOf = () => buildTree({ goals: db.goals || [], projects: db.projects || [], tasks: linkedCards(), links: db.treeLinks || [] });
const n = (x) => Number(x || 0).toLocaleString();
const plural = (k, one, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;
const stepBack = (k) => `${plural(k, 'action')} ${k === 1 ? 'steps' : 'step'} back`;
const openActions = (projectId) => db.tasks.filter((t) => t.project_id === projectId && isOpen(t)).length;
const hrefOf = (node) => (node.kind === 'goal' ? `#goal/${node.id}` : node.kind === 'task' ? `#task/${node.id}` : `#project/${node.id}`);
const TYPE = { goal: 'Goal', milestone: 'Milestone', destination: 'Destination', project: 'Project', card: 'Card' };
const short = (t, max = 34) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };

// The ladder's line for this level.
export function treeSummary() {
  const t = treeOf();
  if (!t.shown.length) return { title: 'Tech tree', sub: 'What unlocks what: do certain things to open future things.', chips: '' };
  const c = t.counts;
  return { title: `Tech tree · ${n(c.open)} open`, sub: `${n(c.achieved)} achieved · ${n(c.locked)} locked`,
    chips: `${t.proposals.length ? `<span class="chip warn">${plural(t.proposals.length, 'proposed link')}</span>` : ''}${c.ready ? `<span class="chip acc">${n(c.ready)} unlocked</span>` : ''}` };
}

function stateLine(node) {
  if (node.state === 'achieved') return `✓ achieved${node.at ? ` ${esc(fmtDate(node.at))}` : ''}`;
  if (node.state === 'locked') {
    const first = node.unmet[0];
    return `needs ${esc(short(first.title, 26))}${node.unmet.length > 1 ? ` +${node.unmet.length - 1}` : ''}${node.kind === 'project' && !node.held ? ' · still active' : ''}`;
  }
  if (node.state === 'ready') return 'unlocked · on hold';
  if (node.state === 'held') return 'on hold';
  if (node.type === 'card') return node.in ? `in ${esc(short(node.in, 26))}` : 'a card to do';
  return node.type === 'milestone' ? 'tick it when it’s true' : 'open now';
}
function nodeHtml(node) {
  const btn = node.state === 'ready' ? `<button class="btn small primary" data-tt="start" data-key="${node.key}">Start it</button>`
    : node.state === 'locked' && node.kind === 'project' && !node.held ? `<button class="btn small" data-tt="hold" data-key="${node.key}" title="Put it on hold until it’s unlocked: ${stepBack(openActions(node.id))}">Hold</button>`
      : node.state === 'open' && node.type === 'milestone' ? `<button class="btn small" data-tt="achieve" data-key="${node.key}">✓ It’s true</button>` : '';
  return `<div class="tt-node tt-${node.state} tt-type-${node.type}" ${node.col ? `style="grid-column:${node.col};grid-row:${node.row}"` : ''} data-tt-node="${node.key}" data-tt="open" data-key="${node.key}" tabindex="0" role="button" aria-label="${esc(node.title)}: ${esc(TYPE[node.type])}, ${esc(node.state)}">
    <span class="tt-kind">${esc(TYPE[node.type])}</span><b class="tt-title">${esc(node.title)}</b>
    <span class="tt-sub">${stateLine(node)}</span>${btn}</div>`;
}

export function viewTree(focus) {
  const tree = treeOf();
  const dest = focus && tree.nodes.get(keyOf('goal', focus));
  const showing = dest ? tree.path(dest).nodes : tree.shown;
  // A branch also shows what is proposed to hang on it, so there is something to accept or dismiss.
  const keys = new Set(showing.map((x) => x.key));
  if (dest) tree.shown.forEach((x) => { if (x.proposed.some((p) => p.key && keys.has(p.key))) keys.add(x.key); });
  const nodes = tree.shown.filter((x) => keys.has(x.key));
  const c = tree.counts;
  const ready = tree.shown.filter((x) => x.state === 'ready');
  const proposals = tree.proposals;
  const nameOf = (l) => { const x = tree.nodes.get(keyOf(l.node_kind, l.node_id)); return x ? x.title : 'a project that’s gone'; };
  const reqOf = (l) => (l.requires_id ? ((tree.nodes.get(keyOf(l.requires_kind, l.requires_id)) || {}).title || '') : l.requires_title);
  const destCard = (d) => {
    const p = tree.path(d);
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return `<a class="tt-dest ${dest && dest.key === d.key ? 'on' : ''}" href="#horizons/tree/${d.id}"><b>${esc(d.title)}</b>
      <span class="hz-bar big"><i style="width:${pct}%"></i></span>
      <span class="hint">${p.total > 1 ? `${n(p.done)} of ${n(p.total)}` : 'no path yet'}${p.next.filter((x) => x.key !== d.key).length ? ` · next: ${esc(p.next.filter((x) => x.key !== d.key).slice(0, 2).map((x) => short(x.title, 28)).join(', '))}` : p.total > 1 ? '' : ' · add what it requires'}</span></a>`;
  };
  const placed = nodes.filter((x) => x.col).sort((a, b) => a.row - b.row || a.col - b.col);
  const rows = [...new Set(placed.map((x) => x.row))].sort((a, b) => a - b); // a branch on its own starts at the top
  placed.forEach((x) => { x.row = rows.indexOf(x.row) + 1; });
  const loose = nodes.filter((x) => !x.col);
  const width = Math.max(0, ...placed.map((x) => x.col));
  return `<a class="back" href="${dest ? '#horizons/tree' : '#horizons'}">‹ ${dest ? 'The whole tree' : 'Horizons'}</a>
    <div class="view-head"><h1 class="horizons">${dest ? esc(dest.title) : 'Tech tree'}</h1><span class="head-actions"><button class="btn small" data-tt="find" title="Look for links already written in your library: “(phase 2)” in a project’s name, “Start when…” in an action or a project’s notes">Find links in my library</button><button class="btn small primary" data-tt="link">+ Link</button></span></div>
    <p class="view-sub">${dest ? 'What this destination rests on.' : 'Do certain things to unlock future things. A link says what a goal or project requires; a locked project belongs on hold until what it needs is done.'}</p>
    ${tree.shown.length ? `<p class="hint tt-counts">${n(c.achieved)} achieved · ${n(c.open)} open now · ${n(c.locked)} locked</p>` : ''}
    ${proposals.length ? `<div class="tt-props" role="region" aria-label="Proposed links"><div class="tt-props-h"><b>${plural(proposals.length, 'proposed link')}</b><span class="hint">Nothing changes until you accept.</span><button class="btn small" data-tt="accept-all">Accept all</button></div>
      ${proposals.map((l) => `<div class="tt-prop" data-tt-prop="${l.id}"><span class="tt-prop-main"><span><b>${esc(nameOf(l))}</b> requires <b>${esc(reqOf(l))}</b>${l.requires_id ? '' : ' <span class="chip">new milestone</span>'}${l.proposed_by === 'agent' ? ' <span class="chip sug">Claude</span>' : ''}</span>${l.why ? `<span class="hint">${esc(l.why)}</span>` : ''}</span>
        <span class="tt-prop-btns"><button class="btn small primary" data-tt="accept" data-id="${l.id}">Accept</button><button class="btn small" data-tt="dismiss" data-id="${l.id}">Dismiss</button></span></div>`).join('')}</div>` : ''}
    ${ready.length ? `<div class="tt-ready" role="status">${ready.map((x) => `<span><b>Unlocked:</b> ${esc(x.title)} <button class="btn small primary" data-tt="start" data-key="${x.key}">Start it</button></span>`).join('')}</div>` : ''}
    ${!dest && tree.destinations.length ? `<h2 class="section-title">Destinations · ${tree.destinations.length}</h2><div class="tt-dests">${tree.destinations.map(destCard).join('')}</div>` : ''}
    ${nodes.length ? `${!dest && tree.destinations.length ? '<h2 class="section-title">The tree</h2>' : ''}${placed.length ? `<div class="tt-scroll"><div class="tt-canvas" data-tt-canvas style="--tt-cols:${width}"><svg class="tt-lines" aria-hidden="true"></svg>${placed.map(nodeHtml).join('')}</div></div>` : ''}
      ${loose.length ? `<h2 class="section-title">Not linked yet · ${loose.length}</h2><div class="tt-loose">${loose.map(nodeHtml).join('')}</div>` : ''}
      <p class="hint tt-legend"><i class="tt-dot tt-achieved"></i>Achieved <i class="tt-dot tt-open"></i>Open now <i class="tt-dot tt-locked"></i>Locked <span class="tt-dash"></span>Proposed, not accepted</p>`
    : `<p class="empty">Nothing on the tree yet. Add a link (“this requires that”), mark a goal as a destination, or let the app look for links already written in your library.</p>`}`;
}

// Lines from what is required to what requires it; dashed while only proposed. Drawn from where the nodes landed.
export function drawTree() {
  const canvas = $('[data-tt-canvas]');
  if (!canvas) return;
  const svg = $('.tt-lines', canvas);
  const box = canvas.getBoundingClientRect();
  svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
  const el = (key) => canvas.querySelector(`[data-tt-node="${key}"]`);
  const tree = treeOf();
  const paths = [];
  tree.shown.forEach((node) => {
    const to = el(node.key);
    if (!to) return;
    [...node.requires.map((r) => ({ key: r.key, dash: false })), ...node.proposed.filter((p) => p.key).map((p) => ({ key: p.key, dash: true }))].forEach((r) => {
      const from = el(r.key);
      if (!from) return;
      const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
      const x1 = a.right - box.left; const y1 = a.top + a.height / 2 - box.top; const x2 = b.left - box.left; const y2 = b.top + b.height / 2 - box.top;
      if (x2 <= x1) return; // stacked (a phone): the node's own line says what it needs
      const mid = (x1 + x2) / 2;
      paths.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}C${mid.toFixed(1)} ${y1.toFixed(1)} ${mid.toFixed(1)} ${y2.toFixed(1)} ${(x2 - 5).toFixed(1)} ${y2.toFixed(1)}" class="${r.dash ? 'dash' : ''}" marker-end="url(#tt-arrow)"/>`);
    });
  });
  svg.innerHTML = `<defs><marker id="tt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>${paths.join('')}`;
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawTree, 120); });

// ---------- writes ----------
async function reloadLinks() {
  const [links, goals] = await Promise.all([run(sb.from('tree_links').select('*').is('archived_at', null)), run(sb.from('goals').select('*').order('sort'))]);
  db.treeLinks = links; db.goals = goals;
}
async function setProject(id, status) {
  const p = byId(db.projects, id);
  const [row] = await run(sb.from('projects').update({ status }).eq('id', id).select());
  if (p && row) syncRow('projects', p, row);
}
// After a link is added or accepted: an active project that is now locked is offered a place on hold.
function offerHold(nodeKey) {
  const node = treeOf().nodes.get(nodeKey);
  if (!node || node.kind !== 'project' || node.state !== 'locked' || node.held) return false;
  const k = openActions(node.id);
  toast(`“${short(node.title, 40)}” is locked now, and still active`, [{ label: `Put on hold${k ? ` (${stepBack(k)})` : ''}`, run: async () => { await setProject(node.id, 'on_hold'); app.render(); toast('On hold until it’s unlocked', [{ label: 'Undo', run: async () => { await setProject(node.id, 'active'); app.render(); } }]); } }]);
  return true;
}
export async function addLink(nodeKey, reqKey, { quiet = false } = {}) {
  if (reqKey.startsWith('task:')) { const why = cardTrouble({ kind: nodeKey.split(':')[0], id: nodeKey.split(':')[1] }, cardById(reqKey.split(':')[1])); if (why) { toast(why); return null; } }
  if (wouldLoop(db.treeLinks || [], nodeKey, reqKey, db.tasks)) { toast(nodeKey === reqKey ? 'It can’t require itself' : 'That would make a loop: it already rests on this one'); return null; }
  const [nk, ni] = nodeKey.split(':'); const [rk, ri] = reqKey.split(':');
  if ((db.treeLinks || []).some((l) => live(l) && l.state === 'accepted' && l.node_kind === nk && l.node_id === ni && l.requires_id === ri)) { toast('That link is already there'); return null; }
  const [row] = await run(sb.from('tree_links').insert({ node_kind: nk, node_id: ni, requires_kind: rk, requires_id: ri }).select());
  (db.treeLinks = db.treeLinks || []).push(row);
  app.render();
  if (!quiet && !offerHold(nodeKey)) toast('Linked', [{ label: 'Undo', run: () => removeLink(row.id) }]);
  return row;
}
export async function removeLink(id) {
  await run(sb.from('tree_links').update({ archived_at: new Date().toISOString() }).eq('id', id));
  db.treeLinks = (db.treeLinks || []).filter((l) => l.id !== id);
  app.render();
}
async function accept(ids) {
  const before = treeOf();
  const nodes = [];
  for (const id of ids) {
    const l = (db.treeLinks || []).find((x) => x.id === id);
    if (!l) continue;
    try { await run(sb.rpc('tree_accept', { link: id })); nodes.push(keyOf(l.node_kind, l.node_id)); } catch { /* said in a toast; the rest still go */ }
  }
  await reloadLinks();
  app.render();
  const after = treeOf();
  const locked = [...new Set(nodes)].map((k) => after.nodes.get(k)).filter((x) => x && x.kind === 'project' && x.state === 'locked' && !x.held);
  if (locked.length === 1) { offerHold(locked[0].key); return; }
  if (locked.length > 1) {
    const k = locked.reduce((s, x) => s + openActions(x.id), 0);
    toast(`${plural(nodes.length, 'link')} accepted · ${plural(locked.length, 'project')} locked and still active`, [{ label: `Put them on hold${k ? ` (${stepBack(k)})` : ''}`, run: async () => {
      for (const x of locked) await setProject(x.id, 'on_hold');
      app.render();
      toast(`${plural(locked.length, 'project')} on hold until unlocked`, [{ label: 'Undo', run: async () => { for (const x of locked) await setProject(x.id, 'active'); app.render(); } }]);
    } }]);
    return;
  }
  toast(`${plural(nodes.length, 'link')} accepted${after.shown.length > before.shown.length ? '' : ''}`);
}
async function findLinks() {
  const found = proposeFromLibrary({ projects: db.projects, tasks: db.tasks, links: db.treeLinks || [] });
  if (!found.length) { toast('No new links found in your library'); return; }
  const rows = found.map((f) => ({ node_kind: f.node.kind, node_id: f.node.id, state: 'proposed', proposed_by: 'app', why: f.why.slice(0, 500),
    requires_kind: f.requires.id ? f.requires.kind : null, requires_id: f.requires.id || null, requires_title: f.requires.id ? null : f.requires.title }));
  const made = await run(sb.from('tree_links').insert(rows).select());
  (db.treeLinks = db.treeLinks || []).push(...made);
  app.render();
  toast(`${plural(made.length, 'link')} found · accept the ones that are right`);
}
async function achieve(key) {
  const tree = treeOf();
  const node = tree.nodes.get(key);
  if (!node || node.kind !== 'goal') return;
  const opens = opensWith(tree, key);
  const g = byId(db.goals, node.id);
  const [row] = await run(sb.from('goals').update({ status: 'achieved' }).eq('id', node.id).select());
  syncRow('goals', g, row);
  app.render();
  const held = opens.filter((x) => x.kind === 'project' && x.held);
  toast(opens.length ? `Unlocked: ${opens.map((x) => short(x.title, 30)).join(', ')}` : `Achieved: ${short(node.title, 40)}`, [
    ...(held.length ? [{ label: held.length === 1 ? 'Start it' : `Start ${held.length}`, run: async () => { for (const x of held) await setProject(x.id, 'active'); app.render(); } }] : []),
    { label: 'Undo', run: async () => { const [r2] = await run(sb.from('goals').update({ status: 'active' }).eq('id', node.id).select()); syncRow('goals', g, r2); app.render(); } }]);
}

// ---------- linking: two browsers side by side ----------
// "This" (a goal or project) on the left, what it "requires" on the right (a goal, a project, or any card or
// step inside one). Each side is the library as a hierarchy (folder › project › card › step) with a search
// that keeps matches under what they belong to. Under them, the link in a sentence and what it would change.
const words = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
const hit = (text, ws) => { const t = String(text || '').toLowerCase(); return ws.every((w) => t.includes(w)); };
const marked = (text, ws) => {
  let out = esc(text);
  ws.map((w) => esc(w)).filter(Boolean).sort((x, y) => y.length - x.length).forEach((w) => { out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'gi'), '<mark>$1</mark>'); });
  return out;
};
const liveProjects = () => db.projects.filter((p) => p.status === 'active' || p.status === 'on_hold').sort(bySort);
const cardsIn = (projectId) => db.tasks.filter((t) => t.project_id === projectId && !t.parent_id && isOpen(t)).sort(taskSort);
const stepsIn = (taskId) => db.tasks.filter((t) => t.parent_id === taskId && isOpen(t)).sort(taskSort);
const MAX_HITS = 80;

// The rows one side shows: [{ kind: head | goal | project | task | new, key?, label, depth, open?, more?, chips }]
function rowsFor(side, st) {
  const ws = words(st.q[side]);
  const rows = [];
  const tree = treeOf();
  const chipsOf = (key, extra = '') => { const n = tree.nodes.get(key); return `${extra}${n && n.state === 'locked' ? '<span class="chip">locked</span>' : ''}${n && n.done ? '<span class="chip">✓ done</span>' : ''}`; };
  const goals = (db.goals || []).filter((g) => g.status !== 'dropped' && (!ws.length || hit(g.title, ws))).sort((a, b) => a.title.localeCompare(b.title));
  const folders = [...(db.folders || []).filter((f) => !f.archived_at).sort(bySort), { id: null, name: 'No folder' }];
  let cardHits = null;
  if (ws.length && side === 'req') {
    const all = db.tasks.filter((t) => isOpen(t) && hit(t.title, ws));
    cardHits = { list: all.slice(0, MAX_HITS), more: Math.max(0, all.length - MAX_HITS) };
  }
  // Cards to show under a project: when searching, the matches with the cards they sit under; else what is opened.
  const under = (projectId) => {
    const out = [];
    if (cardHits) {
      const keep = new Set();
      cardHits.list.filter((t) => t.project_id === projectId).forEach((t) => { for (let n = t, i = 0; n && i < 6; i++) { keep.add(n.id); n = n.parent_id && byId(db.tasks, n.parent_id); } });
      const walk = (list, depth) => list.filter((t) => keep.has(t.id)).forEach((t) => { out.push({ kind: 'task', key: keyOf('task', t.id), label: t.title, depth, dim: !hit(t.title, ws) }); walk(stepsIn(t.id), depth + 1); });
      walk(cardsIn(projectId), 2);
    } else if (side === 'req' && st.open.has(projectId)) {
      const walk = (list, depth) => list.forEach((t) => { const kids = stepsIn(t.id); out.push({ kind: 'task', key: keyOf('task', t.id), label: t.title, depth, toggle: kids.length ? t.id : null, open: st.open.has(t.id) }); if (kids.length && st.open.has(t.id)) walk(kids, depth + 1); });
      walk(cardsIn(projectId), 2);
      if (!out.length) out.push({ kind: 'none', label: 'No open cards', depth: 2 });
    }
    return out;
  };
  if (goals.length) {
    rows.push({ kind: 'head', label: 'Goals and milestones', icon: '🎯' });
    goals.forEach((g) => rows.push({ kind: 'goal', key: keyOf('goal', g.id), label: g.title, depth: 1, chips: chipsOf(keyOf('goal', g.id), g.kind && g.kind !== 'goal' ? `<span class="chip">${esc(TYPE[g.kind].toLowerCase())}</span>` : '') }));
  }
  const projects = liveProjects();
  folders.forEach((f) => {
    const mine = projects.filter((p) => (p.folder_id || null) === f.id);
    const shown = mine.map((p) => ({ p, cards: under(p.id) })).filter((x) => !ws.length || hit(x.p.name, ws) || x.cards.length);
    if (!shown.length) return;
    rows.push({ kind: 'head', label: f.name, icon: '📁' });
    shown.forEach(({ p, cards }) => {
      const k = cardsIn(p.id).length;
      rows.push({ kind: 'project', key: keyOf('project', p.id), label: p.name, depth: 1, dim: ws.length > 0 && !hit(p.name, ws), toggle: side === 'req' && !ws.length && k ? p.id : null, open: st.open.has(p.id),
        chips: chipsOf(keyOf('project', p.id), `${p.status === 'on_hold' ? '<span class="chip warn">on hold</span>' : ''}${side === 'req' && k ? `<span class="chip">${plural(k, 'card')}</span>` : ''}`) });
      rows.push(...cards);
    });
  });
  if (cardHits) {
    const loose = cardHits.list.filter((t) => !t.project_id);
    if (loose.length) { rows.push({ kind: 'head', label: 'Not in a project', icon: '📥' }); loose.forEach((t) => rows.push({ kind: 'task', key: keyOf('task', t.id), label: t.title, depth: 1 })); }
    if (cardHits.more) rows.push({ kind: 'none', label: `${n(cardHits.more)} more cards match: add a word to narrow it`, depth: 1 });
  }
  if (side === 'req' && ws.length) rows.push({ kind: 'new', key: `new:${st.q.req.trim().slice(0, 300)}`, label: `New milestone “${st.q.req.trim().slice(0, 60)}”`, depth: 0 });
  if (!rows.length) rows.push({ kind: 'none', label: ws.length ? 'Nothing matches' : 'Nothing here yet', depth: 0 });
  return rows;
}
const ICON = { goal: '🎯', project: '🗂️', task: '○', new: '＋' };
function listHtml(side, st) {
  const ws = words(st.q[side]);
  const picked = st[side];
  return rowsFor(side, st).map((r) => {
    if (r.kind === 'head') return `<div class="tl-head"><span aria-hidden="true">${r.icon}</span> ${esc(r.label)}</div>`;
    if (r.kind === 'none') return `<div class="tl-none" style="--d:${r.depth}">${esc(r.label)}</div>`;
    return `<div class="tl-row ${picked === r.key ? 'on' : ''} ${r.dim ? 'dim' : ''}" style="--d:${r.depth}" role="option" aria-selected="${picked === r.key}" data-tl-pick="${esc(r.key)}" data-side="${side}" tabindex="-1">
      ${r.toggle ? `<button type="button" class="tl-caret" data-tl-toggle="${r.toggle}" data-side="${side}" aria-expanded="${!!r.open}" aria-label="${r.open ? 'Hide' : 'Show'} what is inside ${esc(r.label)}">${r.open ? '▾' : '▸'}</button>` : '<span class="tl-caret" aria-hidden="true"></span>'}
      <span class="tl-ic" aria-hidden="true">${ICON[r.kind] || ''}</span><span class="tl-t">${r.kind === 'new' ? esc(r.label) : marked(r.label, ws)}</span>${r.chips || ''}</div>`;
  }).join('');
}
// The link in a sentence, and what it would change. → { html, ok }
function effect(st) {
  const tree = treeOf();
  if (!st.node || !st.req) return { ok: false, html: `<span class="hint">${!st.node ? 'Pick what gets unlocked on the left' : 'Now pick what it requires on the right'}${st.node && !st.req ? ': a goal, a project, or any card inside one.' : '.'}</span>` };
  const [nk, ni] = st.node.split(':');
  const nodeTitle = nk === 'goal' ? (byId(db.goals, ni) || {}).title : (byId(db.projects, ni) || {}).name;
  const isNew = st.req.startsWith('new:');
  const [rk, ri] = isNew ? ['goal', ''] : st.req.split(':');
  const reqRow = isNew ? null : rk === 'goal' ? byId(db.goals, ri) : rk === 'project' ? byId(db.projects, ri) : cardById(ri);
  const reqTitle = isNew ? st.req.slice(4) : rk === 'project' ? reqRow.name : reqRow.title;
  const what = isNew ? 'the new milestone' : rk === 'task' ? 'the card' : rk === 'project' ? 'the project' : 'the goal';
  const line = `<span class="tl-line"><b>${esc(nodeTitle)}</b> requires ${what} <b>${esc(reqTitle)}</b></span>`;
  const no = (why) => ({ ok: false, html: `${line}<span class="tl-bad">${esc(why)}</span>` });
  if (!isNew) {
    if (st.node === st.req) return no('It can’t require itself.');
    if (rk === 'task') { const why = cardTrouble({ kind: nk, id: ni }, reqRow); if (why) return no(why); }
    if (wouldLoop(db.treeLinks || [], st.node, st.req, db.tasks)) return no('That would make a loop: it already rests on this one.');
    if ((db.treeLinks || []).some((l) => live(l) && l.state === 'accepted' && l.node_kind === nk && l.node_id === ni && l.requires_id === ri)) return no('That link is already there.');
  }
  const met = !isNew && (rk === 'goal' ? reqRow.status === 'achieved' : rk === 'project' ? reqRow.status === 'completed' : !!reqRow.completed_at);
  const p = nk === 'project' ? byId(db.projects, ni) : null;
  const k = p ? openActions(p.id) : 0;
  const after = met ? 'That is already done, so nothing locks.'
    : p && p.status === 'active' ? `It would be locked until that is done. It is active now${k ? `, with ${plural(k, 'open action')}` : ''}: you will be asked whether to put it on hold.`
      : p ? 'It would be locked until that is done. It is on hold already, and will be offered to start when it unlocks.'
        : 'It would be locked until that is done.';
  const node = tree.nodes.get(st.node);
  return { ok: true, html: `${line}<span class="hint">${after}${node && node.unmet && node.unmet.length ? ` It also needs ${esc(node.unmet.map((u) => short(u.title, 30)).join(', '))}.` : ''}</span>` };
}
export function openLinkSheet(nodeKey = '') {
  const st = { node: nodeKey || null, req: null, q: { node: '', req: '' }, open: new Set() };
  const pane = (side, label, hint, ph) => `<div class="tl-pane" data-tl-pane="${side}"><span class="tl-label">${label}</span>
    <input type="search" class="tl-q" data-tl-q="${side}" placeholder="${ph}" autocomplete="off" spellcheck="false" aria-label="Search: ${label}">
    <div class="tl-list" data-tl-list="${side}" role="listbox" aria-label="${label}"></div><span class="hint">${hint}</span></div>`;
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet tt-sheet tl-sheet"><div class="tl-h"><h2>Link</h2><span class="hint">Tab switches sides · ↑ ↓ move · → opens · Enter picks</span></div>
    <div class="tl-two">${pane('node', 'This', 'Goals and projects: the things that get unlocked.', 'Search goals and projects')}${pane('req', 'requires', 'Goals, projects, and any card or step inside them.', 'Search goals, projects and cards')}</div>
    <div class="tl-out" data-tl-out aria-live="polite"></div>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" data-tl-go>Link</button></div></div></form>`);
  sheet.classList.add('wide');
  const form = $('form', sheet);
  const list = (side) => $(`[data-tl-list="${side}"]`, form);
  const draw = (side) => { list(side).innerHTML = listHtml(side, st); };
  const out = () => { const e = effect(st); $('[data-tl-out]', form).innerHTML = e.html; $('[data-tl-go]', form).disabled = !e.ok; };
  const pick = (side, key) => { st[side] = key; draw(side); out(); const on = list(side).querySelector('.tl-row.on'); if (on) on.scrollIntoView({ block: 'nearest' }); };
  $('[data-cancel]', form).onclick = () => sheet.close();
  form.addEventListener('input', (e) => { const side = e.target.dataset && e.target.dataset.tlQ; if (!side) return; st.q[side] = e.target.value; draw(side); });
  form.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-tl-toggle]');
    if (tg) { e.preventDefault(); const id = tg.dataset.tlToggle; if (st.open.has(id)) st.open.delete(id); else st.open.add(id); draw(tg.dataset.side); return; }
    const row = e.target.closest('[data-tl-pick]');
    if (row) pick(row.dataset.side, row.dataset.tlPick);
  });
  // Keys, from a search box: ↑ ↓ walk the rows, → and ← open and close, Enter picks the row you are on.
  const cur = { node: -1, req: -1 };
  form.addEventListener('keydown', (e) => {
    const side = e.target.dataset && e.target.dataset.tlQ;
    if (!side) return;
    const rows = [...list(side).querySelectorAll('.tl-row')];
    const at = (i) => { cur[side] = Math.max(0, Math.min(rows.length - 1, i)); rows.forEach((r, j) => r.classList.toggle('at', j === cur[side])); if (rows[cur[side]]) rows[cur[side]].scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') { e.preventDefault(); at(cur[side] + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); at(cur[side] - 1); } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const r = rows[cur[side]]; const tg = r && r.querySelector('[data-tl-toggle]');
      if (!tg || e.target.selectionStart !== e.target.value.length) return;
      const open = tg.getAttribute('aria-expanded') === 'true';
      if ((e.key === 'ArrowRight') !== open) { e.preventDefault(); const key = r.dataset.tlPick; tg.click(); at([...list(side).querySelectorAll('.tl-row')].findIndex((x) => x.dataset.tlPick === key)); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[cur[side]] || (rows.length === 1 ? rows[0] : null);
      if (r) { pick(side, r.dataset.tlPick); if (side === 'node') $('[data-tl-q="req"]', form).focus(); } else if (!$('[data-tl-go]', form).disabled) form.requestSubmit();
    }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!effect(st).ok) return;
    let req = st.req;
    if (req.startsWith('new:')) {
      const [g] = await run(sb.from('goals').insert({ title: req.slice(4), kind: 'milestone' }).select());
      (db.goals = db.goals || []).push(g);
      req = keyOf('goal', g.id);
    }
    sheet.close();
    await addLink(st.node, req);
  };
  draw('node'); draw('req'); out();
  if (nodeKey) { const on = list('node').querySelector('.tl-row.on'); if (on) on.scrollIntoView({ block: 'center' }); }
  sheet.showModal();
  $(`[data-tl-q="${nodeKey ? 'req' : 'node'}"]`, form).focus();
}
// A card was finished somewhere in the app: what did it unlock? (data.js asks before and after.)
export const unlockedBy = (taskId) => opensWith(treeOf(), keyOf('task', taskId));
export async function startProjects(ids) { for (const id of ids) await setProject(id, 'active'); app.render(); }

function openNodeSheet(key) {
  const tree = treeOf();
  const node = tree.nodes.get(key);
  if (!node) return;
  const title = (k) => (tree.nodes.get(k) || {}).title || '';
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet tt-sheet"><h2>${esc(node.title)}</h2>
    <p class="hint">${esc(TYPE[node.type])} · ${stateLine(node)}</p>
    <h3 class="po-group">Requires</h3>
    ${node.kind === 'task' ? '<p class="hint">A card waits on other cards through “Waits for”, in the card itself.</p>' : node.requires.length ? `<ul class="tt-list">${node.requires.map((r) => { const x = tree.nodes.get(r.key); return `<li><span>${x && x.done ? '✓ ' : ''}${esc(title(r.key))}</span><button type="button" class="btn small" data-unlink="${r.link.id}" aria-label="Remove the link to ${esc(title(r.key))}">Remove</button></li>`; }).join('')}</ul>` : '<p class="hint">Nothing: it is open from the start.</p>'}
    ${node.kind === 'task' ? '' : '<button type="button" class="btn small" data-add>+ Requires…</button>'}
    ${node.unlocks.length ? `<h3 class="po-group">Unlocks</h3><ul class="tt-list">${node.unlocks.map((k) => `<li><span>${esc(title(k))}</span></li>`).join('')}</ul>` : ''}
    ${node.kind === 'goal' ? `<label>Kind<select name="kind">${['goal', 'milestone', 'destination'].map((k) => `<option value="${k}" ${node.type === k ? 'selected' : ''}>${TYPE[k]}</option>`).join('')}</select><span class="hint">A milestone is a condition you tick. A destination is where a branch leads.</span></label>` : ''}
    <div class="actions"><a class="btn" href="${hrefOf(node)}" data-go>Open the ${node.kind === 'task' ? 'card' : node.kind}</a>
      <div class="right"><button type="button" class="btn" data-cancel>Close</button></div></div></form>`);
  const form = $('form', sheet);
  $('[data-cancel]', form).onclick = () => sheet.close();
  $('[data-go]', form).onclick = () => sheet.close();
  if ($('[data-add]', form)) $('[data-add]', form).onclick = () => { sheet.close(); openLinkSheet(key); };
  form.querySelectorAll('[data-unlink]').forEach((b) => { b.onclick = async () => { sheet.close(); const id = b.dataset.unlink; const l = (db.treeLinks || []).find((x) => x.id === id); await removeLink(id); toast('Link removed', l ? [{ label: 'Undo', run: () => addLink(keyOf(l.node_kind, l.node_id), keyOf(l.requires_kind, l.requires_id), { quiet: true }) }] : []); }; });
  if (form.elements.kind) form.elements.kind.onchange = async () => { const g = byId(db.goals, node.id); const [row] = await run(sb.from('goals').update({ kind: form.elements.kind.value }).eq('id', node.id).select()); syncRow('goals', g, row); sheet.close(); app.render(); };
  sheet.showModal();
}

export async function treeAction(el) {
  const a = el.dataset.tt;
  if (a === 'link') openLinkSheet();
  else if (a === 'find') await findLinks();
  else if (a === 'accept') await accept([el.dataset.id]);
  else if (a === 'accept-all') await accept(treeOf().proposals.map((l) => l.id));
  else if (a === 'dismiss') { await removeLink(el.dataset.id); toast('Dismissed'); }
  else if (a === 'achieve') await achieve(el.dataset.key);
  else if (a === 'open') openNodeSheet(el.dataset.key);
  else if (a === 'start' || a === 'hold') {
    const node = treeOf().nodes.get(el.dataset.key);
    if (!node || node.kind !== 'project') return;
    const to = a === 'start' ? 'active' : 'on_hold'; const back = a === 'start' ? 'on_hold' : 'active';
    const k = openActions(node.id);
    await setProject(node.id, to);
    app.render();
    toast(a === 'start' ? `Started: ${short(node.title, 40)}${k ? ` · ${plural(k, 'action')} available again` : ''}` : `On hold until it’s unlocked${k ? ` · ${stepBack(k)}` : ''}`, [{ label: 'Undo', run: async () => { await setProject(node.id, back); app.render(); } }]);
  }
}
