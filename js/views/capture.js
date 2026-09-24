// Capture from anywhere: capture keys (scope 'capture': can only add to the Inbox) and the step-by-step
// guide to the iPhone Shortcut "Add to Todo" (Siri, lock screen, Action button, Share sheet).
// Plus things shared to the app (Android / desktop Share menu), which the service worker hands over.
import { db, app, sb, run, esc, toast, openSheet, $ } from '../state.js';
import { uploadFiles } from '../editors/attachField.js';

export const CAPTURE_URL = 'https://mcp.todotooling.com/capture';

async function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'tt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return { token, token_hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

// One key per device, so a lost phone can be revoked without breaking the others.
export async function createCaptureKey(after = () => {}) {
  const name = prompt('Which device is this key for?', /iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone');
  if (!name || !name.trim()) return;
  const { token, token_hash } = await newToken();
  await run(sb.from('api_tokens').insert({ name: `${name.trim()} (capture)`, token_hash, token_hint: token.slice(-4), scope: 'capture' }));
  await after();
  openCaptureGuide(token);
}

const copyRow = (label, value, show = value) => `<div class="cap-copy"><span class="hint">${esc(label)}</span><code>${esc(show)}</code><button type="button" class="btn small" data-copy-value="${esc(value)}">Copy</button></div>`;

export function openCaptureGuide(token = null) {
  const auth = token ? `Bearer ${token}` : 'Bearer (your capture key)';
  const sheet = openSheet(`<form method="dialog" class="cap-guide"><h2>Add to Todo: an iPhone Shortcut</h2>
    ${token ? '<p class="persp-warning">Copy the key now. It won’t be shown again (you can always make a new one).</p>' : '<p class="hint">You’ll need a capture key: create one in Settings, and this guide opens with it filled in.</p>'}
    <ol class="cap-steps">
      <li><b>Open Shortcuts</b>, tap <b>+</b>, and name it <b>Add to Todo</b> (that’s what you’ll say to Siri).</li>
      <li>Tap <b>ⓘ</b> (Details): turn on <b>Show in Share Sheet</b>. Under <b>If there’s no input</b>, choose <b>Ask For → Text</b>. Siri then asks “What’s the text?” and you dictate.</li>
      <li>Add the action <b>Get Contents of URL</b>. Set:
        ${copyRow('URL', CAPTURE_URL)}
        <span class="hint">Method</span> <b>POST</b> · <span class="hint">Headers</span> add <b>Authorization</b>:
        ${copyRow('Header value', auth, token ? `Bearer ${token.slice(0, 8)}…${token.slice(-4)}` : auth)}
        <span class="hint">Request Body</span> <b>File</b> → <b>Shortcut Input</b>.</li>
      <li>Add <b>Show Notification</b> with <b>Captured ✓</b> (optional, so you know it landed).</li>
      <li>Try it: <b>“Hey Siri, Add to Todo”</b>. Or share a link, photo or PDF and pick <b>Add to Todo</b>. You can also put it on the Action button, a Lock Screen widget or the Home Screen.</li>
    </ol>
    ${token ? '<div class="test-buttons"><button type="button" class="btn primary" data-cap-test>Send a test</button><span class="test-status" data-cap-status></span></div>' : ''}
    <p class="hint">A capture key can only add to your Inbox. It can’t read, change or delete anything. Revoke it in Settings if a phone is lost.</p>
    <div class="actions"><div class="right"><button class="btn">Done</button></div></div></form>`);
  sheet.classList.add('full');
  sheet.querySelectorAll('[data-copy-value]').forEach((b) => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyValue); toast('Copied'); } catch { toast('Couldn’t copy'); } }; });
  const test = $('[data-cap-test]', sheet);
  if (test) test.onclick = async () => {
    const st = $('[data-cap-status]', sheet);
    st.textContent = 'Sending…';
    try {
      const res = window.__captureFetch ? await window.__captureFetch(token) : await fetch(CAPTURE_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Test from Settings', test: true }) }).then((r) => r.json());
      st.textContent = res.ok ? '✓ The key works. Nothing was added.' : `✗ ${res.error || 'Didn’t work'}`;
      st.className = `test-status ${res.ok ? 'ok' : 'warn'}`;
    } catch { st.textContent = '✗ Couldn’t reach the server'; st.className = 'test-status warn'; }
  };
  sheet.showModal();
}

