// Todo Tooling entry point: event wiring, auth, service worker.
import { sb, db, app, $, byId, isOpen, toggleCollapsed, toast } from './state.js';
import { render } from './router.js';
import { loadAll, flushOutbox, capture, setCompleted, createTag, updateProject, updateTask, moveTask, bulkUpdate, markReviewed, indentTask, outdentTask } from './data.js';
import { openBreakdown } from './editors/breakdown.js';
import { descendants } from './tree.js';
import { reviewQueue, remainingIds, reviewDueCount } from './views/review.js';
import { startOfToday } from './dates.js';
import { forecastData } from './views/forecast.js';
import { HOURS, atDefaultTime } from './dates.js';
import { openEditor, openQuickEntry } from './editors/task.js';
import { openProjectEditor, openFolderEditor } from './editors/project.js';
import { isWide, select, clearSelection, moveSelection } from './inspector.js';
import { onSearchInput } from './views/search.js';
import { onDoneFilterChange } from './views/done.js';
import { setFilter } from './filter.js';
import { setTagStatus } from './data.js';
import { openNewProject, openNewTemplate, openSaveAsTemplate } from './views/templates.js';
import { openFocusPicker, unfocus, focusOn } from './editors/focus.js';
import { handleKey, H } from './shortcuts.js';
import './select-search.js';
import { openSheet, esc } from './state.js';
import { openNewPerspective, openPerspectiveEditor, openPerspectiveMenu, saveCurrentViewAsPerspective } from './editors/perspective.js';
import { livePerspectives, movePerspective, archivePerspective, badgeCount } from './perspectives.js';
import { getFocus, focusLabel } from './prefs.js';
import { newCaptureKey, captureGuide } from './views/settings.js';
import { noticeEmailPeople } from './views/capture.js';
import { checklistAction, checklistChange } from './views/checklists.js';
import { dailyAction, dailySubmit } from './views/daily.js';
import { settleAction, settleKey } from './views/settle.js';
import { fullReviewAction, fullReviewKey, startFullReview, activeSession } from './views/fullreview.js';
import { moreSheetHtml, openCustomize } from './sidebar.js';
import { initUpdates, resumeAfterUpdate, tryApply } from './updates.js';
import { slipAction, slipSubmit, slipInput } from './views/slipbox.js';
import { readingAction, readingSubmit } from './views/reading.js';
import { matrixAction, matrixChange } from './views/matrix.js';
import { keepSession, signedIn, markSignedOutOnPurpose, lastEmail, signInNotice } from './session.js';
import { importBusy } from './views/import.js';
import { newFeedLink } from './views/settings.js';
import { createToken, revokeToken, removeSender, addSender, resetSettings, pushTestNow, pushTestLater, removeDevice } from './views/settings.js';
import { requestLocation, startWatching, onLocation } from './geo.js';
import { enableAlerts } from './alerts.js';
import { subscribePush, testAlert, copyGeoUrl, resetAlerts, turnOnAlerts, replaceGeoKey, openAutomationGuide, hideNudge, primeAlerts, isIOS, isStandalone } from './views/alerts.js';
import { openPlaceEditor, openTagEditor } from './editors/place.js';
import { setWithin } from './views/nearby.js';
import { openErrandPlanner } from './views/errands.js';
import { hereNowCount } from './places.js';
import { gtdAction, gtdSubmit, onRefSearch, waitingBadgeCount } from './views/gtd.js';
import { clarifyAction, onClarifySubmit, clarifyKey } from './views/clarify.js';
import { openDelegate, openTickle } from './editors/gtd.js';
import { weeklyAction, staleAction, weeklySubmit } from './views/weekly.js';
import { sweepAction, sweepSubmit, sweepKey } from './views/sweep.js';
import { somedayAction, somedaySubmit, somedayCount } from './views/someday.js';
import { horizonsAction, horizonsInput, horizonsChange } from './views/horizons.js';
import { nowAction } from './views/now.js';
import { planAction, planSubmit, planInput, planChange } from './views/plan.js';

