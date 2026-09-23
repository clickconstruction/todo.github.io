import worker, { isAuthenticated, emailToTask } from './src/index.js';
import { createHash } from 'node:crypto';
const TOKEN = 'tt_' + 'a'.repeat(32);
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const UID = '11111111-1111-1111-1111-111111111111';
const db = { tasks: [], tags: [], task_tags: [], projects: [], folders: [], api_tokens: [{ id: 't1', user_id: UID, token_hash: HASH, scope: 'full' }], email_senders: [{ id: 'e1', user_id: UID, email: 'robert@douglasmining.com' }], project_tags: [], places: [], push_subscriptions: [], notifications: [], attachments: [], push_log: [], item_history: [] };
let n = 0; const id = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
// Tiny PostgREST imitation: eq/is/in filters, POST/PATCH/DELETE.
const pushed = []; // requests to push services
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('https://places.googleapis.com')) {
    const q = JSON.parse(init.body).textQuery;
    if (init.headers['X-Goog-Api-Key'] !== 'server-key' || /nowhere/i.test(q)) return new Response(JSON.stringify({}), { status: 200 });
    return new Response(JSON.stringify({ places: [{ id: 'gp1', displayName: { text: 'The Home Depot' }, formattedAddress: '5445 W Alabama St, Houston, TX', location: { latitude: 29.7351, longitude: -95.4710 } }] }), { status: 200 });
  }
  if (String(url).includes('/storage/v1/object/sign/')) { return new Response(JSON.stringify({ signedURL: `/object/sign/attachments/${String(url).split('/sign/attachments/')[1]}?token=t` }), { status: 200 }); }
  if (String(url).includes('/storage/v1/object/attachments/')) {
    globalThis.stored = globalThis.stored || {};
    const key = decodeURIComponent(String(url).split('/object/attachments/')[1]);
    if (!init.headers.apikey) return new Response('no key', { status: 401 });
    globalThis.stored[key] = { body: init.body, type: init.headers['Content-Type'] };
    return new Response(JSON.stringify({ Key: key }), { status: 200 });
  }
  if (String(url).startsWith('https://files.example')) return new Response('drawing bytes', { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (String(url).includes('/auth/v1/user')) {
    const auth = init.headers.Authorization || '';
    return auth === 'Bearer user-jwt' ? new Response(JSON.stringify({ id: UID }), { status: 200 }) : new Response('{}', { status: 401 });
  }
  if (String(url).startsWith('https://push.example')) { pushed.push({ url: String(url), init }); return String(url).includes('gone') ? new Response(null, { status: 410 }) : String(url).includes('badjwt') ? new Response('{"reason":"BadJwtToken"}', { status: 403 }) : new Response(null, { status: 201 }); }
  const rpcCalls = globalThis.rpcCalls = globalThis.rpcCalls || [];
  if (String(url).includes('/rest/v1/rpc/')) { rpcCalls.push({ fn: String(url).split('/rpc/')[1], body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }
  const u = new URL(url); const table = u.pathname.split('/').pop();
  const filters = [...u.searchParams].filter(([k]) => !['select','order','limit','or'].includes(k));
  const ors = [...u.searchParams].filter(([k]) => k === 'or').map(([, v]) => v.slice(1, -1).match(/[a-z_]+\.(?:ilike\.\*[^*]*\*|in\.\([^)]*\)|not\.is\.null|is\.null|(?:lt|lte|gte|gt|eq)\.[^,)]+)/g) || []);
  const orMatch = (r) => ors.every((conds) => conds.some((c) => {
    const [k, op, ...rest] = c.split('.'); const v = rest.join('.');
    if (op === 'ilike') return (r[k] || '').toLowerCase().includes(decodeURIComponent(v).replace(/\*/g, '').toLowerCase());
    if (op === 'in') return v.slice(1, -1).split(',').map((x) => x.replace(/"/g, '')).includes(String(r[k]));
    if (op === 'not') return r[k] != null;
    if (op === 'is') return r[k] == null;
    if (op === 'lt') return r[k] != null && r[k] < v;
    if (op === 'lte') return r[k] != null && r[k] <= v;
    if (op === 'gt') return r[k] != null && r[k] > v;
    if (op === 'gte') return r[k] != null && r[k] >= v;
    if (op === 'eq') return String(r[k]) === v;
    return false;
  }));
  const match = (r) => filters.every(([k, v]) => {
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    if (op === 'eq') return String(r[k]) === val;
    if (op === 'is') return val === 'null' ? r[k] == null : String(r[k]) === val;
    if (op === 'in') return val.slice(1, -1).split(',').map(s => s.replace(/"/g,'')).includes(String(r[k]));
    if (op === 'not') return r[k] != null;
    if (op === 'lt') return r[k] && r[k] < val;
    if (op === 'gte') return r[k] && r[k] >= val;
    if (op === 'lte') return r[k] != null && (typeof r[k] === 'number' ? r[k] <= Number(val) : r[k] <= val);
    return true;
  });
  const m = init.method || 'GET'; const rows = db[table];
  const body = init.body ? JSON.parse(init.body) : null;
  const res = (d, s = 200) => new Response(d === null ? null : JSON.stringify(d), { status: s });
  if (m === 'GET') return res(rows.filter((r) => match(r) && orMatch(r)));
  if (m === 'POST') { const add = (Array.isArray(body) ? body : [body]).map(b => ({ id: id(), in_inbox: true, flagged: false, notes: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), parent_id: null, project_id: null, completed_at: null, dropped_at: null, due_at: null, defer_at: null, status: 'active', place_id: null, location_trigger: null, location_radius_m: null, ...(table === 'places' ? { radius_m: 402, archived_at: null, address: '', notes: '' } : {}), ...b })); rows.push(...add); return init.headers.Prefer ? res(add, 201) : res(null, 201); }
  if (m === 'PATCH') { rows.filter(match).forEach(r => Object.assign(r, body, 'updated_at' in r ? { updated_at: new Date().toISOString() } : {})); return res(null, 204); }
  if (m === 'DELETE') { db[table] = rows.filter(r => !match(r)); return res(null, 204); }
};
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', TIMEZONE: 'America/Chicago' };
const ctx = { waitUntil() {} };
const call = async (method, params, token = TOKEN) => {
  const r = await worker.fetch(new Request('https://mcp.todotooling.com/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env, ctx);
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
};
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); const c = r.body.result; if (c.isError) throw new Error(c.content[0].text); return JSON.parse(c.content[0].text); };
const localToday = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };

assert((await call('initialize', { protocolVersion: '2025-06-18' }, 'tt_wrongwrongwrongwrongwrong')).status === 401, 'bad token -> 401');
const init = await call('initialize', { protocolVersion: '2025-06-18' });
assert(init.body.result.protocolVersion === '2025-06-18' && init.body.result.capabilities.tools, 'initialize');
assert((await worker.fetch(new Request('https://mcp.todotooling.com/mcp', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }), env, ctx)).status === 202, 'notification -> 202');
const list = await call('tools/list');
const TOOL_NAMES = list.body.result.tools.map((x) => x.name);
assert(list.body.result.tools.length === 29 && list.body.result.tools.every(t => t.inputSchema && !t.run), 'tools/list: 29 tools, no internals leaked');
const cap = await tool('capture', { title: 'Call GVEC about utilities' });
assert(cap.in_inbox && cap.title === 'Call GVEC about utilities', 'capture lands in inbox');
assert((await tool('list_inbox', {})).count === 1, 'list_inbox shows it');
await tool('create_project', { name: 'Click Plumbing', folder: 'PRIORITIES' });
const up = await tool('update_task', { id: cap.id, project: 'click plumbing', tags: ['Phone', 'Waiting : Hiro'], due: '2026-09-25', flagged: true });
assert(!up.in_inbox && up.project === 'Click Plumbing' && up.tags.includes('Waiting : Hiro') && up.due === '2026-09-25' && up.flagged, 'update_task clarifies out of inbox');
assert(db.task_tags.every(l => l.user_id === UID), 'task_tags scoped to user');
const byTag = await tool('list_tasks', { tag: 'Waiting' });
assert(byTag.count === 1, 'parent tag filter includes children');
const tags = await tool('list_tags', {});
assert(tags.find(t => t.label === 'Waiting : Hiro').open_tasks === 1, 'list_tags counts');
const projs = await tool('list_projects', {});
assert(projs[0].folder === 'PRIORITIES' && projs[0].open_actions === 1, 'list_projects with folder + counts');
const oneShot = await tool('capture', { title: 'Schedule backflow test', project: 'click plumbing', tags: ['Phone', 'Waiting : Hiro'], due: '2026-10-01', planned: '2026-09-28', flagged: true });
assert(oneShot.planned === '2026-09-28' && db.tasks.find((x) => x.id === oneShot.id).planned_at === '2026-09-28T14:00:00.000Z', 'capture: planned date at 9am local');
assert(!oneShot.in_inbox && oneShot.project === 'Click Plumbing' && oneShot.tags.length === 2 && oneShot.due === '2026-10-01' && oneShot.flagged, 'capture sets project, tags, due, flag in one call');
assert((await tool('list_tasks', { search: 'backflow hiro' })).count === 1, 'search: words across title + tag must all match');
assert((await tool('list_tasks', { search: 'plumbing' })).items.some((x) => x.title === 'Schedule backflow test'), 'search: matches project name');
assert((await tool('list_tasks', { search: 'backflow nope' })).count === 0, 'search: every word must match');
await tool('create_project', { name: 'Seq', kind: 'sequential', complete_with_last: true });
const s1 = await tool('capture', { title: 'Seq first', project: 'Seq' });
const s2 = await tool('capture', { title: 'Seq second', project: 'Seq' });
assert(db.tasks.find((x) => x.id === s2.id).sort > db.tasks.find((x) => x.id === s1.id).sort, 'capture into project appends at the end');
await tool('update_task', { id: s2.id, move: 'top' });
const afterMove = await tool('list_tasks', { project: 'Seq', available_only: true });
assert(afterMove.items[0].id === s2.id, 'update_task move: top changes the sequential head');
await tool('update_task', { id: s2.id, move: 'bottom' });
const ct = await tool('create_tag', { label: 'Waiting : Mark' });
assert(ct.label === 'Waiting : Mark' && (await tool('create_tag', { label: 'waiting : mark' })).id === ct.id, 'create_tag nests and is idempotent');
const nextActs = await tool('list_tasks', { project: 'Seq', available_only: true });
assert(nextActs.count === 1 && nextActs.items[0].id === s1.id, 'available_only: sequential shows only the head');
const seqRow = (await tool('list_projects', {})).find((x) => x.name === 'Seq');
assert(seqRow.kind === 'sequential' && seqRow.complete_with_last && seqRow.next_action.id === s1.id, 'list_projects: kind, auto-complete, next action');
const est = await tool('update_task', { id: s1.id, estimate_minutes: 10 });
assert(est.estimate_minutes === 10, 'update_task: estimate');
assert((await tool('list_tasks', { project: 'Seq', max_minutes: 15 })).items.every((x) => x.estimate_minutes <= 15), 'list_tasks: max_minutes');
const pTagged = await tool('update_project', { project: 'Seq', flagged: true, tags: ['Errands'] });
assert(pTagged.flagged && pTagged.tags.join() === 'Errands', 'update_project: flag + tags');
const viaTag = await tool('list_tasks', { tag: 'Errands' });
assert(viaTag.count === 2 && viaTag.items[0].project_tags.includes('Errands'), 'tag filter includes actions inherited from project tags');
const fc = await tool('forecast', { days: 30 });
assert(fc.days['2026-09-28'] && fc.days['2026-09-28'].planned.some((x) => x.title === 'Schedule backflow test') && fc.days['2026-10-01'].due.some((x) => x.title === 'Schedule backflow test'), 'forecast: planned and due land on their days');
db.projects.forEach((x) => { if (!x.next_review_at) x.next_review_at = '2020-01-01T00:00:00Z'; });
const lr = await tool('list_review', {});
const seqReview = lr.projects.find((x) => x.name === 'Seq');
assert(lr.due_count >= 1 && seqReview && Array.isArray(seqReview.hints) && seqReview.next_action, 'list_review: due projects with next action + hints');
const mr = await tool('mark_reviewed', { project: 'Seq' });
assert(mr.last_reviewed === localToday(), 'mark_reviewed stamps today');
const ri = await tool('update_project', { project: 'Seq', review_every_days: 30 });
assert(db.projects.find((x) => x.name === 'Seq').review_every_days === 30, 'update_project: review interval');
const fl = await tool('list_flagged', {});
assert(fl.count >= 2 && fl.by_project.Seq && fl.by_project.Seq.length === 2, 'list_flagged includes actions of flagged projects');
const kindChange = await tool('update_project', { project: 'Seq', kind: 'parallel', complete_with_last: false });
assert(kindChange.kind === 'parallel' && kindChange.complete_with_last === false, 'update_project: kind + complete_with_last');
assert((await tool('list_tasks', { project: 'Seq', available_only: true })).count === 2, 'parallel: all available');
const moved = await tool('update_project', { project: 'Click Plumbing', folder: 'Businesses', status: 'on_hold' });
assert(moved.folder === 'Businesses' && moved.status === 'on_hold' && db.folders.length === 2, 'update_project moves to new folder + status');
const unfiled = await tool('update_project', { project: 'click plumbing', folder: null, name: 'Click Plumbing Co' });
assert(unfiled.folder === null && unfiled.name === 'Click Plumbing Co', 'update_project removes folder + renames');
const nf = await tool('create_folder', { name: 'Personal' });
const again = await tool('create_folder', { name: 'personal' });
assert(nf.id === again.id, 'create_folder is idempotent by name');
const ren = await tool('update_folder', { folder: 'Personal', name: 'Home' });
assert(ren.name === 'Home' && !ren.archived, 'update_folder renames');
const arch = await tool('update_folder', { folder: 'Home', archived: true });
assert(arch.archived, 'update_folder archives an empty folder');
const lf = await tool('list_folders', {});
assert(!lf.find((f) => f.name === 'Home') && (await tool('list_folders', { include_archived: true })).find((f) => f.name === 'Home').archived, 'list_folders hides archived unless asked');
assert(!TOOL_NAMES.some((n) => /delete/.test(n)), 'no delete tools exposed');
const sub = await tool('capture', { title: 'Get meter number' });
const subbed = await tool('update_task', { id: sub.id, project: 'Click Plumbing Co', parent: cap.id, add_tags: ['Phone'] });
assert(subbed.parent_id === cap.id && subbed.project === 'Click Plumbing Co' && !subbed.in_inbox && subbed.tags.join() === 'Phone', 'update_task: subtask + add_tags');
const groupView = await tool('get_task', { id: cap.id });
assert(groupView.sub_actions && groupView.sub_actions[0].id === sub.id, 'get_task lists sub-actions of a group');
const pruned = await tool('update_task', { id: sub.id, remove_tags: ['phone'], project: null });
assert(pruned.tags.length === 0 && !pruned.parent_id && pruned.in_inbox, 'update_task: removing project+tags returns item to Inbox (and detaches parent)');
const dropped = await tool('update_task', { id: sub.id, status: 'dropped' });
assert(dropped.status === 'dropped', 'update_task: drop');
const reopened = await tool('update_task', { id: sub.id, status: 'open' });
assert(reopened.status === 'open', 'update_task: reopen');
const done = await tool('complete_task', { id: cap.id, note: 'Spoke to Jan; bill moves next cycle' });
assert(done.completed_at && done.completion_note === 'Spoke to Jan; bill moves next cycle', 'complete_task records time + note');
const again2 = await tool('complete_task', { id: cap.id, note: 'Updated note' });
assert(again2.completed_at === done.completed_at, 'editing the note keeps the original completion time');
const review = await tool('list_completed', {});
assert(review.count >= 1 && review.by_project['Click Plumbing Co'] === 1 && review.items[0].completion_note === 'Updated note' && Object.values(review.by_day)[0] === 1, 'list_completed: this week, by project and day, with note');
assert((await tool('list_completed', { since: '2020-01-01', until: '2020-01-31' })).count === 0, 'list_completed respects date range');
assert((await tool('list_completed', { project: 'none' })).count === 0, 'list_completed filters by project');
const bad = await call('tools/call', { name: 'get_task', arguments: { id: 'nope' } });
assert(bad.body.result.isError, 'invalid id -> tool error, not crash');
const utcDue = db.tasks[0].due_at;
assert(utcDue === '2026-09-25T22:00:00.000Z', `due 5pm Chicago stored as ${utcDue}`);

// ---------- email capture ----------
assert(isAuthenticated('mx.cloudflare.net; dkim=pass header.d=douglasmining.com header.s=google; spf=pass smtp.mailfrom=robert@douglasmining.com; dmarc=pass', 'douglasmining.com'), 'auth: dmarc pass');
assert(isAuthenticated('dkim=pass header.d=douglasmining.com; dmarc=none', 'douglasmining.com'), 'auth: aligned dkim');
assert(isAuthenticated('dkim=fail; spf=pass smtp.mailfrom=bounce@mail.douglasmining.com', 'douglasmining.com'), 'auth: aligned spf subdomain');
assert(!isAuthenticated('dkim=pass header.d=evil.com; spf=pass smtp.mailfrom=x@evil.com; dmarc=fail', 'douglasmining.com'), 'auth: unaligned pass rejected');
assert(!isAuthenticated('', 'douglasmining.com'), 'auth: missing results rejected');
const t1 = emailToTask({ subject: 'Fwd: RE: Plans for Jodi', text: 'Please release all three.\r\n\r\n\r\n\r\nThanks', date: '2026-09-22T12:00:00Z', attachments: [{ filename: 'plans.pdf' }] }, 'robert@douglasmining.com');
assert(t1.title === 'Plans for Jodi' && t1.notes.includes('Attachments (not saved): plans.pdf') && !t1.notes.includes('\n\n\n'), 'emailToTask cleans subject, notes, attachments');
assert(emailToTask({ subject: '', html: '<p>Call GVEC</p><p>re: utilities</p>' }, 'a@b.c').title === 'Call GVEC', 'emailToTask falls back to first body line (html)');

const raw = (from, subject, body) => [`From: Robert <${from}>`, 'To: inbox@todotooling.com', `Subject: ${subject}`, 'Date: Tue, 22 Sep 2026 17:00:00 -0500', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
const mail = (from, subject, body, auth) => { const m = { from, raw: raw(from, subject, body), headers: new Headers(auth ? { 'arc-authentication-results': auth } : {}), rejected: null, setReject(r) { this.rejected = r; } }; return m; };
const before = db.tasks.length;
const good = mail('robert@douglasmining.com', 'Fwd: Call 1st mortgage', 'Ask where to mail payment', 'i=1; mx.cloudflare.net; dkim=pass header.d=douglasmining.com; dmarc=pass');
await worker.email(good, env);
const made = db.tasks[db.tasks.length - 1];
assert(!good.rejected && db.tasks.length === before + 1 && made.title === 'Call 1st mortgage' && made.source === 'email' && made.user_id === UID && made.in_inbox, 'email from approved sender becomes inbox task');
const stranger = mail('someone@else.com', 'Buy crypto', 'spam', 'dmarc=pass');
await worker.email(stranger, env);
assert(stranger.rejected && db.tasks.length === before + 1, 'unknown sender rejected, no task');
const spoof = mail('robert@douglasmining.com', 'Spoofed', 'x', 'dkim=pass header.d=evil.com; dmarc=fail');
await worker.email(spoof, env);
assert(spoof.rejected && db.tasks.length === before + 1, 'spoofed From rejected, no task');

// ---------- Web Push crypto ----------
const { encryptPayload, vapidHeader, unb64url, b64url } = await import('./src/push.js');
const subtle = crypto.subtle;
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const keys = { p256dh: b64url(uaPub), auth: b64url(authSecret) };
const hk = async (salt, ikm, info, len) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
async function decrypt(body) { // what the browser does (RFC 8291)
  const salt = body.slice(0, 16); const idlen = body[20]; const asPub = body.slice(21, 21 + idlen); const cipher = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const te = new TextEncoder(); const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; a.forEach((x) => { o.set(x, i); i += x.length; }); return o; };
  const ikm = await hk(authSecret, ecdh, cat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
  assert(plain[plain.length - 1] === 2, 'push: final-record delimiter');
  return new TextDecoder().decode(plain.slice(0, -1));
}
const msg = JSON.stringify({ title: '📍 You’re at Home Depot', body: 'Buy fuel filter' });
const sealed = await encryptPayload(msg, keys);
assert(new DataView(sealed.buffer).getUint32(16) === 4096 && sealed[20] === 65, 'push: aes128gcm header (rs 4096, 65-byte key id)');
assert(await decrypt(sealed) === msg, 'push: payload decrypts to the original (RFC 8291 round trip)');
const vapid = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
env.VAPID_PRIVATE_JWK = JSON.stringify(await subtle.exportKey('jwk', vapid.privateKey));
env.VAPID_PUBLIC_KEY = b64url(await subtle.exportKey('raw', vapid.publicKey));
const vh = await vapidHeader('https://push.example.com/abc', env);
const [, jwt, k] = vh.match(/^vapid t=([^,]+), k=(.+)$/);
const [h, c, sig] = jwt.split('.');
assert(JSON.parse(new TextDecoder().decode(unb64url(c))).aud === 'https://push.example.com' && k === env.VAPID_PUBLIC_KEY, 'vapid: audience is the push origin, key attached');
assert(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vapid.publicKey, unb64url(sig), new TextEncoder().encode(`${h}.${c}`)), 'vapid: ES256 signature verifies');

// ---------- /geo (iPhone Shortcuts automation) ----------
const GEO = 'tt_' + 'g'.repeat(32);
db.api_tokens.push({ id: 'tg', user_id: UID, token_hash: createHash('sha256').update(GEO).digest('hex'), scope: 'geo' });
const PL = '22222222-2222-2222-2222-222222222222';
const PL2 = '33333333-3333-3333-3333-333333333333';
db.places.push({ id: PL, user_id: UID, name: 'Home Depot', lat: 29.76, lng: -95.37, radius_m: 402, archived_at: null },
  { id: PL2, user_id: UID, name: 'Old unit', lat: 29.9, lng: -95.5, radius_m: 402, archived_at: '2026-01-01T00:00:00Z' });
const tag = { id: 'gt1', user_id: UID, name: 'Hardware', parent_id: null, place_id: PL, location_trigger: 'nearby', location_radius_m: null };
db.tags.push(tag);
const mk = (o) => { const t = { id: id(), user_id: UID, parent_id: null, project_id: null, completed_at: null, dropped_at: null, defer_at: null, place_id: null, location_trigger: null, location_radius_m: null, ...o }; db.tasks.push(t); return t; };
mk({ title: 'Buy fuel filter', place_id: PL, location_trigger: 'arrive' });
const tagged = mk({ title: 'Screws' });
db.task_tags.push({ task_id: tagged.id, tag_id: 'gt1', user_id: UID });
mk({ title: 'Return drill (on leaving)', place_id: PL, location_trigger: 'leave' });
mk({ title: 'Deferred caulk', place_id: PL, location_trigger: 'arrive', defer_at: '2099-01-01T00:00:00Z' });
mk({ title: 'No alert here', place_id: PL });
db.push_subscriptions.push({ id: 'ps1', user_id: UID, endpoint: 'https://push.example.com/dev1', ...keys }, { id: 'ps2', user_id: UID, endpoint: 'https://push.example.com/gone', ...keys });
const geo = async (qs, init = {}) => { const r = await worker.fetch(new Request(`https://mcp.todotooling.com/geo?${qs}`, init), env, ctx); return { status: r.status, body: await r.json() }; };
let g = await geo(`t=${GEO}&place=${PL}&event=arrive`);
assert(g.status === 200 && g.body.actions.sort().join('|') === 'Buy fuel filter|Screws', `geo arrive: own "arrive" + tag-inherited "nearby"; not leave, deferred or alert-less (${g.body.actions})`);
assert(g.body.devices === 2 && g.body.sent === 1 && pushed.length === 2, 'geo: pushed to every device');
assert(!db.push_subscriptions.some((s) => s.id === 'ps2'), 'geo: expired (410) subscription removed');
const last = pushed[0];
assert(last.init.headers['Content-Encoding'] === 'aes128gcm' && /^vapid t=/.test(last.init.headers.Authorization), 'geo: push request is encrypted and VAPID-signed');
assert(JSON.parse(await decrypt(new Uint8Array(last.init.body))).title === '📍 You’re at Home Depot', 'geo: device can read the notification');
g = await geo(`t=${GEO}&place=${PL}&event=leave`);
assert(g.body.actions.join() === 'Return drill (on leaving)', 'geo leave: only leave alerts');
g = await geo('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: GEO, event: 'test' }) });
assert(g.status === 200 && g.body.sent === 1, 'geo test (POST body) sends a test notification');
assert((await geo(`t=${GEO}&place=${PL2}&event=arrive`)).status === 404, 'geo: archived place -> 404');
assert((await geo(`t=${GEO}&place=${PL}&event=teleport`)).status === 400, 'geo: bad event -> 400');
assert((await geo(`t=tt_${'x'.repeat(30)}&place=${PL}&event=arrive`)).status === 401, 'geo: unknown key -> 401');
assert((await call('initialize', { protocolVersion: '2025-06-18' }, GEO)).status === 401, 'location key cannot use MCP');
assert((await geo(`t=${TOKEN}&place=${PL}&event=arrive`)).status === 200, 'full token also works at /geo');

// ---------- places via MCP ----------
db.places = db.places.filter((p) => p.id === PL || p.id === PL2); // keep the /geo fixtures
let e = null; try { await tool('create_place', { name: 'Lumber yard', address: 'somewhere' }); } catch (x) { e = x.message; }
assert(/Couldn't find/.test(e || ''), 'create_place by address needs the server key (clear error without it)');
env.GOOGLE_SERVER_KEY = 'server-key';
const hd = await tool('create_place', { name: 'HD Galleria', address: 'Home Depot W Alabama Houston', radius_m: 152 });
assert(hd.name === 'HD Galleria' && hd.lat === 29.7351 && hd.address.includes('Alabama') && hd.radius_m === 152, 'create_place looks up an address, keeps the user\'s name');
const office = await tool('create_place', { name: 'Office', lat: 29.80, lng: -95.37 });
assert(office.radius_m === 402, 'create_place with lat/lng, default ¼ mi radius');
const placed = await tool('update_task', { id: oneShot.id, place: 'hd galleria', location_alert: 'arrive' });
assert(placed.place && placed.place.name === 'HD Galleria' && placed.place.alert === 'arrive' && placed.place.radius_m === 152, 'update_task sets place (by name) and alert');
const looked = await tool('capture', { title: 'Buy PEX crimp rings', place: 'Ferguson plumbing supply Houston', location_alert: 'nearby', location_radius_m: 805 });
assert(looked.place && looked.place.name === 'The Home Depot' && looked.place.radius_m === 805, 'capture with an unknown place looks it up and saves it');
e = null; try { await tool('update_task', { id: looked.id, place: 'nowhere at all' }); } catch (x) { e = x.message; }
assert(/No saved place/.test(e || ''), 'unfindable place -> clear error');
e = null; try { await tool('update_task', { id: looked.id, location_alert: 'teleport' }); } catch (x) { e = x.message; }
assert(/location_alert/.test(e || ''), 'bad alert value rejected');
const tg = await tool('update_tag', { tag: 'Phone', place: 'Office', location_alert: 'nearby' });
assert(tg.place.name === 'Office' && tg.place.alert === 'nearby', 'update_tag gives a tag a place');
const inherited = await tool('get_task', { id: cap.id }); // tagged Phone
assert(inherited.place && inherited.place.name === 'Office' && /tag Phone/.test(inherited.place.inherited_from), 'tasks show a place inherited from a tag');
const proj = await tool('update_project', { project: oneShot.project_id, place: 'Office' });
assert(proj.place && proj.place.name === 'Office', 'update_project sets a place');
const near = await tool('list_nearby', { lat: 29.7352, lng: -95.4711, available_only: false });
const hdg = near.places.find((g) => g.place === 'HD Galleria');
assert(hdg && hdg.distance_m < 30 && hdg.inside_radius && hdg.actions.some((t) => t.title === 'Schedule backflow test'), 'list_nearby: place inside radius, with its actions');
const availOnly = await tool('list_nearby', { lat: 29.7352, lng: -95.4711 });
assert(!availOnly.places.some((g) => g.actions.some((t) => t.title === 'Schedule backflow test')), 'list_nearby hides actions not available now (queued in a sequential project)');
assert(near.places.every((g, i, arr) => !i || arr[i - 1].distance_m <= g.distance_m), 'list_nearby sorted by distance');
const far = await tool('list_nearby', { lat: 40.71, lng: -74.0 });
assert(far.count === 0, 'list_nearby: nothing within 25 mi of New York');
const pl = await tool('list_places', { lat: 29.80, lng: -95.37 });
assert(pl[0].name === 'Office' && pl[0].distance_m === 0 && pl.find((x) => x.name === 'HD Galleria').open_actions === 1 && !pl.some((x) => x.name === 'Old unit'), 'list_places: distances, counts, archived hidden');
const archivedPlace = await tool('update_place', { place: 'HD Galleria', archived: true, radius_m: 300 });
assert(archivedPlace.archived && archivedPlace.radius_m === 300, 'update_place archives (never deletes) and edits radius');
const fallback = (await tool('get_task', { id: oneShot.id })).place;
assert(fallback && fallback.name === 'Office' && fallback.inherited_from === 'tag Phone', 'archived own place stops applying; falls back to an inherited place (tag before project)');
const cleared = await tool('update_task', { id: looked.id, place: null });
assert(!cleared.place && db.tasks.find((t) => t.id === looked.id).location_trigger === null, 'place: null clears place and alert');

// ---------- inspector parity 1 via MCP ----------
const inWeek = (n) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + n * 86400000)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
const today0 = localToday();
const np = await tool('create_project', { name: 'Kitchen remodel', due: today0, planned: inWeek(-1), estimate_minutes: 600, review_every: 2, review_unit: 'week' });
assert(np.due === today0 && np.planned === inWeek(-1) && np.estimate_minutes === 600 && np.review.every === 2 && np.review.unit === 'week', 'create_project with due, planned, duration, review cadence');
assert(np.created_at && np.changed_at !== undefined, 'projects report created_at / changed_at');
const fcP = await tool('forecast', { days: 3 });
assert(fcP.days[today0].projects.some((p) => p.name === 'Kitchen remodel'), 'forecast lists a project due today');
const tdP = await tool('today', {});
assert(tdP.projects_due.some((p) => p.name === 'Kitchen remodel' && !p.overdue), 'today lists projects due today');
const up2 = await tool('update_project', { project: 'Kitchen remodel', next_review: '2027-01-15', review_unit: 'month', review_every: 1 });
assert(up2.review.next_review === '2027-01-15' && up2.review.unit === 'month', 'update_project sets next review date and unit');
let bad2 = null; try { await tool('update_project', { project: 'Kitchen remodel', review_unit: 'fortnight' }); } catch (x) { bad2 = x.message; }
assert(/review_unit/.test(bad2 || ''), 'bad review_unit rejected');
const kitchenTask = await tool('capture', { title: 'Pick cabinets', project: 'Kitchen remodel' });
assert((await tool('list_tasks', { project: 'Kitchen remodel', available_only: true })).count === 1, 'action available in an undeferred project');
await tool('update_project', { project: 'Kitchen remodel', defer: inWeek(7) });
assert((await tool('list_tasks', { project: 'Kitchen remodel', available_only: true })).count === 0, 'deferring the project hides its actions');
const closedP = await tool('update_project', { project: 'Kitchen remodel', status: 'completed', completed_at: '2026-09-01' });
assert(closedP.status === 'completed' && closedP.completed_at.startsWith('2026-09-01'), 'backdated project completion');
const backT = await tool('update_task', { id: kitchenTask.id, completed_at: '2026-08-30' });
assert(backT.status === 'completed' && backT.completed_at.startsWith('2026-08-30'), 'update_task completed_at backdates (implies completed)');
const droppedT = await tool('update_task', { id: kitchenTask.id, dropped_at: '2026-08-31T15:00:00Z' });
assert(droppedT.status === 'dropped' && droppedT.dropped_at === '2026-08-31T15:00:00.000Z' && !droppedT.completed_at, 'update_task dropped_at backdates a drop');
assert(backT.changed_at !== undefined && backT.created_at, 'tasks report created_at / changed_at');

// ---------- repeat via MCP ----------
const rep = await tool('capture', { title: 'Water the lawn', repeat: { every: 2, unit: 'week', weekdays: [4, 1, 1] }, due: inWeek(1) });
assert(rep.repeat && rep.repeat.every === 2 && rep.repeat.weekdays.join() === '1,4' && rep.repeat.from === 'assigned' && rep.repeat.tz === 'America/Chicago', 'capture with a repeat rule (weekdays cleaned, tz set)');
assert(rep.repeat.summary === 'Every 2 weeks on Mon, Thu', `repeat summary: ${rep.repeat.summary}`);
let repErr = null; try { await tool('update_task', { id: rep.id, repeat: { every: 1, unit: 'fortnight' } }); } catch (x) { repErr = x.message; }
assert(/repeat.unit/.test(repErr || ''), 'bad repeat unit rejected');
const repC = await tool('update_task', { id: rep.id, repeat: { every: 3, unit: 'month', from: 'completion', end_count: 4 } });
assert(repC.repeat.summary === 'Every 3 months, after completion (1 of 4)', `edit repeat: ${repC.repeat.summary}`);
await tool('update_task', { id: rep.id, skip_occurrence: true });
const skipCall = globalThis.rpcCalls.find((c) => c.fn === 'repeat_skip');
assert(skipCall && skipCall.body.task_id === rep.id && skipCall.body.owner === UID, 'skip_occurrence calls repeat_skip scoped to the owner');
let skipErr = null; try { await tool('update_task', { id: kitchenTask.id, skip_occurrence: true }); } catch (x) { skipErr = x.message; }
assert(/repeating/.test(skipErr || ''), 'skip on a non-repeating action is refused');
assert(!(await tool('update_task', { id: rep.id, repeat: null })).repeat, 'repeat: null stops repeating');
const repP = await tool('create_project', { name: 'Monthly close', repeat: { every: 1, unit: 'month' }, due: inWeek(5) });
assert(repP.repeat && repP.repeat.summary === 'Every month', 'projects take a repeat rule');

// ---------- custom notifications via MCP + cron ----------
const rem = await tool('update_task', { id: oneShot.id, notifications: [{ kind: 'before_due', minutes: 60 }, { kind: 'at', at: '2026-10-01T15:00:00Z' }] });
assert(rem.notifications && rem.notifications.length === 2 && rem.notifications.some((n) => n.kind === 'before_due' && n.minutes === 60), 'update_task sets notifications and shows them');
assert(db.notifications.every((n) => n.user_id === UID && n.task_id === oneShot.id), 'notifications scoped to user and task');
let remErr = null; try { await tool('update_task', { id: oneShot.id, notifications: [{ kind: 'at' }] }); } catch (x) { remErr = x.message; }
assert(/needs at/.test(remErr || ''), '"at" notification without a time is refused');
db.notifications.find((n) => n.kind === 'before_due' && n.task_id === oneShot.id).sent_at = 'sent-marker';
await tool('update_task', { id: oneShot.id, notifications: [{ kind: 'before_due', minutes: 60 }] });
assert(db.notifications.filter((n) => n.task_id === oneShot.id).length === 1 && db.notifications.find((n) => n.task_id === oneShot.id).sent_at === 'sent-marker', 'unchanged reminder kept (not re-sent), removed one dropped');
assert((await tool('update_task', { id: oneShot.id, notifications: [] })).notifications === undefined, 'notifications: [] removes them');
const projRem = await tool('update_project', { project: oneShot.project_id, notifications: [{ kind: 'before_due', minutes: 1440 }] });
assert(projRem.notifications.length === 1 && projRem.notifications[0].minutes === 1440, 'projects take notifications');
const capRem = await tool('capture', { title: 'Call the inspector', due: inWeek(2), notifications: [{ kind: 'before_due', minutes: 30 }] });
assert(capRem.notifications && capRem.notifications.length === 1, 'capture with notifications');

const { sendDueReminders, reminderMessage } = await import('./src/reminders.js');
const nowR = new Date();
const openT = mk({ title: 'Pick up permit', due_at: new Date(nowR.getTime() + 3600e3).toISOString() });
const doneT = mk({ title: 'Already done', completed_at: nowR.toISOString() });
db.push_subscriptions.push({ id: 'ps9', user_id: UID, endpoint: 'https://push.example.com/dev9', ...keys });
db.notifications.push(
  { id: 'n1', user_id: UID, task_id: openT.id, project_id: null, kind: 'before_due', offset_minutes: 60, fire_at: new Date(nowR - 30e3).toISOString(), sent_at: null },
  { id: 'n2', user_id: UID, task_id: doneT.id, project_id: null, kind: 'at', offset_minutes: 0, fire_at: new Date(nowR - 60e3).toISOString(), sent_at: null },
  { id: 'n3', user_id: UID, task_id: openT.id, project_id: null, kind: 'at', offset_minutes: 0, fire_at: new Date(nowR.getTime() + 3600e3).toISOString(), sent_at: null },
  { id: 'n4', user_id: UID, task_id: openT.id, project_id: null, kind: 'at', offset_minutes: 0, fire_at: new Date(nowR - 10 * 3600e3).toISOString(), sent_at: null },
);
const pushedBefore = pushed.length;
const restFn = async (path, opts = {}) => { const r = await fetch(`https://x.supabase.co/rest/v1/${path}`, { method: opts.method || 'GET', headers: {}, body: opts.body ? JSON.stringify(opts.body) : undefined }); const t = await r.text(); return t ? JSON.parse(t) : []; };
const out = await sendDueReminders(env, restFn, nowR);
const newPushes = pushed.slice(pushedBefore);
assert(out.due === 2, `cron picks up due, unsent reminders from the last 6h (got ${out.due})`);
assert(newPushes.length >= 1 && newPushes.every((x) => x.url.startsWith('https://push.example.com')), 'cron pushes the live one');
const msgBody = JSON.parse(await decrypt(new Uint8Array(newPushes[newPushes.length - 1].init.body)));
assert(msgBody.title === '⏰ Pick up permit' && /^Due at /.test(msgBody.body) && msgBody.url === `#task/${openT.id}`, `reminder text: ${msgBody.title} / ${msgBody.body}`);
assert(db.notifications.find((n) => n.id === 'n1').sent_at && db.notifications.find((n) => n.id === 'n2').sent_at, 'due reminders marked sent (completed item: no push)');
assert(!db.notifications.find((n) => n.id === 'n3').sent_at && !db.notifications.find((n) => n.id === 'n4').sent_at, 'future and stale reminders untouched');
assert((await sendDueReminders(env, restFn, nowR)).due === 0, 'nothing is sent twice');
assert(reminderMessage({ id: 'x', project_id: 'p', kind: 'at_defer' }, { id: 'p', name: 'Taxes' }, 'America/Chicago').body === 'Project · Available now', 'project reminder text');

// ---------- attachments via MCP ----------
const att1 = await tool('add_attachment', { task: oneShot.id, name: 'call notes.txt', text: 'Spoke to Jodi; plans ready Friday.' });
assert(att1.name === 'call notes.txt' && att1.size === 34 && att1.mime.startsWith('text/plain') && att1.url.includes('/storage/v1/object/sign/attachments/' + UID), 'add_attachment (text) uploads into the user folder and returns a signed link');
const storedKey = Object.keys(globalThis.stored).find((k) => k.endsWith('call notes.txt'));
assert(storedKey && storedKey.startsWith(UID + '/'), 'file stored under the owner folder');
const att2 = await tool('add_attachment', { project: oneShot.project_id, name: 'plans.pdf', url: 'https://files.example/plans.pdf' });
assert(att2.mime === 'application/pdf' && att2.size === 13, 'add_attachment (url) downloads and attaches to a project');
const att3 = await tool('add_attachment', { task: oneShot.id, name: 'tiny.png', base64: 'iVBORw0KGgo=' });
assert(att3.size === 8 && att3.mime === 'application/octet-stream', 'add_attachment (base64)');
let attErr = null; try { await tool('add_attachment', { task: oneShot.id, name: 'x', url: 'file:///etc/passwd' }); } catch (x) { attErr = x.message; }
assert(/http/.test(attErr || ''), 'only http(s) URLs are fetched');
const withFiles = await tool('get_task', { id: oneShot.id });
assert(withFiles.attachments.length === 2 && withFiles.attachments.every((f) => f.url && f.url.includes('token=')), 'get_task lists attachments with download links');
const rm = await tool('remove_attachment', { id: att3.id });
assert(rm.archived && db.attachments.find((x) => x.id === att3.id).archived_at, 'remove_attachment archives');
assert((await tool('get_task', { id: oneShot.id })).attachments.length === 1, 'archived attachment hidden');
await tool('remove_attachment', { id: att3.id, restore: true });
assert((await tool('get_task', { id: oneShot.id })).attachments.length === 2, 'restore brings it back');

// ---------- delivery log, /push/test, queued tests, history ----------
db.push_log.length = 0;
db.push_subscriptions.push({ id: 'psbad', user_id: UID, endpoint: 'https://push.example.com/badjwt', device: 'iPhone', ...keys });
const pt = async (body, auth = 'Bearer user-jwt') => { const r = await worker.fetch(new Request('https://mcp.todotooling.com/push/test', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, ctx); return { status: r.status, body: await r.json() }; };
assert((await pt({}, 'Bearer nope')).status === 401, '/push/test needs a signed-in user');
const now1 = await pt({ delay_seconds: 0 });
assert(now1.status === 200 && now1.body.devices >= 2 && now1.body.results.some((x) => x.status === 403 && /BadJwtToken/.test(x.reason)), '/push/test sends now and reports each device, with the push service reason');
const logged = db.push_log.find((x) => x.kind === 'test' && x.sent_at);
assert(logged && logged.user_id === UID && logged.results.some((x) => x.device === 'iPhone' && x.status === 403), 'delivery logged with per-device results');
const later = await pt({ delay_seconds: 60 });
assert(later.body.queued && db.push_log.find((x) => x.id === later.body.queued && !x.sent_at), 'test queued for 1 minute');
const { sendQueuedTests } = await import('./src/deliver.js');
assert(await sendQueuedTests(env, restFn, new Date(Date.now() + 30e3)) === 0, 'queued test not sent early');
assert(await sendQueuedTests(env, restFn, new Date(Date.now() + 61e3)) === 1 && db.push_log.find((x) => x.id === later.body.queued).sent_at, 'cron sends the queued test when due');
db.item_history.push({ id: 1, user_id: UID, task_id: oneShot.id, project_id: null, field: 'due_at', old_value: null, new_value: '2026-10-01T22:00:00Z', source: 'app', changed_at: new Date().toISOString() });
db.push_log.push({ id: 'pl-r', user_id: UID, kind: 'reminder', title: '⏰ Schedule backflow test', task_id: oneShot.id, project_id: null, sent_at: new Date().toISOString(), devices: 1, delivered: 1, results: [], created_at: new Date().toISOString() });
const hist = await tool('get_history', { task: oneShot.id });
assert(hist.changes[0].field === 'due_at' && hist.changes[0].by === 'app' && hist.notifications_sent[0].kind === 'reminder', 'get_history returns changes and notifications sent');
const dl = await tool('list_deliveries', {});
assert(dl.devices.some((d) => d.device === 'iPhone' && d.service === 'push.example.com') && dl.deliveries.length >= 2, 'list_deliveries shows devices and recent sends');
console.log('ALL PASSED');
