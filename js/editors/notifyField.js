// Notifications field (custom reminders) for the action and project editors. Reminders are
// kept in the notifications table; the editor collects the wanted list and the save diffs it
// (unchanged reminders are kept, so one that already fired isn't sent again).
import { sb, db, $, esc, run } from '../state.js';
import { fromDateInput, fromDateTimeInput, toDateTimeInput, HOURS } from '../dates.js';

const OPTIONS = [
  ['before_due:0', 'When due'], ['before_due:15', '15 minutes before due'], ['before_due:60', '1 hour before due'], ['before_due:1440', '1 day before due'],
  ['before_planned:0', 'When planned'], ['at_defer:0', 'When it becomes available'], ['at', 'At a specific time…'], ['custom', 'Before due: custom…'],
];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtOffset = (m) => (m % 1440 === 0 ? plural(m / 1440, 'day') : m % 60 === 0 ? plural(m / 60, 'hour') : plural(m, 'minute'));

export function describeReminder(n) {
  if (n.kind === 'at') return `At ${new Date(n.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  if (n.kind === 'at_defer') return 'When it becomes available';
  const what = n.kind === 'before_due' ? 'due' : 'planned';
  return n.offset_minutes ? `${fmtOffset(n.offset_minutes)} before ${what}` : `When ${what}`;
}

// When it will fire, from the form's current dates (null if the date it needs is empty).
function fireAt(n, dates) {
  if (n.kind === 'at') return n.at ? new Date(n.at) : null;
  const base = { before_due: dates.due_at, before_planned: dates.planned_at, at_defer: dates.defer_at }[n.kind];
  return base ? new Date(new Date(base) - (n.offset_minutes || 0) * 60000) : null;
}

export const remindersFor = (col, id) => (id ? db.notifications.filter((n) => n[col] === id) : []);

export function notifyFieldHtml() {
  return `<fieldset class="notify-field"><legend>Notifications</legend>
    <ul class="notify-list" data-notify-list></ul>
    <select data-notify-add aria-label="Add notification"><option value="">+ Add notification…</option>${OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <div class="notify-at" data-notify-at-row hidden><input type="datetime-local" data-notify-at aria-label="Notify at"><button type="button" class="btn small" data-notify-at-add>Add</button></div>
    <p class="hint" style="margin:0">Sent to devices with notifications on (Nearby → Alerts).</p>
  </fieldset>`;
}

// Returns collect() → [{ kind, offset_minutes, at }].
export function wireNotifyField(form, existing, onChange = () => {}) {
  const list = existing.map((n) => ({ kind: n.kind, offset_minutes: n.offset_minutes || 0, at: n.at || null, sent_at: n.sent_at }));
  const ul = $('[data-notify-list]', form);
  const add = $('[data-notify-add]', form);
  const atRow = $('[data-notify-at-row]', form);
  const el = (n) => form.elements[n];
  const dates = () => ({
    defer_at: el('defer_at') ? fromDateInput(el('defer_at').value, HOURS.defer_at) : null,
    planned_at: el('planned_at') ? fromDateInput(el('planned_at').value, HOURS.planned_at) : null,
    due_at: el('due_at') ? fromDateInput(el('due_at').value, HOURS.due_at) : null,
  });
  const draw = () => {
    ul.innerHTML = list.map((n, i) => {
      const when = fireAt(n, dates());
      const note = !when ? `<span class="hint warn">needs a ${n.kind === 'before_planned' ? 'planned' : n.kind === 'at_defer' ? 'defer' : 'due'} date</span>`
        : `<span class="hint">${esc(when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${when < new Date() ? ' · past' : ''}</span>`;
      return `<li><span>🔔 ${esc(describeReminder(n))} ${n.kind === 'at' ? '' : note}</span><button type="button" class="icon-btn" data-notify-remove="${i}" aria-label="Remove notification">✕</button></li>`;
    }).join('');
  };
  const push = (n) => {
    if (list.some((x) => x.kind === n.kind && x.offset_minutes === n.offset_minutes && (x.at || '') === (n.at || ''))) return;
    list.push(n); draw(); onChange();
  };
  add.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = add.value;
    add.value = '';
    if (!v) return;
    if (v === 'at') {
      atRow.hidden = false;
      const at = $('[data-notify-at]', form);
      at.value = toDateTimeInput(dates().due_at || new Date(Date.now() + 3600e3).toISOString());
      at.focus();
      return;
    }
    if (v === 'custom') {
      const s = prompt('How long before it’s due? e.g. 45m, 3h, 2d', '2h');
      const m = s && s.trim().match(/^(\d+)\s*([mhd])?$/i);
      if (!m) return;
      push({ kind: 'before_due', offset_minutes: Number(m[1]) * ({ m: 1, h: 60, d: 1440 }[(m[2] || 'm').toLowerCase()]), at: null });
      return;
    }
    const [kind, mins] = v.split(':');
    push({ kind, offset_minutes: Number(mins), at: null });
  });
  $('[data-notify-at-add]', form).onclick = () => {
    const v = $('[data-notify-at]', form).value;
    if (!v) return;
    atRow.hidden = true;
    push({ kind: 'at', offset_minutes: 0, at: fromDateTimeInput(v) });
  };
  ul.addEventListener('click', (e) => {
    const b = e.target.closest('[data-notify-remove]');
    if (!b) return;
    list.splice(Number(b.dataset.notifyRemove), 1);
    draw(); onChange();
  });
  form.addEventListener('change', (e) => { if (/^(defer_at|planned_at|due_at)$/.test(e.target.name || '')) draw(); });
  form.addEventListener('click', (e) => { if (e.target.closest('[data-qd]')) setTimeout(draw, 0); });
  draw();
  return () => list.map(({ kind, offset_minutes, at }) => ({ kind, offset_minutes, at }));
}

// Make an item's reminders match `wanted` (keeps unchanged rows).
export async function saveReminders(col, id, wanted) {
  if (!wanted) return;
  const key = (n) => `${n.kind}|${n.kind === 'at' ? new Date(n.at).toISOString() : n.offset_minutes || 0}`;
  const current = db.notifications.filter((n) => n[col] === id);
  const want = new Set(wanted.map(key));
  const have = new Set(current.map(key));
  const drop = current.filter((n) => !want.has(key(n)));
  const add = wanted.filter((n) => !have.has(key(n)));
  if (drop.length) {
    await run(sb.from('notifications').delete().in('id', drop.map((n) => n.id)));
    db.notifications = db.notifications.filter((n) => !drop.includes(n));
  }
  if (add.length) {
    const rows = await run(sb.from('notifications').insert(add.map((n) => ({ [col]: id, kind: n.kind, offset_minutes: n.offset_minutes || 0, at: n.at }))).select());
    db.notifications.push(...rows);
  }
}

// After a save changed dates, the database moved fire times; refresh them.
export async function refreshReminders(col, id) {
  if (!db.notifications.some((n) => n[col] === id)) return;
  const rows = await run(sb.from('notifications').select('*').eq(col, id));
  db.notifications = db.notifications.filter((n) => n[col] !== id).concat(rows);
}
