import worker, { isAuthenticated, emailToTask } from './src/index.js';
import { createHash } from 'node:crypto';
const TOKEN = 'tt_' + 'a'.repeat(32);
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const UID = '11111111-1111-1111-1111-111111111111';
const db = { tasks: [], tags: [], task_tags: [], projects: [], folders: [], api_tokens: [{ id: 't1', user_id: UID, token_hash: HASH, scope: 'full' }], email_senders: [{ id: 'e1', user_id: UID, email: 'robert@douglasmining.com' }], project_tags: [], places: [], push_subscriptions: [], notifications: [], attachments: [], push_log: [], item_history: [], perspectives: [], imports: [], project_templates: [], user_settings: [], calendars: [], people: [], reference_items: [], weekly_reviews: [], areas: [], goals: [], checklists: [], checklist_runs: [], daily_reviews: [], review_sessions: [], review_items: [], slipbox_notes: [] };
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
  if (String(url).startsWith('https://cal.example/')) {
    const u = String(url);
    if (u.includes('missing')) return new Response('nope', { status: 404 });
    if (u.includes('html')) return new Response('<html>login</html>', { status: 200 });
    const d = new Date(); const pad = (n) => String(n).padStart(2, '0'); const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    return new Response(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Work', 'BEGIN:VEVENT', 'UID:1', `DTSTART;TZID=America/Chicago:${ymd}T140000`, `DTEND;TZID=America/Chicago:${ymd}T150000`, 'SUMMARY:Site walk', 'LOCATION:1000 Main St', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'), { status: 200, headers: { 'content-type': 'text/calendar' } });
  }
  if (String(url).startsWith('https://files.example')) return new Response('drawing bytes', { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (String(url).includes('/auth/v1/user')) {
    const auth = init.headers.Authorization || '';
    return auth === 'Bearer user-jwt' ? new Response(JSON.stringify({ id: UID }), { status: 200 }) : new Response('{}', { status: 401 });
  }
  if (String(url).startsWith('https://push.example')) { pushed.push({ url: String(url), init }); return String(url).includes('gone') ? new Response(null, { status: 410 }) : String(url).includes('badjwt') ? new Response('{"reason":"BadJwtToken"}', { status: 403 }) : new Response(null, { status: 201 }); }
  const rpcCalls = globalThis.rpcCalls = globalThis.rpcCalls || [];
  if (String(url).includes('/rest/v1/rpc/create_from_template')) { // SQL is tested in supabase/tests; here a small mirror
    const b = JSON.parse(init.body); globalThis.tplCalls = (globalThis.tplCalls || []).concat([b]);
    const t = db.project_templates.find((x) => x.id === b.template && x.user_id === b.owner && !x.archived_at);
    if (!t) return new Response(JSON.stringify({ message: 'Template not found.' }), { status: 400 });
    const TPLm = await import('../js/templates.js');
    const pv = TPLm.preview(t.body, { anchorKey: b.anchor || '2026-10-05', vars: { ...Object.fromEntries((t.body.blanks || []).map((x) => [x.name, x.default || ''])), ...b.vars } });
    const pid = id();
    db.projects.push({ id: pid, user_id: b.owner, name: b.name || pv.name, status: 'active', kind: t.body.kind || 'parallel', folder_id: b.folder || t.folder_id || null, sort: 0, template_id: t.id, created_at: new Date().toISOString() });
    pv.actions.filter((x) => x.depth === 1).forEach((x, i) => db.tasks.push({ id: id(), user_id: b.owner, title: x.title, project_id: pid, parent_id: null, in_inbox: false, sort: i, due_at: x.due ? `${x.due}T22:00:00.000Z` : null, completed_at: null, dropped_at: null, created_at: new Date().toISOString() }));
    return new Response(JSON.stringify(pid), { status: 200 });
  }
  if (String(url).includes('/rest/v1/rpc/import_omnifocus')) { // the SQL function is tested in supabase/tests; here: what the tool sends
    const b = JSON.parse(init.body); (globalThis.importCalls = globalThis.importCalls || []).push(b);
    const counts = { folders: b.payload.folders.length, tags: b.payload.tags.length, projects: b.payload.projects.length, tasks: b.payload.tasks.length, open_tasks: b.payload.tasks.filter((t) => !t.completed_at && !t.dropped_at).length, inbox: 1, review_due: 1, tasks_skipped: 0, projects_skipped: 0, folders_merged: 0, tags_merged: 0 };
    if (!b.dry_run) db.imports.push({ id: 'imp-1', user_id: b.owner, source: b.payload.source, counts, created_at: new Date().toISOString(), undone_at: null });
    return new Response(JSON.stringify({ ...counts, dry_run: b.dry_run, ...(b.dry_run ? {} : { import_id: 'imp-1' }) }), { status: 200 });
  }
  if (String(url).includes('/rest/v1/rpc/undo_import')) { const b = JSON.parse(init.body); (globalThis.undoCalls = globalThis.undoCalls || []).push(b); return new Response(JSON.stringify({ tasks_dropped: 9, projects_dropped: 3, folders_archived: 1 }), { status: 200 }); }
  if (String(url).includes('/rest/v1/rpc/convert_to_project')) { // mirror of the SQL function
    const b = JSON.parse(init.body); const t = db.tasks.find((x) => x.id === b.task_id && x.user_id === b.owner);
    if (!t) return new Response(JSON.stringify({ message: 'Task not found.' }), { status: 400 });
    const pid = id(); db.projects.push({ id: pid, user_id: t.user_id, name: t.title, kind: t.steps_in_order ? 'sequential' : 'parallel', status: 'active', folder_id: null, sort: 99, created_at: new Date().toISOString() });
    db.tasks.filter((x) => x.parent_id === t.id).forEach((x) => { x.parent_id = null; x.project_id = pid; });
    const follow = (pidOf) => db.tasks.filter((x) => x.parent_id && db.tasks.find((y) => y.id === x.parent_id)?.project_id === pid).forEach((x) => { x.project_id = pid; });
    follow(); follow(); follow();
    Object.assign(t, { dropped_at: new Date().toISOString(), completion_note: `Became the project “${t.title}”` });
    return new Response(JSON.stringify(pid), { status: 200 });
  }
  if (String(url).includes('/rest/v1/rpc/apply_project_plan')) { // SQL is tested in supabase/tests/project_planning.sql; a small mirror
    const b = JSON.parse(init.body); const p = db.projects.find((x) => x.id === b.project && x.user_id === b.owner);
    if (!p) return new Response(JSON.stringify({ message: 'Project not found.' }), { status: 400 });
    if (p.plan && p.plan.applied) return new Response(JSON.stringify({ message: 'This plan was already created. Undo it first to create it again.' }), { status: 400 });
    const pl = p.plan || {}; const ids = [];
    const mk = (o) => { const t = { id: id(), user_id: b.owner, in_inbox: false, completed_at: null, dropped_at: null, parent_id: null, created_at: new Date().toISOString(), ...o }; db.tasks.push(t); ids.push(t.id); return t; };
    (pl.ideas || []).filter((i) => !i.bucket || i.bucket === 'action').forEach((i) => mk({ title: i.text, project_id: p.id }));
    (pl.groups || []).forEach((g) => { const mine = (pl.ideas || []).filter((i) => i.bucket === `g:${g.id}`); if (!mine.length) return; const gt = mk({ title: g.name, project_id: p.id, steps_in_order: !!g.in_order }); mine.forEach((i) => mk({ title: i.text, project_id: p.id, parent_id: gt.id })); });
    p.plan = { ...pl, applied: { at: new Date().toISOString(), task_ids: ids, reference_ids: [] } };
    return new Response(JSON.stringify({ tasks: ids.length, references: 0, task_ids: ids, reference_ids: [] }), { status: 200 });
  }
  if (String(url).includes('/rest/v1/rpc/undo_project_plan')) {
    const b = JSON.parse(init.body); const p = db.projects.find((x) => x.id === b.project);
    const a = p.plan.applied; db.tasks.filter((t) => a.task_ids.includes(t.id)).forEach((t) => { t.dropped_at = new Date().toISOString(); });
    const { applied, ...rest } = p.plan; p.plan = rest;
    return new Response(JSON.stringify({ tasks_dropped: a.task_ids.length, references_archived: 0 }), { status: 200 });
  }
  if (String(url).includes('/rest/v1/rpc/')) { rpcCalls.push({ fn: String(url).split('/rpc/')[1], body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }
  const u = new URL(url); const table = u.pathname.split('/').pop();
  const filters = [...u.searchParams].filter(([k]) => !['select','order','limit','offset','or'].includes(k));
  const ors = [...u.searchParams].filter(([k]) => k === 'or').map(([, v]) => v.slice(1, -1).match(/[a-z_]+\.(?:ilike\.\*[^*]*\*|in\.\([^)]*\)|not\.is\.null|is\.null|is\.(?:true|false)|(?:lt|lte|gte|gt|eq)\.[^,)]+)/g) || []);
  const orMatch = (r) => ors.every((conds) => conds.some((c) => {
    const [k, op, ...rest] = c.split('.'); const v = rest.join('.');
    if (op === 'ilike') return (r[k] || '').toLowerCase().includes(decodeURIComponent(v).replace(/\*/g, '').toLowerCase());
    if (op === 'in') return v.slice(1, -1).split(',').map((x) => x.replace(/"/g, '')).includes(String(r[k]));
    if (op === 'not') return r[k] != null;
    if (op === 'is') return v === 'null' ? r[k] == null : String(!!r[k]) === v;
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
  if (m === 'GET') { const off = +(u.searchParams.get('offset') || 0); const lim = Math.min(+(u.searchParams.get('limit') || 1000), 1000); return res(rows.filter((r) => match(r) && orMatch(r)).slice(off, off + lim)); } // the server caps a request at 1,000 rows
  // Mirror of tasks_tree_guard / tasks_tree_follow: loops, 4 levels, steps live in their parent's project.
  const depth = (tid) => { let d = 0; for (let p = tid; p && d < 12; d++) p = db.tasks.find((x) => x.id === p)?.parent_id; return d; };
  const height = (tid) => { const k = db.tasks.filter((x) => x.parent_id === tid); return k.length ? 1 + Math.max(...k.map((x) => height(x.id))) : 0; };
  const guard = (row, patch) => {
    if (table !== 'tasks' || !patch || !('parent_id' in patch || 'project_id' in patch) || !(patch.parent_id ?? row.parent_id)) return null;
    const pid = patch.parent_id ?? row.parent_id;
    for (let p = pid, i = 0; p && i < 12; i++) { if (p === row.id) return 'A task can’t be a step of one of its own steps.'; p = db.tasks.find((x) => x.id === p)?.parent_id; }
    if (depth(pid) + 1 + (row.id ? height(row.id) : 0) > 4) return 'Steps can go 4 levels deep. Turn the big step into a project instead.';
    patch.project_id = db.tasks.find((x) => x.id === pid).project_id; patch.in_inbox = false;
    return null;
  };
  const follow = (r) => db.tasks.filter((x) => x.parent_id === r.id && x.project_id !== r.project_id).forEach((x) => { x.project_id = r.project_id; follow(x); });
  if (m === 'POST' && table === 'tasks') for (const b of (Array.isArray(body) ? body : [body])) { const e = guard({}, b); if (e) return res({ message: e }, 400); }
  if (m === 'PATCH' && table === 'tasks') for (const r of rows.filter(match)) { const b = { ...body }; const e = guard(r, b); if (e) return res({ message: e }, 400); Object.assign(r, b); follow(r); }
  if (m === 'POST') { const add = (Array.isArray(body) ? body : [body]).map(b => ({ id: id(), in_inbox: true, flagged: false, notes: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), parent_id: null, project_id: null, completed_at: null, dropped_at: null, due_at: null, defer_at: null, status: 'active', place_id: null, location_trigger: null, location_radius_m: null, ...(table === 'places' ? { radius_m: 402, archived_at: null, address: '', notes: '' } : {}), ...(table === 'checklists' ? { complete_action: true, archived_at: null } : {}), ...(table === 'review_items' ? { status: 'pending', note: '', changed: {}, priority: false } : {}), ...(table === 'checklist_runs' ? { started_at: new Date().toISOString(), finished_at: null } : {}), ...b })); rows.push(...add); return init.headers.Prefer ? res(add, 201) : res(null, 201); }
  if (m === 'PATCH') { const hit = rows.filter((r) => match(r) && orMatch(r)); hit.forEach(r => Object.assign(r, body, 'updated_at' in r ? { updated_at: new Date().toISOString() } : {})); if (table === 'tasks') hit.forEach((r) => { if (!r.waiting_on) r.follow_up_at = null; }); return init.headers.Prefer ? res(hit) : res(null, 204); }
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
assert(list.body.result.tools.length === 72 && list.body.result.tools.every(t => t.inputSchema && !t.run), 'tools/list: 72 tools, no internals leaked');
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
assert(groupView.steps && groupView.steps[0].id === sub.id && groupView.progress.total === 1, 'get_task lists steps with progress');
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
assert(t1.title === 'Plans for Jodi' && t1.notes.includes('Attachments: plans.pdf') && !t1.notes.includes('\n\n\n'), 'emailToTask cleans subject, notes, attachments');
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

// ---------- steps ("eat the elephant") ----------
{
  const big = await tool('capture', { title: 'Build a 2m telescope' });
  const bd = await tool('break_down', { id: big.id, steps: ['Research mirror grinding', ' ', 'Order a mirror blank', 'Grind the mirror'], in_order: true });
  assert(bd.steps.length === 3 && bd.steps.map((x) => x.title).join('|') === 'Research mirror grinding|Order a mirror blank|Grind the mirror' && bd.steps_in_order && bd.progress.total === 3, 'break_down adds steps in order (blank lines skipped)');
  assert(bd.steps.every((x) => !x.in_inbox), 'steps are not Inbox items');
  const grind = bd.steps[2];
  const bd2 = await tool('break_down', { id: grind.id, steps: ['Rough grind', 'Polish'] });
  const tree = await tool('get_task', { id: big.id });
  assert(tree.steps[2].steps.length === 2 && tree.progress.total === 4, 'nested steps; progress counts the smallest steps');
  const rough = bd2.steps[0];
  const partOf = await tool('get_task', { id: rough.id });
  assert(partOf.part_of.map((x) => x.title).join(' < ') === 'Grind the mirror < Build a 2m telescope', 'get_task shows what a step is part of');
  const again = await tool('break_down', { id: big.id, steps: ['Build the tube'] });
  assert(again.steps[3].title === 'Build the tube' && db.tasks.find((x) => x.id === again.steps[3].id).sort > db.tasks.find((x) => x.id === grind.id).sort, 'break_down appends after existing steps');
  // Availability: in order, only the first open step is available (at every level).
  await tool('create_project', { name: 'Telescope shop' });
  await tool('update_task', { id: big.id, project: 'Telescope shop' });
  const bigPid = db.tasks.find((y) => y.id === big.id).project_id;
  assert(bigPid && db.tasks.filter((x) => x.parent_id === grind.id).every((x) => x.project_id === bigPid), 'moving a task takes all its steps along');
  const avail = async () => (await tool('list_tasks', { project: 'Telescope shop', available_only: true })).items.map((x) => x.title);
  let av = await avail();
  assert(av.includes('Research mirror grinding') && !av.includes('Order a mirror blank') && !av.includes('Rough grind') && !av.includes('Build a 2m telescope'), 'available_only: in-order steps wait their turn; a task with steps is not itself available');
  await tool('update_task', { id: big.id, steps_in_order: false });
  av = await avail();
  assert(av.includes('Order a mirror blank') && av.includes('Rough grind') && !av.includes('Grind the mirror'), 'steps_in_order off: all leaf steps available');
  await tool('update_task', { id: grind.id, defer: '2099-01-01' });
  av = await avail();
  assert(!av.includes('Rough grind'), 'a deferred step hides its own steps');
  await tool('update_task', { id: grind.id, defer: null });
  // Move under any open task; loops and depth are refused.
  const loose = await tool('capture', { title: 'Buy grit' });
  const moved = await tool('update_task', { id: loose.id, parent: rough.id });
  assert(moved.parent_id === rough.id && moved.project_id === bigPid && !moved.in_inbox, 'update_task parent: any open task; it joins that project');
  let err = '';
  try { await tool('break_down', { id: loose.id, steps: ['Too deep'] }); } catch (e) { err = e.message; }
  assert(/4 levels/.test(err), 'a 5th level is refused');
  err = '';
  try { await tool('update_task', { id: big.id, parent: rough.id }); } catch (e) { err = e.message; }
  assert(/own steps/.test(err), 'a loop is refused');
  // Convert to project.
  const conv = await tool('convert_to_project', { id: big.id });
  assert(conv.name === 'Build a 2m telescope' && conv.actions.length === 4 && conv.actions.every((x) => !x.parent_id), 'convert_to_project: steps become the project\'s actions');
  assert(db.tasks.find((x) => x.id === big.id).dropped_at && /Became the project/.test(db.tasks.find((x) => x.id === big.id).completion_note), 'the task is dropped with a note, not deleted');
  assert(db.tasks.find((x) => x.id === rough.id).project_id === conv.id, 'deeper steps come along into the project');
}

// ---------- perspectives ----------
{
  const P = await import('../js/perspective-engine.js');
  // Engine unit checks (the same file the app runs).
  const tags = [{ id: 'w', name: 'Waiting', parent_id: null }, { id: 'h', name: 'Hiro', parent_id: 'w' }, { id: 'ph', name: 'Phone', parent_id: null }];
  const now = new Date('2026-09-23T15:00:00Z');
  const T = (o) => ({ id: o.id, title: o.id, sort: 0, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-20T00:00:00Z', completed_at: null, dropped_at: null, ...o });
  const data = {
    tasks: [T({ id: 'a', due_at: '2026-09-22T22:00:00Z' }), T({ id: 'b', due_at: '2026-09-23T22:00:00Z', estimate_minutes: 10 }), T({ id: 'c', due_at: '2026-09-27T22:00:00Z' }), T({ id: 'd', flagged: true }), T({ id: 'e', completed_at: '2026-09-22T12:00:00Z' }), T({ id: 'f', project_id: 'pp' })],
    projects: [{ id: 'pp', name: 'Shop', sort: 0 }], folders: [], tags,
    taskTags: [{ task_id: 'a', tag_id: 'h' }, { task_id: 'b', tag_id: 'ph' }], projectTags: [{ project_id: 'pp', tag_id: 'ph' }],
  };
  const ev = (rules, options = { show: 'remaining' }) => P.evaluate({ rules, options }, data, { now, tz: 'America/Chicago' }).tasks.map((t) => t.id).join('');
  assert(ev({ match: 'all', rules: [{ type: 'tag', tags: ['w'] }] }) === 'a', 'engine: a parent tag matches its sub-tags');
  assert(ev({ match: 'all', rules: [{ type: 'tag', tags: ['w'], sub: false }] }) === '', 'engine: sub:false means exactly that tag');
  assert(ev({ match: 'all', rules: [{ type: 'tag', tags: ['ph'] }] }, { show: 'remaining', sort_by: 'title' }) === 'bf', 'engine: project tags count');
  assert(ev({ match: 'any', rules: [{ type: 'overdue' }, { type: 'date', field: 'due', when: 'next', days: 7 }] }, { show: 'remaining', sort_by: 'due' }) === 'abc', 'engine: due soon (overdue or within 7 days), sorted by due');
  assert(ev({ match: 'all', rules: [{ type: 'date', field: 'due', when: 'today' }] }) === 'b', 'engine: today in the user\'s timezone');
  assert(ev({ match: 'none', rules: [{ type: 'flagged' }, { type: 'date', field: 'due', when: 'any' }] }, { show: 'remaining', sort_by: 'title' }) === 'f', 'engine: none-of');
  assert(ev({ match: 'all', rules: [{ type: 'date', field: 'completed', when: 'past', days: 3 }] }, { show: 'all' }) === 'e', 'engine: completed in the last N days');
  assert(ev({ match: 'all', rules: [{ type: 'duration', op: 'max', minutes: 15 }] }) === 'b', 'engine: duration');
  const warn = P.evaluate({ rules: { match: 'all', rules: [{ type: 'mystery' }] }, options: {} }, data, { now, tz: 'America/Chicago' });
  assert(warn.tasks.length === 0 && /doesn’t understand/.test(warn.warnings[0]), 'engine: an unknown rule matches nothing and warns');
  const grouped = P.evaluate({ rules: { match: 'all', rules: [] }, options: { show: 'remaining', group_by: 'due' } }, data, { now, tz: 'America/Chicago' }).groups.map((g) => g.label).join('|');
  assert(grouped === 'Overdue|Today|Next 7 days|No due date', 'engine: group by due date', grouped);
  assert(P.describe({ rules: { match: 'all', rules: [{ type: 'tag', tags: ['h'] }, { match: 'any', rules: [{ type: 'flagged' }, { type: 'duration', op: 'max', minutes: 15 }] }] }, options: { show: 'available' } }, data) === 'Available · tagged Waiting : Hiro · (flagged or 15 min or less)', 'engine: plain-English summary');
  assert(P.validate({ rules: { match: 'all', rules: [{ type: 'date', field: 'due', when: 'soonish' }] } }).length === 1, 'engine: validate catches bad rules');

  // Through MCP.
  const made = await tool('create_perspective', { template: 'calls', badge: true, options: { show: 'remaining' } });
  assert(made.name === 'Calls' && made.summary === 'Remaining · tagged Phone' && made.rules.rules[0].tags.length === 1, 'create_perspective from a template (tag name resolved)');
  let dup = '';
  try { await tool('create_perspective', { template: 'calls' }); } catch (e) { dup = e.message; }
  assert(/already exists/.test(dup), 'perspective names are unique');
  const ran = await tool('run_perspective', { perspective: 'calls' });
  assert(ran.count >= 1 && ran.groups.every((g) => g.items.every((x) => x.tags.includes('Phone') || x.project_tags.includes('Phone'))), 'run_perspective by name returns only matching items, grouped');
  const preview = await tool('run_perspective', { rules: { match: 'all', rules: [{ type: 'tag', tags: ['Waiting'] }] }, options: { show: 'remaining', group_by: 'tag' } });
  assert(preview.name === 'Preview' && preview.count >= 1 && preview.groups.some((g) => g.label === 'Waiting : Hiro'), 'run_perspective previews unsaved rules (names ok)');
  let bad = '';
  try { await tool('run_perspective', { rules: { match: 'all', rules: [{ type: 'tag', tags: ['Nope'] }] } }); } catch (e) { bad = e.message; }
  assert(/No tag called/.test(bad), 'unknown tag names are reported');
  bad = '';
  try { await tool('create_perspective', { name: 'Broken', rules: { match: 'all', rules: [{ type: 'duration', minutes: -1 }] } }); } catch (e) { bad = e.message; }
  assert(/minutes/.test(bad), 'invalid rules are refused with a clear message');
  const quick = await tool('create_perspective', { name: 'Quick calls', icon: '⚡', rules: { match: 'all', rules: [{ type: 'tag', tags: ['Phone'] }, { type: 'duration', op: 'max', minutes: 15 }] } });
  const lp = await tool('list_perspectives', {});
  assert(lp.map((x) => x.name).join() === 'Calls,Quick calls' && lp.every((x) => typeof x.open_count === 'number'), 'list_perspectives in order with counts');
  const upd = await tool('update_perspective', { perspective: quick.id, name: 'Short calls', options: { group_by: 'none' }, move: 'top' });
  assert(upd.name === 'Short calls' && upd.options.group_by === 'none' && upd.options.show === 'available' && upd.options.sort_by === 'project', 'update_perspective renames and merges options');
  assert((await tool('list_perspectives', {}))[0].name === 'Short calls', 'update_perspective move');
  await tool('update_perspective', { perspective: 'Short calls', archived: true });
  assert((await tool('list_perspectives', {})).length === 1 && (await tool('list_perspectives', { include_archived: true })).length === 2, 'archive hides it (never deleted)');
}

// ---------- on-hold tags ----------
{
  await tool('create_project', { name: 'Home' });
  const a = await tool('capture', { title: 'Fix gate latch', project: 'Home' });
  const b = await tool('capture', { title: 'Learn Spanish', project: 'Home', tags: ['Someday'] });
  const c = await tool('capture', { title: 'Build a boat', project: 'Home', tags: ['Someday : Big'] });
  const avail = async () => (await tool('list_tasks', { project: 'Home', available_only: true })).items.map((x) => x.title).sort().join('|');
  assert(await avail() === 'Build a boat|Fix gate latch|Learn Spanish', 'before: everything available');
  const held = await tool('update_tag', { tag: 'Someday', status: 'on_hold' });
  assert(held.status === 'on_hold', 'update_tag puts a tag on hold');
  assert(await avail() === 'Fix gate latch', 'on-hold tag (and its sub-tags) park their actions');
  assert((await tool('get_task', { id: b.id })).on_hold === 'Not available: tag “Someday” is on hold', 'get_task says why it isn’t available');
  assert(!(await tool('get_task', { id: a.id })).on_hold, 'others unaffected');
  const tagsNow = await tool('list_tags', {});
  assert(tagsNow.find((t) => t.label === 'Someday').status === 'on_hold' && tagsNow.find((t) => t.label === 'Someday : Big').status === 'on_hold', 'list_tags shows status (sub-tags inherit)');
  const home = (await tool('list_projects', {})).find((x) => x.name === 'Home');
  assert(home.next_action.title === 'Fix gate latch', 'next action skips parked items');
  const pv = await tool('run_perspective', { rules: { match: 'all', rules: [{ type: 'on_hold' }] }, options: { show: 'remaining', group_by: 'none' } });
  assert(pv.count === 2, 'perspective rule on_hold');
  await tool('update_tag', { tag: 'Someday', status: 'dropped' });
  assert(await avail() === 'Build a boat|Fix gate latch|Learn Spanish' && !(await tool('list_tags', {})).some((t) => t.label === 'Someday') && (await tool('list_tags', { include_dropped: true })).some((t) => t.label === 'Someday'), 'dropped: retired, hidden, holds nothing');
  await tool('update_tag', { tag: 'Someday', status: 'active' });
  let bad = '';
  try { await tool('update_tag', { tag: 'Someday', status: 'paused' }); } catch (e) { bad = e.message; }
  assert(/on_hold/.test(bad), 'bad status refused');
  void c;
}

// ---------- project templates ----------
{
  await tool('create_project', { name: 'Jones remodel', kind: 'sequential' });
  const s1 = await tool('capture', { title: 'Site visit with Jones', project: 'Jones remodel', due: '2026-09-01' });
  await tool('capture', { title: 'Send estimate', project: 'Jones remodel', due: '2026-09-03' });
  await tool('break_down', { id: s1.id, steps: ['Measure'] });
  const saved = await tool('save_as_template', { project: 'Jones remodel', name: 'New job', blanks: [{ find: 'Jones', name: 'Client' }] });
  assert(saved.name === 'New job' && saved.actions === 3 && saved.blanks.join() === 'Client' && saved.kind === 'sequential', 'save_as_template: actions, steps, blanks');
  const body = db.project_templates.find((t) => t.id === saved.id).body;
  assert(body.name === '«Client» remodel' && body.actions[0].title === 'Site visit with «Client»' && body.actions[0].due === 0 && body.actions[1].due === 2 && body.actions[0].steps[0].title === 'Measure', 'dates become days from the start; text becomes blanks');
  assert((await tool('list_templates', {})).some((t) => t.name === 'New job' && t.blanks[0] === 'Client'), 'list_templates');
  const made = await tool('create_from_template', { template: 'new job', date: '2026-10-05', values: { Client: 'Smith' } });
  const call = globalThis.tplCalls.at(-1);
  assert(call.owner === UID && call.anchor === '2026-10-05' && call.vars.Client === 'Smith' && call.tz === 'America/Chicago', 'create_from_template calls the database as the user, in their time zone');
  assert(made.name === 'Smith remodel' && made.from_template === 'New job' && made.actions.some((x) => x.title === 'Site visit with Smith' && x.due === '2026-10-05'), 'the project comes back with its actions');
  const left = await tool('create_from_template', { template: saved.id });
  assert(left.blanks_left_empty && left.blanks_left_empty[0] === 'Client', 'says which blanks were left empty');
  let bad = '';
  try { await tool('update_template', { template: 'New job', body: { actions: [{ title: 'x', due: 1.5 }] } }); } catch (e) { bad = e.message; }
  assert(/whole number/.test(bad), 'update_template validates the body');
  const up = await tool('update_template', { template: 'New job', schedule: { every: 1, unit: 'month', start: '2026-11-01' }, body: { name: 'Job for «Client»', kind: 'parallel', actions: [{ title: 'Call «Client»', due: 0 }] } });
  assert(up.schedule === 'Every month from 2026-11-01' && up.actions === 1 && up.blanks[0] === 'Client' && db.project_templates.find((t) => t.id === saved.id).schedule.tz === 'America/Chicago', 'update_template: body and schedule (in the user\'s zone)');
  await tool('update_template', { template: 'New job', archived: true });
  bad = '';
  try { await tool('create_from_template', { template: 'New job' }); } catch (e) { bad = e.message; }
  assert(/archived/.test(bad) && (await tool('list_templates', {})).every((t) => t.name !== 'New job'), 'archived templates are hidden and can\'t be used');
}

// ---------- settings: default times, time zone, Forecast tag ----------
{
  db.user_settings.push({ user_id: UID, due_minutes: 15 * 60 + 30, planned_minutes: 8 * 60, defer_minutes: 6 * 60, timezone: 'America/New_York', forecast_tag_id: null });
  const t = await tool('capture', { title: 'Settings check', due: '2026-10-05', planned: '2026-10-04', defer: '2026-10-03' });
  const row = db.tasks.find((x) => x.id === t.id);
  assert(row.due_at === '2026-10-05T19:30:00.000Z' && row.planned_at === '2026-10-04T12:00:00.000Z' && row.defer_at === '2026-10-03T10:00:00.000Z', 'plain dates land at the account\'s times, in its time zone', `${row.due_at} ${row.planned_at} ${row.defer_at}`);
  const todayTag = await tool('create_tag', { label: 'Today' });
  db.user_settings[0].forecast_tag_id = todayTag.id;
  const pick = await tool('capture', { title: 'Tagged for today', tags: ['Today'] });
  const fc = await tool('forecast', { days: 2 });
  assert(fc.today_tag && fc.today_tag.tag === 'Today' && fc.today_tag.items.some((x) => x.id === pick.id), 'forecast includes the "always show in Today" tag');
  db.user_settings.length = 0;
}

// ---------- iCal reading (js/ics.js) ----------
{
  const { readFileSync } = await import('node:fs');
  const I = await import('../js/ics.js');
  const cal = I.parseCalendar(readFileSync(new URL('../dev/fixtures/calendar-sample.ics', import.meta.url), 'utf8'), { tz: 'America/Chicago' });
  const wk = I.eventsBetween(cal, '2026-09-21', '2026-09-30', { tz: 'America/Chicago' });
  const at = (title) => wk.filter((e) => e.title === title).map((e) => `${e.days.join('+')}${e.allDay ? '' : '@' + new Date(e.start).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })}`).join(',');
  assert(cal.name === 'Work' && at('Standup') === '2026-09-21@9:00 AM,2026-09-23@9:00 AM,2026-09-30@9:00 AM', 'ics: weekly rule, skipped date (EXDATE), alarms ignored', at('Standup'));
  assert(at('Standup (moved)') === '2026-09-28@10:00 AM', 'ics: a moved occurrence replaces the original');
  assert(at('Jodi out of office') === '2026-09-23+2026-09-24+2026-09-25' && !at('Cancelled call'), 'ics: multi-day all-day event; cancelled events hidden');
  assert(wk.some((e) => e.title === 'Site walk: Smith, Jones' && e.location === '1000 Main St\nHouston'), 'ics: escaped text');
  assert(at("Mom's birthday") === '2026-09-24', 'ics: yearly all-day');
  const nov = I.eventsBetween(cal, '2026-11-01', '2026-11-30', { tz: 'America/Chicago' });
  const outlook = nov.find((e) => e.title.startsWith('Outlook meeting'));
  assert(outlook && outlook.title.endsWith('folded over two lines') && new Date(outlook.start).toISOString() === '2026-11-02T14:00:00.000Z', 'ics: Windows zone names, folded lines, daylight saving');
  assert(nov.filter((e) => e.title === 'Board meeting').map((e) => e.days[0]).join() === '2026-11-10', 'ics: 2nd Tuesday of the month');
  assert(!I.eventsBetween(cal, '2027-01-01', '2027-01-31', { tz: 'America/Chicago' }).some((e) => e.title === 'Board meeting'), 'ics: COUNT ends a series');
}

// ---------- calendars ----------
{
  const cf = async (body, auth = 'Bearer user-jwt') => { const r = await worker.fetch(new Request('https://mcp.todotooling.com/calendar/fetch', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, ctx); return { status: r.status, text: await r.text() }; };
  assert((await cf({ url: 'https://cal.example/a.ics' }, 'Bearer nope')).status === 401, '/calendar/fetch needs a signed-in user');
  const ok = await cf({ url: 'webcal://cal.example/a.ics' });
  assert(ok.status === 200 && ok.text.startsWith('BEGIN:VCALENDAR'), 'fetches a calendar link (webcal:// works)');
  assert(/https:\/\/ or webcal/.test((await cf({ url: 'http://cal.example/a.ics' })).text), 'only https links');
  assert(/doesn’t exist any more/.test((await cf({ url: 'https://cal.example/missing.ics' })).text), 'a dead link is explained');
  const html = await cf({ url: 'https://cal.example/html' });
  assert(html.status === 422 && !html.text.includes('<html>'), 'non-calendar pages are refused (never passed through)');
  db.calendars.push({ id: '00000000-0000-0000-0000-00000000ca11', user_id: UID, name: 'Work', url: 'https://cal.example/work.ics', color: '#1D9E75', enabled: true, sort: 0, archived_at: null });
  db.calendars.push({ id: '00000000-0000-0000-0000-00000000ca12', user_id: 'someone-else', name: 'Theirs', url: 'https://cal.example/theirs.ics', color: '#1D9E75', enabled: true, sort: 0, archived_at: null });
  assert((await cf({ id: '00000000-0000-0000-0000-00000000ca11' })).status === 200, 'fetches a saved calendar by id');
  assert((await cf({ id: '00000000-0000-0000-0000-00000000ca12' })).status === 404, 'can’t read someone else’s calendar');
  const fc = await tool('forecast', { days: 2 });
  const todayEvents = Object.values(fc.days)[0].events || [];
  assert(todayEvents.some((e) => e.title === 'Site walk' && e.calendar === 'Work' && e.location === '1000 Main St') && !JSON.stringify(fc).includes('cal.example'), 'forecast includes calendar events, never the links');
  db.calendars.length = 0;
}

// ---------- OmniFocus import ----------
{
  const { readFileSync } = await import('node:fs');
  const sample = readFileSync(new URL('../dev/fixtures/omnifocus-sample.json', import.meta.url), 'utf8');
  const pre = await tool('import_omnifocus', { data: sample });
  const call = globalThis.importCalls.at(-1);
  assert(!pre.saved && call.dry_run === true && call.owner === UID && pre.format === 'json' && pre.counts.projects === 3 && pre.counts.open_tasks === 9, 'import_omnifocus previews by default (dry run, as the user)');
  assert(pre.warnings.some((w) => /moved up/.test(w)) && pre.sample.some((l) => /Click Plumbing/.test(l)) && /confirm: true/.test(pre.next), 'preview has warnings, a sample and the next step');
  assert(call.payload.tasks.every((t, i, a) => i === 0 || a[i - 1].depth <= t.depth), 'steps are sent after the tasks they belong to');
  const done = await tool('import_omnifocus', { data: sample, confirm: true, completed: 'all' });
  assert(done.saved && done.import_id === 'imp-1' && globalThis.importCalls.at(-1).dry_run === false && globalThis.importCalls.at(-1).payload.tasks.length > call.payload.tasks.length, 'confirm imports (completed: all brings history)');
  const tp = await tool('import_omnifocus', { data: readFileSync(new URL('../dev/fixtures/omnifocus-sample.taskpaper', import.meta.url), 'utf8') });
  assert(tp.format === 'taskpaper' && tp.counts.projects === 2, 'TaskPaper works through MCP too');
  let bad = '';
  try { await tool('import_omnifocus', { data: 'hello' }); } catch (e) { bad = e.message; }
  assert(/doesn’t look like an OmniFocus export/.test(bad), 'not an export: a clear error');
  const listed = await tool('undo_import', {});
  assert(listed.length === 1 && listed[0].id === 'imp-1' && listed[0].projects >= 3, 'undo_import without an id lists imports');
  let badId = '';
  try { await tool('undo_import', { import_id: 'nope' }); } catch (e) { badId = e.message; }
  assert(/import_id/.test(badId), 'undo_import checks the id');
}

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
// ---------- GTD: clarify, delegate / waiting / agendas, tickler, reference, energy ----------
{
  const inboxItem = await tool('capture', { title: 'Call Hiro about the backflow permit' });
  const pl = (await tool('list_projects', {})).projects || (await tool('list_projects', {}));
  const projName = (Array.isArray(pl) ? pl : pl.projects || [])[0]?.name || null;
  let err = '';
  try { await tool('clarify_item', { id: inboxItem.id, decision: 'next_action' }); } catch (e) { err = e.message; }
  assert(/project or at least one tag/.test(err), 'clarify next_action needs a project or tag');
  const na = await tool('clarify_item', { id: inboxItem.id, decision: 'next_action', tags: ['Phone'], energy: 'low', planned: '2026-10-05' });
  assert(!na.item.in_inbox && na.item.tags.includes('Phone') && na.item.energy === 'low' && na.item.planned === '2026-10-05', 'clarify next_action: tags, energy, planned; leaves the Inbox');
  const lowOnly = await tool('list_tasks', { max_energy: 'low' });
  assert(lowOnly.items.some((t) => t.id === inboxItem.id) && lowOnly.items.every((t) => t.energy === 'low'), 'list_tasks max_energy');
  // Delegate: drafts a message, never sends; the item waits and isn't available.
  const d1 = await tool('capture', { title: 'Send the permit drawings to the city', tags: ['Laptop'] });
  const del = await tool('delegate', { id: d1.id, person: 'Jodi Park', email: 'jodi@example.com', follow_up: 3 });
  const jodi = db.people.find((p) => p.name === 'Jodi Park');
  assert(jodi && jodi.email === 'jodi@example.com' && del.item.waiting_on === 'Jodi Park' && del.item.follow_up && del.person.name === 'Jodi Park', 'delegate makes a person and waits on them');
  assert(del.message.mailto.startsWith('mailto:jodi%40example.com?subject=Send%20the%20permit') && /Not sent/.test(del.message.note), 'delegate returns a draft for the user to send (nothing sent)');
  const avail = await tool('list_tasks', { available_only: true });
  assert(!avail.items.some((t) => t.id === d1.id), 'a delegated item is not a next action');
  db.tasks.find((t) => t.id === d1.id).follow_up_at = new Date(Date.now() - 86400000).toISOString();
  const w = await tool('list_waiting', {});
  assert(w.count >= 1 && w.follow_ups_due >= 1 && w.by_person['Jodi Park'][0].follow_up_due, 'list_waiting groups by person, flags due follow-ups');
  const fc = await tool('forecast', { days: 2 });
  assert(fc.follow_ups && fc.follow_ups.some((t) => t.id === d1.id), 'forecast lists follow-ups due');
  const nudge = await tool('draft_nudge', { id: d1.id, snooze_days: 2 });
  assert(/just checking in/.test(nudge.message.body) && nudge.follow_up > new Date().toISOString().slice(0, 10), 'draft_nudge drafts a check-in and snoozes');
  const back = await tool('update_task', { id: d1.id, waiting_on: null });
  assert(!back.waiting_on && !db.tasks.find((t) => t.id === d1.id).follow_up_at, 'update_task waiting_on null takes it back');
  const viaUpdate = await tool('update_task', { id: d1.id, waiting_on: 'Jodi' });
  assert(viaUpdate.waiting_on === 'Jodi Park' && viaUpdate.follow_up, 'update_task waiting_on by first name, follow-up defaults to a week');
  // A "Waiting : Hiro" tag becomes Hiro's.
  const hiroTask = await tool('capture', { title: 'Hiro: quote for water heater', tags: ['Waiting : Hiro'] });
  const hiro = await tool('save_person', { name: 'Hiro', tag: 'Waiting : Hiro' });
  const w2 = await tool('list_waiting', { person: 'Hiro' });
  assert(hiro.name === 'Hiro' && w2.count >= 1 && w2.by_person.Hiro.some((t) => t.id === hiroTask.id) && Object.keys(w2.by_person).length === 1, 'a person linked to a Waiting tag: tagged items wait on them');
  // Agendas.
  const ag = await tool('add_agenda_item', { person: 'Jodi Park', title: 'Budget for fixtures' });
  assert(ag.item.agenda_for === 'Jodi Park' && !ag.item.in_inbox, 'add_agenda_item');
  const la = await tool('list_agenda', { person: 'jodi park' });
  assert(la.agenda.length === 1 && la.waiting_on_them.some((t) => t.id === d1.id), 'list_agenda: agenda + what you wait on them for');
  const lp = await tool('list_people', {});
  assert(lp.people.find((p) => p.name === 'Jodi Park').agenda === 1 && lp.people.find((p) => p.name === 'Jodi Park').waiting === 1, 'list_people with counts');
  const arch = await tool('save_person', { id: hiro.id, archived: true });
  assert(arch.archived && db.people.some((p) => p.id === hiro.id), 'people are archived, not deleted');
  // Tickler.
  const tk = await tool('tickle', { title: 'Reconsider the gym membership', date: '2099-01-15' });
  assert(tk.item.tickler === 'back in the Inbox on 2099-01-15' && tk.item.in_inbox, 'tickle a new reminder');
  const inbox = await tool('list_inbox', {});
  assert(!inbox.items.some((t) => t.id === tk.item.id), 'tickled items are hidden from list_inbox until their day');
  const lt = await tool('list_tickler', {});
  assert(lt.by_day['2099-01-15'].some((t) => t.id === tk.item.id), 'list_tickler by day');
  let past = ''; try { await tool('tickle', { id: tk.item.id, date: '2000-01-01' }); } catch (e) { past = e.message; }
  assert(/after today/.test(past), 'tickle needs a future day');
  const cl = await tool('clarify_item', { id: tk.item.id, decision: 'next_action', tags: ['Phone'] });
  assert(!cl.item.tickler && !cl.item.in_inbox, 'clarifying a tickler item takes it out of the tickler');
  // Reference.
  const r1 = await tool('save_reference', { title: 'Gate code', topic: 'Smith job', hidden_value: '4411#', notes: 'Side gate on Elm St.' });
  assert(r1.has_hidden_value && !r1.hidden_value, 'save_reference hides the value');
  const s1 = await tool('search_reference', { query: 'gate' });
  const s2 = await tool('search_reference', { query: 'elm', reveal: true });
  assert(s1.items[0].title === 'Gate code' && !s1.items[0].hidden_value && s2.items[0].hidden_value === '4411#', 'search_reference; reveal only when asked');
  const filed = await tool('capture', { title: 'Water heater warranty', notes: 'Serial 123' });
  const fr = await tool('clarify_item', { id: filed.id, decision: 'reference', topic: 'Home' });
  assert(fr.reference.topic === 'Home' && fr.reference.notes === 'Serial 123' && db.tasks.find((t) => t.id === filed.id).dropped_at, 'clarify reference files it (the item is dropped, not deleted)');
  await tool('save_reference', { id: r1.id, archived: true });
  assert((await tool('search_reference', { query: 'gate' })).count === 0 && db.reference_items.some((r) => r.id === r1.id), 'archived reference is hidden, not deleted');
  // Trash / done / someday.
  const tr = await tool('capture', { title: 'Old flyer' });
  await tool('clarify_item', { id: tr.id, decision: 'trash' });
  assert(db.tasks.find((t) => t.id === tr.id).dropped_at, 'clarify trash drops');
  const sd = await tool('capture', { title: 'Learn Italian' });
  const sdo = await tool('clarify_item', { id: sd.id, decision: 'someday' });
  assert(sdo.item.tags.includes('Someday') && db.tags.find((g) => g.name === 'Someday').status === 'on_hold' && !sdo.item.in_inbox, 'clarify someday: on-hold Someday tag');
}
// ---------- Weekly Review, mind sweep, Someday/Maybe ----------
{
  const st0 = await tool('weekly_review', {});
  assert(!st0.in_progress && st0.steps.length === 12 && st0.steps[0].key === 'papers' && st0.steps.some((x) => x.key === 'notes') && st0.minutes_left > 0, 'weekly_review status before starting');
  const started = await tool('weekly_review', { action: 'start' });
  assert(started.in_progress && db.weekly_reviews.length === 1, 'weekly_review start saves a review');
  const inboxStep = started.steps.find((x) => x.key === 'inbox');
  assert(inboxStep.done || (inboxStep.data && typeof inboxStep.data.count === 'number'), 'inbox step carries its items');
  const staleT = db.tasks.find((t) => !t.completed_at && !t.dropped_at && !t.in_inbox && t.project_id && !t.waiting_on && !t.agenda_for && !t.tickler && (db.projects.find((p) => p.id === t.project_id) || {}).status === 'active');
  if (staleT) staleT.updated_at = new Date(Date.now() - 100 * 86400000).toISOString();
  const st1 = await tool('weekly_review', { action: 'done_step', step: 'papers' });
  const stale = st1.steps.find((x) => x.key === 'stale');
  assert(st1.steps.find((x) => x.key === 'papers').done && (!staleT || (!stale.done && stale.data.items.some((i) => i.id === staleT.id && i.days_untouched >= 99))), 'done_step, and stale actions are listed');
  let bad = ''; try { await tool('weekly_review', { action: 'done_step', step: 'nope' }); } catch (e) { bad = e.message; }
  assert(/step must be/.test(bad), 'done_step checks the step');
  const fin = await tool('weekly_review', { action: 'finish' });
  assert(fin.finished && db.weekly_reviews[0].completed_at && fin.stats.captured >= 0 && fin.streak_weeks === 1, 'finish records stats and streak');
  const prompts = await tool('mind_sweep_prompts', {});
  assert(prompts.count === 56 && prompts.prompts[0].group === 'Work', 'mind_sweep_prompts: the full list');
  db.user_settings.push({ user_id: UID, trigger_hidden: ['t1'], trigger_custom: [{ id: 'c1', group: 'Personal', text: 'Rental properties' }] });
  const p2 = await tool('mind_sweep_prompts', { group: 'Personal' });
  assert(p2.prompts.some((x) => x.prompt === 'Rental properties' && x.yours) && !(await tool('mind_sweep_prompts', {})).prompts.some((x) => x.prompt === 'Projects started but not finished' && x.group === 'Work'), 'mind_sweep_prompts: hidden left out, custom added');
  const sd1 = await tool('capture', { title: 'Drive the Pacific Coast Highway' });
  await tool('clarify_item', { id: sd1.id, decision: 'someday', category: 'Travel' });
  const ls = await tool('list_someday', {});
  assert(ls.by_category.Travel && ls.by_category.Travel[0].id === sd1.id && ls.by_category.Travel[0].parked_days === 0, 'clarify someday with a category; list_someday groups by it');
  const act = await tool('activate_someday', { id: sd1.id, tags: ['Phone'] });
  assert(act.item.tags.includes('Phone') && !act.item.tags.some((x) => /someday/i.test(x)) && !act.item.in_inbox, 'activate_someday: Someday tags off, next action');
}
{
  const { sendReviewReminders, localDayMinutes } = await import('./src/reminders.js');
  const fri4 = new Date('2026-09-25T21:00:00Z'); // Friday 4pm in Chicago
  const ldm = localDayMinutes(fri4, 'America/Chicago');
  assert(ldm.day === 5 && ldm.minutes === 960, 'local weekday and time in the user\'s zone');
  const calls = []; const settings = [{ user_id: 'u9', review_day: 5, review_minutes: 900, review_notified_at: null, timezone: 'America/Chicago' }]; let reviews = [];
  const fakeRest = async (path, opts = {}) => { calls.push([opts.method || 'GET', path, opts.body]); if (path.startsWith('user_settings?review_notify')) return settings; if (path.startsWith('weekly_reviews')) return reviews; if (path.startsWith('push_subscriptions')) return []; return []; };
  assert(await sendReviewReminders(env, fakeRest, fri4) === 1 && calls.some(([m, p, b]) => m === 'POST' && p === 'push_log' && b.kind === 'review' && /Weekly Review/.test(b.title)), 'review reminder sent on the review day after the review time');
  assert(calls.some(([m, p, b]) => m === 'PATCH' && p.startsWith('user_settings?user_id=eq.u9') && b.review_notified_at), 'marked so it is sent once');
  settings[0].review_notified_at = fri4.toISOString();
  assert(await sendReviewReminders(env, fakeRest, new Date(fri4.getTime() + 30 * 60000)) === 0, 'not sent twice');
  settings[0].review_notified_at = null; reviews = [{ id: 'r1' }];
  assert(await sendReviewReminders(env, fakeRest, fri4) === 0, 'not sent if a review was done in the last 5 days');
  reviews = [];
  assert(await sendReviewReminders(env, fakeRest, new Date('2026-09-24T21:00:00Z')) === 0 && await sendReviewReminders(env, fakeRest, new Date('2026-09-25T19:00:00Z')) === 0, 'not on other days or before the time');
}
// ---------- Horizons of Focus, what_now ----------
{
  const area = await tool('save_area', { name: 'Click Plumbing', standards: 'Every job invoiced within 2 days.' });
  const pr = (await tool('create_project', { name: 'Maintenance plan launch', outcome: 'Ten customers on a plan', area: 'Click Plumbing' }));
  assert(pr.outcome === 'Ten customers on a plan' && pr.area_id === area.id, 'create_project with outcome and area');
  let bad = ''; try { await tool('update_project', { project: pr.id, goal: 'Nope' }); } catch (e) { bad = e.message; }
  assert(/No goal "Nope"/.test(bad), 'unknown goal: clear error');
  const goal = await tool('save_goal', { title: 'Grow maintenance revenue', target: '2027-06-30', area: 'Click Plumbing', projects: ['Maintenance plan launch'] });
  assert(goal.status === 'active' && db.projects.find((p) => p.id === pr.id).goal_id === goal.id, 'save_goal links projects');
  const up = await tool('update_project', { project: pr.id, outcome: 'Ten customers signed up' });
  assert(up.outcome === 'Ten customers signed up', 'update_project outcome');
  await tool('save_horizon', { kind: 'purpose', text: 'Build things that last.\nTreat people fairly.', read: true });
  await tool('save_horizon', { kind: 'vision', text: 'Two crews, no nights on the phone.', year: 2029 });
  const hz = await tool('list_horizons', {});
  assert(hz.goals.some((g) => g.title === 'Grow maintenance revenue' && g.projects.includes('Maintenance plan launch')) && hz.areas.some((a) => a.name === 'Click Plumbing' && a.standards) && hz.vision.year === 2029 && hz.purpose.text === 'Build things that last.', 'list_horizons: goals, areas, purpose (first line), vision');
  const hzFull = await tool('list_horizons', { include_text: true });
  assert(hzFull.purpose.text.includes('Treat people fairly'), 'list_horizons include_text');
  const empty = await tool('save_area', { name: 'Health' });
  assert((await tool('list_horizons', {})).areas.find((a) => a.name === 'Health').warnings.includes('nothing active'), 'balance: an area with nothing active is flagged');
  await tool('save_area', { id: 'Health', archived: true });
  assert(db.areas.find((a) => a.id === empty.id).archived_at && !(await tool('list_horizons', {})).areas.some((a) => a.name === 'Health'), 'areas archive, not delete');
  // what_now: goal-serving action ranks above a plain one; context and time filter.
  const act = await tool('capture', { title: 'Call three customers about plans', project: pr.id, tags: ['Phone'], estimate_minutes: 10 });
  const plain = await tool('capture', { title: 'Sort the parts bin', tags: ['Phone'], estimate_minutes: 10 });
  const flagged = await tool('capture', { title: 'Return the inspector’s call', tags: ['Phone'], flagged: true, estimate_minutes: 5 });
  const wn = await tool('what_now', { where: 'Phone', minutes: 15, energy: 'medium', limit: 10 });
  const order = wn.items.map((x) => x.id);
  assert(order.indexOf(flagged.id) < order.indexOf(act.id) && order.indexOf(act.id) < order.indexOf(plain.id), 'what_now ranks flagged > serves a goal > the rest');
  assert(wn.items.find((x) => x.id === act.id).why.includes('serves: Grow maintenance revenue') && wn.items.every((x) => x.tags.includes('Phone') || (x.project_tags || []).includes('Phone')), 'what_now explains why; context filters');
  const short = await tool('what_now', { where: 'Phone', minutes: 5 });
  assert(short.items.every((x) => !x.estimate_minutes || x.estimate_minutes <= 5) && short.items.some((x) => x.id === flagged.id), 'what_now respects the time available');
  const achieved = await tool('save_goal', { id: 'Grow maintenance revenue', status: 'achieved' });
  assert(achieved.status === 'achieved', 'goals are achieved, not deleted');
}
// ---------- plan_project ----------
{
  const pj = await tool('create_project', { name: 'Smith bathroom remodel' });
  const saved = await tool('plan_project', { project: 'Smith bathroom remodel', action: 'save', purpose: 'Usable by the holidays', principles: ['Under $18k', 'Water off 2 days max'], outcome: 'Final inspection passed',
    groups: [{ name: 'Permits', in_order: true }, { name: 'Materials' }],
    ideas: [{ text: 'Book the tile sub', next: true }, { text: 'Pull permit', where: 'Permits', next: true }, { text: 'Rough-in inspection', where: 'Permits' }, { text: 'Order vanity', where: 'Materials' }, { text: 'Heated floor', where: 'someday' }] });
  assert(saved.purpose === 'Usable by the holidays' && saved.principles.length === 2 && saved.preview.groups === 2 && saved.preview.actions === 4 && saved.preview.someday === 1 && saved.ideas.find((i) => i.text === 'Pull permit').next, 'plan_project save: purpose, principles, outcome, ideas, preview');
  let bad = ''; try { await tool('plan_project', { project: pj.id, action: 'save', ideas: [{ text: 'x', where: 'Nowhere' }] }); } catch (e) { bad = e.message; }
  assert(/isn't a group/.test(bad), 'plan_project: unknown group is an error');
  const made = await tool('plan_project', { project: pj.id, action: 'create' });
  assert(made.created.actions === 6 && db.tasks.some((t) => t.title === 'Permits' && t.steps_in_order) && made.project.outcome === 'Final inspection passed' && made.project.principles.length === 2, 'plan_project create');
  const twice = await call('tools/call', { name: 'plan_project', arguments: { project: pj.id, action: 'create' } });
  assert(twice.body.result.isError && /already created/.test(twice.body.result.content[0].text), 'can’t create twice');
  const un = await tool('plan_project', { project: pj.id, action: 'undo' });
  assert(un.undone.tasks_dropped === 6 && db.tasks.filter((t) => t.project_id === pj.id && !t.dropped_at).length === 0, 'plan_project undo drops what it made');
}
// ---------- capture from anywhere, BCC → Waiting For ----------
{
  const CAP = 'tt_' + 'c'.repeat(32);
  db.api_tokens.push({ id: 'cap1', user_id: UID, token_hash: createHash('sha256').update(CAP).digest('hex'), scope: 'capture' });
  const cap = async (body, { token = CAP, type = 'application/json' } = {}) => {
    const r = await worker.fetch(new Request('https://mcp.todotooling.com/capture', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body }), env, ctx);
    return { status: r.status, body: await r.json() };
  };
  const c1 = await cap({ text: 'Order two more cases of PEX elbows' });
  const t = db.tasks.find((x) => x.id === c1.body.id);
  assert(c1.status === 200 && /Captured ✓/.test(c1.body.message) && t.in_inbox && t.title === 'Order two more cases of PEX elbows' && t.source === 'capture', '/capture: text → Inbox item');
  const cg = await cap({ title: 'Price a second trailer', gain: 'Two crews on Fridays' });
  const cgt = await cap({ text: 'Price a van rack → no more ladder runs\nGain: ignored when the title has one' });
  const cgl = await cap({ text: 'Call the bank\nGain: lower rate on the truck loan\nask for Sam' });
  assert(db.tasks.find((x) => x.id === cg.body.id).gain === 'Two crews on Fridays' && db.tasks.find((x) => x.id === cgt.body.id).gain === 'no more ladder runs' && db.tasks.find((x) => x.id === cgt.body.id).title === 'Price a van rack'
    && db.tasks.find((x) => x.id === cgl.body.id).gain === 'lower rate on the truck loan' && db.tasks.find((x) => x.id === cgl.body.id).notes === 'ask for Sam' && !cg.body.fits, '/capture: gain field, "Idea → gain", or a Gain: line (and a capture key reads nothing back)');
  const c2 = await cap({ text: 'https://www.rheem.com/tankless-spec' });
  assert(db.tasks.find((x) => x.id === c2.body.id).title === 'rheem.com/tankless-spec' && db.tasks.find((x) => x.id === c2.body.id).notes.includes('https://www.rheem.com/tankless-spec'), '/capture: a shared link becomes a readable title, link in notes');
  const c3 = await cap({ text: 'Receipt: Home Depot $214', files: [{ name: 'receipt.jpg', mime: 'image/jpeg', base64: btoa('jpegbytes') }] });
  assert(c3.body.attachments === 1 && db.attachments.some((a) => a.task_id === c3.body.id && a.name === 'receipt.jpg' && a.mime === 'image/jpeg'), '/capture: photo attached');
  const fd = new FormData(); fd.append('text', 'Tankless spec sheet'); fd.append('file', new Blob(['%PDF'], { type: 'application/pdf' }), 'spec.pdf');
  const c4r = await worker.fetch(new Request('https://mcp.todotooling.com/capture', { method: 'POST', headers: { Authorization: `Bearer ${CAP}` }, body: fd }), env, ctx);
  const c4 = await c4r.json();
  assert(c4.ok && db.attachments.some((a) => a.task_id === c4.id && a.name === 'spec.pdf'), '/capture: multipart form with a file (Share sheet)');
  const plain = await worker.fetch(new Request('https://mcp.todotooling.com/capture', { method: 'POST', headers: { Authorization: `Bearer ${CAP}`, 'Content-Type': 'text/plain' }, body: 'Call the inspector\nabout Tuesday' }), env, ctx);
  const pj = await plain.json();
  assert(db.tasks.find((x) => x.id === pj.id).title === 'Call the inspector' && db.tasks.find((x) => x.id === pj.id).notes === 'about Tuesday', '/capture: plain text, first line is the title');
  const imgR = await worker.fetch(new Request('https://mcp.todotooling.com/capture', { method: 'POST', headers: { Authorization: `Bearer ${CAP}`, 'Content-Type': 'image/jpeg' }, body: new Uint8Array([255, 216, 255, 224]) }), env, ctx);
  const img = await imgR.json();
  assert(/^Photo · \d{1,2}:\d{2} [AP]M$/.test(img.title) && db.attachments.some((a) => a.task_id === img.id && a.mime === 'image/jpeg' && a.name === 'Photo.jpg'), '/capture: a photo from the Share sheet (raw body) → "Photo · 3:42 PM" with the photo');
  const nT = db.tasks.length;
  const test = await cap({ text: 'Test from Settings', test: true });
  assert(test.body.test && db.tasks.length === nT, '/capture test: checks the key, adds nothing');
  assert((await cap({ text: 'x' }, { token: 'tt_' + 'z'.repeat(32) })).status === 401, '/capture: unknown key refused');
  const geo = 'tt_' + 'g'.repeat(32); db.api_tokens.push({ id: 'geo9', user_id: UID, token_hash: createHash('sha256').update(geo).digest('hex'), scope: 'geo' });
  assert((await cap({ text: 'x' }, { token: geo })).status === 401, '/capture: a location key can’t capture');
  const mcpWithCap = await call('tools/list', {}, CAP);
  assert(mcpWithCap.status === 401, 'a capture key can’t use MCP (read or change anything)');

  // Email: BCC'd (the Inbox isn't in To) → Waiting For on the To person.
  const { followTag, nameFor } = await import('./src/capture.js');
  const fri = followTag('Signed change order [fri]', new Date('2026-09-23T15:00:00Z'), 'America/Chicago');
  assert(fri.subject === 'Signed change order' && fri.days === 2 && followTag('Quote [3d]').days === 3 && followTag('Quote [2w]').days === 14 && followTag('No tag').days === null, 'follow-up tags: [fri], [3d], [2w]');
  assert(nameFor({ address: 'jodi.park@parkhomes.com' }) === 'Jodi Park' && nameFor({ name: 'Hiro Tanaka', address: 'h@x.com' }) === 'Hiro Tanaka', 'names from addresses');
  const rawTo = (to, subject, body, extra = []) => ['From: Robert <robert@douglasmining.com>', `To: ${to}`, ...extra, `Subject: ${subject}`, 'Date: Wed, 23 Sep 2026 10:00:00 -0500', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const send = async (raw) => { const m = { from: 'robert@douglasmining.com', to: 'inbox@todotooling.com', raw, headers: new Headers({ 'arc-authentication-results': 'dkim=pass header.d=douglasmining.com; dmarc=pass' }), rejected: null, setReject(r) { this.rejected = r; } }; await worker.email(m, env); return m; };
  const n0 = db.tasks.length;
  const bcc = await send(rawTo('Jodi Park <jodi@parkhomes.com>, Hiro <hiro@example.com>', 'Re: Signed change order [3d]', 'Hi Jodi, can you sign and send back the change order?'));
  const w = db.tasks[db.tasks.length - 1];
  const jodiP = db.people.find((p) => p.email === 'jodi@parkhomes.com');
  assert(!bcc.rejected && db.tasks.length === n0 + 1 && w.title === 'Signed change order' && w.waiting_on === jodiP.id && !w.in_inbox && w.follow_up_at && w.delegated_at, 'BCC to the Inbox → Waiting For on the To person, tag stripped');
  assert(jodiP.added_via === 'email' && jodiP.name === 'Jodi Park' && w.notes.includes('Emailed Jodi Park <jodi@parkhomes.com>') && w.notes.includes('Also to: Hiro'), 'the person is created from the email, others noted');
  const days = Math.round((Date.parse(w.follow_up_at) - Date.now()) / 86400000);
  assert(days >= 2 && days <= 3, 'follow-up from the [3d] tag');
  await send(rawTo('Jodi Park <jodi@parkhomes.com>', 'Permit copy', 'Can you send the permit copy?'));
  const w2 = db.tasks[db.tasks.length - 1];
  assert(w2.waiting_on === jodiP.id && db.people.filter((p) => p.email === 'jodi@parkhomes.com').length === 1, 'the same person is reused by email');
  const d2 = Math.round((Date.parse(w2.follow_up_at) - Date.now()) / 86400000);
  assert(d2 >= 6 && d2 <= 7, 'no tag: the default follow-up (a week)');
  await send(rawTo('Hiro <hiro@example.com>', 'Quote', 'x', ['Cc: inbox@todotooling.com']));
  assert(db.tasks[db.tasks.length - 1].waiting_on === db.people.find((p) => p.email === 'hiro@example.com').id, 'CC works too');
  await send(rawTo('inbox@todotooling.com', 'Buy a trailer lock', 'x'));
  assert(db.tasks[db.tasks.length - 1].in_inbox && !db.tasks[db.tasks.length - 1].waiting_on, 'sent To the Inbox: an Inbox item as before');
  const mp = ['From: Robert <robert@douglasmining.com>', 'To: Jodi Park <jodi@parkhomes.com>', 'Subject: Change order to sign', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain; charset=utf-8', '', 'Attached.', '--b1', 'Content-Type: application/pdf; name="co.pdf"', 'Content-Disposition: attachment; filename="co.pdf"', 'Content-Transfer-Encoding: base64', '', btoa('%PDF-1.4 change order'), '--b1--', ''].join('\r\n');
  await send(mp);
  const wa = db.tasks[db.tasks.length - 1];
  assert(wa.waiting_on && db.attachments.some((a) => a.task_id === wa.id && a.name === 'co.pdf' && a.mime === 'application/pdf'), 'email attachments are saved to the item');
}
// ---------- Schedule it, the calendar feed, checklists ----------
{
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const est = await tool('capture', { title: 'Write the Smith estimate', project: 'Smith bathroom remodel', estimate_minutes: 90 });
  const sch = await tool('update_task', { id: est.id, schedule: `${day}T10:30` });
  const row = db.tasks.find((t) => t.id === est.id);
  assert(sch.scheduled.at === `${day}T10:30` && sch.scheduled.minutes === 90 && row.planned_at === row.scheduled_at, 'update_task schedule: local time, length from the estimate, also planned');
  let bad = ''; try { await tool('update_task', { id: est.id, schedule: 'tomorrow 3pm' }); } catch (e) { bad = e.message; }
  assert(/YYYY-MM-DDTHH:MM/.test(bad), 'schedule format checked');
  const fc = await tool('forecast', { days: 3 });
  assert(fc.days[day].scheduled.some((t) => t.id === est.id) && !fc.days[day].planned.some((t) => t.id === est.id), 'forecast lists it under scheduled for that day');
  // The feed.
  const FEED = 'tt_' + 'f'.repeat(32);
  db.api_tokens.push({ id: 'feed1', user_id: UID, token_hash: createHash('sha256').update(FEED).digest('hex'), scope: 'feed' });
  const fr = await worker.fetch(new Request(`https://mcp.todotooling.com/feed/${FEED}.ics`), env, ctx);
  const ics = await fr.text();
  assert(fr.status === 200 && fr.headers.get('content-type').startsWith('text/calendar') && ics.includes('BEGIN:VCALENDAR') && ics.includes(`UID:${est.id}@todotooling.com`) && ics.includes('SUMMARY:Write the Smith estimate') && ics.includes('X-WR-CALNAME:Todo Tooling'), 'feed: scheduled actions as events');
  const dt = ics.match(/DTSTART:(\d{8}T\d{6}Z)/)[1]; const de = ics.match(/DTEND:(\d{8}T\d{6}Z)/)[1];
  const toMs = (x) => Date.UTC(+x.slice(0, 4), +x.slice(4, 6) - 1, +x.slice(6, 8), +x.slice(9, 11), +x.slice(11, 13));
  assert((toMs(de) - toMs(dt)) === 90 * 60000, 'feed: event length is the time block');
  assert((await worker.fetch(new Request(`https://mcp.todotooling.com/feed/tt_${'x'.repeat(32)}.ics`), env, ctx)).status === 404, 'feed: unknown or reset link → 404');
  const CAPK = 'tt_' + 'c'.repeat(32);
  assert((await worker.fetch(new Request(`https://mcp.todotooling.com/feed/${CAPK}.ics`), env, ctx)).status === 404, 'feed: a capture key can’t read the feed');
  await tool('update_task', { id: est.id, schedule: null });
  assert(!db.tasks.find((t) => t.id === est.id).scheduled_at, 'unschedule');
  // Checklists.
  const ck = await tool('save_checklist', { name: 'Month-end close', items: ['# Money in', 'Invoice every finished job', 'Chase anything 30+ days', '# Money out', 'Reconcile the card'] });
  assert(ck.items === 3 && ck.sections.join() === 'Money in,Money out' && ck.complete_action, 'save_checklist with sections');
  const me = await tool('capture', { title: 'Month-end close', repeat: { every: 1, unit: 'month' } });
  await tool('save_checklist', { id: 'Month-end close', attach_to: me.id });
  assert(db.tasks.find((t) => t.id === me.id).checklist_id === ck.id, 'attach to an action');
  const r1 = await tool('run_checklist', { checklist: 'Month-end close', task: me.id, tick: ['Invoice every finished job', 2] });
  assert(r1.ticked === 2 && r1.of === 3 && r1.items[0].done && !r1.items[2].done && !r1.finished, 'run_checklist ticks by text or number');
  const r2 = await tool('run_checklist', { checklist: 'Month-end close', task: me.id, tick: ['reconcile'] });
  assert(r2.finished && r2.action_completed && db.tasks.find((t) => t.id === me.id).completed_at, 'last tick finishes the run and completes the action');
  const lc = await tool('list_checklists', {});
  assert(lc.checklists[0].last_run && lc.checklists[0].last_run.ticked === 3, 'list_checklists shows the last run');
  const solo = await tool('run_checklist', { checklist: ck.id });
  assert(solo.ticked === 0 && solo.items.length === 3, 'a new run starts fresh');
  await tool('save_checklist', { id: ck.id, archived: true });
  assert(db.checklists.find((c) => c.id === ck.id).archived_at && (await tool('list_checklists', {})).checklists.length === 0, 'checklists archive, not delete');
}
// ---------- daily review ----------
{
  const b = await tool('daily_review', {});
  assert(b.day && !b.started && b.must_dos && typeof b.must_dos.inbox_count === 'number' && Array.isArray(b.suggestions) && b.suggestions.every((x) => Array.isArray(x.why)), 'daily_review briefing: calendar, must-dos, suggestions with reasons');
  const picks = b.suggestions.slice(0, 4).map((x) => x.id);
  const f = await tool('daily_review', { action: 'focus', ids: picks });
  assert(f.focus.length === Math.min(3, picks.length) && db.daily_reviews.length === 1 && db.daily_reviews[0].focus.length === f.focus.length, 'focus: up to 3 saved for today');
  const p0 = db.tasks.find((t) => t.id === f.focus[0].id);
  assert(p0.planned_at && Math.abs(Date.parse(p0.planned_at) - Date.now()) < 24 * 3600e3, 'focus items are planned today');
  const st = await tool('daily_review', { action: 'start' });
  assert(st.started && db.daily_reviews[0].started_at, 'start marks the day started');
  await tool('update_task', { id: f.focus[0].id, status: 'completed' });
  const w = await tool('daily_review', { action: 'wrapup' });
  assert(w.done === 1 && w.focus.length === f.focus.length && w.tomorrow.day, 'wrapup: what got done, tomorrow at a glance');
  const rest = w.focus.filter((x) => !x.done);
  const c = await tool('daily_review', { action: 'carry', carry: rest.map((x, i) => ({ id: x.id, to: i === 0 ? 'tomorrow' : 'drop' })) });
  if (rest[0]) { const t = db.tasks.find((x) => x.id === rest[0].id); assert(Date.parse(t.planned_at) > Date.now() && !t.scheduled_at, 'carry: tomorrow'); }
  if (rest[1]) assert(db.tasks.find((x) => x.id === rest[1].id).dropped_at, 'carry: drop (not delete)');
  const sd = await tool('daily_review', { action: 'shutdown' });
  assert(sd.shut_down && db.daily_reviews[0].shutdown_at, 'shutdown closes the day');
  // Morning reminder: off by default; when on, once, weekdays, not after starting.
  const { sendDailyReminders } = await import('./src/reminders.js');
  const calls = []; const settings = [{ user_id: 'u9', daily_minutes: 420, daily_weekdays_only: true, daily_notified_at: null, timezone: 'America/Chicago' }]; let started = [];
  const fake = async (path, opts = {}) => { calls.push([opts.method || 'GET', path, opts.body]); if (path.startsWith('user_settings?daily_notify')) return settings; if (path.startsWith('daily_reviews')) return started; return []; };
  const thu730 = new Date('2026-09-24T12:30:00Z'); // Thu 7:30 in Chicago
  assert(await sendDailyReminders(env, fake, thu730) === 1 && calls.some(([m, p2, bd]) => m === 'POST' && p2 === 'push_log' && bd.kind === 'daily'), 'daily reminder at the user\'s time');
  settings[0].daily_notified_at = thu730.toISOString();
  assert(await sendDailyReminders(env, fake, new Date(thu730.getTime() + 30 * 60000)) === 0, 'once a day');
  settings[0].daily_notified_at = null;
  assert(await sendDailyReminders(env, fake, new Date('2026-09-26T12:30:00Z')) === 0, 'weekdays only: not on Saturday');
  started = [{ id: 'x' }];
  assert(await sendDailyReminders(env, fake, thu730) === 0, 'not if the day was already started');
}
// ---------- quarterly and yearly horizon reviews ----------
{
  const { bigReviewsDue } = await import('../js/whatnow.js');
  const now = new Date('2026-09-24T12:00:00Z');
  const old = '2025-01-01T00:00:00Z'; const recent = '2026-09-01T00:00:00Z';
  const b1 = bigReviewsDue({ settings: { purpose: 'Build things that last', purpose_read_at: old, vision: '', horizons_quarter_at: null }, areas: [{ id: 'a', created_at: old }], goals: [{ id: 'g', status: 'active', created_at: old, target_date: '2026-06-30', area_id: 'a' }], projects: [{ id: 'p', status: 'active' }], now });
  assert(b1.yearly.join() === 'purpose' && b1.quarterly && b1.lateGoals.length === 1 && b1.areasNoGoal.length === 0 && b1.looseProjects.length === 1, 'bigReviewsDue: yearly read only for written text; quarterly a quarter after setup; late goals; loose projects');
  const b2 = bigReviewsDue({ settings: { purpose: 'x', purpose_read_at: recent, horizons_quarter_at: recent }, areas: [{ id: 'a', created_at: old }], goals: [], projects: [], now });
  assert(!b2.yearly.length && !b2.quarterly && b2.areasNoGoal.length === 1, 'not due right after doing them; areas with no goal noted');
  const b3 = bigReviewsDue({ settings: {}, areas: [{ id: 'a', created_at: recent }], goals: [], projects: [], now });
  assert(!b3.quarterly && !b3.yearly.length, 'not due right after setting up areas; nothing unwritten is due');
  const h = await tool('list_horizons', {});
  assert(h.reviews_due, 'list_horizons reports reviews due');
  let bad = ''; try { await tool('save_horizon', { kind: 'quarterly' }); } catch (e) { bad = e.message; }
  assert(/read: true/.test(bad), 'quarterly check-in needs read: true');
  const q = await tool('save_horizon', { kind: 'quarterly', read: true });
  assert(q.saved.includes('horizons_quarter_at') && db.user_settings.find((x) => x.user_id === UID).horizons_quarter_at, 'save_horizon quarterly records the check-in');
}
// ---------- Settle in (settle_import) and paged reads ----------
{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  db.imports.push({ id: 'imS', user_id: UID, source: 'omnifocus', counts: { tasks: 1210, projects: 2 }, settle: {}, created_at: ago(0), undone_at: null });
  db.projects.push({ id: 'pS1', user_id: UID, name: 'Huge list', status: 'active', folder_id: null, import_id: 'imS', next_review_at: null, sort: 1, created_at: ago(900) });
  db.projects.push({ id: 'pS2', user_id: UID, name: 'Small one', status: 'on_hold', folder_id: null, import_id: 'imS', next_review_at: ago(-30), sort: 2, created_at: ago(900) });
  const T0 = { user_id: UID, notes: '', parent_id: null, in_inbox: false, flagged: false, due_at: null, defer_at: null, planned_at: null, scheduled_at: null, repeat_rule: null, completed_at: null, dropped_at: null, import_id: 'imS' };
  for (let i = 0; i < 1200; i++) db.tasks.push({ ...T0, id: `stk${i}`, title: `Backlog ${i}`, project_id: 'pS1', sort: i, created_at: ago(i < 30 ? 5 + i / 1000 : 800), updated_at: ago(i < 30 ? 5 + i / 1000 : 800) }); // stk0 is the newest
  db.tasks.push({ ...T0, id: 'stOld', title: 'Ancient', project_id: 'pS2', created_at: ago(2000), updated_at: ago(2000) });
  db.tasks.push({ ...T0, id: 'stDue', title: 'Overdue bill', project_id: 'pS2', due_at: ago(10), created_at: ago(5), updated_at: ago(5) });
  db.tasks.push({ ...T0, id: 'stFlag', title: 'Flag me', project_id: 'pS2', flagged: true, created_at: ago(5), updated_at: ago(5) });
  const st = await tool('settle_import', { import_id: 'imS' });
  assert(st.import_id === 'imS' && st.total_open === 1203, `settle status reads past the 1,000-row page (${st.total_open})`);
  assert(st.old.find((b) => b.bucket === '4y').count === 1 && st.old.find((b) => b.bucket === '2y').count === 1170 && st.big_projects.length === 1 && st.big_projects[0].open === 1200, 'settle status: age buckets and big projects');
  assert(st.overdue.count === 1 && st.flagged.length === 1 && st.reviews_due === 1 && st.projects_to_decide.length === 2 && st.steps.length === 10, 'settle status: overdue, flagged, reviews due (the on-hold one isn’t due yet), projects');
  const before = rpcCalls.length;
  await tool('settle_import', { import_id: 'imS', action: 'apply', choice: 'keep_newest', project: 'pS1', keep: 20 });
  const kc = rpcCalls[before];
  assert(kc.fn === 'settle_apply' && kc.body.batch === 'imS' && kc.body.op === 'someday' && kc.body.args.ids.length === 1180 && !kc.body.args.ids.includes('stk0') && kc.body.owner === UID, 'keep_newest: the 20 most recent stay, the rest → Someday');
  await tool('settle_import', { import_id: 'imS', action: 'apply', choice: 'plan_overdue' });
  const pc = rpcCalls[rpcCalls.length - 1];
  assert(pc.body.op === 'plan' && pc.body.args.ids.join() === 'stDue' && /T\d\d:00:00/.test(pc.body.args.at), 'plan_overdue: planned today at the planned hour');
  await tool('settle_import', { import_id: 'imS', action: 'apply', choice: 'spread_reviews' });
  assert(rpcCalls[rpcCalls.length - 1].body.args.items.length === 1, 'spread_reviews: the due ones');
  await tool('settle_import', { import_id: 'imS', action: 'undo', op_id: 'op1' });
  assert(rpcCalls[rpcCalls.length - 1].fn === 'settle_undo' && rpcCalls[rpcCalls.length - 1].body.op_id === 'op1', 'undo calls settle_undo');
  await tool('settle_import', { import_id: 'imS', action: 'apply', choice: 'mark_step_done', step: 'big' });
  assert(db.imports.find((x) => x.id === 'imS').settle.steps.big, 'mark_step_done keeps progress on the import');
  let e = ''; try { await tool('settle_import', { import_id: 'imS', action: 'apply', choice: 'old_to_someday', bucket: '9y' }); } catch (x) { e = x.message; }
  assert(/bucket/.test(e), 'bad bucket refused');
  const lt = await tool('list_tasks', { project: 'Huge list', limit: 500 });
  assert(lt.count === 500 && lt.items.length === 500, 'explicit limits still apply');
}
// ---------- What do I gain? ----------
{
  const { rankNow } = await import('../js/whatnow.js');
  const base = { completed_at: null, dropped_at: null, created_at: new Date().toISOString(), project_id: 'pw' };
  const rk = rankNow([{ ...base, id: 'a', title: 'No gain' }, { ...base, id: 'b', title: 'With gain', gain: 'Crews never wait' }], { projects: [{ id: 'pw', status: 'active', purpose: 'Project reason' }], goals: [], endOfToday: new Date(Date.now() + 3600e3) });
  assert(rk.items[0].t.id === 'b' && rk.items[0].gain === 'Crews never wait' && rk.items[1].gain === 'Project reason', 'what_now: a stated gain ranks higher and is returned (else the project\'s)');
  const eg = emailToTask({ subject: 'Fwd: Trailer quote → two crews on Fridays', text: 'From the dealer\nGain: run two crews without renting\nThanks' }, 'a@b.c');
  assert(eg.title === 'Trailer quote' && eg.gain === 'run two crews without renting' && !eg.notes.includes('Gain:'), 'email: a Gain: line (over the subject arrow) is the gain, and leaves the notes');
  assert(emailToTask({ subject: 'Trailer quote -> two crews' }, 'a@b.c').gain === 'two crews', 'email: "Idea -> gain" in the subject');
  db.projects.push({ id: 'pG1', user_id: UID, name: 'Fleet and equipment', status: 'active', purpose: 'Trailers and trucks ready so crews never wait', purpose_by: null, folder_id: null, sort: 50, created_at: new Date().toISOString() });
  const c = await tool('capture', { title: 'Get a quote on a second trailer', gain: 'Run two crews on Fridays without renting' });
  const row = db.tasks.find((t) => t.id === c.id);
  assert(row.gain === 'Run two crews on Fridays without renting' && row.gain_by === null && c.gain === row.gain, 'capture saves the user\'s gain as theirs');
  assert(c.fits && c.fits[0].project === 'Fleet and equipment' && c.next, 'capture says which project the gain fits');
  const c2 = await tool('capture', { title: 'Try drone mapping', gain: 'Faster site surveys', gain_suggested: true });
  assert(db.tasks.find((t) => t.id === c2.id).gain_by === 'agent' && c2.gain_suggested, 'a drafted gain is marked as a suggestion');
  const miss = await tool('gains', {});
  assert(miss.actions.every((x) => x.id !== c.id && x.id !== c2.id) && typeof miss.actions_without_gain === 'number' && miss.projects.every((p) => p.id !== 'pG1'), 'gains missing: only items with no gain');
  const plain = await tool('capture', { title: 'Order fittings for Frog Pond' });
  const sug = await tool('gains', { action: 'suggest', items: [{ id: plain.id, kind: 'task', gain: 'Rough-in passes on time' }, { id: c.id, kind: 'task', gain: 'Overwrite attempt' }, { id: c2.id, kind: 'task', gain: 'Better drafted gain' }] });
  assert(sug.saved === 2 && sug.skipped.length === 1 && sug.skipped[0].id === c.id && db.tasks.find((t) => t.id === c.id).gain === 'Run two crews on Fridays without renting', 'suggest never overwrites the user\'s words (replaces its own earlier draft)');
  assert(db.tasks.find((t) => t.id === plain.id).gain_by === 'agent' && db.tasks.find((t) => t.id === c2.id).gain === 'Better drafted gain', 'suggestions saved as Claude suggested');
  await tool('update_task', { id: plain.id, gain: 'Rough-in inspection passes Friday' });
  assert(db.tasks.find((t) => t.id === plain.id).gain_by === null, 'update_task gain without gain_suggested: now the user\'s');
  const pl = await tool('gains', { action: 'place', id: c.id });
  assert(pl.fits.length && pl.fits[0].project_id === 'pG1', 'gains place');
  await tool('update_task', { id: c.id, status: 'completed', gain_met: 'yes' });
  const rep = await tool('gains', { action: 'report' });
  assert(rep.got_it.yes >= 1 && rep.examples.some((x) => x.title === 'Get a quote on a second trailer'), 'gains report: did completed work pay off');
  await tool('update_project', { project: 'pG1', gain: 'Crews never wait for equipment', gain_suggested: true });
  const pg = db.projects.find((p) => p.id === 'pG1');
  assert(pg.purpose === 'Crews never wait for equipment' && pg.purpose_by === 'agent', 'update_project gain = purpose, marked suggested');
}
// ---------- sidebar: pinned perspectives ----------
{
  const made = await tool('create_perspective', { name: 'Quick pins', rules: { match: 'all', rules: [{ type: 'flagged' }] }, pinned: false });
  assert(made.pinned === false && db.perspectives.find((p) => p.name === 'Quick pins').pinned === false, 'create_perspective: pinned false keeps it out of the sidebar');
  const again = await tool('update_perspective', { perspective: made.id, pinned: true });
  assert(again.pinned === true, 'update_perspective: pin it');
}
// ---------- Full Review (full_review) ----------
{
  const U4 = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const W = U4(901); const S1 = U4(902); const M = (i) => U4(1000 + i);
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  db.projects.push({ id: 'pRM', user_id: UID, name: 'Movies', status: 'active', folder_id: null, import_id: 'imR', sort: 90, created_at: ago(2000) });
  db.projects.push({ id: 'pRE', user_id: UID, name: 'Estate and legacy', status: 'active', folder_id: null, sort: 91, created_at: ago(10) });
  const T0 = { user_id: UID, notes: '', parent_id: null, in_inbox: false, flagged: false, due_at: null, defer_at: null, planned_at: null, repeat_rule: null, completed_at: null, dropped_at: null, import_id: 'imR', gain: '' };
  db.tasks.push({ ...T0, id: W, title: 'Update my will', project_id: null, created_at: ago(1900), updated_at: ago(1900) });
  for (let i = 0; i < 14; i++) db.tasks.push({ ...T0, id: M(i), title: `Movie ${i}`, project_id: 'pRM', created_at: ago(1500 + i), updated_at: ago(1500 + i) });
  db.tasks.push({ ...T0, id: S1, title: 'Fix the gate latch', project_id: null, created_at: ago(1600), updated_at: ago(1600) });
  const st = await tool('full_review', { action: 'start', import_id: 'imR', title: 'Full Review · test' });
  assert(st.queue.cards === 3 && st.queue.first_because_important === 1 && st.queue.groups === 1 && /#full\//.test(st.app_link), 'full_review start: important first, 14 movies as one group, the rest single');
  assert(st.current.task.title === 'Update my will' && /my will/.test(st.current.why_first) && st.progress.total === 3, 'the first card is the important one, and says why');
  const an = await tool('full_review', { action: 'annotate', gain: 'Family is not left guessing', project: 'Estate and legacy', planned: '2026-10-03', note: 'You said this matters more now.' });
  const w = db.tasks.find((t) => t.id === W);
  const item = db.review_items.find((x) => x.task_id === W);
  assert(w.gain === 'Family is not left guessing' && w.project_id === 'pRE' && w.planned_at && item.changed.gain && item.changed.project && item.changed.dates && item.note === 'You said this matters more now.', 'annotate: updates the action, marks what changed (for the live highlight), keeps the note');
  const ses = db.review_sessions.find((x) => x.id === st.session_id);
  assert(ses.agent_seen_at && ses.agent_status === '' && an.current.task.gain === 'Family is not left guessing', 'presence recorded; the card reflects the change');
  const before = rpcCalls.length;
  await tool('full_review', { action: 'decide', decision: 'keep', note: 'Planned for Saturday' });
  const dc = rpcCalls.slice(before).find((c) => c.fn === 'review_decide');
  assert(dc && dc.body.item === item.id && dc.body.decision === 'keep' && dc.body.by === 'agent' && dc.body.owner === UID, 'decide: review_decide as the agent');
  const grp = db.review_items.find((x) => x.kind === 'group');
  await tool('full_review', { action: 'goto', item_id: grp.id });
  await tool('full_review', { action: 'annotate', proposal: { op: 'keep_newest', keep: 5 }, note: 'A watchlist, not actions' });
  assert(grp.grp.proposal.op === 'keep_newest' && grp.grp.proposal.keep === 5 && grp.changed.proposal, 'a group card’s proposal can be changed before the user accepts');
  await tool('full_review', { action: 'prioritize', task_ids: [M(3)] });
  assert(!grp.grp.task_ids.includes(M(3)) && db.review_items.some((x) => x.task_id === M(3) && x.priority && x.sort > grp.sort && x.sort < grp.sort + 1), 'prioritize pulls one out of its group, right after the current card');
  let bad = ''; try { await tool('full_review', { action: 'decide' }); } catch (e) { bad = e.message; }
  assert(/decision is required/.test(bad), 'decide needs a decision');
  // Suggestions: nothing changes until the user Submits in the app.
  const s1 = db.review_items.find((x) => x.task_id === S1);
  await tool('full_review', { action: 'goto', item_id: s1.id });
  const sg = await tool('full_review', { action: 'suggest', decision: 'keep', title: 'Fix the gate latch before winter', gain: 'Goats stay in', project: 'Estate and legacy', planned: '2026-10-05', flagged: false, add_tags: ['Brand new tag'], note: 'You said before the cold snap' });
  assert(sg.suggested === 1 && s1.suggestion.decision === 'keep' && s1.suggestion.project_id === 'pRE' && s1.suggestion.project_name === 'Estate and legacy' && /^2026-10-05T/.test(s1.suggestion.planned) && s1.suggestion.add_tag_names.includes('Brand new tag') && !s1.suggestion.ahead, 'suggest: resolved and stored on the card');
  assert(db.tasks.find((t) => t.id === S1).title === 'Fix the gate latch' && !db.tasks.find((t) => t.id === S1).gain, 'suggest changes nothing until the user Submits');
  let bad2 = ''; try { await tool('full_review', { action: 'suggest', decision: 'keep', project: 'No such project' }); } catch (e) { bad2 = e.message; }
  assert(/No active project/.test(bad2), 'a suggestion that doesn’t resolve is refused (nothing saved)');
  let bad3 = ''; try { await tool('full_review', { action: 'suggest', decision: 'accept' }); } catch (e) { bad3 = e.message; }
  assert(/decision must be one of/.test(bad3), 'group decisions aren’t allowed on an action card');
  const st2 = await tool('full_review', { action: 'status' });
  assert(st2.current.suggestion && st2.current.suggestion.note === 'You said before the cold snap', 'status shows the pending suggestion');
  const up = await tool('full_review', { action: 'upcoming', count: 3 });
  assert(Array.isArray(up.cards), 'upcoming: the next cards in one go');
  const nextTask = db.review_items.find((x) => x.kind === 'task' && x.status === 'pending' && x.id !== s1.id && x.task_id !== W);
  if (nextTask) {
    const ah = await tool('full_review', { action: 'suggest', items: [{ item_id: nextTask.id, decision: 'someday', note: 'Like the other movies' }] });
    assert(ah.items[0].ahead === true && nextTask.suggestion.ahead === true, 'drafted ahead: marked as such');
  }
  const before2 = db.review_items.length;
  const ad = await tool('full_review', { action: 'add', title: 'Ask the bank about a HELOC', gain: 'Cash for the barn without selling' });
  const newTask = db.tasks.find((t) => t.title === 'Ask the bank about a HELOC');
  const newCard = db.review_items.find((x) => x.task_id === (newTask || {}).id);
  assert(newTask && newTask.in_inbox !== false && newTask.gain === 'Cash for the barn without selling' && newCard && db.review_items.length === before2 + 1 && newCard.sort === Math.max(...db.review_items.filter((x) => x.session_id === st.session_id).map((x) => x.sort)) && ad.added.title === 'Ask the bank about a HELOC', 'add: a new idea is captured and becomes the last card');
  const ls = await tool('full_review', { action: 'list' });
  assert(ls.some((x) => x.id === st.session_id), 'list sessions');
}
// ---------- slipbox and reading ----------
{
  const a1 = await tool('slipbox', { action: 'add', title: 'Links beat folders', body: 'A note can live in many places at once.' });
  const a2 = await tool('slipbox', { action: 'add', title: 'Surprise is the test', body: 'Keep what surprises me. See [[Links beat folders]] and [[Not written yet]].', source: 'Ahrens p.112' });
  assert(a1.kind === 'fleeting' && a2.links.includes('Links beat folders'), 'slipbox add: fleeting, [[links]] read from the body');
  const g = await tool('slipbox', { action: 'get', note: 'Links beat folders' });
  assert(g.linked_from.includes('Surprise is the test') && g.links.length === 0, 'slipbox get: backlinks');
  const g2 = await tool('slipbox', { action: 'get', note: a2.id });
  assert(g2.links.join() === 'Links beat folders' && g2.missing_links.join() === 'Not written yet', 'slipbox get: resolved links and ones not written yet');
  const up = await tool('slipbox', { action: 'update', note: a1.id, kind: 'permanent' });
  assert(up.kind === 'permanent' && up.processed, 'slipbox update: permanent = processed');
  const ls = await tool('slipbox', { action: 'list', kind: 'fleeting' });
  assert(ls.fleeting === 1 && ls.notes.length === 1 && ls.notes[0].title === 'Surprise is the test', 'slipbox list: fleeting ones waiting');
  const fq = await tool('slipbox', { action: 'list', q: 'surprises' });
  assert(fq.notes.length === 1, 'slipbox list: search');
  await tool('slipbox', { action: 'archive', note: a1.id });
  assert(db.slipbox_notes.find((n) => n.id === a1.id).archived_at, 'slipbox archive (never deleted)');
  const ft = await tool('capture', { title: 'Idea: a feeder funnels Austin to Kingsbury' });
  const b0 = rpcCalls.length;
  await tool('slipbox', { action: 'from_task', task_id: ft.id, source: 'Robert' });
  assert(rpcCalls.slice(b0).some((c) => c.fn === 'slipbox_from_task' && c.body.task === ft.id && c.body.owner === UID), 'slipbox from_task → slipbox_from_task');
  const b1 = rpcCalls.length;
  const ra = await tool('reading', { action: 'add', title: 'Tales of the Nuclear Age', type: 'book' });
  assert(db.tasks.some((t) => t.title === 'Tales of the Nuclear Age') && rpcCalls.slice(b1).some((c) => c.fn === 'reading_set' && c.body.state === 'up_next' && c.body.rtype === 'book'), 'reading add: captured and put up next');
  const b2 = rpcCalls.length;
  await tool('reading', { action: 'move', task_id: ra.id, state: 'reading' });
  assert(rpcCalls.slice(b2).some((c) => c.fn === 'reading_set' && c.body.state === 'reading'), 'reading move → reading_set');
  const tn = await tool('reading', { action: 'take_notes', task_id: ra.id, body: 'Deterrence depends on belief' });
  assert(db.slipbox_notes.some((n) => n.id === tn.note.id && n.reading_task_id === ra.id && n.source === 'Tales of the Nuclear Age'), 'reading take_notes: a fleeting note linked to it');
  await tool('reading', { action: 'notes_done', task_id: ra.id });
  assert(db.tasks.find((t) => t.id === ra.id).reading_notes_done === true, 'reading notes_done');
  const inb = await tool('capture', { title: 'Read the untools article' });
  const b3 = rpcCalls.length;
  const cr = await tool('clarify_item', { id: inb.id, decision: 'reading', type: 'article' });
  assert(cr.decision === 'reading' && rpcCalls.slice(b3).some((c) => c.fn === 'reading_set' && c.body.rtype === 'article'), 'clarify_item reading');
  const inb2 = await tool('capture', { title: 'Luhmann on surprise' });
  const b4 = rpcCalls.length;
  const cs = await tool('clarify_item', { id: inb2.id, decision: 'slipbox', source: 'Ahrens' });
  assert(cs.decision === 'slipbox' && rpcCalls.slice(b4).some((c) => c.fn === 'slipbox_from_task' && c.body.source === 'Ahrens'), 'clarify_item slipbox');
}
console.log('ALL PASSED');
