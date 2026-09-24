// Slipbox (#slipbox, #slipbox/<id>): one idea per note, in your own words, linked with [[Title]].
// Fleeting notes (just captured) wait to be processed into permanent ones; notes are archived, never
// deleted, and never show up in your lists. Export gives an Obsidian-ready folder of Markdown files.
import { db, app, sb, run, esc, byId, toast, syncRow } from '../state.js';
import { searchNotes, outgoing, backlinks, exportFiles, zip, linkTitles } from '../slipbox.js';
import { fmtDate } from '../dates.js';

const S = () => (app.slip ||= { q: '', show: 'all' });
const notes = () => (db.slipbox || []).filter((n) => !n.archived_at);
const snippet = (b) => String(b || '').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 140);

// Links in a note's text: [[Title]] become links to that note (or a "create it" link).
function rendered(n) {
  const html = esc(n.body || '').replace(/\[\[([^\]\n]{1,300})\]\]/g, (_, t) => {
    const title = t.split('|')[0].trim();
    const hit = notes().find((x) => x.title.trim().toLowerCase() === title.toLowerCase());
    return hit ? `<a class="sl-link" href="#slipbox/${hit.id}">${esc(title)}</a>` : `<button class="link-btn sl-missing" data-slip="new-linked" data-title="${esc(title)}">${esc(title)}</button>`;
  });
  return html.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
const row = (n) => `<a class="sl-row" href="#slipbox/${n.id}"><span class="sl-kind ${n.kind}">${n.kind === 'fleeting' ? 'Fleeting' : 'Permanent'}</span>
  <span class="sl-main"><b>${esc(n.title)}</b><span class="hint">${esc(snippet(n.body)) || 'No text yet'}</span>${n.source ? `<span class="hint sl-src">↳ ${esc(n.source)}</span>` : ''}</span>
  <span class="hint">${linkTitles(n.body).length ? `🔗 ${linkTitles(n.body).length}` : ''}</span></a>`;

export function viewSlipbox(id) {
  if (id) return noteView(id);
  const s = S();
  const all = searchNotes(notes(), s.q);
  const list = s.show === 'all' ? all : all.filter((n) => n.kind === s.show);
  const fleeting = notes().filter((n) => n.kind === 'fleeting').length;
  const recent = [...list].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return `<div class="view-head"><h1>Slipbox</h1>${notes().length ? '<button class="btn small" data-slip="export">Export as Markdown</button>' : ''}</div>
    <p class="view-sub">One idea per note, in your own words, linked to others with [[Title]]. Not actions: they never show up in your lists.</p>
    <form class="capture" data-slip-new><input type="text" name="title" placeholder="A new idea, in one line…" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    <div class="sl-bar"><input type="search" data-slip-q placeholder="Search notes" value="${esc(s.q)}">
      <span class="segmented sl-seg">${[['all', `All ${notes().length}`], ['fleeting', `Fleeting ${fleeting}`], ['permanent', `Permanent ${notes().length - fleeting}`]].map(([k, l]) => `<button class="${s.show === k ? 'on' : ''}" data-slip="show" data-show="${k}">${l}</button>`).join('')}</span></div>
    ${fleeting && s.show !== 'permanent' ? `<p class="hint">${fleeting} fleeting note${fleeting === 1 ? '' : 's'} to process: rewrite each as one idea in your words, link it, and mark it permanent.</p>` : ''}
    ${recent.length ? `<div class="sl-list">${recent.map(row).join('')}</div>` : `<p class="empty">${s.q ? 'No notes match.' : 'No notes yet. Capture an idea above, choose Slipbox when clarifying, or take notes when you finish something on your reading list.'}</p>`}`;
}

