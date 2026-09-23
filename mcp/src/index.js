// Todo Tooling MCP server (Cloudflare Worker) at https://mcp.todotooling.com/mcp
//
// Stateless MCP over Streamable HTTP: every JSON-RPC request is a POST that gets
// a single JSON response. Callers authenticate with a personal access token
// (created in the app's Settings) sent as `Authorization: Bearer tt_...`.
// The Worker talks to Supabase with a server-side secret key, so every query
// below is explicitly scoped to the token owner's user_id.

import PostalMime from 'postal-mime';
import { handleGeo, makePlaceResolver, loadPlaceData } from './geo.js';
import { sendDueReminders } from './reminders.js';
import { deliver, sendQueuedTests } from './deliver.js';

const SERVER_INFO = { name: 'todotooling', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Todo Tooling is the user's GTD system. Capture anything new with capture (it lands in the Inbox).
Clarify inbox items with update_task: give each a project and/or tags (contexts like "Laptop", people like "Waiting : Hiro"); an item leaves the Inbox once it has a project or tag.
Use planned for when the user intends to work on something and due only for hard deadlines; flagged means "important now". Dates are YYYY-MM-DD in the user's timezone.
Never complete, reschedule or re-file tasks the user did not ask you to change.
Notifications: pass notifications (e.g. [{"kind":"before_due","minutes":60}]) to remind the user on their devices; they follow the item's dates.
Attachments: add_attachment attaches text, base64 or a URL's file to an action or project; get_task returns download links; remove_attachment archives.
Repeating items: pass repeat on capture/update_task/create_project/update_project (e.g. {"every":2,"unit":"week","weekdays":[1,4]}); completing one creates the next occurrence automatically; use skip_occurrence to skip one; dropping it ends the series.
For a weekly review: call list_review, go through each project with the user (use its hints), make the changes they want, then mark_reviewed.
Folders and projects are never deleted: archive a folder with update_folder (only possible once it has no active/on-hold projects) and archive a project by setting its status to completed or dropped.
Places: an action, tag or project can have a place (a saved location) plus an optional location_alert (arrive, leave or nearby) and radius. Actions inherit a place from their tags, group, project or project tags. Pass place as a saved place's name or id, or as an address/business to look up (it is saved as a new place). Use list_nearby with the user's coordinates to find what can be done nearby. Places are archived, never deleted.`;

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
    if (url.pathname === '/push/test') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      if (!(env.SUPABASE_SECRET_KEY || '').trim() || !(env.VAPID_PRIVATE_JWK || '').trim()) return json({ error: 'Server not configured' }, 503);
      return handlePushTest(request, env);
    }
    if (url.pathname === '/geo') {
      if (!(env.SUPABASE_SECRET_KEY || '').trim()) return json({ error: 'Server not configured' }, 503);
      return handleGeo(request, env, ctx, { rest: (path, opts) => rest(env, path, opts), sha256Hex, json });
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

  // Cron (every minute): send custom notifications and queued tests whose time has come.
  async scheduled(event, env, ctx) {
    if (!(env.SUPABASE_SECRET_KEY || '').trim() || !(env.VAPID_PRIVATE_JWK || '').trim()) return;
    const r = (path, opts) => rest(env, path, opts);
    ctx.waitUntil(Promise.all([
      sendDueReminders(env, r).then((x) => { if (x.due) console.log('reminders', x); }),
      sendQueuedTests(env, r).then((n) => { if (n) console.log('queued tests', n); }),
    ]));
  },

  // Email Routing sends inbox@todotooling.com here; each accepted email becomes an Inbox task.
  async email(message, env) {
    return handleEmail(message, env);
  },
};

// ---------- test notifications from the app ----------
// POST /push/test with the signed-in user's Supabase access token.
//   { delay_seconds: 0 }  send now, respond with each device's result
//   { delay_seconds: 60 } queue it; the cron sends it (lock your phone to see a real background push)
export async function handlePushTest(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in first' }, 401);
  const who = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return json({ error: 'Your session expired. Reload the app.' }, 401);
  const { id: userId } = await who.json();
  let delay = 0;
  try { delay = Math.round(Number((await request.json()).delay_seconds) || 0); } catch { /* no body */ }
  delay = Math.min(3600, Math.max(0, delay));
  const r = (path, opts) => rest(env, path, opts);
  if (delay) {
    const scheduled_for = new Date(Date.now() + delay * 1000).toISOString();
    const [row] = await r('push_log', { method: 'POST', prefer: 'return=representation',
      body: { user_id: userId, kind: 'test', title: '🔔 Scheduled test', body: `Sent ${delay >= 60 ? `${Math.round(delay / 60)} min` : `${delay} s`} after you asked. Background notifications work!`, scheduled_for } });
    return json({ queued: row.id, scheduled_for });
  }
  const out = await deliver(env, r, userId, { title: '🔔 Test notification', body: 'Notifications from Todo Tooling work on this device.', tag: `test:${Date.now()}`, url: '#settings' }, { kind: 'test' });
  return json(out);
}

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
  const rows = await rest(env, `api_tokens?token_hash=eq.${hash}&select=id,user_id,scope`);
  if (!rows.length || rows[0].scope !== 'full') return null; // location keys only work at /geo
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
    const placeData = await loadPlaceData((path) => this.q(path), this.userId);
    const known = new Set(placeData.tasks.map((t) => t.id));
    placeData.tasks.push(...tasks.filter((t) => !known.has(t.id))); // closed tasks too
    const placeOf = makePlaceResolver(placeData);
    const reminders = await this.notificationsFor('task_id', tasks.map((t) => t.id));
    const files = await this.q(`attachments?${this.u}&task_id=${inList(tasks.map((t) => t.id))}&archived_at=is.null&order=created_at.asc&select=id,task_id,name,size,mime`);
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
      place: placeSummary(placeOf(t)),
      repeat: t.repeat_rule ? { ...t.repeat_rule, summary: describeRepeat(t.repeat_rule) } : undefined,
      notifications: reminders[t.id],
      attachments: files.some((f) => f.task_id === t.id) ? files.filter((f) => f.task_id === t.id).map(({ task_id, ...f }) => f) : undefined,
      in_inbox: t.in_inbox,
      status: t.completed_at ? 'completed' : t.dropped_at ? 'dropped' : 'open',
      flagged: t.flagged,
      due: localDate(t.due_at, this.tz),
      planned: localDate(t.planned_at, this.tz),
      defer: localDate(t.defer_at, this.tz),
      completed_at: t.completed_at,
      completion_note: t.completion_note || undefined,
      parent_id: t.parent_id || undefined,
      dropped_at: t.dropped_at || undefined,
      created_at: t.created_at,
      changed_at: t.updated_at,
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

  // Place by id or saved name; otherwise look the text up with Google (address or business) and save it.
  async resolvePlace(ref) {
    if (ref === null || ref === '') return null;
    const key = String(ref).trim();
    const places = await this.q(`places?${this.u}&archived_at=is.null&select=id,name,address`);
    const hit = places.find((p) => p.id === key) || places.find((p) => p.name.toLowerCase() === key.toLowerCase());
    if (hit) return hit.id;
    const found = await geocode(this.env, key);
    if (!found) throw new Error(`No saved place "${key}" and it couldn't be looked up. Use list_places, or create_place with lat/lng.`);
    const [row] = await this.q('places', { method: 'POST', prefer: 'return=representation', body: { user_id: this.userId, ...found } });
    return row.id;
  }

  // place / location_alert / location_radius_m arguments → column patch (shared by tasks, tags, projects).
  async locationPatch(a) {
    const patch = {};
    if (a.place !== undefined) patch.place_id = await this.resolvePlace(a.place);
    if (a.location_alert !== undefined) {
      if (a.location_alert !== null && !['arrive', 'leave', 'nearby'].includes(a.location_alert)) throw new Error('location_alert must be arrive, leave, nearby or null');
      patch.location_trigger = a.location_alert || null;
    }
    if (a.location_radius_m !== undefined) patch.location_radius_m = a.location_radius_m === null ? null : Math.min(80467, Math.max(25, Math.round(Number(a.location_radius_m))));
    if (patch.place_id === null) { patch.location_trigger = null; patch.location_radius_m = null; }
    return patch;
  }

  // Custom notifications: { id -> [{kind, minutes, at, fires_at, sent}] } for task_id or project_id.
  async notificationsFor(col, ids) {
    if (!ids.length) return {};
    const rows = await this.q(`notifications?${this.u}&${col}=${inList(ids)}&order=fire_at.asc&select=*`);
    const out = {};
    rows.forEach((n) => { (out[n[col]] = out[n[col]] || []).push({ kind: n.kind, minutes: n.kind === 'before_due' || n.kind === 'before_planned' ? n.offset_minutes : undefined, at: n.at || undefined, fires_at: n.fire_at, sent: !!n.sent_at }); });
    return out;
  }

  async setNotifications(col, id, list) {
    const rows = list.map((n) => {
      if (!['before_due', 'before_planned', 'at_defer', 'at'].includes(n.kind)) throw new Error('notification kind must be before_due, before_planned, at_defer or at');
      const row = { user_id: this.userId, [col]: id, kind: n.kind, offset_minutes: Math.min(525600, Math.max(0, Math.round(Number(n.minutes) || 0))) };
      if (n.kind === 'at') {
        if (!n.at || isNaN(new Date(n.at))) throw new Error('an "at" notification needs at (an ISO time)');
        row.at = new Date(n.at).toISOString();
      }
      return row;
    });
    // Keep unchanged reminders (so one that already fired isn't re-sent); remove and add the rest.
    const key = (n) => `${n.kind}|${n.kind === 'at' ? new Date(n.at).toISOString() : n.offset_minutes}`;
    const existing = await this.q(`notifications?${this.u}&${col}=eq.${id}&select=id,kind,offset_minutes,at`);
    const wanted = new Set(rows.map(key));
    const have = new Set(existing.map(key));
    const drop = existing.filter((n) => !wanted.has(key(n))).map((n) => n.id);
    const add = rows.filter((r, i) => !have.has(key(r)) && rows.findIndex((x) => key(x) === key(r)) === i);
    if (drop.length) await this.q(`notifications?${this.u}&id=${inList(drop)}`, { method: 'DELETE' });
    if (add.length) await this.q('notifications', { method: 'POST', body: add });
  }

  // ---------- attachments (private Storage bucket "attachments") ----------
  storageHeaders(extra = {}) {
    const key = this.env.SUPABASE_SECRET_KEY;
    return { apikey: key, ...(key.startsWith('ey') ? { Authorization: `Bearer ${key}` } : {}), ...extra };
  }
  async signedUrl(path) {
    const res = await fetch(`${this.env.SUPABASE_URL}/storage/v1/object/sign/attachments/${path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'POST', headers: this.storageHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 3600 }) });
    if (!res.ok) return null;
    const { signedURL } = await res.json();
    return signedURL ? `${this.env.SUPABASE_URL}/storage/v1${signedURL}` : null;
  }
  async withLinks(col, id) {
    const rows = await this.q(`attachments?${this.u}&${col}=eq.${id}&archived_at=is.null&order=created_at.asc&select=id,name,size,mime,path`);
    return Promise.all(rows.map(async ({ path, ...a }) => ({ ...a, url: await this.signedUrl(path) })));
  }
  async upload(col, id, name, bytes, mime) {
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Attachments are limited to 25 MB');
    const safe = String(name).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
    const path = `${this.userId}/${crypto.randomUUID()}/${safe}`;
    const res = await fetch(`${this.env.SUPABASE_URL}/storage/v1/object/attachments/${path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'POST', headers: this.storageHeaders({ 'Content-Type': mime }), body: bytes });
    if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const [row] = await this.q('attachments', { method: 'POST', prefer: 'return=representation', body: { user_id: this.userId, [col]: id, path, name: String(name).slice(0, 255), size: bytes.byteLength, mime } });
    return { id: row.id, name: row.name, size: row.size, mime: row.mime, url: await this.signedUrl(path) };
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
    if (p && (p.status !== 'active' || (p.defer_at && p.defer_at > nowIso))) return false; // deferred project hides its actions
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
        repeat: {
          type: ['object', 'null'],
          description: 'Repeat rule, or null to stop repeating. {every, unit: day|week|month|year, weekdays?: [0-6] (Sun=0, with unit week), from?: assigned|completion (default assigned = fixed schedule), end_count?, end_until?: YYYY-MM-DD}. Completing it creates the next occurrence.',
          properties: { every: { type: 'integer' }, unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] }, weekdays: { type: 'array', items: { type: 'integer' } }, from: { type: 'string', enum: ['assigned', 'completion'] }, end_count: { type: 'integer' }, end_until: { type: 'string' } },
        },
        notifications: {
          type: 'array',
          description: 'Replaces the custom notifications. Each: {kind: before_due|before_planned|at_defer|at, minutes?: minutes before (0 = at the time), at?: ISO time for kind at}. [] removes all.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['before_due', 'before_planned', 'at_defer', 'at'] }, minutes: { type: 'integer' }, at: { type: 'string' } }, required: ['kind'] },
        },
        place: { type: ['string', 'null'], description: 'Saved place name or id, or an address/business to look up and save; null to clear' },
        location_alert: { type: ['string', 'null'], enum: ['arrive', 'leave', 'nearby', null], description: 'Alert when arriving at, leaving, or near the place; null for none' },
        location_radius_m: { type: ['integer', 'null'], description: 'How close counts, in meters (152 = 500 ft, 402 = ¼ mi, 1609 = 1 mi); null uses the place radius' },
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
      const fields = Object.fromEntries(Object.entries(rest).filter(([k, v]) => ['project', 'parent', 'tags', 'flagged', 'due', 'planned', 'defer', 'estimate_minutes', 'place', 'location_alert', 'location_radius_m', 'repeat', 'notifications'].includes(k) && v !== undefined));
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
        projects_due: (await api.q(`projects?${api.u}&status=in.(active,on_hold)&due_at=lt.${endOfToday}&order=due_at.asc&select=id,name,due_at`))
          .map((p) => ({ id: p.id, name: p.name, due: localDate(p.due_at, api.tz), overdue: p.due_at < startOfToday })),
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
      const projects = await api.q(`projects?${api.u}&status=in.(active,on_hold)&or=(due_at.lt.${end},planned_at.lt.${end})&select=id,name,due_at,planned_at,status`);
      const out = { today, past: { overdue: [], planned_earlier: [], overdue_projects: [] }, days: {} };
      for (let i = 0; i < days; i++) {
        const d = localDate(new Date(Date.parse(start) + i * 86400000 + 12 * 3600000).toISOString(), api.tz);
        out.days[d] = { due: [], planned: [], becomes_available: [], projects: [] };
      }
      projects.forEach((p) => {
        const due = localDate(p.due_at, api.tz); const planned = localDate(p.planned_at, api.tz);
        const row = { id: p.id, name: p.name, due, planned };
        if (due && due < today) out.past.overdue_projects.push(row);
        [due, planned].filter((d, i, a) => d && a.indexOf(d) === i).forEach((d) => { if (out.days[d]) out.days[d].projects.push(row); });
      });
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
    name: 'list_review',
    description: 'Projects due for review (the GTD Weekly Review), oldest first, each with its next action and health hints (no next action, overdue, slipped plans, nothing completed in 30+ days, on hold 3+ months). Walk the user through them, suggest fixes, and call mark_reviewed when they are done with one.',
    inputSchema: { type: 'object', properties: { include_not_due: { type: 'boolean', default: false } } },
    async run(api, { include_not_due = false }) {
      const nowIso = new Date().toISOString();
      const [projects, open, folders] = await Promise.all([
        api.q(`projects?${api.u}&status=in.(active,on_hold)&order=next_review_at.asc&select=*`),
        api.q(`tasks?${api.u}&${OPEN}&select=id,title,project_id,parent_id,sort,created_at,defer_at,due_at,planned_at,completed_at,dropped_at`),
        api.q(`folders?${api.u}&select=id,name`),
      ]);
      const due = projects.filter((p) => include_not_due || (p.next_review_at && p.next_review_at <= nowIso));
      const { nextFor } = availabilityOf(open, projects, nowIso);
      const todayStart = zonedToIso(localDate(nowIso, api.tz), 0, api.tz);
      const out = [];
      for (const p of due.slice(0, 50)) {
        const mine = open.filter((t) => t.project_id === p.id);
        const next = p.status === 'active' ? nextFor(p.id) : null;
        const hints = [];
        if (p.status === 'active' && !mine.length) hints.push('No actions left: complete or drop it?');
        else if (p.status === 'active' && !next) hints.push(mine.every((t) => t.defer_at && t.defer_at > nowIso) ? 'Every action is deferred.' : 'No available next action.');
        const overdue = mine.filter((t) => t.due_at && t.due_at < todayStart).length;
        if (overdue) hints.push(`${overdue} overdue`);
        const slipped = mine.filter((t) => t.planned_at && t.planned_at < todayStart).length;
        if (slipped) hints.push(`${slipped} planned date(s) slipped`);
        if (p.status === 'active' && mine.length) {
          const [last] = await api.q(`tasks?${api.u}&project_id=eq.${p.id}&completed_at=not.is.null&order=completed_at.desc&limit=1&select=completed_at`);
          const days = last ? Math.floor((Date.now() - Date.parse(last.completed_at)) / 86400000) : null;
          if (days === null || days >= 30) hints.push(days === null ? 'Nothing ever completed.' : `Nothing completed in ${days} days.`);
        }
        if (p.status === 'on_hold' && p.updated_at && Date.now() - Date.parse(p.updated_at) > 90 * 86400000) hints.push('On hold 3+ months.');
        out.push({
          id: p.id, name: p.name, status: p.status, kind: p.kind, flagged: p.flagged,
          folder: (folders.find((f) => f.id === p.folder_id) || {}).name || null,
          open_actions: mine.length, next_action: next ? { id: next.id, title: next.title } : null,
          review_every_days: p.review_every_days, last_reviewed: localDate(p.last_reviewed_at, api.tz), review_due: localDate(p.next_review_at, api.tz),
          hints,
        });
      }
      return { due_count: due.length, projects: out };
    },
  },
  {
    name: 'mark_reviewed',
    description: 'Mark a project as reviewed now (after going over it with the user). Its next review date moves forward by its review interval.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name or id' } }, required: ['project'] },
    async run(api, { project }) {
      const id = await api.resolveProject(project);
      await api.q(`projects?${api.u}&id=eq.${id}`, { method: 'PATCH', body: { last_reviewed_at: new Date().toISOString() } });
      const [p] = await api.q(`projects?${api.u}&id=eq.${id}&select=id,name,last_reviewed_at,next_review_at,review_every_days`);
      return { id: p.id, name: p.name, last_reviewed: localDate(p.last_reviewed_at, api.tz), next_review: localDate(p.next_review_at, api.tz), review_every_days: p.review_every_days };
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
    description: 'Get one task with its notes, project, tags, dates, repeat, notifications, attachments (with download links valid for an hour) and (for an action group) its sub-actions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(api, { id }) {
      const task = await api.task(id);
      const [shaped] = await api.shape([task]);
      const kids = await api.q(`tasks?${api.u}&parent_id=eq.${task.id}&order=sort.asc&select=*`);
      if (kids.length) shaped.sub_actions = await api.shape(kids);
      if (shaped.attachments) shaped.attachments = await api.withLinks('task_id', task.id);
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
        completed_at: { type: 'string', description: 'When it was completed (ISO time or YYYY-MM-DD), to backdate; implies status completed' },
        dropped_at: { type: 'string', description: 'When it was dropped (ISO time or YYYY-MM-DD), to backdate; implies status dropped' },
        estimate_minutes: { type: ['integer', 'null'], description: 'How long it takes, in minutes; null to clear' },
        repeat: {
          type: ['object', 'null'],
          description: 'Repeat rule, or null to stop repeating. {every, unit: day|week|month|year, weekdays?: [0-6] (Sun=0, with unit week), from?: assigned|completion (default assigned = fixed schedule), end_count?, end_until?: YYYY-MM-DD}. Completing it creates the next occurrence.',
          properties: { every: { type: 'integer' }, unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] }, weekdays: { type: 'array', items: { type: 'integer' } }, from: { type: 'string', enum: ['assigned', 'completion'] }, end_count: { type: 'integer' }, end_until: { type: 'string' } },
        },
        notifications: {
          type: 'array',
          description: 'Replaces the custom notifications. Each: {kind: before_due|before_planned|at_defer|at, minutes?: minutes before (0 = at the time), at?: ISO time for kind at}. [] removes all.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['before_due', 'before_planned', 'at_defer', 'at'] }, minutes: { type: 'integer' }, at: { type: 'string' } }, required: ['kind'] },
        },
        skip_occurrence: { type: 'boolean', description: 'Move a repeating action to its next occurrence without completing it' },
        move: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Reorder among its siblings (same project and parent). Order decides the next action in sequential projects.' },
        place: { type: ['string', 'null'], description: 'Saved place name or id, or an address/business to look up and save; null to clear' },
        location_alert: { type: ['string', 'null'], enum: ['arrive', 'leave', 'nearby', null], description: 'Alert when arriving at, leaving, or near the place; null for none' },
        location_radius_m: { type: ['integer', 'null'], description: 'How close counts, in meters (152 = 500 ft, 402 = ¼ mi, 1609 = 1 mi); null uses the place radius' },
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
      Object.assign(patch, await api.locationPatch(a));
      if (a.repeat !== undefined) patch.repeat_rule = repeatRule(a.repeat, api.tz, task.repeat_rule);
      if (a.completed_at && a.status === undefined) a.status = 'completed';
      if (a.dropped_at && a.status === undefined) a.status = 'dropped';
      if (a.status !== undefined) {
        const at = (v, fallback) => (v ? zonedToIso(v, 12, api.tz) : fallback || new Date().toISOString());
        patch.completed_at = a.status === 'completed' ? at(a.completed_at, task.completed_at) : null;
        patch.dropped_at = a.status === 'dropped' ? at(a.dropped_at, task.dropped_at) : null;
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
      if (Array.isArray(a.notifications)) await api.setNotifications('task_id', task.id, a.notifications);
      if (a.skip_occurrence) {
        if (!(patch.repeat_rule || task.repeat_rule)) throw new Error('skip_occurrence needs a repeating action');
        await api.q('rpc/repeat_skip', { method: 'POST', body: { task_id: task.id, owner: api.userId } });
      }
      if (a.move) {
        const sibs = await api.q(`tasks?${api.u}&${OPEN}&project_id=${projectId ? `eq.${projectId}` : 'is.null'}&parent_id=${parentId ? `eq.${parentId}` : 'is.null'}&select=id,sort,created_at`);
        sibs.sort((x, y) => (x.sort - y.sort) || (x.created_at < y.created_at ? -1 : 1));
        const i = sibs.findIndex((x) => x.id === task.id);
        if (i >= 0) {
          const [me] = sibs.splice(i, 1);
          const to = { up: Math.max(0, i - 1), down: Math.min(sibs.length, i + 1), top: 0, bottom: sibs.length }[a.move];
          sibs.splice(to, 0, me);
          await Promise.all(sibs.map((x, sort) => (x.sort === sort ? null : api.q(`tasks?${api.u}&id=eq.${x.id}`, { method: 'PATCH', body: { sort } }))));
        }
      }
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
      const [done] = await api.shape([await api.task(task.id)]);
      if (completed && task.repeat_rule && !task.completed_at) {
        const [next] = await api.q(`tasks?${api.u}&${OPEN}&title=eq.${encodeURIComponent(task.title)}&source=eq.repeat&order=created_at.desc&limit=1&select=*`);
        if (next) done.next_occurrence = (await api.shape([next]))[0];
      }
      return done;
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
    description: 'List projects with folder, status, type, dates (defer/planned/due), duration, review cadence and dates, open action count and next action.',
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
          ...projectOut(api, p, folders),
          open_actions: open.filter((t) => t.project_id === p.id).length,
          next_action: next ? { id: next.id, title: next.title } : null,
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
        defer: { type: ['string', 'null'], description: 'YYYY-MM-DD: the project and its actions are hidden until then; null to clear' },
        planned: { type: ['string', 'null'], description: 'YYYY-MM-DD when the user intends to work on it; null to clear' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD hard deadline for the whole project; null to clear' },
        estimate_minutes: { type: ['integer', 'null'], description: 'Rough total duration in minutes; null to clear' },
        review_every: { type: 'integer', description: 'Review cadence number, with review_unit (e.g. 2 + week = every 2 weeks)' },
        review_unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        next_review: { type: ['string', 'null'], description: 'YYYY-MM-DD next review date; null to recompute from the cadence' },
        completed_at: { type: 'string', description: 'When it was completed/dropped (ISO time or YYYY-MM-DD), to backdate a closed project' },
        repeat: {
          type: ['object', 'null'],
          description: 'Repeat rule, or null to stop repeating. {every, unit: day|week|month|year, weekdays?: [0-6] (Sun=0, with unit week), from?: assigned|completion (default assigned = fixed schedule), end_count?, end_until?: YYYY-MM-DD}. Completing the project starts a fresh copy with all its actions.',
          properties: { every: { type: 'integer' }, unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] }, weekdays: { type: 'array', items: { type: 'integer' } }, from: { type: 'string', enum: ['assigned', 'completion'] }, end_count: { type: 'integer' }, end_until: { type: 'string' } },
        },
        notifications: {
          type: 'array',
          description: 'Replaces the custom notifications. Each: {kind: before_due|before_planned|at_defer|at, minutes?: minutes before (0 = at the time), at?: ISO time for kind at}. [] removes all.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['before_due', 'before_planned', 'at_defer', 'at'] }, minutes: { type: 'integer' }, at: { type: 'string' } }, required: ['kind'] },
        },
        place: { type: ['string', 'null'], description: 'Saved place name or id, or an address/business to look up and save; null to clear' },
        location_alert: { type: ['string', 'null'], enum: ['arrive', 'leave', 'nearby', null], description: 'Alert when arriving at, leaving, or near the place; null for none' },
        location_radius_m: { type: ['integer', 'null'], description: 'How close counts, in meters (152 = 500 ft, 402 = ¼ mi, 1609 = 1 mi); null uses the place radius' },
      },
      required: ['name'],
    },
    async run(api, { name, folder, notes = '', kind = 'parallel', complete_with_last = false, ...more }) {
      const folder_id = folder ? await api.resolveFolder(folder) : null;
      const body = { user_id: api.userId, name: String(name).trim(), notes, folder_id, kind, complete_with_last: !!complete_with_last, ...(await api.locationPatch(more)), ...projectPatch(api, more) };
      const [row] = await api.q('projects', { method: 'POST', prefer: 'return=representation', body });
      if (Array.isArray(more.notifications)) await api.setNotifications('project_id', row.id, more.notifications);
      return { ...projectOut(api, row, folder ? [{ id: folder_id, name: folder }] : []), notifications: (await api.notificationsFor('project_id', [row.id]))[row.id] };
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
        review_every_days: { type: 'integer', description: 'Review interval in days (older form; prefer review_every + review_unit)' },
        defer: { type: ['string', 'null'], description: 'YYYY-MM-DD: the project and its actions are hidden until then; null to clear' },
        planned: { type: ['string', 'null'], description: 'YYYY-MM-DD when the user intends to work on it; null to clear' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD hard deadline for the whole project; null to clear' },
        estimate_minutes: { type: ['integer', 'null'], description: 'Rough total duration in minutes; null to clear' },
        review_every: { type: 'integer', description: 'Review cadence number, with review_unit (e.g. 2 + week = every 2 weeks)' },
        review_unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        next_review: { type: ['string', 'null'], description: 'YYYY-MM-DD next review date; null to recompute from the cadence' },
        completed_at: { type: 'string', description: 'When it was completed/dropped (ISO time or YYYY-MM-DD), to backdate a closed project' },
        repeat: {
          type: ['object', 'null'],
          description: 'Repeat rule, or null to stop repeating. {every, unit: day|week|month|year, weekdays?: [0-6] (Sun=0, with unit week), from?: assigned|completion (default assigned = fixed schedule), end_count?, end_until?: YYYY-MM-DD}. Completing the project starts a fresh copy with all its actions.',
          properties: { every: { type: 'integer' }, unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] }, weekdays: { type: 'array', items: { type: 'integer' } }, from: { type: 'string', enum: ['assigned', 'completion'] }, end_count: { type: 'integer' }, end_until: { type: 'string' } },
        },
        notifications: {
          type: 'array',
          description: 'Replaces the custom notifications. Each: {kind: before_due|before_planned|at_defer|at, minutes?: minutes before (0 = at the time), at?: ISO time for kind at}. [] removes all.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['before_due', 'before_planned', 'at_defer', 'at'] }, minutes: { type: 'integer' }, at: { type: 'string' } }, required: ['kind'] },
        },
        place: { type: ['string', 'null'], description: 'Saved place name or id, or an address/business to look up and save; null to clear' },
        location_alert: { type: ['string', 'null'], enum: ['arrive', 'leave', 'nearby', null], description: 'Alert when arriving at, leaving, or near the place; null for none' },
        location_radius_m: { type: ['integer', 'null'], description: 'How close counts, in meters (152 = 500 ft, 402 = ¼ mi, 1609 = 1 mi); null uses the place radius' },
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
      Object.assign(patch, await api.locationPatch(a), projectPatch(api, a));
      if (a.review_every_days !== undefined) patch.review_every_days = Math.min(3650, Math.max(1, Math.round(Number(a.review_every_days))));
      if (Array.isArray(a.tags)) {
        const tagIds = [];
        for (const l of a.tags) tagIds.push(await api.ensureTag(l));
        await api.q(`project_tags?${api.u}&project_id=eq.${id}`, { method: 'DELETE' });
        if (tagIds.length) await api.q('project_tags', { method: 'POST', body: [...new Set(tagIds)].map((tag_id) => ({ project_id: id, tag_id, user_id: api.userId })) });
      }
      if (Object.keys(patch).length) await api.q(`projects?${api.u}&id=eq.${id}`, { method: 'PATCH', body: patch });
      if (Array.isArray(a.notifications)) await api.setNotifications('project_id', id, a.notifications);
      const [p] = await api.q(`projects?${api.u}&id=eq.${id}&select=*`);
      const folder = p.folder_id ? (await api.q(`folders?${api.u}&id=eq.${p.folder_id}&select=name`))[0] : null;
      const { tags: allTags, tagLabel } = await api.lookups();
      const pt = (await api.q(`project_tags?${api.u}&project_id=eq.${id}&select=tag_id`)).map((l) => allTags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel);
      const place = p.place_id ? (await api.q(`places?${api.u}&id=eq.${p.place_id}&select=*`))[0] : null;
      return { ...projectOut(api, p, folder ? [{ id: p.folder_id, name: folder.name }] : []), tags: pt,
        notifications: (await api.notificationsFor('project_id', [id]))[id],
        attachments: (await api.withLinks('project_id', id)).map(({ url, ...f }) => f),
        place: place ? { name: place.name, alert: p.location_trigger, radius_m: p.location_radius_m || place.radius_m } : null };
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
    name: 'create_tag',
    description: 'Create a tag (context, person or waiting-for). Use "Parent : Child" to nest, e.g. "Waiting : Hiro". Returns the existing tag if it already exists.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    async run(api, { label }) {
      if (!label || !String(label).trim()) throw new Error('label is required');
      const id = await api.ensureTag(label);
      const { tags, tagLabel } = await api.lookups();
      return { id, label: tagLabel(tags.find((t) => t.id === id)) };
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
  {
    name: 'update_tag',
    description: 'Rename a tag, or give it a place: every action with the tag inherits that place (and its alert) unless the action has its own.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Tag label ("Errands" or "Waiting : Hiro") or id' },
        name: { type: 'string', description: 'New name (just this level, not the parent)' },
        place: { type: ['string', 'null'], description: 'Saved place name or id, or an address/business to look up and save; null to clear' },
        location_alert: { type: ['string', 'null'], enum: ['arrive', 'leave', 'nearby', null], description: 'Alert when arriving at, leaving, or near the place; null for none' },
        location_radius_m: { type: ['integer', 'null'], description: 'How close counts, in meters (152 = 500 ft, 402 = ¼ mi, 1609 = 1 mi); null uses the place radius' },
      },
      required: ['tag'],
    },
    async run(api, a) {
      const { tags, tagLabel } = await api.lookups();
      const key = String(a.tag).trim().toLowerCase();
      const tag = tags.find((t) => t.id === a.tag) || tags.find((t) => tagLabel(t).toLowerCase() === key) || tags.find((t) => t.name.toLowerCase() === key);
      if (!tag) throw new Error(`No tag "${a.tag}". Use list_tags or create_tag.`);
      const patch = await api.locationPatch(a);
      if (a.name !== undefined) patch.name = String(a.name).trim();
      if (Object.keys(patch).length) await api.q(`tags?${api.u}&id=eq.${tag.id}`, { method: 'PATCH', body: patch });
      const [row] = await api.q(`tags?${api.u}&id=eq.${tag.id}&select=*`);
      const place = row.place_id ? (await api.q(`places?${api.u}&id=eq.${row.place_id}&select=*`))[0] : null;
      return { id: row.id, label: tagLabel(row), place: place ? { name: place.name, alert: row.location_trigger, radius_m: row.location_radius_m || place.radius_m } : null };
    },
  },
  {
    name: 'get_history',
    description: 'Change history of an action or project: every field change (old → new, when, and whether it was the app, an agent, or automatic) plus the notifications sent for it. Newest first.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'Action id' }, project: { type: 'string', description: 'Project name or id' }, limit: { type: 'integer', default: 100 } } },
    async run(api, { task, project, limit = 100 }) {
      const col = task ? 'task_id' : project ? 'project_id' : null;
      if (!col) throw new Error('Give task (id) or project');
      const id = task ? (await api.task(task)).id : await api.resolveProject(project);
      const n = Math.min(500, Math.max(1, Math.round(Number(limit) || 100)));
      const [changes, sends] = await Promise.all([
        api.q(`item_history?${api.u}&${col}=eq.${id}&order=changed_at.desc&limit=${n}&select=field,old_value,new_value,source,changed_at`),
        api.q(`push_log?${api.u}&${col}=eq.${id}&order=created_at.desc&limit=${n}&select=kind,title,body,sent_at,devices,delivered,results,created_at`),
      ]);
      return {
        changes: changes.map((c) => ({ field: c.field, from: c.old_value, to: c.new_value, by: c.source, at: c.changed_at })),
        notifications_sent: sends.map((d) => ({ kind: d.kind, title: d.title, at: d.sent_at || d.created_at, devices: d.devices, delivered: d.delivered, results: d.results })),
      };
    },
  },
  {
    name: 'list_deliveries',
    description: 'Recent push notification deliveries (tests, reminders, place alerts) with each device\'s result, to troubleshoot notifications that did not arrive. Also lists the registered devices.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } },
    async run(api, { limit = 20 }) {
      const [devices, rows] = await Promise.all([
        api.q(`push_subscriptions?${api.u}&order=created_at.desc&select=device,endpoint,created_at`),
        api.q(`push_log?${api.u}&order=created_at.desc&limit=${Math.min(100, Math.max(1, Math.round(Number(limit) || 20)))}&select=kind,title,scheduled_for,sent_at,devices,delivered,results,task_id,project_id,created_at`),
      ]);
      return {
        devices: devices.map((d) => ({ device: d.device, service: new URL(d.endpoint).host, since: d.created_at })),
        deliveries: rows.map((d) => ({ kind: d.kind, title: d.title, queued_for: d.scheduled_for || undefined, sent_at: d.sent_at, devices: d.devices, delivered: d.delivered, results: d.results, task_id: d.task_id || undefined, project_id: d.project_id || undefined })),
      };
    },
  },
  {
    name: 'add_attachment',
    description: 'Attach a file to an action or project: text content, base64 bytes, or a public http(s) URL to download (max 25 MB). Returns it with a download link valid for an hour.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Action id (give task or project)' },
        project: { type: 'string', description: 'Project name or id' },
        name: { type: 'string', description: 'File name, e.g. "notes.txt" or "plans.pdf"' },
        text: { type: 'string', description: 'Text content (saved as UTF-8)' },
        base64: { type: 'string', description: 'File bytes, base64-encoded' },
        url: { type: 'string', description: 'Public http(s) URL to download and attach' },
        mime: { type: 'string', description: 'Content type (guessed from the source if omitted)' },
      },
      required: ['name'],
    },
    async run(api, a) {
      const [col, id] = a.task ? ['task_id', (await api.task(a.task)).id] : a.project ? ['project_id', await api.resolveProject(a.project)] : [];
      if (!col) throw new Error('Give task (id) or project');
      let bytes; let mime = a.mime;
      if (a.text !== undefined) { bytes = new TextEncoder().encode(String(a.text)); mime = mime || 'text/plain; charset=utf-8'; }
      else if (a.base64) { bytes = Uint8Array.from(atob(a.base64.replace(/\s+/g, '')), (c) => c.charCodeAt(0)); mime = mime || 'application/octet-stream'; }
      else if (a.url) {
        if (!/^https?:\/\//i.test(a.url)) throw new Error('url must be http(s)');
        const res = await fetch(a.url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`Couldn't download (${res.status})`);
        const len = Number(res.headers.get('content-length') || 0);
        if (len > 25 * 1024 * 1024) throw new Error('Attachments are limited to 25 MB');
        bytes = new Uint8Array(await res.arrayBuffer());
        mime = mime || (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      } else throw new Error('Give text, base64 or url');
      return api.upload(col, id, a.name, bytes, mime);
    },
  },
  {
    name: 'remove_attachment',
    description: 'Remove (archive) an attachment by id, or restore it with restore: true. Attachments are never deleted.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, restore: { type: 'boolean', default: false } }, required: ['id'] },
    async run(api, { id, restore = false }) {
      mustUuid(id, 'id');
      const rows = await api.q(`attachments?${api.u}&id=eq.${id}&select=id,name`);
      if (!rows.length) throw new Error('Attachment not found');
      await api.q(`attachments?${api.u}&id=eq.${id}`, { method: 'PATCH', body: { archived_at: restore ? null : new Date().toISOString() } });
      return { id, name: rows[0].name, archived: !restore };
    },
  },
  {
    name: 'list_places',
    description: 'List saved places with address, radius and how many open actions are at each (directly or inherited). Pass lat/lng to add distances and sort nearest first.',
    inputSchema: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' }, include_archived: { type: 'boolean', default: false } } },
    async run(api, { lat, lng, include_archived = false }) {
      const data = await loadPlaceData((path) => api.q(path), api.userId);
      const resolve = makePlaceResolver(data);
      const counts = new Map();
      data.tasks.forEach((t) => { const loc = resolve(t); if (loc) counts.set(loc.place.id, (counts.get(loc.place.id) || 0) + 1); });
      const here = typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
      return data.places.filter((p) => include_archived || !p.archived_at).map((p) => ({
        id: p.id, name: p.name, address: p.address || undefined, lat: p.lat, lng: p.lng, radius_m: p.radius_m, notes: p.notes || undefined,
        archived: !!p.archived_at, open_actions: counts.get(p.id) || 0,
        distance_m: here ? Math.round(metersBetween(here, p)) : undefined,
      })).sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0) || a.name.localeCompare(b.name));
    },
  },
  {
    name: 'create_place',
    description: 'Save a place. Give an address or business to look up (e.g. "Home Depot, Chimney Rock Rd, Houston"), or exact lat/lng. Radius defaults to ¼ mile (402 m).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the user calls it, e.g. "Home Depot" or "Office"' },
        address: { type: 'string', description: 'Address or business to look up (ignored if lat/lng are given)' },
        lat: { type: 'number' }, lng: { type: 'number' },
        radius_m: { type: 'integer', description: '152 = 500 ft, 402 = ¼ mi, 805 = ½ mi, 1609 = 1 mi' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
    async run(api, a) {
      const body = { user_id: api.userId, name: String(a.name || '').trim(), notes: a.notes || '' };
      if (!body.name) throw new Error('name is required');
      if (typeof a.lat === 'number' && typeof a.lng === 'number') Object.assign(body, { lat: a.lat, lng: a.lng, address: a.address || '' });
      else if (a.address) {
        const found = await geocode(api.env, a.address);
        if (!found) throw new Error(`Couldn't find "${a.address}". Try a fuller address, or pass lat/lng.`);
        Object.assign(body, found, { name: body.name });
      } else throw new Error('Give an address to look up, or lat and lng');
      if (a.radius_m !== undefined) body.radius_m = Math.min(80467, Math.max(25, Math.round(Number(a.radius_m))));
      const [row] = await api.q('places', { method: 'POST', prefer: 'return=representation', body });
      return placeOut(row);
    },
  },
  {
    name: 'update_place',
    description: 'Rename a place, move it (new address or lat/lng), change its radius or notes, or archive/unarchive it (archived: true/false). Places are never deleted; archived places stop applying to actions.',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Place name or id' },
        name: { type: 'string' }, address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' },
        radius_m: { type: 'integer' }, notes: { type: 'string' }, archived: { type: 'boolean' },
      },
      required: ['place'],
    },
    async run(api, a) {
      const all = await api.q(`places?${api.u}&select=*`);
      const key = String(a.place).trim().toLowerCase();
      const matches = all.filter((p) => p.id === a.place || p.name.toLowerCase() === key);
      const place = matches.find((p) => !p.archived_at) || matches[0];
      if (!place) throw new Error(`No place "${a.place}". Use list_places.`);
      const patch = {};
      if (a.name !== undefined) patch.name = String(a.name).trim();
      if (typeof a.lat === 'number' && typeof a.lng === 'number') Object.assign(patch, { lat: a.lat, lng: a.lng, google_place_id: null }, a.address !== undefined ? { address: a.address } : {});
      else if (a.address !== undefined) {
        const found = await geocode(api.env, a.address);
        if (!found) throw new Error(`Couldn't find "${a.address}".`);
        Object.assign(patch, { lat: found.lat, lng: found.lng, address: found.address, google_place_id: found.google_place_id });
      }
      if (a.radius_m !== undefined) patch.radius_m = Math.min(80467, Math.max(25, Math.round(Number(a.radius_m))));
      if (a.notes !== undefined) patch.notes = a.notes;
      if (a.archived !== undefined) patch.archived_at = a.archived ? new Date().toISOString() : null;
      if (Object.keys(patch).length) await api.q(`places?${api.u}&id=eq.${place.id}`, { method: 'PATCH', body: patch });
      const [row] = await api.q(`places?${api.u}&id=eq.${place.id}&select=*`);
      return placeOut(row);
    },
  },
  {
    name: 'list_nearby',
    description: 'Actions at places near a point (the user\'s current location), nearest place first, grouped by place. By default only actions that can be done now and places within 25 miles.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' }, lng: { type: 'number' },
        within_m: { type: 'integer', description: 'Max distance in meters (default 40234 = 25 mi)' },
        available_only: { type: 'boolean', default: true },
      },
      required: ['lat', 'lng'],
    },
    async run(api, { lat, lng, within_m = 40234, available_only = true }) {
      const here = { lat: Number(lat), lng: Number(lng) };
      if (!Number.isFinite(here.lat) || !Number.isFinite(here.lng)) throw new Error('lat and lng are required numbers');
      const data = await loadPlaceData((path) => api.q(path), api.userId);
      const resolve = makePlaceResolver(data);
      const full = await api.q(`tasks?${api.u}&${OPEN}&select=*`);
      const { available } = availabilityOf(full, await api.q(`projects?${api.u}&select=id,status,kind,defer_at`));
      const byPlace = new Map();
      full.forEach((t) => {
        if (available_only && !available(t)) return;
        const loc = resolve(t);
        if (!loc) return;
        const d = metersBetween(here, loc.place);
        if (d > within_m) return;
        if (!byPlace.has(loc.place.id)) byPlace.set(loc.place.id, { place: loc.place, distance_m: Math.round(d), tasks: [] });
        byPlace.get(loc.place.id).tasks.push(t);
      });
      const groups = [...byPlace.values()].sort((a, b) => a.distance_m - b.distance_m);
      const out = [];
      for (const g of groups) {
        out.push({ place: g.place.name, place_id: g.place.id, address: g.place.address || undefined, distance_m: g.distance_m,
          inside_radius: g.distance_m <= g.place.radius_m, actions: await api.shape(g.tasks) });
      }
      return { count: out.reduce((n, g) => n + g.actions.length, 0), places: out };
    },
  },
];

