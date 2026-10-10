// Dailies for agents: actions done every day as a checkbox that starts fresh each day, in two tiers
// (rules in js/daily-rules.js, the same ones the app uses; the database guards them, migration 20261101000001).
// Checks (every: week | quarter | year) are ticked once per review: a tick holds half the cycle, then lapses,
// and finishing the review starts them fresh.
import { onDay, week, summary, describeDaily, readDaily, back, tierLabel, isWeekly, isQuarterly, isYearly, isCheck, latestRow, tickAt, checkTicked, countingTicks, freshAt, checkLine, CHECKS, LOOKBACK } from '../../js/daily-rules.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The user's open daily actions with their ticks (two requests, whatever the library size).
export async function dailiesFor(api, today) {
  const [tasks, ticks] = await Promise.all([
    api.q(`tasks?${api.u}&completed_at=is.null&dropped_at=is.null&daily=not.is.null&select=*`),
    api.q(`daily_ticks?${api.u}&state=eq.done&day=gte.${back(today, LOOKBACK)}&select=id,task_id,day,updated_at`),
  ]);
  const done = new Set(ticks.map((x) => `${x.task_id}:${x.day}`));
  return {
    tasks: tasks.sort((a, b) => ((a.sort || 0) - (b.sort || 0)) || (a.created_at < b.created_at ? -1 : 1)),
    ticked: (t) => (key) => done.has(`${t.id}:${key}`), // a daily one, by day
    rows: (t) => ticks.filter((x) => x.task_id === t.id), // a check's ticks, for the rules
  };
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

// When a check's review last started it fresh (ms, or null): for a weekly check the open Weekly Review's
// start, else the end of the last one; for the others the last "… done" click (user_settings).
const ms = (iso) => (iso ? Date.parse(iso) || null : null);
export async function reviewSinceAt(api) {
  const rs = await api.q(`weekly_reviews?${api.u}&select=started_at,completed_at,abandoned_at&order=started_at.desc&limit=5`);
  const open = rs.find((r) => !r.completed_at && !r.abandoned_at);
  if (open) return ms(open.started_at);
  return rs.reduce((best, r) => Math.max(best, ms(r.completed_at) || 0, ms(r.abandoned_at) || 0), 0) || null;
}
export const quarterSinceAt = (api) => ms((api.settings || {}).horizons_quarter_at);
export const yearSinceAt = (api) => ms((api.settings || {}).horizons_year_at);
export const sinceAtFor = async (api, t) => (isQuarterly(t.daily) ? quarterSinceAt(api) : isYearly(t.daily) ? yearSinceAt(api) : reviewSinceAt(api));
// A check as the tools return it: ticked now, when the tick lapses, when it was last ticked at all.
export function checkOut(t, rows, sinceAt, now = Date.now(), today) {
  const latest = latestRow(rows, sinceAt);
  const on = !!latest && checkTicked(t.daily, tickAt(latest), now);
  const any = latestRow(rows, null);
  return { id: t.id, title: t.title, daily: describeDaily(t.daily), ticked: on, fresh_from: on ? new Date(freshAt(t.daily, tickAt(latest))).toISOString() : undefined,
    last_ticked: any ? any.day : undefined, summary: checkLine(t.daily, rows, sinceAt, now, today) || undefined, since: t.daily.since };
}
const KIND = { week: 'weekly', quarter: 'quarterly', year: 'yearly' };
const WHERE = { week: 'the Weekly Review under Weekly checks', quarter: 'the quarterly check-in (Horizons) under Quarterly checks', year: 'the yearly review (Horizons) under Yearly checks' };

export function dailiesTools({ localDate }) {
  return [{
    name: 'dailies',
    description: `Daily checkboxes: actions the user does every day (or on chosen weekdays). Each day starts fresh: a tick records that day only, a missed day is recorded and never carried forward, and the action itself stays open. Two tiers:
must = "${tierLabel('must')}" (medication, logging hours): a missed day shows, and it is one of the Daily review's must-dos. should = "${tierLabel('should')}" (a walk, reading): a missed day is just an empty dot; never nag about these.
Checks: a question or routine for once a week, quarter or year is set with every: "week" | "quarter" | "year". It is never in Today. A weekly check is one of the Weekly Review's "Weekly checks" (weekly_review, step checks); a quarterly one is listed on the quarterly check-in and a yearly one on the yearly review (list_horizons quarterly_checks / yearly_checks; the Weekly Review's horizons step while they are due). A tick holds for half the cycle (3½ days, 45 days, six months) and then lapses, and finishing the review (the Weekly Review; save_horizon kind quarterly / yearly with read: true) starts them fresh at once. A lapsed tick is not a miss: never nag. list returns them under weekly, quarterly and yearly, each with fresh_from while ticked.
actions: list {day?} (today's, by tier, each with its week and a summary; plus the checks) · tick {id or title, day?} · untick {id or title, day?} · set {id, tier: must|should, weekdays?: [0-6, 0 = Sunday]} or set {id, every: "week" | "quarter" | "year"} (makes an action daily or a check, or changes it; its repeat and dates are cleared) · clear {id} (an ordinary action again).
Use this instead of a repeating action with a due date when the user describes a habit, a daily obligation, or a question they ask themselves every week, quarter or year. Ask which tier when it isn't plain from what they said. day is YYYY-MM-DD in their time zone (default today); a day that hasn't come can't be ticked.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'tick', 'untick', 'set', 'clear'], default: 'list' },
      id: { type: 'string' }, title: { type: 'string', description: 'tick/untick: the daily action\'s exact title, instead of id' },
      day: { type: 'string', description: 'YYYY-MM-DD (default today)' },
      every: { type: 'string', enum: ['day', 'week', 'quarter', 'year'], description: 'set: "week" makes it a weekly check (the Weekly Review), "quarter" a quarterly check (the quarterly check-in), "year" a yearly check (the yearly review); "day" makes a check daily again' },
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
        if (a.every !== undefined && !['day', 'week', 'quarter', 'year'].includes(a.every)) throw new Error('every is "day", "week", "quarter" or "year"');
        // A check when asked for, or when it already is one and nothing about days was passed.
        const every = CHECKS[a.every] ? a.every : a.every === undefined && a.tier === undefined && a.weekdays === undefined && isCheck(t.daily) ? t.daily.every : null;
        const daily = action === 'clear' ? null : { ...readDaily(every ? { every } : { tier: a.tier || (t.daily && t.daily.tier), weekdays: a.weekdays !== undefined ? a.weekdays : t.daily && t.daily.weekdays }), ...(t.daily && t.daily.since ? { since: t.daily.since } : {}) };
        const [row] = await api.q(`tasks?${api.u}&id=eq.${t.id}`, { method: 'PATCH', prefer: 'return=representation', body: { daily } });
        if (!row.daily) return { id: row.id, title: row.title, daily: null, next: 'An ordinary action again. Its ticks are kept.' };
        const { ticked, rows } = await dailiesFor(api, today);
        if (isCheck(row.daily)) return { ...checkOut(row, rows(row), await sinceAtFor(api, row), Date.now(), today), next: t.daily && t.daily.every === row.daily.every ? undefined : `Now a ${KIND[row.daily.every]} check: it is in ${WHERE[row.daily.every]}, not in Today. Its repeat and dates were cleared.` };
        return { ...dailyOut(row, ticked(row), today), next: t.daily ? undefined : 'Now a daily checkbox in Today. Its repeat and dates were cleared.' };
      }

      const { tasks, ticked, rows } = await dailiesFor(api, today);
      if (action === 'tick' || action === 'untick') {
        const key = String(a.title || '').trim().toLowerCase();
        const hits = a.id ? tasks.filter((t) => t.id === a.id) : tasks.filter((t) => t.title.trim().toLowerCase() === key);
        if (!a.id && !key) throw new Error('id or title is required');
        if (hits.length !== 1) throw new Error(hits.length ? `More than one daily action is called "${a.title}". Pass its id.` : 'No daily action like that. dailies list shows them; dailies set makes an action daily.');
        const t = hits[0];
        if (day > today) throw new Error('That day hasn’t come yet.');
        if (isCheck(t.daily)) {
          const sinceAt = await sinceAtFor(api, t);
          if (action === 'untick') { // every tick the box stands for (usually one, maybe from an earlier day)
            const counting = countingTicks(t.daily, rows(t), sinceAt);
            if (counting.length) await api.q(`daily_ticks?${api.u}&id=in.(${counting.map((x) => `"${x.id}"`).join(',')})`, { method: 'PATCH', body: { state: 'cleared' } });
            const left = rows(t).filter((x) => !counting.includes(x));
            return checkOut(t, left, sinceAt, Date.now(), today);
          }
          const [was] = await api.q(`daily_ticks?${api.u}&task_id=eq.${t.id}&day=eq.${day}&select=id,state`);
          let made;
          if (was) [made] = await api.q(`daily_ticks?${api.u}&id=eq.${was.id}`, { method: 'PATCH', prefer: 'return=representation', body: { state: 'done' } }); // ticking again moves its time past the review's fresh moment
          else [made] = await api.q('daily_ticks', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, task_id: t.id, day } });
          const after = [...rows(t).filter((x) => x.id !== (made && made.id)), { ...(made || { task_id: t.id, day }), state: 'done', updated_at: (made && made.updated_at) || new Date().toISOString() }];
          const half = CHECKS[t.daily.every].half;
          return { ...checkOut(t, after, sinceAt, Date.now(), today), next: `Ticked for this ${t.daily.every}. It holds ${half === 3.5 ? '3½ days' : half === 45 ? '45 days' : 'six months'} and lapses, and finishing the ${CHECKS[t.daily.every].where} starts it fresh before that.` };
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
      const now = Date.now();
      const weeklies = tasks.filter((t) => isWeekly(t.daily));
      const wsince = weeklies.length ? await reviewSinceAt(api) : null;
      const weekly = weeklies.map((t) => checkOut(t, rows(t), wsince, now, today));
      const quarterly = tasks.filter((t) => isQuarterly(t.daily)).map((t) => checkOut(t, rows(t), quarterSinceAt(api), now, today));
      const yearly = tasks.filter((t) => isYearly(t.daily)).map((t) => checkOut(t, rows(t), yearSinceAt(api), now, today));
      const left = (list) => (list.length ? list.filter((x) => !x.ticked).length : undefined);
      return { day, have_to: must, should, left: { have_to: must.filter((x) => !x.ticked).length, should: should.filter((x) => !x.ticked).length, weekly: left(weekly), quarterly: left(quarterly), yearly: left(yearly) },
        weekly: weekly.length ? weekly : undefined, weekly_note: weekly.length ? 'Weekly checks belong to the Weekly Review (step checks), not to today: ask them there.' : undefined,
        quarterly: quarterly.length ? quarterly : undefined, quarterly_note: quarterly.length ? 'Quarterly checks belong to the quarterly check-in (list_horizons), not to today: ask them there.' : undefined,
        yearly: yearly.length ? yearly : undefined, yearly_note: yearly.length ? 'Yearly checks belong to the yearly review (list_horizons), not to today: ask them there.' : undefined,
        other_days: tasks.length - asked.length - weekly.length - quarterly.length - yearly.length || undefined };
    },
  }];
}
