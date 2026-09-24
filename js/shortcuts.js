// Keyboard shortcuts: one list drives the key handler, the "?" overlay and Settings → Keyboard.
// Plain keys (like Gmail) because browsers keep ⌘N, ⌘1…9 and ⌘L for themselves. Nothing fires
// while you're typing in a field or a sheet is open (except Esc).
import { db, app, $, byId, openSheet, esc, toast, run, sb, syncRow } from './state.js';
import { startOfToday, addDays, atDefaultTime } from './dates.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

const selectedTask = () => (app.selected && app.selected.type === 'task' ? byId(db.tasks, app.selected.id) : null);
const clickIn = (sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };
const needTask = (fn) => () => { const t = selectedTask(); if (!t) { toast('Select an item first (j / k or ↓ / ↑)'); return; } fn(t); };

async function patch(t, fields, label) {
  const before = Object.fromEntries(Object.keys(fields).map((k) => [k, t[k] ?? null]));
  const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select());
  syncRow('tasks', t, row);
  app.render();
  toast(label, [{ label: 'Undo', run: async () => { const [r] = await run(sb.from('tasks').update(before).eq('id', t.id).select()); syncRow('tasks', t, r); app.render(); } }]);
}

// handlers are filled in by main.js (they need modules main already loads)
export const H = {};

