// Purpose and vision text, written plainly and read formatted (no imports: the app and the MCP Worker both use it).
//   # Title   ## Section   (a short line in CAPITALS is a section too)
//   **bold**   *italic* or _italic_   - a bullet   [ ] a checkbox
// The text stays plain, so it copies, pastes and reads fine anywhere.
// A line that starts with [ ] is a checkbox; [x] is a ticked one ("- [ ]" works too). The ticks live in
// the text itself, so they follow you to every device. Marking the text as read clears them: the
// database does that (migration 20261102000001), and clearTicks() is the same rule for the screen.
const BOX = /^([ \t]*(?:[-*][ \t]+)?)\[([ xX])\][ \t]?(.*)$/;
const TICKED = /^([ \t]*(?:[-*][ \t]+)?)\[[xX]\]/gm;

// Each line as { kind: check | heading | bullet | blank | text, text, i (line number), on (check only), level (heading: 1 | 2) }.
export function parseText(text) {
  return String(text || '').split('\n').map((line, i) => {
    const m = BOX.exec(line);
    if (m) return { kind: 'check', i, on: m[2] !== ' ', text: m[3] };
    const t = line.trim();
    if (!t) return { kind: 'blank', i, text: '' };
    const h = /^(#{1,3})[ \t]+(.*\S)\s*$/.exec(t);
    if (h) return { kind: 'heading', i, level: h[1].length === 1 ? 1 : 2, text: h[2].replace(/[ \t]+#+$/, '') };
    if (/^[-*•]\s+/.test(t)) return { kind: 'bullet', i, text: t.replace(/^[-*•]\s+/, '') };
    if (t.length >= 3 && t.length <= 60 && /[A-Z]/.test(t) && t === t.toUpperCase() && !/[.!?]$/.test(t)) return { kind: 'heading', i, level: 2, text: t };
    return { kind: 'text', i, text: t };
  });
}
export const counts = (text) => { const c = parseText(text).filter((l) => l.kind === 'check'); return { total: c.length, on: c.filter((l) => l.on).length }; };
// Tick or un-tick the checkbox on line i; anything else is left alone.
export function setTick(text, i, on) {
  const lines = String(text || '').split('\n');
  if (lines[i] !== undefined && BOX.test(lines[i])) lines[i] = lines[i].replace(/\[([ xX])\]/, on ? '[x]' : '[ ]');
  return lines.join('\n');
}
export const clearTicks = (text) => String(text || '').replace(TICKED, '$1[ ]');
// The checkbox whose text matches (exactly, else the only one containing it); -1 when none or several do.
export function findTick(text, needle) {
  const key = String(needle || '').trim().toLowerCase();
  const boxes = parseText(text).filter((l) => l.kind === 'check');
  const exact = boxes.filter((l) => [l.text, plain(l.text)].some((x) => x.trim().toLowerCase() === key));
  const hits = exact.length ? exact : boxes.filter((l) => key && (l.text.toLowerCase().includes(key) || plain(l.text).toLowerCase().includes(key)));
  return hits.length === 1 ? hits[0].i : -1;
}
// Editing: make the lines the selection touches checkboxes, or plain again when they all are already.
// → { text, start, end } with the selection kept over the same lines.
export function toggleBoxes(text, start, end) {
  const src = String(text || '');
  const from = src.lastIndexOf('\n', Math.max(0, start) - 1) + 1;
  let to = src.indexOf('\n', Math.max(start, end > start ? end - 1 : end)); if (to < 0) to = src.length;
  const lines = src.slice(from, to).split('\n');
  const real = lines.filter((l) => l.trim());
  const allBoxes = real.length > 0 && real.every((l) => BOX.test(l));
  const out = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l;
    if (allBoxes) return l.replace(BOX, (_, lead, _on, rest) => `${lead.replace(/[-*][ \t]+$/, '')}${rest}`);
    if (BOX.test(l)) return l;
    const m = /^([ \t]*)(?:[-*•][ \t]+)?(.*)$/.exec(l);
    return `${m[1]}[ ] ${m[2]}`;
  }).join('\n');
  return { text: src.slice(0, from) + out + src.slice(to), start: from, end: from + out.length };
}

// ----- bold and italic inside a line -----
const BOLD = /\*\*(\S(?:.*?\S)?)\*\*/g;
const ITAL = /(^|[^*\w])\*(\S(?:[^*\n]*?\S)?)\*(?![*\w])/g;
const UNDER = /(^|[^\w])_(\S(?:[^_\n]*?\S)?)_(?!\w)/g;
// The words without their marks (for a first line, a list, a search).
export const plain = (text) => String(text || '').replace(BOLD, '$1').replace(ITAL, '$1$2').replace(UNDER, '$1$2');
// A line as HTML. esc is the caller's escaper and runs first, so nothing typed can become markup.
export const inlineHtml = (text, esc) => esc(String(text || '')).replace(BOLD, '<strong>$1</strong>').replace(ITAL, '$1<em>$2</em>').replace(UNDER, '$1<em>$2</em>');

// Editing: wrap the selection (or the word the cursor is in) in a mark, or take the mark off when it is
// already there. mark is '**' or '*'. → { text, start, end } with the words selected, not the marks.
export function toggleWrap(text, start, end, mark) {
  const src = String(text || '');
  let a = Math.max(0, Math.min(start, end)); let b = Math.min(src.length, Math.max(start, end));
  if (a === b) { while (a > 0 && /[^\s*]/.test(src[a - 1])) a -= 1; while (b < src.length && /[^\s*]/.test(src[b])) b += 1; }
  while (a < b && /\s/.test(src[a])) a += 1;
  while (b > a && /\s/.test(src[b - 1])) b -= 1;
  const n = mark.length;
  const sel = src.slice(a, b);
  const other = (at) => mark === '*' && src[at] === '*'; // a single * that is half of a ** is bold, not italic
  // the marks sit just outside the selection
  if (src.slice(a - n, a) === mark && src.slice(b, b + n) === mark && !(other(a - n - 1) && other(b + n) && src.slice(a - 3, a) !== '***')) {
    return { text: src.slice(0, a - n) + sel + src.slice(b + n), start: a - n, end: b - n };
  }
  // the marks are inside the selection
  if (sel.length >= 2 * n + 1 && sel.startsWith(mark) && sel.endsWith(mark) && !(mark === '*' && sel.startsWith('**') && !sel.startsWith('***'))) {
    return { text: src.slice(0, a) + sel.slice(n, -n) + src.slice(b), start: a, end: b - 2 * n };
  }
  if (a === b) return { text: src.slice(0, a) + mark + mark + src.slice(a), start: a + n, end: a + n };
  if (sel.includes('\n')) { // marks don't span lines: each line gets its own
    const out = sel.split('\n').map((l) => (l.trim() ? l.replace(/^(\s*(?:#{1,3}[ \t]+|[-*][ \t]+)?(?:\[[ xX]\][ \t]?)?)(.*?)(\s*)$/, (_, lead, body, tail) => (body ? `${lead}${mark}${body}${mark}${tail}` : _)) : l)).join('\n');
    return { text: src.slice(0, a) + out + src.slice(b), start: a, end: a + out.length };
  }
  return { text: src.slice(0, a) + mark + sel + mark + src.slice(b), start: a + n, end: b + n };
}
// The lines the selection touches: → { from, to, lines }.
function linesAt(src, start, end) {
  const from = src.lastIndexOf('\n', Math.max(0, Math.min(start, end)) - 1) + 1;
  const hi = Math.max(start, end);
  let to = src.indexOf('\n', hi > Math.min(start, end) ? hi - 1 : hi); if (to < 0) to = src.length;
  return { from, to, lines: src.slice(from, to).split('\n') };
}
const swapLines = (src, at, fn) => { const out = at.lines.map((l) => (l.trim() || at.lines.length === 1 ? fn(l) : l)).join('\n'); return { text: src.slice(0, at.from) + out + src.slice(at.to), start: at.from, end: at.from + out.length }; };
// Heading: a plain line becomes a title (#), a title a section (##), a section plain again.
export function cycleHeading(text, start, end) {
  const src = String(text || ''); const at = linesAt(src, start, end);
  const level = (l) => { const m = /^\s*(#{1,3})[ \t]+/.exec(l); return m ? Math.min(2, m[1].length) : 0; };
  const next = (level(at.lines.find((l) => l.trim()) || '') + 1) % 3;
  return swapLines(src, at, (l) => { const body = l.replace(/^\s*#{1,3}[ \t]+/, '').replace(/^\s*(?:[-*•][ \t]+)?(?:\[[ xX]\][ \t]?)?/, (m) => (next ? '' : m)); return next ? `${'#'.repeat(next)} ${body.trim()}` : body; });
}
// Bullets: plain lines become "- " lines; when they all are already, plain again.
export function toggleBullets(text, start, end) {
  const src = String(text || ''); const at = linesAt(src, start, end);
  const isB = (l) => /^\s*[-*•][ \t]+(?!\[[ xX]\])/.test(l);
  const real = at.lines.filter((l) => l.trim());
  const all = real.length > 0 && real.every(isB);
  return swapLines(src, at, (l) => (all ? l.replace(/^(\s*)[-*•][ \t]+/, '$1') : isB(l) ? l : l.replace(/^(\s*)(?:#{1,3}[ \t]+)?(?:\[[ xX]\][ \t]?)?(.*)$/, '$1- $2')));
}
