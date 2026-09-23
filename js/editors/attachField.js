// Attachments field for the action and project editors. Files go to the private
// "attachments" bucket under <user id>/<uuid>/<name>; rows in the attachments table.
// Existing items upload as soon as you pick files; new items upload when saved.
// Removing archives the attachment (with Undo); nothing is deleted.
import { sb, db, app, $, esc, run, toast } from '../state.js';

const MAX = 25 * 1024 * 1024;
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const icon = (mime) => (mime.startsWith('image/') ? '🖼' : mime === 'application/pdf' ? '📄' : mime.startsWith('video/') ? '🎞' : mime.startsWith('audio/') ? '🎵' : '📎');
const signedCache = new Map(); // path -> { url, until }

export const attachmentsFor = (col, id) => (id ? db.attachments.filter((a) => a[col] === id && !a.archived_at) : []);

export async function signedUrl(path) {
  const hit = signedCache.get(path);
  if (hit && hit.until > Date.now()) return hit.url;
  const { data, error } = await sb.storage.from('attachments').createSignedUrl(path, 3600);
  if (error) throw error;
  signedCache.set(path, { url: data.signedUrl, until: Date.now() + 50 * 60e3 });
  return data.signedUrl;
}

// Upload files and record them; returns the new rows.
export async function uploadFiles(col, id, files) {
  const out = [];
  for (const file of files) {
    if (file.size > MAX) { toast(`${file.name} is over 25 MB`); continue; }
    const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
    const path = `${app.user.id}/${crypto.randomUUID()}/${safe}`;
    const { error } = await sb.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (error) { toast(`Couldn’t upload ${file.name}: ${error.message}`); continue; }
    const [row] = await run(sb.from('attachments').insert({ [col]: id, path, name: file.name.slice(0, 255), size: file.size, mime: file.type || 'application/octet-stream' }).select());
    db.attachments.push(row);
    out.push(row);
  }
  return out;
}

export function attachFieldHtml() {
  return `<fieldset class="attach-field"><legend>Attachments</legend>
    <ul class="attach-list" data-attach-list></ul>
    <label class="btn small attach-add">＋ Add attachment<input type="file" multiple data-attach-input hidden></label>
  </fieldset>`;
}

// Returns collect() → files still waiting to upload (new items only).
export function wireAttachField(form, col, id) {
  const ul = $('[data-attach-list]', form);
  const input = $('[data-attach-input]', form);
  if (!ul) return () => [];
  const pending = [];
  const draw = () => {
    const rows = attachmentsFor(col, id);
    ul.innerHTML = rows.map((a) => `<li data-attach="${a.id}">
        ${a.mime.startsWith('image/') ? `<img class="attach-thumb" data-thumb="${esc(a.path)}" alt="">` : `<span class="attach-icon">${icon(a.mime)}</span>`}
        <button type="button" class="link attach-open" data-attach-open="${a.id}">${esc(a.name)}</button>
        <span class="hint">${fmtSize(a.size)}</span>
        <button type="button" class="icon-btn" data-attach-remove="${a.id}" aria-label="Remove ${esc(a.name)}">✕</button></li>`).join('')
      + pending.map((f, i) => `<li><span class="attach-icon">⏳</span><span>${esc(f.name)}</span><span class="hint">${fmtSize(f.size)} · uploads when saved</span>
        <button type="button" class="icon-btn" data-pending-remove="${i}" aria-label="Remove">✕</button></li>`).join('');
    ul.querySelectorAll('[data-thumb]').forEach(async (img) => { try { img.src = await signedUrl(img.dataset.thumb); } catch { img.remove(); } });
  };
  input.addEventListener('change', async (e) => {
    e.stopPropagation(); // a file pick isn't a form edit to autosave
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    if (!id) { pending.push(...files); draw(); return; }
    ul.insertAdjacentHTML('beforeend', `<li class="hint">Uploading ${files.length} file${files.length === 1 ? '' : 's'}…</li>`);
    const rows = await uploadFiles(col, id, files);
    draw();
    app.render();
    if (rows.length) toast(`Attached ${rows.length} file${rows.length === 1 ? '' : 's'}`);
  });
  ul.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-attach-open]');
    if (open) {
      const a = db.attachments.find((x) => x.id === open.dataset.attachOpen);
      const w = window.open('', '_blank'); // open now (popup blockers), point it at the file once signed
      try { const url = await signedUrl(a.path); if (w) w.location = url; else location.href = url; } catch (err) { if (w) w.close(); toast(err.message); }
      return;
    }
    const rm = e.target.closest('[data-attach-remove]');
    if (rm) {
      const a = db.attachments.find((x) => x.id === rm.dataset.attachRemove);
      const [row] = await run(sb.from('attachments').update({ archived_at: new Date().toISOString() }).eq('id', a.id).select());
      Object.assign(a, row);
      draw();
      app.render();
      toast(`Removed ${a.name}`, { label: 'Undo', run: async () => { const [r] = await run(sb.from('attachments').update({ archived_at: null }).eq('id', a.id).select()); Object.assign(a, r); draw(); app.render(); } });
      return;
    }
    const pr = e.target.closest('[data-pending-remove]');
    if (pr) { pending.splice(Number(pr.dataset.pendingRemove), 1); draw(); }
  });
  draw();
  return () => pending.splice(0);
}
