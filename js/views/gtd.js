// Tickler (31 day folders + 12 months), Reference (filing cabinet), Waiting For (by person, with
// follow-ups) and a person's page (Agenda + what you're waiting on them for).
import { db, app, sb, run, syncRow, toast, esc, byId, isOpen, visible, taskSort } from '../state.js';
import { openTickle, openReferenceEditor, archiveReference, openPersonEditor, openLink } from '../editors/gtd.js';
import { startOfToday, addDays, addMonths, fmtDate } from '../dates.js';
import { taskList, taskRow } from '../rows.js';
import { attachmentsFor, attachFieldHtml, wireAttachField } from '../editors/attachField.js';
import { calendarEvents, liveCalendars, fmtEventTime } from '../calendars.js';
import {
  ticklerItems, dayKey, tickleNew, addAgendaItem, messageLink, snooze, takeBack, peopleFromWaitingTags, liveReferences, livePeople, waitingFor, agendaFor, waitingPerson, followUpDue, initials, isWaiting, mentions,
} from '../gtd.js';

const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const daysAgo = (iso) => { const n = Math.round((startOfToday() - new Date(new Date(iso).setHours(0, 0, 0, 0))) / 86400000); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`; };
const avatar = (p) => `<span class="av" aria-hidden="true">${esc(initials(p.name))}</span>`;
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// ---------- Tickler ----------
export function viewTickler(selected) {
  const today = startOfToday();
  const items = ticklerItems();
  const keyOf = (t) => dayKey(new Date(t.defer_at));
  const byDay = new Map();
  items.forEach((t) => { const k = keyOf(t); byDay.set(k, (byDay.get(k) || 0) + 1); });
  const days = Array.from({ length: 31 }, (_, i) => addDays(today, i + 1));
  const lastDay = dayKey(days[days.length - 1]);
  const months = Array.from({ length: 12 }, (_, i) => new Date(today.getFullYear(), today.getMonth() + 1 + i, 1));
  const inMonth = (m) => items.filter((t) => keyOf(t) > lastDay && keyOf(t).startsWith(monthKey(m)));
  // Default: the first day with something in it, else tomorrow.
  const sel = selected || (items[0] && keyOf(items[0]) <= lastDay ? keyOf(items[0]) : dayKey(days[0]));
  const isMonth = /^\d{4}-\d{2}$/.test(sel);
  const shown = isMonth ? items.filter((t) => keyOf(t).startsWith(sel)) : items.filter((t) => keyOf(t) === sel);
  const later = items.filter((t) => keyOf(t).slice(0, 7) > monthKey(months[months.length - 1]));
  const title = isMonth ? new Date(`${sel}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : fmtDay(new Date(`${sel}T12:00:00`));
  const addKey = isMonth ? `${sel}-01` : sel;
  const cell = (k, top, big, n) => `<a class="tk-cell ${k === sel ? 'on' : ''} ${n ? 'has' : ''}" href="#tickler/${k}" aria-current="${k === sel}" aria-label="${esc(`${top} ${big}${n ? `, ${n} item${n === 1 ? '' : 's'}` : ''}`)}"><span class="tk-top">${esc(top)}</span><b>${esc(big)}</b>${n ? `<i>${n}</i>` : ''}</a>`;
  return `<div class="view-head"><h1 class="tickler">Tickler</h1></div>
    <p class="view-sub">Items come back to your Inbox on their day (6am). ${items.length ? `${items.length} waiting.` : ''}</p>
    <h2 class="section-title">Next 31 days</h2>
    <nav class="tk-grid" aria-label="Days">${days.map((d) => cell(dayKey(d), d.toLocaleDateString(undefined, { weekday: 'short' }), String(d.getDate()), byDay.get(dayKey(d)) || 0)).join('')}</nav>
    <h2 class="section-title">Months ahead</h2>
    <nav class="tk-grid months" aria-label="Months">${months.map((m) => cell(monthKey(m), String(m.getFullYear()) === String(today.getFullYear()) ? '' : String(m.getFullYear()), m.toLocaleDateString(undefined, { month: 'short' }), inMonth(m).length)).join('')}</nav>
    ${later.length ? `<p class="view-sub">${later.length} further out.</p>` : ''}
    <h2 class="section-title">${esc(title)} · ${shown.length}</h2>
    <form class="capture" data-tickle-add="${addKey}"><input type="text" name="title" placeholder="Remind me on ${esc(fmtDay(new Date(`${addKey}T12:00:00`)))}…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${shown.length ? `<ul class="list">${shown.map((t) => tickleRow(t)).join('')}</ul>` : '<p class="empty">Nothing in this folder.</p>'}
    <details class="why"><summary>Tickler or Defer?</summary><p><b>Defer</b> hides an action you’ve already decided on, in its project, until a date. The <b>Tickler</b> holds anything not decided yet (an idea, a ticket, a “reconsider this”) and drops it back in your Inbox on its day, to clarify then.</p></details>`;
}
function tickleRow(t) {
  const ref = t.reference_id && byId(db.references || [], t.reference_id);
  return taskRow(t, { extra: `<span class="row-actions">
    ${ref ? `<a class="btn small" href="#reference/${ref.id}">🗄 Open</a>` : ''}
    <button class="btn small" data-gtd="retickle" data-id="${t.id}">Change day</button>
    <button class="btn small" data-gtd="untickle" data-id="${t.id}">Bring back now</button></span>` });
}

