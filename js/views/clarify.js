// Clarify (Process Inbox): one item at a time, one decision each. 1 Next action · 2 Do it now
// (2-minute timer) · 3 Delegate · 4 Project · 5 Someday · 6 Tickler · 7 Trash · 8 Reference.
// Every decision can be undone (↶), and Skip leaves an item for later in this session.
import { db, app, sb, run, syncRow, esc, byId, isOpen, taskSort, tagsFor, toast, tagLabel } from '../state.js';
import { startOfToday, addDays, fmtDate, atDefaultTime } from '../dates.js';
import { saveTask, setLinks, convertToProject, capture } from '../data.js';
import { tagPickerHtml, wireTagPicker } from '../editors/tagPicker.js';
import { attachmentsFor, signedUrl } from '../editors/attachField.js';
import { ENERGY, isTickled, returnedFromTickler, suggestFor, makeSomeday, fileToReference, topics, saveReference, dayKey, somedayCategories } from '../gtd.js';
import { openDelegate, openTickle } from '../editors/gtd.js';
import { openReview } from './weekly.js';
import { isWeak } from '../gain.js';

export const CHOICES = [
  ['next', 'Next action', 'I’ll do it'],
  ['now', 'Do it now', 'under 2 min'],
  ['delegate', 'Delegate', 'someone else'],
  ['project', 'Project', 'several steps'],
  ['someday', 'Someday', 'not now'],
  ['tickler', 'Tickler', 'remind me later'],
  ['trash', 'Trash', 'not needed'],
  ['reference', 'Reference', 'just info'],
  ['slipbox', 'Slipbox', 'an idea to think with'],
];
// Columns an undo puts back.
const COLS = ['in_inbox', 'project_id', 'parent_id', 'completed_at', 'dropped_at', 'completion_note', 'planned_at', 'defer_at', 'flagged', 'energy', 'waiting_on', 'follow_up_at', 'delegated_at', 'agenda_for', 'tickler', 'reference_id'];

const state = () => (app.clarify ||= { skipped: new Set(), history: [], mode: null, counts: {}, done: 0 });
export const clarifyQueue = () => db.tasks.filter((t) => t.in_inbox && !t.parent_id && isOpen(t) && !isTickled(t)).sort(taskSort);
const current = () => clarifyQueue().find((t) => !state().skipped.has(t.id)) || null;

function snapshot(t) {
  return { id: t.id, row: Object.fromEntries(COLS.map((k) => [k, t[k] ?? null])), tagIds: tagsFor(t.id).map((g) => g.id) };
}
// Record what an action changed so ↶ can put it back; `undo` handles anything extra it created.
function record(snap, kind, undo = null) {
  const s = state();
  s.history.push({ ...snap, kind, undo });
  s.counts[kind] = (s.counts[kind] || 0) + 1;
  s.done += 1;
  s.mode = null;
  stopTimer();
  app.render();
}

export async function undoLast() {
  const s = state();
  const h = s.history.pop();
  if (!h) return;
  const t = byId(db.tasks, h.id);
  if (h.undo) await h.undo();
  const [row] = await run(sb.from('tasks').update(h.row).eq('id', h.id).select());
  if (t) syncRow('tasks', t, row); else db.tasks.push(row);
  await setLinks('task_tags', 'taskTags', 'task_id', h.id, h.tagIds);
  s.counts[h.kind] -= 1;
  s.done -= 1;
  s.skipped.delete(h.id);
  s.mode = null;
  app.render();
  toast('Undone');
}