const view = $('#view');
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
// Wide screens edit in the inspector; phones (and items not loaded locally) use the sheet.
const inspectOrEdit = (id) => {
  if (isWide() && byId(db.tasks, id)) return select('task', id);
  const t = findTask(id);
  if (t) openEditor(t);
};
app.openTask = (id) => inspectOrEdit(id);
const findTask = (id) => byId(db.tasks, id) || byId(app.searchExtra, id) || (app.doneCache && byId(app.doneCache.rows, id));

const ACTIONS = {
  'customize-sidebar': () => openCustomize(),
  'new-project': () => openNewProject(null, () => openProjectEditor(null)),
  'new-template': openNewTemplate,
  focus: openFocusPicker,
  unfocus,
  'toggle-archived-templates': () => { app.showArchivedTemplates = !app.showArchivedTemplates; render(); },
  'new-folder': () => openFolderEditor(null),
  'toggle-inactive': () => { app.showInactive = !app.showInactive; render(); },
  'toggle-reorder': () => { const id = location.hash.split('/')[1]; app.reorder = app.reorder === id ? null : id; render(); },
  'new-tag': createTag,
  'new-place': () => openPlaceEditor(null),
  'request-location': () => requestLocation().then(render, render),
  'enable-alerts': () => enableAlerts().then(render),
  'subscribe-push': subscribePush,
  'errand-run': openErrandPlanner,
  'alerts-on': turnOnAlerts,
  'replace-geo-key': replaceGeoKey,
  'hide-nudge': hideNudge,
  'test-alert': testAlert,
  'toggle-archived-places': () => { app.showArchivedPlaces = !app.showArchivedPlaces; render(); },
  'new-token': createToken,
  'new-capture-key': newCaptureKey,
  'capture-guide': captureGuide,
  'feed-link': newFeedLink,
  'push-test-now': pushTestNow,
  'push-test-later': pushTestLater,
  'sign-out': () => { markSignedOutOnPurpose(); sb.auth.signOut(); },
  'new-perspective': openNewPerspective,
  'show-remaining': () => { setFilter({ show: 'remaining' }); render(); },
  'reset-filter': () => { setFilter({ show: 'remaining', fits: 0, energy: '', sort: 'default' }); render(); },
  'save-perspective': saveCurrentViewAsPerspective,
};