// ---------- Reference ----------
export function viewReference(id) {
  if (id) return viewReferenceItem(id);
  const q = (app.refQuery || '').trim().toLowerCase();
  const all = liveReferences();
  const match = (r) => !q || [r.title, r.topic, r.body, (byId(db.projects, r.project_id) || {}).name].some((x) => String(x || '').toLowerCase().includes(q));
  const list = all.filter(match);
  const groups = new Map();
  list.forEach((r) => { const k = r.topic || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const row = (r) => {
    const files = attachmentsFor('reference_id', r.id).length;
    const p = r.project_id && byId(db.projects, r.project_id);
    return `<a class="group-row ref-row" href="#reference/${r.id}"><span class="group-main"><span>${r.secret_value ? '🔑 ' : ''}${esc(r.title)}</span>
      ${r.body || p ? `<span class="group-sub">${p ? `🗂 ${esc(p.name)}${r.body ? ' · ' : ''}` : ''}${esc(String(r.body || '').split('\n')[0].slice(0, 90))}</span>` : ''}</span>
      <span class="count">${r.secret_value ? '<span class="ref-mask">••••</span>' : ''}${files ? `📎${files > 1 ? files : ''}` : ''}</span></a>`;
  };
  return `<div class="view-head"><h1 class="reference">Reference</h1><button class="btn small primary" data-gtd="new-ref">+ Reference</button></div>
    <p class="view-sub">Things worth keeping that aren’t actions: codes, warranties, permits, notes. Never in your action lists.</p>
    <input type="search" id="ref-search" value="${esc(app.refQuery || '')}" placeholder="Search reference…" aria-label="Search reference" autocomplete="off">
    ${[...groups.entries()].sort(([a], [b]) => (!a) - (!b) || a.localeCompare(b)).map(([topic, rs]) => `<h2 class="section-title">${esc(topic || 'No topic')} · ${rs.length}</h2><div class="group-list">${rs.map(row).join('')}</div>`).join('')
      || (q ? '<p class="empty">Nothing matches.</p>' : '<p class="empty">Nothing filed yet. In Clarify, choose Reference for anything you want to keep but don’t need to act on.</p>')}`;
}

// After render: the item's attachments (add, open, remove) use the shared attachments field.
export function mountReferenceFiles(id) {
  const form = document.querySelector(`[data-ref-files="${id}"]`);
  if (!form) return;
  form.innerHTML = attachFieldHtml();
  form.onsubmit = (e) => e.preventDefault();
  wireAttachField(form, 'reference_id', id);
}

function viewReferenceItem(id) {
  const r = byId(db.references || [], id);
  if (!r) return '<a class="back" href="#reference">‹ Reference</a><p class="empty">Not found (it may be archived).</p>';
  const p = r.project_id && byId(db.projects, r.project_id);
  const reminders = db.tasks.filter((t) => t.reference_id === r.id && isOpen(t) && t.tickler);
  return `<a class="back" href="#reference">‹ Reference${r.topic ? ` / ${esc(r.topic)}` : ''}</a>
    <div class="view-head"><h1>${r.secret_value ? '🔑 ' : ''}${esc(r.title)}</h1><button class="btn small" data-gtd="edit-ref" data-id="${r.id}">Edit</button></div>
    <p class="view-sub">${esc(r.topic || 'No topic')} · added ${esc(fmtDate(r.created_at))}</p>
    ${r.secret_value ? `<div class="secret-box"><code data-secret hidden>${esc(r.secret_value)}</code><code data-secret-mask>••••••</code>
      <button class="btn small" data-gtd="show-secret">Show</button><button class="btn small" data-gtd="copy-secret" data-id="${r.id}">Copy</button></div>` : ''}
    ${r.body ? `<h2 class="section-title">Notes</h2><div class="ref-body">${esc(r.body)}</div>` : ''}
    <form class="ref-files" data-ref-files="${r.id}"></form>
    ${p ? `<h2 class="section-title">Support material for</h2><a class="group-row" href="#project/${p.id}"><span>🗂 ${esc(p.name)}</span></a>` : ''}
    ${reminders.length ? `<p class="view-sub">📆 Comes back ${reminders.map((t) => esc(fmtDate(t.defer_at))).join(', ')}</p>` : ''}
    <p class="head-actions ref-actions"><button class="btn small" data-gtd="tickle-ref" data-id="${r.id}">📆 Remind me on…</button><button class="btn small" data-gtd="archive-ref" data-id="${r.id}">Archive</button></p>`;
}

// ---------- Waiting For ----------
export const waitingBadgeCount = () => db.tasks.filter((t) => followUpDue(t) && isWaiting(t)).length;

export function waitingRow(t) {
  const late = followUpDue(t);
  const p = waitingPerson(t);
  const bits = [t.follow_up_at ? `<span class="${late ? 'late' : ''}">follow up ${late && new Date(t.follow_up_at) < startOfToday() ? 'was ' : ''}${esc(fmtDate(t.follow_up_at))}</span>` : '', t.delegated_at ? `asked ${esc(daysAgo(t.delegated_at))}` : ''].filter(Boolean).join(' · ');
  const reachable = p && (p.email || p.phone);
  return `<li class="row wait-row ${late ? 'late' : ''}" data-task="${t.id}"><button class="check" data-check="${t.id}" aria-label="Got it">✓</button>
    <div class="row-main"><div class="row-title">${esc(t.title)}</div>${bits ? `<div class="row-meta">${bits}</div>` : ''}</div>
    <span class="row-actions">${reachable ? `<button class="btn small ${late ? 'primary' : ''}" data-gtd="nudge" data-id="${t.id}">Nudge</button>` : ''}
      <button class="btn small" data-gtd="snooze" data-id="${t.id}" title="Follow up in 3 days">+3d</button>
      <button class="btn small" data-gtd="take-back" data-id="${t.id}" title="Put it back on your own list">Take back</button></span></li>`;
}

export function viewWaiting() {
  const people = livePeople();
  const all = waitingFor().filter(visible).sort((a, b) => String(a.follow_up_at || '9').localeCompare(String(b.follow_up_at || '9')) || taskSort(a, b));
  const groups = new Map();
  all.forEach((t) => { const p = waitingPerson(t); const k = p ? p.id : ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  const late = all.filter(followUpDue).length;
  const agendas = people.map((p) => [p, agendaFor(p).length]).filter(([, n]) => n);
  const waitingTagKids = db.tags.filter((g) => g.parent_id && /^waiting/i.test((byId(db.tags, g.parent_id) || {}).name || '') && !people.some((p) => p.tag_id === g.id));
  return `<div class="view-head"><h1 class="waiting">Waiting For</h1><button class="btn small" data-gtd="new-person">+ Person</button></div>
    <p class="view-sub">${all.length} open${late ? ` · <b class="late">${late} to follow up</b>` : ''} · delegate from Clarify or any item</p>
    ${[...groups.entries()].map(([pid, list]) => {
      const p = pid && byId(db.people, pid);
      return `<h2 class="section-title person-head">${p ? `<a href="#person/${p.id}">${avatar(p)}${esc(p.name)}</a>` : 'Someone'} · ${list.length}</h2><ul class="list">${list.map(waitingRow).join('')}</ul>`;
    }).join('') || '<p class="empty">Not waiting on anyone. Delegate something from Clarify or an item’s ⏳ Waiting on row.</p>'}
    ${agendas.length ? `<h2 class="section-title">Agendas</h2><div class="group-list">${agendas.map(([p, n]) => `<a class="group-row" href="#person/${p.id}"><span>${avatar(p)}${esc(p.name)}</span><span class="count">${n}</span></a>`).join('')}</div>` : ''}
    <h2 class="section-title">People · ${people.length}</h2>
    ${people.length ? `<div class="group-list">${people.map((p) => { const w = waitingFor(p).length; const a = agendaFor(p).length; return `<a class="group-row" href="#person/${p.id}"><span class="group-main"><span>${avatar(p)}${esc(p.name)}</span>${w || a ? `<span class="group-sub">${[w && `⏳ ${w} waiting`, a && `🗣 ${a} to discuss`].filter(Boolean).join(' · ')}</span>` : ''}</span></a>`; }).join('')}</div>` : '<p class="empty small">People appear here when you delegate or add an agenda item.</p>'}
    ${waitingTagKids.length ? `<p class="view-sub"><button class="btn small" data-gtd="people-from-tags">Make people from ${waitingTagKids.length} Waiting tag${waitingTagKids.length === 1 ? '' : 's'}</button> (${waitingTagKids.slice(0, 4).map((g) => esc(g.name)).join(', ')}${waitingTagKids.length > 4 ? '…' : ''})</p>` : ''}
    <p class="view-sub">Overdue follow-ups also show in Forecast → Today.</p>`;
}

// A person's next calendar event (title mentions their name), in the next two weeks.
export function nextMeeting(p) {
  if (!liveCalendars().some((c) => c.enabled)) return null;
  const from = startOfToday();
  return calendarEvents(dayKey(from), dayKey(addDays(from, 14))).find((e) => mentions(p, e.title) && (e.allDay ? true : Date.parse(e.end || e.start) >= Date.now())) || null;
}

export function viewPerson(id) {
  const p = byId(db.people || [], id);
  if (!p) return '<a class="back" href="#waiting">‹ Waiting For</a><p class="empty">Person not found.</p>';
  const agenda = agendaFor(p).sort(taskSort);
  const waiting = waitingFor(p);
  const meet = nextMeeting(p);
  const contact = [p.email && `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`, p.phone && `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>`].filter(Boolean).join(' · ');
  return `<a class="back" href="#waiting">‹ Waiting For</a>
    <div class="view-head"><h1 class="person-title">${avatar(p)}${esc(p.name)}${p.archived_at ? ' <span class="chip">archived</span>' : ''}</h1><button class="btn small" data-gtd="edit-person" data-id="${p.id}">Edit</button></div>
    ${contact ? `<p class="view-sub">${contact}</p>` : ''}${p.notes ? `<p class="view-sub" style="white-space:pre-wrap">${esc(p.notes)}</p>` : ''}
    ${meet ? `<p class="meet-note">Next: <b>${esc(meet.title)}</b> · ${esc(new Date(meet.allDay ? `${meet.days[0]}T12:00:00` : meet.start).toLocaleDateString(undefined, { weekday: 'short' }))} ${esc(fmtEventTime(meet))} <span class="hint">(from your calendar)</span></p>` : ''}
    <h2 class="section-title">Agenda · ${agenda.filter(isOpen).length}</h2>
    <form class="capture" data-agenda-add="${p.id}"><input type="text" name="title" placeholder="Something to discuss with ${esc(p.name.split(/\s+/)[0])}…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    ${taskList(agenda, { showPlace: false }) || '<p class="empty small">Nothing to discuss yet.</p>'}
    <h2 class="section-title">Waiting on ${esc(p.name.split(/\s+/)[0])} · ${waiting.length}</h2>
    ${waiting.length ? `<ul class="list">${waiting.map(waitingRow).join('')}</ul>` : '<p class="empty small">Nothing delegated.</p>'}
    ${agenda.length ? '<p class="view-sub">Agenda items also show under a calendar event with their name in Forecast, so they’re there when you meet.</p>' : ''}`;
}

// ---------- clicks (data-gtd) and forms ----------
export async function gtdAction(el) {
  const t = el.dataset.id && byId(db.tasks, el.dataset.id);
  const r = el.dataset.id && byId(db.references || [], el.dataset.id);
  switch (el.dataset.gtd) {
    case 'retickle': if (t) openTickle(t); break;
    case 'untickle': if (t) { const was = t.defer_at; await patch(t, { defer_at: null }); toast('Back in the Inbox', [{ label: 'Undo', run: () => patch(t, { defer_at: was }) }]); } break;
    case 'new-ref': openReferenceEditor(null, { defaults: el.dataset.project ? { project_id: el.dataset.project, topic: (byId(db.projects, el.dataset.project) || {}).name || '' } : {}, onDone: (row) => { if (!el.dataset.project) location.hash = `#reference/${row.id}`; } }); break;
    case 'edit-ref': if (r) openReferenceEditor(r); break;
    case 'archive-ref': if (r) archiveReference(r); break;
    case 'tickle-ref': if (r) openTickle({ title: `Look at: ${r.title}` }, { title: 'Remind me on…', extra: { reference_id: r.id, notes: r.topic ? `Reference · ${r.topic}` : '' } }); break;
    case 'show-secret': {
      const box = el.closest('.secret-box');
      const shown = box.querySelector('[data-secret]').hidden;
      box.querySelector('[data-secret]').hidden = !shown;
      box.querySelector('[data-secret-mask]').hidden = shown;
      el.textContent = shown ? 'Hide' : 'Show';
      break;
    }
    case 'copy-secret': if (r) { try { await navigator.clipboard.writeText(r.secret_value); toast('Copied'); } catch { toast('Couldn’t copy; tap Show and copy it'); } } break;
    case 'nudge': if (t) { const p = waitingPerson(t); const link = p && messageLink(p, t, { nudge: true, via: p.email ? 'email' : 'text' }); if (link) openLink(link); } break;
    case 'snooze': if (t) snooze(t, 3); break;
    case 'take-back': if (t) takeBack(t); break;
    case 'new-person': openPersonEditor(null, { onDone: (p) => { location.hash = `#person/${p.id}`; } }); break;
    case 'edit-person': { const p = byId(db.people || [], el.dataset.id); if (p) openPersonEditor(p); break; }
    case 'people-from-tags': { const n = await peopleFromWaitingTags(); app.render(); toast(`Added ${n} ${n === 1 ? 'person' : 'people'}`); break; }
    default:
  }
}
const patch = async (t, fields) => { const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select()); syncRow('tasks', t, row); app.render(); };

// Capture forms on these pages; returns true when handled.
export function gtdSubmit(e) {
  const tk = e.target.closest('[data-tickle-add]');
  const ag = e.target.closest('[data-agenda-add]');
  if (!tk && !ag) return false;
  e.preventDefault();
  const form = tk || ag;
  const title = form.elements.title.value.trim();
  if (!title) return true;
  form.elements.title.value = '';
  (tk ? tickleNew(title, tk.dataset.tickleAdd) : addAgendaItem(byId(db.people, ag.dataset.agendaAdd), title)).then(() => {
    const again = document.querySelector(tk ? '[data-tickle-add] input' : '[data-agenda-add] input');
    if (again) again.focus();
  });
  return true;
}

// Reference search filters as you type (keeping focus in the box).
export function onRefSearch(input) {
  app.refQuery = input.value;
  const pos = input.selectionStart;
  app.render();
  const again = document.getElementById('ref-search');
  if (again) { again.focus(); again.setSelectionRange(pos, pos); }
}
