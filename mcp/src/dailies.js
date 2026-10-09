// Dailies for agents: actions done every day as a checkbox that starts fresh each day, in two tiers
// (rules in js/daily-rules.js, the same ones the app uses; the database guards them, migration 20261101000001).
import { onDay, week, summary, describeDaily, readDaily, back, tierLabel, isWeekly, isQuarterly, isCheck, tickedSince, quarterSince as quarterFrom, lastTicked, LOOKBACK } from '../../js/daily-rules.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The user's open daily actions with their ticks (two requests, whatever the library size).
export async function dailiesFor(api, today, localDate = (iso) => iso.slice(0, 10)) {
  const [tasks, ticks] = await Promise.all([
    api.q(`tasks?${api.u}&completed_at=is.null&dropped_at=is.null&daily=not.is.null&select=*`),
    api.q(`daily_ticks?${api.u}&state=eq.done&day=gte.${back(today, LOOKBACK)}&select=task_id,day,updated_at`),
  ]);
  const done = new Map(ticks.map((x) => [`${x.task_id}:${x.day}`, x.updated_at]));
  // A quarterly check's tick on the day of the last check-in counts only when it came after the click.
  const at = (api.settings || {}).horizons_quarter_at || null; const doneDay = at ? localDate(at, api.tz) : null;
  return { tasks: tasks.sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || (a.created_at < b.created_at ? -1 : 1)),
    ticked: (t) => (key) => done.has(`${t.id}:${key}`) && !(isQuarterly(t.daily) && key === doneDay && Date.parse(done.get(`${t.id}:${key}`)) <= Date.parse(at)) };
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
// Quarterly checks (daily.every = 'quarter'): ticked means ticked since the last "Quarterly check-in done".
export function quarterSince(api, today, localDate) {
  const at = (api.settings || {}).horizons_quarter_at;
  const day = at ? localDate(at, api.tz) : null;
  return quarterFrom(day && day > today ? today : day, today);
}
// The day a check counts from, by its kind.
const sinceFor = async (api, t, today, localDate) => (isQuarterly(t.daily) ? quarterSince(api, today, localDate) : reviewSince(api, today, localDate));
export const checkOut = (t, ticked, since, today) => ({
  id: t.id, title: t.title, daily: describeDaily(t.daily), ticked: !!tickedSince(ticked, since, today), last_ticked: lastTicked(ticked, today) || undefined, since: t.daily.since,
});

