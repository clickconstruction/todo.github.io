// Slipbox and reading list for agents: the same notes and list the user sees in the app.
// Slipbox notes: one idea each, in the user's words, linked with [[Title]]; archived, never deleted.
// Reading list: actions with a reading state (up_next is parked in Someday; reading is a live action).
import { linkTitles, backlinks, outgoing, searchNotes, guessReadingType } from '../../js/slipbox.js';

export function slipboxTools({ tool }) {
  const notes = (api) => api.q(`slipbox_notes?${api.u}&archived_at=is.null&select=*`);
  const snippet = (b) => String(b || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const out = (n, all) => ({ id: n.id, title: n.title, kind: n.kind, body: n.body || undefined, source: n.source || undefined, source_url: n.source_url || undefined,
    links: all ? outgoing(n, all).linked.map((x) => x.title) : linkTitles(n.body), missing_links: all ? outgoing(n, all).missing : undefined,
    linked_from: all ? backlinks(n, all).map((x) => x.title) : undefined, created: n.created_at, processed: n.processed_at || undefined });
  const find = (all, ref) => all.find((n) => n.id === ref) || all.find((n) => n.title.toLowerCase() === String(ref || '').trim().toLowerCase());
  return [{
    name: 'slipbox',
    description: `The user's slipbox (Zettelkasten): one idea per note, in their own words, linked to other notes with [[Title]] in the body. Fleeting = just captured; permanent = processed (one clear idea, linked). Notes are not actions and never appear in task lists; archived, never deleted.
Use it when the user has an idea to think with rather than something to do, and to help process fleeting notes into permanent ones (ask for their words; suggest links to existing notes).
actions: add {title, body?, source?, source_url?} · list {kind?: fleeting|permanent, q?, limit?} · get {note: id or title} (with links and backlinks) · update {note, title?, body?, source?, kind?} (kind permanent marks it processed) · archive {note} · from_task {task_id, title?, source?} (an action that is really an idea: becomes a fleeting note, the action is dropped)`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'list', 'get', 'update', 'archive', 'from_task'], default: 'list' },
      note: { type: 'string', description: 'Note id or exact title' }, title: { type: 'string' }, body: { type: 'string' }, source: { type: 'string' }, source_url: { type: 'string' },
      kind: { type: 'string', enum: ['fleeting', 'permanent'] }, q: { type: 'string' }, limit: { type: 'integer' }, task_id: { type: 'string' } } },
    async run(api, a) {
      const action = a.action || 'list';
      if (action === 'add') {
        if (!a.title || !String(a.title).trim()) throw new Error('title is required');
        const [n] = await api.q('slipbox_notes', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: String(a.title).trim().slice(0, 300), body: a.body || '', source: a.source || '', source_url: a.source_url || null, kind: 'fleeting' } });
        return out(n);
      }
      if (action === 'from_task') {
        if (!a.task_id) throw new Error('task_id is required');
        const id = await api.q('rpc/slipbox_from_task', { method: 'POST', body: { task: a.task_id, title: a.title || null, body: null, source: a.source || '', owner: api.userId } });
        const [n] = await api.q(`slipbox_notes?${api.u}&id=eq.${id}&select=*`);
        return { ...(n ? out(n) : { id }), next: 'The action was dropped (not deleted); the idea is now a fleeting note.' };
      }
      const all = await notes(api);
      if (action === 'list') {
        const list = searchNotes(all, a.q).filter((n) => !a.kind || n.kind === a.kind).sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
        return { count: list.length, fleeting: all.filter((n) => n.kind === 'fleeting').length, notes: list.slice(0, Math.min(200, a.limit || 50)).map((n) => ({ id: n.id, title: n.title, kind: n.kind, snippet: snippet(n.body) || undefined, source: n.source || undefined, links: linkTitles(n.body).length || undefined })) };
      }
      const n = find(all, a.note);
      if (!n) throw new Error(`No note "${a.note}". Use list.`);
      if (action === 'get') return out(n, all);
      if (action === 'archive') { await api.q(`slipbox_notes?${api.u}&id=eq.${n.id}`, { method: 'PATCH', body: { archived_at: new Date().toISOString() } }); return { archived: n.title }; }
      if (action === 'update') {
        const patch = {};
        if (a.title !== undefined) patch.title = String(a.title).trim().slice(0, 300);
        if (a.body !== undefined) patch.body = String(a.body);
        if (a.source !== undefined) patch.source = String(a.source);
        if (a.source_url !== undefined) patch.source_url = a.source_url || null;
        if (a.kind) { patch.kind = a.kind; patch.processed_at = a.kind === 'permanent' ? new Date().toISOString() : null; }
        const [row] = await api.q(`slipbox_notes?${api.u}&id=eq.${n.id}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
        return out(row, (await notes(api)));
      }
      throw new Error('Unknown action');
    },
  }, {
    name: 'reading',
    description: `The user's reading list: books, articles, videos and podcasts, kept apart from their actions. up_next = waiting (parked in Someday, out of lists); reading = in progress (a live action); finished = done, with notes still to write until notes_done.
actions: list · add {title, type?: book|article|video|podcast|other, url?} (up next) · move {task_id, state: up_next|reading|finished|off, type?} (off = no longer on the list) · notes_done {task_id} · take_notes {task_id, body?} (a fleeting slipbox note linked to it)
When the user finishes something, offer to take notes (their ideas, in their words) into the slipbox.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'add', 'move', 'notes_done', 'take_notes'], default: 'list' },
      title: { type: 'string' }, type: { type: 'string', enum: ['book', 'article', 'video', 'podcast', 'other'] }, url: { type: 'string' },
      task_id: { type: 'string' }, state: { type: 'string', enum: ['up_next', 'reading', 'finished', 'off'] }, body: { type: 'string' } } },
    async run(api, a) {
      const action = a.action || 'list';
      const shape = (t) => ({ id: t.id, title: t.title, type: t.reading_type || guessReadingType(t.title), url: t.reading_url || undefined, state: t.reading_state });
      if (action === 'list') {
        const [open, done] = await Promise.all([
          api.q(`tasks?${api.u}&reading_state=in.(up_next,reading)&completed_at=is.null&dropped_at=is.null&select=id,title,reading_type,reading_url,reading_state,created_at`),
          api.q(`tasks?${api.u}&reading_state=eq.finished&reading_notes_done=is.false&order=completed_at.desc&limit=100&select=id,title,reading_type,reading_url,reading_state,completed_at`),
        ]);
        return { reading_now: open.filter((t) => t.reading_state === 'reading').map(shape), up_next_count: open.filter((t) => t.reading_state === 'up_next').length,
          up_next: open.filter((t) => t.reading_state === 'up_next').sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, 50).map(shape), notes_to_write: done.map(shape) };
      }
      if (action === 'add') {
        if (!a.title || !String(a.title).trim()) throw new Error('title is required');
        const made = await tool('capture').run(api, { title: String(a.title).trim(), notes: a.url || '' });
        const r = await api.q('rpc/reading_set', { method: 'POST', body: { task: made.id, state: 'up_next', rtype: a.type || null, owner: api.userId } });
        return { added: made.title, id: made.id, ...r };
      }
      if (!a.task_id) throw new Error('task_id is required');
      if (action === 'move') {
        if (!a.state) throw new Error('state is required');
        return api.q('rpc/reading_set', { method: 'POST', body: { task: a.task_id, state: a.state, rtype: a.type || null, owner: api.userId } });
      }
      if (action === 'notes_done') { await api.q(`tasks?${api.u}&id=eq.${a.task_id}`, { method: 'PATCH', body: { reading_notes_done: true } }); return { notes_done: true }; }
      if (action === 'take_notes') {
        const [t] = await api.q(`tasks?${api.u}&id=eq.${a.task_id}&select=id,title,reading_url`);
        if (!t) throw new Error('Not found');
        const [n] = await api.q('slipbox_notes', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: `Notes: ${t.title}`.slice(0, 300), body: a.body || '', source: String(t.title).slice(0, 500), source_url: t.reading_url || null, reading_task_id: t.id, kind: 'fleeting' } });
        return { note: { id: n.id, title: n.title }, next: 'A fleeting note linked to what they read; help them turn it into permanent notes.' };
      }
      throw new Error('Unknown action');
    },
  }];
}
