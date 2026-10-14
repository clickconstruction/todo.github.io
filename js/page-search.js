// Search on every page: a box in the title row that first searches the page you're on, and always offers
// everything. Typing hides the rows that don't match and shows two pills, "This page · n" and
// "Everything · n" (the Search view's results, js/views/search.js). When nothing on the page matches it
// switches to everything on its own, drawn in place under the title, so clearing the box brings the page
// back. The sidebar's Search opens it in Everything scope; the phone's search bubble, / and s open it as
// it is. Esc clears, then closes; Enter opens the first match.
// Every draw replaces #view, so the box is rebuilt each time: its text, scope and focus live in
// app.pageSearch and are put back after the draw. A different page starts it clean.
import { app, $, esc } from './state.js';

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
import { searchResultsHtml, searchCount, searchServer } from './views/search.js';

const ROWS = 'li.row, .group-row, .dv-row, .six-row, .six-now, .persp-row, .tl-row, .rd-row, .cal-row';
const ROWS_SHOWN = ROWS.split(', ').map((s) => `${s}:not(.ps-hide)`).join(', ');
const HEADS = '.section-title, .po-group';
const KEEP = '.focus-banner, .view-head, .ps-line, .ps-empty, #ps-results';
const NO_BOX = new Set(['search', 'full', 'sheets']); // their own search, or no page to search
const S = () => (app.pageSearch ||= { q: '', scope: 'auto', hash: '', focused: false, open: false, fetched: '' });
const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
let serverTimer;

