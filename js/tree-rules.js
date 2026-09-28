// Tech tree, the rules (no imports: the app and the MCP Worker both use them).
// A node is a goal or a project that takes part in a link, or a goal marked milestone or destination.
// What a node requires can also be a card (an action or a step): finishing the card opens what waits on it.
// A card is never the locked one: cards wait on cards through "Waits for".
// A link says "this node requires that one" (tree_links; the database refuses loops). States:
//   achieved  the goal is achieved / the project completed
//   open      everything it requires is achieved (or it requires nothing)
//   ready     a project whose requirements are met but which is still on hold: unlocked, not started
//   held      a project on hold that requires nothing on the tree: on hold for its own reasons, not the tree's
//   locked    something it requires isn't achieved yet
//   unmapped  a destination nothing leads to yet: there is no path, so it is not "open" (you can't just go
//             and be an astronaut); it asks to be mapped
// A dropped node neither blocks nor shows. Proposed links (from Claude or the library) are drawn,
// dashed, and block nothing until accepted.
export const keyOf = (kind, id) => `${kind}:${id}`;
export const live = (l) => !l.archived_at;

export function buildTree({ goals = [], projects = [], tasks = [], links = [] }) {
  const nodes = new Map();
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const add = (kind, id) => {
    const key = keyOf(kind, id);
    if (nodes.has(key)) return nodes.get(key);
    const row = kind === 'goal' ? goalById.get(id) : kind === 'task' ? taskById.get(id) : projectById.get(id);
    if (!row) return null;
    const n = kind === 'task'
      ? { key, kind, id, title: row.title, type: 'card', done: !!row.completed_at, gone: !!row.dropped_at && !row.completed_at, held: false, at: row.completed_at || null, in: (projectById.get(row.project_id) || {}).name || '' }
      : kind === 'goal'
      ? { key, kind, id, title: row.title, type: row.kind || 'goal', done: row.status === 'achieved', gone: row.status === 'dropped', held: false, at: row.achieved_at || null }
      : { key, kind, id, title: row.name, type: 'project', done: row.status === 'completed', gone: row.status === 'dropped', held: row.status === 'on_hold', at: row.completed_at || null };
    Object.assign(n, { requires: [], proposed: [], unlocks: [], raw: row });
    nodes.set(key, n);
    return n;
  };
  goals.filter((g) => g.kind === 'milestone' || g.kind === 'destination').forEach((g) => add('goal', g.id));
  const pending = []; // proposed links whose requirement is only a title so far (a milestone made on accept)
  links.filter(live).forEach((l) => {
    const n = add(l.node_kind, l.node_id);
    if (!n) return;
    if (!l.requires_id) { if (l.state === 'proposed') { n.proposed.push({ link: l, title: l.requires_title }); pending.push(l); } return; }
    const r = add(l.requires_kind, l.requires_id);
    if (!r) return;
    if (l.state === 'proposed') n.proposed.push({ link: l, key: r.key, title: r.title });
    else { n.requires.push({ link: l, key: r.key }); r.unlocks.push(n.key); }
  });
  const shown = [...nodes.values()].filter((n) => !n.gone);
  shown.forEach((n) => {
    n.unmet = n.requires.map((r) => nodes.get(r.key)).filter((r) => r && !r.done && !r.gone);
    n.state = n.done ? 'achieved' : n.unmet.length ? 'locked' : n.type === 'destination' && !n.requires.length ? 'unmapped'
      : n.kind === 'project' && n.held ? (n.requires.length ? 'ready' : 'held') : 'open';
  });
  // Depth: the longest chain of requirements under a node (proposed links count, so they have a place to be drawn).
  const depth = new Map();
  const depthOf = (n, seen = new Set()) => {
    if (depth.has(n.key)) return depth.get(n.key);
    if (seen.has(n.key)) return 0;
    seen.add(n.key);
    const below = [...n.requires, ...n.proposed.filter((p) => p.key)].map((r) => nodes.get(r.key)).filter((r) => r && !r.gone);
    const d = below.length ? 1 + Math.max(...below.map((r) => depthOf(r, seen))) : 0;
    depth.set(n.key, d);
    return d;
  };
  shown.forEach((n) => { n.depth = depthOf(n); });
  // Everything a node rests on, itself included (accepted links only).
  const under = (n, acc = new Map()) => { if (!n || acc.has(n.key) || n.gone) return acc; acc.set(n.key, n); n.requires.forEach((r) => under(nodes.get(r.key), acc)); return acc; };
  const path = (n) => {
    const all = [...under(n).values()];
    return { nodes: all, done: all.filter((x) => x.done).length, total: all.length, next: all.filter((x) => x.state === 'open' || x.state === 'ready').sort((a, b) => a.depth - b.depth) };
  };
  // Branches: nodes joined by links (proposed ones too) sit together; each node gets a row in its branch, so
  // a chain reads straight across. A node joined to nothing is loose (a destination with no path yet).
  const joined = new Map(shown.map((n) => [n.key, new Set()]));
  shown.forEach((n) => [...n.requires, ...n.proposed.filter((p) => p.key)].forEach((r) => { if (joined.has(r.key)) { joined.get(n.key).add(r.key); joined.get(r.key).add(n.key); } }));
  const branches = []; const seenB = new Set();
  [...shown].sort((a, b) => a.depth - b.depth || a.title.localeCompare(b.title)).forEach((n) => {
    if (seenB.has(n.key)) return;
    const group = []; const stack = [n.key];
    while (stack.length) { const k = stack.pop(); if (seenB.has(k)) continue; seenB.add(k); group.push(nodes.get(k)); joined.get(k).forEach((x) => stack.push(x)); }
    group.forEach((x) => { x.branch = branches.length; });
    branches.push(group);
  });
  const loose = branches.filter((g) => g.length === 1).map((g) => g[0]);
  let row = 1;
  branches.filter((g) => g.length > 1).sort((a, b) => b.length - a.length).forEach((g) => {
    const cols = new Map();
    g.forEach((n) => { if (!cols.has(n.depth)) cols.set(n.depth, []); cols.get(n.depth).push(n); });
    // Each node sits on the row of what it requires when that row is free, else the next one down: a chain
    // reads straight across, and what fans out from one node stacks beside it.
    const place = new Map(); let tall = 0;
    [...cols.keys()].sort((a, b) => a - b).forEach((d) => {
      const near = (n) => { const below = [...n.requires, ...n.proposed.filter((p) => p.key)].map((r) => place.get(r.key)).filter((v) => v !== undefined); return below.length ? Math.min(...below) : 1e9; };
      const used = new Set();
      cols.get(d).sort((a, b) => near(a) - near(b) || a.title.localeCompare(b.title)).forEach((n) => {
        let r = near(n) === 1e9 ? 0 : near(n);
        while (used.has(r)) r += 1;
        used.add(r); place.set(n.key, r); n.col = d + 1; n.row = row + r; tall = Math.max(tall, r + 1);
      });
    });
    // What starts a branch lines up with what it leads to, where that row is free in the first column.
    const roots = cols.get(Math.min(...cols.keys())) || [];
    const taken = new Set();
    roots.map((n) => ({ n, want: Math.min(...[1e9, ...n.unlocks.map((k) => place.get(k)).filter((v) => v !== undefined)]) })).sort((a, b) => a.want - b.want).forEach(({ n, want }) => {
      let r = want === 1e9 ? 0 : want;
      while (taken.has(r)) r += 1;
      taken.add(r); place.set(n.key, r); n.row = row + r; tall = Math.max(tall, r + 1);
    });
    row += tall;
  });
  loose.forEach((n) => { n.col = 0; n.row = 0; });
  const destinations = shown.filter((n) => n.type === 'destination');
  const proposals = links.filter((l) => live(l) && l.state === 'proposed');
  const count = (s) => shown.filter((n) => n.state === s).length;
  const branchOf = (key) => { const n = nodes.get(key); return n && branches[n.branch] ? branches[n.branch] : []; };
  return { nodes, shown, loose, branches: branches.filter((g) => g.length > 1), branchOf, destinations, proposals, pending, path,
    counts: { achieved: count('achieved'), open: count('open') + count('ready'), ready: count('ready'), locked: count('locked'), held: count('held'), unmapped: count('unmapped') } };
}

