// Dailies, the rules (no imports: the app and the MCP Worker both use them; see js/dailies.js).
// A daily is an action with daily = { tier: must | should, weekdays?: [0-6], since: YYYY-MM-DD }.
// A weekly one adds every: 'week': it is not asked for on any day but once per Weekly Review, where it is
// one of the "Weekly checks"; each review starts it fresh. A quarterly one (every: 'quarter') is asked for
// once per quarterly check-in (Horizons); "Quarterly check-in done" starts it fresh.
// Days are local day keys (YYYY-MM-DD); ticked(key) says whether that day was ticked.
export const TIERS = [['must', 'Have to', 'every day'], ['should', 'Should', 'most days']];
export const tierLabel = (tier) => { const t = TIERS.find(([k]) => k === tier) || TIERS[1]; return `${t[1]}, ${t[2]}`; };
export const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (key) => new Date(`${key}T12:00`);
export const back = (key, n) => { const d = dateOf(key); d.setDate(d.getDate() - n); return dayKey(d); };

export const isWeekly = (daily) => !!daily && daily.every === 'week';
export const isQuarterly = (daily) => !!daily && daily.every === 'quarter';
// A check: ticked once per period (a weekly check or a quarterly one), never on a day.
export const isCheck = (daily) => isWeekly(daily) || isQuarterly(daily);
export const WEEKLY_LABEL = 'Every week, in the Weekly Review';
export const QUARTERLY_LABEL = 'Every quarter, in the quarterly check-in';
// How far back a check's ticks are looked at: a quarter and some.
export const LOOKBACK = 100;
// A check is ticked for this period when it was ticked on or after the day it started (since). For a
// weekly check that is the day the open review started (today when none is open); for a quarterly one
// the day of the last "Quarterly check-in done" (quarterSince). Returns that day, or null.
export function tickedSince(ticked, since, today) {
  for (let key = today, i = 0; key >= since && i < LOOKBACK; key = back(key, 1), i++) if (ticked(key)) return key;
  return null;
}
// A quarterly check counts from the day the last check-in was done (its ticks that day count only when
// made after it was done: the caller's ticked() sees to that); never done, every tick in the lookback counts.
export const quarterSince = (doneDay, today) => doneDay || back(today, LOOKBACK - 1);
// The last day it was ticked, looking back a quarter and some (null if never in that time).
export function lastTicked(ticked, today) {
  for (let i = 0; i < LOOKBACK; i++) { const key = back(today, i); if (ticked(key)) return key; }
  return null;
}

// Is it asked for on this day: one of its weekdays, and not before it became daily. A check never is.
export function onDay(daily, key) {
  if (isCheck(daily)) return false;
  const wd = daily.weekdays;
  if (Array.isArray(wd) && wd.length && !wd.includes(dateOf(key).getDay())) return false;
  return !daily.since || key >= daily.since;
}
// The last 7 days, oldest first: done, miss (asked for, not ticked, day over), open (today, not yet), off.
export function week(daily, ticked, today) {
  return Array.from({ length: 7 }, (_, i) => back(today, 6 - i)).map((key) => ({
    key, state: !onDay(daily, key) ? 'off' : ticked(key) ? 'done' : key === today ? 'open' : 'miss',
  }));
}
// Days in a row, counting back from today (or yesterday while today is still open); off days don't break it.
export function running(daily, ticked, today) {
  let n = 0;
  for (let i = 0; i < 60; i++) {
    const key = back(today, i);
    if (!onDay(daily, key)) { if (daily.since && key < daily.since) break; continue; }
    if (ticked(key)) n += 1;
    else if (i > 0) break;
  }
  return n;
}
// One line under the title. Have to: the last miss this week, else days running. Should: n of m this week.
export function summary(daily, ticked, today) {
  if (isCheck(daily)) {
    const last = lastTicked(ticked, today);
    return !last ? '' : last === today ? 'ticked today' : `last ticked ${dateOf(last).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  const w = week(daily, ticked, today);
  if (daily.tier === 'must') {
    const miss = [...w].reverse().find((d) => d.state === 'miss');
    if (miss) return `missed ${miss.key === back(today, 1) ? 'yesterday' : WD[dateOf(miss.key).getDay()]}`;
    const n = running(daily, ticked, today);
    return n > 1 ? `${n} days running` : '';
  }
  const asked = w.filter((d) => d.state !== 'off');
  return asked.length ? `${asked.filter((d) => d.state === 'done').length} of ${asked.length} this week` : '';
}
export const describeDaily = (daily) => {
  if (isWeekly(daily)) return WEEKLY_LABEL;
  if (isQuarterly(daily)) return QUARTERLY_LABEL;
  const wd = daily && Array.isArray(daily.weekdays) && daily.weekdays.length && daily.weekdays.length < 7 ? ` (${[...daily.weekdays].sort().map((d) => WD[d].slice(0, 3)).join(', ')})` : '';
  return `${tierLabel(daily && daily.tier)}${wd}`;
};
// A daily value from what someone passed: 'must' | 'should' | 'weekly' | 'quarterly' | { tier, weekdays? }
// | { every: 'week' | 'quarter' }. Throws a plain sentence.
export function readDaily(v) {
  const every = typeof v === 'string' ? v : v && typeof v === 'object' ? v.every : undefined;
  if (every === 'weekly' || every === 'week') return { tier: 'should', every: 'week' };
  if (every === 'quarterly' || every === 'quarter') return { tier: 'should', every: 'quarter' };
  const o = typeof v === 'string' ? { tier: v } : v || {};
  if (!['must', 'should'].includes(o.tier) || (o.every && o.every !== 'day')) throw new Error('daily is "must" (have to, every day), "should" (should, most days), "weekly" (once a week, in the Weekly Review) or "quarterly" (once a quarter, in the quarterly check-in)');
  const wd = Array.isArray(o.weekdays) ? [...new Set(o.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (Array.isArray(o.weekdays) && o.weekdays.length && wd.length !== new Set(o.weekdays.map(Number)).size) throw new Error('weekdays are numbers 0 (Sunday) to 6 (Saturday)');
  return { tier: o.tier, ...(wd.length && wd.length < 7 ? { weekdays: wd } : {}) };
}
