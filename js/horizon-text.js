// Purpose and vision text with checkboxes (no imports: the app and the MCP Worker both use it).
// A line that starts with [ ] is a checkbox; [x] is a ticked one ("- [ ]" works too). The ticks live in
// the text itself, so they follow you to every device. Marking the text as read clears them: the
// database does that (migration 20261102000001), and clearTicks() is the same rule for the screen.
const BOX = /^([ \t]*(?:[-*][ \t]+)?)\[([ xX])\][ \t]?(.*)$/;
const TICKED = /^([ \t]*(?:[-*][ \t]+)?)\[[xX]\]/gm;

// Each line as { kind: check | heading | bullet | blank | text, text, i (line number), on (check only) }.
export function parseText(text) {
  return String(text || '').split('\n').map((line, i) => {
    const m = BOX.exec(line);
    if (m) return { kind: 'check', i, on: m[2] !== ' ', text: m[3] };
    const t = line.trim();
    if (!t) return { kind: 'blank', i, text: '' };
    if (/^[-*•]\s+/.test(t)) return { kind: 'bullet', i, text: t.replace(/^[-*•]\s+/, '') };
    if (t.length >= 3 && t.length <= 60 && /[A-Z]/.test(t) && t === t.toUpperCase() && !/[.!?]$/.test(t)) return { kind: 'heading', i, text: t };
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
  const exact = boxes.filter((l) => l.text.trim().toLowerCase() === key);
  const hits = exact.length ? exact : boxes.filter((l) => key && l.text.toLowerCase().includes(key));
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