function noteView(id) {
  const n = byId(db.slipbox || [], id);
  if (!n) return '<a class="back" href="#slipbox">‹ Slipbox</a><p class="empty">That note isn’t here.</p>';
  const out = outgoing(n, notes());
  const back = backlinks(n, notes());
  const reading = n.reading_task_id && byId(db.tasks, n.reading_task_id);
  return `<a class="back" href="#slipbox">‹ Slipbox</a>
    <form class="sl-note" data-slip-note="${n.id}">
      <div class="sl-head"><span class="sl-kind ${n.kind}">${n.kind === 'fleeting' ? 'Fleeting' : 'Permanent'}</span>
        <span class="hint">${esc(fmtDate(n.created_at))}${n.processed_at ? ` · processed ${esc(fmtDate(n.processed_at))}` : ''}</span></div>
      <input class="sl-title" name="title" value="${esc(n.title)}" maxlength="300" aria-label="Title" required>
      <textarea name="body" rows="8" maxlength="20000" placeholder="The idea, in your own words. Link other notes with [[Title]].">${esc(n.body)}</textarea>
      <label class="sl-srcf">Source<input name="source" value="${esc(n.source)}" maxlength="500" placeholder="Book and page, article, conversation…"></label>
      <div class="sl-actions"><button class="btn primary">Save</button>
        ${n.kind === 'fleeting' ? `<button type="button" class="btn" data-slip="permanent" data-id="${n.id}">Mark permanent</button>` : `<button type="button" class="btn" data-slip="fleeting" data-id="${n.id}">Back to fleeting</button>`}
        <button type="button" class="btn small" data-slip="insert-link">[[ Link a note</button>
        <button type="button" class="btn small danger" data-slip="archive" data-id="${n.id}">Archive</button></div>
    </form>
    ${n.body ? `<div class="sl-read">${rendered(n)}</div>` : ''}
    ${reading ? `<p class="hint">From your reading: ${esc(reading.title)}</p>` : ''}
    <h2 class="section-title">Links · ${out.linked.length}</h2>${out.linked.length ? `<div class="sl-list">${out.linked.map(row).join('')}</div>` : '<p class="hint">None yet. Type [[ and a note’s title to link it.</p>'}
    ${out.missing.length ? `<p class="hint">Not written yet: ${out.missing.map((t) => `<button class="link-btn" data-slip="new-linked" data-title="${esc(t)}">${esc(t)}</button>`).join(', ')}</p>` : ''}
    <h2 class="section-title">Linked from · ${back.length}</h2>${back.length ? `<div class="sl-list">${back.map(row).join('')}</div>` : '<p class="hint">No notes link here yet.</p>'}`;
}

// ---------- writes ----------
export async function addNote(fields) {
  const [row] = await run(sb.from('slipbox_notes').insert({ kind: 'fleeting', body: '', source: '', ...fields }).select());
  (db.slipbox ||= []).push(row);
  return row;
}
async function saveNote(id, patch) {
  const n = byId(db.slipbox, id);
  const [row] = await run(sb.from('slipbox_notes').update(patch).eq('id', id).select());
  syncRow('slipbox', n, row);
  app.render();
}
function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function slipAction(el) {
  const a = el.dataset.slip;
  if (a === 'show') { S().show = el.dataset.show; app.render(); return; }
  if (a === 'export') {
    const files = exportFiles(notes());
    if (window.__slipExport) { window.__slipExport(files); return; } // tests
    download(`Slipbox ${new Date().toISOString().slice(0, 10)}.zip`, zip(files), 'application/zip');
    toast(`Exported ${files.length} note${files.length === 1 ? '' : 's'}: unzip into your Obsidian vault`);
    return;
  }
  if (a === 'permanent') { await saveNote(el.dataset.id, { kind: 'permanent', processed_at: new Date().toISOString() }); toast('Permanent note'); return; }
  if (a === 'fleeting') { await saveNote(el.dataset.id, { kind: 'fleeting', processed_at: null }); return; }
  if (a === 'archive') {
    await saveNote(el.dataset.id, { archived_at: new Date().toISOString() });
    location.hash = '#slipbox';
    toast('Archived', { label: 'Undo', run: async () => { await saveNote(el.dataset.id, { archived_at: null }); location.hash = `#slipbox/${el.dataset.id}`; } });
    return;
  }
  if (a === 'new-linked') { const row = await addNote({ title: el.dataset.title.slice(0, 300) }); location.hash = `#slipbox/${row.id}`; return; }
  if (a === 'insert-link') {
    const box = document.querySelector('.sl-note textarea');
    const title = prompt('Link which note? (type part of its title)');
    if (!box || !title) return;
    const hit = notes().find((x) => x.title.toLowerCase().includes(title.trim().toLowerCase()));
    const t = hit ? hit.title : title.trim();
    const at = box.selectionStart ?? box.value.length;
    box.value = `${box.value.slice(0, at)}[[${t}]]${box.value.slice(at)}`;
    box.focus();
  }
}
export function slipSubmit(e) {
  const nf = e.target.closest && e.target.closest('[data-slip-new]');
  const edit = e.target.closest && e.target.closest('[data-slip-note]');
  if (!nf && !edit) return false;
  e.preventDefault();
  if (nf) {
    const title = nf.elements.title.value.trim();
    if (!title) return true;
    nf.elements.title.value = '';
    addNote({ title: title.slice(0, 300) }).then((row) => { location.hash = `#slipbox/${row.id}`; });
    return true;
  }
  const f = new FormData(edit);
  const title = String(f.get('title') || '').trim();
  if (!title) return true;
  saveNote(edit.dataset.slipNote, { title: title.slice(0, 300), body: String(f.get('body') || ''), source: String(f.get('source') || '').trim() }).then(() => toast('Saved'));
  return true;
}
export function slipInput(e) {
  const q = e.target.closest && e.target.closest('[data-slip-q]');
  if (!q) return false;
  S().q = q.value;
  const pos = q.selectionStart;
  app.render();
  const again = document.querySelector('[data-slip-q]'); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  return true;
}