// key: what KeyboardEvent.key is; shift: needs Shift (for letters); group: where it shows.
export const SHORTCUTS = [
  { key: 'n', group: 'Anywhere', label: 'Capture to the Inbox', run: () => H.capture() },
  { key: 'N', shift: true, group: 'Anywhere', label: 'New project', run: () => H.newProject() },
  { key: '/', group: 'Anywhere', label: 'Search', run: () => { location.hash = '#search'; } },
  { key: 'F', shift: true, group: 'Anywhere', label: 'Focus (on the selected item’s project, or choose)', run: () => { const t = selectedTask(); if (t && t.project_id) H.focusOn(t.project_id); else H.focusPicker(); } },
  { key: 'U', shift: true, group: 'Anywhere', label: 'Unfocus (show everything)', run: () => H.unfocus() },
  { key: '?', shift: true, group: 'Anywhere', label: 'Show keyboard shortcuts', run: () => openShortcuts() },
  { key: '1', group: 'Go to', label: 'Inbox', run: () => { location.hash = '#inbox'; } },
  { key: '2', group: 'Go to', label: 'Forecast', run: () => { location.hash = '#forecast'; } },
  { key: '3', group: 'Go to', label: 'Flagged', run: () => { location.hash = '#flagged'; } },
  { key: '4', group: 'Go to', label: 'Projects', run: () => { location.hash = '#projects'; } },
  { key: '5', group: 'Go to', label: 'Tags', run: () => { location.hash = '#tags'; } },
  { key: '6', group: 'Go to', label: 'Weekly Review', run: () => { location.hash = '#weekly'; } },
  { key: '7', group: 'Go to', label: 'Perspectives', run: () => { location.hash = '#perspectives'; } },
  { key: '8', group: 'Go to', label: 'Nearby', run: () => { location.hash = '#nearby'; } },
  { key: '9', group: 'Go to', label: 'Done', run: () => { location.hash = '#done'; } },
  { key: '0', group: 'Go to', label: 'Settings', run: () => { location.hash = '#settings'; } },
  { key: '.', group: 'Go to', label: 'What now?', run: () => { location.hash = '#now'; } },
  { key: 'g', group: 'Go to', label: 'Daily review (start your day / shut down)', run: () => { location.hash = '#daily'; } },
  { key: 'H', shift: true, group: 'Go to', label: 'Horizons', run: () => { location.hash = '#horizons'; } },
  { key: 'c', group: 'Go to', label: 'Clarify: process the Inbox', run: () => { location.hash = '#clarify'; } },
  { key: 'w', group: 'Go to', label: 'Waiting For', run: () => { location.hash = '#waiting'; } },
  { key: 'r', group: 'Go to', label: 'Reference', run: () => { location.hash = '#reference'; } },
  { key: 'T', shift: true, group: 'Go to', label: 'Tickler', run: () => { location.hash = '#tickler'; } },
  { key: 'S', shift: true, group: 'Go to', label: 'Someday/Maybe', run: () => { location.hash = '#someday'; } },
  { key: 'M', shift: true, group: 'Go to', label: 'Mind sweep', run: () => { location.hash = '#sweep'; } },
  { key: 'j', alt: 'ArrowDown', group: 'Lists', label: 'Select the next item', run: () => H.move(1) },
  { key: 'k', alt: 'ArrowUp', group: 'Lists', label: 'Select the previous item', run: () => H.move(-1) },
  { key: 'e', alt: 'Enter', group: 'Lists', label: 'Open the selected item', run: needTask((t) => H.open(t)) },
  { key: 'Escape', group: 'Lists', label: 'Clear the selection / close', run: () => H.clear() },
  { key: 'x', group: 'Selected item', label: 'Complete (or reopen)', run: needTask((t) => clickIn(`#view [data-check="${t.id}"]`)) },
  { key: 'f', group: 'Selected item', label: 'Flag or unflag', run: needTask((t) => { if (!clickIn(`#view [data-flag="${t.id}"]`)) patch(t, { flagged: !t.flagged }, t.flagged ? 'Unflagged' : 'Flagged'); }) },
  { key: 'p', group: 'Selected item', label: 'Plan for today', run: needTask((t) => patch(t, { planned_at: atDefaultTime(startOfToday(), 'planned_at').toISOString() }, 'Planned for today')) },
  { key: 'd', group: 'Selected item', label: 'Defer until tomorrow', run: needTask((t) => patch(t, { defer_at: atDefaultTime(addDays(startOfToday(), 1), 'defer_at').toISOString() }, 'Deferred until tomorrow')) },
  { key: 'D', shift: true, group: 'Selected item', label: 'Drop (with Undo)', run: needTask((t) => patch(t, { dropped_at: new Date().toISOString() }, `Dropped “${t.title}”`)) },
  { key: 'a', group: 'Selected item', label: 'Delegate (waiting on someone)', run: needTask((t) => H.delegate(t)) },
  { key: 't', group: 'Selected item', label: 'Tickle: back in the Inbox on a day', run: needTask((t) => H.tickle(t)) },
  { key: 'b', group: 'Selected item', label: 'Break it down into steps', run: needTask((t) => H.breakdown(t)) },
  { key: ']', group: 'Selected item', label: 'Make it a step of the item above', run: needTask((t) => H.indent(t)) },
  { key: '[', group: 'Selected item', label: 'Move it up a level', run: needTask((t) => H.outdent(t)) },
  { key: `${MOD}+Enter`, group: 'Editing', label: 'Save now (inspector and sheets)', passive: true },
  { key: 'Esc', group: 'Editing', label: 'Close the open row or sheet', passive: true },
  { key: 'j k m', group: 'Review', label: 'Previous / next project, mark reviewed', passive: true },
  { key: '1–8', group: 'Clarify', label: 'Next action · Do it now · Delegate · Project · Someday · Tickler · Trash · Reference', passive: true },
  { key: 's z', group: 'Clarify', label: 'Skip · undo the last decision', passive: true },
];

const typing = () => { const el = document.activeElement; return el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)); };

export function handleKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key === 'Escape') { if ($('#sheet').open || $('#sheet2').open) return false; H.clear(); return true; }
  if (typing() || $('#sheet').open || $('#sheet2').open) return false;
  if (location.hash.startsWith('#review') && ['j', 'k', 'm'].includes(e.key)) return false; // Review has its own j/k/m
  const s = SHORTCUTS.find((x) => !x.passive && (x.key === e.key || x.alt === e.key));
  if (!s) return false;
  e.preventDefault();
  s.run();
  return true;
}

