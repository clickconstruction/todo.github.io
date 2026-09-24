// Horizons of Focus and "What now?" for agents (same rules as the app: js/whatnow.js).
import { rankNow, areaBalance, isDueForReview } from '../../js/whatnow.js';

export function horizonsTools({ OPEN, localDate, zonedToIso, availableTasks, calendar }) {
  const findBy = (list, ref, key) => { const r = String(ref || '').trim().toLowerCase(); return list.find((x) => x.id === ref) || list.find((x) => String(x[key]).toLowerCase() === r); };

  return [
    {
      name: 'list_horizons',
      description: 'The Horizons of Focus: purpose and principles, vision, active goals (with progress over the projects that serve them), areas of focus (with standards and a balance check: nothing active, no next actions), and projects without an outcome. Use for monthly/yearly reviews and "am I working on the right things?".',
      inputSchema: { type: 'object', properties: { include_text: { type: 'boolean', description: 'Include the full purpose and vision text' } } },
      async run(api, { include_text = false }) {
        const [areas, goals, projects, open] = await Promise.all([
          api.q(`areas?${api.u}&archived_at=is.null&order=sort.asc&select=*`), api.q(`goals?${api.u}&order=sort.asc&select=*`),
          api.q(`projects?${api.u}&select=id,name,status,area_id,goal_id,outcome`), api.q(`tasks?${api.u}&${OPEN}&select=id,project_id,completed_at,dropped_at`),
        ]);
        const s = api.settings || {};
        const text = (v) => (include_text ? v || '' : String(v || '').split('\n')[0].slice(0, 200));
        return {
          purpose: { text: text(s.purpose) || null, last_read: localDate(s.purpose_read_at, api.tz) },
          vision: { year: s.vision_year || null, text: text(s.vision) || null, last_read: localDate(s.vision_read_at, api.tz) },
          goals: goals.filter((g) => g.status === 'active').map((g) => {
            const ps = projects.filter((p) => p.goal_id === g.id && p.status !== 'dropped');
            return { id: g.id, title: g.title, why: g.why || undefined, target: g.target_date, area: (areas.find((a) => a.id === g.area_id) || {}).name || null, projects: ps.map((p) => p.name), done: ps.filter((p) => p.status === 'completed').length, review_due: isDueForReview(g) || undefined };
          }),
          goals_ended: goals.filter((g) => g.status !== 'active').map((g) => ({ id: g.id, title: g.title, status: g.status })),
          areas: areas.map((a) => {
            const b = areaBalance(a, { projects, tasks: open });
            return { id: a.id, name: a.name, standards: a.standards || undefined, active_projects: projects.filter((p) => p.area_id === a.id && p.status === 'active').map((p) => p.name), warnings: b.warnings.length ? b.warnings : undefined, review_due: isDueForReview(a) || undefined };
          }),
          projects_without_outcome: projects.filter((p) => p.status === 'active' && !String(p.outcome || '').trim()).map((p) => p.name),
          projects_without_area: areas.length ? projects.filter((p) => p.status === 'active' && !p.area_id).map((p) => p.name) : undefined,
        };
      },
    },
    {
      name: 'save_area',
      description: 'Add or edit an area of focus (an ongoing responsibility: Health, Family, a business). standards = what good looks like. reviewed: true marks it reviewed now. archived: true archives it (never deleted). projects: names or ids of projects to put in this area.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Area id or name, to edit' }, name: { type: 'string' }, standards: { type: 'string' }, review_every_days: { type: 'integer' }, reviewed: { type: 'boolean' }, archived: { type: 'boolean' }, projects: { type: 'array', items: { type: 'string' } } } },
      async run(api, a) {
        const body = {};
        if (a.name !== undefined) body.name = String(a.name).trim();
        if (a.standards !== undefined) body.standards = String(a.standards);
        if (a.review_every_days !== undefined) body.review_every_days = Math.min(366, Math.max(1, Math.round(Number(a.review_every_days))));
        if (a.reviewed) body.last_reviewed_at = new Date().toISOString();
        if (a.archived !== undefined) body.archived_at = a.archived ? new Date().toISOString() : null;
        let row;
        if (a.id) {
          const hit = findBy(await api.q(`areas?${api.u}&select=*`), a.id, 'name');
          if (!hit) throw new Error(`No area "${a.id}"`);
          [row] = Object.keys(body).length ? await api.q(`areas?${api.u}&id=eq.${hit.id}`, { method: 'PATCH', prefer: 'return=representation', body }) : [hit];
        } else {
          if (!body.name) throw new Error('name is required');
          [row] = await api.q('areas', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, ...body } });
        }
        for (const ref of a.projects || []) await api.q(`projects?${api.u}&id=eq.${await api.resolveProject(ref)}`, { method: 'PATCH', body: { area_id: row.id } });
        return { id: row.id, name: row.name, standards: row.standards || undefined, review_every_days: row.review_every_days, last_reviewed: localDate(row.last_reviewed_at, api.tz), archived: !!row.archived_at || undefined, projects_added: (a.projects || []).length || undefined };
      },
    },
    {
      name: 'save_goal',
      description: 'Add or edit a goal (1-2 years). target: YYYY-MM-DD. status: active, achieved or dropped (never deleted). projects: names or ids of projects that serve it (their actions rank higher in what_now). reviewed: true marks it reviewed now.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Goal id or title, to edit' }, title: { type: 'string' }, why: { type: 'string' }, target: { type: ['string', 'null'] }, area: { type: ['string', 'null'] }, status: { type: 'string', enum: ['active', 'achieved', 'dropped'] }, reviewed: { type: 'boolean' }, projects: { type: 'array', items: { type: 'string' } } } },
      async run(api, a) {
        const body = {};
        if (a.title !== undefined) body.title = String(a.title).trim();
        if (a.why !== undefined) body.why = String(a.why);
        if (a.target !== undefined) { if (a.target !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.target)) throw new Error('target must be YYYY-MM-DD'); body.target_date = a.target; }
        if (a.status !== undefined) body.status = a.status;
        if (a.reviewed) body.last_reviewed_at = new Date().toISOString();
        if (a.area !== undefined) {
          if (a.area === null) body.area_id = null;
          else { const hit = findBy(await api.q(`areas?${api.u}&select=id,name`), a.area, 'name'); if (!hit) throw new Error(`No area "${a.area}". Use save_area first.`); body.area_id = hit.id; }
        }
        let row;
        if (a.id) {
          const hit = findBy(await api.q(`goals?${api.u}&select=*`), a.id, 'title');
          if (!hit) throw new Error(`No goal "${a.id}"`);
          [row] = Object.keys(body).length ? await api.q(`goals?${api.u}&id=eq.${hit.id}`, { method: 'PATCH', prefer: 'return=representation', body }) : [hit];
        } else {
          if (!body.title) throw new Error('title is required');
          [row] = await api.q('goals', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, ...body } });
        }
        for (const ref of a.projects || []) await api.q(`projects?${api.u}&id=eq.${await api.resolveProject(ref)}`, { method: 'PATCH', body: { goal_id: row.id } });
        return { id: row.id, title: row.title, status: row.status, target: row.target_date, why: row.why || undefined, projects_linked: (a.projects || []).length || undefined };
      },
    },
    {
      name: 'save_horizon',
      description: 'Write the user\'s purpose and principles or their vision (3-5 years), in their words. read: true records that they read it today.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['purpose', 'vision'] }, text: { type: 'string' }, year: { type: 'integer', description: 'vision: the year it looks ahead to' }, read: { type: 'boolean' } }, required: ['kind'] },
      async run(api, a) {
        const body = {};
        if (a.text !== undefined) body[a.kind] = String(a.text);
        if (a.kind === 'vision' && a.year !== undefined) body.vision_year = a.year;
        if (a.read) body[`${a.kind}_read_at`] = new Date().toISOString();
        if (!Object.keys(body).length) throw new Error('Pass text, year or read');
        const had = (await api.q(`user_settings?${api.u}&select=user_id`)).length;
        if (had) await api.q(`user_settings?${api.u}`, { method: 'PATCH', body });
        else await api.q('user_settings', { method: 'POST', body: { user_id: api.userId, ...body } });
        return { saved: Object.keys(body) };
      },
    },
    {
      name: 'what_now',
      description: 'What should the user do now? GTD\'s four criteria: where they are (a context tag like "Phone", or anywhere), minutes available, energy (low/medium/high), then priority: due today or overdue, flagged, planned today, serves an active goal, oldest. Returns the best few available actions with reasons. If minutes is omitted, uses the gap before their next calendar event today.',
      inputSchema: { type: 'object', properties: { where: { type: 'string', description: 'A context tag (it includes its sub-tags), or "anywhere"' }, minutes: { type: 'integer', description: '0 = any length' }, energy: { type: 'string', enum: ['low', 'medium', 'high'] }, limit: { type: 'integer', default: 5 } } },
      async run(api, a) {
        const { tasks, tags, links, projectLinks, projects } = await availableTasks(api);
        let inContext = () => true;
        if (a.where && a.where.toLowerCase() !== 'anywhere') {
          const { tagLabel } = await api.lookups();
          const g = tags.find((x) => x.id === a.where || tagLabel(x).toLowerCase() === a.where.toLowerCase() || x.name.toLowerCase() === a.where.toLowerCase());
          if (!g) throw new Error(`No tag "${a.where}"`);
          const ids = new Set([g.id, ...tags.filter((x) => x.parent_id === g.id).map((x) => x.id)]);
          inContext = (t) => links.some((l) => l.task_id === t.id && ids.has(l.tag_id)) || projectLinks.some((l) => l.project_id === t.project_id && ids.has(l.tag_id));
        }
        let minutes = a.minutes;
        let gap = null;
        if (minutes === undefined) {
          try {
            const today = localDate(new Date().toISOString(), api.tz);
            const next = (await calendar(api, today, today)).events.filter((e) => !e.allDay && Date.parse(e.start) > Date.now()).sort((x, y) => x.start.localeCompare(y.start))[0];
            if (next) { const m = Math.floor((Date.parse(next.start) - Date.now()) / 60000); if (m <= 240) { gap = { minutes: m, before: next.title }; minutes = m; } }
          } catch { /* no calendars */ }
        }
        const goals = await api.q(`goals?${api.u}&status=eq.active&select=id,title,status`);
        const end = new Date(zonedToIso(localDate(new Date().toISOString(), api.tz), 24, api.tz));
        const r = rankNow(tasks, { tz: api.tz, endOfToday: end, minutes: minutes || 0, energy: a.energy || '', inContext, projects, goals, limit: Math.min(20, a.limit || 5) });
        const shaped = new Map((await api.shape(r.items.map((x) => x.t))).map((x) => [x.id, x]));
        return { where: a.where || 'anywhere', minutes: minutes || null, time_from_calendar: gap || undefined, energy: a.energy || null, fits: r.total,
          items: r.items.map(({ t, reasons }) => ({ ...shaped.get(t.id), why: reasons.map((x) => x.text) })) };
      },
    },
  ];
}
