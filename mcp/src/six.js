// Six (the Ivy Lee list) for agents: up to six cards for a day, in order; the first open one is Now.
// The same rows as the app and the Daily review (daily_reviews.focus). Carry-over is the database's
// six_carry / six_uncarry, as in the app (js/views/six.js).
import { rankNow } from '../../js/whatnow.js';

const SIX = 6;
export function sixTools({ localDate, zonedToIso, availableTasks }) {
  return [{
    name: 'six',
    description: 'Six, the Ivy Lee list: up to six cards for a day, in order. The first open one is "now"; finished ones stay in place. action: status (default; day today|tomorrow: the list with ranks, gains and what is done, plus suggestions: overdue and due, flagged, what What now? would pick next) · add (ids, day: to the end, planned for that day) · remove (id, day) · move (id, day, to: top|bottom|up|down or a position 1–6) · tomorrow (id: from today\'s list to the end of tomorrow\'s) · today (id: from tomorrow\'s to today\'s) · carry (what was left of the day before comes to the top of today, once a day; the app does this when today is first opened) · undo_carry. Finishing one is complete_task; a dropped one stays in its place as dropped, not done. Six is the limit on each day.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'add', 'remove', 'move', 'tomorrow', 'today', 'carry', 'undo_carry'], default: 'status' },
      day: { type: 'string', enum: ['today', 'tomorrow'], default: 'today' },
      ids: { type: 'array', items: { type: 'string' } }, id: { type: 'string' },
      to: { type: 'string', description: 'move: top, bottom, up, down or a position 1–6' },
    } },
    async run(api, a) {
      const action = a.action || 'status';
      const now = new Date();
      const today = localDate(now.toISOString(), api.tz);
      const tomorrow = localDate(new Date(now.getTime() + 86400000).toISOString(), api.tz);
      const dayKey = (d) => (d === 'tomorrow' ? tomorrow : today);
      const which = a.day === 'tomorrow' ? 'tomorrow' : 'today';
      const key = dayKey(which);
      const row = async (day) => (await api.q(`daily_reviews?${api.u}&day=eq.${day}&select=*`))[0] || null;
      const ensure = async (day) => (await row(day)) || (await api.q('daily_reviews', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, day } }))[0];
      const listOf = (r) => (r && Array.isArray(r.focus) ? r.focus : []);
      const setList = async (day, focus) => {
        if (focus.length > SIX) throw new Error('Six is the limit.');
        const r = await ensure(day);
        return (await api.q(`daily_reviews?${api.u}&id=eq.${r.id}`, { method: 'PATCH', prefer: 'return=representation', body: { focus } }))[0];
      };
      const dayStart = (day) => zonedToIso(day, 0, api.tz);
      const dayEnd = (day) => zonedToIso(day, 24, api.tz);
      // On a day's list means planned for that day.
      const planFor = async (t, day) => { if (!t.planned_at || t.planned_at < dayStart(day) || t.planned_at >= dayEnd(day)) await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: { planned_at: zonedToIso(day, api.hours.planned, api.tz) } }); };
      const move = (arr, from, to) => { const x = [...arr]; const [v] = x.splice(from, 1); x.splice(to, 0, v); return x; };
      const dayName = (d) => (d === today ? 'today' : 'tomorrow');

      if (action === 'add') {
        const ids = [...new Set(a.ids || (a.id ? [a.id] : []))];
        if (!ids.length) throw new Error('Pass ids to add.');
        const list = listOf(await row(key));
        const fresh = ids.filter((x) => !list.includes(x));
        if (list.length + fresh.length > SIX) throw new Error(`Six is the limit: ${which} has ${list.length} and ${fresh.length} more would make ${list.length + fresh.length}. Finish one, send one to the other day, or remove one.`);
        for (const id of fresh) { const t = await api.task(id); if (t.completed_at || t.dropped_at) throw new Error(`"${t.title}" is not open.`); await planFor(t, key); }
        await setList(key, [...list, ...fresh]);
      }
      if (action === 'remove') {
        const list = listOf(await row(key));
        if (!a.id || !list.includes(a.id)) throw new Error(`Not on ${which}'s list.`);
        await setList(key, list.filter((x) => x !== a.id));
      }
      if (action === 'move') {
        const list = listOf(await row(key));
        const i = list.indexOf(a.id);
        if (i < 0) throw new Error(`Not on ${which}'s list.`);
        const to = String(a.to || '').toLowerCase();
        const j = to === 'top' ? 0 : to === 'bottom' ? list.length - 1 : to === 'up' ? Math.max(0, i - 1) : to === 'down' ? Math.min(list.length - 1, i + 1) : /^[1-6]$/.test(to) ? Math.min(list.length - 1, Number(to) - 1) : -1;
        if (j < 0) throw new Error('to is top, bottom, up, down or a position 1–6.');
        await setList(key, move(list, i, j));
      }
      if (action === 'tomorrow' || action === 'today') {
        const from = action === 'tomorrow' ? today : tomorrow;
        const to = action === 'tomorrow' ? tomorrow : today;
        const src = listOf(await row(from));
        if (!a.id || !src.includes(a.id)) throw new Error(`Not on ${dayName(from)}'s list.`);
        const dst = listOf(await row(to));
        if (dst.length >= SIX) throw new Error(`${action === 'tomorrow' ? 'Tomorrow' : 'Today'} already has six.`);
        const t = await api.task(a.id);
        await setList(from, src.filter((x) => x !== a.id));
        await setList(to, [...dst, a.id]);
        await planFor(t, to);
      }
      if (action === 'carry') {
        const r = await api.q('rpc/six_carry', { method: 'POST', body: { p_day: today, owner: api.userId } });
        for (const id of (r && r.carried) || []) { try { await planFor(await api.task(id), today); } catch { /* a card that is gone stays as it is */ } }
      }
      if (action === 'undo_carry') await api.q('rpc/six_uncarry', { method: 'POST', body: { p_day: today, owner: api.userId } });

      // The day asked for; after a move between days, the day it landed on; carrying is always today.
      const outKey = action === 'tomorrow' ? tomorrow : action === 'today' || action === 'carry' || action === 'undo_carry' ? today : key;
      const r = await row(outKey);
      const list = listOf(r);
      const tasks = list.length ? await api.q(`tasks?${api.u}&id=in.(${list.map((x) => `"${x}"`).join(',')})&select=*`) : [];
      const have = new Map(tasks.map((t) => [t.id, t]));
      const items = list.map((id) => have.get(id)).filter(Boolean);
      const shaped = new Map((await api.shape(items)).map((t) => [t.id, t]));
      const open = items.filter((t) => !t.completed_at && !t.dropped_at);
      const nowT = outKey === today ? open[0] : null;
      const carried = new Set((r && r.carried) || []);
      const [{ tasks: avail, projects }, goals] = await Promise.all([availableTasks(api), api.q(`goals?${api.u}&status=eq.active&select=id,title,status`)]);
      const listed = new Set(list);
      const pool = avail.filter((t) => !listed.has(t.id) && !t.in_inbox && !t.daily);
      const end = dayEnd(outKey);
      const due = pool.filter((t) => t.due_at && t.due_at < end).sort((x, y) => x.due_at.localeCompare(y.due_at));
      const dueIds = new Set(due.map((t) => t.id));
      const flagged = pool.filter((t) => t.flagged && !dueIds.has(t.id));
      const flagIds = new Set(flagged.map((t) => t.id));
      const next = rankNow(pool.filter((t) => !dueIds.has(t.id) && !flagIds.has(t.id)), { tz: api.tz, endOfToday: new Date(end), projects, goals, limit: 5 }).items;
      const brief = (t) => ({ id: t.id, title: t.title, project: (projects.find((p) => p.id === t.project_id) || {}).name, due: t.due_at || undefined, flagged: t.flagged || undefined });
      const free = SIX - items.length;
      return {
        day: outKey, which: dayName(outKey), count: items.length, limit: SIX,
        carried_over: carried.size ? [...carried] : undefined,
        now: nowT ? nowT.id : undefined,
        items: items.map((t, i) => ({ rank: i + 1, ...shaped.get(t.id), now: t === nowT || undefined, carried_over: carried.has(t.id) || undefined, done: !!t.completed_at, dropped: (!!t.dropped_at && !t.completed_at) || undefined })), // dropped isn't done
        suggestions: free > 0 ? { due: due.slice(0, 8).map(brief), flagged: flagged.slice(0, 8).map(brief), next: next.map(({ t, reasons }) => ({ ...brief(t), why: reasons.map((x) => x.text) })) } : undefined,
        note: free > 0 ? `${free} place${free === 1 ? '' : 's'} free. Adding plans the card for that day.` : 'Six is the limit. Finish one, send one to the other day, or remove one before adding.',
      };
    },
  }];
}
