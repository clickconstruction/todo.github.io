// Todo Tooling MCP server (Cloudflare Worker) at https://mcp.todotooling.com/mcp
//
// Stateless MCP over Streamable HTTP: every JSON-RPC request is a POST that gets
// a single JSON response. Callers authenticate with a personal access token
// (created in the app's Settings) sent as `Authorization: Bearer tt_...`.
// The Worker talks to Supabase with a server-side secret key, so every query
// below is explicitly scoped to the token owner's user_id.

import PostalMime from 'postal-mime';

const SERVER_INFO = { name: 'todotooling', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Todo Tooling is the user's GTD system. Capture anything new with capture (it lands in the Inbox).
Clarify inbox items with update_task: give each a project and/or tags (contexts like "Laptop", people like "Waiting : Hiro"); an item leaves the Inbox once it has a project or tag.
Use planned for when the user intends to work on something and due only for hard deadlines; flagged means "important now". Dates are YYYY-MM-DD in the user's timezone.
Never complete, reschedule or re-file tasks the user did not ask you to change.
Folders and projects are never deleted: archive a folder with update_folder (only possible once it has no active/on-hold projects) and archive a project by setting its status to completed or dropped.`;

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

  // Email Routing sends inbox@todotooling.com here; each accepted email becomes an Inbox task.
  async email(message, env) {
    return handleEmail(message, env);
  },
};

// ---------- email capture ----------
const MAX_NOTES = 6000;

// Accept only mail whose From: address is on a user's allowlist AND that passed
// DMARC, or DKIM/SPF aligned with the From: domain, so a spoofed From: is rejected.
export async function handleEmail(message, env) {
  const parsed = await PostalMime.parse(message.raw);
  const from = ((parsed.from && parsed.from.address) || message.from || '').toLowerCase().trim();
  const domain = from.split('@')[1] || '';
  const authResults = [message.headers.get('arc-authentication-results'), message.headers.get('authentication-results')]
    .filter(Boolean).join(';').toLowerCase();
  if (!isAuthenticated(authResults, domain)) {
    console.log('email rejected: unauthenticated', { from, authResults: authResults || '(none)' });
    message.setReject('Message failed sender authentication.');
    return;
  }
  const senders = await rest(env, `email_senders?email=eq.${encodeURIComponent(from)}&select=user_id`);
  if (!senders.length) {
    console.log('email rejected: unknown sender', { from });
    message.setReject('This address only accepts mail from approved senders.');
    return;
  }
  const task = emailToTask(parsed, from);
  await rest(env, 'tasks', { method: 'POST', body: { user_id: senders[0].user_id, source: 'email', ...task } });
  console.log('email captured', { from, title: task.title });
}

export function isAuthenticated(results, domain) {
  if (!results || !domain) return false;
  if (/\bdmarc=pass\b/.test(results)) return true;
  const aligned = (d) => d && (d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`));
  for (const m of results.matchAll(/\bdkim=pass\b[^;]*?header\.d=([a-z0-9.-]+)/g)) if (aligned(m[1])) return true;
  for (const m of results.matchAll(/\bspf=pass\b[^;]*?smtp\.mailfrom=(?:[^@\s;]*@)?([a-z0-9.-]+)/g)) if (aligned(m[1])) return true;
  return false;
}

