// Dailies for agents: actions done every day as a checkbox that starts fresh each day, in two tiers
// (rules in js/daily-rules.js, the same ones the app uses; the database guards them, migration 20261101000001).
import { onDay, week, summary, describeDaily, readDaily, back, tierLabel, isWeekly, weeklyTickDay, lastTicked } from '../../js/daily-rules.js';

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

// Weekly checks (daily.every = 'week'): ticked means ticked since the open Weekly Review started (today if none is open).
export async function reviewSince(api, today, localDate) {
  const [r] = await api.q(`weekly_reviews?${api.u}&completed_at=is.null&abandoned_at=is.null&select=started_at&limit=1`);
  const day = r ? localDate(r.started_at, api.tz) : today;
  return day < today ? day : today;
}
export const weeklyOut = (t, ticked, since, today) => ({
  id: t.id, title: t.title, daily: describeDaily(t.daily), ticked: !!weeklyTickDay(ticked, since, today), last_ticked: lastTicked(ticked, today) || undefined, since: t.daily.since,
});

export function dailiesTools({ localDate }) {
  return [{
    name: 'dailies',
    description: `Daily checkboxes: actions the user does every day (or on chosen weekdays). Each day starts fresh: a tick records that day only, a missed day is recorded and never carried forward, and the action itself stays open. Two tiers:
must = "${tierLabel('must')}" (medication, logging hours): a missed day shows, and it is one of the Daily review's must-dos. should = "${tierLabel('should')}" (a walk, reading): a missed day is just an empty dot; never nag about these.
Weekly checks: a question or routine for once a week ("Am I reviewing?", "Did I send everyone their items?") is set with every: "week". It is never in Today: it is one of the Weekly Review's "Weekly checks" (weekly_review, step checks), each review starts it fresh, and ticked means ticked since the open review started. list returns them under weekly.
actions: list {day?} (today's, by tier, each with its week and a summary; plus weekly) · tick {id or title, day?} · untick {id or title, day?} · set {id, tier: must|should, weekdays?: [0-6, 0 = Sunday]} or set {id, every: "week"} (makes an action daily or a weekly check, or changes it; its repeat and dates are cleared) · clear {id} (an ordinary action again).
Use this instead of a repeating action with a due date when the user describes a habit, a daily obligation or a weekly check. Ask which tier when it isn't plain from what they said. day is YYYY-MM-DD in their time zone (default today); a day that hasn't come can't be ticked.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'tick', 'untick', 'set', 'clear'], default: 'list' },
      id: { type: 'string' }, title: { type: 'string', description: 'tick/untick: the daily action\'s exact title, instead of id' },
      day: { type: 'string', description: 'YYYY-MM-DD (default today)' },
      every: { type: 'string', enum: ['day', 'week'], description: 'set: "week" makes it a weekly check (ticked once per Weekly Review); "day" makes a weekly check daily again' },
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
        if (a.every !== undefined && !['day', 'week'].includes(a.every)) throw new Error('every is "day" or "week"');
        // Weekly when asked for, or when it already is and nothing about days was passed.
        const weekly = a.every === 'week' || (a.every === undefined && a.tier === undefined && a.weekdays === undefined && isWeekly(t.daily));
        const daily = action === 'clear' ? null : { ...readDaily(weekly ? { every: 'week' } : { tier: a.tier || (t.daily && t.daily.tier), weekdays: a.weekdays !== undefined ? a.weekdays : t.daily && t.daily.weekdays }), ...(t.daily && t.daily.since ? { since: t.daily.since } : {}) };
        const [row] = await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', prefer: 'return=representation', body: { daily } });
        if (!row.daily) return { id: row.id, title: row.title, daily: null, next: 'An ordinary action again. Its ticks are kept.' };
        const { ticked } = await dailiesFor(api, today);
        if (isWeekly(row.daily)) return { ...weeklyOut(row, ticked(row), await reviewSince(api, today, localDate), today), next: isWeekly(t.daily) ? undefined : 'Now a weekly check: it is in the Weekly Review under Weekly checks, not in Today. Its repeat and dates were cleared.' };
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
        if (isWeekly(t.daily)) {
          const since = await reviewSince(api, today, localDate);
          if (action === 'untick') { // every tick since the review started (usually one, maybe from an earlier day)
            const rows = await api.q(`daily_ticks?${api.u}&task_id=eq.${t.id}&state=eq.done&day=gte.${since}&select=id`);
            if (rows.length) await api.q(`daily_ticks?${api.u}&id=in.(${rows.map((x) => `"${x.id}"`).join(',')})`, { method: 'PATCH', body: { state: 'cleared' } });
            return { ...weeklyOut(t, () => false, since, today), last_ticked: lastTicked((k) => k < since && ticked(t)(k), today) || undefined };
          }
          const [was] = await api.q(`daily_ticks?${api.u}&task_id=eq.${t.id}&day=eq.${day}&select=id,state`);
          if (was) { if (was.state !== 'done') await api.q(`daily_ticks?${api.u}&id=eq.${was.id}`, { method: 'PATCH', body: { state: 'done' } }); }
          else await api.q('daily_ticks', { method: 'POST', body: { user_id: api.userId, task_id: t.id, day } });
          return { ...weeklyOut(t, (k) => k === day || ticked(t)(k), since, today), next: 'Ticked for this Weekly Review. The next review starts it fresh.' };
        }
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
      const weeklies = tasks.filter((t) => isWeekly(t.daily));
      const since = weeklies.length ? await reviewSince(api, today, localDate) : today;
      const weekly = weeklies.map((t) => weeklyOut(t, ticked(t), since, today));
      return { day, have_to: must, should, left: { have_to: must.filter((x) => !x.ticked).length, should: should.filter((x) => !x.ticked).length, weekly: weekly.length ? weekly.filter((x) => !x.ticked).length : undefined },
        weekly: weekly.length ? weekly : undefined, weekly_note: weekly.length ? 'Weekly checks belong to the Weekly Review (step checks), not to today: ask them there.' : undefined,
        other_days: tasks.length - asked.length - weeklies.length || undefined };
    },
  }];
}