// Put the box in the title row of the page just drawn, and apply what was typed before the draw.
export function mountPageSearch() {
  const st = S();
  if (st.hash !== location.hash) Object.assign(st, { q: '', scope: 'auto', hash: location.hash, open: false, focused: false, fetched: '' }); // a new page: clean, and the keys are the page's again
  if (NO_BOX.has((location.hash.slice(1) || 'inbox').split('/')[0])) return;
  const head = $('#view .view-head');
  if (!head || $('.ps', head)) return;
  const h1 = $('h1', head);
  const box = `<label class="ps${st.open ? ' open' : ''}"><span class="ps-glyph" aria-hidden="true">🔍</span><input type="text" class="ps-input" inputmode="search" enterkeyhint="search" autocomplete="off" spellcheck="false" aria-label="Search this page, or everything" value="${esc(st.q)}"><button type="button" class="ps-x" aria-label="Clear the search">✕</button><kbd class="ps-kbd" title="Press / or s to search">/</kbd></label>`;
  if (h1) h1.insertAdjacentHTML('afterend', box); else head.insertAdjacentHTML('beforeend', box);
  const input = $('.ps-input', head); // handlers read S() fresh: the state outlives this box
  input.oninput = () => { S().q = input.value; apply(); };
  input.onfocus = () => { S().focused = true; };
  input.onblur = (e) => { if (e.target.isConnected) S().focused = false; }; // a draw took it away: still "focused", put it back
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); if (S().q) clear(); else { S().open = false; input.blur(); apply(); } }
    else if (e.key === 'Enter') { e.preventDefault(); openFirst(); }
  };
  $('.ps-x', head).onclick = () => { if (S().q) { clear(); input.focus(); } else { S().open = false; apply(); } };
  apply();
  if (st.focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

// The sidebar's Search, the phone's bubble, / and s: focus the box (Everything scope for the sidebar).
// A page with no title row (the Full Review) goes to the Search page instead.
export function openPageSearch({ scope } = {}) {
  const st = S();
  if (scope) st.scope = scope;
  st.open = true;
  if (!$('#view .ps')) mountPageSearch();
  const input = $('#view .ps-input');
  if (!input) { location.hash = '#search'; return false; }
  apply();
  input.focus(); input.select();
  return true;
}

function clear() { const st = S(); st.q = ''; st.scope = 'auto'; st.fetched = ''; const i = $('#view .ps-input'); if (i) i.value = ''; apply(); }

// What the page shows for the box as it is: rows hidden or everything drawn in place, the pills, the hint.
function apply() {
  const st = S();
  const root = $('#view');
  const box = root && $('.ps', root);
  if (!box) return;
  const head = $('.view-head', root);
  const input = $('.ps-input', box);
  const ws = words(st.q);
  $$('.ps-hide', root).forEach((el) => el.classList.remove('ps-hide'));
  $$('.ps-line, .ps-empty, #ps-results', root).forEach((el) => el.remove());
  box.classList.toggle('has-q', ws.length > 0);
  box.classList.toggle('open', st.open || ws.length > 0);
  const rows = $$(ROWS, root).filter((r) => !r.closest('#ps-results'));
  const everything = st.scope === 'all' || !rows.length; // a page with nothing to search in (Settings, a card) searches everything
  input.placeholder = everything ? 'Search everything…' : 'Search this page…';
  if (!ws.length) return;
  const hits = rows.filter((r) => { const t = r.textContent.toLowerCase(); return ws.every((w) => t.includes(w)); });
  const nAll = searchCount(st.q);
  const scope = st.scope === 'auto' ? (hits.length ? 'page' : 'all') : st.scope;
  const seg = (k, label, n) => `<button type="button" class="ps-seg ${scope === k ? 'on' : ''}" data-ps-scope="${k}" aria-pressed="${scope === k}">${label} · ${n || 'none'}</button>`;
  const note = scope === 'all' ? (hits.length ? 'Everything in your library.' : rows.length ? 'Nothing on this page matches, so this is everything.' : '') : 'What matches on this page.';
  head.insertAdjacentHTML('afterend', `<div class="ps-line" role="status">${seg('page', 'This page', hits.length)}${seg('all', 'Everything', nAll)}<span class="ps-note">${note}</span><span class="ps-esc"><kbd>esc</kbd> clears · <kbd>⏎</kbd> opens the first</span></div>`);
  $$('.ps-seg', root).forEach((b) => { b.onclick = () => { st.scope = b.dataset.psScope; apply(); input.focus(); }; });
  const line = $('.ps-line', root);
  if (scope === 'page') {
    rows.forEach((r) => { if (!hits.includes(r)) r.classList.add('ps-hide'); });
    // A heading with nothing left under it goes too, and so does an emptied list.
    $$(HEADS, root).forEach((h) => {
      let el = h.nextElementSibling; let any = false;
      while (el && !el.matches(HEADS)) { if ((el.matches(ROWS) && !el.classList.contains('ps-hide')) || el.querySelector(ROWS_SHOWN)) { any = true; break; } el = el.nextElementSibling; }
      if (!any) h.classList.add('ps-hide');
    });
    $$('ul.list, .group-list', root).forEach((l) => { if (!l.querySelector(ROWS_SHOWN)) l.classList.add('ps-hide'); });
    if (!hits.length) line.insertAdjacentHTML('afterend', `<p class="empty ps-empty">Nothing on this page matches “${esc(st.q)}”.</p>`);
    return;
  }
  [...root.children].forEach((el) => { if (!el.matches(KEEP) && !el.contains(head)) el.classList.add('ps-hide'); });
  line.insertAdjacentHTML('afterend', `<div id="ps-results" class="ps-results">${searchResultsHtml(st.q)}</div>`);
  // Completed and dropped actions come from the server; the results and the count follow when they arrive.
  if (st.fetched !== st.q) {
    const q = st.q; st.fetched = q;
    clearTimeout(serverTimer);
    serverTimer = setTimeout(() => searchServer(q, () => { if (S().q === q && $('#ps-results')) apply(); }), 250);
  }
}

// Enter: the first match, on the page or in everything (a row opens; a link goes).
function openFirst() {
  const root = $('#view');
  const res = $('#ps-results', root);
  const first = res ? $('.tally a, li.row, .sr-row', res) : $(ROWS_SHOWN, root);
  if (!first) return;
  if (first.matches('a[href]')) { location.hash = first.getAttribute('href'); return; }
  if (first.dataset.task && app.openTask) { app.openTask(first.dataset.task); return; }
  const a = $('a[href]', first);
  if (a) location.hash = a.getAttribute('href'); else first.click();
}

// The sidebar's Search and the phone's bubble sit outside #view: they open the box instead of the Search page.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.nav-tool[href="#search"], a.search-fab');
  if (!a) return;
  e.preventDefault();
  openPageSearch(a.classList.contains('search-fab') ? {} : { scope: 'all' });
});