// ---------- the drawn keyboard ----------
const ROWS = [
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", 'Enter'],
  ['Shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 'Shift'],
];
const SHIFTED = { '/': '?' };
const labelFor = (k) => ({ Enter: '⏎', Shift: '⇧', Escape: 'Esc' }[k] || k);
// Every shortcut that uses this physical key (plain and with Shift).
export function shortcutsOn(k) {
  const lower = k.toLowerCase();
  return SHORTCUTS.filter((s) => !s.passive && (s.key.toLowerCase() === lower || s.key === SHIFTED[k] || (s.alt === 'Enter' && k === 'Enter')));
}

export function keyboardHtml() {
  return `<div class="kbd" role="group" aria-label="Keyboard: highlighted keys have shortcuts">
    <div class="kbd-row"><button type="button" class="kbd-key ${shortcutsOn('Escape').length ? 'on' : ''}" data-kbd="Escape">Esc</button></div>
    ${ROWS.map((row, r) => `<div class="kbd-row" style="--indent:${r}">${row.map((k) => {
      const on = shortcutsOn(k).length || (k === 'Shift' && SHORTCUTS.some((s) => s.shift));
      return `<button type="button" class="kbd-key ${on ? 'on' : ''} ${k.length > 1 ? 'wide' : ''}" data-kbd="${esc(k)}" aria-label="${esc(k)}${on ? ': has shortcuts' : ''}">${esc(labelFor(k))}</button>`;
    }).join('')}</div>`).join('')}
    <div class="kbd-row arrows"><button type="button" class="kbd-key on" data-kbd="ArrowUp">↑</button><button type="button" class="kbd-key on" data-kbd="ArrowDown">↓</button></div>
    <div class="kbd-tip" data-kbd-tip aria-live="polite">Hover or tap a highlighted key.</div>
  </div>`;
}

export function shortcutListHtml() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  const keyText = (s) => [s.key === 'Escape' ? 'Esc' : s.key, s.alt && ({ ArrowDown: '↓', ArrowUp: '↑', Enter: '⏎' }[s.alt] || s.alt)].filter(Boolean)
    .map((k) => `<kbd>${esc(s.shift && /^[A-Z]$/.test(k) ? `⇧${k}` : k)}</kbd>`).join(' ');
  return groups.map((g) => `<h3 class="kbd-group">${esc(g)}</h3><dl class="kbd-list">${SHORTCUTS.filter((s) => s.group === g).map((s) => `<dt>${keyText(s)}</dt><dd>${esc(s.label)}</dd>`).join('')}</dl>`).join('');
}

export function tipFor(k) {
  if (k === 'Shift') return '⇧ Shift with a letter: N new project · F focus · U unfocus · D drop · T tickler · S someday · M mind sweep · H horizons · ? this list';
  if (k === 'ArrowUp' || k === 'ArrowDown') return `${k === 'ArrowUp' ? '↑' : '↓'}: select the ${k === 'ArrowUp' ? 'previous' : 'next'} item`;
  const list = shortcutsOn(k);
  if (!list.length) return `${labelFor(k)}: no shortcut`;
  return list.map((s) => `${s.shift ? '⇧' : ''}${s.key === 'Escape' ? 'Esc' : s.alt === 'Enter' && k === 'Enter' ? '⏎' : s.key}: ${s.label}`).join(' · ');
}

// Hover, tap or keyboard-focus a key to see what it does (one listener for every drawn keyboard).
const showTip = (e) => {
  const b = e.target.closest && e.target.closest('[data-kbd]');
  const kbd = b && b.closest('.kbd');
  if (!kbd) return;
  const tip = kbd.querySelector('[data-kbd-tip]');
  if (tip) tip.textContent = tipFor(b.dataset.kbd);
  kbd.querySelectorAll('.kbd-key.sel').forEach((x) => x.classList.remove('sel'));
  b.classList.add('sel');
};
['mouseover', 'click', 'focusin'].forEach((ev) => document.addEventListener(ev, showTip));

export function openShortcuts() {
  const sheet = openSheet(`<form method="dialog" class="kbd-sheet"><h2>Keyboard shortcuts</h2>
    ${keyboardHtml()}
    <div class="kbd-lists">${shortcutListHtml()}</div>
    <p class="hint">Also in Settings → Keyboard. Shortcuts don’t fire while you’re typing.</p>
    <div class="actions"><div class="right"><button class="btn">Close</button></div></div></form>`);
  sheet.classList.add('full');
  sheet.showModal();
}

