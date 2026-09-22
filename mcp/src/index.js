// Todo Tooling MCP server (Cloudflare Worker) at https://mcp.todotooling.com/mcp
//
// Stateless MCP over Streamable HTTP: every JSON-RPC request is a POST that gets
// a single JSON response. Callers authenticate with a personal access token
// (created in the app's Settings) sent as `Authorization: Bearer tt_...`.
// The Worker talks to Supabase with a server-side secret key, so every query
// below is explicitly scoped to the token owner's user_id.

const SERVER_INFO = { name: 'todotooling', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Todo Tooling is the user's GTD system. Capture anything new with capture (it lands in the Inbox).
Clarify inbox items with update_task: give each a project and/or tags (contexts like "Laptop", people like "Waiting : Hiro"); an item leaves the Inbox once it has a project or tag.
Use due dates only for hard deadlines; use flagged for "today-ish". Dates are YYYY-MM-DD in the user's timezone.
Never complete, reschedule or re-file tasks the user did not ask you to change.`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' && request.method === 'GET') {
      return text('Todo Tooling MCP server. Endpoint: POST /mcp with Authorization: Bearer <token from todotooling.com Settings>.');
    }
    if (url.pathname !== '/mcp') return text('Not found', 404);
    if (request.method !== 'POST') return text('Method not allowed', 405, { Allow: 'POST' });

    if (!(env.SUPABASE_SECRET_KEY || '').trim()) {
      return json(rpcError(null, -32002, 'Server not configured: SUPABASE_SECRET_KEY is missing or empty'), 503);
    }
    let auth;
    try {
      auth = await authenticate(request, env, ctx);
    } catch (e) {
      return json(rpcError(null, -32603, `Auth lookup failed: ${e.message}`), 502);
    }
    if (!auth) {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <token>' } }, 401,
        { 'WWW-Authenticate': 'Bearer realm="todotooling"' });
    }

    let body;
    try { body = await request.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
    const api = new Api(env, auth.userId);
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m, api)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await handle(body, api);
    return out ? json(out) : new Response(null, { status: 202, headers: CORS });
  },
};

async function handle(msg, api) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return ok(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        try {
          const result = await tool.run(api, args);
          return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          return ok(msg.id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    return rpcError(msg.id, -32603, e.message);
  }
}

// ---------- auth ----------
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authenticate(request, env, ctx) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(tt_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  const rows = await rest(env, `api_tokens?token_hash=eq.${hash}&select=id,user_id`);
  if (!rows.length) return null;
  ctx.waitUntil(rest(env, `api_tokens?id=eq.${rows[0].id}`, { method: 'PATCH', body: { last_used_at: new Date().toISOString() } }).catch(() => {}));
  return { userId: rows[0].user_id };
}

// ---------- Supabase REST ----------
async function rest(env, path, { method = 'GET', body, prefer } = {}) {
  const key = env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('ey')) headers.Authorization = `Bearer ${key}`; // legacy service_role JWT
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Database error ${res.status}: ${raw}`);
  return raw ? JSON.parse(raw) : [];
}

const inList = (ids) => `in.(${ids.map((id) => `"${id}"`).join(',')})`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function mustUuid(v, field) {
  if (!UUID.test(String(v || ''))) throw new Error(`${field} must be a task/project id (uuid)`);
  return v;
}

