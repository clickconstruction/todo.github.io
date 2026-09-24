// Daily review for agents: a morning briefing (calendar, must-dos, today's focus with suggestions) and
// an evening wrap-up (focus done or not, carry the rest over, tomorrow at a glance). Same rows the app
// uses (daily_reviews); up to 3 focus items, each planned for today.
import { rankNow } from '../../js/whatnow.js';

export function dailyTools({ OPEN, localDate, zonedToIso, availableTasks, calendar }) {
  return [{
    name: 'daily_review',
    description: 'The daily review. action: briefing (default; morning: today\'s calendar, due/overdue, follow-ups due, tickler, Inbox count, today\'s focus and suggestions), focus (set up to 3 task ids for today; they are planned today), start (mark the day started), wrapup (evening: focus done or not, tomorrow\'s calendar and due items), carry (move unfinished focus: [{id, to: tomorrow|next_week|drop}]), shutdown (mark the day closed). Keep it short and conversational.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['briefing', 'focus', 'start', 'wrapup', 'carry', 'shutdown'] }, ids: { type: 'array', items: { type: 'string' } }, carry: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, to: { type: 'string', enum: ['tomorrow', 'next_week', 'drop'] } }, required: ['id', 'to'] } } } },
    async run(api, a) {
      const action = a.action || 'briefing';
      const now = new Date();
      const today = localDate(now.toISOString(), api.tz);
      const plus = (n) => localDate(new Date(now.getTime() + n * 86400000).toISOString(), api.tz);
      const endToday = zonedToIso(today, 24, api.tz);
      const row = async () => (await api.q(`daily_reviews?${api.u}&day=eq.${today}&select=*`))[0] || null;
      const ensure = async () => (await row()) || (await api.q('daily_reviews', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, day: today } }))[0];
      const patch = async (fields) => { const r = await ensure(); return (await api.q(`daily_reviews?${api.u}&id=eq.${r.id}`, { method: 'PATCH', prefer: 'return=representation', body: fields }))[0]; };
      const at9 = (day) => zonedToIso(day, api.hours.planned, api.tz);
      if (action === 'focus') {
        const ids = [...new Set(a.ids || [])].slice(0, 3);
        for (const id of ids) { const t = await api.task(id); if (!t.planned_at || t.planned_at >= endToday || t.planned_at < zonedToIso(today, 0, api.tz)) await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { planned_at: at9(today) } }); }
        await patch({ focus: ids });
      }
      if (action === 'start') await patch({ started_at: now.toISOString() });
      if (action === 'shutdown') await patch({ shutdown_at: now.toISOString() });
      if (action === 'carry') {
        for (const c of a.carry || []) {
          const t = await api.task(c.id);
          const body = c.to === 'drop' ? { dropped_at: now.toISOString() } : { planned_at: at9(c.to === 'tomorrow' ? plus(1) : plus(7)), scheduled_at: null, scheduled_minutes: null };
          await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body });
        }
      }
      const r = await row();
      const focusIds = r ? r.focus : [];
      const focus = focusIds.length ? await api.shape(await api.q(`tasks?${api.u}&id=in.(${focusIds.map((x) => `"${x}"`).join(',')})&select=*`)) : [];
      const events = async (day) => { try { return (await calendar(api, day, day)).events.map((e) => ({ title: e.title, start: e.allDay ? undefined : e.start, all_day: e.allDay || undefined })); } catch { return []; } };
      if (['wrapup', 'carry', 'shutdown'].includes(action)) {
        const dueTmr = await api.q(`tasks?${api.u}&${OPEN}&due_at=gte.${endToday}&due_at=lt.${zonedToIso(plus(1), 24, api.tz)}&select=*`);
        return { day: today, focus: focus.map((t) => ({ id: t.id, title: t.title, done: t.status === 'completed', status: t.status })), done: focus.filter((t) => t.status === 'completed').length,
          tomorrow: { day: plus(1), calendar: await events(plus(1)), due: await api.shape(dueTmr) }, shut_down: !!(r && r.shutdown_at) };
      }
      const [open, { tasks: avail, projects }, goals] = await Promise.all([
        api.q(`tasks?${api.u}&${OPEN}&select=*`), availableTasks(api), api.q(`goals?${api.u}&status=eq.active&select=id,title,status`),
      ]);
      const { isWaiting } = await api.waitingRule();
      const nowIso = now.toISOString();
      const due = open.filter((t) => t.due_at && t.due_at < endToday && !isWaiting(t));
      const follow = open.filter((t) => t.waiting_on && t.follow_up_at && t.follow_up_at < endToday);
      const tickler = open.filter((t) => t.tickler && t.in_inbox && (!t.defer_at || t.defer_at <= nowIso));
      const inbox = open.filter((t) => t.in_inbox && !t.parent_id && !(t.tickler && t.defer_at && t.defer_at > nowIso)).length;
      const sugg = rankNow(avail.filter((t) => !focusIds.includes(t.id)), { tz: api.tz, endOfToday: new Date(endToday), projects, goals, limit: 5 }).items;
      const shapedS = new Map((await api.shape(sugg.map((x) => x.t))).map((x) => [x.id, x]));
      return {
        day: today, started: !!(r && r.started_at),
        calendar: await events(today),
        scheduled: (await api.shape(open.filter((t) => t.scheduled_at && localDate(t.scheduled_at, api.tz) === today))).map((t) => ({ id: t.id, title: t.title, at: t.scheduled.at, minutes: t.scheduled.minutes })),
        must_dos: { due: await api.shape(due), follow_ups: await api.shape(follow), from_tickler: await api.shape(tickler), inbox_count: inbox },
        focus: focus.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        suggestions: sugg.map(({ t, reasons, gain }) => ({ ...shapedS.get(t.id), why: reasons.map((x) => x.text), ...(gain ? { gain } : {}) })),
        note: 'Up to 3 focus items (action focus with ids).',
      };
    },
  }];
}