export function dailiesTools({ localDate }) {
  return [{
    name: 'dailies',
    description: `Daily checkboxes: actions the user does every day (or on chosen weekdays). Each day starts fresh: a tick records that day only, a missed day is recorded and never carried forward, and the action itself stays open. Two tiers:
must = "${tierLabel('must')}" (medication, logging hours): a missed day shows, and it is one of the Daily review's must-dos. should = "${tierLabel('should')}" (a walk, reading): a missed day is just an empty dot; never nag about these.
Weekly checks: a question or routine for once a week ("Am I reviewing?", "Did I send everyone their items?") is set with every: "week". It is never in Today: it is one of the Weekly Review's "Weekly checks" (weekly_review, step checks), each review starts it fresh, and ticked means ticked since the open review started. list returns them under weekly.
Quarterly checks: a question for once a quarter ("Am I making businesses?", "Are my companies in good standing?") is set with every: "quarter". It is never in Today: it is listed on the quarterly check-in (list_horizons quarterly_checks; the Weekly Review's horizons step when the check-in is due), ticked means ticked since the last "Quarterly check-in done" (save_horizon kind quarterly read: true), which starts them fresh. list returns them under quarterly.
actions: list {day?} (today's, by tier, each with its week and a summary; plus weekly and quarterly) · tick {id or title, day?} · untick {id or title, day?} · set {id, tier: must|should, weekdays?: [0-6, 0 = Sunday]} or set {id, every: "week" | "quarter"} (makes an action daily, a weekly check or a quarterly one, or changes it; its repeat and dates are cleared) · clear {id} (an ordinary action again).
Use this instead of a repeating action with a due date when the user describes a habit, a daily obligation, a weekly check or a quarterly question. Ask which tier when it isn't plain from what they said. day is YYYY-MM-DD in their time zone (default today); a day that hasn't come can't be ticked.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'tick', 'untick', 'set', 'clear'], default: 'list' },
      id: { type: 'string' }, title: { type: 'string', description: 'tick/untick: the daily action\'s exact title, instead of id' },
      day: { type: 'string', description: 'YYYY-MM-DD (default today)' },
      every: { type: 'string', enum: ['day', 'week', 'quarter'], description: 'set: "week" makes it a weekly check (ticked once per Weekly Review), "quarter" a quarterly check (ticked once per quarterly check-in); "day" makes a check daily again' },
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
        if (a.every !== undefined && !['day', 'week', 'quarter'].includes(a.every)) throw new Error('every is "day", "week" or "quarter"');
        // A check (weekly or quarterly) when asked for, or when it already is one and nothing about days was passed.
        const every = ['week', 'quarter'].includes(a.every) ? a.every : a.every === undefined && a.tier === undefined && a.weekdays === undefined && isCheck(t.daily) ? t.daily.every : null;
        const daily = action === 'clear' ? null : { ...readDaily(every ? { every } : { tier: a.tier || (t.daily && t.daily.tier), weekdays: a.weekdays !== undefined ? a.weekdays : t.daily && t.daily.weekdays }), ...(t.daily && t.daily.since ? { since: t.daily.since } : {}) };
        const [row] = await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', prefer: 'return=representation', body: { daily } });
        if (!row.daily) return { id: row.id, title: row.title, daily: null, next: 'An ordinary action again. Its ticks are kept.' };
        const { ticked } = await dailiesFor(api, today, localDate);
        if (isCheck(row.daily)) return { ...checkOut(row, ticked(row), await sinceFor(api, row, today, localDate), today), next: t.daily && t.daily.every === row.daily.every ? undefined : isQuarterly(row.daily) ? 'Now a quarterly check: it is on the quarterly check-in (Horizons) under Quarterly checks, not in Today. Its repeat and dates were cleared.' : 'Now a weekly check: it is in the Weekly Review under Weekly checks, not in Today. Its repeat and dates were cleared.' };
        return { ...dailyOut(row, ticked(row), today), next: t.daily ? undefined : 'Now a daily checkbox in Today. Its repeat and dates were cleared.' };
      }

      const { tasks, ticked } = await dailiesFor(api, today, localDate);
      if (action === 'tick' || action === 'untick') {
        const key = String(a.title || '').trim().toLowerCase();
        const hits = a.id ? tasks.filter((t) => t.id === a.id) : tasks.filter((t) => t.title.trim().toLowerCase() === key);
        if (!a.id && !key) throw new Error('id or title is required');
        if (hits.length !== 1) throw new Error(hits.length ? `More than one daily action is called "${a.title}". Pass its id.` : 'No daily action like that. dailies list shows them; dailies set makes an action daily.');
        const t = hits[0];
        if (day > today) throw new Error('That day hasn’t come yet.');
        if (isCheck(t.daily)) {
          const q = isQuarterly(t.daily);
          const since = await sinceFor(api, t, today, localDate);
          if (action === 'untick') { // every tick since the period started (usually one, maybe from an earlier day)
            const rows = (await api.q(`daily_ticks?${api.u}&task_id=eq.${t.id}&state=eq.done&day=gte.${since}&select=id,day`)).filter((x) => ticked(t)(x.day));
            if (rows.length) await api.q(`daily_ticks?${api.u}&id=in.(${rows.map((x) => `"${x.id}"`).join(',')})`, { method: 'PATCH', body: { state: 'cleared' } });
            return { ...checkOut(t, () => false, since, today), last_ticked: lastTicked((k) => k < since && ticked(t)(k), today) || undefined };
          }
          const [was] = await api.q(`daily_ticks?${api.u}&task_id=eq.${t.id}&day=eq.${day}&select=id,state`);
          if (was) { if (was.state !== 'done' || !ticked(t)(day)) await api.q(`daily_ticks?${api.u}&id=eq.${was.id}`, { method: 'PATCH', body: { state: 'done' } }); } // a tick from before the check-in that day is made again
          else await api.q('daily_ticks', { method: 'POST', body: { user_id: api.userId, task_id: t.id, day } });
          return { ...checkOut(t, (k) => k === day || ticked(t)(k), since, today), next: q ? 'Ticked for this quarter. "Quarterly check-in done" starts it fresh.' : 'Ticked for this Weekly Review. The next review starts it fresh.' };
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
      const weekly = weeklies.map((t) => checkOut(t, ticked(t), since, today));
      const quarterlies = tasks.filter((t) => isQuarterly(t.daily));
      const qsince = quarterSince(api, today, localDate);
      const quarterly = quarterlies.map((t) => checkOut(t, ticked(t), qsince, today));
      return { day, have_to: must, should, left: { have_to: must.filter((x) => !x.ticked).length, should: should.filter((x) => !x.ticked).length, weekly: weekly.length ? weekly.filter((x) => !x.ticked).length : undefined, quarterly: quarterly.length ? quarterly.filter((x) => !x.ticked).length : undefined },
        weekly: weekly.length ? weekly : undefined, weekly_note: weekly.length ? 'Weekly checks belong to the Weekly Review (step checks), not to today: ask them there.' : undefined,
        quarterly: quarterly.length ? quarterly : undefined, quarterly_note: quarterly.length ? 'Quarterly checks belong to the quarterly check-in (list_horizons), not to today: ask them there.' : undefined,
        other_days: tasks.length - asked.length - weeklies.length - quarterlies.length || undefined };
    },
  }];
}
