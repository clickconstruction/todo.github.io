// Dailies, the rules (no imports: the app and the MCP Worker both use them; see js/dailies.js).
// A daily is an action with daily = { tier: must | should, weekdays?: [0-6], since: YYYY-MM-DD }.
// Days are local day keys (YYYY-MM-DD); ticked(key) says whether that day was ticked.
export const TIERS = [['must', 'Have to', 'every day'], ['should', 'Should', 'most days']];
export const tierLabel = (tier) => { const t = TIERS.find(([k]) => k === tier) || TIERS[1]; return `${t[1]}, ${t[2]}`; };
export const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (key) => new Date(`${key}T12:00`);
export const back = (key, n) => { const d = dateOf(key); d.setDate(d.getDate() - n); return dayKey(d); };

// Is it asked for on this day: one of its weekdays, and not before it became daily.
export function onDay(daily, key) {
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
  const wd = daily && Array.isArray(daily.weekdays) && daily.weekdays.length && daily.weekdays.length < 7 ? ` (${[...daily.weekdays].sort().map((d) => WD[d].slice(0, 3)).join(', ')})` : '';
  return `${tierLabel(daily && daily.tier)}${wd}`;
};
// A daily value from what someone passed: 'must' | 'should' | { tier, weekdays? }. Throws a plain sentence.
export function readDaily(v) {
  const o = typeof v === 'string' ? { tier: v } : v || {};
  if (!['must', 'should'].includes(o.tier)) throw new Error('daily is "must" (have to, every day) or "should" (should, most days)');
  const wd = Array.isArray(o.weekdays) ? [...new Set(o.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (Array.isArray(o.weekdays) && o.weekdays.length && wd.length !== new Set(o.weekdays.map(Number)).size) throw new Error('weekdays are numbers 0 (Sunday) to 6 (Saturday)');
  return { tier: o.tier, ...(wd.length && wd.length < 7 ? { weekdays: wd } : {}) };
}
