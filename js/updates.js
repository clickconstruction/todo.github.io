// New versions, without interrupting. The service worker downloads a new version in the background and
// waits; this module switches to it at the first safe moment:
//   1. the app goes into the background (nobody sees the reload),
//   2. you change screens (the page is changing anyway),
//   3. a minute with nothing happening.
// Safe = no sheet or editor open, not typing, no unsaved panel edits, no database call in flight, and
// nothing in memory a reload would lose (a running import, a Clarify session's Undo, Settle in cards).
// Afterwards you're back on the same screen, scroll position and selection, with "Updated ✓".
// If it's never safe, "Update ready · Reload" stays in the sidebar (and on the phone's More button).
// A release can set a minimum version (sw.js MIN_VERSION): older pages switch at the next moment that is
// merely not mid-typing, after a short heads-up.
import { app, $, toast, inflight } from './state.js';

const CHECK_EVERY = 30 * 60000; // quietly ask for a new version
const NAV_CHECK_GAP = 5 * 60000; // on screen changes, at most this often
const IDLE = 60000; // a minute with nothing happening
const RESUME_KEY = 'todo.resume';
const num = (v) => Number(String(v || '').replace(/^v/, '')) || 0;

const U = { reg: null, waiting: null, force: false, applying: false, lastCheck: 0, lastInput: Date.now(), controllerChanged: false, hadController: false };
export const updateState = () => U;

// ---------- is it safe right now? ----------
const typing = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (!el.getClientRects().length) return false; // focus left behind in a closed sheet
  if (el.isContentEditable) return true;
  if (!/INPUT|TEXTAREA|SELECT/.test(el.tagName)) return false;
  return !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
};
const sheetOpen = () => ['#sheet', '#sheet2'].some((s) => { const d = $(s); return d && d.open; });
const panelDirty = () => { const st = $('#inspector .save-state'); return !!st && /Editing|Saving/.test(st.textContent); };
function inMemoryWork() {
  const h = location.hash;
  if (h.startsWith('#clarify') && app.clarify && app.clarify.history && app.clarify.history.length) return 'clarify';
  if (/^#settle\/[^/]+\/cards\//.test(h) && app.settleUi && app.settleUi.cardUndo && app.settleUi.cardUndo.length) return 'settle';
  if (U.importBusy && U.importBusy()) return 'import';
  return '';
}
// → '' when safe, otherwise why not (for tests and the console).
export function busyReason({ forced = false } = {}) {
  if (typing()) return 'typing';
  if (panelDirty()) return 'unsaved';
  if (inflight.n > 0) return 'saving';
  if (U.importBusy && U.importBusy()) return 'import'; // never, not even forced
  if (forced) return '';
  if (sheetOpen()) return 'sheet';
  return inMemoryWork();
}

// ---------- switching ----------
function saveContext() {
  const s = app.selected;
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ hash: location.hash, y: window.scrollY, selected: s || null, at: Date.now() })); } catch { /* private mode */ }
}
export function tryApply(reason = 'manual') {
  if (U.applying || (!U.waiting && !U.controllerChanged)) return false;
  // Your tap on "Update ready" counts like a forced update: only typing, unsaved edits or a save in flight wait.
  const blocked = busyReason({ forced: U.force || reason === 'manual' });
  if (blocked) { if (reason === 'manual') toast(blocked === 'import' ? 'Updating after the import finishes' : 'Updating as soon as this is saved'); return false; }
  U.applying = true;
  U.reason = reason;
  saveContext();
  if (U.controllerChanged || !U.waiting) { window.__reload ? window.__reload() : location.reload(); return true; } // another tab already switched
  U.waiting.postMessage({ type: 'SKIP_WAITING' }); // → controllerchange → reload
  if (window.__reload) window.__reload(); // tests
  return true;
}

// Back on the same screen after an update: scroll, selection, and a quiet note.
export function resumeAfterUpdate() {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null'); sessionStorage.removeItem(RESUME_KEY); } catch { r = null; }
  if (!r || Date.now() - r.at > 2 * 60000) return false;
  if (r.hash && r.hash !== location.hash) location.hash = r.hash;
  requestAnimationFrame(() => {
    window.scrollTo(0, r.y || 0);
    if (r.selected) import('./inspector.js').then(({ select }) => select(r.selected.type, r.selected.id)).catch(() => {});
  });
  toast('Updated ✓');
  return true;
}

// ---------- "Update ready" (when it's never safe) ----------
function showReady() {
  document.body.classList.add('update-ready');
  const b = $('#nav-update');
  if (b) b.hidden = false;
}
export function onWaiting(worker) {
  U.waiting = worker;
  showReady();
  // Must this page switch soon? (the new version's minimum vs the version running now)
  const running = navigator.serviceWorker && navigator.serviceWorker.controller;
  const ask = (w) => new Promise((res) => { try { const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data); w.postMessage({ type: 'INFO' }, [ch.port2]); setTimeout(() => res(null), 3000); } catch { res(null); } });
  Promise.all([ask(worker), running ? ask(running) : null]).then(([next, cur]) => {
    if (next && cur && num(cur.version) < num(next.min)) {
      U.force = true;
      toast('An important update is ready: switching in a moment');
    }
    if (U.force || Date.now() - U.lastInput > 15000) tryApply('ready'); // not while you're mid-click
  });
}

function check() {
  U.lastCheck = Date.now();
  if (U.reg) U.reg.update().catch(() => {});
}

// ---------- wiring ----------
export function initUpdates({ importBusy } = {}) {
  U.importBusy = importBusy;
  const b = $('#nav-update');
  if (b) b.onclick = () => tryApply('manual');
  ['keydown', 'pointerdown', 'wheel', 'touchstart', 'input'].forEach((ev) => document.addEventListener(ev, () => { U.lastInput = Date.now(); }, { passive: true, capture: true }));
  // 1. into the background
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') tryApply('hidden');
    else if (Date.now() - U.lastCheck > 60000) check();
  });
  // 2. a screen change
  window.addEventListener('hashchange', () => {
    if (!tryApply('navigate') && Date.now() - U.lastCheck > NAV_CHECK_GAP) check();
  });
  // 3. a quiet minute (and the regular check); forced updates retry sooner
  setInterval(() => {
    if (U.force) tryApply('forced');
    else if (Date.now() - U.lastInput > IDLE) tryApply('idle');
    if (Date.now() - U.lastCheck > CHECK_EVERY) check();
  }, 10000);

  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!('serviceWorker' in navigator) || isLocal) return;
  U.hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    U.reg = reg;
    U.lastCheck = Date.now();
    if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) onWaiting(w); });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!U.hadController) return; // first install: nothing stale to replace
    if (U.applying) { location.reload(); return; }
    // Another tab switched (or an old worker skipped waiting): this page is now stale; switch when safe.
    U.controllerChanged = true;
    showReady();
    if (Date.now() - U.lastInput > 15000) tryApply('ready');
  });
}

// Tests only: start over (dev/smoke.js).
export function __resetUpdates() {
  Object.assign(U, { waiting: null, force: false, applying: false, controllerChanged: false, reason: null, lastInput: Date.now() });
  document.body.classList.remove('update-ready');
  const b = $('#nav-update');
  if (b) b.hidden = true;
}
