// Searchable dropdowns: any <select> with more than 12 choices (or data-searchable) opens a small search
// popover instead of the long native list, e.g. picking one of 100+ projects. Type any part of any word
// ("orb" finds "Space Feeder (Orbital Foundries)"); ↑/↓ move, Return picks, Esc closes. The <select> stays
// the source of truth: picking sets its value and fires input + change, so every existing handler works.
// Opt out with data-no-search.
const MIN_OPTIONS = 12;
let pop = null, current = null, items = [], active = -1;

const qualifies = (el) => el && el.tagName === 'SELECT' && !el.multiple && !el.disabled && !el.hasAttribute('data-no-search')
  && (el.hasAttribute('data-searchable') || el.options.length > MIN_OPTIONS);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function entries(sel) {
  const out = [];
  for (const node of sel.children) {
    if (node.tagName === 'OPTGROUP') {
      out.push({ group: node.label });
      for (const o of node.children) if (o.tagName === 'OPTION') out.push({ o, groupLabel: node.label });
    } else if (node.tagName === 'OPTION') out.push({ o: node });
  }
  return out;
}

// Every query word must appear somewhere; names where a word starts with the query rank first.
function score(label, words) {
  const n = norm(label);
  if (!words.every((w) => n.includes(w))) return -1;
  return (n.startsWith(words[0]) ? 0 : (' ' + n).includes(' ' + words[0]) ? 1 : 2);
}

function draw(q) {
  const words = norm(q).split(' ').filter(Boolean);
  const list = pop.querySelector('.ss-list');
  let rows = [];
  if (!words.length) {
    rows = entries(current).filter((e) => e.group || !e.o.disabled);
  } else {
    rows = entries(current).filter((e) => e.o && !e.o.disabled).map((e) => ({ ...e, s: score(e.o.textContent, words) }))
      .filter((e) => e.s >= 0).sort((a, b) => a.s - b.s);
  }
  items = rows.filter((e) => e.o);
  const val = current.value;
  active = Math.max(0, items.findIndex((e) => e.o.value === val && words.length === 0));
  if (words.length) active = items.length ? 0 : -1;
  list.innerHTML = rows.length ? rows.map((e) => e.group
    ? `<li class="ss-group" role="presentation">${escHtml(e.group)}</li>`
    : `<li class="ss-opt${e.o.value === val ? ' ss-cur' : ''}" role="option" id="ss-o${items.indexOf(e)}" data-i="${items.indexOf(e)}" aria-selected="${e.o.value === val}">${escHtml(e.o.textContent.trim() || '—')}${words.length && e.groupLabel ? `<small>${escHtml(e.groupLabel)}</small>` : ''}</li>`).join('')
    : '<li class="ss-empty">No matches</li>';
  mark();
}

function mark() {
  pop.querySelectorAll('.ss-opt').forEach((li) => li.classList.toggle('ss-active', Number(li.dataset.i) === active));
  const a = pop.querySelector('.ss-active');
  pop.querySelector('input').setAttribute('aria-activedescendant', a ? a.id : '');
  if (a) a.scrollIntoView({ block: 'nearest' });
}

function place() {
  const r = current.getBoundingClientRect();
  const w = Math.max(r.width, 260), h = Math.min(360, innerHeight - 24);
  pop.style.width = Math.min(w, innerWidth - 16) + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - Math.min(w, innerWidth - 16) - 8)) + 'px';
  const below = innerHeight - r.bottom - 8, above = r.top - 8;
  pop.style.maxHeight = Math.max(160, Math.min(h, below >= 220 || below >= above ? below : above)) + 'px';
  if (below >= 220 || below >= above) { pop.style.top = r.bottom + 4 + 'px'; pop.style.bottom = ''; }
  else { pop.style.bottom = innerHeight - r.top + 4 + 'px'; pop.style.top = ''; }
}

function open(sel, seed = '') {
  close(false);
  current = sel;
  const label = (sel.closest('label') && sel.closest('label').firstChild && sel.closest('label').firstChild.textContent) || sel.getAttribute('aria-label') || '';
  pop = document.createElement('div');
  pop.className = 'ss-pop';
  pop.innerHTML = `<input type="search" class="ss-q" placeholder="Search${label.trim() ? ' ' + escHtml(label.trim().toLowerCase()) : ''}…" aria-label="Search the list" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="ss-list"><ul class="ss-list" id="ss-list" role="listbox"></ul>`;
  (sel.closest('dialog[open]') || document.body).appendChild(pop);
  sel.setAttribute('aria-expanded', 'true');
  place();
  const q = pop.querySelector('input');
  q.value = seed;
  draw(seed);
  q.focus();
  q.addEventListener('input', () => draw(q.value));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { active = (active + 1) % items.length; mark(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; mark(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) pick(items[active].o); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  });
  pop.addEventListener('pointerdown', (e) => { const li = e.target.closest('.ss-opt'); if (li) { e.preventDefault(); pick(items[Number(li.dataset.i)].o); } });
  pop.addEventListener('pointermove', (e) => { const li = e.target.closest('.ss-opt'); if (li && Number(li.dataset.i) !== active) { active = Number(li.dataset.i); mark(); } });
}

function pick(o) {
  const sel = current;
  close(false);
  if (sel.value !== o.value) {
    sel.value = o.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  sel.focus({ preventScroll: true });
}

function close(refocus) {
  if (!pop) return;
  const sel = current;
  pop.remove(); pop = null; current = null; items = []; active = -1;
  if (sel) { sel.removeAttribute('aria-expanded'); if (refocus) sel.focus({ preventScroll: true }); }
}

// Open instead of the native list: mouse/pen press, touch tap, or keyboard (Return, Space, Alt+↓, or a letter).
document.addEventListener('mousedown', (e) => {
  const sel = e.target.closest && e.target.closest('select');
  if (e.button === 0 && qualifies(sel)) { e.preventDefault(); if (current === sel) close(true); else { sel.focus({ preventScroll: true }); open(sel); } }
}, true);
document.addEventListener('touchend', (e) => {
  const sel = e.target.closest && e.target.closest('select');
  if (qualifies(sel)) { e.preventDefault(); open(sel); }
}, { capture: true, passive: false });
document.addEventListener('keydown', (e) => {
  const sel = e.target;
  if (!qualifies(sel) || pop) return;
  if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); open(sel); }
  else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); open(sel, e.key); }
}, true);
document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && e.target !== current) close(false); }, true);
addEventListener('resize', () => close(false));
document.addEventListener('scroll', (e) => { if (pop && !pop.contains(e.target)) place(); }, true);
