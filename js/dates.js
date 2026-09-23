// Date helpers. Stored as timestamptz; shown and edited as local calendar days.
// Due dates land at 5pm local, planned at 9am, defer at midnight.

export const HOURS = { defer_at: 0, planned_at: 9, due_at: 17 };

export const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const dayStart = (iso) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); return d; };

export const isOverdue = (t) => t.due_at && new Date(t.due_at) < startOfToday();
export const isDueToday = (t) => t.due_at && new Date(t.due_at) <= endOfToday();
export const isDeferred = (t) => t.defer_at && new Date(t.defer_at) > new Date();
export const isPlannedPast = (t) => t.planned_at && new Date(t.planned_at) < startOfToday();
export const isPlannedByToday = (t) => t.planned_at && new Date(t.planned_at) <= endOfToday();

export function fmtDate(iso) {
  const d = new Date(iso);
  const today = startOfToday();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
export const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// <input type=date> value <-> timestamptz.
export const toDateInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const fromDateInput = (v, hour) => {
  if (!v) return null;
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d, hour).toISOString();
};

// One-tap date math for the quick buttons: steps from the field's current day, or today if empty.
export function quickDate(currentInputValue, step) {
  const base = currentInputValue ? new Date(currentInputValue + 'T00:00') : startOfToday();
  switch (step) {
    case 'today': return toDateInput(startOfToday().toISOString());
    case '+1d': return toDateInput(addDays(base, 1).toISOString());
    case '+1w': return toDateInput(addDays(base, 7).toISOString());
    case '+1m': return toDateInput(addMonths(base, 1).toISOString());
    case 'clear': return '';
    default: return currentInputValue;
  }
}
