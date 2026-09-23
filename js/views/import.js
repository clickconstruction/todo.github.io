// Import from OmniFocus (#import): get the data (OmniFocus script via the clipboard, or a TaskPaper /
// CSV file), preview exactly what will happen (a dry run in the database), import in chunks, and
// offer Undo. Past imports are listed with their own Undo.
import { sb, app, run, esc, toast } from '../state.js';
import { parse, prepare, sampleTree, chunks, sumCounts, omniRunUrl, OMNI_SCRIPT } from '../omnifocus-import.js';
import { localTz } from '../repeat.js';
import { loadAll } from '../data.js';

const S = { step: 'start', text: '', parsed: null, prepared: null, preview: null, result: null, error: '', completed: 'none', progress: '', imports: null };
const reset = () => Object.assign(S, { step: 'start', text: '', parsed: null, prepared: null, preview: null, result: null, error: '', completed: 'none', progress: '' });
const n = (x) => Number(x || 0).toLocaleString();
const plural = (x, one, many = `${one}s`) => `${n(x)} ${Number(x) === 1 ? one : many}`;
const COMPLETED = [['none', 'Skip them'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All of them']];

const rpc = (payload, opts = {}) => run(sb.rpc('import_omnifocus', { payload, dry_run: !!opts.dryRun, ...(opts.batch ? { batch: opts.batch } : {}) }));

async function loadImports() {
  try { S.imports = await run(sb.from('imports').select('*').order('created_at', { ascending: false }).limit(20)); } catch { S.imports = []; }
  app.render();
}

// Parse, prepare with the chosen option, and ask the database what would happen (nothing is saved).
async function check(text) {
  S.error = '';
  try {
    S.text = text;
    S.parsed = parse(text, { tz: localTz() });
  } catch (e) { S.error = e.message; S.step = 'start'; app.render(); return; }
  await recheck();
}
async function recheck() {
  S.prepared = prepare(S.parsed, { completed: S.completed });
  S.step = 'checking';
  S.progress = `Checking ${plural(S.prepared.payload.tasks.length, 'item')}…`;
  app.render();
  try {
    const parts = chunks(S.prepared.payload);
    const results = [];
    for (const [i, part] of parts.entries()) {
      if (parts.length > 1) { S.progress = `Checking part ${i + 1} of ${parts.length}…`; app.render(); }
      results.push(await rpc(part, { dryRun: true }));
    }
    S.preview = sumCounts(results, { dryRun: true });
    S.step = 'preview';
  } catch (e) { S.error = e.message || String(e); S.step = 'start'; }
  app.render();
}

async function doImport() {
  S.step = 'importing';
  const parts = chunks(S.prepared.payload);
  const results = [];
  try {
    let batch = null;
    for (const [i, part] of parts.entries()) {
      S.progress = parts.length > 1 ? `Importing part ${i + 1} of ${parts.length}…` : 'Importing…';
      app.render();
      const r = await rpc(part, { batch });
      batch = batch || r.import_id;
      results.push(r);
    }
    S.result = sumCounts(results);
    S.step = 'done';
    await loadAll();
    loadImports();
  } catch (e) {
    S.error = `${e.message || e}${results.length ? ` (${results.length} of ${parts.length} parts were saved; importing again finishes the rest without duplicates)` : ''}`;
    S.step = 'preview';
  }
  app.render();
}

async function undo(id) {
  if (!confirm('Undo this import? Everything it added is dropped (you can still find it under Done → Dropped), and its folders are archived. Tags stay.')) return;
  const r = await run(sb.rpc('undo_import', { batch: id }));
  toast(`Undone: ${plural(r.tasks_dropped, 'action')} and ${plural(r.projects_dropped, 'project')} dropped`);
  if (S.result && S.result.import_id === id) reset();
  await loadAll();
  loadImports();
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) { toast('The clipboard is empty. Run the OmniFocus step first.'); return; }
    check(text);
  } catch {
    S.step = 'paste';
    app.render();
  }
}