// ---------- repeat ----------
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Validate a repeat argument into a stored rule (keeps the occurrence counter when editing).
function repeatRule(r, tz, previous) {
  if (r === null) return null;
  if (typeof r !== 'object') throw new Error('repeat must be an object or null');
  const unit = r.unit || 'day';
  if (!['day', 'week', 'month', 'year'].includes(unit)) throw new Error('repeat.unit must be day, week, month or year');
  const rule = { every: Math.min(999, Math.max(1, Math.round(Number(r.every) || 1))), unit, from: r.from === 'completion' ? 'completion' : 'assigned', tz, n: (previous && previous.n) || 1 };
  if (unit === 'week' && Array.isArray(r.weekdays) && r.weekdays.length) {
    const wd = [...new Set(r.weekdays.map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    if (wd.length) rule.weekdays = wd;
  }
  if (r.end_count) rule.end_count = Math.max(1, Math.round(Number(r.end_count)));
  if (r.end_until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.end_until)) throw new Error('repeat.end_until must be YYYY-MM-DD');
    rule.end_until = r.end_until;
  }
  return rule;
}
function describeRepeat(rule) {
  const n = rule.every || 1;
  let s = `Every ${n === 1 ? rule.unit : `${n} ${rule.unit}s`}`;
  if (rule.weekdays && rule.weekdays.length) s += rule.weekdays.join() === '1,2,3,4,5' ? ' on weekdays' : ` on ${rule.weekdays.map((d) => WD[d]).join(', ')}`;
  if (rule.from === 'completion') s += ', after completion';
  if (rule.end_count) s += ` (${Math.min(rule.n || 1, rule.end_count)} of ${rule.end_count})`;
  if (rule.end_until) s += ` until ${rule.end_until}`;
  return s;
}

