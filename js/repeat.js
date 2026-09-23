// Repeat rules: presets, a readable summary, and next-occurrence math for previews.
// The database does the real work when an item is completed (migration 20260925000002);
// this mirrors it (in the device's time zone) so the editor can show "Next: Tue, Sep 30"
// and the test harness behaves the same.
//
// rule = { every, unit: day|week|month|year, weekdays?: [0-6], from: assigned|completion,
//          end_count?, end_until?: 'YYYY-MM-DD', n, tz }

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const REPEAT_UNITS = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']];
export const REPEAT_PRESETS = [
  ['', 'Never'],
  ['daily', 'Every day'],
  ['weekdays', 'Every weekday'],
  ['weekly', 'Every week'],
  ['biweekly', 'Every 2 weeks'],
  ['monthly', 'Every month'],
  ['yearly', 'Every year'],
  ['custom', 'Custom…'],
];
const PRESET_RULES = {
  daily: { every: 1, unit: 'day' },
  weekdays: { every: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] },
  weekly: { every: 1, unit: 'week' },
  biweekly: { every: 2, unit: 'week' },
  monthly: { every: 1, unit: 'month' },
  yearly: { every: 1, unit: 'year' },
};
export const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

export const presetRule = (key) => (PRESET_RULES[key] ? { ...PRESET_RULES[key], from: 'assigned', tz: localTz(), n: 1 } : null);

// Which preset a rule matches ('' none, 'custom' otherwise).
export function presetOf(rule) {
  if (!rule) return '';
  if (rule.from === 'completion' || rule.end_count || rule.end_until) return 'custom';
  const wd = (rule.weekdays || []).slice().sort().join();
  for (const [key, r] of Object.entries(PRESET_RULES)) {
    if (r.every === rule.every && r.unit === rule.unit && (r.weekdays || []).join() === wd) return key;
  }
  return 'custom';
}

const plural = (n, word) => (n === 1 ? word : `${n} ${word}s`);
export function describe(rule) {
  if (!rule) return '';
  const n = rule.every || 1;
  let s = `Every ${plural(n, rule.unit || 'day')}`;
  if (rule.unit === 'week' && rule.weekdays && rule.weekdays.length) {
    const wd = rule.weekdays.slice().sort();
    s += wd.join() === '1,2,3,4,5' ? ' on weekdays' : ` on ${wd.map((d) => WEEKDAYS[d]).join(', ')}`;
  }
  if (rule.from === 'completion') s += ', after completion';
  if (rule.end_count) s += ` · ${Math.min(rule.n || 1, rule.end_count)} of ${rule.end_count}`;
  if (rule.end_until) s += ` · until ${new Date(`${rule.end_until}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return s;
}

function addUnits(d, n, unit) {
  const x = new Date(d);
  if (unit === 'day') x.setDate(x.getDate() + n);
  else if (unit === 'week') x.setDate(x.getDate() + 7 * n);
  else {
    const day = x.getDate();
    x.setDate(1);
    x.setMonth(x.getMonth() + (unit === 'year' ? 12 * n : n));
    x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate())); // Jan 31 + 1 month = Feb 28
  }
  return x;
}

// Next scheduled occurrence after d (same local time).
export function step(rule, d) {
  const n = rule.every || 1;
  if (rule.unit === 'week' && rule.weekdays && rule.weekdays.length) {
    const days = rule.weekdays.slice().sort((a, b) => a - b);
    const dow = d.getDay();
    const later = days.find((x) => x > dow);
    const x = new Date(d);
    x.setDate(x.getDate() + (later !== undefined ? later - dow : 7 * n - dow + days[0]));
    return x;
  }
  return addUnits(d, n, rule.unit || 'day');
}

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

export function nextAnchor(rule, anchor, completed) {
  if (rule.from === 'completion' || !anchor) {
    const x = addUnits(startOfDay(completed), rule.every || 1, rule.unit || 'day');
    if (anchor) x.setHours(anchor.getHours(), anchor.getMinutes(), 0, 0);
    return x;
  }
  let nxt = step(rule, anchor);
  const today = startOfDay(new Date());
  for (let i = 0; nxt < today && i < 1000; i++) nxt = step(rule, nxt); // catch up past today
  return nxt;
}

export const ended = (rule, next) => (rule.end_count && (rule.n || 1) >= rule.end_count)
  || (rule.end_until && startOfDay(next) > new Date(`${rule.end_until}T00:00`));

// Dates of the next occurrence for an item (tasks and projects), or null if the series ends.
export function nextOccurrence(item, completedAt = new Date()) {
  const rule = item.repeat_rule;
  if (!rule) return null;
  const anchorIso = item.due_at || item.planned_at || item.defer_at;
  const anchor = anchorIso ? new Date(anchorIso) : null;
  const next = nextAnchor(rule, anchor, new Date(completedAt));
  if (ended(rule, next)) return null;
  if (!anchor) return { defer_at: next.toISOString(), planned_at: null, due_at: null, next };
  const shift = next - anchor;
  const move = (iso) => (iso ? new Date(new Date(iso).getTime() + shift).toISOString() : null);
  return { defer_at: move(item.defer_at), planned_at: move(item.planned_at), due_at: move(item.due_at), next };
}
