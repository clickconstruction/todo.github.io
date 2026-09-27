// Pull to refresh (phones): from the top of a list, drag down past the title and let go to reload
// from the database, the same reload the app does when it comes back to the foreground. A pill
// under the status bar says "Pull to refresh", then "Release to refresh", then spins. Never while a
// sheet is open, while typing, in Full Review, or when the list isn't at the top.
import { $ } from './state.js';

const THRESHOLD = 72; // px of pull before letting go refreshes
let el = null;
const pill = () => {
  if (!el) { el = document.createElement('div'); el.className = 'ptr'; el.setAttribute('role', 'status'); el.hidden = true; document.body.append(el); }
  return el;
};
const hide = () => { if (el) { el.hidden = true; el.classList.remove('ready', 'busy'); el.style.removeProperty('--pull'); } };
const busy = () => !!$('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') || document.body.classList.contains('fr-mode');

export function initPullToRefresh({ refresh }) {
  let startY = null; let pulled = 0; let refreshing = false;
  document.addEventListener('touchstart', (e) => {
    if (refreshing || busy() || window.scrollY > 0 || e.touches.length !== 1) { startY = null; return; }
    startY = e.touches[0].clientY; pulled = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (startY === null || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 8 || window.scrollY > 0) { pulled = 0; hide(); return; }
    pulled = dy;
    const box = pill();
    box.hidden = false;
    box.classList.toggle('ready', dy >= THRESHOLD);
    box.textContent = dy >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
    box.style.setProperty('--pull', `${Math.min(dy, THRESHOLD * 1.5)}px`);
  }, { passive: true });
  const end = async () => {
    if (startY === null) return;
    const go = pulled >= THRESHOLD;
    startY = null; pulled = 0;
    if (!go || refreshing) { hide(); return; }
    refreshing = true;
    const box = pill();
    box.classList.add('busy'); box.classList.remove('ready'); box.textContent = 'Refreshing…';
    try { await refresh(); box.textContent = 'Updated ✓'; } catch { box.textContent = 'Couldn’t refresh'; }
    setTimeout(() => { hide(); refreshing = false; }, 700);
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', () => { startY = null; pulled = 0; hide(); }, { passive: true });
}
