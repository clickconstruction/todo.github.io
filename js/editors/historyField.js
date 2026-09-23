// History section for the action and project editors: every recorded change (field, old → new,
// who, when) plus notifications sent for the item, newest first, with a field filter.
// Loaded when opened. The database writes it (item_history, push_log); it can't be edited.
import { sb, db, $, esc, byId, run } from '../state.js';
import { fmtStamp } from '../dates.js';
import { fmtMinutes } from '../components.js';
import { fmtRadius } from '../geo.js';
import { describe as describeRepeat } from '../repeat.js';
import { describeReminder } from './notifyField.js';

const LABELS = {
  created: 'Created', title: 'Title', name: 'Name', notes: 'Notes', project_id: 'Project', parent_id: 'Group', flagged: 'Flag',
  defer_at: 'Defer', planned_at: 'Planned', due_at: 'Due', estimate_minutes: 'Duration', completed_at: 'Completed', dropped_at: 'Dropped',
  completion_note: 'Completion note', place_id: 'Place', location_trigger: 'Location alert', location_radius_m: 'Radius', repeat_rule: 'Repeat',
  notification: 'Notification', tag: 'Tag', attachment: 'Attachment', status: 'Status', kind: 'Type', folder_id: 'Folder',
  complete_with_last: 'Complete with last action', review_every: 'Review every', review_unit: 'Review unit', next_review_at: 'Next review',
  last_reviewed_at: 'Reviewed', sent: 'Notification sent',
};
const BY = { app: 'you', agent: 'an agent (MCP) or email', automatic: 'automatically' };
const TRIGGERS = { arrive: 'Arriving', leave: 'Leaving', nearby: 'Nearby' };

function show(field, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (field.endsWith('_at')) return fmtStamp(v);
  switch (field) {
    case 'project_id': return (byId(db.projects, v) || {}).name || 'a project';
    case 'parent_id': return (byId(db.tasks, v) || {}).title || 'a group';
    case 'folder_id': return (byId(db.folders, v) || {}).name || 'a folder';
    case 'place_id': return (byId(db.places, v) || {}).name || 'a place';
    case 'flagged': case 'complete_with_last': return v ? 'On' : 'Off';
    case 'estimate_minutes': return fmtMinutes(v);
    case 'location_radius_m': return fmtRadius(v);
    case 'location_trigger': return TRIGGERS[v] || v;
    case 'repeat_rule': return describeRepeat(v);
    case 'notification': return describeReminder(v);
    case 'notes': case 'completion_note': { const s = String(v); return s.length > 80 ? `${s.slice(0, 80)}…` : s; }
    default: return String(v);
  }
}

function line(h) {
  const label = LABELS[h.field] || h.field;
  let what;
  if (h.field === 'created') what = `<b>Created</b> “${esc(show('title', h.new_value))}”`;
  else if (['notification', 'tag', 'attachment'].includes(h.field)) {
    const added = h.new_value !== null && h.new_value !== undefined;
    what = `<b>${added ? 'Added' : 'Removed'} ${label.toLowerCase()}</b> ${esc(show(h.field, added ? h.new_value : h.old_value))}`;
  } else what = `<b>${esc(label)}</b> ${esc(show(h.field, h.old_value))} → ${esc(show(h.field, h.new_value))}`;
  return `<li data-field="${esc(h.field)}"><div>${what}</div><div class="hint">${esc(fmtStamp(h.changed_at))} · by ${BY[h.source] || h.source}</div></li>`;
}

function sentLine(d) {
  const ok = (d.results || []).filter((r) => r.status >= 200 && r.status < 300).map((r) => r.device);
  const bad = (d.results || []).filter((r) => !(r.status >= 200 && r.status < 300));
  const result = !d.devices ? 'no devices to send to' : [ok.length ? `delivered to ${ok.join(', ')}` : '', ...bad.map((r) => `${r.device} failed (${r.status} ${r.reason || ''})`)].filter(Boolean).join('; ');
  return `<li data-field="sent"><div><b>${d.kind === 'place' ? '📍' : '⏰'} Notification sent</b> ${esc(d.title)}</div><div class="hint">${esc(fmtStamp(d.sent_at || d.created_at))} · ${esc(result)}</div></li>`;
}

export const historyFieldHtml = (row) => (row && row.id ? '<details class="history-field" data-history><summary>History</summary><div data-history-body><p class="hint">Loading…</p></div></details>' : '');

export function wireHistoryField(form, col, id) {
  const box = $('[data-history]', form);
  if (!box || !id) return;
  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true;
    const body = $('[data-history-body]', box);
    try {
      const [changes, sends] = await Promise.all([
        run(sb.from('item_history').select('*').eq(col, id).order('changed_at', { ascending: false }).limit(300)),
        run(sb.from('push_log').select('*').eq(col, id).order('created_at', { ascending: false }).limit(100)),
      ]);
      const items = [...changes.map((h) => ({ at: h.changed_at, html: line(h), field: h.field })), ...sends.map((d) => ({ at: d.sent_at || d.created_at, html: sentLine(d), field: 'sent' }))]
        .sort((a, b) => new Date(b.at) - new Date(a.at));
      if (!items.length) { body.innerHTML = '<p class="hint">No changes recorded yet. History starts from Sep 23, 2026.</p>'; return; }
      const fields = [...new Set(items.map((i) => i.field))];
      body.innerHTML = `<select data-history-filter aria-label="Show"><option value="">All changes (${items.length})</option>${fields.map((f) => `<option value="${esc(f)}">${esc(LABELS[f] || f)}</option>`).join('')}</select>
        <ul class="history-list">${items.map((i) => i.html).join('')}</ul>`;
      const filter = $('[data-history-filter]', body);
      filter.addEventListener('change', (e) => {
        e.stopPropagation(); // not a form edit
        body.querySelectorAll('.history-list li').forEach((li) => { li.hidden = !!filter.value && li.dataset.field !== filter.value; });
      });
    } catch (e) {
      body.innerHTML = `<p class="hint">Couldn’t load history: ${esc(e.message)}</p>`;
      loaded = false;
    }
  });
}

