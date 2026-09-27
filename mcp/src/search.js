// Search for agents: a word or phrase across the user's actions (open and done), projects, Slipbox notes,
// reference (never secret values), events, people, places, checklists, areas and goals, the same stores the
// app's Search covers. Every word must match; a few requests in parallel, whatever the library size.
// Checklists are read whole and matched here: their lines are JSON, which the API can't search, and there are few.

const clean = (w) => w.replace(/[,()*%\\:."'\s]/g, '').trim();
function snip(text, words, width = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const low = s.toLowerCase();
  if (!s) return undefined;
  const at = Math.min(...words.map((w) => { const i = low.indexOf(w); return i < 0 ? Infinity : i; }));
  const from = Number.isFinite(at) ? Math.max(0, at - 40) : 0; // matched in the title: the opening of the text
  return `${from > 0 ? '…' : ''}${s.slice(from, from + width)}${from + width < s.length ? '…' : ''}`;
}

export function searchTools() {
  return [{
    name: 'search',
    description: 'Search everything the user keeps: actions (open and completed/dropped), projects, Slipbox notes, reference (titles, topics and bodies; never secret values), events, people, places, checklists (names and lines), areas and goals. Every word must match. Returns each hit with a snippet of where it matched; open anything with its own tool (get_task, slipbox, search_reference, events, list_people, list_places, list_checklists, list_horizons).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 20, description: 'Per kind, 1-50' } }, required: ['query'] },
    async run(api, a) {
      const words = String(a.query || '').toLowerCase().split(/\s+/).map(clean).filter(Boolean).slice(0, 6);
      if (!words.length) throw new Error('query is required');
      const n = Math.min(50, Math.max(1, Math.round(Number(a.limit) || 20)));
      const ors = (cols) => words.map((w) => `or=(${cols.map((c) => `${c}.ilike.*${encodeURIComponent(w)}*`).join(',')})`).join('&');
      const [tasks, projects, notes, refs, events, people, places, checklists, areas, goals] = await Promise.all([
        api.q(`tasks?${api.u}&${ors(['title', 'notes', 'gain', 'completion_note'])}&order=updated_at.desc&limit=${n}&select=id,title,notes,project_id,completed_at,dropped_at`),
        api.q(`projects?${api.u}&${ors(['name', 'notes'])}&limit=${n}&select=id,name,status,notes`),
        api.q(`slipbox_notes?${api.u}&archived_at=is.null&${ors(['title', 'body'])}&limit=${n}&select=id,title,body,kind`),
        api.q(`reference_items?${api.u}&archived_at=is.null&${ors(['title', 'topic', 'body'])}&limit=${n}&select=id,title,topic,body`),
        api.q(`events?${api.u}&archived_at=is.null&${ors(['title', 'location', 'notes'])}&order=starts_at.desc&limit=${n}&select=id,title,location,notes,starts_at,all_day`),
        api.q(`people?${api.u}&archived_at=is.null&${ors(['name', 'email', 'notes'])}&limit=${n}&select=id,name,email,notes`),
        api.q(`places?${api.u}&archived_at=is.null&${ors(['name', 'address', 'notes'])}&limit=${n}&select=id,name,address,notes`),
        api.q(`checklists?${api.u}&archived_at=is.null&order=sort.asc&select=id,name,items`),
        api.q(`areas?${api.u}&archived_at=is.null&${ors(['name', 'standards'])}&limit=${n}&select=id,name,standards`),
        api.q(`goals?${api.u}&${ors(['title', 'why'])}&limit=${n}&select=id,title,why,status`),
      ]);
      const pids = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))];
      const pnames = pids.length ? await api.q(`projects?${api.u}&id=in.(${pids.map((x) => `"${x}"`).join(',')})&select=id,name`) : [];
      const pname = (id) => (pnames.find((p) => p.id === id) || {}).name;
      const out = { query: words.join(' ') };
      const put = (k, list) => { if (list.length) out[k] = list; };
      put('actions', tasks.map((t) => ({ id: t.id, title: t.title, project: pname(t.project_id), status: t.completed_at ? 'completed' : t.dropped_at ? 'dropped' : 'open', snippet: snip(t.notes, words) })));
      put('projects', projects.map((p) => ({ id: p.id, name: p.name, status: p.status, snippet: snip(p.notes, words) })));
      put('slipbox', notes.map((x) => ({ id: x.id, title: x.title, kind: x.kind, snippet: snip(x.body, words) })));
      put('reference', refs.map((r) => ({ id: r.id, title: r.title, topic: r.topic || undefined, snippet: snip(r.body, words) })));
      put('events', events.map((e) => ({ id: e.id, title: e.title, starts: e.starts_at, all_day: e.all_day || undefined, location: e.location || undefined })));
      put('people', people.map((p) => ({ id: p.id, name: p.name, email: p.email || undefined, snippet: snip(p.notes, words) })));
      put('places', places.map((p) => ({ id: p.id, name: p.name, address: p.address || undefined, snippet: snip(p.notes, words) })));
      const lines = (c) => (Array.isArray(c.items) ? c.items : []).map((i) => (i && i.text) || '').filter(Boolean);
      put('checklists', checklists.map((c) => ({ c, text: `${c.name} ${lines(c).join(' ')}`.toLowerCase() })).filter((x) => words.every((w) => x.text.includes(w))).slice(0, n)
        .map(({ c }) => ({ id: c.id, name: c.name, snippet: snip(lines(c).join(' · '), words) })));
      put('areas', areas.map((x) => ({ id: x.id, name: x.name, snippet: snip(x.standards, words) })));
      put('goals', goals.map((g) => ({ id: g.id, title: g.title, status: g.status, snippet: snip(g.why, words) })));
      if (Object.keys(out).length === 1) out.none = 'Nothing matched every word. Try fewer words.';
      return out;
    },
  }];
}
