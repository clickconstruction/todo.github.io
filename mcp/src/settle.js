// Settle in for agents: sort what an import brought, in bulk, each choice with an Undo. Same grouping as
// the app (js/settle.js) and the same database functions (settle_apply / settle_undo); only rows of that
// import are ever touched, and nothing is deleted.
import { STEPS, BIG_PROJECT, settleData, spreadReviews } from '../../js/settle.js';

const CHOICES = ['old_to_someday', 'keep_newest', 'park_project', 'project_status', 'plan_overdue', 'clear_overdue', 'unflag_except', 'spread_reviews', 'retire_unused_tags', 'someday', 'complete', 'drop', 'unflag', 'clear_due', 'plan', 'mark_step_done'];

export function settleTools({ OPEN, zonedToIso, localDate }) {
  const findImport = async (api, id) => {
    const rows = await api.q(`imports?${api.u}&undone_at=is.null&order=created_at.desc&limit=20&select=*`);
    const hit = id ? rows.find((r) => r.id === id) : rows.find((r) => (r.counts.tasks || 0) + (r.counts.projects || 0) > 0);
    if (!hit) throw new Error(id ? 'No such import (or it was undone).' : 'No imports yet.');
    return hit;
  };
  const load = async (api, imp) => {
    const [tasks, projects, folders, tags, taskTags, projectTags] = await Promise.all([
      api.q(`tasks?${api.u}&${OPEN}&select=*`),
      api.q(`projects?${api.u}&select=*`),
      api.q(`folders?${api.u}&select=id,name`),
      api.q(`tags?${api.u}&select=*`),
      api.q(`task_tags?${api.u}&select=task_id,tag_id`),
      api.q(`project_tags?${api.u}&select=project_id,tag_id`),
    ]);
    return { tasks, projects, folders, tags, taskTags, projectTags, d: settleData({ importId: imp.id, tasks, projects, tags, taskTags, projectTags }) };
  };
  const apply = async (api, imp, op, args) => api.q('rpc/settle_apply', { method: 'POST', body: { batch: imp.id, op, args, owner: api.userId } });

  return [{
    name: 'settle_import',
    description: `Settle in after an OmniFocus import: sort what came over, biggest levers first, mostly in bulk. Every choice returns an op_id that undo takes back; only that import's rows are touched and nothing is deleted (Someday = the on-hold Someday tag: out of lists, kept).
action "status" (default): the checklist (${STEPS.map((s) => s[0]).join(', ')}) with counts: old undated actions by age (4+, 2–4, 1–2 years), projects with ${BIG_PROJECT}+ open actions, projects to decide, overdue, flagged, reviews due, unused tags, inexact repeats, and live vs total actions. Show it, recommend, and ask before applying.
action "apply" with choice:
  old_to_someday {bucket: "4y"|"2y"|"1y"} · keep_newest {project, keep=20} (the rest of that project → Someday) · park_project {project} (on hold) · project_status {projects:[ids], status: active|on_hold|completed|dropped} · plan_overdue (planned today, due cleared) · clear_overdue · unflag_except {keep:[ids]} · spread_reviews (over 4 weeks) · retire_unused_tags · someday|complete|drop|unflag|clear_due {ids} · plan {ids, date} · mark_step_done {step}.
action "undo" with op_id.`,
    inputSchema: {
      type: 'object',
      properties: {
        import_id: { type: 'string', description: 'Default: the latest import' },
        action: { type: 'string', enum: ['status', 'apply', 'undo'], default: 'status' },
        choice: { type: 'string', enum: CHOICES },
        bucket: { type: 'string', enum: ['4y', '2y', '1y'] },
        project: { type: 'string', description: 'Project id' },
        projects: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['active', 'on_hold', 'completed', 'dropped'] },
        keep: { description: 'keep_newest: how many to keep (default 20); unflag_except: ids to keep flagged' },
        ids: { type: 'array', items: { type: 'string' } },
        date: { type: 'string', description: 'plan: YYYY-MM-DD (planned-time default) or ISO' },
        step: { type: 'string', enum: STEPS.map((s) => s[0]) },
        op_id: { type: 'string' },
      },
    },
    async run(api, a) {
      const imp = await findImport(api, a.import_id);
      const action = a.action || 'status';
      if (action === 'undo') {
        if (!a.op_id) throw new Error('op_id is required');
        return api.q('rpc/settle_undo', { method: 'POST', body: { op_id: a.op_id, owner: api.userId } });
      }
      const { tasks, projects, folders, d } = await load(api, imp);
      const title = (id) => (tasks.find((t) => t.id === id) || {}).title;
      const pname = (id) => (projects.find((p) => p.id === id) || {}).name;
      if (action === 'status') {
        const steps = (imp.settle && imp.settle.steps) || {};
        return {
          import_id: imp.id, imported: localDate(imp.created_at, api.tz), total_open: d.total, live: d.live,
          steps: STEPS.map(([key, label]) => ({ key, label, done: !!steps[key] })),
          inbox: d.inbox.length,
          old: d.old.map((b) => ({ bucket: b.key, label: b.label, count: b.ids.length, mostly_in: b.top })),
          big_projects: d.big.map((b) => ({ id: b.id, name: b.name, open: b.open, last_touched: b.last ? localDate(new Date(b.last).toISOString(), api.tz) : null })),
          projects_to_decide: d.projects.slice(0, 300).map((id) => { const p = projects.find((x) => x.id === id); return { id, name: p.name, status: p.status, folder: (folders.find((f) => f.id === p.folder_id) || {}).name || null, open: tasks.filter((t) => t.project_id === id).length }; }),
          overdue: { count: d.overdue.length, sample: d.overdue.slice(0, 20).map((id) => ({ id, title: title(id) })) },
          flagged: d.flagged.slice(0, 100).map((id) => ({ id, title: title(id) })),
          reviews_due: d.reviewsDue.length, unused_tags: d.unusedTags.length,
          inexact_repeats: d.inexact.map((id) => ({ id, title: title(id) })),
          next: 'Recommend the biggest levers first (old buckets, big projects), ask, then apply. Each result has an op_id for undo.',
        };
      }
      if (action !== 'apply' || !a.choice) throw new Error('action "apply" needs a choice');
      const c = a.choice;
      const done = (r, what) => ({ ...r, did: what, undo: `settle_import action "undo" op_id "${r.op_id}"` });
      if (c === 'mark_step_done') {
        if (!a.step) throw new Error('step is required');
        const settle = { steps: {}, kept: [], ...(imp.settle || {}) };
        settle.steps = { ...settle.steps, [a.step]: { done_at: new Date().toISOString(), n: null } };
        await api.q(`imports?${api.u}&id=eq.${imp.id}`, { method: 'PATCH', body: { settle } });
        return { step: a.step, done: true };
      }
      if (c === 'old_to_someday') {
        const b = d.old.find((x) => x.key === a.bucket);
        if (!b) throw new Error('bucket must be 4y, 2y or 1y');
        const kept = new Set((imp.settle && imp.settle.kept) || []);
        return done(await apply(api, imp, 'someday', { ids: b.ids.filter((x) => !kept.has(x)) }), `${b.label} → Someday`);
      }
      if (c === 'keep_newest') {
        const b = d.big.find((x) => x.id === a.project);
        if (!b) throw new Error(`Not one of the big projects (${BIG_PROJECT}+ open actions) of this import`);
        const n = Math.max(0, Number(a.keep ?? 20) || 0);
        return done(await apply(api, imp, 'someday', { ids: b.newest.slice(n) }), `${b.name}: kept the ${n} newest`);
      }
      if (c === 'park_project') return done(await apply(api, imp, 'project_status', { ids: [a.project], status: 'on_hold' }), `${pname(a.project)} on hold`);
      if (c === 'project_status') {
        if (!a.status) throw new Error('status is required');
        return done(await apply(api, imp, 'project_status', { ids: a.projects || [], status: a.status }), `projects → ${a.status}`);
      }
      const today = zonedToIso(localDate(new Date().toISOString(), api.tz), api.hours.planned, api.tz);
      if (c === 'plan_overdue') return done(await apply(api, imp, 'plan', { ids: d.overdue, at: today }), 'overdue → planned today');
      if (c === 'clear_overdue') return done(await apply(api, imp, 'clear_due', { ids: d.overdue }), 'overdue dates cleared');
      if (c === 'unflag_except') {
        const keep = new Set(Array.isArray(a.keep) ? a.keep : []);
        return done(await apply(api, imp, 'unflag', { ids: d.flagged.filter((x) => !keep.has(x)) }), `unflagged (kept ${keep.size})`);
      }
      if (c === 'spread_reviews') return done(await apply(api, imp, 'review_dates', { items: spreadReviews(d.reviewsDue) }), 'reviews spread over 4 weeks');
      if (c === 'retire_unused_tags') return done(await apply(api, imp, 'drop_tags', { ids: d.unusedTags }), 'unused tags retired');
      if (['someday', 'complete', 'drop', 'unflag', 'clear_due'].includes(c)) return done(await apply(api, imp, c, { ids: a.ids || [] }), c);
      if (c === 'plan') {
        if (!a.date) throw new Error('date is required');
        return done(await apply(api, imp, 'plan', { ids: a.ids || [], at: zonedToIso(a.date, api.hours.planned, api.tz) }), `planned ${a.date}`);
      }
      throw new Error('Unknown choice');
    },
  }];
}
