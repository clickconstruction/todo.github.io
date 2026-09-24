// Sidebar: views grouped by GTD step (Do, Organize, Lists, Reflect) with compact rows. Groups collapse
// (per device) and, collapsed, still show what needs you. Customize (per account, user_settings.sidebar)
// hides views you don't use and orders them within their group; pinned perspectives sit in Do.
// Phones keep the tab bar; everything else is in the More sheet, in the same groups (hidden views too).
import { db, app, $, esc, openSheet, run, sb, syncRow, toast } from './state.js';
import { saveSettings } from './prefs.js';

export const GROUPS = [
  ['do', 'Do', [['forecast', '📅', 'Forecast'], ['now', '▶️', 'What now?'], ['flagged', '🚩', 'Flagged'], ['nearby', '📍', 'Nearby']]],
  ['organize', 'Organize', [['projects', '🗂️', 'Projects'], ['tags', '🏷️', 'Tags'], ['perspectives', '🔭', 'Perspectives'], ['checklists', '☑️', 'Checklists']]],
  ['lists', 'Lists', [['waiting', '⏳', 'Waiting For'], ['someday', '💭', 'Someday/Maybe'], ['tickler', '📆', 'Tickler'], ['reference', '🗄️', 'Reference'], ['reading', '📚', 'Reading'], ['slipbox', '🗃️', 'Slipbox']]],
  ['reflect', 'Reflect', [['daily', '☀️', 'Daily review'], ['weekly', '🧭', 'Weekly Review'], ['horizons', '🏔️', 'Horizons']]],
];
// The phone tab bar and the places everything starts from can't be hidden.
const FIXED = new Set(['forecast', 'projects']);
const KEY = 'todo.nav.collapsed';

const prefs = () => ({ hidden: [], order: {}, ...((app.settings && app.settings.sidebar) || {}) });
const collapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } };
function setCollapsed(group, on) {
  const c = collapsed();
  if (on) c.add(group); else c.delete(group);
  try { localStorage.setItem(KEY, JSON.stringify([...c])); } catch { /* private mode: this session only */ }
  applySidebar();
}
const ordered = (group, items) => {
  const order = prefs().order[group] || [];
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? 100 + items.findIndex(([x]) => x === k) : i; };
  return [...items].sort((a, b) => rank(a[0]) - rank(b[0]));
};

// Apply order, hidden views and collapsed groups to the sidebar; call after badges are set.
export function applySidebar() {
  const nav = $('.tabs');
  if (!nav) return;
  const { hidden } = prefs();
  const shut = collapsed();
  GROUPS.forEach(([g, , items]) => {
    const box = nav.querySelector(`.nav-group[data-group="${g}"]`);
    if (!box) return;
    const list = box.querySelector('.nav-items');
    const pinned = list.querySelector('#nav-perspectives');
    ordered(g, items).forEach(([k]) => { const a = list.querySelector(`[data-nav="${k}"]`); if (a) list.insertBefore(a, pinned); });
    items.forEach(([k]) => { const a = list.querySelector(`[data-nav="${k}"]`); if (a) a.classList.toggle('nav-hidden', hidden.includes(k) && !FIXED.has(k)); });
    const isShut = shut.has(g);
    box.classList.toggle('collapsed', isShut);
    const head = box.querySelector('.nav-head');
    head.setAttribute('aria-expanded', String(!isShut));
    // Collapsed: what still needs you (counts on the action badges, a dot for a due review).
    const badges = [...list.querySelectorAll('a:not(.nav-hidden) .badge:not(.quiet):not(.persp)')].map((b) => b.textContent.trim()).filter(Boolean);
    const n = badges.filter((x) => /^\d+$/.test(x)).reduce((s, x) => s + Number(x), 0);
    head.querySelector('.nav-sum').innerHTML = isShut && (n || badges.length) ? `<b class="badge ${g === 'reflect' ? 'review' : g === 'lists' ? 'due' : ''}">${n || '•'}</b>` : '';
    head.title = isShut ? `Show ${items.map((x) => x[2]).join(', ')}` : '';
  });
}

document.addEventListener('click', (e) => {
  const head = e.target.closest && e.target.closest('[data-nav-group]');
  if (head) { e.preventDefault(); setCollapsed(head.dataset.navGroup, !collapsed().has(head.dataset.navGroup)); return; }
  if (e.target.closest && e.target.closest('[data-act="customize-sidebar"]') && !e.target.closest('#view')) { e.preventDefault(); openCustomize(); }
});

