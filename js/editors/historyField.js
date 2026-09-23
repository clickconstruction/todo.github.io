// History section for the action and project editors: every recorded change plus the
// notifications sent for the item, newest first, grouped by day, with a field filter.
// Loaded when opened (and refreshed after the inspector saves). The database writes it
// (item_history, push_log); nobody can edit it.
import { sb, db, $, esc, byId, run } from '../state.js';
import { fmtStamp, fmtDate } from '../dates.js';
import { fmtMinutes } from '../components.js';
import { fmtRadius } from '../geo.js';
import { describe as describeRepeat } from '../repeat.js';
import { describeReminder } from './notifyField.js';
import { resultLines, stripIcon, timeOnly } from '../pushResult.js';

const PAGE = 30;
const LABELS = {
  created: 'Created', title: 'Title', name: 'Name', notes: 'Notes', project_id: 'Project', parent_id: 'Group', flagged: 'Flag',
  defer_at: 'Defer', planned_at: 'Planned', due_at: 'Due', estimate_minutes: 'Duration', completed_at: 'Completed', dropped_at: 'Dropped',
  completion_note: 'Completion note', place_id: 'Place', location_trigger: 'Location alert', location_radius_m: 'Radius', repeat_rule: 'Repeat',
  notification: 'Notification', tag: 'Tag', attachment: 'Attachment', status: 'Status', kind: 'Type', folder_id: 'Folder',
  complete_with_last: 'Complete with last action', review_every: 'Review every', review_unit: 'Review unit', next_review_at: 'Next review',
  last_reviewed_at: 'Reviewed', sent: 'Notifications sent',
};
const BY = { app: 'you', agent: 'an agent', automatic: 'automatic' };
const TRIGGERS = { arrive: 'Arriving', leave: 'Leaving', nearby: 'Nearby' };
const STATUS = { active: 'Active', on_hold: 'On hold', completed: 'Completed', dropped: 'Dropped' };
const KINDS = { parallel: 'Parallel', sequential: 'Sequential', single_actions: 'Single actions' };

