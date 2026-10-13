// GTD practices beyond projects and contexts: People (Waiting For, Agendas), the Tickler, Reference,
// Energy, and the helpers Clarify uses. Waiting/agenda availability is the shared rule in
// js/perspective-engine.js (makeWaiting), used by the app, perspectives and the MCP server.
import { db, app, sb, run, byId, syncRow, toast, isOpen, tagsFor } from './state.js';
import { waitingRule } from './availability.js';
import { startOfToday, addDays, isDeferred } from './dates.js';
import { placeFor } from './gain.js';
import { saveTask, ensureTag, updateTag } from './data.js';

export const ENERGY = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
export const ENERGY_ICON = { low: '🔋', medium: '⚡', high: '🔥' };

// ---------- people ----------
export const livePeople = () => (db.people || []).filter((p) => !p.archived_at).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
export const isWaiting = (t) => isOpen(t) && waitingRule()(t);
export const waitingPerson = (t) => waitingRule().personFor(t);
export const agendaPerson = (t) => (t.agenda_for ? byId(db.people || [], t.agenda_for) : null);
export const waitingFor = (person) => db.tasks.filter((t) => isOpen(t) && !t.agenda_for && waitingRule()(t) && (!person || (waitingPerson(t) || {}).id === person.id));
export const agendaFor = (person) => db.tasks.filter((t) => isOpen(t) && t.agenda_for === person.id);
export const followUpDue = (t) => isOpen(t) && t.follow_up_at && new Date(t.follow_up_at) < addDays(startOfToday(), 1);
// Does this text (an event title) mention the person by first name?
export const mentions = (person, text) => {
  const first = String(person.name || '').split(/\s+/)[0];
  return first.length >= 3 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(text || ''));
};
export const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export async function savePerson(p, fields) {
  if (p && p.id) { const [row] = await run(sb.from('people').update(fields).eq('id', p.id).select()); return syncRow('people', p, row); }
  const sort = Math.max(-1, ...(db.people || []).map((x) => x.sort || 0)) + 1;
  const [row] = await run(sb.from('people').insert({ ...fields, sort }).select());
  (db.people = db.people || []).push(row);
  return row;
}
// Archive (or restore) people in one request. Archived people are kept, listed under "Show n archived"
// on Waiting For, and come back with Restore; nobody is deleted.
export async function archivePeople(list, archived = true) {
  const ids = list.map((p) => p.id);
  if (!ids.length) return [];
  const rows = await run(sb.from('people').update({ archived_at: archived ? new Date().toISOString() : null }).in('id', ids).select());
  rows.forEach((row) => { const p = (db.people || []).find((x) => x.id === row.id); if (p) syncRow('people', p, row); });
  return rows;
}
// ---------- groups (what someone is to you) and projects (what you're working on together) ----------
// A person is in one group or none, like a project in a folder; a person can be on several projects, with
// a role word. Groups are archived, never deleted; archiving one files its people under "no group" (the
// database does the same). A project link is a link: it can be removed.
export const liveGroups = () => (db.peopleGroups || []).filter((g) => !g.archived_at).sort((a, b) => ((a.sort ?? 0) - (b.sort ?? 0)) || a.name.localeCompare(b.name));
export const groupOf = (p) => (p && p.group_id && byId(db.peopleGroups || [], p.group_id)) || null;
export async function savePeopleGroup(g, fields) {
  if (g && g.id) { const [row] = await run(sb.from('people_groups').update(fields).eq('id', g.id).select()); return syncRow('peopleGroups', g, row); }
  const sort = Math.max(-1, ...(db.peopleGroups || []).map((x) => x.sort || 0)) + 1;
  const [row] = await run(sb.from('people_groups').insert({ ...fields, sort }).select());
  (db.peopleGroups = db.peopleGroups || []).push(row);
  return row;
}
export async function archivePeopleGroup(g, archived = true) {
  await savePeopleGroup(g, { archived_at: archived ? new Date().toISOString() : null });
  if (archived) (db.people || []).forEach((p) => { if (p.group_id === g.id) p.group_id = null; });
}
export async function movePeopleGroup(g, dir) {
  const list = liveGroups(); const i = list.indexOf(g); const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  list.splice(i, 1); list.splice(j, 0, g);
  await Promise.all(list.map((x, k) => (x.sort === k ? null : savePeopleGroup(x, { sort: k }))));
}
export const peopleOn = (projectId) => (db.projectPeople || []).filter((l) => l.project_id === projectId).map((l) => ({ link: l, person: byId(db.people || [], l.person_id) })).filter((x) => x.person && !x.person.archived_at).sort((a, b) => a.person.name.localeCompare(b.person.name));
export const projectsOf = (p) => (db.projectPeople || []).filter((l) => l.person_id === p.id).map((l) => ({ link: l, project: byId(db.projects, l.project_id) })).filter((x) => x.project && ['active', 'on_hold'].includes(x.project.status)).sort((a, b) => a.project.name.localeCompare(b.project.name));
export const onProject = (p, projectId) => (db.projectPeople || []).find((l) => l.person_id === p.id && l.project_id === projectId) || null;
export async function putOnProject(p, projectId, role = '') {
  const have = onProject(p, projectId);
  if (have) return have;
  const [row] = await run(sb.from('project_people').insert({ project_id: projectId, person_id: p.id, role }).select());
  (db.projectPeople = db.projectPeople || []).push(row);
  return row;
}
export async function takeOffProject(p, projectId) {
  const l = onProject(p, projectId);
  if (!l) return;
  await run(sb.from('project_people').delete().eq('id', l.id));
  db.projectPeople = db.projectPeople.filter((x) => x.id !== l.id);
}
export async function setProjectRole(link, role) { const [row] = await run(sb.from('project_people').update({ role }).eq('id', link.id).select()); return syncRow('projectPeople', link, row); }
// A person's open items in a project: what you're waiting on them for there, and their agenda items filed there.
export const itemsWith = (p, projectId) => [...waitingFor(p), ...agendaFor(p)].filter((t) => t.project_id === projectId);
// People with open items in a project who aren't on it yet: offered with "Put on project".
export const suggestedFor = (projectId) => livePeople().filter((p) => !onProject(p, projectId) && itemsWith(p, projectId).length);
// Find a person by name, or create one (e.g. typed in the Delegate sheet).
export async function personNamed(name, extra = {}) {
  const n = String(name || '').trim();
  if (!n) return null;
  const hit = livePeople().find((p) => p.name.toLowerCase() === n.toLowerCase());
  if (hit) { if (Object.keys(extra).some((k) => extra[k] && !hit[k])) await savePerson(hit, Object.fromEntries(Object.entries(extra).filter(([k, v]) => v && !hit[k]))); return hit; }
  // Their tag is "Waiting : Name" (an existing one is theirs; otherwise it is made), so items with it
  // count as waiting on them.
  const tag = await waitingTagFor(n);
  return savePerson(null, { name: n, ...extra, tag_id: tag ? tag.id : null });
}
// The "Waiting : Name" tag for a person: the existing one, else made.
export async function waitingTagFor(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const have = db.tags.find((g) => g.name.toLowerCase() === n.toLowerCase() && g.parent_id && /^waiting/i.test((byId(db.tags, g.parent_id) || {}).name || ''));
  return have || ensureTag(`Waiting : ${n}`);
}
// A person's own "Waiting : Name" tag follows a rename.
export async function renamePersonTag(p, newName) {
  const g = p && p.tag_id && byId(db.tags, p.tag_id);
  if (!g || !g.parent_id || g.name !== p.name || newName === p.name) return;
  if (/^waiting/i.test((byId(db.tags, g.parent_id) || {}).name || '')) await updateTag(g, { name: newName });
}
// People for every "Waiting : X" tag that doesn't have one yet.
export async function peopleFromWaitingTags() {
  const parents = db.tags.filter((g) => !g.parent_id && /^waiting/i.test(g.name)).map((g) => g.id);
  const kids = db.tags.filter((g) => parents.includes(g.parent_id) && !livePeople().some((p) => p.tag_id === g.id));
  for (const g of kids) await savePerson(null, { name: g.name, tag_id: g.id });
  return kids.length;
}