// ---------- the 2-minute timer ----------
let timer = null;
function stopTimer() { clearInterval(timer); timer = null; }
function startTimer() {
  stopTimer();
  const s = state();
  s.timerStart = Date.now();
  timer = setInterval(() => {
    const el = document.querySelector('[data-clarify-timer]');
    if (!el || s.mode !== 'now') { stopTimer(); return; }
    const left = Math.max(0, 120 - Math.floor((Date.now() - s.timerStart) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('over', left === 0);
  }, 250);
}

// ---------- rendering ----------
const progressBar = (n, total) => `<div class="cl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${n}" aria-label="${n} of ${total}"><i style="width:${total ? Math.round((n / total) * 100) : 100}%"></i></div>`;
const WHEN = () => [['', 'No date'], [dayKey(startOfToday()), 'Today'], [dayKey(addDays(startOfToday(), 1)), 'Tomorrow']];

function itemCard(t) {
  const files = attachmentsFor('task_id', t.id).length;
  const meta = [`Captured ${esc(fmtDate(t.created_at))}`, returnedFromTickler(t) && '📆 from the tickler', files && `📎 ${files}`].filter(Boolean).join(' · ');
  const pics = attachmentsFor('task_id', t.id).filter((a) => a.mime.startsWith('image/')).slice(0, 4);
  return `<div class="cl-item"><b>${esc(t.title)}</b><span class="cl-meta">${meta}</span>
    ${pics.length ? `<div class="cl-pics">${pics.map((a) => `<img class="cl-thumb" data-cl-thumb="${esc(a.path)}" alt="${esc(a.name)}">`).join('')}</div>` : ''}
    ${t.notes ? `<p class="cl-notes">${esc(t.notes.slice(0, 400))}${t.notes.length > 400 ? '…' : ''}</p>` : ''}
    <label class="gain-card"><span class="gain-label"><span aria-hidden="true">✦</span> What do I gain?</span>
      <input type="text" data-cl-gain="${t.id}" value="${esc(t.gain || '')}" maxlength="500" placeholder="Say it in one line, or skip" autocomplete="off"></label>
    ${t.gain_by === 'agent' ? '<span class="chip sug">Claude suggested</span>' : ''}
    <button class="link-btn" data-task="${t.id}">Edit details</button></div>
    ${isWeak(t) ? `<div class="gain-weak cl-gain"><p>No gain written, and you’ve skipped this ${t.clarify_skips} times.</p>
      <div class="st-btns"><button class="btn small" data-cl-gain-focus>Add a gain</button><button class="btn small" data-clarify="someday">Someday</button><button class="btn small" data-clarify="trash">Drop</button></div></div>` : ''}`;
}

function nextForm(t) {
  const sug = suggestFor(t);
  const s = state();
  const projectId = s.draft?.project_id ?? (sug ? sug.project.id : (t.project_id || ''));
  const projects = db.projects.filter((p) => ['active', 'on_hold'].includes(p.status)).sort((a, b) => a.name.localeCompare(b.name));
  const when = WHEN();
  return `<form class="cl-form" data-clarify-form="next">
    <label class="field"><span class="field-label">Where does it go?</span><select name="project_id"><option value="">No project (single action)</option>
      ${projects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}${sug && sug.project.id === p.id ? ' · suggested' : ''}</option>`).join('')}</select></label>
    <div class="field cl-tags">${tagPickerHtml('where can you do it?')}</div>
    <div class="field"><span class="field-label">When?</span><div class="segmented" role="radiogroup" aria-label="When">
      ${when.map(([v, l]) => `<label><input type="radio" name="when" value="${v}" ${v === '' ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      <label><input type="radio" name="when" value="pick"><span>Pick date</span></label></div><input type="date" name="when_date" hidden aria-label="Planned date"></div>
    <div class="field"><span class="field-label">Energy</span><div class="segmented" role="radiogroup" aria-label="Energy">
      <label><input type="radio" name="energy" value="" checked><span>—</span></label>${ENERGY.map(([v, l]) => `<label><input type="radio" name="energy" value="${v}"><span>${l}</span></label>`).join('')}</div></div>
    <p class="form-error" data-cl-error hidden>Pick a project or a tag, so it leaves the Inbox.</p>
    <div class="cl-foot"><button type="button" class="btn" data-clarify="back">‹ Back</button>
      <span><label class="flag-pill" title="Flag"><input type="checkbox" name="flagged"><span aria-hidden="true">⚑</span><span class="sr-only">Flag</span></label>
      <button type="submit" class="btn primary">Save · next ⏎</button></span></div>
  </form>`;
}

function projectForm(t) {
  const folders = db.folders.filter((f) => !f.archived_at).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return `<form class="cl-form" data-clarify-form="project">
    <label>Project (the outcome)<input type="text" name="name" value="${esc(t.title)}" required autocomplete="off"></label>
    ${folders.length ? `<label>Folder<select name="folder_id"><option value="">No folder</option>${folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>` : ''}
    <label>Done looks like <span class="hint">optional</span><input type="text" name="outcome" placeholder="Permit approved and posted on site" maxlength="1000" autocomplete="off"></label>
    <label>Very next action<input type="text" name="first" placeholder="e.g. Call Hiro about dates" autocomplete="off"></label>
    <p class="hint">The item becomes the project (its notes and steps come along).${db.templates && db.templates.some((x) => !x.archived_at) ? ' Or <a href="#projects">start from a template</a>.' : ''}</p>
    <div class="cl-foot"><button type="button" class="btn" data-clarify="back">‹ Back</button><button type="submit" class="btn primary">Create project ⏎</button></div>
  </form>`;
}

function referenceForm(t) {
  const sug = suggestFor(t);
  return `<form class="cl-form" data-clarify-form="reference">
    <label>Topic<input type="text" name="topic" list="cl-topics" value="${esc(sug ? sug.project.name : '')}" placeholder="Home, Smith job…" autocomplete="off">
      <datalist id="cl-topics">${topics().map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
    <p class="hint">Filed in Reference with its notes and attachments; it leaves the Inbox.</p>
    <div class="cl-foot"><button type="button" class="btn" data-clarify="back">‹ Back</button><button type="submit" class="btn primary">File it ⏎</button></div>
  </form>`;
}

function slipboxForm(t) {
  return `<form class="cl-form" data-clarify-form="slipbox">
    <label>One idea, in your own words<input type="text" name="title" value="${esc(t.title)}" maxlength="300" autocomplete="off"></label>
    <label>Source <span class="hint">optional</span><input type="text" name="source" maxlength="500" placeholder="Book and page, article, conversation…" autocomplete="off"></label>
    <p class="hint">A fleeting note in your slipbox (its notes come too); it leaves the Inbox. Not an action: it never shows up in your lists.</p>
    <div class="cl-foot"><button type="button" class="btn" data-clarify="back">‹ Back</button><button type="submit" class="btn primary">Save to slipbox ⏎</button></div>
  </form>`;
}

function somedayForm() {
  const cats = somedayCategories();
  return `<form class="cl-form" data-clarify-form="someday">
    <div class="field"><span class="field-label">Category <span class="hint">optional</span></span><div class="segmented cl-cats" role="radiogroup" aria-label="Category">
      <label><input type="radio" name="category" value="" checked><span>None</span></label>${cats.map((g) => `<label><input type="radio" name="category" value="${esc(g.name)}"><span>${esc(g.name)}</span></label>`).join('')}</div></div>
    <label>Or a new category<input type="text" name="new_category" placeholder="Travel, Learn, Home…" maxlength="60" autocomplete="off"></label>
    <p class="hint">Parked in Someday/Maybe: out of your lists, looked at in the Weekly Review.</p>
    <div class="cl-foot"><button type="button" class="btn" data-clarify="back">‹ Back</button><button type="submit" class="btn primary">Park it ⏎</button></div>
  </form>`;
}

function nowPanel() {
  return `<div class="cl-now"><div class="cl-timer" data-clarify-timer aria-live="off">2:00</div><p class="hint">The 2-minute rule: if it takes less than two minutes, do it now.</p>
    <div class="cl-foot"><button class="btn" data-clarify="longer">Taking longer: make it an action</button><button class="btn primary" data-clarify="did-it">✓ Done ⏎</button></div></div>`;
}

export function viewClarify() {
  const s = state();
  const t = current();
  const remaining = clarifyQueue().filter((x) => !s.skipped.has(x.id)).length;
  const total = s.done + remaining + s.skipped.size;
  const head = `${openReview() ? '<a class="back" href="#weekly/inbox">‹ Weekly Review</a>' : ''}<div class="view-head"><h1 class="inbox">Process Inbox</h1><span class="cl-count">${t ? `${s.done + 1} of ${total}` : ''}</span></div>${progressBar(s.done, total)}`;
  if (!t) {
    const c = s.counts;
    const summary = CHOICES.filter(([k]) => c[k]).map(([k, l]) => `${c[k]} ${l.toLowerCase()}`).join(' · ');
    return `${head}<div class="cl-done"><div class="cl-big">🎉</div><h2>${s.skipped.size ? `Done, except ${s.skipped.size} skipped` : 'Inbox zero'}</h2>
      ${s.done ? `<p>You clarified ${s.done} item${s.done === 1 ? '' : 's'}${summary ? `: ${summary}` : ''}.</p>` : '<p>Nothing to clarify.</p>'}
      <p>${s.skipped.size ? '<button class="btn" data-clarify="unskip">Go through the skipped ones</button> ' : ''}${s.history.length ? '<button class="btn" data-clarify="undo">↶ Undo last</button> ' : ''}${openReview() ? '<a class="btn primary" href="#weekly/inbox">Back to the Weekly Review</a>' : '<a class="btn primary" href="#inbox">Back to the Inbox</a>'}</p></div>`;
  }
  let body;
  if (s.mode === 'next') body = nextForm(t);
  else if (s.mode === 'project') body = projectForm(t);
  else if (s.mode === 'reference') body = referenceForm(t);
  else if (s.mode === 'now') body = nowPanel();
  else if (s.mode === 'someday') body = somedayForm();
  else if (s.mode === 'slipbox') body = slipboxForm(t);
  else {
    const sug = suggestFor(t);
    body = `${sug ? `<button class="cl-sug" data-clarify="suggested">Suggested: <b>${esc(sug.project.name)}</b>${sug.tags.map((g) => ` · ${esc(tagLabel(g))}`).join('')} ✓</button>` : ''}
      <p class="cl-q">What is it?</p>
      <div class="cl-grid">${CHOICES.map(([k, l, sub], i) => `<button class="cl-choice ${i === 0 ? 'pri' : ''}" data-clarify="${k}"><kbd>${i + 1}</kbd><b>${l}</b><span>${sub}</span></button>`).join('')}</div>`;
  }
  return `${head}${itemCard(t)}${body}
    <div class="cl-bar"><button class="btn small" data-clarify="undo" ${s.history.length ? '' : 'disabled'}>↶ Undo</button><span class="hint cl-keys">1–9 choose · ⏎ save · Esc back</span><button class="btn small" data-clarify="skip">Skip →</button></div>`;
}

// After render: wire the next-action form's tag chips (prefilled from the suggestion).
export function mountClarify() {
  const s = state();
  document.querySelectorAll('[data-cl-thumb]').forEach(async (img) => { try { img.src = await signedUrl(img.dataset.clThumb); } catch { img.remove(); } });
  const form = document.querySelector('[data-clarify-form="next"]');
  if (form) {
    const t = current();
    const sug = t && suggestFor(t);
    const initial = s.draft?.tagIds || (t ? tagsFor(t.id).map((g) => g.id) : []);
    s.pickTags = wireTagPicker(form, initial.length ? initial : sug ? sug.tags.map((g) => g.id) : []);
    form.addEventListener('change', () => { form.elements.when_date.hidden = form.elements.when.value !== 'pick'; });
    if (s.draft?.flagged) form.elements.flagged.checked = true;
    s.draft = null;
  }
  const first = document.querySelector('.cl-form input[type=text]');
  if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  if (s.mode === 'now' && !timer) startTimer();
}

// ---------- decisions ----------
async function submitForm(form) {
  const t = current();
  if (!t) return;
  const s = state();
  const snap = snapshot(t);
  const kind = form.dataset.clarifyForm;
  if (kind === 'next') {
    const f = new FormData(form);
    const tagIds = s.pickTags ? s.pickTags() : [];
    const project_id = f.get('project_id') || null;
    if (!project_id && !tagIds.length) { form.querySelector('[data-cl-error]').hidden = false; return; }
    const whenV = f.get('when') === 'pick' ? f.get('when_date') : f.get('when');
    await saveTask(t, { project_id, flagged: f.get('flagged') === 'on', energy: f.get('energy') || null, tickler: false, planned_at: whenV ? atDefaultTime(new Date(`${whenV}T00:00:00`), 'planned_at').toISOString() : t.planned_at || null }, tagIds);
    record(snap, 'next');
  } else if (kind === 'project') {
    const f = new FormData(form);
    const name = String(f.get('name') || '').trim();
    if (!name) return;
    if (name !== t.title) { snap.row.title = t.title; const [r] = await run(sb.from('tasks').update({ title: name }).eq('id', t.id).select()); syncRow('tasks', t, r); }
    const pid = await convertToProject(byId(db.tasks, t.id) || t);
    const p = byId(db.projects, pid);
    const extra = { ...(f.get('folder_id') ? { folder_id: f.get('folder_id') } : {}), ...(String(f.get('outcome') || '').trim() ? { outcome: String(f.get('outcome')).trim() } : {}) };
    if (p && Object.keys(extra).length) { const [r] = await run(sb.from('projects').update(extra).eq('id', p.id).select()); syncRow('projects', p, r); }
    const first = String(f.get('first') || '').trim();
    if (p && first) await capture(first, { project_id: p.id, in_inbox: false });
    record(snap, 'project', async () => {
      if (p) { const [r] = await run(sb.from('projects').update({ status: 'dropped' }).eq('id', p.id).select()); syncRow('projects', p, r); }
    });
    toast(`Project “${name}” created`, [{ label: 'Plan it', run: () => { location.hash = `#plan/${pid}`; } }, { label: 'Open', run: () => { location.hash = `#project/${pid}`; } }]);
  } else if (kind === 'someday') {
    const f = new FormData(form);
    const category = String(f.get('new_category') || '').trim() || String(f.get('category') || '');
    await makeSomeday(t, category);
    toast(`Parked in Someday/Maybe${category ? ` · ${category}` : ''}`);
    record(snap, 'someday');
  } else if (kind === 'slipbox') {
    const f = new FormData(form);
    const noteId = await run(sb.rpc('slipbox_from_task', { task: t.id, title: String(f.get('title') || '').trim() || t.title, body: t.notes || '', source: String(f.get('source') || '').trim() }));
    const [row] = await run(sb.from('tasks').select('*').eq('id', t.id)); syncRow('tasks', t, row);
    const [note] = await run(sb.from('slipbox_notes').select('*').eq('id', noteId)); if (note) (db.slipbox ||= []).push(note);
    record(snap, 'slipbox', async () => {
      const [r] = await run(sb.from('slipbox_notes').update({ archived_at: new Date().toISOString() }).eq('id', noteId).select());
      const n = byId(db.slipbox || [], noteId); if (n) syncRow('slipbox', n, r);
    });
    toast('Saved to your slipbox', [{ label: 'Open', run: () => { location.hash = `#slipbox/${noteId}`; } }]);
  } else if (kind === 'reference') {
    const topic = String(new FormData(form).get('topic') || '').trim();
    const files = attachmentsFor('task_id', t.id).map((a) => a.id);
    const ref = await fileToReference(t, topic);
    const proj = db.projects.find((p) => p.name.toLowerCase() === topic.toLowerCase() && ['active', 'on_hold'].includes(p.status));
    if (proj) await saveReference(ref, { project_id: proj.id });
    record(snap, 'reference', async () => {
      await saveReference(ref, { archived_at: new Date().toISOString() });
      for (const id of files) { const a = byId(db.attachments, id); const [r] = await run(sb.from('attachments').update({ reference_id: null, task_id: t.id }).eq('id', id).select()); if (a) syncRow('attachments', a, r); }
    });
    toast(`Filed in Reference${topic ? ` · ${topic}` : ''}`, [{ label: 'Open', run: () => { location.hash = `#reference/${ref.id}`; } }]);
  }
}

export async function clarifyAction(action) {
  const s = state();
  const t = current();
  if (action === 'undo') return undoLast();
  if (action === 'unskip') { s.skipped.clear(); app.render(); return; }
  if (!t) return;
  const snap = snapshot(t);
  switch (action) {
    case 'next': s.mode = 'next'; break;
    case 'suggested': s.mode = 'next'; break;
    case 'project': s.mode = 'project'; break;
    case 'reference': s.mode = 'reference'; break;
    case 'now': s.mode = 'now'; s.timerStart = Date.now(); stopTimer(); break;
    case 'back': s.mode = null; stopTimer(); break;
    case 'skip': {
      s.skipped.add(t.id); s.mode = null; stopTimer();
      run(sb.from('tasks').update({ clarify_skips: (t.clarify_skips || 0) + 1 }).eq('id', t.id).select()).then(([row]) => syncRow('tasks', t, row)).catch(() => {});
      break;
    }
    case 'longer': s.mode = 'next'; stopTimer(); break;
    case 'did-it': {
      const [row] = await run(sb.from('tasks').update({ completed_at: new Date().toISOString() }).eq('id', t.id).select());
      syncRow('tasks', t, row);
      return record(snap, 'now');
    }
    case 'delegate': return openDelegate(t, { onDone: () => record(snap, 'delegate') });
    case 'tickler': return openTickle(t, { onDone: () => record(snap, 'tickler') });
    case 'someday': s.mode = 'someday'; break;
    case 'slipbox': s.mode = 'slipbox'; break;
    case 'trash': {
      const [row] = await run(sb.from('tasks').update({ dropped_at: new Date().toISOString() }).eq('id', t.id).select());
      syncRow('tasks', t, row);
      return record(snap, 'trash');
    }
    default: return;
  }
  app.render();
}

export function onClarifySubmit(e) {
  const form = e.target.closest('[data-clarify-form]');
  if (!form) return false;
  e.preventDefault();
  submitForm(form);
  return true;
}

// Keys while clarifying: 1–9 choose, ⏎ save/done, Esc back, s/→ skip, z/u undo.
export function clarifyKey(e) {
  if (!location.hash.startsWith('#clarify') || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (document.querySelector('#sheet').open || document.querySelector('#sheet2').open) return false;
  const s = state();
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'radio' && document.activeElement.type !== 'checkbox';
  if (e.key === 'Escape') { if (s.mode) { e.preventDefault(); clarifyAction('back'); return true; } return false; }
  if (e.key === 'Enter') {
    if (s.mode === 'now') { e.preventDefault(); clarifyAction('did-it'); return true; }
    const form = document.querySelector('[data-clarify-form]');
    if (form && !typing && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); form.requestSubmit(); return true; }
    return false;
  }
  if (typing) return false;
  if (!s.mode && /^[1-9]$/.test(e.key)) { e.preventDefault(); clarifyAction(CHOICES[Number(e.key) - 1][0]); return true; }
  if (e.key === 's' || e.key === 'ArrowRight') { e.preventDefault(); clarifyAction('skip'); return true; }
  if (e.key === 'z' || e.key === 'u') { e.preventDefault(); clarifyAction('undo'); return true; }
  return false;
}

// The gain on the item card saves as you leave the field (Enter too); a suggestion you touch becomes yours.
document.addEventListener('change', async (e) => {
  const el = e.target.closest && e.target.closest('[data-cl-gain]');
  if (!el) return;
  const t = byId(db.tasks, el.dataset.clGain);
  if (!t) return;
  const gain = el.value.trim().slice(0, 500);
  if (gain === (t.gain || '') && t.gain_by !== 'agent') return;
  const [row] = await run(sb.from('tasks').update({ gain, gain_by: null }).eq('id', t.id).select());
  syncRow('tasks', t, row);
  app.render();
});
document.addEventListener('keydown', (e) => {
  const el = e.target.closest && e.target.closest('[data-cl-gain]');
  if (el && e.key === 'Enter') { e.preventDefault(); el.blur(); }
});
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('[data-cl-gain-focus]')) { const i = document.querySelector('[data-cl-gain]'); if (i) i.focus(); }
});