// ---------- projects ----------
// Date/duration/review/completion arguments shared by create_project and update_project.
function projectPatch(api, a) {
  const patch = {};
  if (a.defer !== undefined) patch.defer_at = zonedToIso(a.defer, 0, api.tz);
  if (a.planned !== undefined) patch.planned_at = zonedToIso(a.planned, 9, api.tz);
  if (a.due !== undefined) patch.due_at = zonedToIso(a.due, 17, api.tz);
  if (a.estimate_minutes !== undefined) patch.estimate_minutes = a.estimate_minutes === null ? null : Math.max(0, Math.round(Number(a.estimate_minutes)));
  if (a.review_every !== undefined) patch.review_every = Math.min(999, Math.max(1, Math.round(Number(a.review_every))));
  if (a.review_unit !== undefined) {
    if (!['day', 'week', 'month', 'year'].includes(a.review_unit)) throw new Error('review_unit must be day, week, month or year');
    patch.review_unit = a.review_unit;
  }
  if (a.next_review !== undefined) patch.next_review_at = a.next_review === null ? null : zonedToIso(a.next_review, 0, api.tz);
  if (a.completed_at !== undefined) patch.completed_at = zonedToIso(a.completed_at, 12, api.tz);
  if (a.repeat !== undefined) patch.repeat_rule = repeatRule(a.repeat, api.tz);
  return patch;
}
function projectOut(api, p, folders = []) {
  return {
    id: p.id, name: p.name, status: p.status, kind: p.kind, complete_with_last: p.complete_with_last, flagged: p.flagged,
    notes: p.notes || undefined,
    folder: (folders.find((f) => f.id === p.folder_id) || {}).name || null,
    defer: localDate(p.defer_at, api.tz), planned: localDate(p.planned_at, api.tz), due: localDate(p.due_at, api.tz),
    estimate_minutes: p.estimate_minutes ?? undefined,
    review: { every: p.review_every, unit: p.review_unit, last_reviewed: localDate(p.last_reviewed_at, api.tz), next_review: localDate(p.next_review_at, api.tz) },
    review_every_days: p.review_every_days, last_reviewed: localDate(p.last_reviewed_at, api.tz), next_review: localDate(p.next_review_at, api.tz),
    completed_at: p.completed_at || undefined,
    repeat: p.repeat_rule ? { ...p.repeat_rule, summary: describeRepeat(p.repeat_rule) } : undefined,
    created_at: p.created_at, changed_at: p.updated_at,
  };
}

