// Todo Tooling MCP server (Cloudflare Worker) at https://mcp.todotooling.com/mcp
//
// Stateless MCP over Streamable HTTP: every JSON-RPC request is a POST that gets
// a single JSON response. Callers authenticate with a personal access token
// (created in the app's Settings) sent as `Authorization: Bearer tt_...`.
// The Worker talks to Supabase with a server-side secret key, so every query
// below is explicitly scoped to the token owner's user_id.

import PostalMime from 'postal-mime';
import { handleGeo, makePlaceResolver, loadPlaceData, decodeSnapshot } from './geo.js';
import { sendDueReminders, sendReviewReminders, sendDailyReminders } from './reminders.js';
import { deliver, sendQueuedTests } from './deliver.js';
import { handleCalendarFetch, calendarEvents } from './calendar.js';
import * as P from '../../js/perspective-engine.js';
import * as OF from '../../js/omnifocus-import.js';
import * as TPL from '../../js/templates.js';
import { splitGain, gainFromText, placeFor } from '../../js/gain.js';
import { gtdTools } from './gtd.js';
import { weeklyTools } from './weekly.js';
import { horizonsTools } from './horizons.js';
import { planTools } from './plan.js';
import { handleCapture, followTag, nameFor } from './capture.js';
import { checklistTools } from './checklists.js';
import { dailyTools } from './daily.js';
import { settleTools } from './settle.js';
import { gainsTools } from './gains.js';
import { fullReviewTools } from './fullreview.js';
import { eventsTools, nextDay } from './events.js';
import { slipboxTools } from './slipbox.js';
import { matrixTools } from './matrix.js';
import { eventOf, ownEventOf, icsCalendar } from '../../js/schedule.js';

