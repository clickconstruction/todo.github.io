// Capture shorthand: what one typed line can carry besides its title. No imports, so the Worker can
// read a line the same way.
//   Idea → gain                   the gain ("->" and "::" work too)
//   #Click Plumbing               the project, when a project of that name exists; else it stays text
//   @Laptop                       a tag, when a tag of that name exists ("@tcruznc" in a title stays text)
//   due fri · by fri              Due: a hard deadline
//   plan fri · on fri · fri       Planned: the intention. A bare day word is Planned.
// Day words: today, tomorrow, mon…sun, monday…sunday, next week (= next Monday). Nothing else becomes
// a date, so numbers and other words are never taken for one.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const DAYWORD = '(?:today|tomorrow|tmrw|next week|sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|thur|sun|mon|tue|wed|thu|fri|sat)';
const AFTER = '(?=$|[\\s,.;:!?)])';
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// A day word → YYYY-MM-DD (local). A weekday is this week's, today included.
export function dayFromWord(word, today = new Date()) {
  const w = String(word || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const d = midnight(today);
  if (w === 'today') return keyOf(d);
  if (w === 'tomorrow' || w === 'tmrw') { d.setDate(d.getDate() + 1); return keyOf(d); }
  if (w === 'next week') { d.setDate(d.getDate() + (((1 - d.getDay()) + 7) % 7 || 7)); return keyOf(d); }
  const dow = DAYS.indexOf(w) >= 0 ? DAYS.indexOf(w) : SHORT[w];
  if (dow === undefined) return null;
  d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
  return keyOf(d);
}
// "today", "tomorrow", else "Fri 17".
export function dayLabel(day, today = new Date()) {
  const t = midnight(today);
  const d = new Date(`${day}T12:00:00`);
  const diff = Math.round((midnight(d) - t) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every "#name" / "@name" in the line that is a name from the list (the longest name at each spot; names
// with spaces work), plus a lone word that starts exactly one name.
function marked(text, mark, items, namesOf) {
  const found = [];
  const taken = (i, j) => found.some((f) => i < f.end && j > f.start);
  for (const item of items) {
    for (const name of namesOf(item).filter(Boolean)) {
      const re = new RegExp(`(^|\\s)${mark}${rx(name)}${AFTER}`, 'gi');
      let m;
      while ((m = re.exec(text))) {
        const start = m.index + m[1].length; const end = m.index + m[0].length;
        const over = found.find((f) => start < f.end && end > f.start);
        if (over) { if (name.length > over.name.length) Object.assign(over, { item, name, start, end }); } else found.push({ item, name, start, end });
      }
    }
  }
  const lone = new RegExp(`(^|\\s)${mark}([^\\s#@]+)`, 'g');
  let m;
  while ((m = lone.exec(text))) {
    const start = m.index + m[1].length; const end = m.index + m[0].length;
    if (taken(start, end)) continue;
    const word = m[2].toLowerCase();
    const hits = items.filter((it) => namesOf(it).some((n) => String(n || '').toLowerCase().startsWith(word)));
    if (hits.length === 1) found.push({ item: hits[0], name: namesOf(hits[0])[0], start, end });
  }
  return found.sort((a, b) => a.start - b.start);
}

// The line read: { title, gain, project, tags, due, planned, chips }. `keep` names kinds whose words stay
// in the title (a chip the user took off): 'project', 'tag', 'due', 'planned'.
export function parseCapture(line, { projects = [], tags = [], today = new Date(), keep = new Set() } = {}) {
  let text = String(line || '');
  let gain = '';
  const g = text.match(/^(.*?\S)\s*(?:→|->|::)\s*(\S.*)$/);
  if (g) { text = g[1]; gain = g[2].trim().slice(0, 500); }
  const out = { gain, project: null, tags: [], due: null, planned: null, chips: [] };
  const cuts = []; // [start, end) spans to take out of the title
  const projectHits = marked(text, '#', projects, (p) => [p.name]);
  if (projectHits.length) { const h = projectHits[0]; out.project = h.item; out.chips.push({ kind: 'project', id: h.item.id, label: h.name }); if (!keep.has('project')) cuts.push([h.start, h.end]); }
  marked(text, '@', tags, (t) => [t.label, t.name]).forEach((h) => {
    if (out.tags.some((x) => x.id === h.item.id)) return;
    out.tags.push(h.item); out.chips.push({ kind: 'tag', id: h.item.id, label: h.name });
    if (!keep.has('tag')) cuts.push([h.start, h.end]);
  });
  const dated = new RegExp(`(^|\\s)(due|by|plan|planned|on)\\s+(${DAYWORD})${AFTER}`, 'gi');
  let m;
  while ((m = dated.exec(text))) {
    const kind = /^(due|by)$/i.test(m[2]) ? 'due' : 'planned';
    if (out[kind]) continue;
    out[kind] = dayFromWord(m[3], today);
    out.chips.push({ kind, day: out[kind], label: `${kind} ${dayLabel(out[kind], today)}` });
    if (!keep.has(kind)) cuts.push([m.index + m[1].length, m.index + m[0].length]);
  }
  if (!out.planned && !out.due) {
    const bare = new RegExp(`(^|\\s)(${DAYWORD})${AFTER}`, 'i').exec(text);
    if (bare) {
      out.planned = dayFromWord(bare[2], today);
      out.chips.push({ kind: 'planned', day: out.planned, label: `planned ${dayLabel(out.planned, today)}` });
      if (!keep.has('planned')) cuts.push([bare.index + bare[1].length, bare.index + bare[0].length]);
    }
  }
  cuts.sort((a, b) => b[0] - a[0]).forEach(([s, e]) => { text = `${text.slice(0, s)} ${text.slice(e)}`; });
  out.title = text.replace(/\s+/g, ' ').replace(/[\s,;:–-]+$/, '').replace(/^[\s,;:–-]+/, '').trim();
  return out;
}
