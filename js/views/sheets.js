// Waiting sheets: one printed page per person who owes you something, and the debrief when it comes back.
// #sheets/all prints a page for everyone with open items (a page break between people); #sheets/<person>
// one page. A page: the person, "with <you>", the date; "Open with you", oldest first, each item numbered
// with its context line, the day you agreed and how far past it, Done / Not yet boxes and a line for "why,
// and by when?"; "Let's talk about", their agenda, with a line each; a footer to date and initial together.
// The browser's Print dialog makes the PDF (Save as PDF, AirPrint); nothing else is printed.
// #person/<id>/debrief goes down the same items in the same order: Done completes the card; Not yet writes
// the reason into its notes and moves the follow-up to the day agreed; an agenda item takes a note.
import { db, app, sb, run, syncRow, esc, byId, isOpen, toast, $, taskSort } from '../state.js';
import { setCompleted } from '../data.js';
import { startOfToday, atDefaultTime, fmtDate } from '../dates.js';
import { livePeople, waitingFor, agendaFor, peopleOn } from '../gtd.js';

const FROM_KEY = 'todo.sheets.from';
const S = () => (app.debrief ||= { open: new Set() });
// "with Todd · Click Plumbing": remembered on this device; to start, the name part of the sign-in.
export const fromLine = () => { try { const v = localStorage.getItem(FROM_KEY); if (v) return v; } catch { /* private mode */ } const n = ((app.user && app.user.email) || '').split('@')[0]; return n ? n[0].toUpperCase() + n.slice(1) : ''; };
const firstName = (p) => p.name.split(/\s+/)[0];
const longDate = (d) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const daysPast = (iso) => (iso ? Math.floor((startOfToday() - new Date(iso).setHours(0, 0, 0, 0)) / 86400000) : 0);
const context = (t) => String(t.notes || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const sheetCode = (p) => `${p.name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'SHT'}-${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
// Open items waiting on the person, oldest agreed day first (none agreed last), then list order; a
// project's sheets show only the items filed in that project.
export const sheetItems = (p, projectId = null) => waitingFor(p).filter((t) => !projectId || t.project_id === projectId).sort((a, b) => String(a.follow_up_at || '9').localeCompare(String(b.follow_up_at || '9')) || taskSort(a, b));
const projName = (t) => (t.project_id ? (byId(db.projects, t.project_id) || {}).name || '' : '');

function sheetHtml(p, from, projectId = null, label = '') {
  const items = sheetItems(p, projectId);
  const agenda = agendaFor(p).filter((t) => !projectId || t.project_id === projectId).sort(taskSort);
  const late = items.filter((t) => daysPast(t.follow_up_at) > 0).length;
  return `<section class="psheet" data-sheet-for="${p.id}">
    <header class="sh-head"><div><h1>${esc(p.name)}</h1><div class="sh-with">with ${esc(from || 'me')}${projectId && label ? ` · ${esc(label)}` : ''}</div></div>
      <div class="sh-date">${esc(longDate(new Date()))}<br>${items.length} open${agenda.length ? ` · ${agenda.length} to talk about` : ''}</div></header>
    <div class="sh-sec"><span>Open with you</span><span>oldest first${late ? ' · ▲ past the day we agreed' : ''}</span></div>
    ${items.map((t, i) => { const past = daysPast(t.follow_up_at); const ctx = context(t); return `<div class="sh-item"><span class="sh-num">${i + 1}</span><div class="sh-main">
      <div class="sh-title">${esc(t.title)}</div>${ctx ? `<div class="sh-ctx">${esc(ctx.slice(0, 160))}</div>` : ''}
      <div class="sh-meta">${projName(t) ? `${esc(projName(t))} · ` : ''}${t.follow_up_at ? `agreed <b>${esc(shortDate(t.follow_up_at))}</b>${past > 0 ? ` · <b>▲ ${past} day${past === 1 ? '' : 's'}</b>` : ''}` : 'no day agreed yet'}</div>
      <div class="sh-marks"><span><i class="sh-box"></i>Done</span><span><i class="sh-box"></i>Not yet</span><span class="sh-line">why, and by when?<span></span></span></div></div></div>`; }).join('') || '<p class="sh-empty">Nothing open.</p>'}
    ${agenda.length ? `<div class="sh-sec"><span>Let’s talk about</span><span>notes</span></div>${agenda.map((t) => `<div class="sh-talk"><span>•</span><span>${esc(t.title)}</span><span class="sh-line"><span></span></span></div>`).join('')}` : ''}
    <footer class="sh-foot"><span>Went through it together on ______________ &nbsp;·&nbsp; <i class="sh-box sm"></i>${esc(from || 'me')} &nbsp;<i class="sh-box sm"></i>${esc(firstName(p))}</span><span>Sheet ${esc(sheetCode(p))} · Todo Tooling</span></footer>
  </section>`;
}

// #sheets/all, #sheets/group/<id>, #sheets/project/<id> or #sheets/<person>.
export function viewSheets(who = 'all', id = null) {
  const from = fromLine();
  const hasAny = (p, projectId = null) => sheetItems(p, projectId).length || agendaFor(p).some((t) => !projectId || t.project_id === projectId);
  let people; let back = '#waiting'; let label = ''; let projectId = null;
  if (who === 'all') people = livePeople().filter((p) => hasAny(p));
  else if (who === 'group') { const g = byId(db.peopleGroups || [], id); label = g ? g.name : ''; people = g ? livePeople().filter((p) => p.group_id === g.id && hasAny(p)) : []; }
  else if (who === 'project') { const pr = byId(db.projects, id); projectId = pr ? pr.id : null; label = pr ? pr.name : ''; back = pr ? `#project/${pr.id}` : '#waiting'; people = pr ? peopleOn(pr.id).map((x) => x.person).filter((p) => hasAny(p, projectId)) : []; }
  else { people = [byId(db.people || [], who)].filter(Boolean); back = `#person/${who}`; }
  return `<div class="sheets-bar"><a class="back" href="${back}">‹ Back</a>
      <label class="sheets-from">with <input type="text" data-sheet-from value="${esc(from)}" placeholder="your name · company" aria-label="Your name on the sheets" autocomplete="off"></label>
      <span class="hint">${label ? `${esc(label)} · ` : ''}${people.length} ${people.length === 1 ? 'sheet' : 'sheets'} · one page each</span>
      <button type="button" class="btn primary" data-sheet="print">Print</button></div>
    <div class="sheets">${people.map((p) => sheetHtml(p, from, projectId, label)).join('') || '<p class="empty">Nobody owes you anything right now.</p>'}</div>`;
}

