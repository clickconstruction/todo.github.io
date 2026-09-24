// Plan it for agents: the Natural Planning Model on a project (same plan the app edits; created by
// the database's apply_project_plan, undone by undo_project_plan).
export function planTools({ projectOut }) {
  const uid = () => Math.random().toString(36).slice(2, 9);
  const BUCKETS = ['action', 'someday', 'reference', 'drop'];
  return [{
    name: 'plan_project',
    description: 'Plan a project with the Natural Planning Model, in conversation: ask why (purpose, principles), what done looks like (outcome), brainstorm everything, organize ideas (action, a group of steps, someday, reference, drop), and pick each next action. action: get (default), save (sets what you pass; ideas replace the list), create (builds it all: groups become action groups with steps, someday is parked, reference is filed), undo (drops what create made). Show the user the preview before create.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id' },
        action: { type: 'string', enum: ['get', 'save', 'create', 'undo'] },
        purpose: { type: 'string' }, principles: { type: 'array', items: { type: 'string' } }, outcome: { type: 'string' },
        ideas: { type: 'array', description: 'Replaces the brainstorm. Each: {text, where?: "action" (default) | "someday" | "reference" | "drop" | a group name, next?: true for the next action of its group or the project}', items: { type: 'object', properties: { text: { type: 'string' }, where: { type: 'string' }, next: { type: 'boolean' } }, required: ['text'] } },
        groups: { type: 'array', description: 'Groups (become action groups). Each: {name, in_order?}', items: { type: 'object', properties: { name: { type: 'string' }, in_order: { type: 'boolean' } }, required: ['name'] } },
      },
      required: ['project'],
    },
    async run(api, a) {
      const id = await api.resolveProject(a.project);
      const load = async () => (await api.q(`projects?${api.u}&id=eq.${id}&select=*`))[0];
      let p = await load();
      const action = a.action || 'get';
      if (action === 'save') {
        const body = {};
        if (a.purpose !== undefined) body.purpose = String(a.purpose).trim();
        if (a.outcome !== undefined) body.outcome = String(a.outcome).trim();
        if (Array.isArray(a.principles)) body.principles = a.principles.map((x) => String(x).trim()).filter(Boolean).join('\n');
        if (Array.isArray(a.ideas) || Array.isArray(a.groups)) {
          const old = p.plan || {};
          if (old.applied) throw new Error('This plan was already created. Use action undo first, or plan in a new project.');
          const groups = Array.isArray(a.groups) ? a.groups.map((g) => ({ id: uid(), name: String(g.name).trim(), in_order: !!g.in_order })) : (old.groups || []);
          const next = {};
          const ideas = (Array.isArray(a.ideas) ? a.ideas : (old.ideas || []).map((i) => ({ text: i.text, bucket: i.bucket }))).map((x) => {
            const i = { id: uid(), text: String(x.text).trim(), bucket: x.bucket ?? null };
            if (x.where !== undefined) {
              const w = String(x.where).trim();
              const g = groups.find((y) => y.name.toLowerCase() === w.toLowerCase());
              if (g) i.bucket = `g:${g.id}`;
              else if (BUCKETS.includes(w.toLowerCase())) i.bucket = w.toLowerCase();
              else throw new Error(`"${w}" isn't a group or one of ${BUCKETS.join(', ')}`);
            }
            if (x.next) next[i.bucket && i.bucket.startsWith('g:') ? i.bucket.slice(2) : 'project'] = i.id;
            return i;
          }).filter((i) => i.text);
          body.plan = { mode: old.mode || 'full', step: old.step || 0, ideas, groups, next };
        }
        if (Object.keys(body).length) [p] = await api.q(`projects?${api.u}&id=eq.${id}`, { method: 'PATCH', prefer: 'return=representation', body });
      }
      if (action === 'create') {
        const res = await api.q('rpc/apply_project_plan', { method: 'POST', body: { project: id, owner: api.userId } });
        p = await load();
        return { created: { actions: res.tasks, reference_items: res.references }, project: projectOut(api, p), note: 'Undo with action undo.' };
      }
      if (action === 'undo') {
        const res = await api.q('rpc/undo_project_plan', { method: 'POST', body: { project: id, owner: api.userId } });
        return { undone: res };
      }
      const pl = p.plan || {};
      const groups = pl.groups || [];
      const where = (i) => (i.bucket && i.bucket.startsWith('g:') ? (groups.find((g) => `g:${g.id}` === i.bucket) || {}).name : i.bucket || 'action');
      const ideas = (pl.ideas || []).map((i) => ({ text: i.text, where: where(i), next: (pl.next || {})[i.bucket && i.bucket.startsWith('g:') ? i.bucket.slice(2) : 'project'] === i.id || undefined }));
      const count = (w) => ideas.filter((i) => i.where === w).length;
      return {
        project: p.name, purpose: p.purpose || null, principles: String(p.principles || '').split('\n').filter(Boolean), outcome: p.outcome || null,
        ideas, groups: groups.map((g) => ({ name: g.name, in_order: g.in_order || undefined })),
        preview: pl.applied ? undefined : { groups: groups.filter((g) => count(g.name)).length, actions: ideas.filter((i) => !['someday', 'reference', 'drop'].includes(i.where)).length, someday: count('someday'), reference: count('reference') },
        created: pl.applied ? { at: pl.applied.at, actions: (pl.applied.task_ids || []).length } : undefined,
      };
    },
  }];
}