// ---------- view ----------
function startHtml() {
  return `<section class="import-card">
      <h2>Copy from OmniFocus <span class="chip">best</span></h2>
      <p class="hint">Brings folders, projects (type, status, review schedule), tags, repeats, planned dates, notes and nesting. OmniFocus asks you to allow a read-only script first.</p>
      <ol class="import-steps">
        <li><a class="btn primary" href="${esc(omniRunUrl())}" data-of-open>Open OmniFocus</a> <span class="hint">then tap Run, and come back</span></li>
        <li><button class="btn primary" data-of-paste>Paste</button> <span class="hint">what OmniFocus copied</span></li>
      </ol>
      <details class="import-alt"><summary>On a Mac, and the button does nothing?</summary>
        <p class="hint">In OmniFocus choose <b>Automation → Console</b>, paste the script, press Return, then come back and tap Paste.</p>
        <button class="btn small" data-of-copy-script>Copy the script</button></details>
    </section>
    <section class="import-card">
      <h2>Or an export file</h2>
      <p class="hint">In OmniFocus: <b>File → Export</b> as TaskPaper or CSV (no folders or review schedules).</p>
      <label class="btn">Choose file<input type="file" accept=".taskpaper,.txt,.csv,.json,text/plain,text/csv,application/json" data-of-file hidden></label>
      <button class="btn" data-of-paste-text>Paste text</button>
    </section>
    ${S.step === 'paste' ? `<section class="import-card"><h2>Paste here</h2><textarea data-of-text rows="6" placeholder="Paste what OmniFocus copied, or a TaskPaper/CSV export"></textarea>
      <div class="actions"><div class="right"><button class="btn primary" data-of-check>Continue</button></div></div></section>` : ''}
    ${pastImportsHtml()}`;
}