// What would open if this node were achieved now: the nodes it unlocks whose other requirements are met.
export function opensWith(tree, key) {
  const n = tree.nodes.get(key);
  if (!n) return [];
  return n.unlocks.map((k) => tree.nodes.get(k)).filter((d) => d && !d.done && !d.gone && d.unmet.every((u) => u.key === key));
}

// Would adding "node requires req" make a loop? (The database refuses too; this is for a plain sentence first.)
// tasks: the cards, so that a card is known to rest on its project.
export function wouldLoop(links, node, req, tasks = []) {
  if (node === req) return true;
  const below = new Map();
  tasks.filter((t) => t.project_id).forEach((t) => below.set(keyOf('task', t.id), [keyOf('project', t.project_id)]));
  links.filter((l) => live(l) && l.requires_id).forEach((l) => { const k = keyOf(l.node_kind, l.node_id); if (!below.has(k)) below.set(k, []); below.get(k).push(keyOf(l.requires_kind, l.requires_id)); });
  const seen = new Set(); const stack = [req];
  while (stack.length) { const k = stack.pop(); if (k === node) return true; if (seen.has(k)) continue; seen.add(k); (below.get(k) || []).forEach((x) => stack.push(x)); }
  return false;
}

// Why a card can't be what this node requires, in words; '' when it can.
export function cardTrouble(node, task) {
  if (!task) return 'That card isn’t there.';
  if (node.kind === 'project' && task.project_id === node.id) return 'A project can’t require a card inside itself: on hold, it would hide the card that opens it.';
  return '';
}