// Click handlers keyed by data-attribute; first match wins.
const CLICKS = [
  ['[data-open-folder]', (el, e) => { e.stopPropagation(); }], // a shortcuts:// link: the browser follows it
  ['[data-check]', (el, e) => {
    e.stopPropagation();
    const t = byId(db.tasks, el.dataset.check);
    if (!t) return;
    // Completing a task with open steps completes those steps too (database rule), so confirm first.
    const openKids = descendants(t).filter(isOpen).length;
    if (!t.completed_at && openKids && !confirm(`Complete “${t.title}” and its ${openKids} open step${openKids === 1 ? '' : 's'}?`)) return;
    setCompleted(t, !t.completed_at);
  }],
  ['[data-flag]', (el, e) => { e.stopPropagation(); const t = byId(db.tasks, el.dataset.flag); if (t) updateTask(t, { flagged: !t.flagged }); }],
  ['[data-flag-project]', (el, e) => { e.stopPropagation(); const p = byId(db.projects, el.dataset.flagProject); if (p) updateProject(p, { flagged: !p.flagged }); }],
  ['[data-triage]', (el) => {
    const { overdue, plannedPast, today } = forecastData();
    const at9 = atDefaultTime(new Date(today), 'planned_at');
    if (el.dataset.triage === 'due-to-planned') {
      if (!confirm(`Turn ${overdue.length} overdue deadline${overdue.length === 1 ? '' : 's'} into plans for today? (Due dates are cleared; use this for dates that were never real deadlines.)`)) return;
      bulkUpdate(overdue, () => ({ due_at: null, planned_at: at9.toISOString() }), `${overdue.length} moved to Planned today`);
    } else {
      bulkUpdate(plannedPast, () => ({ planned_at: at9.toISOString() }), `${plannedPast.length} planned for today`);
    }
  }],
  ['[data-review-go]', (el) => { if (el.dataset.reviewGo) location.hash = `#review/${el.dataset.reviewGo}`; }],
  ['[data-mark-reviewed]', async (el) => {
    const p = byId(db.projects, el.dataset.markReviewed);
    const q = reviewQueue();
    const due = remainingIds();
    const next = due[due.indexOf(p.id) + 1] || due.find((id) => id !== p.id) || '';
    await markReviewed(p);
    q.reviewed.push(p.id);
    q.current = next || null;
    location.hash = next ? `#review/${next}` : '#review';
    render();
  }],
  ['[data-review-fix]', async (el) => {
    const p = byId(db.projects, el.dataset.project);
    const fix = el.dataset.reviewFix;
    if (fix === 'add') { const input = $('#review-capture'); input.focus(); input.scrollIntoView({ block: 'center' }); return; }
    if (fix === 'forecast') { location.hash = '#forecast/past'; return; }
    if (fix === 'replan') {
      const at9 = atDefaultTime(startOfToday(), 'planned_at');
      const stale = db.tasks.filter((t) => t.project_id === p.id && isOpen(t) && t.planned_at && new Date(t.planned_at) < startOfToday());
      bulkUpdate(stale, () => ({ planned_at: at9.toISOString() }), `${stale.length} planned for today`);
      return;
    }
    const status = { complete: 'completed', drop: 'dropped', hold: 'on_hold', activate: 'active' }[fix];
    if (status && (status === 'active' || status === 'on_hold' || confirm(`Mark “${p.name}” ${status}?`))) updateProject(p, { status });
  }],
  ['[data-toggle-group]', (el, e) => { e.stopPropagation(); toggleCollapsed(el.dataset.toggleGroup); render(); }],
  ['[data-add-sub]', (el, e) => { e.stopPropagation(); const parent = byId(db.tasks, el.dataset.addSub); if (parent) openBreakdown(parent); }],
  ['[data-indent]', (el, e) => { e.stopPropagation(); const t = byId(db.tasks, el.dataset.indent); if (t) indentTask(t); }],
  ['[data-outdent]', (el, e) => { e.stopPropagation(); const t = byId(db.tasks, el.dataset.outdent); if (t) outdentTask(t); }],
  ['[data-move]', (el, e) => { e.stopPropagation(); const t = byId(db.tasks, el.dataset.move); if (t) moveTask(t, Number(el.dataset.dir)); }],
  ['[data-persp-edit]', (el) => { const p = byId(db.perspectives, el.dataset.perspEdit); if (p) openPerspectiveEditor(p); }],
  ['[data-persp-menu]', (el) => { const p = byId(db.perspectives, el.dataset.perspMenu); if (p) openPerspectiveMenu(p); }],
  ['[data-persp-move]', async (el) => { const p = byId(db.perspectives, el.dataset.perspMove); if (p) { await movePerspective(p, Number(el.dataset.dir)); render(); } }],
  ['[data-persp-restore]', async (el) => { const p = byId(db.perspectives, el.dataset.perspRestore); if (p) { await archivePerspective(p, false); render(); } }],
  ['[data-focus-here]', (el) => focusOn(el.dataset.focusHere)],
  ['[data-save-template]', (el) => { const p = byId(db.projects, el.dataset.saveTemplate); if (p) openSaveAsTemplate(p); }],
  ['[data-act]', (el) => ACTIONS[el.dataset.act]()],
  ['[data-clarify]', (el, e) => { e.stopPropagation(); clarifyAction(el.dataset.clarify); }],
  ['[data-gtd]', (el, e) => { e.stopPropagation(); gtdAction(el); }],
  ['[data-weekly]', (el, e) => { e.stopPropagation(); weeklyAction(el); }],
  ['[data-stale]', (el, e) => { e.stopPropagation(); staleAction(el); }],
  ['[data-sweep]', (el, e) => { e.stopPropagation(); sweepAction(el); }],
  ['[data-someday]', (el, e) => { e.stopPropagation(); somedayAction(el); }],
  ['[data-hz]', (el, e) => { e.stopPropagation(); horizonsAction(el); }],
  ['[data-plan]', (el, e) => { e.stopPropagation(); planAction(el); }],
  ['[data-ck]', (el, e) => { e.stopPropagation(); checklistAction(el); }],
  ['[data-daily]', (el, e) => { e.stopPropagation(); dailyAction(el); }],
  ['[data-settle]', (el, e) => { e.stopPropagation(); if (!el.disabled) settleAction(el); }],
  ['[data-fr]', (el, e) => { e.stopPropagation(); fullReviewAction(el); }],
  ['[data-slip]', (el, e) => { e.stopPropagation(); slipAction(el); }],
  ['[data-rd]', (el, e) => { e.stopPropagation(); readingAction(el); }],
  ['[data-mx]', (el, e) => { e.stopPropagation(); matrixAction(el); }],
  ['[data-fr-start]', async (el, e) => {
    e.stopPropagation();
    const key = el.dataset.frStart === 'import' ? 'import_id' : 'project_id';
    const open = await activeSession(key, el.dataset.id);
    if (open && confirm('Pick up your Full Review where you left off? (Cancel starts a new one.)')) { location.hash = `#full/${open.id}`; return; }
    el.disabled = true;
    try { await startFullReview({ [key]: el.dataset.id }, el.dataset.title || 'Full Review'); } finally { el.disabled = false; }
  }],
  ['[data-flag-keep]', () => {}], // a Settle in flag tick is just a checkbox
  ['[data-cl-tick]', () => {}], // a checklist tick is handled on change
  ['[data-now], [data-now-set]', (el, e) => { e.stopPropagation(); nowAction(el); }],
  ['[data-edit-place]', (el, e) => { e.preventDefault(); e.stopPropagation(); openPlaceEditor(byId(db.places, el.dataset.editPlace)); }],
  ['[data-copy-geo]', (el) => copyGeoUrl(el)],
  ['[data-setup-auto]', (el) => openAutomationGuide(el.dataset.setupAuto)],
  ['[data-edit-tag]', (el) => openTagEditor(byId(db.tags, el.dataset.editTag))],
  ['[data-edit-folder]', (el) => openFolderEditor(byId(db.folders, el.dataset.editFolder))],
  ['[data-add-project]', (el) => openNewProject(el.dataset.addProject, () => openProjectEditor(null, { folder_id: el.dataset.addProject }))],
  ['[data-edit-project]', (el) => (isWide() ? select('project', el.dataset.editProject) : openProjectEditor(byId(db.projects, el.dataset.editProject)))],
  ['[data-remove-device]', (el) => removeDevice(el.dataset.removeDevice)],
  ['[data-remove-sender]', (el) => removeSender(el.dataset.removeSender)],
  ['[data-revoke]', (el) => revokeToken(el.dataset.revoke)],
  ['[data-done-task]', (el) => inspectOrEdit(el.dataset.doneTask)],
  ['[data-task]', (el) => inspectOrEdit(el.dataset.task)],
];

