// The Weekly Review, mind sweep and Someday/Maybe for agents (same steps and prompts as the app:
// js/weekly.js). An agent can walk the user through a review in conversation, step by step.
import { STEPS, STAGES, STALE_DAYS, sweepPrompts, streak } from '../../js/weekly.js';

export function weeklyTools({ OPEN, localDate, zonedToIso, tool, calendar }) {
  const isSomedayTag = (tags) => { const root = tags.find((g) => !g.parent_id && /^someday/i.test(g.name)); return root ? new Set([root.id, ...tags.filter((g) => g.parent_id === root.id).map((g) => g.id)]) : new Set(); };
  const openReview = async (api) => (await api.q(`weekly_reviews?${api.u}&completed_at=is.null&abandoned_at=is.null&select=*&limit=1`))[0] || null;
  const days = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);

  async function someday(api) {
    const [tags, links, open, onHold] = await Promise.all([
      api.q(`tags?${api.u}&select=id,name,parent_id,status`), api.q(`task_tags?${api.u}&select=task_id,tag_id,created_at`),
      api.q(`tasks?${api.u}&${OPEN}&select=*`), api.q(`projects?${api.u}&status=eq.on_hold&select=id,name,updated_at,created_at`),
    ]);
    const ids = isSomedayTag(tags);
    const root = tags.find((g) => ids.has(g.id) && !g.parent_id);
    const items = open.filter((t) => links.some((l) => l.task_id === t.id && ids.has(l.tag_id)));
    return { tags, links, ids, root, items, onHold, open };
  }

  // Everything each step needs, kept short.
  async function snapshot(api, r) {
    const now = new Date().toISOString();
    const [open, projects] = await Promise.all([api.q(`tasks?${api.u}&${OPEN}&select=*`), api.q(`projects?${api.u}&select=*`)]);
    const sd = await someday(api);
    const { isWaiting } = await api.waitingRule();
    const inbox = open.filter((t) => t.in_inbox && !t.parent_id && !(t.tickler && t.defer_at && t.defer_at > now));
    const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
    const somedayIds = new Set(sd.items.map((t) => t.id));
    const stale = open.filter((t) => !t.in_inbox && !t.waiting_on && !t.agenda_for && !t.tickler && !somedayIds.has(t.id) && (t.updated_at || t.created_at) < cutoff
      && (!t.project_id || (projects.find((p) => p.id === t.project_id) || {}).status === 'active'));
    const end = zonedToIso(localDate(now, api.tz), 24, api.tz);
    const waiting = open.filter((t) => !t.agenda_for && isWaiting(t));
    const due = projects.filter((p) => ['active', 'on_hold'].includes(p.status) && p.next_review_at && p.next_review_at <= now);
    // Stuck = active with no open action (the app also counts "nothing available").
    const stuck = projects.filter((p) => p.status === 'active' && !open.some((t) => t.project_id === p.id));
    const count = { inbox: inbox.length, stale: stale.length, waiting: waiting.length, projects: due.length + stuck.length, someday: sd.items.length + sd.onHold.length };
    const auto = { inbox: !inbox.length, stale: !stale.length, waiting: !waiting.some((t) => t.follow_up_at && t.follow_up_at < end), projects: !due.length && !stuck.length };
    const data = {
      inbox: { count: inbox.length, items: inbox.slice(0, 15).map((t) => ({ id: t.id, title: t.title })) },
      stale: { count: stale.length, items: stale.slice(0, 20).map((t) => ({ id: t.id, title: t.title, project: (projects.find((p) => p.id === t.project_id) || {}).name || null, days_untouched: days(t.updated_at || t.created_at) })), note: 'For each: keep (update_task with no change touches it), complete, move to someday (clarify_item decision someday) or drop.' },
      waiting: { count: waiting.length, follow_ups_due: waiting.filter((t) => t.follow_up_at && t.follow_up_at < end).map((t) => ({ id: t.id, title: t.title, follow_up: localDate(t.follow_up_at, api.tz) })) },
      projects: { due_for_review: due.map((p) => p.name), stuck: stuck.map((p) => p.name), note: 'Use list_review and mark_reviewed; give stuck projects a next action.' },
      someday: { count: count.someday, note: 'Use list_someday; activate_someday or drop.' },
      sweep: { note: 'Use mind_sweep_prompts and capture what the user says.' },
    };
    const steps = STEPS.map((s) => {
      const done = !!(r && r.steps && r.steps[s.key]) || !!auto[s.key];
      return { key: s.key, stage: STAGES.find(([k]) => k === s.stage)[1], title: s.title, hint: s.hint, done, nothing_to_do: !(r && r.steps && r.steps[s.key]) && !!auto[s.key] || undefined, minutes: s.minutes(count[s.key] || 0), ...(done ? {} : { data: data[s.key] }) };
    });
    return steps;
  }

  return [
    {
      name: 'weekly_review',
      description: 'The GTD Weekly Review, saved so the user can continue in the app. action: status (default; each step with what it has to go through), start, done_step (step key), finish, restart. Walk the user through the steps in order: Get clear (papers, mind sweep, inbox), Get current (past and next calendar, stale actions, waiting, projects), Get creative (someday, anything new). Steps with nothing to do are already done. Calendar steps include events.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'start', 'done_step', 'finish', 'restart'] }, step: { type: 'string', enum: STEPS.map((s) => s.key) } } },
      async run(api, { action = 'status', step }) {
        let r = await openReview(api);
        if (action === 'restart' && r) { await api.q(`weekly_reviews?${api.u}&id=eq.${r.id}`, { method: 'PATCH', body: { abandoned_at: new Date().toISOString() } }); r = null; action = 'start'; }
        if ((action === 'start' || action === 'done_step') && !r) [r] = await api.q('weekly_reviews', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId } });
        if (action === 'done_step') {
          if (!STEPS.some((s) => s.key === step)) throw new Error(`step must be one of ${STEPS.map((s) => s.key).join(', ')}`);
          const steps = { ...(r.steps || {}), [step]: { done_at: new Date().toISOString(), n: null } };
          [r] = await api.q(`weekly_reviews?${api.u}&id=eq.${r.id}`, { method: 'PATCH', prefer: 'return=representation', body: { steps } });
        }
        if (action === 'finish') {
          if (!r) throw new Error('No review in progress (action start)');
          const since = r.started_at;
          const [created, completed, reviewed] = await Promise.all([
            api.q(`tasks?${api.u}&created_at=gte.${since}&select=id`), api.q(`tasks?${api.u}&completed_at=gte.${since}&select=id`), api.q(`projects?${api.u}&last_reviewed_at=gte.${since}&select=id`),
          ]);
          const stats = { captured: created.length, completed: completed.length, projects_reviewed: reviewed.length, minutes: Math.max(1, Math.round((Date.now() - Date.parse(since)) / 60000)) };
          if (stats.minutes > 1440) delete stats.minutes;
          await api.q(`weekly_reviews?${api.u}&id=eq.${r.id}`, { method: 'PATCH', body: { completed_at: new Date().toISOString(), stats } });
          const all = await api.q(`weekly_reviews?${api.u}&completed_at=not.is.null&select=completed_at&order=completed_at.desc&limit=30`);
          return { finished: true, stats, streak_weeks: streak(all.map((x) => x.completed_at)) };
        }
        const steps = await snapshot(api, r);
        const out = { in_progress: !!r, started_at: r ? r.started_at : undefined, steps, minutes_left: steps.filter((s) => !s.done).reduce((n, s) => n + s.minutes, 0) };
        const pending = steps.filter((s) => !s.done).map((s) => s.key);
        if (pending.includes('past') || pending.includes('next')) {
          const today = localDate(new Date().toISOString(), api.tz);
          const shift = (n) => localDate(new Date(Date.now() + n * 86400000).toISOString(), api.tz);
          try {
            if (pending.includes('past')) steps.find((s) => s.key === 'past').data = { events: (await calendar(api, shift(-14), shift(-1))).events.map((e) => ({ title: e.title, day: e.days[0] })) };
            if (pending.includes('next')) steps.find((s) => s.key === 'next').data = { events: (await calendar(api, today, shift(21))).events.map((e) => ({ title: e.title, day: e.days[0], start: e.allDay ? undefined : e.start })) };
          } catch { /* calendars unavailable */ }
        }
        return out;
      },
    },
    {
      name: 'mind_sweep_prompts',
      description: 'The user\'s mind sweep trigger list (Work, then Personal; their hidden prompts left out, their own added). Go through them with the user one at a time and capture every open loop they mention (capture: it goes to the Inbox).',
      inputSchema: { type: 'object', properties: { group: { type: 'string', enum: ['Work', 'Personal'] } } },
      async run(api, { group }) {
        await api.loadSettings();
        const list = sweepPrompts(api.settings || {}).filter((p) => !group || p.group === group);
        return { count: list.length, prompts: list.map((p) => ({ group: p.group, prompt: p.text, examples: p.hint || undefined, yours: p.custom || undefined })) };
      },
    },
    {
      name: 'list_someday',
      description: 'Someday/Maybe: items parked under the Someday tag (by category, e.g. Someday : Travel) and on-hold projects, with how long each has been parked (6+ months: ask if the user still wants it).',
      inputSchema: { type: 'object', properties: {} },
      async run(api) {
        const sd = await someday(api);
        const by = {};
        sd.items.forEach((t) => {
          const l = sd.links.find((x) => x.task_id === t.id && sd.ids.has(x.tag_id));
          const tag = sd.tags.find((g) => g.id === l.tag_id);
          const k = tag && tag.parent_id ? tag.name : 'Someday';
          (by[k] = by[k] || []).push({ id: t.id, title: t.title, parked_days: days(l.created_at || t.updated_at || t.created_at) });
        });
        return { count: sd.items.length + sd.onHold.length, by_category: by, projects_on_hold: sd.onHold.map((p) => ({ id: p.id, name: p.name, on_hold_days: days(p.updated_at || p.created_at) })) };
      },
    },
    {
      name: 'activate_someday',
      description: 'Take something out of Someday/Maybe. For an item: its Someday tags come off and it becomes a next action (give project and/or tags; with neither it goes to the Inbox). For an on-hold project (pass its id or name as project_on_hold): it becomes active.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, project: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, project_on_hold: { type: 'string' } } },
      async run(api, a) {
        if (a.project_on_hold) {
          const pid = await api.resolveProject(a.project_on_hold);
          await api.q(`projects?${api.u}&id=eq.${pid}`, { method: 'PATCH', body: { status: 'active' } });
          return { project: a.project_on_hold, status: 'active' };
        }
        if (!a.id) throw new Error('Pass id (an item) or project_on_hold');
        const { tags, tagLabel } = await api.lookups();
        const ids = isSomedayTag(tags);
        const links = await api.q(`task_tags?${api.u}&task_id=eq.${a.id}&select=tag_id`);
        const keep = links.filter((l) => !ids.has(l.tag_id)).map((l) => tagLabel(tags.find((g) => g.id === l.tag_id)));
        return { item: await tool('update_task').run(api, { id: a.id, tags: [...keep, ...(a.tags || [])], ...(a.project ? { project: a.project } : {}) }) };
      },
    },
  ];
}
