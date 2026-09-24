// What do I gain? for agents: find actions and projects with no stated gain, draft gains the user then
// keeps or edits (marked "Claude suggested", never over the user's own words), suggest where an idea
// belongs from its gain, and report whether completed work paid off (gain_met).
import { placeFor } from '../../js/gain.js';

export function gainsTools({ OPEN, localDate }) {
  const lookups = async (api) => {
    const [projects, goals, areas] = await Promise.all([
      api.q(`projects?${api.u}&status=eq.active&select=id,name,status,purpose,purpose_by,outcome,goal_id,area_id`),
      api.q(`goals?${api.u}&status=eq.active&select=id,title,why,status`),
      api.q(`areas?${api.u}&archived_at=is.null&select=id,name,standards,archived_at`),
    ]);
    return { projects, goals, areas };
  };
  return [{
    name: 'gains',
    description: `"What do I gain?" — the user's reason each action or project is worth doing (a project's gain is its purpose). It is asked at capture and used to place ideas and weed out weak ones.
action "missing" (default): open actions and active projects with no stated gain, most important first (flagged, due soon, in active projects).
action "suggest" with items [{id, kind: "task"|"project", gain}]: save your drafts, marked "Claude suggested" until the user keeps or edits them. Only fills empty gains (or replaces your own earlier suggestions); never overwrites the user's words. Draft from the title, notes, project and goal; keep it one plain sentence about the benefit to the user.
action "place" with id: projects the item's gain (and title) point to.
action "report" (days, default 90): after completing, did the user get the gain (yes / partly / no), with examples — evidence for what kinds of work pay off.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['missing', 'suggest', 'place', 'report'], default: 'missing' },
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['task', 'project'] }, gain: { type: 'string' } }, required: ['id', 'gain'] } },
        id: { type: 'string' },
        limit: { type: 'integer', default: 30 },
        days: { type: 'integer', default: 90 },
      },
    },
    async run(api, a) {
      const action = a.action || 'missing';
      if (action === 'missing') {
        const [tasks, { projects }] = await Promise.all([api.q(`tasks?${api.u}&${OPEN}&select=id,title,gain,project_id,parent_id,flagged,due_at,planned_at,in_inbox,created_at`), lookups(api)]);
        const parents = new Set(tasks.map((t) => t.parent_id).filter(Boolean));
        const live = new Set(projects.map((p) => p.id));
        const score = (t) => (t.flagged ? 100 : 0) + (t.due_at ? 50 : 0) + (t.planned_at ? 30 : 0) + (live.has(t.project_id) ? 20 : 0) + (t.in_inbox ? 10 : 0);
        const list = tasks.filter((t) => !t.gain && !parents.has(t.id)).sort((x, y) => score(y) - score(x) || String(y.created_at || '').localeCompare(String(x.created_at || '')));
        const limit = Math.min(200, a.limit || 30);
        const pname = (id) => (projects.find((p) => p.id === id) || {}).name;
        return {
          actions_without_gain: list.length,
          projects_without_gain: projects.filter((p) => !p.purpose).length,
          projects: projects.filter((p) => !p.purpose).slice(0, limit).map((p) => ({ id: p.id, name: p.name, outcome: p.outcome || undefined })),
          actions: list.slice(0, limit).map((t) => ({ id: t.id, title: t.title, project: pname(t.project_id), flagged: t.flagged || undefined, due: localDate(t.due_at, api.tz) || undefined, inbox: t.in_inbox || undefined })),
          next: 'Ask the user what they gain, or draft suggestions with action "suggest" for them to keep or edit.',
        };
      }
      if (action === 'suggest') {
        const items = Array.isArray(a.items) ? a.items.slice(0, 200) : [];
        if (!items.length) throw new Error('items is required');
        const saved = []; const skipped = [];
        for (const it of items) {
          const project = it.kind === 'project';
          const [row] = await api.q(`${project ? 'projects' : 'tasks'}?${api.u}&id=eq.${encodeURIComponent(it.id)}&select=id,${project ? 'name,purpose,purpose_by' : 'title,gain,gain_by'}`);
          if (!row) { skipped.push({ id: it.id, why: 'not found' }); continue; }
          const current = project ? row.purpose : row.gain; const by = project ? row.purpose_by : row.gain_by;
          if (current && by !== 'agent') { skipped.push({ id: it.id, why: 'the user already wrote one' }); continue; }
          const text = String(it.gain || '').trim().slice(0, 500);
          if (!text) { skipped.push({ id: it.id, why: 'empty' }); continue; }
          await api.q(`${project ? 'projects' : 'tasks'}?${api.u}&id=eq.${row.id}`, { method: 'PATCH', body: project ? { purpose: text, purpose_by: 'agent' } : { gain: text, gain_by: 'agent' } });
          saved.push({ id: row.id, name: row.name || row.title, gain: text });
        }
        return { saved: saved.length, skipped, items: saved, next: 'They show as "Claude suggested" in the app until the user keeps or edits them.' };
      }
      if (action === 'place') {
        if (!a.id) throw new Error('id is required');
        const t = await api.task(a.id);
        const fits = placeFor(t, await lookups(api), { limit: 3, exclude: t.project_id });
        return { id: t.id, title: t.title, gain: t.gain || null, fits: fits.map((f) => ({ project: f.project.name, project_id: f.project.id, via: f.via === 'project' ? undefined : `${f.via}: ${f.viaName}`, matched: f.word })) };
      }
      if (action === 'report') {
        const since = new Date(Date.now() - Math.min(3650, a.days || 90) * 86400000).toISOString();
        const done = await api.q(`tasks?${api.u}&completed_at=gte.${since}&select=id,title,gain,gain_met,completed_at,project_id`);
        const withGain = done.filter((t) => t.gain);
        const count = (v) => withGain.filter((t) => t.gain_met === v).length;
        return {
          since: localDate(since, api.tz), completed: done.length, completed_with_gain: withGain.length,
          got_it: { yes: count('yes'), partly: count('partly'), no: count('no'), not_answered: withGain.filter((t) => !t.gain_met).length },
          examples: withGain.filter((t) => t.gain_met).slice(-20).map((t) => ({ title: t.title, gain: t.gain, got_it: t.gain_met, completed: localDate(t.completed_at, api.tz) })),
        };
      }
      throw new Error('Unknown action');
    },
  }];
}