// ----- links already written into the library, in words -----
// "(phase 2)" in a project's name: it requires phase 1 of the same run. "Start (this) when …" as an action's
// title or in a project's notes: the project requires that condition, a milestone shared by every project
// that says the same. → [{ node: {kind, id, title}, requires: {kind, id, title} | { title }, why }]
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export function conditionTitle(text) {
  let t = tidy(text).replace(/[.:;,\s]+$/, '');
  t = t.replace(/\bsomone\b/gi, 'someone').replace(/^i\s+(can|could|am|have)\b/i, (_, v) => v);
  t = t.replace(/^can afford to pay (a |an )?(personal )?(\w+ )?(someone|somebody|developer|person)\b.*full time$/i, 'Can afford to pay someone full time');
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}
const sameCondition = (a, b) => conditionTitle(a).toLowerCase() === conditionTitle(b).toLowerCase();
export function proposeFromLibrary({ projects = [], tasks = [], links = [] }) {
  const out = [];
  const liveP = projects.filter((p) => p.status === 'active' || p.status === 'on_hold');
  const has = (node, req) => links.some((l) => live(l) && l.node_kind === node.kind && l.node_id === node.id
    && (req.id ? l.requires_id === req.id : l.requires_title && sameCondition(l.requires_title, req.title)))
    || out.some((o) => o.node.id === node.id && (req.id ? o.requires.id === req.id : sameCondition(o.requires.title || '', req.title)));
  const phased = liveP.map((p) => ({ p, m: /\(phase\s*(\d+)\)/i.exec(p.name) })).filter((x) => x.m).map((x) => ({ p: x.p, n: Number(x.m[1]) })).sort((a, b) => a.n - b.n);
  phased.forEach((x) => {
    const prev = phased.filter((y) => y.n < x.n).pop();
    if (!prev) return;
    const node = { kind: 'project', id: x.p.id, title: x.p.name }; const requires = { kind: 'project', id: prev.p.id, title: prev.p.name };
    if (!has(node, requires)) out.push({ node, requires, why: `Its name says phase ${x.n}; “${prev.p.name}” is phase ${prev.n}.` });
  });
  const when = /^\s*start(?:\s+this)?\s+when:?\s+(.+?)\s*$/i;
  const said = [];
  tasks.filter((t) => !t.completed_at && !t.dropped_at && t.project_id).forEach((t) => { const m = when.exec(String(t.title || '').split(/:\s+(?=[A-Z])/)[0]); if (m) said.push({ project_id: t.project_id, text: m[1], from: `an action: “${tidy(t.title).slice(0, 90)}”` }); });
  liveP.forEach((p) => { const line = String(p.notes || '').split('\n').map((l) => when.exec(l)).find(Boolean); if (line) said.push({ project_id: p.id, text: line[1], from: 'its notes' }); });
  said.forEach((s) => {
    const p = liveP.find((x) => x.id === s.project_id);
    const title = conditionTitle(s.text);
    if (!p || !title) return;
    const node = { kind: 'project', id: p.id, title: p.name }; const requires = { title };
    if (!has(node, requires)) out.push({ node, requires, why: `Written in ${s.from}.` });
  });
  return out;
}