view.addEventListener('click', (e) => {
  for (const [sel, fn] of CLICKS) {
    const el = e.target.closest(sel);
    if (el) { fn(el, e); return; }
  }
});

// Focus from the sidebar (desktop) or the More sheet (phones): both live outside #view.
document.addEventListener('click', (e) => {
  const b = e.target.closest('.nav-focus, .focus-more');
  if (!b) return;
  e.preventDefault();
  openFocusPicker();
});

view.addEventListener('submit', async (e) => {
  if (onClarifySubmit(e) || gtdSubmit(e) || weeklySubmit(e) || sweepSubmit(e) || somedaySubmit(e) || planSubmit(e) || dailySubmit(e) || slipSubmit(e) || readingSubmit(e)) return;
  const senderForm = e.target.closest('[data-add-sender]');
  if (senderForm) { e.preventDefault(); await addSender(senderForm); return; }
  const form = e.target.closest('[data-capture]');
  if (!form) return;
  e.preventDefault();
  const input = form.elements.title;
  const title = input.value;
  input.value = '';
  const extra = form.dataset.project ? { project_id: form.dataset.project, in_inbox: false } : {};
  await capture(title, extra);
  const again = $('[data-capture] input');
  if (again) again.focus();
});

view.addEventListener('change', (e) => {
  if (e.target.closest('[data-hz-link-area], [data-hz-link-goal]')) { horizonsChange(e); return; }
  if (planChange(e)) return;
  if (matrixChange(e)) return;
  if (e.target.closest('[data-cl-tick]') && location.hash.startsWith('#checklist/')) { checklistChange(e); return; }
  const doneCtl = e.target.closest('[data-done]');
  if (doneCtl) { onDoneFilterChange(doneCtl); return; }
  const withinCtl = e.target.closest('[data-within]');
  if (withinCtl) { setWithin(Number(withinCtl.value)); render(); return; }
  const filterCtl = e.target.closest('[data-filter]');
  const tagSt = e.target.closest('[data-tag-status]');
  if (tagSt) { setTagStatus(byId(db.tags, tagSt.dataset.tagStatus), tagSt.value); return; }
  if (filterCtl) { setFilter({ [filterCtl.dataset.filter]: filterCtl.dataset.filter === 'fits' ? Number(filterCtl.value) : filterCtl.value }); render(); return; }
  const kind = e.target.closest('[data-review-kind]');
  if (kind) { updateProject(byId(db.projects, kind.dataset.reviewKind), { kind: kind.value }); return; }
  const interval = e.target.closest('[data-review-interval]');
  if (interval) { updateProject(byId(db.projects, interval.dataset.reviewInterval), { review_every_days: Number(interval.value) }); return; }
  const notes = e.target.closest('[data-review-notes]');
  if (notes) { updateProject(byId(db.projects, notes.dataset.reviewNotes), { notes: notes.value }); return; }
  const sel = e.target.closest('[data-project-status]');
  if (sel) updateProject(byId(db.projects, sel.dataset.projectStatus), { status: sel.value });
});

