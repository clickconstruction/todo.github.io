// Capture from anywhere: POST /capture with a capture key (scope 'capture', made in Settings) adds one
// Inbox item, with any files attached. Used by the iPhone Shortcut (Siri, lock screen, Share sheet).
// The key can only add; it can't read, change or delete anything.
//   JSON: { title?, text?, notes?, gain?, url?, files?: [{ name, base64, mime }] }
//   The gain can also ride in the title ("Idea → gain") or a "Gain:" line in the text.
//   or multipart/form-data: title / text / url fields, and file fields.
// And for email: [3d] / [1w] / [fri] follow-up tags in a subject.

import { splitGain, gainFromText } from '../../js/gain.js';

const MAX_BYTES = 25 * 1024 * 1024;

export async function captureAuth(request, env, { rest, sha256Hex }, ctx) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(tt_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const rows = await rest(`api_tokens?token_hash=eq.${await sha256Hex(m[1])}&select=id,user_id,scope`);
  if (!rows.length || !['capture', 'full'].includes(rows[0].scope)) return null;
  const touch = rest(`api_tokens?id=eq.${rows[0].id}`, { method: 'PATCH', body: { last_used_at: new Date().toISOString() } }).catch(() => {});
  if (ctx) ctx.waitUntil(touch);
  return { userId: rows[0].user_id };
}

const b64ToBytes = (s) => Uint8Array.from(atob(String(s).replace(/^data:[^,]*,/, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));

// → { title, notes, files: [{ name, bytes, mime }] }
export async function readCapture(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  let fields = {}; const files = [];
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData();
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') { if (!fields[k]) fields[k] = v; }
      else if (v && v.size) files.push({ name: v.name || 'file', bytes: new Uint8Array(await v.arrayBuffer()), mime: v.type || 'application/octet-stream' });
    }
  } else if (type.includes('application/json')) {
    fields = await request.json().catch(() => ({})) || {};
    for (const f of Array.isArray(fields.files) ? fields.files : []) if (f && f.base64) files.push({ name: f.name || 'file', bytes: b64ToBytes(f.base64), mime: f.mime || 'application/octet-stream' });
  } else if (!type || type.startsWith('text/')) {
    fields = { text: await request.text() }; // plain text body (Shortcuts "File" body with text or a link)
  } else {
    // A photo, PDF or other file sent as the whole body (Shortcuts "File" body from the Share sheet).
    const ext = { 'image/jpeg': 'jpg', 'image/heic': 'heic', 'image/png': 'png', 'application/pdf': 'pdf' }[type.split(';')[0]] || 'bin';
    const name = decodeURIComponent(request.headers.get('X-Filename') || '') || `${type.startsWith('image/') ? 'Photo' : 'File'}.${ext}`;
    files.push({ name, bytes: new Uint8Array(await request.arrayBuffer()), mime: type.split(';')[0] });
  }
  const text = String(fields.text || '').replace(/\r\n/g, '\n').trim();
  const url = String(fields.url || '').trim();
  const lines = text.split('\n').filter((l) => l.trim());
  let title = String(fields.title || '').trim() || lines[0] || '';
  const rest = fields.title ? text : lines.slice(1).join('\n');
  // A bare link as the whole text: keep it as the link.
  let link = url;
  if (!link && /^https?:\/\/\S+$/i.test(title)) { link = title; title = ''; }
  if (!title) title = link ? link.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 120) : files[0] ? (files[0].mime.startsWith('image/') ? 'Photo' : files[0].name) : 'Captured item';
  const split = splitGain(title);
  const fromText = gainFromText(rest);
  const gain = (String(fields.gain || '').trim() || split.gain || fromText.gain).slice(0, 500);
  title = split.title || title;
  const notes = [String(fields.notes || '').trim(), fromText.rest, link && link !== title ? link : ''].filter(Boolean).join('\n\n');
  return { title: title.slice(0, 300), notes: notes.slice(0, 6000), gain, files, test: fields.test === true || fields.test === 'true' };
}

export async function handleCapture(request, env, ctx, { rest, sha256Hex, json, cors, makeApi }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const who = await captureAuth(request, env, { rest, sha256Hex }, ctx);
  if (!who) return json({ error: 'Capture key not recognized. Make a new one in Settings → Capture from anywhere.' }, 401);
  let item;
  try { item = await readCapture(request); } catch (e) { return json({ error: `Couldn’t read that: ${e.message}` }, 400); }
  if (item.test) return json({ ok: true, test: true, message: 'Captured ✓ (test: nothing was added)' }); // Settings → Send a test
  const total = item.files.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (total > MAX_BYTES) return json({ error: 'Files are limited to 25 MB in total.' }, 413);
  const api = makeApi(who.userId);
  if (item.title === 'Photo') { // "Photo · 3:42 PM" in the user's time zone
    await api.loadSettings();
    item.title = `Photo · ${new Date().toLocaleTimeString('en-US', { timeZone: api.tz, hour: 'numeric', minute: '2-digit' })}`;
  }
  const [row] = await rest('tasks', { method: 'POST', prefer: 'return=representation', body: { user_id: who.userId, title: item.title, notes: item.notes, gain: item.gain, in_inbox: true, source: 'capture' } });
  let attached = 0;
  for (const f of item.files) { await api.upload('task_id', row.id, f.name, f.bytes, f.mime); attached += 1; }
  return json({ ok: true, id: row.id, title: row.title, attachments: attached, message: `Captured ✓ ${row.title}` });
}

// Follow-up tag in an email subject: [3d] [2w] [1m] [fri] [tomorrow]. → { subject, days } (days null = none)
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function followTag(subject, now = new Date(), tz = 'America/Chicago') {
  const m = String(subject || '').match(/\[\s*(\d{1,2})\s*([dwm])\s*\]|\[\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*\]|\[\s*(tomorrow|tmrw)\s*\]/i);
  if (!m) return { subject: String(subject || '').trim(), days: null };
  const clean = String(subject).replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
  let days;
  if (m[1]) days = Number(m[1]) * ({ d: 1, w: 7, m: 30 }[m[2].toLowerCase()]);
  else if (m[4]) days = 1;
  else {
    const today = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now).toLowerCase().slice(0, 3);
    days = ((DAYS.indexOf(m[3].toLowerCase()) - DAYS.indexOf(today) + 7) % 7) || 7;
  }
  return { subject: clean, days: Math.min(Math.max(days, 1), 365) };
}

// "Jodi Park <jodi@x.com>" → a display name (from the header, else the mailbox: jodi.park → Jodi Park).
export const nameFor = (addr) => {
  const n = String(addr.name || '').replace(/["']/g, '').trim();
  if (n && !n.includes('@')) return n.slice(0, 100);
  return String(addr.address || '').split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 100) || addr.address;
};