// ---------- places ----------
function metersBetween(a, b) {
  const R = 6371000; const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const placeOut = (p) => ({ id: p.id, name: p.name, address: p.address || undefined, lat: p.lat, lng: p.lng, radius_m: p.radius_m, notes: p.notes || undefined, archived: !!p.archived_at });
const placeSummary = (loc) => (loc ? { name: loc.place.name, id: loc.place.id, alert: loc.trigger, radius_m: loc.radius, ...(loc.via ? { inherited_from: `${loc.via.kind} ${loc.via.label}` } : {}) } : undefined);

// Address or business → { name, address, lat, lng, google_place_id } via Places Text Search.
export async function geocode(env, text) {
  const key = (env.GOOGLE_SERVER_KEY || '').trim();
  if (!key) return null;
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location' },
    body: JSON.stringify({ textQuery: String(text), maxResultCount: 1 }),
  });
  if (!res.ok) return null;
  const { places } = await res.json();
  const p = places && places[0];
  if (!p || !p.location) return null;
  return { name: (p.displayName && p.displayName.text) || String(text), address: p.formattedAddress || '', lat: p.location.latitude, lng: p.location.longitude, google_place_id: p.id || null };
}

// ---------- responses ----------
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const text = (s, status = 200, headers = {}) => new Response(s, { status, headers: { 'Content-Type': 'text/plain', ...CORS, ...headers } });