function show(field, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (['defer_at', 'planned_at', 'due_at', 'next_review_at'].includes(field)) { // the day is what matters
    const d = new Date(v);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  if (field.endsWith('_at')) return fmtStamp(v);
  switch (field) {
    case 'project_id': return (byId(db.projects, v) || {}).name || 'a project';
    case 'parent_id': return (byId(db.tasks, v) || {}).title || 'a group';
    case 'folder_id': return (byId(db.folders, v) || {}).name || 'a folder';
    case 'place_id': return (byId(db.places, v) || {}).name || 'a place';
    case 'estimate_minutes': return fmtMinutes(v);
    case 'location_radius_m': return fmtRadius(v);
    case 'location_trigger': return TRIGGERS[v] || v;
    case 'repeat_rule': return describeRepeat(v);
    case 'notification': return describeReminder(v);
    case 'status': return STATUS[v] || v;
    case 'kind': return KINDS[v] || v;
    case 'notes': case 'completion_note': { const s = String(v).replace(/\s+/g, ' '); return s.length > 90 ? `${s.slice(0, 90)}…` : s; }
    default: return String(v);
  }
}

// A readable sentence for one change.
function sentence(h) {
  const f = h.field; const o = h.old_value; const n = h.new_value;
  const set = o === null || o === undefined || o === ''; const cleared = n === null || n === undefined || n === '';
  const b = (t) => `<b>${esc(t)}</b>`;
  if (f === 'created') return `${b('Created')} “${esc(show('title', n))}”`;
  if (['notification', 'tag', 'attachment'].includes(f)) return `${b(`${cleared ? 'Removed' : 'Added'} ${LABELS[f].toLowerCase()}`)} ${esc(show(f, cleared ? o : n))}`;
  if (f === 'completed_at') return cleared ? b('Reopened') : b('Completed');
  if (f === 'dropped_at') return cleared ? b('Restored') : b('Dropped');
  if (f === 'flagged' || f === 'complete_with_last') return b(f === 'flagged' ? (n ? 'Flagged' : 'Unflagged') : `${n ? 'Turned on' : 'Turned off'} complete with last action`);
  if (f === 'last_reviewed_at') return b('Marked reviewed');
  if (f === 'notes' || f === 'completion_note') return cleared ? `${b(`${LABELS[f]} cleared`)}` : `${b(`${LABELS[f]} ${set ? 'added' : 'edited'}`)} <span class="hint">“${esc(show(f, n))}”</span>`;
  if (set) return `${b(LABELS[f] || f)} set to ${esc(show(f, n))}`;
  if (cleared) return `${b(`${LABELS[f] || f} cleared`)} <span class="hint">(was ${esc(show(f, o))})</span>`;
  return `${b(LABELS[f] || f)} ${esc(show(f, o))} → ${esc(show(f, n))}`;
}

const changeItem = (h) => ({ at: h.changed_at, field: h.field,
  html: `<li data-field="${esc(h.field)}"><div>${sentence(h)}</div><div class="hint">${timeOnly(h.changed_at)} · ${BY[h.source] || h.source}</div></li>` });

const sentItem = (d) => ({ at: d.sent_at || d.created_at, field: 'sent',
  html: `<li data-field="sent"><div><span class="icon">${d.kind === 'place' ? '📍' : '⏰'}</span><b>Notification sent</b> ${esc(stripIcon(d.title))}</div>
    <div class="hint">${timeOnly(d.sent_at || d.created_at)}</div>${d.devices ? resultLines(d.results) : '<div class="warn">No devices to send to</div>'}</li>` });

export const historyFieldHtml = (row) => (row && row.id ? '<details class="history-field" data-history><summary>History</summary><div data-history-body><p class="hint">Loading…</p></div></details>' : '');

export function wireHistoryField(form, col, id) {
  const box = $('[data-history]', form);
  if (!box || !id) return;
  const body = $('[data-history-body]', box);
  let items = [];
  let shown = PAGE;
  let filter = '';

  const draw = () => {
    if (!items.length) { body.innerHTML = '<p class="hint">No changes recorded yet. History starts from Sep 23, 2026.</p>'; return; }
    const fields = [...new Set(items.map((i) => i.field))];
    const visible = items.filter((i) => !filter || i.field === filter);
    let day = '';
    const rows = visible.slice(0, shown).map((i) => {
      const d = fmtDate(i.at);
      const head = d !== day ? `<li class="history-day">${esc(d === 'Today' || d === 'Yesterday' ? d : new Date(i.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: new Date(i.at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }))}</li>` : '';
      day = d;
      return head + i.html;
    }).join('');
    body.innerHTML = `<select data-history-filter aria-label="Show">
        <option value="">All changes (${items.length})</option>${fields.map((f) => `<option value="${esc(f)}" ${f === filter ? 'selected' : ''}>${esc(LABELS[f] || f)} (${items.filter((i) => i.field === f).length})</option>`).join('')}</select>
      <ul class="history-list">${rows}</ul>
      ${visible.length > shown ? `<button type="button" class="btn small" data-history-more>Show ${Math.min(PAGE, visible.length - shown)} more</button>` : ''}`;
  };

  const load = async () => {
    try {
      const [changes, sends] = await Promise.all([
        run(sb.from('item_history').select('*').eq(col, id).order('changed_at', { ascending: false }).limit(500)),
        run(sb.from('push_log').select('*').eq(col, id).order('created_at', { ascending: false }).limit(100)),
      ]);
      items = [...changes.map(changeItem), ...sends.filter((d) => d.sent_at).map(sentItem)].sort((a, b) => new Date(b.at) - new Date(a.at));
      draw();
    } catch (e) {
      body.innerHTML = `<p class="hint">Couldn’t load history: ${esc(e.message)}</p>`;
    }
  };

  box.addEventListener('toggle', () => { if (box.open && !items.length) load(); });
  body.addEventListener('change', (e) => {
    if (!e.target.matches('[data-history-filter]')) return;
    e.stopPropagation(); // not a form edit
    filter = e.target.value; shown = PAGE; draw();
  });
  body.addEventListener('click', (e) => { if (e.target.closest('[data-history-more]')) { shown += PAGE; draw(); } });
  // The inspector saves in place: show the new changes if History is open.
  form.addEventListener('saved', () => { if (box.open) load(); });
}
