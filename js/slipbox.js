// Slipbox and reading list: pure helpers shared by the app and the MCP server.
//   Slipbox notes link with [[Title]] (Obsidian's syntax), so an export drops straight into a vault.
//   Reading-list items are actions with reading_type / reading_state (up_next, reading, finished).

export const READING_TYPES = [['book', 'Book'], ['article', 'Article'], ['video', 'Video'], ['podcast', 'Podcast'], ['other', 'Other']];
export const READING_ICON = { book: '📕', article: '📰', video: '🎬', podcast: '🎧', other: '📎' };

// Same rules as the database's reading_guess().
export function guessReadingType(title = '') {
  const s = String(title);
  if (/\b(watch|video|youtube|film|movie|documentary|ted talk)\b/i.test(s)) return 'video';
  if (/\b(listen|podcast|episode|audiobook)\b/i.test(s)) return 'podcast';
  if (/\b(book|novel)\b|archive\.org/i.test(s)) return 'book';
  if (/https?:\/\//i.test(s)) return 'article';
  if (/^\s*read\b/i.test(s)) return 'book';
  return 'other';
}
// Looks like something to read, watch or listen to (for suggesting "→ Reading list").
export const looksLikeReading = (title = '') => /^\s*(read|watch|listen|review)\b|https?:\/\/|\b(book|podcast|video|article|documentary)\b/i.test(String(title));
export const firstUrl = (s = '') => (String(s).match(/https?:\/\/[^\s)>\]]+/) || [null])[0];

// [[Title]] links in a note's body → the titles, as written.
export function linkTitles(body = '') {
  const out = [];
  String(body).replace(/\[\[([^\]\n]{1,300})\]\]/g, (_, t) => { const x = t.split('|')[0].trim(); if (x && !out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x); return _; });
  return out;
}
const live = (notes) => notes.filter((n) => !n.archived_at);
export const findByTitle = (notes, title) => live(notes).find((n) => n.title.trim().toLowerCase() === String(title).trim().toLowerCase()) || null;
// Notes this one links to (resolved) and titles that don't exist yet.
export function outgoing(note, notes) {
  const titles = linkTitles(note.body);
  return { linked: titles.map((t) => findByTitle(notes, t)).filter(Boolean), missing: titles.filter((t) => !findByTitle(notes, t)) };
}
// Notes that link to this one.
export const backlinks = (note, notes) => live(notes).filter((n) => n.id !== note.id && linkTitles(n.body).some((t) => t.toLowerCase() === note.title.trim().toLowerCase()));

export function searchNotes(notes, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return live(notes);
  return live(notes).filter((n) => { const h = `${n.title} ${n.body} ${n.source}`.toLowerCase(); return words.every((w) => h.includes(w)); });
}

// ---------- export: one Markdown file per note, Obsidian-ready ----------
export const fileName = (title) => `${String(title).replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'}.md`;
export function toMarkdown(n) {
  const fm = ['---', `kind: ${n.kind}`, n.source ? `source: "${String(n.source).replace(/"/g, '\\"')}"` : null, n.source_url ? `url: ${n.source_url}` : null,
    `created: ${String(n.created_at || '').slice(0, 10)}`, '---'].filter(Boolean).join('\n');
  return `${fm}\n# ${n.title}\n\n${n.body || ''}\n`;
}
// A plain ZIP (stored, no compression): enough for a folder of notes, no library needed.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files) { // [{ name, text }] → Uint8Array
  const enc = new TextEncoder();
  const chunks = []; const central = []; let offset = 0;
  const used = new Set();
  files.forEach(({ name, text }) => {
    let nm = name; for (let i = 2; used.has(nm.toLowerCase()); i++) nm = name.replace(/\.md$/, ` ${i}.md`);
    used.add(nm.toLowerCase());
    const nb = enc.encode(nm); const data = enc.encode(text); const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nb.length, true);
    chunks.push(new Uint8Array(local.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + data.length;
  });
  const cSize = central.reduce((s, x) => s + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let p = 0; all.forEach((x) => { out.set(x, p); p += x.length; });
  return out;
}
export const exportFiles = (notes) => live(notes).map((n) => ({ name: `${n.kind === 'fleeting' ? 'Fleeting/' : ''}${fileName(n.title)}`, text: toMarkdown(n) }));
