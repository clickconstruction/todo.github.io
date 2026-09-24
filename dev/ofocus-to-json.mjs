// OmniFocus database (.ofocus, e.g. File → Export → OmniFocus Document) → the JSON the importer reads
// (the same shape as the "Copy from OmniFocus" script, which needs OmniFocus Pro). Everything the
// database holds comes over: folders, tags (with on-hold/dropped), projects (status, type, review
// interval, last review), actions and groups, dates, flags, estimates, repeats, notes.
//   node dev/ofocus-to-json.mjs <path/to/Export.ofocus> <out.json> [time zone]
// Reads the newest full snapshot plus any later delta transactions, in order.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { localToIso } from '../js/omnifocus-import.js';

const [src, dest, tz = 'America/Chicago'] = process.argv.slice(2);
if (!src || !dest) { console.error('usage: node dev/ofocus-to-json.mjs <db.ofocus> <out.json> [tz]'); process.exit(1); }

// ---------- a tiny XML reader (the file is machine-written and regular) ----------
function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, kids: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g;
  const ent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) { stack[stack.length - 1].text += ent(m[5]); continue; }
    if (m[6] !== undefined) { stack[stack.length - 1].text += m[6]; continue; }
    if (!m[2]) continue;
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    m[3].replace(/([\w:.-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = ent(v); return ''; });
    const node = { tag: m[2], attrs, kids: [], text: '' };
    stack[stack.length - 1].kids.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}
const kid = (n, tag) => n.kids.find((k) => k.tag === tag);
const val = (n, tag) => { const k = kid(n, tag); return k ? k.text.trim() : ''; };
const ref = (n, tag) => { const k = kid(n, tag); return k && k.attrs.idref ? k.attrs.idref : null; };
// Note fields are rich text (<text><p><run><lit>…): keep the words, one line per paragraph.
const noteText = (n) => {
  const k = kid(n, 'note');
  if (!k) return '';
  const paras = [];
  const walk = (x, acc) => { if (x.tag === 'lit') acc.push(x.text); x.kids.forEach((c) => walk(c, acc)); };
  const ps = []; const findP = (x) => { if (x.tag === 'p') ps.push(x); else x.kids.forEach(findP); }; findP(k);
  if (!ps.length) return k.text.trim();
  ps.forEach((p) => { const acc = []; walk(p, acc); paras.push(acc.join('')); });
  return paras.join('\n').trim();
};