// ---------- dates (user's timezone) ----------
// Converts YYYY-MM-DD at a wall-clock hour in `tz` to an ISO instant. Full ISO strings pass through.
function zonedToIso(value, hour, tz) {
  if (value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value);
    if (isNaN(d)) throw new Error(`Invalid date: ${value}`);
    return d.toISOString();
  }
  const [y, m, d] = value.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asIfUtc - guess)).toISOString();
}
function localDate(iso, tz) {
  if (!iso) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ---------- data access, always scoped to one user ----------
class Api {
  constructor(env, userId) {
    this.env = env;
    this.userId = userId;
    this.tz = env.TIMEZONE || 'America/Chicago';
    this.u = `user_id=eq.${userId}`;
  }
  q(path, opts) { return rest(this.env, path, opts); }

  async lookups() {
    const [projects, tags] = await Promise.all([
      this.q(`projects?${this.u}&select=id,name,status,folder_id`),
      this.q(`tags?${this.u}&select=id,name,parent_id`),
    ]);
    const tagLabel = (t) => {
      const p = t.parent_id && tags.find((x) => x.id === t.parent_id);
      return p ? `${p.name} : ${t.name}` : t.name;
    };
    return { projects, tags, tagLabel };
  }

  async shape(tasks) {
    if (!tasks.length) return [];
    const [{ projects, tags, tagLabel }, links] = await Promise.all([
      this.lookups(),
      this.q(`task_tags?${this.u}&task_id=${inList(tasks.map((t) => t.id))}&select=task_id,tag_id`),
    ]);
    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes || undefined,
      project: (projects.find((p) => p.id === t.project_id) || {}).name || null,
      project_id: t.project_id,
      tags: links.filter((l) => l.task_id === t.id).map((l) => tags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel),
      in_inbox: t.in_inbox,
      flagged: t.flagged,
      due: localDate(t.due_at, this.tz),
      defer: localDate(t.defer_at, this.tz),
      completed_at: t.completed_at,
      parent_id: t.parent_id || undefined,
      created_at: t.created_at,
    }));
  }

  async task(id) {
    const rows = await this.q(`tasks?${this.u}&id=eq.${mustUuid(id, 'id')}&select=*`);
    if (!rows.length) throw new Error('Task not found');
    return rows[0];
  }

  async resolveProject(ref) {
    if (ref === null || ref === '') return null;
    const { projects } = await this.lookups();
    const p = projects.find((x) => x.id === ref) || projects.find((x) => x.name.toLowerCase() === String(ref).toLowerCase());
    if (!p) throw new Error(`No project named "${ref}". Use list_projects or create_project first.`);
    return p.id;
  }

  // "Waiting : Hiro" finds or creates parent "Waiting" and child "Hiro".
  async ensureTag(label) {
    const parts = String(label).split(':').map((s) => s.trim()).filter(Boolean).slice(0, 2);
    if (!parts.length) throw new Error('Empty tag');
    let parentId = null;
    for (const name of parts) {
      const filter = parentId ? `parent_id=eq.${parentId}` : 'parent_id=is.null';
      const found = (await this.q(`tags?${this.u}&${filter}&select=id,name`)).find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (found) { parentId = found.id; continue; }
      const [row] = await this.q('tags', { method: 'POST', prefer: 'return=representation', body: { user_id: this.userId, name, parent_id: parentId } });
      parentId = row.id;
    }
    return parentId;
  }

  async setTags(taskId, labels) {
    const ids = [];
    for (const l of labels) ids.push(await this.ensureTag(l));
    await this.q(`task_tags?${this.u}&task_id=eq.${taskId}`, { method: 'DELETE' });
    if (ids.length) {
      await this.q('task_tags', { method: 'POST', body: [...new Set(ids)].map((tag_id) => ({ task_id: taskId, tag_id, user_id: this.userId })) });
    }
    return ids.length;
  }
}

const OPEN = 'completed_at=is.null&dropped_at=is.null';

