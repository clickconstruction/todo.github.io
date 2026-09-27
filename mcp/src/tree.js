// Tech tree for agents: goals and projects linked by what they require (rules in js/tree-rules.js, the same
// ones the app uses; the database refuses loops and keeps everything, migration 20261103000001).
import { buildTree, keyOf, opensWith, wouldLoop, proposeFromLibrary, live } from '../../js/tree-rules.js';

const OPEN = 'completed_at=is.null&dropped_at=is.null';

export function treeTools() {
  const load = async (api) => {
    const [goals, projects, links] = await Promise.all([
      api.q(`goals?${api.u}&select=*`), api.q(`projects?${api.u}&select=*`), api.q(`tree_links?${api.u}&archived_at=is.null&select=*`),
    ]);
    return { goals, projects, links, tree: buildTree({ goals, projects, links }) };
  };
  // A goal or project by id or exact name. kind narrows it when a goal and a project share a name.
  const find = (L, ref, kind) => {
    const r = String(ref || '').trim().toLowerCase();
    if (!r) throw new Error('Name the goal or project (its name or id).');
    const hits = [
      ...L.goals.filter((g) => g.status !== 'dropped' && (g.id === ref || g.title.trim().toLowerCase() === r)).map((g) => ({ kind: 'goal', id: g.id, title: g.title })),
      ...L.projects.filter((p) => p.status !== 'dropped' && (p.id === ref || p.name.trim().toLowerCase() === r)).map((p) => ({ kind: 'project', id: p.id, title: p.name })),
    ].filter((x) => !kind || x.kind === kind);
    if (!hits.length) throw new Error(`No goal or project called “${ref}”. Use list_projects or list_horizons for the exact name; a new milestone goes in as {milestone: "…"}.`);
    if (hits.length > 1) throw new Error(`“${ref}” is both a goal and a project (or there are two). Pass its id, or kind: goal | project.`);
    return hits[0];
  };
  const nodeOut = (tree, x) => ({
    id: x.id, kind: x.kind, type: x.type === 'project' || x.type === 'goal' ? undefined : x.type, title: x.title, state: x.state,
    needs: x.state === 'locked' ? x.unmet.map((u) => u.title) : undefined,
    on_hold: x.kind === 'project' ? x.held || undefined : undefined,
    note: x.state === 'locked' && x.kind === 'project' && !x.held ? 'locked but still active: offer hold' : x.state === 'ready' ? 'unlocked, still on hold: offer start' : x.state === 'held' ? 'on hold for its own reasons, not the tree’s' : undefined,
    unlocks: x.unlocks.length ? x.unlocks.map((k) => (tree.nodes.get(k) || {}).title).filter(Boolean) : undefined,
  });
  const propOut = (L, l) => ({ id: l.id, node: (L.tree.nodes.get(keyOf(l.node_kind, l.node_id)) || {}).title, requires: l.requires_id ? (L.tree.nodes.get(keyOf(l.requires_kind, l.requires_id)) || {}).title : l.requires_title,
    new_milestone: l.requires_id ? undefined : true, why: l.why || undefined, by: l.proposed_by });
  const openCount = async (api, ids) => {
    if (!ids.length) return {};
    const rows = await api.q(`tasks?${api.u}&${OPEN}&project_id=in.(${ids.map((x) => `"${x}"`).join(',')})&select=id,project_id`);
    return rows.reduce((m, t) => { m[t.project_id] = (m[t.project_id] || 0) + 1; return m; }, {});
  };
  const insert = async (api, L, node, req, extra) => {
    const dup = L.links.find((l) => live(l) && l.node_kind === node.kind && l.node_id === node.id && (req.id ? l.requires_id === req.id : String(l.requires_title || '').trim().toLowerCase() === req.title.trim().toLowerCase()));
    if (dup) return { row: dup, already: true };
    if (req.id && wouldLoop(L.links, keyOf(node.kind, node.id), keyOf(req.kind, req.id))) throw new Error(node.id === req.id ? `“${node.title}” can’t require itself.` : `That would make a loop: “${req.title}” already rests on “${node.title}”.`);
    const [row] = await api.q('tree_links', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, node_kind: node.kind, node_id: node.id,
      requires_kind: req.id ? req.kind : null, requires_id: req.id || null, requires_title: req.id ? null : req.title, why: '', ...extra } });
    L.links.push(row);
    return { row };
  };
  const reqOf = (L, x) => {
    if (x.milestone !== undefined) { const title = String(x.milestone || '').trim().slice(0, 300); if (!title) throw new Error('milestone needs its words, e.g. "Can afford to pay someone full time"'); const g = L.goals.find((y) => y.status !== 'dropped' && y.title.trim().toLowerCase() === title.toLowerCase()); return g ? { kind: 'goal', id: g.id, title: g.title } : { title }; }
    return find(L, x.requires, x.requires_kind);
  };

  return [{
    name: 'tech_tree',
    description: `The user's tech tree: goals and projects linked by what they require, so doing certain things unlocks future things. States: achieved · open (everything it requires is done) · ready (a project that is unlocked but still on hold) · locked (needs something first) · held (a project on hold that requires nothing on the tree: leave it be). A milestone is a condition the user ticks ("Can afford to pay someone full time"); a destination is where a branch leads (mark either with save_goal kind).
Locks are real for projects: a locked project belongs on hold (its actions leave the available lists) and an unlocked one can be started. NEVER hold or start a project, or accept a link, without the user saying so: propose, and tell them what would change.
actions: get {destination?} (the tree: counts, destinations with progress and what is next, every node, proposed links) · link {node, requires | milestone} (an accepted link, when the user states it) · propose {links: [{node, requires | milestone, why}]} (your ideas: shown dashed in the app until they accept) · find {save?} (links already written in the library: "(phase 2)" in a project's name, "Start when…" in an action or notes; save: true stores them as proposals) · accept {id | all: true} · dismiss {id} · unlink {node, requires} · hold {project} · start {project}.
node and requires are names or ids of goals or projects (kind / requires_kind: goal | project when a name is both). To answer "what should I work towards?", get with the destination and read next.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'link', 'propose', 'find', 'accept', 'dismiss', 'unlink', 'hold', 'start'], default: 'get' },
      destination: { type: 'string', description: 'get: only this destination’s branch (goal name or id)' },
      node: { type: 'string' }, kind: { type: 'string', enum: ['goal', 'project'] },
      requires: { type: 'string' }, requires_kind: { type: 'string', enum: ['goal', 'project'] },
      milestone: { type: 'string', description: 'link/propose: the requirement is this condition (found by title, or made when accepted)' },
      links: { type: 'array', description: 'propose: several at once', items: { type: 'object', properties: { node: { type: 'string' }, kind: { type: 'string' }, requires: { type: 'string' }, requires_kind: { type: 'string' }, milestone: { type: 'string' }, why: { type: 'string' } }, required: ['node'] } },
      why: { type: 'string', description: 'propose: one line on why you think so, shown beside the proposal' },
      id: { type: 'string', description: 'accept / dismiss: the proposed link' }, all: { type: 'boolean', description: 'accept: every proposed link' },
      project: { type: 'string', description: 'hold / start: project name or id' },
      save: { type: 'boolean', description: 'find: store what was found as proposals' },
    } },
    async run(api, a) {
      const action = a.action || 'get';
      const L = await load(api);

      if (action === 'link' || action === 'propose') {
        const list = action === 'propose' && Array.isArray(a.links) && a.links.length ? a.links : [a];
        if (list.length > 40) throw new Error('Up to 40 links in one call');
        const pairs = list.map((x) => ({ node: find(L, x.node, x.kind), req: reqOf(L, x), why: String(x.why || '').trim().slice(0, 500) })); // all checked before anything is saved
        const out = [];
        for (const p of pairs) {
          if (action === 'link' && !p.req.id) { // a new milestone: made now, since the user stated the link
            const [g] = await api.q('goals', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: p.req.title, kind: 'milestone' } });
            L.goals.push(g); Object.assign(p.req, { kind: 'goal', id: g.id });
          }
          const r = await insert(api, L, p.node, p.req, action === 'propose' ? { state: 'proposed', proposed_by: 'agent', why: p.why } : {});
          out.push({ id: r.row.id, node: p.node.title, requires: p.req.title, state: r.row.state, already: r.already || undefined });
        }
        const after = buildTree({ goals: L.goals, projects: L.projects, links: L.links });
        const locked = action === 'link' ? [...new Set(pairs.map((p) => keyOf(p.node.kind, p.node.id)))].map((k) => after.nodes.get(k)).filter((x) => x && x.kind === 'project' && x.state === 'locked' && !x.held) : [];
        const counts = await openCount(api, locked.map((x) => x.id));
        return { [action === 'link' ? 'linked' : 'proposed']: out,
          ...(locked.length ? { now_locked_but_active: locked.map((x) => ({ project: x.title, open_actions: counts[x.id] || 0 })), next: 'Ask the user whether to put these on hold (tech_tree hold): their actions would leave the available lists.' } : {}),
          ...(action === 'propose' ? { next: 'Shown dashed in the app (Horizons → Tech tree) until the user accepts.' } : {}) };
      }

      if (action === 'find') {
        const tasks = await api.q(`tasks?${api.u}&${OPEN}&title=ilike.${encodeURIComponent('start*when*')}&select=id,title,project_id,completed_at,dropped_at`);
        const found = proposeFromLibrary({ projects: L.projects, tasks, links: L.links });
        if (!a.save || !found.length) return { found: found.map((f) => ({ node: f.node.title, requires: f.requires.title, new_milestone: f.requires.id ? undefined : true, why: f.why })), saved: false, next: found.length ? 'Tell the user what you found; find with save: true stores them as proposals for them to accept.' : 'Nothing new is written into the library.' };
        const rows = await api.q('tree_links', { method: 'POST', prefer: 'return=representation', body: found.map((f) => ({ user_id: api.userId, node_kind: f.node.kind, node_id: f.node.id, state: 'proposed', proposed_by: 'agent', why: f.why.slice(0, 500),
          requires_kind: f.requires.id ? f.requires.kind : null, requires_id: f.requires.id || null, requires_title: f.requires.id ? null : f.requires.title })) });
        return { saved: rows.length, proposals: found.map((f, i) => ({ id: rows[i] && rows[i].id, node: f.node.title, requires: f.requires.title, why: f.why })), next: 'They wait in the app (Horizons → Tech tree) for the user to accept or dismiss.' };
      }

      if (action === 'accept') {
        const ids = a.all ? L.tree.proposals.map((l) => l.id) : [a.id].filter(Boolean);
        if (!ids.length) throw new Error(a.all ? 'No proposed links to accept.' : 'id is required (or all: true)');
        if (!a.all && !L.tree.proposals.some((l) => l.id === a.id)) throw new Error('No proposed link with that id. tech_tree get lists them.');
        const done = [];
        for (const id of ids.slice(0, 40)) done.push(await api.q('rpc/tree_accept', { method: 'POST', body: { link: id, owner: api.userId } }));
        const L2 = await load(api);
        const touched = new Set(L.links.filter((l) => ids.includes(l.id)).map((l) => keyOf(l.node_kind, l.node_id)));
        const locked = [...touched].map((k) => L2.tree.nodes.get(k)).filter((x) => x && x.kind === 'project' && x.state === 'locked' && !x.held);
        const counts = await openCount(api, locked.map((x) => x.id));
        return { accepted: done.length, milestones_made: done.filter((d) => d && d.milestone_made).length || undefined, counts: L2.tree.counts,
          ...(locked.length ? { now_locked_but_active: locked.map((x) => ({ project: x.title, open_actions: counts[x.id] || 0 })), next: 'Ask the user whether to put these on hold (tech_tree hold).' } : {}) };
      }
      if (action === 'dismiss') {
        const l = L.tree.proposals.find((x) => x.id === a.id);
        if (!l) throw new Error('No proposed link with that id.');
        await api.q(`tree_links?${api.u}&id=eq.${l.id}`, { method: 'PATCH', body: { archived_at: new Date().toISOString() } });
        return { dismissed: propOut(L, l) };
      }
      if (action === 'unlink') {
        const node = find(L, a.node, a.kind); const req = find(L, a.requires, a.requires_kind);
        const l = L.links.find((x) => live(x) && x.node_kind === node.kind && x.node_id === node.id && x.requires_id === req.id);
        if (!l) throw new Error(`“${node.title}” doesn’t require “${req.title}”.`);
        await api.q(`tree_links?${api.u}&id=eq.${l.id}`, { method: 'PATCH', body: { archived_at: new Date().toISOString() } });
        return { unlinked: { node: node.title, requires: req.title }, note: 'Archived, not deleted.' };
      }
      if (action === 'hold' || action === 'start') {
        const p = find(L, a.project, 'project');
        const x = L.tree.nodes.get(keyOf('project', p.id));
        if (action === 'start' && x && x.state === 'locked') throw new Error(`“${p.title}” is still locked: it needs ${x.unmet.map((u) => `“${u.title}”`).join(', ')}. Start it anyway with update_project status active, if the user says so.`);
        const counts = await openCount(api, [p.id]);
        await api.q(`projects?${api.u}&id=eq.${p.id}`, { method: 'PATCH', body: { status: action === 'hold' ? 'on_hold' : 'active' } });
        return { project: p.title, status: action === 'hold' ? 'on_hold' : 'active', open_actions: counts[p.id] || 0, note: action === 'hold' ? 'Its actions have left the available lists until it is started.' : 'Its actions are available again.' };
      }

      // get
      const dest = a.destination ? find(L, a.destination, 'goal') : null;
      const tree = L.tree;
      const shown = dest ? tree.path(tree.nodes.get(keyOf('goal', dest.id)) || { key: '', requires: [] }).nodes : tree.shown;
      const achievable = tree.shown.filter((x) => x.state === 'open' && x.type === 'milestone').map((x) => ({ milestone: x.title, would_unlock: opensWith(tree, x.key).map((d) => d.title) })).filter((x) => x.would_unlock.length);
      return { counts: tree.counts,
        destinations: tree.destinations.map((d) => { const p = tree.path(d); return { id: d.id, title: d.title, state: d.state, done: p.done, of: p.total, next: p.next.filter((x) => x.key !== d.key).map((x) => x.title), note: p.total > 1 ? undefined : 'no path yet: nothing is linked to it' }; }),
        nodes: shown.sort((x, y) => x.depth - y.depth || x.title.localeCompare(y.title)).slice(0, 200).map((x) => nodeOut(tree, x)),
        proposals: tree.proposals.length ? tree.proposals.map((l) => propOut(L, l)) : undefined,
        milestones_to_tick: achievable.length ? achievable : undefined,
        ...(tree.shown.length ? {} : { next: 'The tree is empty. tech_tree find looks for links already written in the library; save_goal kind: destination marks where a branch leads.' }) };
    },
  }];
}
