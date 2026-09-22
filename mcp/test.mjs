import worker from './src/index.js';
import { createHash } from 'node:crypto';
const TOKEN = 'tt_' + 'a'.repeat(32);
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const UID = '11111111-1111-1111-1111-111111111111';
const db = { tasks: [], tags: [], task_tags: [], projects: [], folders: [], api_tokens: [{ id: 't1', user_id: UID, token_hash: HASH }] };
let n = 0; const id = () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`;
// Tiny PostgREST imitation: eq/is/in filters, POST/PATCH/DELETE.
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const table = u.pathname.split('/').pop();
  const filters = [...u.searchParams].filter(([k]) => !['select','order','limit','or'].includes(k));
  const match = (r) => filters.every(([k, v]) => {
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    if (op === 'eq') return String(r[k]) === val;
    if (op === 'is') return val === 'null' ? r[k] == null : String(r[k]) === val;
    if (op === 'in') return val.slice(1, -1).split(',').map(s => s.replace(/"/g,'')).includes(String(r[k]));
    if (op === 'not') return r[k] != null;
    if (op === 'lt') return r[k] && r[k] < val;
    return true;
  });
  const m = init.method || 'GET'; const rows = db[table];
  const body = init.body ? JSON.parse(init.body) : null;
  const res = (d, s = 200) => new Response(d === null ? null : JSON.stringify(d), { status: s });
  if (m === 'GET') return res(rows.filter(match));
  if (m === 'POST') { const add = (Array.isArray(body) ? body : [body]).map(b => ({ id: id(), in_inbox: true, flagged: false, notes: '', created_at: new Date().toISOString(), parent_id: null, project_id: null, completed_at: null, dropped_at: null, due_at: null, defer_at: null, status: 'active', ...b })); rows.push(...add); return init.headers.Prefer ? res(add, 201) : res(null, 201); }
  if (m === 'PATCH') { rows.filter(match).forEach(r => Object.assign(r, body)); return res(null, 204); }
  if (m === 'DELETE') { db[table] = rows.filter(r => !match(r)); return res(null, 204); }
};
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', TIMEZONE: 'America/Chicago' };
const ctx = { waitUntil() {} };
const call = async (method, params, token = TOKEN) => {
  const r = await worker.fetch(new Request('https://mcp.todotooling.com/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env, ctx);
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
};
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); const c = r.body.result; if (c.isError) throw new Error(c.content[0].text); return JSON.parse(c.content[0].text); };
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };

assert((await call('initialize', { protocolVersion: '2025-06-18' }, 'tt_wrongwrongwrongwrongwrong')).status === 401, 'bad token -> 401');
const init = await call('initialize', { protocolVersion: '2025-06-18' });
assert(init.body.result.protocolVersion === '2025-06-18' && init.body.result.capabilities.tools, 'initialize');
assert((await worker.fetch(new Request('https://mcp.todotooling.com/mcp', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }), env, ctx)).status === 202, 'notification -> 202');
const list = await call('tools/list');
assert(list.body.result.tools.length === 10 && list.body.result.tools.every(t => t.inputSchema && !t.run), 'tools/list: 10 tools, no internals leaked');
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
const done = await tool('complete_task', { id: cap.id });
assert(done.completed_at, 'complete_task');
const bad = await call('tools/call', { name: 'get_task', arguments: { id: 'nope' } });
assert(bad.body.result.isError, 'invalid id -> tool error, not crash');
const utcDue = db.tasks[0].due_at;
assert(utcDue === '2026-09-25T22:00:00.000Z', `due 5pm Chicago stored as ${utcDue}`);
console.log('ALL PASSED');
