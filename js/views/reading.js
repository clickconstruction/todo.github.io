// Reading & watching (#reading): books, articles, videos and podcasts, apart from your actions.
// Up next sorts flagged (priority) first; flagged items waiting here stay out of Flagged.
//   Now: what you're reading (the only reading items that are live actions)
//   Up next: everything waiting (parked in Someday, so it stays out of your lists)
//   Finished, notes to write: done, with its ideas still to go into the slipbox
// Finishing asks to take notes: a fleeting slipbox note linked to the source.
import { db, app, sb, run, esc, byId, toast, isOpen } from '../state.js';
import { capture, refreshTasks } from '../data.js';
import { READING_TYPES, READING_ICON, guessReadingType } from '../slipbox.js';
import { fmtDate } from '../dates.js';
import { addNote } from './slipbox.js';

const R = () => (app.reading ||= { done: null, type: '' });
async function loadFinished() {
  try { R().done = await run(sb.from('tasks').select('*').eq('reading_state', 'finished').eq('reading_notes_done', false).order('completed_at', { ascending: false }).limit(200)); } catch { R().done = []; }
  app.render();
}
// Load the finished-but-no-notes list once (Reading view and the Weekly Review's notes step).
export function ensureFinished() { if (R().done === null) { R().done = []; loadFinished(); } }
export const readingNow = () => db.tasks.filter((t) => t.reading_state === 'reading' && isOpen(t));
export const readingNext = () => db.tasks.filter((t) => t.reading_state === 'up_next' && isOpen(t));
export const notesToWrite = () => (R().done || []);

const kind = (t) => t.reading_type || guessReadingType(t.title);
const link = (t) => (t.reading_url ? ` <a class="hint rd-url" href="${esc(t.reading_url)}" target="_blank" rel="noopener">open ↗</a>` : '');
const item = (t, btns) => `<div class="rd-row"><span class="rd-ico" aria-hidden="true">${READING_ICON[kind(t)] || '📎'}</span>
  <span class="rd-main"><b>${t.flagged ? '<span class="rd-flag" title="Priority">⚑</span> ' : ''}${esc(t.title)}</b><span class="hint">${esc((READING_TYPES.find(([k]) => k === kind(t)) || [0, 'Other'])[1])}${t.reading_state === 'reading' && t.updated_at ? ` · started ${esc(fmtDate(t.updated_at))}` : ''}${t.completed_at && t.reading_state === 'finished' ? ` · finished ${esc(fmtDate(t.completed_at))}` : ''}</span>${link(t)}</span>
  <span class="st-btns">${btns}</span></div>`;

export function viewReading() {
  const r = R();
  ensureFinished();
  const q = r.type;
  const by = (list) => (q ? list.filter((t) => kind(t) === q) : list);
  const now = by(readingNow()); const next = by(readingNext()).sort((a, b) => (Number(!!b.flagged) - Number(!!a.flagged)) || String(b.created_at).localeCompare(String(a.created_at))); const notes = by(notesToWrite());
  return `<div class="view-head"><h1>Reading &amp; watching</h1></div>
    <p class="view-sub">Books, articles, videos and podcasts. Only what you’re reading now counts as an action; the rest waits here.</p>
    <form class="capture rd-add" data-rd-new><input type="text" name="title" placeholder="A book, article, video or podcast…" autocomplete="off" enterkeyhint="done">
      <select name="type" aria-label="Type"><option value="">Type: guess</option>${READING_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn primary">Add</button></form>
    <div class="segmented rd-seg">${[['', 'All'], ...READING_TYPES].map(([k, l]) => `<button class="${q === k ? 'on' : ''}" data-rd="type-filter" data-type="${k}">${l}</button>`).join('')}</div>
    <h2 class="section-title">Now · ${now.length}</h2>
    ${now.length ? now.map((t) => item(t, `<button class="btn small primary" data-rd="finish" data-id="${t.id}">Finished</button><button class="btn small" data-rd="pause" data-id="${t.id}">Back to up next</button>`)).join('') : '<p class="hint">Nothing in progress. Start something from Up next.</p>'}
    <h2 class="section-title">Finished · notes to write · ${notes.length}</h2>
    ${notes.length ? notes.map((t) => item(t, `<button class="btn small primary" data-rd="take-notes" data-id="${t.id}">Take notes</button><button class="btn small" data-rd="notes-done" data-id="${t.id}">Notes done</button>`)).join('') : '<p class="hint">All caught up.</p>'}
    <h2 class="section-title">Up next · ${next.length}${next.some((t) => t.flagged) ? ` · ⚑ ${next.filter((t) => t.flagged).length} priority` : ''}</h2>
    ${next.length ? next.slice(0, 300).map((t) => item(t, `<button class="btn small" data-rd="start" data-id="${t.id}">Start</button><button class="btn small" data-rd="off" data-id="${t.id}" title="Take it off the reading list (it stays in Someday)">Remove</button>`)).join('') + (next.length > 300 ? `<p class="hint">+ ${next.length - 300} more</p>` : '') : '<p class="hint">Empty. In a Full Review, “→ Reading list” sends things here.</p>'}`;
}