// ---------- the debrief ----------
export function viewDebrief(id) {
  const p = byId(db.people || [], id);
  if (!p) return '<a class="back" href="#waiting">‹ Waiting For</a><p class="empty">Person not found.</p>';
  const items = sheetItems(p);
  const agenda = agendaFor(p).sort(taskSort);
  const s = S();
  const doneN = db.tasks.filter((t) => t.completed_at && (t.waiting_on === p.id || t.agenda_for === p.id) && new Date(t.completed_at) > new Date(Date.now() - 6 * 3600000)).length;
  const row = (t, i) => { const past = daysPast(t.follow_up_at); const open = s.open.has(t.id); return `<div class="db-row"><span class="six-num">${i + 1}</span><div class="row-main">
      <div class="row-title">${esc(t.title)}</div>
      <div class="row-meta">${projName(t) ? `<span class="chip">${esc(projName(t))}</span>` : ''}${t.follow_up_at ? `<span class="chip ${past > 0 ? 'red' : ''}">agreed ${esc(shortDate(t.follow_up_at))}${past > 0 ? ` · ${past} day${past === 1 ? '' : 's'}` : ''}</span>` : ''}</div>
      ${open ? `<form class="db-notyet" data-debrief-form="${t.id}"><input type="text" name="why" placeholder="Why not yet… (goes into the card’s notes)" aria-label="Why not yet" autocomplete="off"><label class="hint">by <input type="date" name="when" value="${esc(nextWeekDay())}" aria-label="By when"></label><button type="submit" class="btn small primary">Save</button></form>` : ''}
    </div><span class="db-acts"><button type="button" class="btn small ok" data-debrief="done" data-id="${t.id}">✓ Done</button><button type="button" class="btn small ${open ? 'on' : ''}" data-debrief="notyet" data-id="${t.id}">Not yet</button></span></div>`; };
  return `<a class="back" href="#person/${p.id}">‹ ${esc(p.name)}</a>
    <div class="view-head"><h1 class="person-title">${esc(p.name)} <span class="hint" style="font-size:16px;font-weight:400">· debrief</span></h1><span><a class="btn small" href="#sheets/${p.id}">Print the sheet</a></span></div>
    <div class="six-carried db-strip"><span>The sheet is back? Go down it once, in the same order.${doneN ? ` <b>${doneN} done so far.</b>` : ''}</span><a class="link-btn" href="#person/${p.id}">Done with the sheet</a></div>
    ${items.map(row).join('') || '<p class="empty small">Nothing open with them.</p>'}
    ${agenda.length ? `<h2 class="section-title">Talked about</h2>${agenda.map((t) => `<div class="db-row"><span class="six-num">•</span><div class="row-main"><div class="row-title">${esc(t.title)}</div>
      <form class="db-notyet" data-debrief-note="${t.id}"><input type="text" name="note" placeholder="What came of it… (saved to the item)" aria-label="Notes" autocomplete="off"><button type="submit" class="btn small">Save</button></form></div>
      <span class="db-acts"><button type="button" class="btn small ok" data-debrief="done" data-id="${t.id}">✓ Done</button></span></div>`).join('')}` : ''}
    <p class="hint" style="margin-top:12px">“Not yet” writes the reason into the card’s notes and moves the follow-up to the day you agreed.</p>`;
}
const nextWeekDay = () => { const d = new Date(startOfToday()); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const stamp = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export async function sheetsAction(el, e) {
  if (el.dataset.sheet === 'print') { window.print(); return; }
  const a = el.dataset.debrief;
  const t = el.dataset.id && byId(db.tasks, el.dataset.id);
  if (!t) return;
  if (a === 'done') { S().open.delete(t.id); await setCompleted(t, true); return; }
  if (a === 'notyet') { const s = S(); if (s.open.has(t.id)) s.open.delete(t.id); else s.open.add(t.id); app.render(); const f = $(`[data-debrief-form="${t.id}"] [name=why]`); if (f) f.focus(); }
}
export function sheetsChange(e) {
  const f = e.target.closest && e.target.closest('[data-sheet-from]');
  if (!f) return false;
  try { localStorage.setItem(FROM_KEY, f.value.trim()); } catch { /* private mode */ }
  app.render();
  return true;
}
// Not yet (why + by when) and an agenda note, saved to the card. Answers at once (true when the form is
// one of these, with the native submit stopped) and saves in the background.
export function sheetsSubmit(e) {
  const form = e.target.closest && e.target.closest('[data-debrief-form], [data-debrief-note]');
  if (!form) return false;
  e.preventDefault();
  saveDebrief(form).catch(() => {});
  return true;
}
async function saveDebrief(form) {
  const id = form.dataset.debriefForm || form.dataset.debriefNote;
  const t = byId(db.tasks, id);
  if (!t) return;
  const fields = {};
  if (form.dataset.debriefForm) {
    const why = form.elements.why.value.trim();
    const when = form.elements.when.value;
    if (why) fields.notes = `${t.notes ? `${t.notes}\n\n` : ''}Debrief ${stamp()}: ${why}`;
    if (when) fields.follow_up_at = atDefaultTime(new Date(`${when}T12:00:00`), 'planned_at').toISOString();
  } else {
    const note = form.elements.note.value.trim();
    if (!note) return;
    fields.notes = `${t.notes ? `${t.notes}\n\n` : ''}Talked ${stamp()}: ${note}`;
  }
  if (!Object.keys(fields).length) return;
  const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select());
  syncRow('tasks', t, row);
  S().open.delete(t.id);
  toast(fields.follow_up_at ? `Noted · follow up ${fmtDate(fields.follow_up_at)}` : 'Noted');
  app.render();
}