const patchTask = async (t, fields) => { const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select()); syncRow('tasks', t, row); return row; };
const undoable = (t, fields, label) => {
  const before = Object.fromEntries(Object.keys(fields).map((k) => [k, t[k] ?? null]));
  return patchTask(t, fields).then(() => { app.render(); toast(label, [{ label: 'Undo', run: async () => { await patchTask(t, before); app.render(); } }]); });
};

// Delegate: waiting on a person, follow up on a day; returns a mail/text link to send the request.
export async function delegate(t, person, { followUpDays = 7, followUpKey = null } = {}) {
  const follow = followUpKey ? new Date(`${followUpKey}T09:00:00`) : (() => { const d = addDays(startOfToday(), followUpDays); d.setHours(9, 0, 0, 0); return d; })();
  await patchTask(t, { waiting_on: person.id, delegated_at: new Date().toISOString(), follow_up_at: follow.toISOString(), in_inbox: false, tickler: false, defer_at: t.tickler ? null : t.defer_at });
  app.render();
}
export const takeBack = (t) => undoable(t, { waiting_on: null, follow_up_at: null, delegated_at: null }, 'Back on your list');
export const gotIt = (t) => undoable(t, { completed_at: new Date().toISOString() }, `Got it: “${t.title}”`);
export const snooze = (t, days = 3) => { const d = addDays(startOfToday(), days); d.setHours(9, 0, 0, 0); return undoable(t, { follow_up_at: d.toISOString() }, `Follow up ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`); };

