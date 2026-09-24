// Checklists and Schedule it for agents (same data the app uses: checklists, checklist_runs,
// tasks.checklist_id / scheduled_at). Nothing is deleted: checklists archive, runs are kept.
const rid = () => Math.random().toString(36).slice(2, 9);

export function parseItemLines(lines, old = []) {
  let section = '';
  const out = [];
  for (const raw of lines) {
    const l = String(raw || '').trim();
    if (!l) continue;
    if (/^#+\s*/.test(l)) { section = l.replace(/^#+\s*/, '').slice(0, 100); continue; }
    const t = l.replace(/^[-*•☐☑✓]\s*/, '').slice(0, 300);
    const same = old.find((o) => o.text === t && !out.some((x) => x.id === o.id));
    out.push({ id: same ? same.id : rid(), text: t, ...(section ? { section } : {}) });
  }
  return out.slice(0, 300);
}

export function checklistTools({ localDate }) {
  const find = async (api, ref) => {
    const all = await api.q(`checklists?${api.u}&select=*`);
    const r = String(ref || '').trim().toLowerCase();
    const hit = all.find((c) => c.id === ref) || all.find((c) => !c.archived_at && c.name.toLowerCase() === r) || all.find((c) => c.name.toLowerCase() === r);
    if (!hit) throw new Error(`No checklist called “${ref}”. Use list_checklists.`);
    return hit;
  };
  const out = (c, runs = [], actions = []) => {
    const last = runs.find((r) => r.finished_at);
    return { id: c.id, name: c.name, items: c.items.length, sections: [...new Set(c.items.map((i) => i.section).filter(Boolean))], complete_action: c.complete_action,
      on_actions: actions.length ? actions.map((t) => t.title) : undefined, last_run: last ? { finished: localDate(last.finished_at, 'UTC'), ticked: last.ticked.length, of: last.total } : null, archived: !!c.archived_at || undefined };
  };
  return [
    {
      name: 'list_checklists',
      description: 'The user\'s reusable checklists (routines like a pre-job walkthrough or van restock), with when each was last run and which actions carry them.',
      inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean' } } },
      async run(api, a) {
        const [list, runs, tasks] = await Promise.all([
          api.q(`checklists?${api.u}${a.include_archived ? '' : '&archived_at=is.null'}&order=sort.asc&select=*`),
          api.q(`checklist_runs?${api.u}&order=started_at.desc&limit=300&select=*`),
          api.q(`tasks?${api.u}&checklist_id=not.is.null&completed_at=is.null&dropped_at=is.null&select=id,title,checklist_id`),
        ]);
        return { checklists: list.map((c) => out(c, runs.filter((r) => r.checklist_id === c.id), tasks.filter((t) => t.checklist_id === c.id))) };
      },
    },
    {
      name: 'save_checklist',
      description: 'Create or edit a checklist. items: lines in order ("# Section" starts a section) — replaces the list. attach_to: an action id to carry it (a repeating action keeps it; each occurrence starts fresh). complete_action: ticking the last item completes that action (default true). archived: true archives it.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Checklist id or name, to edit' }, name: { type: 'string' }, items: { type: 'array', items: { type: 'string' } }, complete_action: { type: 'boolean' }, attach_to: { type: ['string', 'null'] }, archived: { type: 'boolean' } } },
      async run(api, a) {
        const body = {};
        if (a.name !== undefined) body.name = String(a.name).trim();
        if (a.complete_action !== undefined) body.complete_action = !!a.complete_action;
        if (a.archived !== undefined) body.archived_at = a.archived ? new Date().toISOString() : null;
        let c = a.id ? await find(api, a.id) : null;
        if (Array.isArray(a.items)) body.items = parseItemLines(a.items, c ? c.items : []);
        if (c) [c] = Object.keys(body).length ? await api.q(`checklists?${api.u}&id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=representation', body }) : [c];
        else {
          if (!body.name) throw new Error('name is required');
          [c] = await api.q('checklists', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, items: [], ...body } });
        }
        if (a.attach_to !== undefined) {
          if (a.attach_to === null) await api.q(`tasks?${api.u}&checklist_id=eq.${c.id}`, { method: 'PATCH', body: { checklist_id: null } });
          else { const t = await api.task(a.attach_to); await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { checklist_id: c.id } }); }
        }
        return out(c);
      },
    },
    {
      name: 'run_checklist',
      description: 'Go through a checklist with the user: returns the items with what is ticked in the current run. tick / untick: item texts (or 1-based numbers). task: the action it is on (runs are per action). finish: end this run now. When every item is ticked the run finishes, and if the checklist completes its action, the action is completed.',
      inputSchema: { type: 'object', properties: { checklist: { type: 'string' }, task: { type: 'string' }, tick: { type: 'array', items: { type: ['string', 'integer'] } }, untick: { type: 'array', items: { type: ['string', 'integer'] } }, finish: { type: 'boolean' } }, required: ['checklist'] },
      async run(api, a) {
        const c = await find(api, a.checklist);
        const task = a.task ? await api.task(a.task) : null;
        const taskFilter = task ? `task_id=eq.${task.id}` : 'task_id=is.null';
        let [r] = await api.q(`checklist_runs?${api.u}&checklist_id=eq.${c.id}&${taskFilter}&finished_at=is.null&select=*`);
        const pick = (refs) => (refs || []).map((x) => (typeof x === 'number' || /^\d+$/.test(String(x)) ? c.items[Number(x) - 1] : c.items.find((i) => i.text.toLowerCase() === String(x).toLowerCase()) || c.items.find((i) => i.text.toLowerCase().includes(String(x).toLowerCase())))).filter(Boolean).map((i) => i.id);
        const tick = pick(a.tick); const untick = pick(a.untick);
        let completed = false;
        if (tick.length || untick.length || a.finish) {
          if (!r) [r] = await api.q('checklist_runs', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, checklist_id: c.id, task_id: task ? task.id : null, total: c.items.length, ticked: [] } });
          const set = new Set(r.ticked || []);
          tick.forEach((id) => set.add(id)); untick.forEach((id) => set.delete(id));
          const ticked = c.items.map((i) => i.id).filter((id) => set.has(id));
          const all = ticked.length === c.items.length && c.items.length > 0;
          [r] = await api.q(`checklist_runs?${api.u}&id=eq.${r.id}`, { method: 'PATCH', prefer: 'return=representation', body: { ticked, total: c.items.length, ...(all || a.finish ? { finished_at: new Date().toISOString() } : {}) } });
          if (all && task && c.complete_action && !task.completed_at && !task.dropped_at) {
            await api.q(`tasks?${api.u}&id=eq.${task.id}`, { method: 'PATCH', body: { completed_at: new Date().toISOString() } });
            completed = true;
          }
        }
        const on = new Set(r ? r.ticked || [] : []);
        return { checklist: c.name, task: task ? task.title : undefined, items: c.items.map((i, n) => ({ n: n + 1, text: i.text, section: i.section || undefined, done: on.has(i.id) })),
          ticked: on.size, of: c.items.length, finished: !!(r && r.finished_at) || undefined, action_completed: completed || undefined };
      },
    },
  ];
}