view.addEventListener('input', (e) => {
  if (e.target.id === 'search-input') onSearchInput(e.target);
  if (e.target.id === 'ref-search') onRefSearch(e.target);
  horizonsInput(e);
  planInput(e);
  slipInput(e);
});

$('#fab').onclick = openQuickEntry;
$('#nav-capture').onclick = openQuickEntry; // laptops: capture lives at the top of the sidebar
const $$review = (i) => document.querySelectorAll('[data-review-go]')[i];

// Phones: views that don't fit the tab bar live in a "More" sheet.
$('#more-tab').onclick = () => {
  const due = reviewDueCount();
  const here = hereNowCount();
  const waiting = waitingBadgeCount();
  const some = somedayCount();
  const badges = { waiting: waiting ? ` <b class="badge due inline">${waiting}</b>` : '', someday: some ? ` <span class="hint">${some}</span>` : '', weekly: due ? ` <b class="badge review inline">${due}</b>` : '', nearby: here ? ` <b class="badge here inline">${here}</b>` : '' };
  const perspectives = livePerspectives().filter((p) => p.pinned !== false).map((p) => { const n = badgeCount(p); return [`#perspective/${p.id}`, esc(p.icon), `${esc(p.name)}${n ? ` <b class="badge persp inline">${n}</b>` : ''}`]; });
  const focusLine = `<button type="button" class="btn focus-more" data-act="focus">🎯 ${getFocus() ? `Focused on ${esc(focusLabel())} · change` : 'Focus'}</button>`;
  const sheet = openSheet(moreSheetHtml({ badges, perspectives, focusLine: `${document.body.classList.contains('update-ready') ? '<button type="button" class="btn primary update-more" data-update-now>Update ready · Reload</button>' : ''}${focusLine}` }));
  const up = sheet.querySelector('[data-update-now]'); if (up) up.onclick = () => { sheet.close(); tryApply('manual'); };
  sheet.querySelectorAll('[data-more-link]').forEach((a) => { a.onclick = () => sheet.close(); });
  sheet.showModal();
};
window.addEventListener('hashchange', render);
document.addEventListener('keydown', (e) => {
  if (clarifyKey(e) || sweepKey(e) || (!$('#sheet').open && (settleKey(e) || fullReviewKey(e)))) return;
  if (!e.metaKey && !e.ctrlKey && !$('#sheet').open && !typing() && location.hash.startsWith('#review') && ['j', 'k', 'm'].includes(e.key)) {
    const btn = e.key === 'm' ? $('[data-mark-reviewed]') : $$review(e.key === 'j' ? 1 : 0);
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    return;
  }
  handleKey(e);
});
// What the shortcuts do (js/shortcuts.js lists them).
Object.assign(H, {
  capture: openQuickEntry,
  newProject: () => openNewProject(null, () => openProjectEditor(null)),
  focusPicker: openFocusPicker,
  focusOn,
  unfocus,
  move: (dir) => moveSelection(dir),
  open: (t) => (isWide() ? select('task', t.id) : openEditor(t)),
  clear: () => { if (app.selected) clearSelection(); },
  breakdown: (t) => openBreakdown(t),
  indent: (t) => indentTask(t),
  outdent: (t) => outdentTask(t),
  delegate: (t) => openDelegate(t),
  tickle: (t) => openTickle(t),
});
// Pick up changes made on another device when the app comes back to the foreground.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && app.user && !window.__noRefresh) { await keepSession(sb); await flushOutbox(); await loadAll(); render(); } // tests pause this
});
window.addEventListener('online', async () => { if (app.user) { await keepSession(sb); await flushOutbox(); render(); } });