async function setState(id, state, rtype = null) {
  await run(sb.rpc('reading_set', { task: id, state, rtype }));
  await refreshTasks([id]);
  const links = await run(sb.from('task_tags').select('*').eq('task_id', id));
  db.taskTags = db.taskTags.filter((x) => x.task_id !== id).concat(links);
}
// A fleeting note for something you've read, linked to it; opens it to write.
export async function notesFor(t) {
  const note = await addNote({ title: `Notes: ${String(t.title).slice(0, 280)}`, source: String(t.title).slice(0, 500), source_url: t.reading_url || null, reading_task_id: t.id });
  location.hash = `#slipbox/${note.id}`;
}
// From anywhere (editor, Full Review): onto the reading list, up next.
export async function toReadingList(id) { await setState(id, 'up_next'); app.render(); toast('On Reading & watching', { label: 'Open', run: () => { location.hash = '#reading'; } }); }

export async function readingAction(el) {
  const a = el.dataset.rd; const id = el.dataset.id;
  const r = R();
  if (a === 'type-filter') { r.type = el.dataset.type; app.render(); return; }
  if (a === 'start') { await setState(id, 'reading'); app.render(); toast('Reading now'); return; }
  if (a === 'pause') { await setState(id, 'up_next'); app.render(); return; }
  if (a === 'off') { await run(sb.rpc('reading_set', { task: id, state: 'off' })); await refreshTasks([id]); app.render(); toast('Off Reading & watching (still in Someday)'); return; }
  if (a === 'finish') {
    await setState(id, 'finished');
    const t = byId(db.tasks, id);
    r.done = [t, ...(r.done || []).filter((x) => x.id !== id)];
    app.render();
    toast('Finished · take notes now?', [{ label: 'Take notes', run: () => notesFor(t) }]);
    return;
  }
  if (a === 'take-notes') { const t = (r.done || []).find((x) => x.id === id) || byId(db.tasks, id); if (t) await notesFor(t); return; }
  if (a === 'notes-done') {
    await run(sb.from('tasks').update({ reading_notes_done: true }).eq('id', id));
    r.done = (r.done || []).filter((x) => x.id !== id);
    app.render();
    toast('Notes done');
  }
}
export function readingSubmit(e) {
  const f = e.target.closest && e.target.closest('[data-rd-new]');
  if (!f) return false;
  e.preventDefault();
  const title = f.elements.title.value.trim();
  const type = f.elements.type.value || null;
  if (!title) return true;
  f.elements.title.value = '';
  capture(title, {}).then(async (row) => { if (row) { await setState(row.id, 'up_next', type); app.render(); toast('Added to Up next'); } });
  return true;
}