// ---------- Customize ----------
async function savePrefs(next) {
  app.settings = { ...app.settings, sidebar: next };
  applySidebar();
  await saveSettings({ sidebar: next }, { quiet: true });
}
function customizeHtml() {
  const { hidden } = prefs();
  const persp = (db.perspectives || []).filter((p) => !p.archived_at);
  return `<form method="dialog" class="nav-custom"><h2>Customize sidebar</h2>
    <p class="hint">Hide what you don’t use; ▲▼ orders a group. Hidden views stay in Search and the phone’s More sheet.</p>
    ${GROUPS.map(([g, label, items]) => `<h3 class="po-group">${esc(label)}</h3><ul class="nav-custom-list">${ordered(g, items).map(([k, icon, name], i, arr) => `<li class="${hidden.includes(k) ? 'off' : ''}">
      <span>${icon} ${esc(name)}</span>
      <span class="st-btns"><button type="button" class="icon-btn" data-nav-move="${k}" data-group="${g}" data-dir="-1" aria-label="Move ${esc(name)} up" ${i === 0 ? 'disabled' : ''}>▲</button><button type="button" class="icon-btn" data-nav-move="${k}" data-group="${g}" data-dir="1" aria-label="Move ${esc(name)} down" ${i === arr.length - 1 ? 'disabled' : ''}>▼</button>
      ${FIXED.has(k) ? '<span class="hint">always shown</span>' : `<button type="button" class="btn small" data-nav-toggle="${k}">${hidden.includes(k) ? 'Show' : 'Hide'}</button>`}</span></li>`).join('')}</ul>`).join('')}
    <h3 class="po-group">Pinned perspectives <span class="hint">(in Do)</span></h3>
    ${persp.length ? `<ul class="nav-custom-list">${persp.map((p) => `<li><label><input type="checkbox" data-nav-pin="${p.id}" ${p.pinned !== false ? 'checked' : ''}> ${esc(p.icon)} ${esc(p.name)}</label></li>`).join('')}</ul>` : '<p class="hint">No perspectives yet.</p>'}
    <div class="actions"><button type="button" class="btn" data-nav-reset>Reset to default</button><div class="right"><button class="btn primary">Done</button></div></div></form>`;
}
export function openCustomize() {
  const sheet = openSheet(customizeHtml());
  // Handlers live on the form (the sheet <dialog> is shared by every editor), redrawn in place.
  const wire = () => { const f = $('.nav-custom', sheet); f.onclick = onClick; f.onchange = onChange; };
  const redraw = () => { sheet.innerHTML = customizeHtml(); wire(); };
  const onClick = async (e) => {
    const t = e.target.closest('[data-nav-toggle]');
    const mv = e.target.closest('[data-nav-move]');
    if (t) {
      const p = prefs(); const k = t.dataset.navToggle;
      await savePrefs({ ...p, hidden: p.hidden.includes(k) ? p.hidden.filter((x) => x !== k) : [...p.hidden, k] });
      redraw();
    } else if (mv) {
      const p = prefs(); const g = mv.dataset.group;
      const keys = ordered(g, GROUPS.find(([x]) => x === g)[2]).map(([k]) => k);
      const i = keys.indexOf(mv.dataset.navMove); const j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= keys.length) return;
      [keys[i], keys[j]] = [keys[j], keys[i]];
      await savePrefs({ ...p, order: { ...p.order, [g]: keys } });
      redraw();
    } else if (e.target.closest('[data-nav-reset]')) {
      await savePrefs({});
      redraw();
    }
  };
  const onChange = async (e) => {
    const pin = e.target.closest('[data-nav-pin]');
    if (!pin) return;
    const p = (db.perspectives || []).find((x) => x.id === pin.dataset.navPin);
    const [row] = await run(sb.from('perspectives').update({ pinned: pin.checked }).eq('id', p.id).select());
    syncRow('perspectives', p, row);
    app.render();
    toast(pin.checked ? `Pinned “${p.name}”` : `Unpinned “${p.name}”`);
  };
  wire();
  sheet.showModal();
}

// ---------- Phones: the More sheet, grouped the same way ----------
export function moreSheetHtml({ badges = {}, perspectives = [], focusLine = '' }) {
  const onBar = new Set(['forecast', 'flagged', 'projects']);
  return `<form method="dialog" class="more-sheet">${focusLine}
    ${GROUPS.map(([g, label, items]) => {
      const rows = ordered(g, items).filter(([k]) => !onBar.has(k)).map(([k, icon, name]) => `<a href="#${k}" data-more-link><span>${icon}</span><i class="ml">${esc(name)}</i>${badges[k] || ''}</a>`);
      const extra = g === 'do' ? perspectives.map(([href, icon, lbl]) => `<a href="${href}" data-more-link><span>${icon}</span><i class="ml">${lbl}</i></a>`) : [];
      const tail = g === 'reflect' ? ['<a href="#sweep" data-more-link><span>🧹</span>Mind sweep</a>'] : [];
      const all = [...rows, ...extra, ...tail];
      return all.length ? `<h2>${esc(label)}</h2><nav class="more-links">${all.join('')}</nav>` : '';
    }).join('')}
    <h2>More</h2><nav class="more-links"><a href="#search" data-more-link><span>🔍</span>Search</a><a href="#done" data-more-link><span>✅</span>Done</a><a href="#alerts" data-more-link><span>🔔</span>Alerts</a><a href="#settings" data-more-link><span>⚙️</span>Settings</a></nav>
    <div class="actions"><div class="right"><button class="btn">Close</button></div></div></form>`;
}
