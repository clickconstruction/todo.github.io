// Dailies for agents: actions done every day as a checkbox that starts fresh each day, in two tiers
// (rules in js/daily-rules.js, the same ones the app uses; the database guards them, migration 20261101000001).
import { onDay, week, summary, describeDaily, readDaily, back, tierLabel } from '../../js/daily-rules.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The user's open daily actions with their ticks (two requests, whatever the library size).
export async function dailiesFor(api, today) {
  const [tasks, ticks] = await Promise.all([
    api.q(`tasks?${api.u}&completed_at=is.null&dropped_at=is.null&daily=not.is.null&select=*`),
    api.q(`daily_ticks?${api.u}&state=eq.done&day=gte.${back(today, 62)}&select=task_id,day`),
  ]);
  const done = new Set(ticks.map((x) => `${x.task_id}:${x.day}`));
  return { tasks: tasks.sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || (a.created_at < b.created_at ? -1 : 1)), ticked: (t) => (key) => done.has(`${t.id}:${key}`) };
}
// Have-to dailies asked for today and not ticked yet (the Daily review's must-dos).
export async function mustLeft(api, today) {
  const { tasks, ticked } = await dailiesFor(api, today);
  return tasks.filter((t) => t.daily.tier === 'must' && onDay(t.daily, today) && !ticked(t)(today));
}
export const dailyOut = (t, ticked, today) => ({
  id: t.id, title: t.title, daily: describeDaily(t.daily), ticked: ticked(today), asked_today: onDay(t.daily, today) || undefined,
  week: week(t.daily, ticked, today).map((d) => `${d.key.slice(5)} ${d.state}`), summary: summary(t.daily, ticked, today) || undefined, since: t.daily.since,
});

export function dailiesTools({ localDate }) {
  return [{
    name: 'dailies',
    description: `Daily checkboxes: actions the user does every day (or on chosen weekdays). Each day starts fresh: a tick records that day only, a missed day is recorded and never carried forward, and the action itself stays open. Two tiers:
must = "${tierLabel('must')}" (medication, logging hours): a missed day shows, and it is one of the Daily review's must-dos. should = "${tierLabel('should')}" (a walk, reading): a missed day is just an empty dot; never nag about these.
actions: list {day?} (today's, by tier, each with its week and a summary) · tick {id or title, day?} · untick {id or title, day?} · set {id, tier: must|should, weekdays?: [0-6, 0 = Sunday]} (makes an action daily, or changes its tier or days; its repeat and dates are cleared) · clear {id} (an ordinary action again).
Use this instead of a repeating action with a due date when the user describes a habit or a daily obligation. Ask which tier when it isn't plain from what they said. day is YYYY-MM-DD in their time zone (default today); a day that hasn't come can't be ticked.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'tick', 'untick', 'set', 'clear'], default: 'list' },
      id: { type: 'string' }, title: { type: 'string', description: 'tick/untick: the daily action\'s exact title, instead of id' },
      day: { type: 'string', description: 'YYYY-MM-DD (default today)' },
      tier: { type: 'string', enum: ['must', 'should'] }, weekdays: { type: 'array', items: { type: 'integer' }, description: 'set: only on these days (0 = Sunday); leave out for every day' },
    } },
    async run(api, a) {
      const action = a.action || 'list';
      const today = localDate(new Date().toISOString(), api.tz);
      const day = a.day === undefined ? today : String(a.day);
      if (!DAY.test(day)) throw new Error('day is a date like 2026-10-07');

      if (action === 'set' || action === 'clear') {
        if (!a.id) throw new Error('id is required');
        const t = await api.task(a.id);
        if (t.completed_at || t.dropped_at) throw new Error('That action is closed.');
        const daily = action === 'clear' ? null : { ...readDaily({ tier: a.tier || (t.daily && t.daily.tier), weekdays: a.weekdays !== undefined ? a.weekdays : t.daily && t.daily.weekdays }), ...(t.daily && t.daily.since ? { since: t.daily.since } : {}) };
        const [row] = await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', prefer: 'return=representation', body: { daily } });
        if (!row.daily) return { id: row.id, title: row.title, daily: null, next: 'An ordinary action again. Its ticks are kept.' };
        const { ticked } = await dailiesFor(api, today);
        return { ...dailyOut(row, ticked(row), today), next: t.daily ? undefined : 'Now a daily checkbox in Today. Its repeat and dates were cleared.' };
      }

      const { tasks, ticked } = await dailiesFor(api, today);
      if (action === 'tick' || action === 'untick') {
        const key = String(a.title || '').trim().toLowerCase();
        const hits = a.id ? tasks.filter((t) => t.id === a.id) : tasks.filter((t) => t.title.trim().toLowerCase() === key);
        if (!a.id && !key) throw new Error('id or title is required');
        if (hits.length !== 1) throw new Error(hits.length ? `More than one daily action is called "${a.title}". Pass its id.` : 'No daily action like that. dailies list shows them; dailies set makes an action daily.');
        const t = hits[0];
        if (day > today) throw new Error('That day hasn’t come yet.');
        const [cur] = await api.q(`daily_ticks?${api.u}&task_id=eq.${t.id}&day=eq.${day}&select=id,state`);
        const state = action === 'tick' ? 'done' : 'cleared';
        if (cur) { if (cur.state !== state) await api.q(`daily_ticks?${api.u}&id=eq.${cur.id}`, { method: 'PATCH', body: { state } }); }
        else if (action === 'tick') await api.q('daily_ticks', { method: 'POST', body: { user_id: api.userId, task_id: t.id, day } });
        const after = (k) => (k === day ? action === 'tick' : ticked(t)(k));
        return { ...dailyOut(t, after, today), day };
      }

      const asked = tasks.filter((t) => onDay(t.daily, day));
      const out = (tier) => asked.filter((t) => (t.daily.tier === 'must') === (tier === 'must')).map((t) => ({ ...dailyOut(t, ticked(t), day), asked_today: undefined }));
      const must = out('must'); const should = out('should');
      return { day, have_to: must, should, left: { have_to: must.filter((x) => !x.ticked).length, should: should.filter((x) => !x.ticked).length },
        other_days: tasks.length - asked.length || undefined };
    },
  }];
}