// ----- looking back over the tree -----
// The three questions of a review, answered from the tree.
//   since       ISO time: "this year" starts here (the last review, or a year ago)
//   activity    [{ project_id, done, last }]: what was finished in each project lately (rpc tree_activity)
//   openCounts  { project_id: open actions }
//   projects    every project (to say whether a goal's projects are moving)
// → { unlocked: [{ node, at, opened: [titles] }], open: [{ node, work, detail, under }], destinations: [{ node, done, total, next }] }
//   work: moving | stalled | empty (nothing to do in it) | todo (a card not done) | tick (a milestone to tick) | start (unlocked, on hold)
export function treeReview(tree, { since, activity = [], openCounts = {}, projects = [] }) {
  const act = new Map(activity.map((a) => [a.project_id, a]));
  const titleOf = (k) => (tree.nodes.get(k) || {}).title;
  const unlocked = tree.shown.filter((n) => n.done && n.at && n.at >= since).sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map((n) => ({ node: n, at: n.at, opened: n.unlocks.map((k) => tree.nodes.get(k)).filter((d) => d && !d.gone && d.state !== 'locked').map((d) => d.title) }));
  // Which destination an item leads to (the first whose path holds it).
  const paths = tree.destinations.map((d) => ({ d, keys: new Set(tree.path(d).nodes.map((x) => x.key)) }));
  const under = (n) => { const p = paths.find((x) => x.keys.has(n.key) && x.d.key !== n.key); return p ? p.d.title : ''; };
  const workOf = (n) => {
    if (n.state === 'ready') return { work: 'start', detail: 'unlocked, still on hold' };
    if (n.kind === 'task') return { work: 'todo', detail: n.in ? `a card in ${n.in}` : 'a card' };
    if (n.type === 'milestone') return { work: 'tick', detail: 'tick it when it is true' };
    const mine = n.kind === 'project' ? [n.id] : projects.filter((p) => p.goal_id === n.id && (p.status === 'active' || p.status === 'on_hold')).map((p) => p.id);
    const done = mine.reduce((sum, id) => sum + ((act.get(id) || {}).done || 0), 0);
    const left = mine.reduce((sum, id) => sum + (openCounts[id] || 0), 0);
    if (n.kind === 'goal' && !mine.length) return { work: 'empty', detail: 'no project serves it yet' };
    if (done) return { work: 'moving', detail: `${done} action${done === 1 ? '' : 's'} done lately` };
    return left ? { work: 'stalled', detail: `nothing done lately · ${left} open action${left === 1 ? '' : 's'}` } : { work: 'empty', detail: 'nothing to do in it yet' };
  };
  const ORDER = { start: 0, stalled: 1, todo: 2, empty: 3, tick: 4, moving: 5 };
  const open = tree.shown.filter((n) => n.state === 'open' || n.state === 'ready').map((n) => ({ node: n, ...workOf(n), under: under(n) }))
    .sort((a, b) => ORDER[a.work] - ORDER[b.work] || a.node.title.localeCompare(b.node.title));
  const destinations = tree.destinations.filter((d) => !d.done).map((d) => { const p = tree.path(d); return { node: d, done: p.done, total: p.total, next: p.next.filter((x) => x.key !== d.key).map((x) => x.title) }; });
  return { unlocked, open, destinations, titleOf };
}