export function captureSection(keys) {
  return `<h2 class="section-title">Capture from anywhere</h2>
    <p class="view-sub">“Hey Siri, Add to Todo”, the Lock Screen, the Action button and the Share sheet: an iPhone Shortcut sends what you say or share straight to your Inbox. Each device gets its own capture key, which can only add to your Inbox.</p>
    <p><button class="btn primary" data-act="new-capture-key">Create a capture key</button> <button class="btn" data-act="capture-guide">Shortcut steps</button></p>
    ${keys.length ? `<ul class="list">${keys.map((t) => `<li class="row" style="cursor:default"><div class="row-main"><div class="row-title">${esc(t.name)} <span class="chip">…${esc(t.token_hint)}</span> <span class="chip">📥 Inbox only</span></div>
      <div class="row-meta"><span>${t.last_used_at ? `Last used ${esc(new Date(t.last_used_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : 'Never used'}</span></div></div>
      <button class="btn small danger" data-revoke="${t.id}">Revoke</button></li>`).join('')}</ul>` : ''}
    <p class="hint">On Android or a computer, install the app and it appears in the Share menu too.</p>`;
}

// ---------- shared to the app (the service worker stashes it, then opens #share) ----------
export const viewShare = () => '<div class="cl-done"><div class="cl-big">📥</div><h2>Adding to your Inbox…</h2></div>';
export async function mountShare() {
  let meta = null; const files = [];
  try {
    const cache = await caches.open('todo-share');
    const m = await cache.match('/__share/meta');
    if (m) {
      meta = await m.json();
      for (const f of meta.files || []) {
        const r = await cache.match(`/__share/file/${f.i}`);
        if (r) files.push(new File([await r.blob()], f.name, { type: f.type }));
        await cache.delete(`/__share/file/${f.i}`);
      }
      await cache.delete('/__share/meta');
    }
  } catch { /* no cache API */ }
  if (!meta) { location.hash = '#inbox'; return; }
  const text = String(meta.text || '').trim();
  const url = String(meta.url || '').trim() || ((text.match(/https?:\/\/\S+/) || [])[0] || '');
  const title = (String(meta.title || '').trim() || text.split('\n')[0].replace(url, '').trim() || (url ? url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 120) : '') || (files[0] ? (files[0].type.startsWith('image/') ? `Photo · ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : files[0].name) : 'Shared item')).slice(0, 300);
  const notes = [text !== title ? text : '', url && !text.includes(url) ? url : ''].filter(Boolean).join('\n\n');
  const [row] = await run(sb.from('tasks').insert({ title, notes, in_inbox: true, source: 'share' }).select());
  db.tasks.push(row);
  if (files.length) await uploadFiles('task_id', row.id, files);
  location.hash = '#inbox';
  app.render();
  toast(`Shared to your Inbox: ${title}`);
}

// People a BCC'd email created: mention each once, so nothing appears silently.
export function noticeEmailPeople() {
  let seen;
  try { seen = new Set(JSON.parse(localStorage.getItem('todo.people.seen') || '[]')); } catch { seen = new Set(); }
  const fresh = (db.people || []).filter((p) => p.added_via === 'email' && !seen.has(p.id) && Date.now() - Date.parse(p.created_at) < 14 * 86400000);
  if (!fresh.length) return;
  fresh.forEach((p) => seen.add(p.id));
  try { localStorage.setItem('todo.people.seen', JSON.stringify([...seen].slice(-500))); } catch { /* private mode */ }
  const names = fresh.map((p) => p.name);
  toast(`${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''} added from email`, [{ label: 'Open', run: () => { location.hash = fresh.length === 1 ? `#person/${fresh[0].id}` : '#waiting'; } }]);
}
