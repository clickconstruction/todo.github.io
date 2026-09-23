// Location events from outside the app (an iPhone Shortcuts "Arrive"/"Leave" automation):
//   GET or POST https://mcp.todotooling.com/geo?t=<location key>&place=<place id>&event=arrive|leave|test
// Finds open, non-deferred actions whose effective place is that place and whose alert matches,
// then sends a Web Push notification to the user's subscribed devices.
import { deliver } from './deliver.js';

// Effective place for a task, mirroring the app (js/places.js): own, tag, group, project, project tag.
export function makePlaceResolver({ tasks, taskTags, tags, projects, projectTags, places }) {
  const placeById = new Map(places.filter((p) => !p.archived_at).map((p) => [p.id, p]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const fromRow = (row, via) => {
    const place = row && row.place_id && placeById.get(row.place_id);
    return place ? { place, trigger: row.location_trigger || null, radius: row.location_radius_m || place.radius_m, via } : null;
  };
  const resolve = (t, depth = 0) => {
    const own = fromRow(t, null);
    if (own) return own;
    for (const link of taskTags.filter((x) => x.task_id === t.id)) {
      const tag = tagById.get(link.tag_id);
      const r = fromRow(tag, tag && { kind: 'tag', label: tag.name });
      if (r) return r;
    }
    const parent = t.parent_id && taskById.get(t.parent_id);
    if (parent && depth < 3) { const r = resolve(parent, depth + 1); if (r) return { ...r, via: { kind: 'group', label: parent.title } }; }
    const project = t.project_id && projectById.get(t.project_id);
    if (project) {
      const r = fromRow(project, { kind: 'project', label: project.name });
      if (r) return r;
      for (const link of projectTags.filter((x) => x.project_id === project.id)) {
        const tag = tagById.get(link.tag_id);
        const pr = fromRow(tag, tag && { kind: 'project tag', label: tag.name });
        if (pr) return pr;
      }
    }
    return null;
  };
  return resolve;
}

// Everything the resolver needs for one user (open tasks only).
export async function loadPlaceData(rest, userId) {
  const u = `user_id=eq.${userId}`;
  const [tasks, taskTags, tags, projects, projectTags, places] = await Promise.all([
    rest(`tasks?${u}&completed_at=is.null&dropped_at=is.null&select=id,title,parent_id,project_id,place_id,location_trigger,location_radius_m,defer_at,flagged,due_at,planned_at`),
    rest(`task_tags?${u}&select=task_id,tag_id`),
    rest(`tags?${u}&select=id,name,parent_id,place_id,location_trigger,location_radius_m`),
    rest(`projects?${u}&select=id,name,status,place_id,location_trigger,location_radius_m`),
    rest(`project_tags?${u}&select=project_id,tag_id`),
    rest(`places?${u}&select=*`),
  ]);
  return { tasks, taskTags, tags, projects, projectTags, places };
}

const MATCHES = { arrive: ['arrive', 'nearby'], leave: ['leave'] };
const VERB = { arrive: 'You’re at', leave: 'You left' };

// Which actions an event at `placeId` should announce.
export function actionsForEvent(data, placeId, event, now = new Date()) {
  const resolve = makePlaceResolver(data);
  const blockedProjects = new Set(data.projects.filter((p) => p.status !== 'active').map((p) => p.id));
  return data.tasks.filter((t) => {
    if (t.defer_at && new Date(t.defer_at) > now) return false;
    if (t.project_id && blockedProjects.has(t.project_id)) return false;
    const loc = resolve(t);
    return loc && loc.place.id === placeId && MATCHES[event].includes(loc.trigger);
  });
}

export function eventMessage(place, event, tasks) {
  const names = tasks.map((t) => t.title);
  return {
    title: `📍 ${VERB[event]} ${place.name}`,
    body: names.slice(0, 3).join('\n') + (names.length > 3 ? `\n+${names.length - 3} more` : ''),
    tag: `place:${place.id}:${event}`,
    url: `#nearby/${place.id}`,
  };
}

export async function handleGeo(request, env, ctx, { rest, sha256Hex, json }) {
  const url = new URL(request.url);
  const p = Object.fromEntries(url.searchParams);
  if (request.method === 'POST') { try { Object.assign(p, await request.json()); } catch { /* query only */ } }
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const token = String(p.t || bearer || '');
  if (!/^tt_[A-Za-z0-9_-]{20,}$/.test(token)) return json({ error: 'Missing or malformed key (t=…)' }, 401);
  const [key] = await rest(`api_tokens?token_hash=eq.${await sha256Hex(token)}&select=id,user_id,scope`);
  if (!key) return json({ error: 'Unknown or revoked key' }, 401);
  ctx.waitUntil(rest(`api_tokens?id=eq.${key.id}`, { method: 'PATCH', body: { last_used_at: new Date().toISOString() } }).catch(() => {}));
  const userId = key.user_id;
  const event = String(p.event || '');
  if (!['arrive', 'leave', 'test'].includes(event)) return json({ error: 'event must be arrive, leave or test' }, 400);
  if (!(env.VAPID_PRIVATE_JWK || '').trim()) return json({ error: 'Push is not configured on the server' }, 503);

  let message;
  let actions = [];
  let place = null;
  if (event === 'test') {
    message = { title: '📍 Todo Tooling alerts are on', body: 'Background location alerts will appear like this.', tag: 'test', url: '#nearby' };
  } else {
    if (!/^[0-9a-f-]{36}$/i.test(String(p.place || ''))) return json({ error: 'place must be a place id' }, 400);
    [place] = await rest(`places?id=eq.${p.place}&user_id=eq.${userId}&archived_at=is.null&select=*`);
    if (!place) return json({ error: 'Place not found (archived or not yours)' }, 404);
    actions = actionsForEvent(await loadPlaceData(rest, userId), place.id, event);
    if (!actions.length) return json({ place: place.name, event, actions: [], sent: 0, note: 'No open actions ask for this alert, so nothing was sent.' });
    message = eventMessage(place, event, actions);
  }

  const out = await deliver(env, rest, userId, message, { kind: event === 'test' ? 'test' : 'place', task_id: actions.length === 1 ? actions[0].id : null });
  return json({ place: place && place.name, event, actions: actions.map((t) => t.title), devices: out.devices, sent: out.delivered, results: out.results,
    ...(out.devices ? {} : { note: 'No devices have notifications turned on. Open Todo Tooling → Alerts on your phone.' }) });
}
