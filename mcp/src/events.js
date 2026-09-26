// Events for agents: the user's own calendar entries (an airshow, a trip, an appointment), the same
// rows Forecast shows and the private calendar feed sends to their phone. Not actions.
// Dates are the user's local time: "YYYY-MM-DD" makes an all-day event (end = its last day,
// inclusive); "YYYY-MM-DDTHH:MM" a timed one. Stored as the app stores them: all-day from local
// midnight of the first day to local midnight after the last day (exclusive). Archived, never deleted.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const AT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const nextDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
// An instant as "YYYY-MM-DDTHH:MM" on the user's clock.
const localAt = (iso, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

export function eventsTools({ localDate, zonedToIso, OPEN }) {
  // The local days an event covers, first to last.
  const daysOf = (e, tz) => {
    const last = localDate(new Date(Math.max(Date.parse(e.starts_at), Date.parse(e.ends_at) - 1)).toISOString(), tz);
    const out = [];
    for (let d = localDate(e.starts_at, tz), i = 0; d <= last && i < 62; i++, d = nextDay(d)) out.push(d);
    return out;
  };
  // What the agent sees: local dates for all-day events, local times for timed ones.
  const shape = (e, tz, projectName = () => null, cardOf = () => null) => {
    const days = daysOf(e, tz);
    const card = cardOf(e.task_id);
    return {
      id: e.id, title: e.title, all_day: e.all_day,
      start: e.all_day ? days[0] : localAt(e.starts_at, tz), end: e.all_day ? days[days.length - 1] : localAt(e.ends_at, tz),
      days: days.length > 1 ? days : undefined,
      location: e.location || undefined, project: projectName(e.project_id) || undefined, card: card ? { id: card.id, title: card.title } : undefined, url: e.url || undefined, notes: e.notes || undefined,
      archived: e.archived_at ? true : undefined,
    };
  };
  // start / end / all_day from the arguments (falling back to the row being edited) → the stored columns.
  function when(a, tz, current = null) {
    let { start, end } = a;
    const allDay = a.all_day !== undefined ? !!a.all_day : current ? current.all_day : DAY.test(String(start || ''));
    if (current) {
      const cur = shape(current, tz);
      if (start === undefined) start = allDay === current.all_day ? cur.start : allDay ? cur.start.slice(0, 10) : `${cur.start}T09:00`;
      if (end === undefined && (a.start === undefined || allDay === current.all_day)) end = allDay === current.all_day ? cur.end : allDay ? cur.end.slice(0, 10) : undefined;
    }
    if (!start) throw new Error('start is required');
    if (allDay) {
      const s = String(start).slice(0, 10); const e = end ? String(end).slice(0, 10) : s;
      if (!DAY.test(s) || !DAY.test(e)) throw new Error('Dates are YYYY-MM-DD');
      if (e < s) throw new Error('end is before start');
      return { all_day: true, starts_at: zonedToIso(s, 0, tz), ends_at: zonedToIso(nextDay(e), 0, tz) };
    }
    const toIso = (v, label) => { const m = AT.exec(String(v)); if (!m) throw new Error(`${label} is YYYY-MM-DDTHH:MM (the user's local time), or YYYY-MM-DD for all day`); return zonedToIso(m[1], +m[2] + (+m[3]) / 60, tz); };
    const starts_at = toIso(start, 'start');
    const ends_at = end ? toIso(end, 'end') : new Date(Date.parse(starts_at) + 3600000).toISOString();
    if (ends_at < starts_at) throw new Error('end is before start');
    return { all_day: false, starts_at, ends_at };
  }
  const str = (v, max) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));

  return [{
    name: 'events',
    description: `The user's own calendar events (an airshow, a trip, an appointment): shown in Forecast on every day they cover and sent to their phone through their calendar feed. Not actions: nothing to tick off (a time block on an action is update_task schedule).
actions: list {from?, to?} (local dates; default today to 60 days out) · add {title, start, end?, all_day?, location?, notes?, url?, project?, task?} or add {items: [{…}, …]} for several in one call · update {id, …the same fields} · remove {id} (archived, never deleted) · restore {id}.
Dates are the user's local time: "YYYY-MM-DD" makes an all-day event (end = its last day, inclusive; omitted = one day); "YYYY-MM-DDTHH:MM" a timed one (end defaults to an hour later).`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'restore'], default: 'list' },
      id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day: { type: 'boolean' },
      location: { type: 'string' }, notes: { type: 'string' }, url: { type: 'string' }, project: { type: ['string', 'null'], description: 'Project name or id; null clears it' },
      task: { type: ['string', 'null'], description: 'The card (action) this event comes from: id or exact title of an open task; null unlinks. Shown as a "from" link in the app.' },
      items: { type: 'array', description: 'add: several events at once', items: { type: 'object', properties: {
        title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, url: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' } }, required: ['title', 'start'] } },
    } },
    async run(api, a) {
      const action = a.action || 'list';
      const tz = api.tz;
      const projects = await api.q(`projects?${api.u}&select=id,name,status`);
      const projectName = (id) => (projects.find((p) => p.id === id) || {}).name || null;
      const projectId = (v) => {
        if (v === null || v === '') return null;
        const r = String(v).trim().toLowerCase();
        const p = projects.find((x) => x.id === v) || projects.find((x) => x.name.toLowerCase() === r && x.status !== 'dropped');
        if (!p) throw new Error(`No project called "${v}". Create it first (create_project) or leave project out.`);
        return p.id;
      };
      // The card an event comes from: an open task by id or exact title (one read, shared by the call).
      const taskId = async (v) => {
        if (v === null || v === '') return null;
        const open = await api.q(`tasks?${api.u}&${OPEN}&select=*`);
        const r = String(v).trim().toLowerCase();
        const t = open.find((x) => x.id === v) || open.find((x) => x.title.trim().toLowerCase() === r);
        if (!t) throw new Error(`No open card called "${v}". Pass its id or exact title, or leave task out.`);
        return t.id;
      };
      // Titles for the cards a list of events point at (open or done), in one read.
      const cardsFor = async (rows) => {
        const ids = [...new Set(rows.map((e) => e.task_id).filter(Boolean))];
        const cards = ids.length ? await api.q(`tasks?${api.u}&id=in.(${ids.map((i) => `"${i}"`).join(',')})&select=id,title`) : [];
        return (id) => cards.find((c) => c.id === id) || null;
      };
      const fields = (x, current = null) => {
        const out = {};
        if (x.title !== undefined || !current) { const t = str(x.title, 200); if (!t) throw new Error('title is required'); out.title = t; }
        if (x.start !== undefined || x.end !== undefined || x.all_day !== undefined || !current) Object.assign(out, when(x, tz, current));
        if (x.location !== undefined) out.location = str(x.location, 500) || '';
        if (x.notes !== undefined) out.notes = String(x.notes || '').slice(0, 6000);
        if (x.url !== undefined) { const u = str(x.url, 2000) || ''; if (u && !/^https?:\/\//i.test(u)) throw new Error('url must start with http:// or https://'); out.url = u; }
        if (x.project !== undefined) out.project_id = projectId(x.project);
        return out;
      };
      const withTask = async (x, out) => { if (x.task !== undefined) out.task_id = await taskId(x.task); return out; };
      const get = async (id) => {
        if (!id) throw new Error('id is required');
        const [e] = await api.q(`events?${api.u}&id=eq.${encodeURIComponent(id)}&select=*`);
        if (!e) throw new Error('Event not found');
        return e;
      };
      if (action === 'add') {
        const list = Array.isArray(a.items) && a.items.length ? a.items : [a];
        if (list.length > 100) throw new Error('Add up to 100 events in one call');
        // Every row is checked before anything is saved, and every row carries the same keys (a bulk insert requires it).
        const rows = [];
        for (const x of list) rows.push(await withTask(x, { user_id: api.userId, source: 'mcp', location: '', notes: '', url: '', project_id: null, task_id: null, ...fields(x) }));
        const saved = await api.q('events', { method: 'POST', prefer: 'return=representation', body: rows });
        const cardOf = await cardsFor(saved);
        const out = saved.map((e) => shape(e, tz, projectName, cardOf));
        return Array.isArray(a.items) && a.items.length ? { added: out.length, events: out } : out[0];
      }
      if (action === 'update') {
        const cur = await get(a.id);
        const patch = await withTask(a, fields(a, cur));
        if (!Object.keys(patch).length) throw new Error('Nothing to change');
        const [e] = await api.q(`events?${api.u}&id=eq.${encodeURIComponent(cur.id)}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
        return shape(e, tz, projectName, await cardsFor([e]));
      }
      if (action === 'remove' || action === 'restore') {
        const cur = await get(a.id);
        const [e] = await api.q(`events?${api.u}&id=eq.${encodeURIComponent(cur.id)}`, { method: 'PATCH', prefer: 'return=representation', body: { archived_at: action === 'remove' ? new Date().toISOString() : null } });
        return { ...shape(e, tz, projectName, await cardsFor([e])), next: action === 'remove' ? 'Removed (archived). events restore with this id brings it back.' : 'Back on the calendar.' };
      }
      // list
      const today = localDate(new Date().toISOString(), tz);
      const from = a.from && DAY.test(a.from) ? a.from : today;
      const to = a.to && DAY.test(a.to) ? a.to : localDate(new Date(Date.parse(zonedToIso(from, 12, tz)) + 60 * 86400000).toISOString(), tz);
      if (to < from) throw new Error('to is before from');
      const fromIso = zonedToIso(from, 0, tz); const toIso = zonedToIso(nextDay(to), 0, tz);
      const rows = await api.q(`events?${api.u}&archived_at=is.null&starts_at=lt.${encodeURIComponent(toIso)}&ends_at=gt.${encodeURIComponent(fromIso)}&order=starts_at.asc&limit=500&select=*`);
      rows.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
      const cardOf = await cardsFor(rows);
      return { from, to, events: rows.map((e) => shape(e, tz, projectName, cardOf)) };
    },
  }];
}

// For the calendar feed and forecast: the local days an event covers, first to last.
export { nextDay };