export function emailToTask(parsed, from) {
  const body = (parsed.text || htmlToText(parsed.html || '')).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const subject = (parsed.subject || '').replace(/^(\s*(fwd?|fw|re|aw)\s*:\s*)+/i, '').trim();
  const firstLine = body.split('\n').find((l) => l.trim()) || '';
  const title = (subject || firstLine || 'Emailed item').slice(0, 300);
  const when = parsed.date ? new Date(parsed.date).toUTCString() : new Date().toUTCString();
  const attachments = (parsed.attachments || []).filter((a) => a.disposition !== 'inline').map((a) => a.filename).filter(Boolean);
  let notes = `Emailed by ${from} · ${when}`;
  if (attachments.length) notes += `\nAttachments (not saved): ${attachments.join(', ')}`;
  if (body) notes += `\n\n${body}`;
  if (notes.length > MAX_NOTES) notes = `${notes.slice(0, MAX_NOTES)}\n…(truncated)`;
  return { title, notes };
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

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
    const projectIds = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))];
    const [{ projects, tags, tagLabel }, links, pLinks] = await Promise.all([
      this.lookups(),
      this.q(`task_tags?${this.u}&task_id=${inList(tasks.map((t) => t.id))}&select=task_id,tag_id`),
      projectIds.length ? this.q(`project_tags?${this.u}&project_id=${inList(projectIds)}&select=project_id,tag_id`) : [],
    ]);
    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes || undefined,
      project: (projects.find((p) => p.id === t.project_id) || {}).name || null,
      project_id: t.project_id,
      tags: links.filter((l) => l.task_id === t.id).map((l) => tags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel),
      project_tags: pLinks.filter((l) => l.project_id === t.project_id).map((l) => tags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel),
      estimate_minutes: t.estimate_minutes ?? undefined,
      in_inbox: t.in_inbox,
      status: t.completed_at ? 'completed' : t.dropped_at ? 'dropped' : 'open',
      flagged: t.flagged,
      due: localDate(t.due_at, this.tz),
      planned: localDate(t.planned_at, this.tz),
      defer: localDate(t.defer_at, this.tz),
      completed_at: t.completed_at,
      completion_note: t.completion_note || undefined,
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

  // Folder by name (case-insensitive), created if missing. null/'' means no folder.
  async resolveFolder(name) {
    if (name === null || name === '') return null;
    const key = String(name).trim().toLowerCase();
    const all = (await this.q(`folders?${this.u}&select=id,name,archived_at`)).filter((f) => f.name.toLowerCase() === key);
    const found = all.find((f) => !f.archived_at) || all[0];
    if (found) return found.id;
    const [row] = await this.q('folders', { method: 'POST', prefer: 'return=representation', body: { user_id: this.userId, name: String(name).trim() } });
    return row.id;
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

// Mirror of the app's js/availability.js. available = open, not deferred, project active,
// not a group with open children, and not queued behind the head of a sequential project.
function availabilityOf(tasks, projects, nowIso = new Date().toISOString()) {
  const isOpenT = (t) => !t.completed_at && !t.dropped_at;
  const byIdT = new Map(tasks.map((t) => [t.id, t]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const sortT = (a, b) => (a.sort - b.sort) || (a.created_at < b.created_at ? -1 : 1);
  const heads = new Map();
  for (const p of projects) {
    if (p.kind !== 'sequential') continue;
    const top = tasks.filter((t) => t.project_id === p.id && !t.parent_id && isOpenT(t)).sort(sortT);
    if (top[0]) heads.set(p.id, top[0].id);
  }
  const hasOpenKids = new Set(tasks.filter((t) => t.parent_id && isOpenT(t)).map((t) => t.parent_id));
  const available = (t) => {
    if (!isOpenT(t) || (t.defer_at && t.defer_at > nowIso)) return false;
    const p = t.project_id && projectById.get(t.project_id);
    if (p && p.status !== 'active') return false;
    if (hasOpenKids.has(t.id)) return false;
    if (p && heads.has(p.id)) {
      const top = t.parent_id ? byIdT.get(t.parent_id) : t;
      if (!top || top.id !== heads.get(p.id)) return false;
    }
    return true;
  };
  const nextFor = (projectId) => {
    const open = tasks.filter((t) => t.project_id === projectId && isOpenT(t));
    const ordered = open.filter((t) => !t.parent_id).sort(sortT).flatMap((t) => [t, ...open.filter((c) => c.parent_id === t.id).sort(sortT)]);
    return ordered.find(available) || null;
  };
  return { available, nextFor };
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'capture',
    description: 'Add a new item. With just a title it lands in the Inbox to clarify later; you can also set project, tags, parent, flag, due/defer dates and notes in the same call (it then skips the Inbox).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "What it is, in the user's words" },
        notes: { type: 'string' },
        project: { type: 'string', description: 'Project name or id' },
        parent: { type: 'string', description: 'Id of an open action in that project, to make this a subtask' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Labels like "Laptop" or "Waiting : Hiro"; missing tags are created' },
        flagged: { type: 'boolean' },
        planned: { type: 'string', description: 'YYYY-MM-DD when the user intends to do it' },
        due: { type: 'string', description: 'YYYY-MM-DD hard deadline only' },
        defer: { type: 'string', description: 'YYYY-MM-DD (hidden until then)' },
        estimate_minutes: { type: 'integer', description: 'How long it takes, in minutes' },
      },
      required: ['title'],
    },
    async run(api, { title, notes = '', ...rest }) {
      if (!title || !String(title).trim()) throw new Error('title is required');
      // Into a project: append at the end (order matters in sequential projects).
      const body = { user_id: api.userId, title: String(title).trim(), notes, source: 'mcp' };
      if (rest.project) {
        body.project_id = await api.resolveProject(rest.project);
        const sib = await api.q(`tasks?${api.u}&project_id=eq.${body.project_id}&parent_id=is.null&select=sort&order=sort.desc&limit=1`);
        body.sort = sib.length ? (sib[0].sort || 0) + 1 : 0;
      }
      const [row] = await api.q('tasks', { method: 'POST', prefer: 'return=representation', body });
      const fields = Object.fromEntries(Object.entries(rest).filter(([k, v]) => ['project', 'parent', 'tags', 'flagged', 'due', 'planned', 'defer', 'estimate_minutes'].includes(k) && v !== undefined));
      if (!Object.keys(fields).length) return (await api.shape([row]))[0];
      return TOOLS.find((t) => t.name === 'update_task').run(api, { id: row.id, ...fields });
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
    description: 'What needs attention today: overdue items, items due today, items planned for today or earlier, and flagged items. Deferred items are hidden.',
    inputSchema: { type: 'object', properties: {} },
    async run(api) {
      const today = localDate(new Date().toISOString(), api.tz);
      const endOfToday = zonedToIso(today, 24, api.tz);
      const now = new Date().toISOString();
      const notDeferred = `or=(defer_at.is.null,defer_at.lte.${now})`;
      const [due, flagged, planned] = await Promise.all([
        api.q(`tasks?${api.u}&${OPEN}&${notDeferred}&due_at=lt.${endOfToday}&order=due_at.asc&select=*`),
        api.q(`tasks?${api.u}&${OPEN}&${notDeferred}&flagged=is.true&order=created_at.asc&select=*`),
        api.q(`tasks?${api.u}&${OPEN}&${notDeferred}&planned_at=lt.${endOfToday}&order=planned_at.asc&select=*`),
      ]);
      const startOfToday = zonedToIso(today, 0, api.tz);
      const shapedDue = await api.shape(due);
      const dueIds = new Set(due.map((t) => t.id));
      return {
        date: today,
        overdue: shapedDue.filter((_, i) => due[i].due_at < startOfToday),
        due_today: shapedDue.filter((_, i) => due[i].due_at >= startOfToday),
        planned: await api.shape(planned.filter((t) => !dueIds.has(t.id))),
        flagged: await api.shape(flagged.filter((t) => !dueIds.has(t.id) && !planned.some((p) => p.id === t.id))),
      };
    },
  },
  {
    name: 'list_tasks',
    description: 'Search and filter tasks. All filters are optional and combine with AND. Open tasks only unless include_completed is true.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Words to find; each must appear in the title, notes, completion note, project name or a tag (same as the app search)' },
        project: { type: 'string', description: 'Project name or id' },
        tag: { type: 'string', description: 'Tag label, e.g. "Laptop" or "Waiting : Hiro" (a parent tag includes its children)' },
        flagged: { type: 'boolean' },
        max_minutes: { type: 'integer', description: 'Only actions with an estimate of at most this many minutes ("I have 15 minutes")' },
        available_only: { type: 'boolean', description: 'Only actions that can be done now (not deferred, not waiting in a sequential project, project active). This is the Next Actions list.' },
        due_before: { type: 'string', description: 'YYYY-MM-DD; items due on or before this date' },
        include_completed: { type: 'boolean', default: false },
        limit: { type: 'integer', default: 100 },
      },
    },
    async run(api, a) {
      const f = [api.u, 'select=*', `limit=${Math.min(+a.limit || 100, 500)}`, 'order=created_at.asc'];
      if (!a.include_completed) f.push(OPEN);
      if (a.flagged !== undefined) f.push(`flagged=is.${!!a.flagged}`);
      if (a.max_minutes !== undefined) f.push(`estimate_minutes=lte.${Math.max(0, Math.round(Number(a.max_minutes)))}`);
      if (a.due_before) f.push(`due_at=lt.${zonedToIso(a.due_before, 24, api.tz)}`);
      if (a.project) f.push(`project_id=eq.${await api.resolveProject(a.project)}`);
      if (a.search) {
        const words = String(a.search).toLowerCase().replace(/[%,()*\\]/g, ' ').split(/\s+/).filter(Boolean);
        if (words.length) {
          const { projects, tags, tagLabel } = await api.lookups();
          const links = await api.q(`task_tags?${api.u}&select=task_id,tag_id`);
          for (const w of words) {
            const e = encodeURIComponent(w);
            const conds = [`title.ilike.*${e}*`, `notes.ilike.*${e}*`, `completion_note.ilike.*${e}*`];
            const pids = projects.filter((p) => p.name.toLowerCase().includes(w)).map((p) => p.id);
            const tids = new Set(tags.filter((t) => tagLabel(t).toLowerCase().includes(w)).map((t) => t.id));
            const taskIds = [...new Set(links.filter((l) => tids.has(l.tag_id)).map((l) => l.task_id))].slice(0, 300);
            if (pids.length) conds.push(`project_id.in.(${pids.join(',')})`);
            if (taskIds.length) conds.push(`id.in.(${taskIds.join(',')})`);
            f.push(`or=(${conds.join(',')})`);
          }
        }
      }
      if (a.tag) {
        const { tags, tagLabel } = await api.lookups();
        const tag = tags.find((t) => tagLabel(t).toLowerCase() === a.tag.toLowerCase()) || tags.find((t) => t.name.toLowerCase() === a.tag.toLowerCase());
        if (!tag) return { count: 0, items: [], note: `No tag "${a.tag}"` };
        const tagIds = [tag.id, ...tags.filter((t) => t.parent_id === tag.id).map((t) => t.id)];
        // A project's tags apply to its actions.
        const [links, pLinks] = await Promise.all([
          api.q(`task_tags?${api.u}&tag_id=${inList(tagIds)}&select=task_id`),
          api.q(`project_tags?${api.u}&tag_id=${inList(tagIds)}&select=project_id`),
        ]);
        const direct = links.map((l) => l.task_id);
        const viaProject = pLinks.length ? (await api.q(`tasks?${api.u}&project_id=${inList([...new Set(pLinks.map((l) => l.project_id))])}&select=id`)).map((t) => t.id) : [];
        const ids = [...new Set([...direct, ...viaProject])];
        if (!ids.length) return { count: 0, items: [] };
        f.push(`id=${inList(ids)}`);
      }
      let rows = await api.q(`tasks?${f.join('&')}`);
      if (a.available_only) {
        const [allOpen, projects] = await Promise.all([
          api.q(`tasks?${api.u}&${OPEN}&select=id,project_id,parent_id,sort,created_at,defer_at,completed_at,dropped_at`),
          api.q(`projects?${api.u}&select=id,kind,status`),
        ]);
        const { available } = availabilityOf(allOpen, projects);
        const ok = new Set(allOpen.filter(available).map((t) => t.id));
        rows = rows.filter((t) => ok.has(t.id));
      }
      return { count: rows.length, items: await api.shape(rows) };
    },
  },
  {
    name: 'forecast',
    description: 'Day-by-day view of what is due, planned, or becoming available (deferred until that day), plus past-due and past-planned items. Use for "what is coming up this week" and daily planning.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', default: 7, description: 'How many days from today (1-60)' } } },
    async run(api, { days = 7 }) {
      days = Math.min(Math.max(1, Math.round(Number(days) || 7)), 60);
      const today = localDate(new Date().toISOString(), api.tz);
      const start = zonedToIso(today, 0, api.tz);
      const endDay = localDate(new Date(Date.parse(start) + (days - 1) * 86400000 + 12 * 3600000).toISOString(), api.tz);
      const end = zonedToIso(endDay, 24, api.tz);
      const rows = await api.q(`tasks?${api.u}&${OPEN}&or=(due_at.lt.${end},planned_at.lt.${end},defer_at.lt.${end})&select=*`);
      const items = await api.shape(rows);
      const out = { today, past: { overdue: [], planned_earlier: [] }, days: {} };
      for (let i = 0; i < days; i++) {
        const d = localDate(new Date(Date.parse(start) + i * 86400000 + 12 * 3600000).toISOString(), api.tz);
        out.days[d] = { due: [], planned: [], becomes_available: [] };
      }
      items.forEach((t) => {
        if (t.due && t.due < today) out.past.overdue.push(t);
        else if (t.planned && t.planned < today && !(t.due && t.due < today)) out.past.planned_earlier.push(t);
        if (out.days[t.due]) out.days[t.due].due.push(t);
        if (out.days[t.planned] && t.planned !== t.due) out.days[t.planned].planned.push(t);
        if (out.days[t.defer] && t.defer !== t.due && t.defer !== t.planned) out.days[t.defer].becomes_available.push(t);
      });
      return out;
    },
  },
  {
    name: 'list_flagged',
    description: 'The Flagged list: flagged actions plus every open action in a flagged project, grouped by project. Pass available_only to hide deferred/queued items.',
    inputSchema: { type: 'object', properties: { available_only: { type: 'boolean', default: false } } },
    async run(api, { available_only = false }) {
      const [open, projects] = await Promise.all([
        api.q(`tasks?${api.u}&${OPEN}&select=*`),
        api.q(`projects?${api.u}&select=id,name,kind,status,flagged`),
      ]);
      const flaggedProjects = new Set(projects.filter((p) => p.flagged).map((p) => p.id));
      const { available } = availabilityOf(open, projects);
      const rows = open.filter((t) => (t.flagged || flaggedProjects.has(t.project_id)) && (!available_only || available(t)));
      const items = await api.shape(rows);
      const byProject = {};
      items.forEach((t) => { const k = t.project || 'No project'; (byProject[k] = byProject[k] || []).push(t); });
      return { count: items.length, by_project: byProject };
    },
  },
  {
    name: 'get_task',
    description: 'Get one task with its notes, project, tags, dates and (for an action group) its sub-actions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(api, { id }) {
      const task = await api.task(id);
      const [shaped] = await api.shape([task]);
      const kids = await api.q(`tasks?${api.u}&parent_id=eq.${task.id}&order=sort.asc&select=*`);
      if (kids.length) shaped.sub_actions = await api.shape(kids);
      return shaped;
    },
  },
  {
    name: 'update_task',
    description: 'Edit any field of a task; only fields you pass change. Clarify inbox items by giving them a project and/or tags. An item with no project, no parent and no tags lives in the Inbox (removing them moves it back). Pass null to clear a date, project or parent.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        project: { type: ['string', 'null'], description: 'Project name or id; null to remove' },
        parent: { type: ['string', 'null'], description: 'Id of an open action in the same project to make this a subtask of; null for top-level' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags. Labels like "Laptop" or "Waiting : Hiro"; missing tags are created.' },
        add_tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add, keeping existing ones' },
        remove_tags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
        flagged: { type: 'boolean' },
        planned: { type: ['string', 'null'], description: 'YYYY-MM-DD when the user intends to work on it (9am local), or null. Prefer this over due for intentions.' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD hard deadline only (due 5pm local), or null' },
        defer: { type: ['string', 'null'], description: 'YYYY-MM-DD (hidden until then) or null' },
        status: { type: 'string', enum: ['open', 'completed', 'dropped'], description: 'Only change when the user says so' },
        completion_note: { type: 'string' },
        estimate_minutes: { type: ['integer', 'null'], description: 'How long it takes, in minutes; null to clear' },
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
      if (a.planned !== undefined) patch.planned_at = zonedToIso(a.planned, 9, api.tz);
      if (a.defer !== undefined) patch.defer_at = zonedToIso(a.defer, 0, api.tz);
      if (a.project !== undefined) patch.project_id = await api.resolveProject(a.project);
      if (a.completion_note !== undefined) patch.completion_note = String(a.completion_note).trim();
      if (a.estimate_minutes !== undefined) patch.estimate_minutes = a.estimate_minutes === null ? null : Math.max(0, Math.round(Number(a.estimate_minutes)));
      if (a.status !== undefined) {
        patch.completed_at = a.status === 'completed' ? (task.completed_at || new Date().toISOString()) : null;
        patch.dropped_at = a.status === 'dropped' ? (task.dropped_at || new Date().toISOString()) : null;
      }
      const projectId = patch.project_id !== undefined ? patch.project_id : task.project_id;
      if (a.parent !== undefined) {
        if (a.parent === null || a.parent === '') patch.parent_id = null;
        else {
          const parent = await api.task(a.parent);
          if (parent.id === task.id || parent.parent_id) throw new Error('Parent must be a different top-level action');
          if (parent.project_id !== projectId) throw new Error('Parent must be in the same project');
          patch.parent_id = parent.id;
        }
      } else if (patch.project_id !== undefined && patch.project_id !== task.project_id) {
        patch.parent_id = null; // moving projects detaches from the old parent
      }
      // Tags: replace, or add/remove.
      if (Array.isArray(a.tags) || Array.isArray(a.add_tags) || Array.isArray(a.remove_tags)) {
        const { tags, tagLabel } = await api.lookups();
        const links = await api.q(`task_tags?${api.u}&task_id=eq.${task.id}&select=tag_id`);
        let labels = Array.isArray(a.tags) ? a.tags
          : links.map((l) => tags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel);
        if (Array.isArray(a.add_tags)) labels = labels.concat(a.add_tags);
        if (Array.isArray(a.remove_tags)) {
          const drop = a.remove_tags.map((x) => String(x).toLowerCase().trim());
          labels = labels.filter((l) => !drop.includes(l.toLowerCase()) && !drop.includes(l.split(':').pop().trim().toLowerCase()));
        }
        await api.setTags(task.id, labels);
      }
      const tagCount = (await api.q(`task_tags?${api.u}&task_id=eq.${task.id}&select=tag_id`)).length;
      const parentId = patch.parent_id !== undefined ? patch.parent_id : task.parent_id;
      patch.in_inbox = !(projectId || parentId || tagCount);
      await api.q(`tasks?${api.u}&id=eq.${task.id}`, { method: 'PATCH', body: patch });
      return (await api.shape([await api.task(task.id)]))[0];
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task complete (or pass completed:false to reopen it). Only do this when the user says it is done. Optionally record a completion note. Rules: completing an action group also completes its open sub-actions; completing the last sub-action completes the group; a project set to complete-with-last-action completes when its last action does.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, completed: { type: 'boolean', default: true }, note: { type: 'string', description: 'Completion note' } },
      required: ['id'],
    },
    async run(api, { id, completed = true, note }) {
      const task = await api.task(id);
      const patch = { completed_at: completed ? (task.completed_at || new Date().toISOString()) : null };
      if (note !== undefined) patch.completion_note = String(note).trim();
      await api.q(`tasks?${api.u}&id=eq.${task.id}`, { method: 'PATCH', body: patch });
      return (await api.shape([await api.task(task.id)]))[0];
    },
  },
  {
    name: 'list_completed',
    description: 'Review what was completed, newest first, filtered by date range (YYYY-MM-DD, inclusive, user timezone) and/or project. Returns items with completion time and note, plus counts per project and per day. Great for weekly reviews and "what did I get done" questions.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'YYYY-MM-DD (default: 7 days ago)' },
        until: { type: 'string', description: 'YYYY-MM-DD inclusive (default: today)' },
        project: { type: 'string', description: 'Project name or id; "none" for items with no project' },
        limit: { type: 'integer', default: 200 },
      },
    },
    async run(api, a) {
      const today = localDate(new Date().toISOString(), api.tz);
      const weekAgo = localDate(new Date(Date.now() - 6 * 86400000).toISOString(), api.tz);
      const since = a.since || weekAgo;
      const until = a.until || today;
      const f = [api.u, 'completed_at=not.is.null', 'order=completed_at.desc', 'select=*', `limit=${Math.min(+a.limit || 200, 1000)}`,
        `completed_at=gte.${zonedToIso(since, 0, api.tz)}`, `completed_at=lt.${zonedToIso(until, 24, api.tz)}`];
      if (a.project === 'none') f.push('project_id=is.null');
      else if (a.project) f.push(`project_id=eq.${await api.resolveProject(a.project)}`);
      const rows = await api.q(`tasks?${f.join('&')}`);
      const items = await api.shape(rows);
      const byProject = {}; const byDay = {};
      items.forEach((t, i) => {
        const pk = t.project || 'No project';
        byProject[pk] = (byProject[pk] || 0) + 1;
        const dk = localDate(rows[i].completed_at, api.tz);
        byDay[dk] = (byDay[dk] || 0) + 1;
      });
      return { since, until, count: items.length, by_project: byProject, by_day: byDay, items };
    },
  },
  {
    name: 'list_projects',
    description: 'List projects with their folder, status and number of open actions.',
    inputSchema: { type: 'object', properties: { include_inactive: { type: 'boolean', default: false, description: 'Include completed and dropped projects' } } },
    async run(api, { include_inactive = false }) {
      const [projects, folders, open] = await Promise.all([
        api.q(`projects?${api.u}${include_inactive ? '' : '&status=in.(active,on_hold)'}&order=sort.asc&select=*`),
        api.q(`folders?${api.u}&select=id,name`),
        api.q(`tasks?${api.u}&${OPEN}&select=id,title,project_id,parent_id,sort,created_at,defer_at,completed_at,dropped_at`),
      ]);
      const { nextFor } = availabilityOf(open, projects);
      return projects.map((p) => {
        const next = p.status === 'active' ? nextFor(p.id) : null;
        return {
          id: p.id, name: p.name, status: p.status, kind: p.kind, complete_with_last: p.complete_with_last, flagged: p.flagged,
          notes: p.notes || undefined,
          folder: (folders.find((f) => f.id === p.folder_id) || {}).name || null,
          open_actions: open.filter((t) => t.project_id === p.id).length,
          next_action: next ? { id: next.id, title: next.title } : null,
          review_every_days: p.review_every_days, last_reviewed: localDate(p.last_reviewed_at, api.tz), next_review: localDate(p.next_review_at, api.tz),
        };
      });
    },
  },
  {
    name: 'create_project',
    description: 'Create a project (an outcome that takes more than one action). Optionally put it in a folder, which is created if missing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, folder: { type: 'string' }, notes: { type: 'string' },
        kind: { type: 'string', enum: ['parallel', 'sequential', 'single_actions'], description: 'parallel (default): all actions available; sequential: only the next one; single_actions: a list of unrelated actions' },
        complete_with_last: { type: 'boolean', description: 'Complete the project automatically when its last action is done' },
      },
      required: ['name'],
    },
    async run(api, { name, folder, notes = '', kind = 'parallel', complete_with_last = false }) {
      const folder_id = folder ? await api.resolveFolder(folder) : null;
      const [row] = await api.q('projects', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name: String(name).trim(), notes, folder_id, kind, complete_with_last: !!complete_with_last } });
      return { id: row.id, name: row.name, folder: folder || null, status: row.status, kind: row.kind, complete_with_last: row.complete_with_last };
    },
  },
  {
    name: 'update_project',
    description: 'Rename a project, move it to a folder (created if missing; null for no folder), change its status, type (parallel/sequential/single_actions), complete-with-last-action, or notes. Only fields you pass change.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id' },
        name: { type: 'string' },
        folder: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['active', 'on_hold', 'completed', 'dropped'] },
        notes: { type: 'string' },
        kind: { type: 'string', enum: ['parallel', 'sequential', 'single_actions'] },
        complete_with_last: { type: 'boolean' },
        flagged: { type: 'boolean', description: 'Flagged projects put all their actions in the Flagged list' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the project tags; its actions inherit them' },
      },
      required: ['project'],
    },
    async run(api, a) {
      const id = await api.resolveProject(a.project);
      const patch = {};
      if (a.name !== undefined) patch.name = String(a.name).trim();
      if (a.folder !== undefined) patch.folder_id = await api.resolveFolder(a.folder);
      if (a.status !== undefined) patch.status = a.status;
      if (a.notes !== undefined) patch.notes = a.notes;
      if (a.kind !== undefined) patch.kind = a.kind;
      if (a.complete_with_last !== undefined) patch.complete_with_last = !!a.complete_with_last;
      if (a.flagged !== undefined) patch.flagged = !!a.flagged;
      if (Array.isArray(a.tags)) {
        const tagIds = [];
        for (const l of a.tags) tagIds.push(await api.ensureTag(l));
        await api.q(`project_tags?${api.u}&project_id=eq.${id}`, { method: 'DELETE' });
        if (tagIds.length) await api.q('project_tags', { method: 'POST', body: [...new Set(tagIds)].map((tag_id) => ({ project_id: id, tag_id, user_id: api.userId })) });
      }
      if (Object.keys(patch).length) await api.q(`projects?${api.u}&id=eq.${id}`, { method: 'PATCH', body: patch });
      const [p] = await api.q(`projects?${api.u}&id=eq.${id}&select=*`);
      const folder = p.folder_id ? (await api.q(`folders?${api.u}&id=eq.${p.folder_id}&select=name`))[0] : null;
      const { tags: allTags, tagLabel } = await api.lookups();
      const pt = (await api.q(`project_tags?${api.u}&project_id=eq.${id}&select=tag_id`)).map((l) => allTags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel);
      return { id: p.id, name: p.name, status: p.status, kind: p.kind, complete_with_last: p.complete_with_last, flagged: p.flagged, tags: pt, folder: folder ? folder.name : null, notes: p.notes || undefined };
    },
  },
  {
    name: 'list_folders',
    description: 'List project folders with how many active/on-hold and completed/dropped projects each holds. Archived folders are included only if include_archived is true.',
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean', default: false } } },
    async run(api, { include_archived = false }) {
      const [folders, projects] = await Promise.all([
        api.q(`folders?${api.u}${include_archived ? '' : '&archived_at=is.null'}&order=sort.asc&select=id,name,archived_at`),
        api.q(`projects?${api.u}&folder_id=not.is.null&select=folder_id,status`),
      ]);
      return folders.map((f) => {
        const inside = projects.filter((p) => p.folder_id === f.id);
        const live = inside.filter((p) => p.status === 'active' || p.status === 'on_hold').length;
        return { id: f.id, name: f.name, archived: !!f.archived_at, active_projects: live, archived_projects: inside.length - live };
      });
    },
  },
  {
    name: 'create_folder',
    description: 'Create a project folder (returns the existing one if a non-archived folder with that name exists).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run(api, { name }) {
      if (!name || !String(name).trim()) throw new Error('name is required');
      const id = await api.resolveFolder(name);
      const [f] = await api.q(`folders?${api.u}&id=eq.${id}&select=id,name,archived_at`);
      return { id: f.id, name: f.name, archived: !!f.archived_at };
    },
  },
  {
    name: 'update_folder',
    description: 'Rename a folder, or archive/unarchive it (archived: true/false). Folders cannot be deleted. Archiving fails while the folder has active or on-hold projects; move them with update_project or mark them completed/dropped first.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder name or id' },
        name: { type: 'string', description: 'New name' },
        archived: { type: 'boolean' },
      },
      required: ['folder'],
    },
    async run(api, a) {
      const all = await api.q(`folders?${api.u}&select=id,name,archived_at`);
      const key = String(a.folder).trim().toLowerCase();
      const matches = all.filter((f) => f.id === a.folder || f.name.toLowerCase() === key);
      const f = matches.find((x) => !x.archived_at) || matches[0];
      if (!f) throw new Error(`No folder "${a.folder}". Use list_folders.`);
      const patch = {};
      if (a.name !== undefined) patch.name = String(a.name).trim();
      if (a.archived !== undefined) patch.archived_at = a.archived ? new Date().toISOString() : null;
      if (Object.keys(patch).length) await api.q(`folders?${api.u}&id=eq.${f.id}`, { method: 'PATCH', body: patch });
      const [row] = await api.q(`folders?${api.u}&id=eq.${f.id}&select=id,name,archived_at`);
      return { id: row.id, name: row.name, archived: !!row.archived_at };
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