// A ready-to-send request or nudge (the user presses Send in their own mail/messages app).
export const draftMessage = (person, t, { nudge = false } = {}) => {
  const first = String(person ? person.name : '').split(/\s+/)[0] || 'there';
  return nudge ? `Hi ${first}, just checking in on this: ${t.title}. Any update?` : `Hi ${first}, could you take care of this? ${t.title}${t.notes ? `\n\n${t.notes}` : ''}\n\nThanks!`;
};
export function messageLink(person, t, { nudge = false, via = 'email', body = draftMessage(person, t, { nudge }) } = {}) {
  if (via === 'text' && person.phone) return `sms:${person.phone.replace(/[^\d+]/g, '')}${/iPhone|iPad|Mac/.test(navigator.userAgent) ? '&' : '?'}body=${encodeURIComponent(body)}`;
  if (person.email) return `mailto:${encodeURIComponent(person.email)}?subject=${encodeURIComponent(nudge ? `Following up: ${t.title}` : t.title)}&body=${encodeURIComponent(body)}`;
  return null;
}

export async function addAgendaItem(person, title) {
  const [row] = await run(sb.from('tasks').insert({ title: String(title).trim(), agenda_for: person.id, in_inbox: false }).select());
  db.tasks.push(row);
  app.render();
  return row;
}

// ---------- tickler ----------
// A tickled item waits (hidden) in the Inbox until 6am on its day, then it's back to clarify.
export const isTickled = (t) => isOpen(t) && t.tickler && isDeferred(t);
export const ticklerItems = () => db.tasks.filter(isTickled).sort((a, b) => a.defer_at.localeCompare(b.defer_at));
export const returnedFromTickler = (t) => isOpen(t) && t.tickler && t.in_inbox && !isDeferred(t);
export const tickleIso = (key) => new Date(`${key}T06:00:00`).toISOString();
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export async function tickle(t, key) {
  await patchTask(t, { tickler: true, in_inbox: true, defer_at: tickleIso(key), project_id: null, parent_id: null });
  app.render();
}
export async function tickleNew(title, key, extra = {}) {
  const [row] = await run(sb.from('tasks').insert({ title: String(title).trim(), tickler: true, in_inbox: true, defer_at: tickleIso(key), ...extra }).select());
  db.tasks.push(row);
  app.render();
  return row;
}

// ---------- reference ----------
export const liveReferences = () => (db.references || []).filter((r) => !r.archived_at).sort((a, b) => (a.topic || '~').localeCompare(b.topic || '~') || a.title.localeCompare(b.title));
export const topics = () => [...new Set([...liveReferences().map((r) => r.topic).filter(Boolean), ...db.projects.filter((p) => ['active', 'on_hold'].includes(p.status)).map((p) => p.name)])].sort();
export async function saveReference(r, fields) {
  if (r && r.id) { const [row] = await run(sb.from('reference_items').update(fields).eq('id', r.id).select()); return syncRow('references', r, row); }
  const [row] = await run(sb.from('reference_items').insert(fields).select());
  (db.references = db.references || []).push(row);
  return row;
}
// File an Inbox item as reference: its notes and attachments move with it; the item is dropped (not deleted).
export async function fileToReference(t, topic = '') {
  const ref = await saveReference(null, { title: t.title, body: t.notes || '', topic });
  const files = db.attachments.filter((a) => a.task_id === t.id && !a.archived_at);
  for (const a of files) { const [row] = await run(sb.from('attachments').update({ task_id: null, reference_id: ref.id }).eq('id', a.id).select()); syncRow('attachments', a, row); }
  await patchTask(t, { dropped_at: new Date().toISOString(), completion_note: `Filed to Reference: ${topic || 'no topic'}`, reference_id: ref.id });
  return ref;
}
export const referencesFor = (projectId) => liveReferences().filter((r) => r.project_id === projectId);