// ---------- tools ----------
const TOOLS = [
  {
    name: 'capture',
    description: 'Add a new item to the Inbox. Use for anything the user wants remembered; clarify it later with update_task.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'What it is, in the user\'s words' }, notes: { type: 'string' } },
      required: ['title'],
    },
    async run(api, { title, notes = '' }) {
      if (!title || !String(title).trim()) throw new Error('title is required');
      const [row] = await api.q('tasks', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, title: String(title).trim(), notes, source: 'mcp' } });
      return (await api.shape([row]))[0];
    },
  },
  {
    name: 'list_inbox',
    description: 'List open Inbox items (captured but not yet clarified), oldest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 100 } } },
    async run(api, { limit = 100 }) {
      const rows = await api.q(`tasks?${api.u}&${OPEN}&in_inbox=is.true&parent_id=is.null&order=created_at.asc&limit=${Math.min(+limit || 100, 500)}&select=*`);
      return { count: rows.length, items: await api.shape(rows) };
    },
  },
  {
    name: 'today',
    description: 'What needs attention today: overdue items, items due today, and flagged items. Deferred items are hidden.',
    inputSchema: { type: 'object', properties: {} },
    async run(api) {
      const today = localDate(new Date().toISOString(), api.tz);
      const endOfToday = zonedToIso(today, 24, api.tz);
      const now = new Date().toISOString();
      const notDeferred = `or=(defer_at.is.null,defer_at.lte.${now})`;
      const [due, flagged] = await Promise.all([
        api.q(`tasks?${api.u}&${OPEN}&${notDeferred}&due_at=lt.${endOfToday}&order=due_at.asc&select=*`),
        api.q(`tasks?${api.u}&${OPEN}&${notDeferred}&flagged=is.true&order=created_at.asc&select=*`),
      ]);
      const startOfToday = zonedToIso(today, 0, api.tz);
      const shapedDue = await api.shape(due);
      const dueIds = new Set(due.map((t) => t.id));
      return {
        date: today,
        overdue: shapedDue.filter((_, i) => due[i].due_at < startOfToday),
        due_today: shapedDue.filter((_, i) => due[i].due_at >= startOfToday),
        flagged: await api.shape(flagged.filter((t) => !dueIds.has(t.id))),
      };
    },
  },
  {
    name: 'list_tasks',
    description: 'Search and filter tasks. All filters are optional and combine with AND. Open tasks only unless include_completed is true.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Case-insensitive text to match in title or notes' },
        project: { type: 'string', description: 'Project name or id' },
        tag: { type: 'string', description: 'Tag label, e.g. "Laptop" or "Waiting : Hiro" (a parent tag includes its children)' },
        flagged: { type: 'boolean' },
        due_before: { type: 'string', description: 'YYYY-MM-DD; items due on or before this date' },
        include_completed: { type: 'boolean', default: false },
        limit: { type: 'integer', default: 100 },
      },
    },
    async run(api, a) {
      const f = [api.u, 'select=*', `limit=${Math.min(+a.limit || 100, 500)}`, 'order=created_at.asc'];
      if (!a.include_completed) f.push(OPEN);
      if (a.flagged !== undefined) f.push(`flagged=is.${!!a.flagged}`);
      if (a.due_before) f.push(`due_at=lt.${zonedToIso(a.due_before, 24, api.tz)}`);
      if (a.project) f.push(`project_id=eq.${await api.resolveProject(a.project)}`);
      if (a.search) {
        const s = String(a.search).replace(/[%,()*]/g, ' ').trim();
        f.push(`or=(title.ilike.*${encodeURIComponent(s)}*,notes.ilike.*${encodeURIComponent(s)}*)`);
      }
      if (a.tag) {
        const { tags, tagLabel } = await api.lookups();
        const tag = tags.find((t) => tagLabel(t).toLowerCase() === a.tag.toLowerCase()) || tags.find((t) => t.name.toLowerCase() === a.tag.toLowerCase());
        if (!tag) return { count: 0, items: [], note: `No tag "${a.tag}"` };
        const tagIds = [tag.id, ...tags.filter((t) => t.parent_id === tag.id).map((t) => t.id)];
        const links = await api.q(`task_tags?${api.u}&tag_id=${inList(tagIds)}&select=task_id`);
        if (!links.length) return { count: 0, items: [] };
        f.push(`id=${inList([...new Set(links.map((l) => l.task_id))])}`);
      }
      const rows = await api.q(`tasks?${f.join('&')}`);
      return { count: rows.length, items: await api.shape(rows) };
    },
  },
  {
    name: 'get_task',
    description: 'Get one task with its notes, project, tags and dates.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(api, { id }) {
      return (await api.shape([await api.task(id)]))[0];
    },
  },
  {
    name: 'update_task',
    description: 'Clarify or edit a task. Only fields you pass change. Setting a project or tags moves an Inbox item out of the Inbox. Pass null to clear a date or project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        project: { type: ['string', 'null'], description: 'Project name or id; null to remove' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags. Labels like "Laptop" or "Waiting : Hiro"; missing tags are created.' },
        flagged: { type: 'boolean' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD (due 5pm local) or null' },
        defer: { type: ['string', 'null'], description: 'YYYY-MM-DD (hidden until then) or null' },
      },
      required: ['id'],
    },
    async run(api, a) {
      const task = await api.task(a.id);
      const patch = {};
      if (a.title !== undefined) patch.title = String(a.title).trim();
      if (a.notes !== undefined) patch.notes = a.notes;
      if (a.flagged !== undefined) patch.flagged = !!a.flagged;
      if (a.due !== undefined) patch.due_at = zonedToIso(a.due, 17, api.tz);
      if (a.defer !== undefined) patch.defer_at = zonedToIso(a.defer, 0, api.tz);
      if (a.project !== undefined) patch.project_id = await api.resolveProject(a.project);
      let tagCount = null;
      if (Array.isArray(a.tags)) tagCount = await api.setTags(task.id, a.tags);
      if (task.in_inbox && ((patch.project_id !== undefined ? patch.project_id : task.project_id) || tagCount)) patch.in_inbox = false;
      if (Object.keys(patch).length) {
        await api.q(`tasks?${api.u}&id=eq.${task.id}`, { method: 'PATCH', body: patch });
      }
      return (await api.shape([await api.task(task.id)]))[0];
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task complete (or pass completed:false to reopen it). Only do this when the user says it is done.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, completed: { type: 'boolean', default: true } }, required: ['id'] },
    async run(api, { id, completed = true }) {
      const task = await api.task(id);
      await api.q(`tasks?${api.u}&id=eq.${task.id}`, { method: 'PATCH', body: { completed_at: completed ? new Date().toISOString() : null } });
      return (await api.shape([await api.task(task.id)]))[0];
    },
  },
  {
    name: 'list_projects',
    description: 'List projects with their folder, status and number of open actions.',
    inputSchema: { type: 'object', properties: { include_inactive: { type: 'boolean', default: false, description: 'Include completed and dropped projects' } } },
    async run(api, { include_inactive = false }) {
      const [projects, folders, open] = await Promise.all([
        api.q(`projects?${api.u}${include_inactive ? '' : '&status=in.(active,on_hold)'}&order=sort.asc&select=id,name,status,kind,folder_id,notes`),
        api.q(`folders?${api.u}&select=id,name`),
        api.q(`tasks?${api.u}&${OPEN}&project_id=not.is.null&select=project_id`),
      ]);
      return projects.map((p) => ({
        id: p.id, name: p.name, status: p.status, kind: p.kind, notes: p.notes || undefined,
        folder: (folders.find((f) => f.id === p.folder_id) || {}).name || null,
        open_actions: open.filter((t) => t.project_id === p.id).length,
      }));
    },
  },
  {
    name: 'create_project',
    description: 'Create a project (an outcome that takes more than one action). Optionally put it in a folder, which is created if missing.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, folder: { type: 'string' }, notes: { type: 'string' } },
      required: ['name'],
    },
    async run(api, { name, folder, notes = '' }) {
      let folder_id = null;
      if (folder) {
        const found = (await api.q(`folders?${api.u}&select=id,name`)).find((f) => f.name.toLowerCase() === folder.toLowerCase());
        folder_id = found ? found.id
          : (await api.q('folders', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name: folder } }))[0].id;
      }
      const [row] = await api.q('projects', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name: String(name).trim(), notes, folder_id } });
      return { id: row.id, name: row.name, folder: folder || null, status: row.status };
    },
  },
  {
    name: 'list_tags',
    description: 'List all tags (contexts, people, waiting-fors) with open task counts. Nested tags show as "Parent : Child".',
    inputSchema: { type: 'object', properties: {} },
    async run(api) {
      const [{ tags, tagLabel }, links, open] = await Promise.all([
        api.lookups(),
        api.q(`task_tags?${api.u}&select=task_id,tag_id`),
        api.q(`tasks?${api.u}&${OPEN}&select=id`),
      ]);
      const openIds = new Set(open.map((t) => t.id));
      return tags.map((t) => ({ id: t.id, label: tagLabel(t), open_tasks: links.filter((l) => l.tag_id === t.id && openIds.has(l.task_id)).length }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },
  },
];

// ---------- responses ----------
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const text = (s, status = 200, headers = {}) => new Response(s, { status, headers: { 'Content-Type': 'text/plain', ...CORS, ...headers } });