// ---------- auth ----------
const authMsg = (m) => { $('#auth-msg').textContent = m; };
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  authMsg('Signing in…');
  const { error } = await sb.auth.signInWithPassword({ email: $('#auth-email').value, password: $('#auth-password').value });
  authMsg(error ? error.message : '');
};
$('#auth-signup').onclick = async () => {
  $('#auth-password').autocomplete = 'new-password'; // so the phone offers to save a new password
  if (!$('#auth-form').reportValidity()) return;
  authMsg('Creating account…');
  const { data, error } = await sb.auth.signUp({
    email: $('#auth-email').value,
    password: $('#auth-password').value,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) return authMsg(error.message);
  authMsg(data.session ? '' : 'Check your email to confirm, then sign in here.');
};

if (window.__mock) window.__showApp = (s) => showApp(s); // tests: the signed-out screen
async function showApp(session) {
  app.user = session ? session.user : null;
  resetSettings();
  resetAlerts();
  $('#auth').hidden = !!app.user;
  $('#app').hidden = !app.user;
  if (!app.user) {
    // Signed out: your email filled in, and (unless you chose to sign out) a word about why.
    const email = $('#auth-email');
    if (!email.value) email.value = lastEmail();
    authMsg(signInNotice());
    if (email.value) setTimeout(() => $('#auth-password').focus(), 0);
    return;
  }
  signedIn(app.user);
  await loadAll();
  await flushOutbox();
  render();
  resumeAfterUpdate(); // back where you were if an update just reloaded the page
  noticeEmailPeople();
  startWatching(); // only if location was already allowed; never prompts on launch
  primeAlerts();
  // First launch from the iPhone Home Screen: take people straight to finishing alert setup.
  try {
    if (isIOS() && isStandalone() && !localStorage.getItem('todo.alerts.seen')) {
      localStorage.setItem('todo.alerts.seen', '1');
      location.hash = '#alerts';
    }
  } catch { /* private mode */ }
}

// Moving refreshes distances and the Nearby badge, but never re-renders under someone typing.
onLocation((_here, moved) => {
  if (!moved || !app.user) return;
  if (typing() || $('#sheet').open || $('#sheet2').open) { $('#badge-nearby').textContent = hereNowCount() || ''; return; }
  render();
});

if (!sb) {
  document.body.textContent = 'Supabase is not configured.';
} else {
  let lastUserId;
  sb.auth.onAuthStateChange((_event, session) => {
    const id = session ? session.user.id : null;
    if (id === lastUserId) return;
    lastUserId = id;
    setTimeout(() => showApp(session), 0);
  });
}

// The shell is served cache-first, so skip the worker on localhost to keep edits visible while developing.
// New versions: downloaded in the background, switched to at a safe moment (js/updates.js).
initUpdates({ importBusy });

// ⋯ menus close after a choice, or when you click elsewhere.
document.addEventListener('click', (e) => {
  const inMenu = e.target.closest && e.target.closest('.head-menu');
  document.querySelectorAll('details.head-menu[open]').forEach((d) => {
    if (d !== inMenu || (e.target.closest('.menu') && e.target.closest('a, button'))) d.open = false;
  });
});