const SERVER_INFO = { name: 'todotooling', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Todo Tooling is the user's GTD system. Capture anything new with capture (it lands in the Inbox).
What do I gain?: every action can carry the user's gain (why it's worth doing; a project's gain is its purpose). When capturing, ask what they gain if it isn't obvious and pass it as gain; capture then says which project it fits. Never present your own wording as theirs: drafts go in with gain_suggested (or gains action suggest) and show as "Claude suggested" until kept. Use gains to explain priorities, and gains missing / report to help them drop ideas with no clear payoff.
Clarify inbox items one at a time with clarify_item (next_action, done, delegate, project, someday, tickler, trash, reference), or with update_task: an item leaves the Inbox once it has a project, a tag or a person (waiting_on / agenda_for).
Delegation: delegate (or update_task waiting_on + follow_up) makes an item wait on a person; it is then not a next action. You never send anything: delegate and draft_nudge return a drafted message and mailto/sms link for the user to send. list_waiting shows follow-ups due; add_agenda_item/list_agenda keep what to discuss with someone. People: list_people, save_person.
Tickler: tickle puts an item (or a new reminder) out of sight until a day, then it is back in the Inbox. Reference: search_reference / save_reference hold non-actionable information (codes, warranties); reveal hidden values only when the user asks. Energy (low/medium/high) is set with update_task and filtered with list_tasks max_energy.
Use planned for when the user intends to work on something and due only for hard deadlines; flagged means "important now". Dates are YYYY-MM-DD in the user's timezone; a plain date lands at the user's default time (Settings → Dates).
Never complete, reschedule or re-file tasks the user did not ask you to change.
Notifications: pass notifications (e.g. [{"kind":"before_due","minutes":60}]) to remind the user on their devices; they follow the item's dates.
Attachments: add_attachment attaches text, base64 or a URL's file to an action or project; get_task returns download links; remove_attachment archives.
Repeating items: pass repeat on capture/update_task/create_project/update_project (e.g. {"every":2,"unit":"week","weekdays":[1,4]}); completing one creates the next occurrence automatically; use skip_occurrence to skip one; dropping it ends the series.
Weekly Review: call weekly_review (action start) and walk the user through each step in order (Get clear: papers, mind sweep with mind_sweep_prompts, inbox with clarify_item; Get current: calendars, stale actions, waiting, projects via list_review/mark_reviewed; Get creative: list_someday, anything new), marking each done_step, then finish. Someday/Maybe: clarify_item someday (with a category), list_someday, activate_someday.
Daily review: in the morning call daily_review (briefing), help the user pick up to 3 focus items (action focus), then start; in the evening wrapup, carry what didn't happen, shutdown.
Time blocks: update_task schedule ("YYYY-MM-DDTHH:MM") puts an action on their calendar (Forecast and their calendar feed); check forecast for free time first. Checklists (routines run again and again): list_checklists, save_checklist (attach_to an action), run_checklist to tick through one with them.
Horizons of Focus: list_horizons shows purpose, vision, goals and areas (with balance warnings); save_area, save_goal, save_horizon edit them; projects take outcome ("done looks like"), area and goal. To plan a project with the user (Natural Planning Model), use plan_project: why, done looks like, brainstorm, organize, next actions; show the preview, then create. For "what should I do now?", call what_now (where, minutes, energy) and explain its reasons.
Folders and projects are never deleted: archive a folder with update_folder (only possible once it has no active/on-hold projects) and archive a project by setting its status to completed or dropped.
Templates: for repeated projects (a new job, a trip), list_templates then create_from_template with the blanks' values; save_as_template turns a project into one.
Moving from OmniFocus: import_omnifocus previews first (confirm: true to save); then settle_import walks the sort (status → recommend → apply, each with an Undo); undo_import takes a whole import back.
Slipbox and reading: ideas to think with (not actions) go to the slipbox tool as fleeting notes (one idea, the user's words, [[links]]); things to read/watch/listen to go on the reading list (reading tool; clarify_item/full_review decisions slipbox and reading). When they finish something, offer to take notes. The Weekly Review step "notes" turns fleeting notes into permanent ones.
Events: the user's own calendar entries (an airshow, a trip, an appointment) go in with the events tool (add; several at once with items; pass task to link them to the card they come from); they show in Forecast (by day) and the Events list, and reach their phone through the calendar feed. Not actions: a time block on an action is update_task schedule.
Matrix (Eisenhower): the matrix tool sorts available actions into do / schedule / delegate / park from due dates, flags and goals; the user can override with ★/☆ (mark). Use it when they ask what matters, or to park the neither-urgent-nor-important box in Someday (only what they agree to; unpark undoes).
Full Review (full_review): when the user wants to go through things together, start or resume a session, give them the app link, and work card by card while they watch it in the app. Turn what they tell you into a suggestion (full_review suggest) that they Submit in the app (or, when they say "submit", call full_review submit to press it for them); draft suggestions ahead for the next cards (upcoming + suggest items) so they can approve quickly. Apply directly (annotate/decide) only when they say to just do it. Important items come first; group cards need their agreement on the proposal.
Perspectives are the user's saved views (e.g. Calls, Today): list_perspectives, then run_perspective to see what's in one; to answer "what should I do now" questions, prefer the user's own perspectives. create_perspective/update_perspective build them (preview rules with run_perspective first).
Big tasks: break_down splits a task into steps (in_order for one at a time); steps can have steps, up to 4 levels. get_task shows the steps tree and progress. Move a task under another with update_task parent. If a task grows into a real project, offer convert_to_project.
Waits for: update_task waits_for / add_waits_for links a card to cards in any project it can't start until they're done (e.g. "offer kava" waits for "move Dad"); it stays out of available lists until then and, by default, lands in Forecast today when unblocked. get_task shows waits_for and unblocks. steps_type gives a card with steps a project-style type: parallel, sequential or single_actions (a bucket); complete_with_last false keeps it open after its last step.
Tags can be put on hold (update_tag status on_hold): their actions are parked, not available, until the tag is active again. A task's on_hold field says why it isn't available.
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
    if (url.pathname === '/calendar/fetch') {
      if (!(env.SUPABASE_SECRET_KEY || '').trim()) return json({ error: 'Server not configured' }, 503);
      return handleCalendarFetch(request, env, ctx, { rest: (path, opts) => rest(env, path, opts), json, sha256Hex, cors: CORS });
    }
    if (url.pathname.startsWith('/feed/') && request.method === 'GET') {
      if (!(env.SUPABASE_SECRET_KEY || '').trim()) return text('Server not configured', 503);
      return handleFeed(url, env, ctx);
    }
    if (url.pathname === '/capture') {
      if (!(env.SUPABASE_SECRET_KEY || '').trim()) return json({ error: 'Server not configured' }, 503);
      return handleCapture(request, env, ctx, { rest: (path, opts) => rest(env, path, opts), sha256Hex, json: (b, s) => json(b, s), cors: CORS, makeApi: (uid) => new Api(env, uid) });
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
    api.ctx = ctx;
    await api.loadSettings();
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
      sendReviewReminders(env, r).then((n) => { if (n) console.log('review reminders', n); }).catch((e) => console.log('review cron', e.message)),
      sendDailyReminders(env, r).then((n) => { if (n) console.log('daily reminders', n); }).catch((e) => console.log('daily cron', e.message)),
      r('rpc/run_template_schedules', { method: 'POST', body: {} }).then((n) => { if (n) console.log('scheduled templates', n); }).catch((e) => console.log('templates cron', e.message)),
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

// ---------- the calendar feed: scheduled actions as events (Apple/Google subscribe to it) ----------
async function handleFeed(url, env, ctx) {
  const token = decodeURIComponent(url.pathname.slice('/feed/'.length)).replace(/\.ics$/i, '');
  if (!/^tt_[A-Za-z0-9_-]{20,}$/.test(token)) return text('Not found', 404);
  const [key] = await rest(env, `api_tokens?token_hash=eq.${await sha256Hex(token)}&scope=eq.feed&select=id,user_id`);
  if (!key) return text('This calendar link was reset. Get the new one in Todo Tooling → Settings.', 404);
  ctx.waitUntil(rest(env, `api_tokens?id=eq.${key.id}`, { method: 'PATCH', body: { last_used_at: new Date().toISOString() } }).catch(() => {}));
  const from = new Date(Date.now() - 30 * 86400000).toISOString();
  const to = new Date(Date.now() + 366 * 86400000).toISOString();
  const [tasks, projects, events, settings] = await Promise.all([
    rest(env, `tasks?user_id=eq.${key.user_id}&scheduled_at=gte.${from}&scheduled_at=lte.${to}&dropped_at=is.null&order=scheduled_at.asc&limit=1000&select=id,title,notes,scheduled_at,scheduled_minutes,estimate_minutes,completed_at,project_id,created_at,updated_at`),
    rest(env, `projects?user_id=eq.${key.user_id}&select=id,name`),
    rest(env, `events?user_id=eq.${key.user_id}&archived_at=is.null&starts_at=lte.${to}&ends_at=gte.${from}&order=starts_at.asc&limit=1000&select=*`),
    rest(env, `user_settings?user_id=eq.${key.user_id}&select=timezone`),
  ]);
  const tz = (settings[0] && settings[0].timezone) || env.TIMEZONE || 'America/Chicago';
  const projectName = (id) => (projects.find((p) => p.id === id) || {}).name || null;
  const body = icsCalendar([
    ...tasks.map((t) => eventOf(t, { project: projectName(t.project_id) })),
    ...events.map((ev) => ownEventOf(ev, { project: projectName(ev.project_id), dayKey: (iso) => localDate(iso, tz) })),
  ]);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=300', ...CORS } });
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
  const userId = senders[0].user_id;
  const api = new Api(env, userId);
  await api.loadSettings();
  // BCC or CC to the Inbox (it isn't in the To line) = you've asked someone: Waiting For on them.
  const flat = (list) => (list || []).flatMap((a) => (a && a.group ? a.group : [a])).filter((a) => a && a.address);
  const ours = (a) => /@todotooling\.com$/i.test(a || '');
  const to = flat(parsed.to);
  const recipients = to.filter((a) => !ours(a.address) && a.address.toLowerCase() !== from);
  const waiting = !to.some((a) => ours(a.address)) && recipients.length;
  let row;
  if (waiting) {
    row = await emailToWaiting(api, parsed, from, recipients);
    console.log('email → waiting for', { from, to: recipients[0].address, title: row.title });
  } else {
    const task = emailToTask(parsed, from);
    [row] = await rest(env, 'tasks', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, source: 'email', ...task } });
    console.log('email captured', { from, title: task.title });
  }
  await saveEmailAttachments(api, row.id, parsed);
}

// Attachments on emailed items are saved to the item (up to 25 MB in all; inline images skipped).
async function saveEmailAttachments(api, taskId, parsed) {
  let total = 0;
  for (const a of (parsed.attachments || []).filter((x) => x.disposition !== 'inline' && x.content)) {
    const bytes = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
    if (total + bytes.byteLength > 25 * 1024 * 1024) break;
    total += bytes.byteLength;
    try { await api.upload('task_id', taskId, a.filename || 'attachment', bytes, a.mimeType || 'application/octet-stream'); } catch (e) { console.log('attachment not saved', e.message); }
  }
}

// "Waiting on Jodi Park: Signed change order", follow up in [3d] / a week, Jodi saved as a person.
export async function emailToWaiting(api, parsed, from, recipients) {
  const first = recipients[0];
  const addr = first.address.toLowerCase();
  const people = await api.q(`people?${api.u}&select=*`);
  let person = people.find((p) => (p.email || '').toLowerCase() === addr && !p.archived_at) || people.find((p) => (p.email || '').toLowerCase() === addr);
  if (!person) {
    const name = nameFor(first);
    const same = people.find((p) => !p.archived_at && !p.email && p.name.toLowerCase() === name.toLowerCase());
    if (same) [person] = await api.q(`people?${api.u}&id=eq.${same.id}`, { method: 'PATCH', prefer: 'return=representation', body: { email: addr } });
    else [person] = await api.q('people', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name, email: addr, added_via: 'email' } });
  }
  const base = emailToTask(parsed, from);
  const tagged = followTag(base.title, new Date(), api.tz);
  const days = tagged.days || api.settings.waiting_followup_days || 7;
  const day = localDate(new Date(Date.now() + days * 86400000).toISOString(), api.tz);
  const others = recipients.slice(1).map((a) => nameFor(a));
  const body = gainFromText((parsed.text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()).rest;
  const when = parsed.date ? new Date(parsed.date).toUTCString() : new Date().toUTCString();
  let notes = `Emailed ${person.name} <${addr}> · ${when}${others.length ? `\nAlso to: ${others.join(', ')}` : ''}`;
  if (body) notes += `\n\n${body}`;
  if (notes.length > MAX_NOTES) notes = `${notes.slice(0, MAX_NOTES)}\n…(truncated)`;
  const [row] = await api.q('tasks', { method: 'POST', prefer: 'return=representation', body: {
    user_id: api.userId, title: (tagged.subject || base.title).slice(0, 300), notes, gain: base.gain || '', source: 'email', in_inbox: false,
    waiting_on: person.id, delegated_at: new Date().toISOString(), follow_up_at: zonedToIso(day, 9, api.tz) } });
  return row;
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
  // "Gain: …" on its own line in the body (or "Idea → gain" in the subject) is the item's gain.
  const raw = (parsed.text || htmlToText(parsed.html || '')).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const { gain: bodyGain, rest: body } = gainFromText(raw);
  const split = splitGain((parsed.subject || '').replace(/^(\s*(fwd?|fw|re|aw)\s*:\s*)+/i, '').trim());
  const subject = split.title;
  const gain = bodyGain || split.gain;
  const firstLine = body.split('\n').find((l) => l.trim()) || '';
  const title = (subject || firstLine || 'Emailed item').slice(0, 300);
  const when = parsed.date ? new Date(parsed.date).toUTCString() : new Date().toUTCString();
  const attachments = (parsed.attachments || []).filter((a) => a.disposition !== 'inline').map((a) => a.filename).filter(Boolean);
  let notes = `Emailed by ${from} · ${when}`;
  if (attachments.length) notes += `\nAttachments: ${attachments.join(', ')}`;
  if (body) notes += `\n\n${body}`;
  if (notes.length > MAX_NOTES) notes = `${notes.slice(0, MAX_NOTES)}\n…(truncated)`;
  return { title, notes, ...(gain ? { gain } : {}) };
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
// The API returns at most 1,000 rows a request, so a read without its own limit is fetched a page at a
// time, in a stable order (the table's key breaks ties), until a short page.
const PAGE = 1000;
const TIE = { task_tags: 'task_id.asc,tag_id.asc', project_tags: 'project_id.asc,tag_id.asc', task_waits: 'task_id.asc,waits_for.asc', user_settings: 'user_id.asc' };
async function rest(env, path, opts = {}) {
  if ((opts.method || 'GET') !== 'GET' || path.startsWith('rpc/') || /[?&]limit=/.test(path)) return rest1(env, path, opts);
  const tie = TIE[path.split('?')[0]] || 'id.asc';
  const ordered = /[?&]order=/.test(path) ? path.replace(/([?&]order=[^&]*)/, `$1,${tie}`) : `${path}${path.includes('?') ? '&' : '?'}order=${tie}`;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await rest1(env, `${ordered}&limit=${PAGE}&offset=${offset}`, opts);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}
async function rest1(env, path, { method = 'GET', body, prefer } = {}) {
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
// A read by a long id list, 150 ids a request, so the address stays short (a big steps tree has hundreds).
async function byIds(ids, read) {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...await read(ids.slice(i, i + 150)));
  return out;
}
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
  const guess = Date.UTC(y, m - 1, d, 0, Math.round(hour * 60));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asIfUtc - guess)).toISOString();
}
// "2026-09-24T10:30" in the user's zone.
function localTime(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
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
    this.hours = { due: 17, planned: 9, defer: 0 }; // Settings → Dates (loadSettings)
    this.settings = {};
  }
  // The account's settings: time zone, the times plain dates land at, the Forecast tag.
  async loadSettings() {
    try {
      const [s] = await this.q(`user_settings?${this.u}&select=*`);
      if (!s) return;
      this.settings = s;
      if (s.timezone) this.tz = s.timezone;
      this.hours = { due: (s.due_minutes ?? 1020) / 60, planned: (s.planned_minutes ?? 540) / 60, defer: (s.defer_minutes ?? 0) / 60 };
    } catch { /* defaults */ }
  }
  // Reads are shared within one call (the same list asked for twice, e.g. every tag link for availability
  // and again for display, costs one set of requests; a Worker gets 50 a call). Any write clears them.
  // Everything the rules need, in one request (rpc/mcp_snapshot): open tasks (sent as a table, each
  // column name once), tags, tag links, projects, people, places and waits-for links. Shared by the call.
  snapshot() {
    this.snap ||= rest1(this.env, 'rpc/mcp_snapshot', { method: 'POST', body: { owner: this.userId } }).then((s) => decodeSnapshot(s, this.userId));
    this.snap.catch(() => { this.snap = null; });
    return this.snap;
  }
  // Place and tag data for just these tasks: them, the tasks they're steps of (up to 4 levels), their
  // tag links, and the small lists (tags, projects, project tags, places). Direct reads, not the snapshot.
  async placeDataFor(tasks) {
    const d = (path) => this.q(path, { direct: true });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    let need = [...new Set(tasks.map((t) => t.parent_id).filter((x) => x && !byId.has(x)))];
    for (let i = 0; i < 4 && need.length; i++) {
      const up = await byIds(need, (part) => d(`tasks?${this.u}&id=${inList(part)}&select=*`));
      up.forEach((t) => byId.set(t.id, t));
      need = [...new Set(up.map((t) => t.parent_id).filter((x) => x && !byId.has(x)))];
    }
    const all = [...byId.values()];
    const [taskTags, tags, projects, projectTags, places] = await Promise.all([
      byIds(all.map((t) => t.id), (part) => d(`task_tags?${this.u}&task_id=${inList(part)}&select=task_id,tag_id`)),
      d(`tags?${this.u}&select=*`), d(`projects?${this.u}&select=*`), d(`project_tags?${this.u}&select=project_id,tag_id`), d(`places?${this.u}&select=*`),
    ]);
    return { tasks: all, taskTags, tags, projects, projectTags, places };
  }
  // Available open task ids, decided by the database (rpc/available_task_ids, the same rules as the app).
  // All of them (shared by the call) or just those in ids. A read, so it doesn't clear the call's cache.
  availableSet(ids = null) {
    const ask = (body) => rest1(this.env, 'rpc/available_task_ids', { method: 'POST', body }).then((x) => new Set(x || []));
    if (ids && ids.length <= 2000) return ask({ owner: this.userId, only_ids: ids });
    this.avail ||= ask({ owner: this.userId });
    this.avail.catch(() => { this.avail = null; });
    return this.avail;
  }
  // The whole-library reads the tools make, answered from the snapshot instead of 20-odd paged requests.
  fromSnapshot(path) {
    const u = this.u;
    const map = {
      [`tasks?${u}&${OPEN}&select=*`]: (s) => s.tasks,
      [`tags?${u}&select=*`]: (s) => s.tags,
      [`task_tags?${u}&select=task_id,tag_id`]: (s) => s.task_tags,
      [`project_tags?${u}&select=project_id,tag_id`]: (s) => s.project_tags,
      [`projects?${u}&select=*`]: (s) => s.projects,
      [`places?${u}&select=*`]: (s) => s.places,
      [`task_waits?${u}&select=task_id,waits_for`]: (s) => s.task_waits,
      [`people?${u}&select=*`]: (s) => s.people,
      [`people?${u}&select=id,name`]: (s) => s.people,
      [`people?${u}&archived_at=is.null&select=id,name,tag_id,archived_at`]: (s) => s.people.filter((p) => !p.archived_at),
    };
    return map[path] || null;
  }
  q(path, opts) {
    const read = !opts || (opts.method || 'GET') === 'GET';
    if (!read) { this.reads = null; this.snap = null; this.avail = null; return rest(this.env, path, opts); }
    const pick = opts && opts.direct ? null : this.fromSnapshot(path); // direct: a small read, shared but not from the snapshot
    if (pick) return this.snapshot().then((s) => pick(s).slice());
    this.reads ||= new Map();
    if (!this.reads.has(path)) {
      const p = rest(this.env, path, opts);
      this.reads.set(path, p);
      p.catch(() => { if (this.reads) this.reads.delete(path); });
    }
    return this.reads.get(path).then((rows) => (Array.isArray(rows) ? rows.slice() : rows));
  }

  async lookups() {
    const [projects, tags, people] = await Promise.all([
      this.q(`projects?${this.u}&select=id,name,status,folder_id`),
      this.q(`tags?${this.u}&select=id,name,parent_id,status`),
      this.q(`people?${this.u}&select=id,name,email,phone,tag_id,archived_at`),
    ]);
    const tagLabel = (t) => {
      const p = t.parent_id && tags.find((x) => x.id === t.parent_id);
      return p ? `${p.name} : ${t.name}` : t.name;
    };
    return { projects, tags, tagLabel, people };
  }

  // A person by id or name (live people first). create: make one for a new name.
  async resolvePerson(ref, { create = false, email, phone, archived = false } = {}) {
    const r = String(ref || '').trim();
    if (!r) throw new Error('person is required');
    const people = await this.q(`people?${this.u}&select=*`);
    const live = people.filter((p) => archived || !p.archived_at);
    const hit = live.find((p) => p.id === r) || live.find((p) => p.name.toLowerCase() === r.toLowerCase()) || live.find((p) => p.name.toLowerCase().split(/\s+/)[0] === r.toLowerCase());
    if (hit) {
      const fill = Object.fromEntries(Object.entries({ email, phone }).filter(([k, v]) => v && !hit[k]));
      if (Object.keys(fill).length) Object.assign(hit, (await this.q(`people?${this.u}&id=eq.${hit.id}`, { method: 'PATCH', prefer: 'return=representation', body: fill }))[0]);
      return hit;
    }
    if (!create) throw new Error(`No person called "${r}". Use list_people or save_person.`);
    // An existing "Waiting : Name" tag becomes theirs, so items with it count as waiting on them.
    const tags = await this.q(`tags?${this.u}&select=id,name,parent_id`);
    const tag = tags.find((g) => g.parent_id && g.name.toLowerCase() === r.toLowerCase() && /waiting/i.test((tags.find((x) => x.id === g.parent_id) || {}).name || ''));
    const [row] = await this.q('people', { method: 'POST', prefer: 'return=representation', body: { user_id: this.userId, name: r, email: email || null, phone: phone || null, tag_id: tag ? tag.id : null } });
    return row;
  }

  // Project outcome, area and goal (Horizons of Focus), by name or id.
  async horizonsPatch(a) {
    const patch = {};
    if (a.outcome !== undefined) patch.outcome = String(a.outcome || '').trim();
    if (a.mac_folder !== undefined) patch.folder_path = String(a.mac_folder || '').trim().slice(0, 500) || null;
    if (a.gain !== undefined) { patch.purpose = String(a.gain || '').trim().slice(0, 2000); patch.purpose_by = a.gain_suggested ? 'agent' : null; }
    const pick = async (table, key, ref) => {
      if (ref === null || ref === '') return null;
      const rows = await this.q(`${table}?${this.u}&select=id,${key}`);
      const r = String(ref).trim().toLowerCase();
      const hit = rows.find((x) => x.id === ref) || rows.find((x) => String(x[key]).toLowerCase() === r);
      if (!hit) throw new Error(`No ${table === 'areas' ? 'area' : 'goal'} "${ref}". Use save_${table === 'areas' ? 'area' : 'goal'} first.`);
      return hit.id;
    };
    if (a.area !== undefined) patch.area_id = await pick('areas', 'name', a.area);
    if (a.goal !== undefined) patch.goal_id = await pick('goals', 'title', a.goal);
    return patch;
  }

  // Waiting on someone (delegated, a person's tag, or on an agenda): the shared rule (js/perspective-engine.js).
  async waitingRule() {
    const [people, taskTags] = await Promise.all([this.q(`people?${this.u}&archived_at=is.null&select=*`), this.q(`task_tags?${this.u}&select=task_id,tag_id`)]);
    const fn = P.makeWaiting({ people, taskTags });
    return { people, isWaiting: fn, personFor: fn.personFor };
  }

  async shape(tasks) {
    if (!tasks.length) return [];
    // The snapshot if this call already has it; otherwise only what these rows need (a few small reads).
    const placeData = this.snap ? await loadPlaceData((path) => this.q(path), this.userId) : await this.placeDataFor(tasks);
    const known = new Set(placeData.tasks.map((t) => t.id));
    placeData.tasks.push(...tasks.filter((t) => !known.has(t.id))); // closed tasks too
    const placeOf = makePlaceResolver(placeData);
    // The place data already holds every tag, project and tag link: reuse them (a Worker gets 50 requests a call).
    const ids = tasks.map((t) => t.id);
    const d = (path) => this.q(path, this.snap ? undefined : { direct: true }); // small direct reads unless the snapshot is here
    const [reminders, files, people, waits] = await Promise.all([
      this.notificationsFor('task_id', ids),
      byIds(ids, (part) => this.q(`attachments?${this.u}&task_id=${inList(part)}&archived_at=is.null&order=created_at.asc&select=id,task_id,name,size,mime`)),
      d(`people?${this.u}&select=id,name`),
      this.snap ? this.q(`task_waits?${this.u}&select=task_id,waits_for`)
        : byIds(ids, (part) => this.q(`task_waits?${this.u}&or=(task_id.${inList(part)},waits_for.${inList(part)})&select=task_id,waits_for`, { direct: true })),
    ]);
    const card = new Map(placeData.tasks.map((x) => [x.id, x]));
    const linked = [...new Set(waits.flatMap((w) => [w.task_id, w.waits_for]))].filter((x) => !card.has(x));
    if (linked.length) (await byIds(linked, (part) => this.q(`tasks?${this.u}&id=${inList(part)}&select=id,title,completed_at,dropped_at`, { direct: true }))).forEach((x) => card.set(x.id, x));
    const openCard = (x) => x && !x.completed_at && !x.dropped_at;
    const { projects, tags } = placeData;
    const tagLabel = (t) => { const p = t.parent_id && tags.find((x) => x.id === t.parent_id); return p ? `${p.name} : ${t.name}` : t.name; };
    const wanted = new Set(ids);
    const links = placeData.taskTags.filter((l) => wanted.has(l.task_id));
    const pLinks = placeData.projectTags;
    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes || undefined,
      project: (projects.find((p) => p.id === t.project_id) || {}).name || null,
      project_id: t.project_id,
      tags: links.filter((l) => l.task_id === t.id).map((l) => tags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel),
      on_hold: (() => { const own = [...links.filter((l) => l.task_id === t.id), ...pLinks.filter((l) => l.project_id === t.project_id)].map((l) => tags.find((x) => x.id === l.tag_id)).filter(Boolean);
        const held = own.find((g) => { let h = false; for (let x = g, i = 0; x && i < 8; i++) { if (x.status === 'dropped') return false; if (x.status === 'on_hold') h = true; x = tags.find((y) => y.id === x.parent_id); } return h; });
        return !t.completed_at && !t.dropped_at && held ? `Not available: tag “${tagLabel(held)}” is on hold` : undefined; })(),
      project_tags: pLinks.filter((l) => l.project_id === t.project_id).map((l) => tags.find((x) => x.id === l.tag_id)).filter(Boolean).map(tagLabel),
      estimate_minutes: t.estimate_minutes ?? undefined,
      energy: t.energy || undefined,
      mac_folder: t.folder_path || undefined,
      waiting_on: t.waiting_on ? ((people.find((p) => p.id === t.waiting_on) || {}).name || 'someone') : undefined,
      delegated: t.waiting_on ? localDate(t.delegated_at, this.tz) : undefined,
      follow_up: t.waiting_on ? localDate(t.follow_up_at, this.tz) : undefined,
      agenda_for: t.agenda_for ? ((people.find((p) => p.id === t.agenda_for) || {}).name || 'someone') : undefined,
      tickler: t.tickler && !t.completed_at && !t.dropped_at ? (t.defer_at && t.defer_at > new Date().toISOString() ? `back in the Inbox on ${localDate(t.defer_at, this.tz)}` : 'back from the tickler') : undefined,
      reference_id: t.reference_id || undefined,
      scheduled: t.scheduled_at ? { at: localTime(t.scheduled_at, this.tz), minutes: t.scheduled_minutes || 30 } : undefined,
      checklist_id: t.checklist_id || undefined,
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
      gain: t.gain || undefined,
      gain_cost: t.gain_cost || undefined,
      gain_suggested: t.gain_by === 'agent' || undefined,
      gain_met: t.gain_met || undefined,
      parent_id: t.parent_id || undefined,
      steps_in_order: t.steps_in_order || undefined,
      steps_type: t.steps_single ? 'single_actions' : t.steps_in_order ? 'sequential' : undefined,
      complete_with_last: t.complete_with_last === false ? false : undefined,
      waits_for: (() => { const w = waits.filter((x) => x.task_id === t.id); return w.length ? w.map((x) => { const c = card.get(x.waits_for); return { id: x.waits_for, title: c ? c.title : undefined, done: !openCard(c) }; }) : undefined; })(),
      on_unblock: waits.some((x) => x.task_id === t.id) && t.on_unblock === 'none' ? 'none' : undefined,
      unblocks: (() => { const u = waits.filter((x) => x.waits_for === t.id).map((x) => card.get(x.task_id)).filter(openCard); return u.length ? u.map((c) => ({ id: c.id, title: c.title })) : undefined; })(),
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
    const rows = await byIds(ids, (part) => this.q(`notifications?${this.u}&${col}=${inList(part)}&order=fire_at.asc&select=*`));
    const out = {};
    rows.forEach((n) => { (out[n[col]] = out[n[col]] || []).push({ kind: n.kind, minutes: n.kind === 'before_due' || n.kind === 'before_planned' ? n.offset_minutes : undefined, at: n.at || undefined, fires_at: n.fire_at, sent: !!n.sent_at }); });
    return out;
  }

  async setNotifications(col, id, list) {
    const rows = list.map((n) => {
      if (!['before_due', 'before_planned', 'at_defer', 'at'].includes(n.kind)) throw new Error('notification kind must be before_due, before_planned, at_defer or at');
      const row = { user_id: this.userId, [col]: id, kind: n.kind, offset_minutes: Math.min(525600, Math.max(0, Math.round(Number(n.minutes) || 0))), at: null }; // every row the same keys: one insert
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

// Mirror of the app's js/availability.js. available = open, not deferred (nor any ancestor),
// project active and not deferred, no open steps of its own, and not waiting its turn in an
// ordered container (a sequential project, or a task with steps_in_order) at any level up the tree.
// known: the set of available ids from the database (api.availableSet); when given it decides availability
// and this only supplies the tree walk for nextFor. The JS rules stay as the reference (tests, parity).
export function availabilityOf(tasks, projects, nowIso = new Date().toISOString(), onHold = () => false, known = null) {
  const isOpenT = (t) => !t.completed_at && !t.dropped_at;
  const byIdT = new Map(tasks.map((t) => [t.id, t]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const sortT = (a, b) => ((a.sort || 0) - (b.sort || 0)) || (a.created_at < b.created_at ? -1 : 1);
  const kidsOf = new Map();
  tasks.filter(isOpenT).forEach((t) => { const k = t.parent_id || `p:${t.project_id}`; if (!kidsOf.has(k)) kidsOf.set(k, []); kidsOf.get(k).push(t); });
  kidsOf.forEach((list) => list.sort(sortT));
  const firstOpen = (key) => (kidsOf.get(key) || []).filter((t) => key.startsWith('p:') ? !t.parent_id : true)[0];
  const deferred = (t) => t.defer_at && t.defer_at > nowIso;
  const waiting = (t) => {
    let node = t;
    for (let i = 0; i < 10 && node; i++) {
      const parent = node.parent_id && byIdT.get(node.parent_id);
      if (parent) {
        if (deferred(parent)) return true;
        if (parent.steps_in_order) { const f = firstOpen(parent.id); if (f && f.id !== node.id) return true; }
        node = parent;
      } else {
        const p = node.project_id && projectById.get(node.project_id);
        if (p && p.kind === 'sequential') { const f = firstOpen(`p:${p.id}`); if (f && f.id !== node.id) return true; }
        return false;
      }
    }
    return false;
  };
  const available = known ? (t) => known.has(t.id) : (t) => {
    if (!isOpenT(t) || deferred(t)) return false;
    const p = t.project_id && projectById.get(t.project_id);
    if (p && (p.status !== 'active' || (p.defer_at && p.defer_at > nowIso))) return false; // deferred project hides its actions
    if ((kidsOf.get(t.id) || []).length) return false; // has open steps: do the steps
    if (onHold(t)) return false; // parked by an on-hold tag
    return !waiting(t);
  };
  const nextFor = (projectId) => {
    const walk = (list) => {
      for (const t of list) {
        if (available(t)) return t;
        const hit = walk(kidsOf.get(t.id) || []);
        if (hit) return hit;
      }
      return null;
    };
    return walk((kidsOf.get(`p:${projectId}`) || []).filter((t) => !t.parent_id));
  };
  return { available, nextFor };
}

// Not the user's to do now: parked by an on-hold tag, or waiting on someone / on an agenda.
// (shared rules: js/perspective-engine.js makeOnHold and makeWaiting)
// Waits for another card that's still open (its own links, or those of a card it's a step of; a card not
// in the data counts as done), and "single actions" buckets, which are lists, never actions.
const cardWaitsOf = (data) => {
  const w = new Map(); (data.taskWaits || []).forEach((x) => { if (!w.has(x.task_id)) w.set(x.task_id, []); w.get(x.task_id).push(x.waits_for); });
  if (!w.size) return () => false;
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const open = (id) => { const t = byId.get(id); return !!t && !t.completed_at && !t.dropped_at; };
  return (t) => { for (let n = t, i = 0; n && i < 8; i++) { if ((w.get(n.id) || []).some(open)) return true; n = n.parent_id && byId.get(n.parent_id); } return false; };
};
export const parkedOf = (data) => {
  const hold = P.makeOnHold(data); const wait = P.makeWaiting(data); const cards = cardWaitsOf(data);
  return (t) => hold(t) || wait(t) || cards(t) || (data.buckets ? data.buckets.has(t.id) : !!t.steps_single);
};
async function holdFor(api, tasks) {
  const [tags, taskTags, projectTags, people, taskWaits] = await Promise.all([
    api.q(`tags?${api.u}&select=*`),
    api.q(`task_tags?${api.u}&select=task_id,tag_id`),
    api.q(`project_tags?${api.u}&select=project_id,tag_id`),
    api.q(`people?${api.u}&archived_at=is.null&select=id,name,tag_id,archived_at`),
    api.q(`task_waits?${api.u}&select=task_id,waits_for`),
  ]);
  return parkedOf({ tasks, tags, taskTags, projectTags, people, taskWaits });
}

// A task with its steps as a nested tree (progress counted over the smallest steps, the leaves) and the
// tasks it is part of (part_of, nearest first). One query for the whole family and one shape pass, so a
// big tree stays well inside the Worker's 50 requests.
async function taskWithTree(api, id) {
  const family = await api.q('rpc/task_family', { method: 'POST', body: { task_id: mustUuid(id, 'id'), owner: api.userId } });
  const byId = new Map(family.map((t) => [t.id, t]));
  const task = family.find((t) => t.id.toLowerCase() === String(id).toLowerCase());
  if (!task) throw new Error('Task not found');
  const kidsOf = new Map();
  family.forEach((t) => { if (t.parent_id) { if (!kidsOf.has(t.parent_id)) kidsOf.set(t.parent_id, []); kidsOf.get(t.parent_id).push(t); } });
  const kids = (pid) => (kidsOf.get(pid) || []).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const all = [];
  const collect = (pid, d) => { if (d < 8) kids(pid).forEach((t) => { all.push(t); collect(t.id, d + 1); }); };
  collect(task.id, 0);
  const shaped = new Map((await api.shape([task, ...all])).map((x) => [x.id, x]));
  const out = shaped.get(task.id);
  if (all.length) {
    const build = (pid) => kids(pid).map((t) => { const x = shaped.get(t.id); const k = build(t.id); if (k.length) x.steps = k; return x; });
    const leaves = all.filter((t) => !kidsOf.has(t.id) && (!t.dropped_at || t.completed_at));
    Object.assign(out, { steps: build(task.id), progress: { done: leaves.filter((t) => t.completed_at).length, total: leaves.length } });
  }
  const up = [];
  for (let p = byId.get(task.parent_id); p && up.length < 6; p = byId.get(p.parent_id)) up.push({ id: p.id, title: p.title });
  if (up.length) out.part_of = up;
  return out;
}


// ---------- perspectives (shared engine: js/perspective-engine.js) ----------
const RULES_DOC = 'Rules: {"match":"all"|"any"|"none","rules":[...]} where each rule is a group of the same shape or one of: {"type":"flagged"|"inbox"|"available"|"overdue"|"repeating"|"has_notes"|"has_gain"|"has_steps"|"is_step"|"untagged"|"no_project"|"has_place"|"has_estimate"}, {"type":"tag","tags":["Phone","Waiting : Hiro"],"sub":true}, {"type":"project","projects":["Click Plumbing"]}, {"type":"folder","folders":["Work"]}, {"type":"date","field":"due"|"planned"|"defer"|"completed"|"added"|"changed","when":"overdue"|"today"|"next"|"past"|"before"|"after"|"any"|"none","days":7,"date":"YYYY-MM-DD"}, {"type":"duration","op":"max"|"min","minutes":15}, {"type":"text","contains":"words"}. Tags, projects and folders may be given by name or id.';
const OPTIONS_DOC = 'Display: {"show":"available"|"remaining"|"completed"|"dropped"|"all","group_by":"project"|"folder"|"tag"|"due"|"flagged"|"none","sort_by":"project"|"due"|"planned"|"defer"|"added"|"changed"|"completed"|"duration"|"title","layout":"tree"|"flat"}';

async function perspectiveData(api, needClosed) {
  const [open, closed, projects, folders, tags, taskTags, projectTags, people, taskWaits] = await Promise.all([
    api.q(`tasks?${api.u}&${OPEN}&select=*`),
    needClosed ? api.q(`tasks?${api.u}&or=(completed_at.not.is.null,dropped_at.not.is.null)&order=updated_at.desc&limit=500&select=*`) : [],
    api.q(`projects?${api.u}&select=*`),
    api.q(`folders?${api.u}&select=*`),
    api.q(`tags?${api.u}&select=*`),
    api.q(`task_tags?${api.u}&select=task_id,tag_id`),
    api.q(`project_tags?${api.u}&select=project_id,tag_id`),
    api.q(`people?${api.u}&archived_at=is.null&select=id,name,tag_id,archived_at`),
    api.q(`task_waits?${api.u}&select=task_id,waits_for`),
  ]);
  const ids = new Set(open.map((t) => t.id));
  return { tasks: [...open, ...closed.filter((t) => !ids.has(t.id))], open, projects, folders, tags, taskTags, projectTags, people, taskWaits };
}
const needsClosed = (x) => ['completed', 'dropped', 'all'].includes((x.options || {}).show) || JSON.stringify(x.rules || {}).includes('"completed"');

// Names → ids in tag/project/folder rules (agents speak in names). Unknown names are errors.
function resolveRuleNames(rules, data) {
  const tagLabel = (t) => { const p = t.parent_id && data.tags.find((x) => x.id === t.parent_id); return p ? `${p.name} : ${t.name}` : t.name; };
  const find = (list, key, label) => (ref) => {
    const r = String(ref).trim();
    const hit = list.find((x) => x.id === r) || list.find((x) => label(x).toLowerCase() === r.toLowerCase()) || list.find((x) => x.name.toLowerCase() === r.toLowerCase());
    if (!hit) throw new Error(`No ${key} called “${r}”`);
    return hit.id;
  };
  const tag = find(data.tags, 'tag', tagLabel);
  const project = find(data.projects, 'project', (x) => x.name);
  const folder = find(data.folders, 'folder', (x) => x.name);
  const walk = (r) => {
    if (!r || typeof r !== 'object') return r;
    if (Array.isArray(r.rules)) return { match: r.match || 'all', rules: r.rules.map(walk), ...(r.v ? { v: r.v } : {}) };
    const out = { ...r };
    if (r.type === 'tag') out.tags = (r.tags || []).map(tag);
    if (r.type === 'project') out.projects = (r.projects || []).map(project);
    if (r.type === 'folder') out.folders = (r.folders || []).map(folder);
    return out;
  };
  return { v: 1, ...walk(rules) };
}

async function findPerspective(api, ref) {
  const all = await api.q(`perspectives?${api.u}&select=*`);
  const r = String(ref || '').trim().toLowerCase();
  const hit = all.find((p) => p.id === ref) || all.find((p) => !p.archived_at && p.name.toLowerCase() === r) || all.find((p) => p.name.toLowerCase() === r);
  if (!hit) throw new Error(`No perspective called “${ref}”. Use list_perspectives.`);
  return hit;
}

function perspectiveOut(p, data) {
  return { id: p.id, name: p.name, icon: p.icon, summary: P.describe(p, data), rules: p.rules, options: { ...P.DEFAULT_OPTIONS, ...(p.options || {}) }, badge: p.badge, pinned: p.pinned !== false, archived: !!p.archived_at };
}


// ---------- project templates (shared: js/templates.js; creating is the database's create_from_template) ----------
async function findTemplate(api, ref) {
  const all = await api.q(`project_templates?${api.u}&select=*`);
  const r = String(ref || '').trim().toLowerCase();
  const hit = all.find((t) => t.id === ref) || all.find((t) => !t.archived_at && t.name.toLowerCase() === r) || all.find((t) => t.name.toLowerCase() === r);
  if (!hit) throw new Error(`No template called “${ref}”. Use list_templates.`);
  return hit;
}
const templateOut = (t) => ({
  id: t.id, name: t.name, icon: t.icon, actions: TPL.countActions(t.body), blanks: TPL.blanksOf(t.body).map((b) => b.name),
  dates_count_from: t.body.anchor === 'due' ? 'due date' : 'start', kind: t.body.kind || 'parallel',
  schedule: t.schedule ? TPL.describeSchedule(t.schedule) : null, next_run_at: t.next_run_at || undefined, archived: !!t.archived_at,
});
const TEMPLATE_BODY_DOC = 'body = {name (may contain «Blank» words), notes, kind: parallel|sequential|single_actions, review_every, review_unit, anchor: start|due, project_due (days), blanks: [{name, default}], actions: [{title, notes, flagged, estimate_minutes, defer, planned, due (whole days from the start, negative = before; with anchor due they count from the due date), steps_in_order, steps: [...] (4 levels)}]}. «Date», «Month» and «Year» fill themselves.';

// ---------- tools ----------
const TOOLS = [
  {
    name: 'capture',
    description: 'Add a new item. With just a title it lands in the Inbox to clarify later; you can also set project, tags, parent (make it a step of a task), flag, due/defer dates and notes in the same call (it then skips the Inbox). To split a task into several steps at once, use break_down.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "What it is, in the user's words" },
        notes: { type: 'string' },
        gain: { type: 'string', description: 'What doing it gains the user, in their words (one or two sentences). Ask for it; never invent it as theirs — use gain_suggested for your own draft' },
        gain_suggested: { type: 'boolean', description: 'true when the gain is your suggestion (the app shows "Claude suggested" until the user keeps or edits it)' },
        gain_cost: { type: 'string', description: 'Optional: what it costs the user not to do it' },
        project: { type: 'string', description: 'Project name or id' },
        parent: { type: 'string', description: 'Id of an open task to make this a step of (it joins that task\'s project; steps go 4 levels deep)' },
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
        energy: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Energy it takes' },
        waiting_on: { type: 'string', description: 'Person it is delegated to (name or id; new names become people)' },
        follow_up: { type: 'string', description: 'YYYY-MM-DD to follow up (with waiting_on; default a week)' },
        agenda_for: { type: 'string', description: 'Person to discuss it with (their Agenda)' },
        schedule: { type: 'string', description: 'Time block "YYYY-MM-DDTHH:MM" (user\'s time zone)' },
        schedule_minutes: { type: 'integer' },
        checklist: { type: 'string', description: 'Checklist name or id to attach' },
      },
      required: ['title'],
    },
    async run(api, { title, notes = '', ...rest }) {
      if (!title || !String(title).trim()) throw new Error('title is required');
      // Into a project: append at the end (order matters in sequential projects).
      const body = { user_id: api.userId, title: String(title).trim(), notes, source: 'mcp' };
      if (rest.gain) { body.gain = String(rest.gain).trim().slice(0, 500); body.gain_by = rest.gain_suggested ? 'agent' : null; }
      if (rest.gain_cost) body.gain_cost = String(rest.gain_cost).trim().slice(0, 500);
      if (rest.project) {
        body.project_id = await api.resolveProject(rest.project);
        const sib = await api.q(`tasks?${api.u}&project_id=eq.${body.project_id}&parent_id=is.null&select=sort&order=sort.desc&limit=1`);
        body.sort = sib.length ? (sib[0].sort || 0) + 1 : 0;
      }
      const [row] = await api.q('tasks', { method: 'POST', prefer: 'return=representation', body });
      const fields = Object.fromEntries(Object.entries(rest).filter(([k, v]) => ['project', 'parent', 'steps_in_order', 'tags', 'flagged', 'due', 'planned', 'defer', 'estimate_minutes', 'place', 'location_alert', 'location_radius_m', 'repeat', 'notifications', 'energy', 'waiting_on', 'follow_up', 'agenda_for', 'schedule', 'schedule_minutes', 'checklist'].includes(k) && v !== undefined));
      if (!Object.keys(fields).length) {
        // An Inbox capture: where its gain (or title) points, for the user to decide.
        const [projects, goals, areas] = await Promise.all([api.q(`projects?${api.u}&status=eq.active&select=id,name,status,purpose,outcome,goal_id,area_id`), api.q(`goals?${api.u}&status=eq.active&select=id,title,why,status`), api.q(`areas?${api.u}&archived_at=is.null&select=id,name,standards,archived_at`)]);
        const fits = placeFor(row, { projects, goals, areas });
        return { ...(await api.shape([row]))[0], ...(fits.length ? { fits: fits.map((f) => ({ project: f.project.name, project_id: f.project.id, via: f.via === 'project' ? undefined : `${f.via}: ${f.viaName}`, matched: f.word })), next: 'Offer to move it to the project that fits (update_task project), or leave it in the Inbox.' } : {}) };
      }
      return TOOLS.find((t) => t.name === 'update_task').run(api, { id: row.id, ...fields });
    },
  },
  {
    name: 'list_inbox',
    description: 'List open Inbox items (captured but not yet clarified), oldest first. Items waiting in the tickler are left out until their day (list_tickler).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 100 } } },
    async run(api, { limit = 100 }) {
      const now = new Date().toISOString();
      const rows = await api.q(`tasks?${api.u}&${OPEN}&in_inbox=is.true&parent_id=is.null&or=(tickler.is.false,defer_at.is.null,defer_at.lte.${now})&order=created_at.asc&limit=${Math.min(+limit || 100, 500)}&select=*`);
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
        available_only: { type: 'boolean', description: 'Only actions that can be done now (not deferred, not waiting in a sequential project, not delegated or on an agenda, project active). This is the Next Actions list.' },
        max_energy: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Only actions marked with at most this energy ("I\'m tired": low)' },
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
      if (a.max_energy) f.push(`energy=in.(${['low', 'medium', 'high'].slice(0, ['low', 'medium', 'high'].indexOf(a.max_energy) + 1).join(',')})`);
      if (a.due_before) f.push(`due_at=lt.${zonedToIso(a.due_before, 24, api.tz)}`);
      if (a.project) f.push(`project_id=eq.${await api.resolveProject(a.project)}`);
      if (a.search) {
        const words = String(a.search).toLowerCase().replace(/[%,()*\\]/g, ' ').split(/\s+/).filter(Boolean);
        if (words.length) {
          const { projects, tags, tagLabel } = await api.lookups();
          const links = await api.q(`task_tags?${api.u}&select=task_id,tag_id`);
          for (const w of words) {
            const e = encodeURIComponent(w);
            const conds = [`title.ilike.*${e}*`, `notes.ilike.*${e}*`, `gain.ilike.*${e}*`, `completion_note.ilike.*${e}*`];
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
        const ok = await api.availableSet(rows.map((t) => t.id)); // the database decides, for just these rows
        rows = rows.filter((t) => ok.has(t.id));
      }
      return { count: rows.length, items: await api.shape(rows) };
    },
  },
  {
    name: 'forecast',
    description: 'Day-by-day view of what is due, planned, or becoming available (deferred until that day), plus past-due and past-planned items, calendar events from the user\'s calendars (events, per day; times are ISO), and (today_tag) the actions with the user\'s "always show in Today" tag. Use for "what is coming up this week" and daily planning.',
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
      // Waiting For follow-ups due today or earlier (someone else's move; check in).
      const follow = await api.q(`tasks?${api.u}&${OPEN}&waiting_on=not.is.null&follow_up_at=lt.${zonedToIso(today, 24, api.tz)}&order=follow_up_at.asc&select=*`);
      if (follow.length) out.follow_ups = await api.shape(follow);
      // Settings → Dates → "Always show in Today": that tag's open, available-now actions.
      const ftag = api.settings.forecast_tag_id;
      if (ftag) {
        const [tags, links] = await Promise.all([api.q(`tags?${api.u}&select=*`), api.q(`task_tags?${api.u}&select=task_id,tag_id`)]);
        const ids = new Set([ftag, ...tags.filter((g) => g.parent_id === ftag).map((g) => g.id)]);
        const taggedIds = [...new Set(links.filter((l) => ids.has(l.tag_id)).map((l) => l.task_id))];
        const nowIso = new Date().toISOString();
        const tagged = taggedIds.length ? (await api.q(`tasks?${api.u}&${OPEN}&id=${inList(taggedIds)}&select=*`)).filter((t) => !t.defer_at || t.defer_at <= nowIso) : [];
        const t0 = tags.find((g) => g.id === ftag);
        out.today_tag = { tag: t0 ? t0.name : null, items: await api.shape(tagged) };
      }
      for (let i = 0; i < days; i++) {
        const d = localDate(new Date(Date.parse(start) + i * 86400000 + 12 * 3600000).toISOString(), api.tz);
        out.days[d] = { scheduled: [], due: [], planned: [], becomes_available: [], projects: [] };
      }
      projects.forEach((p) => {
        const due = localDate(p.due_at, api.tz); const planned = localDate(p.planned_at, api.tz);
        const row = { id: p.id, name: p.name, due, planned };
        if (due && due < today) out.past.overdue_projects.push(row);
        [due, planned].filter((d, i, a) => d && a.indexOf(d) === i).forEach((d) => { if (out.days[d]) out.days[d].projects.push(row); });
      });
      // Calendar events (Settings → Calendars), per day, alongside the tasks.
      try {
        const lastDay = Object.keys(out.days).pop();
        const { events, errors } = await calendarEvents(api, today, lastDay, api.ctx, { sha256Hex });
        events.forEach((e) => e.days.forEach((d) => { if (out.days[d]) (out.days[d].events = out.days[d].events || []).push({ title: e.title, start: e.allDay ? undefined : e.start, end: e.allDay ? undefined : e.end, all_day: e.allDay || undefined, location: e.location || undefined, calendar: e.calendar }); }));
        if (errors.length) out.calendar_errors = errors;
      } catch { out.calendar_errors = [{ error: 'Calendars unavailable right now.' }]; }
      // The user's own events (the events tool, Forecast → + Event), on each day they cover.
      const own = await api.q(`events?${api.u}&archived_at=is.null&starts_at=lt.${encodeURIComponent(end)}&ends_at=gt.${encodeURIComponent(start)}&order=starts_at.asc&limit=500&select=*`);
      const cardIds = [...new Set(own.map((e) => e.task_id).filter(Boolean))];
      const cards = cardIds.length ? await api.q(`tasks?${api.u}&id=${inList(cardIds)}&select=id,title`) : [];
      own.forEach((e) => {
        const last = localDate(new Date(Math.max(Date.parse(e.starts_at), Date.parse(e.ends_at) - 1)).toISOString(), api.tz);
        for (let d = localDate(e.starts_at, api.tz), i = 0; d <= last && i < 62; i++, d = nextDay(d)) {
          if (out.days[d]) (out.days[d].events = out.days[d].events || []).push({ id: e.id, title: e.title, start: e.all_day ? undefined : e.starts_at, end: e.all_day ? undefined : e.ends_at, all_day: e.all_day || undefined, location: e.location || undefined, url: e.url || undefined, calendar: 'Todo Tooling', own: true, card: (cards.find((c) => c.id === e.task_id) || {}).title || undefined });
        }
      });
      items.forEach((t) => {
        if (t.due && t.due < today) out.past.overdue.push(t);
        else if (t.planned && t.planned < today && !(t.due && t.due < today)) out.past.planned_earlier.push(t);
        if (out.days[t.due]) out.days[t.due].due.push(t);
        if (t.scheduled && out.days[t.scheduled.at.slice(0, 10)]) out.days[t.scheduled.at.slice(0, 10)].scheduled.push(t);
        else if (out.days[t.planned] && t.planned !== t.due) out.days[t.planned].planned.push(t);
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
        api.q(`tasks?${api.u}&${OPEN}&select=*`),
        api.q(`folders?${api.u}&select=id,name`),
      ]);
      const due = projects.filter((p) => include_not_due || (p.next_review_at && p.next_review_at <= nowIso));
      const { nextFor } = availabilityOf(open, projects, nowIso, undefined, await api.availableSet());
      const todayStart = zonedToIso(localDate(nowIso, api.tz), 0, api.tz);
      const out = [];
      // Completions in the last 30 days for these projects, in one read (not one per project).
      const shown = due.slice(0, 50);
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const recent = shown.length ? await api.q(`tasks?${api.u}&completed_at=gte.${since30}&project_id=${inList(shown.map((p) => p.id))}&select=project_id,completed_at`) : [];
      const lastDone = new Map(); recent.forEach((t) => { if (!lastDone.has(t.project_id) || t.completed_at > lastDone.get(t.project_id)) lastDone.set(t.project_id, t.completed_at); });
      for (const p of shown) {
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
          if (!lastDone.has(p.id)) hints.push('Nothing completed in the last 30 days.');
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
        api.q(`projects?${api.u}&select=*`),
      ]);
      const flaggedProjects = new Set(projects.filter((p) => p.flagged).map((p) => p.id));
      const { available } = availabilityOf(open, projects, undefined, undefined, await api.availableSet());
      const rows = open.filter((t) => (t.flagged || flaggedProjects.has(t.project_id)) && (!available_only || available(t)));
      const items = await api.shape(rows);
      const byProject = {};
      items.forEach((t) => { const k = t.project || 'No project'; (byProject[k] = byProject[k] || []).push(t); });
      return { count: items.length, by_project: byProject };
    },
  },
  {
    name: 'get_task',
    description: 'Get one task with its notes, project, tags, dates, repeat, notifications, attachments (with download links valid for an hour), the tasks it is part of (part_of, nearest first) and its steps as a nested tree with progress (done/total over the smallest steps).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(api, { id }) {
      const shaped = await taskWithTree(api, id);
      if (shaped.attachments) shaped.attachments = await api.withLinks('task_id', shaped.id);
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
        parent: { type: ['string', 'null'], description: 'Id of an open task to make this a step of (it and its own steps move into that task\'s project; max 4 levels, no loops); null to make it stand on its own' },
        steps_in_order: { type: 'boolean', description: 'Do this task\'s steps in order: only the first open step is available' },
        steps_type: { type: 'string', enum: ['parallel', 'sequential', 'single_actions'], description: 'How its steps work, like a project type: parallel (all available), sequential (one at a time) or single_actions (a bucket of separate actions; the card itself is never an action and never completes on its own)' },
        complete_with_last: { type: 'boolean', description: 'Finishing the last step completes this card (default true). false: it stays open to check off yourself' },
        waits_for: { type: 'array', items: { type: 'string' }, description: 'Ids of cards (any project) this one waits for; replaces the list ([] clears). It isn\'t available until all of them are completed or dropped. No loops, and not its own steps or parent' },
        add_waits_for: { type: 'array', items: { type: 'string' }, description: 'Ids of cards to add to what it waits for' },
        remove_waits_for: { type: 'array', items: { type: 'string' }, description: 'Ids of cards it should stop waiting for' },
        on_unblock: { type: 'string', enum: ['forecast', 'none'], description: 'When the last card it waits for is done: forecast (default) plans it for today; none just makes it available' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags. Labels like "Laptop" or "Waiting : Hiro"; missing tags are created.' },
        add_tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add, keeping existing ones' },
        remove_tags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
        mac_folder: { type: ['string', 'null'], description: 'A folder on the user\'s Mac for its files (support material), e.g. "~/_SYNC/MAGA/_Todo/Bookmarks cleanup"; the app\'s 📂 button opens it. null to clear' },
        flagged: { type: 'boolean' },
        planned: { type: ['string', 'null'], description: 'YYYY-MM-DD when the user intends to work on it (9am local), or null. Prefer this over due for intentions.' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD hard deadline only (due 5pm local), or null' },
        defer: { type: ['string', 'null'], description: 'YYYY-MM-DD (hidden until then) or null' },
        status: { type: 'string', enum: ['open', 'completed', 'dropped'], description: 'Only change when the user says so' },
        completion_note: { type: 'string' },
        gain: { type: 'string', description: 'What doing it gains the user, in their words (one or two sentences). Ask for it; never invent it as theirs — use gain_suggested for your own draft' },
        gain_suggested: { type: 'boolean', description: 'true when the gain is your suggestion (the app shows "Claude suggested" until the user keeps or edits it)' },
        gain_cost: { type: 'string', description: 'What it costs the user not to do it' },
        gain_met: { type: ['string', 'null'], enum: ['yes', 'partly', 'no', null], description: 'After completing: did the user get the gain?' },
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
        energy: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null], description: 'Energy it takes; null to clear' },
        waiting_on: { type: ['string', 'null'], description: 'Delegated to this person (name or id; new names become people); null takes it back. Use delegate to also draft the request.' },
        follow_up: { type: ['string', 'null'], description: 'YYYY-MM-DD to follow up on a waiting item' },
        agenda_for: { type: ['string', 'null'], description: 'Something to discuss with this person (their Agenda); null to remove' },
        tickle: { type: ['string', 'null'], description: 'YYYY-MM-DD: out of sight until that day, then back in the Inbox (tickler); null takes it out of the tickler' },
        schedule: { type: ['string', 'null'], description: 'Time block: "YYYY-MM-DDTHH:MM" in the user\'s time zone (shows in Forecast and their calendar feed; also sets planned); null unschedules' },
        schedule_minutes: { type: 'integer', description: 'Length of the time block (default: the estimate, else 30)' },
        checklist: { type: ['string', 'null'], description: 'Attach a checklist (name or id); null removes it' },
      },
      required: ['id'],
    },
    async run(api, a) {
      const task = await api.task(a.id);
      const patch = {};
      if (a.title !== undefined) patch.title = String(a.title).trim();
      if (a.notes !== undefined) patch.notes = a.notes;
      if (a.flagged !== undefined) patch.flagged = !!a.flagged;
      if (a.steps_in_order !== undefined) patch.steps_in_order = !!a.steps_in_order;
      if (a.steps_type !== undefined) { patch.steps_in_order = a.steps_type === 'sequential'; patch.steps_single = a.steps_type === 'single_actions'; }
      if (a.complete_with_last !== undefined) patch.complete_with_last = !!a.complete_with_last;
      if (a.on_unblock !== undefined) patch.on_unblock = a.on_unblock === 'none' ? 'none' : 'forecast';
      if (a.due !== undefined) patch.due_at = zonedToIso(a.due, api.hours.due, api.tz);
      if (a.planned !== undefined) patch.planned_at = zonedToIso(a.planned, api.hours.planned, api.tz);
      if (a.defer !== undefined) patch.defer_at = zonedToIso(a.defer, api.hours.defer, api.tz);
      if (a.project !== undefined) patch.project_id = await api.resolveProject(a.project);
      if (a.completion_note !== undefined) patch.completion_note = String(a.completion_note).trim();
      if (a.gain !== undefined) { patch.gain = String(a.gain || '').trim().slice(0, 500); patch.gain_by = a.gain_suggested ? 'agent' : null; }
      if (a.gain_cost !== undefined) patch.gain_cost = String(a.gain_cost || '').trim().slice(0, 500);
      if (a.gain_met !== undefined) patch.gain_met = a.gain_met || null;
      if (a.estimate_minutes !== undefined) patch.estimate_minutes = a.estimate_minutes === null ? null : Math.max(0, Math.round(Number(a.estimate_minutes)));
      Object.assign(patch, await api.locationPatch(a));
      if (a.repeat !== undefined) patch.repeat_rule = repeatRule(a.repeat, api.tz, task.repeat_rule);
      if (a.schedule !== undefined) {
        if (a.schedule === null || a.schedule === '') Object.assign(patch, { scheduled_at: null, scheduled_minutes: null });
        else {
          const m = String(a.schedule).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
          if (!m) throw new Error('schedule must be "YYYY-MM-DDTHH:MM"');
          const at = zonedToIso(m[1], Number(m[2]) + Number(m[3]) / 60, api.tz);
          Object.assign(patch, { scheduled_at: at, planned_at: at, scheduled_minutes: Math.min(720, Math.max(5, Math.round(Number(a.schedule_minutes || task.scheduled_minutes || task.estimate_minutes || 30)))) });
        }
      } else if (a.schedule_minutes !== undefined && task.scheduled_at) patch.scheduled_minutes = Math.min(720, Math.max(5, Math.round(Number(a.schedule_minutes))));
      if (a.checklist !== undefined) {
        if (a.checklist === null || a.checklist === '') patch.checklist_id = null;
        else { const all = await api.q(`checklists?${api.u}&archived_at=is.null&select=id,name`); const hit = all.find((c) => c.id === a.checklist) || all.find((c) => c.name.toLowerCase() === String(a.checklist).toLowerCase()); if (!hit) throw new Error(`No checklist called “${a.checklist}”`); patch.checklist_id = hit.id; }
      }
      if (a.energy !== undefined) { if (a.energy !== null && !['low', 'medium', 'high'].includes(a.energy)) throw new Error('energy must be low, medium or high'); patch.energy = a.energy; }
      if (a.mac_folder !== undefined) patch.folder_path = String(a.mac_folder || '').trim().slice(0, 500) || null;
      if (a.waiting_on !== undefined) {
        patch.waiting_on = a.waiting_on === null || a.waiting_on === '' ? null : (await api.resolvePerson(a.waiting_on, { create: true })).id;
        if (patch.waiting_on && patch.waiting_on !== task.waiting_on) { patch.delegated_at = new Date().toISOString(); if (a.follow_up === undefined && !task.follow_up_at) a.follow_up = localDate(new Date(Date.now() + 7 * 86400000).toISOString(), api.tz); }
        if (patch.waiting_on) patch.tickler = false;
      }
      if (a.follow_up !== undefined) patch.follow_up_at = zonedToIso(a.follow_up, 9, api.tz);
      if (a.agenda_for !== undefined) patch.agenda_for = a.agenda_for === null || a.agenda_for === '' ? null : (await api.resolvePerson(a.agenda_for, { create: true })).id;
      if (a.tickle !== undefined) {
        if (a.tickle) { Object.assign(patch, { tickler: true, defer_at: zonedToIso(a.tickle, 6, api.tz), project_id: null, parent_id: null }); a.project = undefined; a.parent = undefined; }
        else if (task.tickler) Object.assign(patch, { tickler: false, ...(task.defer_at && task.defer_at > new Date().toISOString() ? { defer_at: null } : {}) });
      } else if (task.tickler && (a.project || a.parent || (a.tags && a.tags.length) || (a.add_tags && a.add_tags.length) || patch.waiting_on || patch.agenda_for)) patch.tickler = false; // clarified
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
          if (parent.completed_at || parent.dropped_at) throw new Error('Parent must be an open task');
          patch.parent_id = parent.id; // the database checks loops and depth and sets the project
          delete patch.project_id;
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
      const eff = (k) => (k in patch ? patch[k] : task[k]);
      patch.in_inbox = !!eff('tickler') || !(eff('project_id') || parentId || tagCount || eff('waiting_on') || eff('agenda_for'));
      await api.q(`tasks?${api.u}&id=eq.${task.id}`, { method: 'PATCH', body: patch });
      if (Array.isArray(a.waits_for) || Array.isArray(a.add_waits_for) || Array.isArray(a.remove_waits_for)) {
        const have = (await api.q(`task_waits?${api.u}&task_id=eq.${task.id}&select=waits_for`)).map((w) => w.waits_for);
        const want = new Set(Array.isArray(a.waits_for) ? a.waits_for.map((x) => mustUuid(x, 'waits_for')) : have);
        (a.add_waits_for || []).forEach((x) => want.add(mustUuid(x, 'add_waits_for')));
        (a.remove_waits_for || []).forEach((x) => want.delete(mustUuid(x, 'remove_waits_for')));
        const drop = have.filter((x) => !want.has(x)); const add = [...want].filter((x) => !have.includes(x));
        if (drop.length) await api.q(`task_waits?${api.u}&task_id=eq.${task.id}&waits_for=in.(${drop.join(',')})`, { method: 'DELETE' });
        if (add.length) await api.q('task_waits', { method: 'POST', body: add.map((w) => ({ task_id: task.id, waits_for: w, user_id: api.userId })) });
      }
      if (Array.isArray(a.notifications)) await api.setNotifications('task_id', task.id, a.notifications);
      if (a.skip_occurrence) {
        if (!(patch.repeat_rule || task.repeat_rule)) throw new Error('skip_occurrence needs a repeating action');
        await api.q('rpc/repeat_skip', { method: 'POST', body: { task_id: task.id, owner: api.userId } });
      }
      if (a.move) {
        const now = await api.task(task.id); // after a move under another task, its project may have changed
        const sibs = await api.q(`tasks?${api.u}&${OPEN}&project_id=${now.project_id ? `eq.${now.project_id}` : 'is.null'}&parent_id=${now.parent_id ? `eq.${now.parent_id}` : 'is.null'}&select=id,sort,created_at`);
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
    description: 'Mark a task complete (or pass completed:false to reopen it). Only do this when the user says it is done. Optionally record a completion note. Rules: completing a task with steps also completes its open steps; completing the last step completes the task (at every level); a project set to complete-with-last-action completes when its last action does.',
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
    name: 'break_down',
    description: 'Break a big task into smaller steps ("eat the elephant"). Adds the steps, in order, after any it already has; they live in the task\'s project. in_order: true makes only the first open step available. Steps can have steps (up to 4 levels). Completing the last step completes the task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task to break down' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Step titles, first to last' },
        in_order: { type: 'boolean', description: 'Do the steps in order (only the next one is available)' },
      },
      required: ['id', 'steps'],
    },
    async run(api, { id, steps = [], in_order }) {
      const task = await api.task(id);
      if (task.completed_at || task.dropped_at) throw new Error('Only open tasks can be broken down');
      const titles = (Array.isArray(steps) ? steps : []).map((x) => String(x || '').trim()).filter(Boolean);
      if (!titles.length && in_order === undefined) throw new Error('steps is required');
      const sibs = await api.q(`tasks?${api.u}&parent_id=eq.${task.id}&select=sort`);
      const base = Math.max(-1, ...sibs.map((x) => x.sort || 0)) + 1;
      if (titles.length) {
        await api.q('tasks', { method: 'POST', body: titles.map((title, i) => ({ user_id: api.userId, title, parent_id: task.id, project_id: task.project_id, in_inbox: false, sort: base + i, source: 'mcp' })) });
      }
      if (in_order !== undefined) await api.q(`tasks?${api.u}&id=eq.${task.id}`, { method: 'PATCH', body: { steps_in_order: !!in_order } });
      return taskWithTree(api, task.id);
    },
  },
  {
    name: 'convert_to_project',
    description: 'Turn a task that has grown too big into a project: its steps become the project\'s actions (with their own steps), in the same folder, sequential if its steps were in order; its tags become project tags. The task is dropped with a note pointing at the new project (nothing is deleted). Ask the user first.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(api, { id }) {
      const task = await api.task(id);
      const pid = await api.q('rpc/convert_to_project', { method: 'POST', body: { task_id: task.id, owner: api.userId } });
      const projectId = Array.isArray(pid) ? pid[0] : pid;
      const [p] = await api.q(`projects?${api.u}&id=eq.${mustUuid(projectId, 'project')}&select=*`);
      const actions = await api.q(`tasks?${api.u}&project_id=eq.${p.id}&parent_id=is.null&order=sort.asc&select=*`);
      const folders = await api.q(`folders?${api.u}&select=id,name`);
      return { ...projectOut(api, p, folders), actions: await api.shape(actions) };
    },
  },
  {
    name: 'list_perspectives',
    description: 'List the user\'s perspectives (saved views built from rules), in their order, with a plain-English summary and how many open items each shows now. Use run_perspective to see the items.',
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean', default: false } } },
    async run(api, { include_archived = false }) {
      const all = (await api.q(`perspectives?${api.u}&order=sort.asc&select=*`)).filter((p) => include_archived || !p.archived_at).sort((x, y) => (x.sort - y.sort) || x.name.localeCompare(y.name));
      const data = await perspectiveData(api, all.some(needsClosed));
      const { available } = availabilityOf(data.open, data.projects, undefined, undefined, await api.availableSet());
      return all.map((p) => ({ ...perspectiveOut(p, data), open_count: P.evaluate(p, data, { tz: api.tz, available }).tasks.filter((t) => !t.completed_at && !t.dropped_at).length }));
    },
  },
  {
    name: 'run_perspective',
    description: `Show what a perspective contains right now, grouped and sorted the way it is set up. Pass a saved perspective (name or id), or pass rules/options to preview an unsaved one (e.g. to try rules before create_perspective). ${RULES_DOC} ${OPTIONS_DOC}`,
    inputSchema: {
      type: 'object',
      properties: {
        perspective: { type: 'string', description: 'Name or id of a saved perspective' },
        rules: { type: 'object', description: 'Preview these rules instead of a saved perspective' },
        options: { type: 'object', description: 'Display options for a preview' },
        limit: { type: 'integer', default: 100, description: 'Max items returned (the count is always complete)' },
      },
    },
    async run(api, a) {
      let p;
      if (a.perspective) p = await findPerspective(api, a.perspective);
      else if (a.rules) p = { name: 'Preview', rules: a.rules, options: a.options || {} };
      else throw new Error('Pass perspective (name or id), or rules to preview');
      const data = await perspectiveData(api, needsClosed(p));
      if (!a.perspective) {
        p.rules = resolveRuleNames(p.rules, data);
        const errors = P.validate({ rules: p.rules, options: p.options });
        if (errors.length) throw new Error(errors.join('; '));
      }
      const { available } = availabilityOf(data.open, data.projects, undefined, undefined, await api.availableSet());
      const r = P.evaluate(p, data, { tz: api.tz, available });
      const limit = Math.min(Math.max(1, +a.limit || 100), 500);
      const picked = new Set(r.tasks.slice(0, limit).map((t) => t.id));
      const shaped = new Map((await api.shape(r.tasks.filter((t) => picked.has(t.id)))).map((x) => [x.id, x]));
      const byId = new Map(data.tasks.map((t) => [t.id, t]));
      const withContext = (t) => { const x = shaped.get(t.id); if (x && t.parent_id && byId.get(t.parent_id)) x.part_of = byId.get(t.parent_id).title; return x; };
      return {
        ...(p.id ? perspectiveOut(p, data) : { name: 'Preview', summary: P.describe(p, data), rules: p.rules, options: r.options }),
        count: r.tasks.length,
        open_count: r.tasks.filter((t) => !t.completed_at && !t.dropped_at).length,
        groups: r.groups.map((g) => ({ label: g.label || null, count: g.tasks.length, items: g.tasks.filter((t) => picked.has(t.id)).map(withContext).filter(Boolean) })).filter((g) => g.items.length || g.count),
        warnings: r.warnings.length ? r.warnings : undefined,
        truncated: r.tasks.length > limit || undefined,
      };
    },
  },
  {
    name: 'create_perspective',
    description: `Save a new perspective. Start from a template (calls, quick, today, due, waiting, stalled) and/or give rules and options. Preview with run_perspective first when unsure. ${RULES_DOC} ${OPTIONS_DOC}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        icon: { type: 'string', description: 'One emoji' },
        template: { type: 'string', enum: ['calls', 'quick', 'today', 'due', 'waiting', 'stalled', 'blank'] },
        rules: { type: 'object' },
        options: { type: 'object' },
        badge: { type: 'boolean', description: 'Show its count in the sidebar' },
        pinned: { type: 'boolean', description: 'Pinned in the sidebar\'s Do group (default true); unpinned ones are under Perspectives' },
      },
    },
    async run(api, a) {
      const data = await perspectiveData(api, false);
      const base = a.template ? P.instantiate(P.TEMPLATES.find((t) => t.key === a.template) || P.TEMPLATES[P.TEMPLATES.length - 1], data.tags) : { name: 'New perspective', icon: '🔭', rules: { v: 1, match: 'all', rules: [] }, options: { ...P.DEFAULT_OPTIONS } };
      const rules = a.rules ? resolveRuleNames(a.rules, data) : base.rules;
      const options = { ...P.DEFAULT_OPTIONS, ...base.options, ...(a.options || {}) };
      const errors = P.validate({ rules, options });
      if (errors.length) throw new Error(errors.join('; '));
      const name = String(a.name || base.name).trim();
      const existing = await api.q(`perspectives?${api.u}&select=sort,name,archived_at`);
      if (existing.some((x) => !x.archived_at && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`A perspective called “${name}” already exists; use update_perspective`);
      const sort = Math.max(-1, ...existing.map((x) => x.sort || 0)) + 1;
      const [row] = await api.q('perspectives', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name, icon: a.icon || base.icon, rules, options, badge: !!a.badge, pinned: a.pinned !== false, sort } });
      return perspectiveOut(row, data);
    },
  },
  {
    name: 'update_perspective',
    description: `Change a perspective: rename, new icon, replace its rules or options (options merge), badge, move up/down, or archive (archived: true; perspectives are never deleted; false restores). ${RULES_DOC} ${OPTIONS_DOC}`,
    inputSchema: {
      type: 'object',
      properties: {
        perspective: { type: 'string', description: 'Name or id' },
        name: { type: 'string' }, icon: { type: 'string' },
        rules: { type: 'object' }, options: { type: 'object' }, badge: { type: 'boolean' }, pinned: { type: 'boolean', description: 'Pinned in the sidebar (Do group)' },
        archived: { type: 'boolean' },
        move: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
      },
      required: ['perspective'],
    },
    async run(api, a) {
      const p = await findPerspective(api, a.perspective);
      const data = await perspectiveData(api, false);
      const patch = {};
      if (a.name !== undefined) patch.name = String(a.name).trim();
      if (a.icon !== undefined) patch.icon = a.icon;
      if (a.badge !== undefined) patch.badge = !!a.badge;
      if (a.pinned !== undefined) patch.pinned = !!a.pinned;
      if (a.rules !== undefined) patch.rules = resolveRuleNames(a.rules, data);
      if (a.options !== undefined) patch.options = { ...P.DEFAULT_OPTIONS, ...(p.options || {}), ...a.options };
      if (a.archived !== undefined) patch.archived_at = a.archived ? new Date().toISOString() : null;
      const errors = P.validate({ rules: patch.rules, options: patch.options });
      if (errors.length) throw new Error(errors.join('; '));
      if (Object.keys(patch).length) await api.q(`perspectives?${api.u}&id=eq.${p.id}`, { method: 'PATCH', body: patch });
      if (a.move) {
        const list = (await api.q(`perspectives?${api.u}&archived_at=is.null&select=id,sort,name`)).sort((x, y) => (x.sort - y.sort) || x.name.localeCompare(y.name));
        const i = list.findIndex((x) => x.id === p.id);
        if (i >= 0) {
          const [me] = list.splice(i, 1);
          list.splice({ up: Math.max(0, i - 1), down: Math.min(list.length, i + 1), top: 0, bottom: list.length }[a.move], 0, me);
          await Promise.all(list.map((x, sort) => (x.sort === sort ? null : api.q(`perspectives?${api.u}&id=eq.${x.id}`, { method: 'PATCH', body: { sort } }))));
        }
      }
      const [row] = await api.q(`perspectives?${api.u}&id=eq.${p.id}&select=*`);
      return perspectiveOut(row, data);
    },
  },
  {
    name: 'import_omnifocus',
    description: 'Import the user\'s OmniFocus library. data is what OmniFocus produced: the JSON from the Todo Tooling OmniFocus script (best: folders, review schedules, repeats), or a TaskPaper or CSV export. Without confirm it only previews (counts, merges, skips, warnings; nothing saved). Show the preview to the user and only call again with confirm: true when they agree. Importing twice never duplicates; undo_import takes an import back.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'The OmniFocus script JSON, TaskPaper text or CSV text' },
        completed: { type: 'string', enum: ['none', '30', '90', 'all'], default: 'none', description: 'Which completed/dropped items come along: none, the last 30 or 90 days, or all' },
        confirm: { type: 'boolean', default: false, description: 'true = actually import (after the user saw the preview)' },
      },
      required: ['data'],
    },
    async run(api, { data, completed = 'none', confirm = false }) {
      const parsed = OF.parse(String(data || ''), { tz: api.tz, hours: api.hours });
      const prepared = OF.prepare(parsed, { completed });
      const parts = OF.chunks(prepared.payload);
      const results = [];
      let batch = null;
      for (const part of parts) {
        const r = await api.q('rpc/import_omnifocus', { method: 'POST', body: { payload: part, dry_run: !confirm, owner: api.userId, ...(batch ? { batch } : {}) } });
        if (confirm) batch = batch || r.import_id;
        results.push(r);
      }
      const counts = OF.sumCounts(results, { dryRun: !confirm });
      return {
        format: parsed.format, saved: !!confirm, import_id: confirm ? counts.import_id : undefined,
        counts, summary: prepared.summary, warnings: prepared.warnings,
        sample: OF.sampleTree(prepared.payload).map((l) => `${'  '.repeat(l.depth)}${l.text}${l.meta ? ` (${l.meta})` : ''}`),
        next: confirm ? 'Imported. Next, offer Settle in (settle_import): sort old actions, big projects, overdue dates and flags in bulk, each with an Undo. The whole import can be undone with undo_import.' : 'Nothing saved yet. Show this preview; call again with confirm: true to import.',
      };
    },
  },
  {
    name: 'undo_import',
    description: 'Take back an OmniFocus import: its open actions and projects are dropped and its new folders archived (nothing is deleted); a later import brings them in again. Without import_id, lists recent imports. Ask the user first.',
    inputSchema: { type: 'object', properties: { import_id: { type: 'string' } } },
    async run(api, { import_id }) {
      if (!import_id) {
        const rows = await api.q(`imports?${api.u}&order=created_at.desc&limit=20&select=id,source,counts,created_at,undone_at`);
        return rows.filter((r) => (r.counts.tasks || 0) + (r.counts.projects || 0) > 0).map((r) => ({ id: r.id, source: r.source, at: r.created_at, projects: r.counts.projects || 0, actions: r.counts.tasks || 0, undone: !!r.undone_at }));
      }
      return api.q('rpc/undo_import', { method: 'POST', body: { batch: mustUuid(import_id, 'import_id'), owner: api.userId } });
    },
  },
  {
    name: 'list_templates',
    description: 'List the user\'s project templates (reusable project outlines), with how many actions, the blanks to fill in, whether dates count from the start or the due date, and any schedule.',
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean', default: false } } },
    async run(api, { include_archived = false }) {
      const rows = await api.q(`project_templates?${api.u}&select=*`);
      return rows.filter((t) => include_archived || !t.archived_at).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name)).map(templateOut);
    },
  },
  {
    name: 'create_from_template',
    description: 'Start a new project from a template: every action, step, tag and duration comes along, blanks («Client») are filled with values, and dates are placed relative to date (the start date, or the due date for templates that count back from a deadline). Use list_templates to see the blanks.',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template name or id' },
        date: { type: 'string', description: 'YYYY-MM-DD the start (or due) date; default today' },
        values: { type: 'object', description: 'Blank values, e.g. {"Client": "Smith"}' },
        name: { type: 'string', description: 'Override the project name' },
        folder: { type: 'string', description: 'Folder name (default: the template\'s folder)' },
      },
      required: ['template'],
    },
    async run(api, a) {
      const t = await findTemplate(api, a.template);
      if (t.archived_at) throw new Error('That template is archived; restore it first with update_template.');
      if (a.date && !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw new Error('date: YYYY-MM-DD');
      const folder = a.folder ? await api.resolveFolder(a.folder) : null;
      const vars = Object.fromEntries(Object.entries(a.values || {}).map(([k, v]) => [k, String(v ?? '')]));
      const pid = await api.q('rpc/create_from_template', { method: 'POST', body: { template: t.id, anchor: a.date || null, vars, name: a.name || null, folder, tz: api.tz, owner: api.userId } });
      const projectId = Array.isArray(pid) ? pid[0] : pid;
      const [p] = await api.q(`projects?${api.u}&id=eq.${mustUuid(projectId, 'project')}&select=*`);
      const actions = await api.q(`tasks?${api.u}&project_id=eq.${p.id}&parent_id=is.null&order=sort.asc&select=*`);
      const folders = await api.q(`folders?${api.u}&select=id,name`);
      const missing = TPL.blanksOf(t.body).filter((b) => !vars[b.name] && !b.default).map((b) => b.name);
      return { ...projectOut(api, p, folders), from_template: t.name, actions: await api.shape(actions), blanks_left_empty: missing.length ? missing : undefined };
    },
  },
  {
    name: 'save_as_template',
    description: 'Save an existing project as a template: its open actions, steps, tags, durations and notes, with dates turned into days from the project\'s start (or due date). blanks turn specific text into fill-in words, e.g. [{"find": "Jones", "name": "Client"}].',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id' },
        name: { type: 'string', description: 'Template name (default: the project name)' },
        dates_count_from: { type: 'string', enum: ['start', 'due'], default: 'start' },
        blanks: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, name: { type: 'string' } }, required: ['find', 'name'] } },
      },
      required: ['project'],
    },
    async run(api, a) {
      const projectId = await api.resolveProject(a.project);
      const [[project], tasks, projectTags, taskTags] = await Promise.all([
        api.q(`projects?${api.u}&id=eq.${projectId}&select=*`),
        api.q(`tasks?${api.u}&project_id=eq.${projectId}&select=*`),
        api.q(`project_tags?${api.u}&project_id=eq.${projectId}&select=project_id,tag_id`),
        api.q(`task_tags?${api.u}&select=task_id,tag_id`),
      ]);
      const { body } = TPL.bodyFromProject({ project, tasks, projectTags, taskTags }, { anchor: a.dates_count_from === 'due' ? 'due' : 'start', blanks: a.blanks || [], tz: api.tz });
      const existing = await api.q(`project_templates?${api.u}&select=sort`);
      const [row] = await api.q('project_templates', { method: 'POST', prefer: 'return=representation', body: { user_id: api.userId, name: String(a.name || project.name).trim(), folder_id: project.folder_id || null, body, sort: Math.max(-1, ...existing.map((x) => x.sort || 0)) + 1 } });
      return templateOut(row);
    },
  },
  {
    name: 'update_template',
    description: `Change a template: rename, replace its body, set a schedule (creates a project automatically, e.g. {"every":1,"unit":"month","start":"2026-11-01"}; null stops it), or archive/restore (templates are never deleted). ${TEMPLATE_BODY_DOC}`,
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template name or id' },
        name: { type: 'string' }, icon: { type: 'string' },
        body: { type: 'object' },
        schedule: { type: ['object', 'null'], properties: { every: { type: 'integer' }, unit: { type: 'string', enum: ['day', 'week', 'month', 'year'] }, start: { type: 'string' } } },
        archived: { type: 'boolean' },
      },
      required: ['template'],
    },
    async run(api, a) {
      const t = await findTemplate(api, a.template);
      const patch = {};
      if (a.name !== undefined) patch.name = String(a.name).trim();
      if (a.icon !== undefined) patch.icon = a.icon;
      if (a.body !== undefined) {
        const errors = TPL.validateBody(a.body);
        if (errors.length) throw new Error(errors.join('; '));
        patch.body = { ...a.body, blanks: TPL.blanksOf(a.body) };
      }
      if (a.schedule !== undefined) {
        if (a.schedule && (!['day', 'week', 'month', 'year'].includes(a.schedule.unit) || (a.schedule.start && !/^\d{4}-\d{2}-\d{2}$/.test(a.schedule.start)))) throw new Error('schedule: {every, unit: day|week|month|year, start: YYYY-MM-DD}');
        patch.schedule = a.schedule ? { every: Math.max(1, Math.round(a.schedule.every || 1)), unit: a.schedule.unit, start: a.schedule.start || undefined, tz: api.tz } : null;
      }
      if (a.archived !== undefined) patch.archived_at = a.archived ? new Date().toISOString() : null;
      if (Object.keys(patch).length) await api.q(`project_templates?${api.u}&id=eq.${t.id}`, { method: 'PATCH', body: patch });
      const [row] = await api.q(`project_templates?${api.u}&id=eq.${t.id}&select=*`);
      return templateOut(row);
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
        api.q(`tasks?${api.u}&${OPEN}&select=*`),
      ]);
      const { nextFor } = availabilityOf(open, projects, undefined, undefined, await api.availableSet());
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
        outcome: { type: 'string', description: 'What done looks like, e.g. "Final inspection passed, paid in full"' },
        mac_folder: { type: ['string', 'null'], description: 'A folder on the user\'s Mac for its files (support material), e.g. "~/_SYNC/MAGA/_Todo/Bookmarks cleanup"; the app\'s 📂 button opens it. null to clear' },
        gain: { type: 'string', description: 'What doing it gains the user, in their words (one or two sentences). Ask for it; never invent it as theirs — use gain_suggested for your own draft' },
        gain_suggested: { type: 'boolean', description: 'true when the gain is your suggestion (the app shows "Claude suggested" until the user keeps or edits it)' },
        area: { type: ['string', 'null'], description: 'Area of focus (name or id); null to remove' },
        goal: { type: ['string', 'null'], description: 'Goal it serves (title or id); null to remove' },
      },
      required: ['name'],
    },
    async run(api, { name, folder, notes = '', kind = 'parallel', complete_with_last = false, ...more }) {
      const folder_id = folder ? await api.resolveFolder(folder) : null;
      const body = { user_id: api.userId, name: String(name).trim(), notes, folder_id, kind, complete_with_last: !!complete_with_last, ...(await api.locationPatch(more)), ...projectPatch(api, more), ...(await api.horizonsPatch(more)) };
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
        outcome: { type: 'string', description: 'What done looks like, e.g. "Final inspection passed, paid in full"' },
        mac_folder: { type: ['string', 'null'], description: 'A folder on the user\'s Mac for its files (support material), e.g. "~/_SYNC/MAGA/_Todo/Bookmarks cleanup"; the app\'s 📂 button opens it. null to clear' },
        gain: { type: 'string', description: 'What doing it gains the user, in their words (one or two sentences). Ask for it; never invent it as theirs — use gain_suggested for your own draft' },
        gain_suggested: { type: 'boolean', description: 'true when the gain is your suggestion (the app shows "Claude suggested" until the user keeps or edits it)' },
        area: { type: ['string', 'null'], description: 'Area of focus (name or id); null to remove' },
        goal: { type: ['string', 'null'], description: 'Goal it serves (title or id); null to remove' },
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
      Object.assign(patch, await api.locationPatch(a), projectPatch(api, a), await api.horizonsPatch(a));
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
    description: 'List tags (contexts, people, waiting-fors) with open task counts and status (active; on_hold = its actions are parked, not available; dropped = retired, hidden unless include_dropped). Nested tags show as "Parent : Child".',
    inputSchema: { type: 'object', properties: { include_dropped: { type: 'boolean', default: false } } },
    async run(api, { include_dropped = false } = {}) {
      const [{ tags, tagLabel }, links, open] = await Promise.all([
        api.lookups(),
        api.q(`task_tags?${api.u}&select=task_id,tag_id`),
        api.q(`tasks?${api.u}&${OPEN}&select=*`),
      ]);
      const openIds = new Set(open.map((t) => t.id));
      const statusOf = (t) => { let st = 'active'; for (let g = t, i = 0; g && i < 8; i++) { if (g.status === 'dropped') return 'dropped'; if (g.status === 'on_hold') st = 'on_hold'; g = tags.find((x) => x.id === g.parent_id); } return st; };
      return tags.map((t) => ({ id: t.id, label: tagLabel(t), status: statusOf(t), open_tasks: links.filter((l) => l.tag_id === t.id && openIds.has(l.task_id)).length }))
        .filter((t) => include_dropped || t.status !== 'dropped')
        .sort((a, b) => a.label.localeCompare(b.label));
    },
  },
  {
    name: 'update_tag',
    description: 'Rename a tag, set its status, or give it a place (every action with the tag inherits that place and its alert unless the action has its own). status: on_hold parks every action with the tag (or a sub-tag): not available anywhere until active again, like a Someday list; dropped retires the tag (hidden from pickers, doesn\'t hold actions). Ask the user before putting a tag on hold.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Tag label ("Errands" or "Waiting : Hiro") or id' },
        name: { type: 'string', description: 'New name (just this level, not the parent)' },
        status: { type: 'string', enum: ['active', 'on_hold', 'dropped'] },
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
      if (a.status !== undefined) {
        if (!['active', 'on_hold', 'dropped'].includes(a.status)) throw new Error('status: active, on_hold or dropped');
        patch.status = a.status;
      }
      if (Object.keys(patch).length) await api.q(`tags?${api.u}&id=eq.${tag.id}`, { method: 'PATCH', body: patch });
      const [row] = await api.q(`tags?${api.u}&id=eq.${tag.id}&select=*`);
      const place = row.place_id ? (await api.q(`places?${api.u}&id=eq.${row.place_id}&select=*`))[0] : null;
      return { id: row.id, label: tagLabel(row), status: row.status || 'active', place: place ? { name: place.name, alert: row.location_trigger, radius_m: row.location_radius_m || place.radius_m } : null };
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
      const { available } = availabilityOf(full, await api.q(`projects?${api.u}&select=*`), undefined, undefined, await api.availableSet());
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
      const shaped = new Map((await api.shape(groups.flatMap((g) => g.tasks))).map((x) => [x.id, x])); // one pass, not one per place
      const out = [];
      for (const g of groups) {
        out.push({ place: g.place.name, place_id: g.place.id, address: g.place.address || undefined, distance_m: g.distance_m,
          inside_radius: g.distance_m <= g.place.radius_m, actions: g.tasks.map((t) => shaped.get(t.id)) });
      }
      return { count: out.reduce((n, g) => n + g.actions.length, 0), places: out };
    },
  },
];
TOOLS.push(...gtdTools({ OPEN, zonedToIso, localDate, inList, tool: (name) => TOOLS.find((t) => t.name === name) }));
// Available actions (not Inbox items) with what What now? needs to filter and rank them.
async function availableTasks(api) {
  const [open, projects, tags, links, projectLinks, people, taskWaits] = await Promise.all([
    api.q(`tasks?${api.u}&${OPEN}&select=*`), api.q(`projects?${api.u}&select=*`), api.q(`tags?${api.u}&select=*`),
    api.q(`task_tags?${api.u}&select=task_id,tag_id`), api.q(`project_tags?${api.u}&select=project_id,tag_id`), api.q(`people?${api.u}&archived_at=is.null&select=id,name,tag_id,archived_at`),
    api.q(`task_waits?${api.u}&select=task_id,waits_for`),
  ]);
  const ok = await api.availableSet();
  return { tasks: open.filter((t) => !t.in_inbox && ok.has(t.id)), tags, links, projectLinks, projects };
}
TOOLS.push(...planTools({ projectOut }));
TOOLS.push(...checklistTools({ localDate }));
TOOLS.push(...settleTools({ OPEN, zonedToIso, localDate }));
TOOLS.push(...gainsTools({ OPEN, localDate }));
TOOLS.push(...fullReviewTools({ OPEN, localDate, zonedToIso, tool: (name) => TOOLS.find((t) => t.name === name) }));
TOOLS.push(...slipboxTools({ tool: (name) => TOOLS.find((t) => t.name === name) }));
TOOLS.push(...matrixTools({ OPEN, availableTasks }));
TOOLS.push(...eventsTools({ localDate, zonedToIso, OPEN, geocode }));
TOOLS.push(...dailyTools({ OPEN, zonedToIso, localDate, availableTasks, calendar: (api, from, to) => calendarEvents(api, from, to, api.ctx, { sha256Hex }) }));
TOOLS.push(...horizonsTools({ OPEN, zonedToIso, localDate, availableTasks, calendar: (api, from, to) => calendarEvents(api, from, to, api.ctx, { sha256Hex }) }));
TOOLS.push(...weeklyTools({ OPEN, zonedToIso, localDate, tool: (name) => TOOLS.find((t) => t.name === name), calendar: (api, from, to) => calendarEvents(api, from, to, api.ctx, { sha256Hex }) }));

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
  if (a.defer !== undefined) patch.defer_at = zonedToIso(a.defer, api.hours.defer, api.tz);
  if (a.planned !== undefined) patch.planned_at = zonedToIso(a.planned, api.hours.planned, api.tz);
  if (a.due !== undefined) patch.due_at = zonedToIso(a.due, api.hours.due, api.tz);
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
    outcome: p.outcome || undefined, mac_folder: p.folder_path || undefined, gain: p.purpose || undefined, gain_suggested: p.purpose_by === 'agent' || undefined, principles: p.principles ? p.principles.split('\n').filter(Boolean) : undefined, area_id: p.area_id || undefined, goal_id: p.goal_id || undefined,
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
