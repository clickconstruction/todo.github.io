// Dailies, the rules (no imports: the app and the MCP Worker both use them; see js/dailies.js).
// A daily is an action with daily = { tier: must | should, weekdays?: [0-6], since: YYYY-MM-DD }.
// A check adds every: 'week' | 'quarter' | 'year': it is not asked for on any day but once per review
// (the Weekly Review's "Weekly checks", the quarterly check-in, the yearly review in Horizons). A tick
// holds for half the cycle and then lapses, so the next review finds it fresh without a click; finishing
// the review (the Weekly Review, "Quarterly check-in done", "Yearly review done") starts it fresh at once.
// Days are local day keys (YYYY-MM-DD); ticked(key) says whether that day was ticked.
export const TIERS = [['must', 'Have to', 'every day'], ['should', 'Should', 'most days']];
export const tierLabel = (tier) => { const t = TIERS.find(([k]) => k === tier) || TIERS[1]; return `${t[1]}, ${t[2]}`; };
export const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (key) => new Date(`${key}T12:00`);
export const back = (key, n) => { const d = dateOf(key); d.setDate(d.getDate() - n); return dayKey(d); };

// The checks: what the editor and the cards call them, where they are ticked, and how long a tick holds
// (half the cycle, in days) before it lapses.
export const CHECKS = {
  week: { label: 'Every week, in the Weekly Review', where: 'the Weekly Review', half: 3.5 },
  quarter: { label: 'Every quarter, in the quarterly check-in', where: 'the quarterly check-in', half: 45 },
  year: { label: 'Every year, in the yearly review', where: 'the yearly review', half: 182 },
};
export const isWeekly = (daily) => !!daily && daily.every === 'week';
export const isQuarterly = (daily) => !!daily && daily.every === 'quarter';
export const isYearly = (daily) => !!daily && daily.every === 'year';
// A check: ticked once per review, never on a day.
export const isCheck = (daily) => !!daily && !!CHECKS[daily.every];
export const WEEKLY_LABEL = CHECKS.week.label;
export const QUARTERLY_LABEL = CHECKS.quarter.label;
export const YEARLY_LABEL = CHECKS.year.label;
// How far back a check's ticks are looked at: a year and some.
export const LOOKBACK = 400;
const DAY_MS = 86400000;
export const halfMs = (daily) => (CHECKS[daily.every] || CHECKS.week).half * DAY_MS;
// When a tick row was made or last changed (ms); a row without times counts from noon of its day.
export const tickAt = (row) => Date.parse(row.updated_at || row.created_at || '') || Date.parse(`${row.day}T12:00`);
// The newest done tick row after the review's "fresh" moment (sinceAt, ms, or null); null when none.
export function latestRow(rows, sinceAt) {
  let best = null, bestAt = 0;
  for (const r of rows) { if (r.state && r.state !== 'done') continue; const at = tickAt(r); if (at > bestAt && (!sinceAt || at > sinceAt)) { best = r; bestAt = at; } }
  return best;
}
// The same, as ms.
export const latestTick = (rows, sinceAt) => { const r = latestRow(rows, sinceAt); return r ? tickAt(r) : null; };
// Is a check ticked now: its newest tick came after the review's fresh moment and is younger than half the cycle.
export const checkTicked = (daily, latestAt, now = Date.now()) => !!latestAt && now - latestAt < halfMs(daily);
// When a tick lapses (ms).
export const freshAt = (daily, latestAt) => latestAt + halfMs(daily);
// The ticks that count now: those a check's box stands for, and what un-ticking clears.
export const countingTicks = (daily, rows, sinceAt, now = Date.now()) => rows.filter((r) => (!r.state || r.state === 'done') && (!sinceAt || tickAt(r) > sinceAt) && now - tickAt(r) < halfMs(daily));
const shortDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// One line under a check: "ticked today · fresh from Nov 17", "ticked Oct 3 · fresh from Nov 17", or "last ticked Oct 3" once it lapsed.
export function checkLine(daily, rows, sinceAt, now = Date.now(), today = dayKey(new Date(now))) {
  const r = latestRow(rows, sinceAt);
  const when = (row) => (row.day === today ? 'today' : shortDate(Date.parse(`${row.day}T12:00`)));
  if (r && checkTicked(daily, tickAt(r), now)) return `ticked ${when(r)} · fresh from ${shortDate(freshAt(daily, tickAt(r)))}`;
  const any = latestRow(rows, null);
  return any ? `last ticked ${when(any)}` : '';
}
// The last day it was ticked, looking back a year and some (null if never in that time).
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
  if (isCheck(daily)) return CHECKS[daily.every].label;
  const wd = daily && Array.isArray(daily.weekdays) && daily.weekdays.length && daily.weekdays.length < 7 ? ` (${[...daily.weekdays].sort().map((d) => WD[d].slice(0, 3)).join(', ')})` : '';
  return `${tierLabel(daily && daily.tier)}${wd}`;
};
// A daily value from what someone passed: 'must' | 'should' | 'weekly' | 'quarterly' | 'yearly' |
// { tier, weekdays? } | { every: 'week' | 'quarter' | 'year' }. Throws a plain sentence.
export function readDaily(v) {
  const every = typeof v === 'string' ? v : v && typeof v === 'object' ? v.every : undefined;
  if (every === 'weekly' || every === 'week') return { tier: 'should', every: 'week' };
  if (every === 'quarterly' || every === 'quarter') return { tier: 'should', every: 'quarter' };
  if (every === 'yearly' || every === 'year') return { tier: 'should', every: 'year' };
  const o = typeof v === 'string' ? { tier: v } : v || {};
  if (!['must', 'should'].includes(o.tier) || (o.every && o.every !== 'day')) throw new Error('daily is "must" (have to, every day), "should" (should, most days), "weekly" (once a week, in the Weekly Review), "quarterly" (once a quarter, in the quarterly check-in) or "yearly" (once a year, in the yearly review)');
  const wd = Array.isArray(o.weekdays) ? [...new Set(o.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (Array.isArray(o.weekdays) && o.weekdays.length && wd.length !== new Set(o.weekdays.map(Number)).size) throw new Error('weekdays are numbers 0 (Sunday) to 6 (Saturday)');
  return { tier: o.tier, ...(wd.length && wd.length < 7 ? { weekdays: wd } : {}) };
}