// ---------- someday ----------
export async function somedayTag() {
  let tag = db.tags.find((g) => !g.parent_id && /^someday/i.test(g.name));
  if (!tag) { const [row] = await run(sb.from('tags').insert({ name: 'Someday', status: 'on_hold' }).select()); db.tags.push(row); tag = row; }
  else if (tag.status !== 'on_hold') { const [row] = await run(sb.from('tags').update({ status: 'on_hold' }).eq('id', tag.id).select()); syncRow('tags', tag, row); }
  return tag;
}
// Park it in Someday/Maybe, optionally in a category ("Travel" → the tag Someday : Travel).
export async function makeSomeday(t, category = '') {
  const root = await somedayTag();
  let tag = root;
  const c = String(category || '').trim();
  if (c) {
    tag = db.tags.find((g) => g.parent_id === root.id && g.name.toLowerCase() === c.toLowerCase());
    if (!tag) { const [row] = await run(sb.from('tags').insert({ name: c, parent_id: root.id }).select()); db.tags.push(row); tag = row; }
  }
  await saveTask(t, { in_inbox: false, tickler: false }, [...new Set([...tagsFor(t.id).map((g) => g.id), tag.id])]);
}
// Someday/Maybe: open items with the Someday tag (or one under it), and on-hold projects.
export const somedayRoot = () => db.tags.find((g) => !g.parent_id && /^someday/i.test(g.name)) || null;
export const somedayCategories = () => { const r = somedayRoot(); return r ? db.tags.filter((g) => g.parent_id === r.id).sort((a, b) => a.name.localeCompare(b.name)) : []; };
const somedayIds = () => { const r = somedayRoot(); return r ? new Set([r.id, ...somedayCategories().map((g) => g.id)]) : new Set(); };
export const somedayLink = (t) => { const ids = somedayIds(); return db.taskTags.find((x) => x.task_id === t.id && ids.has(x.tag_id)) || null; };
export const isSomeday = (t) => isOpen(t) && !!somedayLink(t);
export function somedayItems() {
  const ids = somedayIds();
  const tasks = ids.size ? db.tasks.filter((t) => isOpen(t) && db.taskTags.some((x) => x.task_id === t.id && ids.has(x.tag_id))) : [];
  const projects = db.projects.filter((p) => p.status === 'on_hold');
  return { tasks, projects };
}
// When it was parked (the Someday tag was put on; else when it was last changed).
export const parkedSince = (t) => { const l = somedayLink(t); return (l && l.created_at) || t.updated_at || t.created_at; };
export const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));
// Out of Someday: the Someday tags come off; with a project and/or tags it becomes a next action.
export async function activateSomeday(t, { project_id = null, tagIds = [] } = {}) {
  const ids = somedayIds();
  const keep = tagsFor(t.id).map((g) => g.id).filter((id) => !ids.has(id));
  await saveTask(t, { project_id: project_id || t.project_id || null }, [...new Set([...keep, ...tagIds])]);
}

// ---------- Clarify suggestions ----------
// Project and tags from similar items you've already filed (shared words in the title).
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'on', 'in', 'at', 'with', 'about', 'call', 'email', 'get', 'send', 'buy', 'my', 'is', 'it']);
const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) || [];
export function suggestFor(t) {
  const mine = new Set(words(t.title));
  if (!mine.size && !t.gain) return null;
  const votes = new Map(); const tagVotes = new Map();
  db.tasks.forEach((x) => {
    if (x.id === t.id || x.in_inbox || !x.project_id) return;
    const overlap = words(x.title).filter((w) => mine.has(w)).length;
    if (!overlap) return;
    votes.set(x.project_id, (votes.get(x.project_id) || 0) + overlap);
    tagsFor(x.id).forEach((g) => tagVotes.set(g.id, (tagVotes.get(g.id) || 0) + overlap));
  });
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) { // nothing similar yet: where its gain (or title) points
    const [p] = placeFor(t, { projects: db.projects, goals: db.goals || [], areas: db.areas || [] }, { limit: 1 });
    return p ? { project: byId(db.projects, p.project.id), tags: [], via: p } : null;
  }
  const project = byId(db.projects, best[0]);
  if (!project || !['active', 'on_hold'].includes(project.status)) return null;
  const tags = [...tagVotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => byId(db.tags, id)).filter(Boolean);
  return { project, tags };
}