// ---------- read the database: the base snapshot, then deltas in name order ----------
const zips = fs.readdirSync(src).filter((f) => f.endsWith('.zip')).sort();
if (!zips.length) throw new Error('No transactions in that .ofocus');
const objects = new Map(); // id → { kind, node }
const order = [];
for (const z of zips) {
  const xml = execFileSync('unzip', ['-p', path.join(src, z), 'contents.xml'], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
  const root = parseXml(xml).kids.find((k) => k.tag === 'omnifocus');
  for (const n of root.kids) {
    const id = n.attrs.id;
    if (!id) continue;
    const op = n.attrs.op;
    if (op === 'delete') { objects.delete(id); continue; }
    if (op === 'update' && objects.has(id)) { // a delta replaces the element
      objects.set(id, { kind: n.tag, node: n });
      continue;
    }
    if (!objects.has(id)) order.push(id);
    objects.set(id, { kind: n.tag, node: n });
  }
}
const of = (kind) => order.map((id) => objects.get(id)).filter((o) => o && o.kind === kind).map((o) => o.node);

const isoZ = (s) => (s ? new Date(s).toISOString() : null); // stamps with Z
const floating = (s) => (s ? (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? new Date(s).toISOString() : localToIso(s.replace('T', ' ').replace(/\.\d+$/, ''), tz)) : null); // start/due/planned
const truthy = (s) => s === 'true';
const dateOrNull = (s) => (s && s !== 'false' && s !== 'true' ? s : null);

const out = { format: 'todotooling-omnifocus', version: 1, exported_at: new Date().toISOString(), app: 'OmniFocus (database export)', folders: [], tags: [], projects: [], tasks: [] };

for (const f of of('folder')) {
  out.folders.push({ id: f.attrs.id, name: val(f, 'name'), parent: ref(f, 'folder'), dropped: !!dateOrNull(val(f, 'hidden')) || truthy(val(f, 'hidden')), added: isoZ(val(f, 'added')), modified: isoZ(val(f, 'modified')) });
}
for (const c of of('context')) {
  const hidden = val(c, 'hidden');
  const status = truthy(hidden) || dateOrNull(hidden) ? 'dropped' : truthy(val(c, 'prohibits-next-action')) ? 'on_hold' : 'active';
  out.tags.push({ id: c.attrs.id, name: val(c, 'name'), parent: ref(c, 'context'), status, added: isoZ(val(c, 'added')), modified: isoZ(val(c, 'modified')) });
}

// Tags on each item, in the item's own order.
const tagLinks = new Map();
for (const l of of('task-to-tag')) {
  const t = ref(l, 'task'); const g = ref(l, 'context');
  if (!t || !g) continue;
  if (!tagLinks.has(t)) tagLinks.set(t, []);
  tagLinks.get(t).push({ g, rank: Number(val(l, 'rank-in-task')) || 0 });
}
const tagsOf = (n) => {
  const list = (tagLinks.get(n.attrs.id) || []).sort((a, b) => a.rank - b.rank).map((x) => x.g);
  const primary = ref(n, 'context');
  return [...new Set([...(primary ? [primary] : []), ...list])];
};

// Repeats: the RRULE (repetition-rule) and method; older items have only "@1w"-style repeat.
const oldRepeat = (s) => {
  const m = String(s || '').match(/^[@~](\d+)([hdwmy])$/);
  if (!m) return null;
  return `FREQ=${{ h: 'HOURLY', d: 'DAILY', w: 'WEEKLY', m: 'MONTHLY', y: 'YEARLY' }[m[2]]};INTERVAL=${m[1]}`;
};
const repeatOf = (n) => {
  const rule = val(n, 'repetition-rule') || oldRepeat(val(n, 'repeat'));
  if (!rule) return null;
  const method = val(n, 'repetition-method') || 'fixed';
  return { rule, method: method === 'fixed' ? 'fixed' : `${method}`, schedule: val(n, 'repetition-schedule-type'), anchor: val(n, 'repetition-anchor-date') };
};
const reviewOf = (p) => {
  const m = String(val(p, 'review-interval')).match(/^[@~](\d+)([dwmy])$/);
  return m ? { steps: Number(m[1]), unit: { d: 'days', w: 'weeks', m: 'months', y: 'years' }[m[2]] } : null;
};

const tasks = of('task');
const byId = new Map(tasks.map((t) => [t.attrs.id, t]));
const isProject = (t) => { const p = kid(t, 'project'); return !!(p && p.kids.length); };
const attachments = new Map();
for (const a of of('attachment')) { const t = ref(a, 'task'); if (t) attachments.set(t, (attachments.get(t) || 0) + 1); }

// A title that runs over several lines (pasted text): the first line is the title, the rest leads the
// notes (the importer keeps at most 1,000 characters of a title, and long titles read badly).
const splitTitle = (name, note) => {
  const lines = String(name || '').replace(/\r/g, '').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { name: '', note };
  let title = lines[first].trim();
  let rest = lines.slice(first + 1).join('\n').trim();
  if (title.length > 300) { const cut = title.lastIndexOf(' ', 280); rest = `${title.slice(cut > 100 ? cut : 280).trim()}${rest ? `\n${rest}` : ''}`; title = `${title.slice(0, cut > 100 ? cut : 280).trim()}…`; }
  return { name: title, note: [rest, note].filter(Boolean).join('\n\n') };
};
let splitCount = 0;

for (const t of tasks) {
  const id = t.attrs.id;
  const st = splitTitle(val(t, 'name'), noteText(t));
  if (st.name !== val(t, 'name').trim()) splitCount++;
  const common = {
    id, name: st.name, note: st.note, flagged: truthy(val(t, 'flagged')),
    defer: floating(val(t, 'start')), planned: floating(val(t, 'planned')), due: floating(val(t, 'due')),
    estimate: val(t, 'estimated-minutes') ? Number(val(t, 'estimated-minutes')) : null,
    completed: isoZ(val(t, 'completed')), dropped: isoZ(dateOrNull(val(t, 'hidden'))),
    tags: tagsOf(t), repeat: repeatOf(t), attachments: attachments.get(id) || 0, notifications: 0,
    added: isoZ(val(t, 'added')), modified: isoZ(val(t, 'modified')),
  };
  if (isProject(t)) {
    const p = kid(t, 'project');
    const status = val(p, 'status');
    out.projects.push({ ...common, folder: ref(p, 'folder'),
      status: common.completed ? 'completed' : status === 'dropped' ? 'dropped' : status === 'inactive' ? 'on_hold' : status === 'done' ? 'completed' : 'active',
      dropped: status === 'dropped' ? (common.dropped || common.modified) : null,
      sequential: val(t, 'order') === 'sequential', singleActions: truthy(val(p, 'singleton')), autoComplete: truthy(val(t, 'completed-by-children')),
      review: reviewOf(p), lastReview: isoZ(val(p, 'last-review')), nextReview: isoZ(val(p, 'next-review')) });
    continue;
  }
  // The nearest project up the chain; the parent only if it's an action (not the project itself).
  const parentId = ref(t, 'task');
  let proj = null;
  for (let x = parentId ? byId.get(parentId) : null, i = 0; x && i < 20; i++) { if (isProject(x)) { proj = x.attrs.id; break; } x = byId.get(ref(x, 'task')); }
  out.tasks.push({ ...common, project: proj, parent: parentId && parentId !== proj ? parentId : null, inbox: truthy(val(t, 'inbox')) || (!proj && !parentId), sequential: val(t, 'order') === 'sequential' });
}

fs.writeFileSync(dest, JSON.stringify(out));
const open = out.tasks.filter((t) => !t.completed && !t.dropped).length;
console.log(JSON.stringify({ titles_split: splitCount, folders: out.folders.length, tags: out.tags.length, projects: out.projects.length, actions: out.tasks.length, open_actions: open, inbox: out.tasks.filter((t) => t.inbox && !t.completed && !t.dropped).length, transactions: zips.length }));