function pastImportsHtml() {
  if (S.imports === null) { loadImports(); return ''; }
  const list = S.imports.filter((i) => (i.counts.tasks || 0) + (i.counts.projects || 0) > 0);
  if (!list.length) return '';
  return `<h2 class="section-title">Past imports</h2><ul class="list import-list">${list.map((i) => `<li class="import-row">
      <span><b>${esc(new Date(i.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</b>
        <span class="hint">${plural(i.counts.projects, 'project')} · ${plural(i.counts.tasks, 'action')} · ${esc(i.source)}${i.undone_at ? ' · undone' : ''}</span></span>
      ${i.undone_at ? '' : `<button class="btn small" data-of-undo="${i.id}">Undo</button>`}</li>`).join('')}</ul>`;
}

function previewHtml() {
  const p = S.preview;
  const s = S.prepared.summary;
  const tree = sampleTree(S.prepared.payload);
  const nothingNew = !p.tasks && !p.projects && !p.folders && !p.tags;
  const stat = (v, label) => `<div class="stat"><b>${n(v)}</b><span>${label}</span></div>`;
  return `<section class="import-card">
      <h2>Preview <span class="hint">nothing is saved yet</span></h2>
      <div class="import-stats">
        ${stat(p.projects, `project${p.projects === 1 ? '' : 's'}${s.onHoldProjects ? ` (${n(s.onHoldProjects)} on hold)` : ''}`)}
        ${stat(p.open_tasks, 'open actions')}
        ${stat(p.inbox, 'in the Inbox')}
        ${stat(p.folders + p.folders_merged, 'folders')}
        ${stat(p.tags + p.tags_merged, 'tags')}
        ${stat(s.repeating, 'repeating')}
      </div>
      <ul class="import-notes">
        ${p.tags_merged ? `<li>${plural(p.tags_merged, 'tag')} match${p.tags_merged === 1 ? 'es' : ''} one you already have and will be shared.</li>` : ''}
        ${p.folders_merged ? `<li>${plural(p.folders_merged, 'folder')} match${p.folders_merged === 1 ? 'es' : ''} one you already have.</li>` : ''}
        ${p.tasks_skipped || p.projects_skipped ? `<li>${plural(p.tasks_skipped, 'action')} and ${plural(p.projects_skipped, 'project')} were imported before and are skipped.</li>` : ''}
        ${p.review_due ? `<li>${plural(p.review_due, 'project')} will be due for review.</li>` : ''}
        ${p.tasks - p.open_tasks > 0 ? `<li>${plural(p.tasks - p.open_tasks, 'completed or dropped item')} come along as history.</li>` : ''}
      </ul>
      <label class="prop prop-inline">Completed and dropped items
        <select data-of-completed>${COMPLETED.map(([v, l]) => `<option value="${v}" ${S.completed === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${tree.length ? `<ul class="import-tree">${tree.map((l) => `<li style="--depth:${l.depth}">${esc(l.text)} ${l.meta ? `<span class="hint">${esc(l.meta)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${S.prepared.warnings.map((w) => `<p class="persp-warning">⚠️ ${esc(w)}</p>`).join('')}
      <div class="actions"><button class="btn" data-of-cancel>Start over</button>
        <div class="right">${nothingNew ? '<span class="hint">Nothing new to import.</span>' : `<button class="btn primary" data-of-import>Import ${plural(p.tasks + p.projects, 'item')}</button>`}</div></div>
    </section>`;
}

function doneHtml() {
  const r = S.result;
  return `<section class="import-card">
      <p class="import-ok">✓ Imported ${plural(r.projects, 'project')}, ${plural(r.tasks, 'action')} and ${plural(r.tags, 'new tag')}.</p>
      <div class="import-stats">
        <div class="stat"><b>${n(r.open_tasks)}</b><span>open actions</span></div>
        <div class="stat"><b>${n(r.inbox)}</b><span>in the Inbox</span></div>
        <div class="stat"><b>${n(r.review_due)}</b><span>due for review</span></div>
      </div>
      <div class="import-next"><a class="btn primary" href="#projects">Open Projects</a>${r.review_due ? '<a class="btn" href="#review">Start a review</a>' : ''}${r.inbox ? '<a class="btn" href="#inbox">Open the Inbox</a>' : ''}</div>
      <p class="hint">Not what you expected? <button class="link-btn" data-of-undo="${r.import_id}">Undo this import</button>: it drops everything it added; nothing is deleted.</p>
      <button class="link-btn muted" data-of-cancel>Import something else</button>
    </section>`;
}

export function viewImport() {
  const body = { start: startHtml, paste: startHtml, preview: previewHtml, done: doneHtml }[S.step];
  return `<div class="view-head"><h1>Import from OmniFocus</h1></div>
    <p class="view-sub">Bring your OmniFocus library over. You see exactly what will happen before anything is saved, importing twice never duplicates, and an import can be undone.</p>
    ${S.error ? `<p class="persp-warning" role="alert">⚠️ ${esc(S.error)}</p>` : ''}
    ${body ? body() : `<section class="import-card"><p class="import-busy" role="status"><span class="spinner" aria-hidden="true"></span> ${esc(S.progress)}</p></section>`}`;
}

// ---------- events (delegated; the view re-renders often) ----------
document.addEventListener('click', (e) => {
  if (!location.hash.startsWith('#import')) return;
  const t = e.target;
  if (t.closest('[data-of-paste]')) { pasteFromClipboard(); return; }
  if (t.closest('[data-of-paste-text]')) { S.step = 'paste'; app.render(); const box = document.querySelector('[data-of-text]'); if (box) box.focus(); return; }
  if (t.closest('[data-of-check]')) { const box = document.querySelector('[data-of-text]'); if (box && box.value.trim()) check(box.value); return; }
  if (t.closest('[data-of-copy-script]')) { navigator.clipboard.writeText(OMNI_SCRIPT).then(() => toast('Script copied. Paste it into OmniFocus → Automation → Console.'), () => toast('Couldn’t copy; try again')); return; }
  if (t.closest('[data-of-import]')) { doImport(); return; }
  if (t.closest('[data-of-cancel]')) { reset(); app.render(); return; }
  const u = t.closest('[data-of-undo]');
  if (u) undo(u.dataset.ofUndo);
});
document.addEventListener('change', (e) => {
  if (!location.hash.startsWith('#import')) return;
  const t = e.target;
  if (t.matches('[data-of-file]') && t.files[0]) { t.files[0].text().then(check); return; }
  if (t.matches('[data-of-completed]')) { S.completed = t.value; recheck(); }
});

export const resetImport = () => { reset(); S.imports = null; };
