// Full Review for agents: the same session and current card the user sees in the app (#full/<id>).
// Read the card, talk it through with the user, annotate it (gain, project, dates, tags, a one-line
// note) and decide it; the app updates live. Every decision can be undone; nothing is deleted.
import { buildQueue, priorityReason, proposalText } from '../../js/review.js';

export function fullReviewTools({ OPEN, localDate, zonedToIso, tool }) {
  // ---------- suggestions: Claude proposes, the user Submits in the app ----------
  const TASK_DECISIONS = ['keep', 'someday', 'done', 'drop', 'skip', 'reading', 'slipbox'];
  const GROUP_DECISIONS = ['accept', 'one_by_one', 'keep_all', 'skip'];
  async function lookups(api) {
    const [projects, tags] = await Promise.all([
      api.q(`projects?${api.u}&status=in.(active,on_hold)&select=id,name`), api.q(`tags?${api.u}&status=neq.dropped&select=id,name,parent_id`),
    ]);
    const label = (g) => { const p = g.parent_id && tags.find((x) => x.id === g.parent_id); return p ? `${p.name} : ${g.name}` : g.name; };
    return { projects, tags, label };
  }
  // One suggestion from tool arguments; throws on anything that doesn't resolve (nothing is saved then).
  function suggestionFrom(api, a, kind, L) {
    const s = { at: new Date().toISOString() };
    const ok = kind === 'group' ? GROUP_DECISIONS : TASK_DECISIONS;
    if (!ok.includes(a.decision)) throw new Error(`decision must be one of: ${ok.join(', ')}`);
    s.decision = a.decision;
    if (a.note !== undefined) s.note = String(a.note).slice(0, 1000);
    if (a.ahead) s.ahead = true;
    if (kind === 'group') {
      if (a.proposal) s.proposal = { op: a.proposal.op || 'someday', ...(a.proposal.keep !== undefined ? { keep: a.proposal.keep } : {}) };
      return s;
    }
    if (a.title !== undefined && String(a.title).trim()) s.title = String(a.title).trim().slice(0, 1000);
    if (a.gain !== undefined) { s.gain = String(a.gain || '').trim().slice(0, 500); if (a.gain_suggested) s.gain_suggested = true; }
    if (a.project !== undefined) {
      if (a.project === null || a.project === '') s.project_id = null;
      else {
        const r = String(a.project).trim().toLowerCase();
        const p = L.projects.find((x) => x.id === a.project) || L.projects.find((x) => x.name.toLowerCase() === r);
        if (!p) throw new Error(`No active project called "${a.project}". Create it first (create_project) or pick another.`);
        s.project_id = p.id; s.project_name = p.name;
      }
    }
    const hours = { planned: api.hours.planned, due: api.hours.due, defer: api.hours.defer };
    ['planned', 'due', 'defer'].forEach((k) => { if (a[k] !== undefined) s[k] = a[k] === null || a[k] === '' ? null : zonedToIso(a[k], hours[k], api.tz); });
    if (a.flagged !== undefined) s.flagged = !!a.flagged;
    if (a.steps !== undefined) { // break it down: added under the action on Submit (keep / someday only)
      const steps = (Array.isArray(a.steps) ? a.steps : []).map((x) => String(x || '').trim().slice(0, 500)).filter(Boolean);
      if (steps.length > 40) throw new Error('At most 40 steps in one suggestion.');
      if (steps.length && !['keep', 'someday'].includes(a.decision)) throw new Error('Steps go with keep or someday.');
      if (steps.length) s.steps = steps;
    }
    if (a.steps_in_order !== undefined) s.steps_in_order = !!a.steps_in_order;
    const find = (name) => { const n = String(name).trim().toLowerCase(); return L.tags.find((g) => g.id === name) || L.tags.find((g) => L.label(g).toLowerCase() === n) || L.tags.find((g) => g.name.toLowerCase() === n); };
    if (Array.isArray(a.add_tags) && a.add_tags.length) {
      s.add_tag_ids = []; s.add_tag_names = []; s.add_tag_labels = [];
      a.add_tags.forEach((n) => { const g = find(n); if (g) { s.add_tag_ids.push(g.id); s.add_tag_labels.push(L.label(g)); } else { s.add_tag_names.push(String(n).trim().slice(0, 100)); s.add_tag_labels.push(`${String(n).trim()} (new)`); } });
    }
    if (Array.isArray(a.remove_tags) && a.remove_tags.length) {
      s.remove_tag_ids = []; s.remove_tag_labels = [];
      a.remove_tags.forEach((n) => { const g = find(n); if (g) { s.remove_tag_ids.push(g.id); s.remove_tag_labels.push(L.label(g)); } });
    }
    return s;
  }

  const touch = (api, id, extra = {}) => api.q(`review_sessions?${api.u}&id=eq.${id}`, { method: 'PATCH', body: { agent_seen_at: new Date().toISOString(), ...extra } });
  const findSession = async (api, sid) => {
    const rows = await api.q(`review_sessions?${api.u}&order=created_at.desc&limit=20&select=*`);
    const s = sid ? rows.find((r) => r.id === sid) : rows.find((r) => r.status === 'active');
    if (!s) throw new Error(sid ? 'No such review session.' : 'No review in progress. Start one with action "start".');
    return s;
  };
  // The queue without the heavy group lists (a group can hold thousands of ids); the current card in full.
  // Cloudflare allows 50 outgoing requests per call, so every read here is one query.
  const items = (api, sid) => api.q(`review_items?${api.u}&session_id=eq.${sid}&status=neq.void&order=sort.asc&select=id,sort,status,kind,task_id,priority,reviewed_at,label:grp->>label`);
  const itemFull = async (api, id) => (id ? (await api.q(`review_items?${api.u}&id=eq.${id}&select=*`))[0] || null : null);

  async function cardOut(api, it) {
    if (!it) return null;
    const base = { item_id: it.id, kind: it.kind, status: it.status, note: it.note || undefined, suggestion: it.suggestion && !it.suggestion.applied_at ? it.suggestion : undefined };
    if (it.kind === 'group') {
      const g = it.grp || {};
      const ids = g.task_ids || [];
      const rows = ids.length ? await api.q(`tasks?${api.u}&id=in.(${ids.slice(0, 12).map((x) => `"${x}"`).join(',')})&select=id,title`) : [];
      return { ...base, group: { label: g.label, count: ids.length, sample: rows.map((r) => r.title), proposal: g.proposal || { op: 'someday' }, proposal_text: proposalText(g.proposal, ids.length) },
        decisions: 'accept (apply the proposal) | one_by_one (expand into single cards) | keep_all | skip' };
    }
    const [raw] = await api.q(`tasks?${api.u}&id=eq.${it.task_id}&select=*`);
    if (!raw) return { ...base, task: null };
    const [links, projects] = await Promise.all([
      api.q(`task_tags?${api.u}&task_id=eq.${raw.id}&select=tag_id`),
      raw.project_id ? api.q(`projects?${api.u}&id=eq.${raw.project_id}&select=id,name,flagged,purpose`) : [],
    ]);
    const tags = links.length ? await api.q(`tags?${api.u}&id=in.(${links.map((l) => `"${l.tag_id}"`).join(',')})&select=name`) : [];
    const p = projects[0] || null;
    const day = (iso) => (iso ? localDate(iso, api.tz) : undefined);
    return { ...base, priority: it.priority || undefined, why_first: it.priority ? priorityReason(raw, p) || undefined : undefined,
      task: { id: raw.id, title: raw.title, notes: raw.notes ? String(raw.notes).slice(0, 2000) : undefined, project: p ? p.name : undefined, project_gain: p && p.purpose ? p.purpose : undefined,
        tags: tags.map((g) => g.name), gain: raw.gain || undefined, gain_suggested: raw.gain_by === 'agent' || undefined, flagged: raw.flagged || undefined,
        due: day(raw.due_at), planned: day(raw.planned_at), defer: day(raw.defer_at), in_inbox: raw.in_inbox || undefined, repeating: raw.repeat_rule ? true : undefined,
        added: day(raw.created_at), age_days: raw.created_at ? Math.floor((Date.now() - Date.parse(raw.created_at)) / 86400000) : undefined },
      decisions: 'keep | someday | done | drop | skip | reading | slipbox' };
  }
  async function stateOut(api, s, list) {
    const live = list.filter((x) => x.status !== 'void');
    const cur = live.find((x) => x.id === s.current_item);
    const after = cur ? live.filter((x) => x.status === 'pending' && x.sort > cur.sort).slice(0, 3) : [];
    const singles = after.filter((x) => x.kind === 'task');
    const titles = singles.length ? await api.q(`tasks?${api.u}&id=in.(${singles.map((x) => `"${x.task_id}"`).join(',')})&select=id,title`) : [];
    const upcoming = after.map((x) => (x.kind === 'group' ? `group: ${x.label || 'similar actions'}` : (titles.find((r) => r.id === x.task_id) || {}).title)).filter(Boolean);
    return {
      session_id: s.id, title: s.title, status: s.status, app_link: `https://todotooling.com/#full/${s.id}`,
      progress: { position: cur ? live.filter((x) => x.sort <= cur.sort).length : live.length, total: live.length, reviewed: live.filter((x) => x.status === 'reviewed').length, skipped: live.filter((x) => x.status === 'skipped').length },
      current: await cardOut(api, cur ? await itemFull(api, cur.id) : null), upcoming,
    };
  }

  return [{
    name: 'full_review',
    description: `Full Review: go through the user's actions one card at a time WITH them while they watch the same card in the app.
Default way of working: SUGGEST, the user approves. When the user tells you what to do with a card, turn it into a suggestion ("suggest": decision plus any title/gain/project/dates/flag/tags and a one-line note). It appears on the card in the app as "Suggested by Claude" with Submit / Edit / Dismiss; nothing changes until they Submit. Only use "annotate" + "decide" (which apply immediately) when the user says to just do it.
Big actions: when the user describes the parts ("cut the spot, run power, then…"), put them in the suggestion as steps (in order if they said so) rather than applying break_down; Submit adds them.
Draft ahead: call "upcoming" and "suggest" with items [...] for the next few cards from the user's patterns; these show as "drafted ahead" so the user can Submit quickly and only talk to you when they disagree. Never suggest drop/done for something the user hasn't clearly let go of; the gain should be the user's words (set gain_suggested when it's yours).
actions:
  start {import_id | project | all:true, min_age_days?, title?} → a new session (give the user app_link)
  status {session_id?} (default) → progress, the current card (with any pending suggestion), the next few titles
  suggest {decision, title?, gain?, gain_suggested?, project?, planned?|due?|defer? (YYYY-MM-DD or null), flagged?, add_tags?, remove_tags?, steps? (titles, first to last: break it down), steps_in_order?, proposal? (group), note?, item_id? (default current)} or {items: [{item_id, …}]}
  upcoming {count? ≤10} → the next cards in full, for drafting ahead
  add {title, gain?, notes?} → a new idea the user has mid-review: captured to the Inbox and added as the last card
  annotate {…same fields…} / decide {decision, note?} → apply now (only when asked to just do it)
  prioritize {task_ids} · goto {item_id | "next" | "previous"} · undo {item_id?} · list
Decisions: action cards keep|someday|done|drop|skip|reading (→ reading list, up next)|slipbox (an idea, not an action → fleeting note); group cards accept|one_by_one|keep_all|skip.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'suggest', 'upcoming', 'add', 'annotate', 'decide', 'prioritize', 'goto', 'undo', 'list'], default: 'status' },
        notes: { type: 'string', description: 'add: notes for the new idea' },
        items: { type: 'array', description: 'suggest: several cards at once, each {item_id, decision, title?, gain?, project?, planned?, due?, defer?, flagged?, add_tags?, remove_tags?, steps?, steps_in_order?, proposal?, note?}', items: { type: 'object' } },
        ahead: { type: 'boolean', description: 'suggest: drafted before talking it through (shown as “drafted ahead”)' },
        count: { type: 'integer', description: 'upcoming: how many cards (max 10)' },
        session_id: { type: 'string' },
        import_id: { type: 'string' }, project: { type: 'string', description: 'Project name or id (start: review that project; annotate: move the action there)' },
        all: { type: 'boolean' }, min_age_days: { type: 'integer' }, title: { type: 'string' },
        gain: { type: 'string' }, gain_suggested: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' }, description: 'suggest: break the action down: step titles, first to last (added on Submit)' }, steps_in_order: { type: 'boolean', description: 'suggest: only the first open step is available' },
        planned: { type: ['string', 'null'] }, due: { type: ['string', 'null'] }, defer: { type: ['string', 'null'] },
        flagged: { type: 'boolean' }, note: { type: 'string', description: 'One line: why you changed or decided it, shown on the card' },
        proposal: { type: 'object', properties: { op: { type: 'string', enum: ['someday', 'drop', 'park', 'keep_newest'] }, keep: { type: 'integer' } } },
        decision: { type: 'string', enum: ['keep', 'someday', 'done', 'drop', 'skip', 'reading', 'slipbox', 'accept', 'one_by_one', 'keep_all'] },
        task_ids: { type: 'array', items: { type: 'string' } },
        item_id: { type: 'string' },
      },
    },
    async run(api, a) {
      const action = a.action || 'status';
      if (action === 'list') {
        const rows = await api.q(`review_sessions?${api.u}&order=created_at.desc&limit=20&select=id,title,status,created_at,finished_at`);
        return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, started: localDate(r.created_at, api.tz), app_link: `https://todotooling.com/#full/${r.id}` }));
      }
      if (action === 'start') {
        const scope = a.import_id ? { import_id: a.import_id } : a.project ? { project_id: await api.resolveProject(a.project) } : a.all ? { all: true } : null;
        if (!scope) throw new Error('start needs import_id, project or all: true');
        if (a.min_age_days) scope.min_age_days = a.min_age_days;
        const [tasks, projects, tags] = await Promise.all([
          api.q(`tasks?${api.u}&${OPEN}&select=id,title,notes,project_id,parent_id,import_id,flagged,due_at,planned_at,gain,in_inbox,created_at,updated_at,completed_at,dropped_at`),
          api.q(`projects?${api.u}&select=id,name,flagged,status`), api.q(`tags?${api.u}&select=id,name,parent_id`),
        ]);
        // Only the Someday links matter here (already-parked actions aren't reviewed): one query, not thousands of rows.
        const someday = tags.filter((g) => !g.parent_id && /^someday/i.test(g.name)).map((g) => g.id);
        const taskTags = someday.length ? await api.q(`task_tags?${api.u}&tag_id=in.(${someday.map((x) => `"${x}"`).join(',')})&select=task_id,tag_id`) : [];
        const queue = buildQueue({ tasks, projects, tags, taskTags, scope });
        if (!queue.length) throw new Error('Nothing to review there: every open action is already sorted.');
        const [s] = await api.q('review_sessions', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: a.title || 'Full Review', scope, agent_seen_at: new Date().toISOString() } });
        for (let i = 0; i < queue.length; i += 500) {
          await api.q('review_items', { method: 'POST', body: queue.slice(i, i + 500).map((x) => ({ session_id: s.id, user_id: api.userId, sort: x.sort, kind: x.kind, task_id: x.task_id || null, grp: x.grp || null, priority: !!x.priority })) });
        }
        const [first] = await api.q(`review_items?${api.u}&session_id=eq.${s.id}&order=sort.asc&limit=1&select=id`);
        await api.q(`review_sessions?${api.u}&id=eq.${s.id}`, { method: 'PATCH', body: { current_item: first.id } });
        const out = await stateOut(api, { ...s, current_item: first.id }, await items(api, s.id));
        return { ...out, queue: { cards: queue.length, first_because_important: queue.filter((x) => x.priority).length, groups: queue.filter((x) => x.kind === 'group').length },
          next: 'Give the user app_link to open in the app, then work through the current card together.' };
      }
      const s = await findSession(api, a.session_id);
      if (action !== 'status') await touch(api, s.id); // any call is a check-in: the app shows Claude following along
      let list = await items(api, s.id);
      const cur = await itemFull(api, (list.find((x) => x.id === s.current_item) || {}).id);
      if (action === 'status') { await touch(api, s.id); return stateOut(api, s, list); }
      if (action === 'add') {
        // A new idea during the review: captured to the Inbox (with its gain) and added as the last card.
        if (!a.title || !String(a.title).trim()) throw new Error('title is required');
        const made = await tool('capture').run(api, { title: String(a.title).trim(), notes: a.notes || '', ...(a.gain ? { gain: a.gain, gain_suggested: !!a.gain_suggested } : {}) });
        const lastSort = list.reduce((m, x) => Math.max(m, x.sort), 0);
        const [row] = await api.q('review_items', { method: 'POST', prefer: 'return=representation', body: { session_id: s.id, user_id: api.userId, sort: Math.floor(lastSort + 1), kind: 'task', task_id: made.id, priority: false } });
        const reopen = s.status === 'done' || !s.current_item;
        await touch(api, s.id, reopen ? { current_item: row.id, status: 'active', finished_at: null } : {});
        return { added: { item_id: row.id, task_id: made.id, title: made.title }, card: list.filter((x) => x.status !== 'void').length + 1, fits: made.fits,
          next: 'It is in the Inbox and at the end of this review; carry on with the current card.' };
      }
      if (action === 'suggest') {
        // One card (item_id, default the current one) or several: items [{item_id, decision, …}].
        const wanted = Array.isArray(a.items) && a.items.length ? a.items.slice(0, 25) : [{ ...a, item_id: a.item_id || (cur && cur.id) }];
        const L = await lookups(api);
        const rows = await api.q(`review_items?${api.u}&session_id=eq.${s.id}&id=in.(${wanted.map((w) => `"${w.item_id}"`).join(',')})&select=id,kind,status`);
        const planned = wanted.map((w) => {
          const row = rows.find((r) => r.id === w.item_id);
          if (!row) throw new Error(`No card ${w.item_id} in this review.`);
          if (row.status !== 'pending') throw new Error(`Card ${w.item_id} is already decided.`);
          return { id: row.id, s: suggestionFrom(api, { ...w, ahead: w.ahead ?? (cur && w.item_id !== cur.id) }, row.kind, L) };
        });
        for (const p of planned) await api.q(`review_items?${api.u}&id=eq.${p.id}`, { method: 'PATCH', body: { suggestion: p.s } });
        await touch(api, s.id, { agent_status: '' });
        return { suggested: planned.length, items: planned.map((p) => ({ item_id: p.id, decision: p.s.decision, ahead: p.s.ahead || undefined })),
          next: 'The user sees each suggestion on its card in the app and Submits (or edits / dismisses) it there. Check status to see what they decided.' };
      }
      if (action === 'upcoming') {
        // The next few cards in one go (for drafting suggestions ahead): 4–5 queries, whatever the count.
        const n = Math.min(10, Math.max(1, a.count || 5));
        const next = list.filter((x) => x.status === 'pending' && (!cur || x.sort > cur.sort)).slice(0, n);
        if (!next.length) return { cards: [] };
        const full = await api.q(`review_items?${api.u}&id=in.(${next.map((x) => `"${x.id}"`).join(',')})&select=*`);
        const taskIds = full.filter((x) => x.kind === 'task').map((x) => x.task_id);
        const tasks = taskIds.length ? await api.q(`tasks?${api.u}&id=in.(${taskIds.map((x) => `"${x}"`).join(',')})&select=*`) : [];
        const [links, projects] = await Promise.all([
          taskIds.length ? api.q(`task_tags?${api.u}&task_id=in.(${taskIds.map((x) => `"${x}"`).join(',')})&select=task_id,tag_id`) : [],
          api.q(`projects?${api.u}&id=in.(${[...new Set(tasks.map((t) => t.project_id).filter(Boolean))].map((x) => `"${x}"`).join(',') || '"00000000-0000-0000-0000-000000000000"'})&select=id,name,flagged,purpose`),
        ]);
        const tagRows = links.length ? await api.q(`tags?${api.u}&id=in.(${[...new Set(links.map((l) => l.tag_id))].map((x) => `"${x}"`).join(',')})&select=id,name`) : [];
        const day = (iso) => (iso ? localDate(iso, api.tz) : undefined);
        const cards = next.map((x) => {
          const it = full.find((f) => f.id === x.id) || x;
          const sug = it.suggestion && !it.suggestion.applied_at ? it.suggestion : undefined;
          if (it.kind === 'group') { const g = it.grp || {}; return { item_id: it.id, kind: 'group', label: g.label, count: (g.task_ids || []).length, proposal: g.proposal || { op: 'someday' }, suggestion: sug }; }
          const t = tasks.find((r) => r.id === it.task_id);
          if (!t) return { item_id: it.id, kind: 'task', task: null };
          const p = projects.find((r) => r.id === t.project_id);
          return { item_id: it.id, kind: 'task', priority: it.priority || undefined, why_first: it.priority ? priorityReason(t, p) || undefined : undefined, suggestion: sug,
            task: { id: t.id, title: t.title, notes: t.notes ? String(t.notes).slice(0, 600) : undefined, project: p ? p.name : undefined, tags: links.filter((l) => l.task_id === t.id).map((l) => (tagRows.find((g) => g.id === l.tag_id) || {}).name).filter(Boolean),
              gain: t.gain || undefined, flagged: t.flagged || undefined, due: day(t.due_at), planned: day(t.planned_at), added: day(t.created_at) } };
        });
        await touch(api, s.id);
        return { cards, next: 'Draft suggestions for these with action "suggest" and items [{item_id, decision, …}] (marked "drafted ahead" in the app).' };
      }
      if (action === 'annotate') {
        if (!cur) throw new Error('No current card.');
        const changed = { ...(cur.changed || {}) };
        const stamp = new Date().toISOString();
        const patch = {};
        if (cur.kind === 'task') {
          const f = {};
          ['title', 'gain', 'gain_suggested', 'tags', 'add_tags', 'remove_tags', 'planned', 'due', 'defer', 'flagged'].forEach((k) => { if (a[k] !== undefined) f[k] = a[k]; });
          if (a.project !== undefined) f.project = a.project;
          if (Object.keys(f).length) {
            await touch(api, s.id, { agent_status: 'editing' });
            await tool('update_task').run(api, { id: cur.task_id, ...f });
            if (f.title !== undefined) changed.title = stamp;
            if (f.gain !== undefined) changed.gain = stamp;
            if (f.project !== undefined) changed.project = stamp;
            if (['planned', 'due', 'defer'].some((k) => f[k] !== undefined)) changed.dates = stamp;
            if (['tags', 'add_tags', 'remove_tags'].some((k) => f[k] !== undefined)) changed.tags = stamp;
            if (f.flagged !== undefined) changed.flagged = stamp;
          }
        } else if (a.proposal) {
          patch.grp = { ...(cur.grp || {}), proposal: { op: a.proposal.op || 'someday', ...(a.proposal.keep !== undefined ? { keep: a.proposal.keep } : {}) } };
          changed.proposal = stamp;
        }
        await api.q(`review_items?${api.u}&id=eq.${cur.id}`, { method: 'PATCH', body: { ...patch, changed, ...(a.note !== undefined ? { note: String(a.note).slice(0, 1000) } : {}) } });
        await touch(api, s.id, { agent_status: '' });
        list = await items(api, s.id);
        return stateOut(api, s, list);
      }
      if (action === 'decide') {
        if (!cur) throw new Error('No current card (the review is finished).');
        if (!a.decision) throw new Error('decision is required');
        await api.q('rpc/review_decide', { method: 'POST', body: { item: cur.id, decision: a.decision, by: 'agent', note: a.note ?? null, owner: api.userId } });
        const [s2] = await api.q(`review_sessions?${api.u}&id=eq.${s.id}&select=*`);
        return { decided: { item_id: cur.id, decision: a.decision }, ...(await stateOut(api, s2, await items(api, s.id))) };
      }
      if (action === 'undo') {
        const last = a.item_id ? list.find((x) => x.id === a.item_id) : list.filter((x) => x.reviewed_at).sort((x, y) => String(y.reviewed_at).localeCompare(String(x.reviewed_at)))[0];
        if (!last) throw new Error('Nothing to undo.');
        await api.q('rpc/review_undo', { method: 'POST', body: { item: last.id, owner: api.userId } });
        await touch(api, s.id);
        const [s2] = await api.q(`review_sessions?${api.u}&id=eq.${s.id}&select=*`);
        return { undone: last.id, ...(await stateOut(api, s2, await items(api, s.id))) };
      }
      if (action === 'goto') {
        const pending = list.filter((x) => x.status === 'pending');
        const target = a.item_id === 'next' ? pending.find((x) => cur && x.sort > cur.sort)
          : a.item_id === 'previous' ? [...list].reverse().find((x) => cur && x.sort < cur.sort)
          : list.find((x) => x.id === a.item_id);
        if (!target) throw new Error('No such card.');
        await touch(api, s.id, { current_item: target.id });
        return stateOut(api, { ...s, current_item: target.id }, list);
      }
      if (action === 'prioritize') {
        const ids = [...new Set(a.task_ids || [])];
        if (!ids.length) throw new Error('task_ids is required');
        const base = cur ? cur.sort : 0;
        let k = 0;
        let groups = null;
        for (const tid of ids) {
          k += 1;
          const sort = base + (k / (ids.length + 1)) * 0.5; // right after the current card
          const single = list.find((x) => x.kind === 'task' && x.task_id === tid && x.status === 'pending');
          if (single) { await api.q(`review_items?${api.u}&id=eq.${single.id}`, { method: 'PATCH', body: { sort, priority: true } }); continue; }
          if (!groups) groups = await api.q(`review_items?${api.u}&session_id=eq.${s.id}&kind=eq.group&status=eq.pending&select=id,sort,grp`);
          const grp = groups.find((x) => ((x.grp || {}).task_ids || []).includes(tid));
          if (grp) {
            grp.grp = { ...grp.grp, task_ids: grp.grp.task_ids.filter((x) => x !== tid) };
            await api.q(`review_items?${api.u}&id=eq.${grp.id}`, { method: 'PATCH', body: { grp: grp.grp } });
          }
          await api.q('review_items', { method: 'POST', body: { session_id: s.id, user_id: api.userId, sort, kind: 'task', task_id: tid, priority: true } });
        }
        await touch(api, s.id);
        return { prioritized: ids.length, ...(await stateOut(api, s, await items(api, s.id))) };
      }
      throw new Error('Unknown action');
    },
  }];
}
