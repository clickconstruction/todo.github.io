// Todo Tooling entry point: event wiring, auth, service worker.
import { sb, db, app, $, byId, isOpen, toggleCollapsed, toast } from './state.js';
import { render } from './router.js';
import { loadAll, flushOutbox, capture, setCompleted, createTag, updateProject, updateTask, moveTask, addSubAction, bulkUpdate, markReviewed } from './data.js';
import { reviewQueue, remainingIds, reviewDueCount } from './views/review.js';
import { startOfToday } from './dates.js';
import { forecastData } from './views/forecast.js';
import { HOURS } from './dates.js';
import { openEditor, openQuickEntry } from './editors/task.js';
import { openProjectEditor, openFolderEditor } from './editors/project.js';
import { isWide, select, clearSelection, moveSelection } from './inspector.js';
import { onSearchInput } from './views/search.js';
import { onDoneFilterChange } from './views/done.js';
import { setFilter } from './filter.js';
import { openSheet } from './state.js';
import { createToken, revokeToken, removeSender, addSender, resetSettings } from './views/settings.js';
import { requestLocation, startWatching, onLocation } from './geo.js';
import { enableAlerts } from './alerts.js';
import { subscribePush, createGeoKey, testAlert, copyGeoUrl, resetAlerts } from './views/alerts.js';
import { openPlaceEditor, openTagEditor } from './editors/place.js';
import { setWithin } from './views/nearby.js';
import { hereNowCount } from './places.js';

const view = $('#view');
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
// Wide screens edit in the inspector; phones (and items not loaded locally) use the sheet.
const inspectOrEdit = (id) => {
  if (isWide() && byId(db.tasks, id)) return select('task', id);
  const t = findTask(id);
  if (t) openEditor(t);
};
const findTask = (id) => byId(db.tasks, id) || byId(app.searchExtra, id) || (app.doneCache && byId(app.doneCache.rows, id));

const ACTIONS = {
  'new-project': () => openProjectEditor(null),
  'new-folder': () => openFolderEditor(null),
  'toggle-inactive': () => { app.showInactive = !app.showInactive; render(); },
  'toggle-reorder': () => { const id = location.hash.split('/')[1]; app.reorder = app.reorder === id ? null : id; render(); },
  'new-tag': createTag,
  'new-place': () => openPlaceEditor(null),
  'request-location': () => requestLocation().then(render, render),
  'enable-alerts': () => enableAlerts().then(render),
  'subscribe-push': subscribePush,
  'create-geo-key': createGeoKey,
  'test-alert': testAlert,
  'toggle-archived-places': () => { app.showArchivedPlaces = !app.showArchivedPlaces; render(); },
  'new-token': createToken,
  'sign-out': () => sb.auth.signOut(),
};

// Click handlers keyed by data-attribute; first match wins.
const CLICKS = [
  ['[data-check]', (el, e) => {
    e.stopPropagation();
    const t = byId(db.tasks, el.dataset.check);
    if (!t) return;
    // Completing a group completes its open actions too (database rule), so confirm first.
    const openKids = db.tasks.filter((c) => c.parent_id === t.id && isOpen(c)).length;
    if (!t.completed_at && openKids && !confirm(`Complete “${t.title}” and its ${openKids} open action${openKids === 1 ? '' : 's'}?`)) return;
    setCompleted(t, !t.completed_at);
  }],
  ['[data-flag]', (el, e) => { e.stopPropagation(); const t = byId(db.tasks, el.dataset.flag); if (t) updateTask(t, { flagged: !t.flagged }); }],
  ['[data-flag-project]', (el, e) => { e.stopPropagation(); const p = byId(db.projects, el.dataset.flagProject); if (p) updateProject(p, { flagged: !p.flagged }); }],
  ['[data-triage]', (el) => {
    const { overdue, plannedPast, today } = forecastData();
    const at9 = new Date(today); at9.setHours(HOURS.planned_at);
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
      const at9 = startOfToday(); at9.setHours(HOURS.planned_at);
      const stale = db.tasks.filter((t) => t.project_id === p.id && isOpen(t) && t.planned_at && new Date(t.planned_at) < startOfToday());
      bulkUpdate(stale, () => ({ planned_at: at9.toISOString() }), `${stale.length} planned for today`);
      return;
    }
    const status = { complete: 'completed', drop: 'dropped', hold: 'on_hold', activate: 'active' }[fix];
    if (status && (status === 'active' || status === 'on_hold' || confirm(`Mark “${p.name}” ${status}?`))) updateProject(p, { status });
  }],
  ['[data-toggle-group]', (el, e) => { e.stopPropagation(); toggleCollapsed(el.dataset.toggleGroup); render(); }],
  ['[data-add-sub]', (el, e) => {
    e.stopPropagation();
    const parent = byId(db.tasks, el.dataset.addSub);
    const title = parent && prompt(`New sub-action under “${parent.title}”`);
    if (title) addSubAction(parent, title);
  }],
  ['[data-move]', (el, e) => { e.stopPropagation(); const t = byId(db.tasks, el.dataset.move); if (t) moveTask(t, Number(el.dataset.dir)); }],
  ['[data-act]', (el) => ACTIONS[el.dataset.act]()],
  ['[data-edit-place]', (el, e) => { e.preventDefault(); e.stopPropagation(); openPlaceEditor(byId(db.places, el.dataset.editPlace)); }],
  ['[data-copy-geo]', (el) => copyGeoUrl(el)],
  ['[data-edit-tag]', (el) => openTagEditor(byId(db.tags, el.dataset.editTag))],
  ['[data-edit-folder]', (el) => openFolderEditor(byId(db.folders, el.dataset.editFolder))],
  ['[data-add-project]', (el) => openProjectEditor(null, { folder_id: el.dataset.addProject })],
  ['[data-edit-project]', (el) => (isWide() ? select('project', el.dataset.editProject) : openProjectEditor(byId(db.projects, el.dataset.editProject)))],
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

view.addEventListener('submit', async (e) => {
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
  const doneCtl = e.target.closest('[data-done]');
  if (doneCtl) { onDoneFilterChange(doneCtl); return; }
  const withinCtl = e.target.closest('[data-within]');
  if (withinCtl) { setWithin(Number(withinCtl.value)); render(); return; }
  const filterCtl = e.target.closest('[data-filter]');
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
});

$('#fab').onclick = openQuickEntry;
const $$review = (i) => document.querySelectorAll('[data-review-go]')[i];

// Phones: views that don't fit the tab bar live in a "More" sheet.
$('#more-tab').onclick = () => {
  const due = reviewDueCount();
  const here = hereNowCount();
  const links = [['#review', '🔁', `Review${due ? ` <b class="badge review inline">${due}</b>` : ''}`], ['#nearby', '📍', `Nearby${here ? ` <b class="badge here inline">${here}</b>` : ''}`], ['#tags', '🏷️', 'Tags'], ['#done', '✅', 'Done'], ['#search', '🔍', 'Search'], ['#settings', '⚙️', 'Settings']];
  const sheet = openSheet(`<form method="dialog" class="more-sheet"><h2>More</h2>
    <nav class="more-links">${links.map(([href, icon, label]) => `<a href="${href}" data-more-link><span>${icon}</span>${label}</a>`).join('')}</nav>
    <div class="actions"><div class="right"><button class="btn">Close</button></div></div></form>`);
  sheet.querySelectorAll('[data-more-link]').forEach((a) => { a.onclick = () => sheet.close(); });
  sheet.showModal();
};
window.addEventListener('hashchange', render);
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || $('#sheet').open || typing()) return;
  if (isWide() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); return; }
  if (e.key === 'Escape' && app.selected) { clearSelection(); return; }
  if (location.hash.startsWith('#review') && ['j', 'k', 'm'].includes(e.key)) {
    const btn = e.key === 'm' ? $('[data-mark-reviewed]') : $$review(e.key === 'j' ? 1 : 0);
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); location.hash = '#search'; }
  else if (e.key === 'n') { e.preventDefault(); openQuickEntry(); }
});
// Pick up changes made on another device when the app comes back to the foreground.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && app.user) { await flushOutbox(); await loadAll(); render(); }
});
window.addEventListener('online', async () => { if (app.user) { await flushOutbox(); render(); } });

// ---------- auth ----------
const authMsg = (m) => { $('#auth-msg').textContent = m; };
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  authMsg('Signing in…');
  const { error } = await sb.auth.signInWithPassword({ email: $('#auth-email').value, password: $('#auth-password').value });
  authMsg(error ? error.message : '');
};
$('#auth-signup').onclick = async () => {
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

async function showApp(session) {
  app.user = session ? session.user : null;
  resetSettings();
  resetAlerts();
  $('#auth').hidden = !!app.user;
  $('#app').hidden = !app.user;
  if (!app.user) return;
  await loadAll();
  await flushOutbox();
  render();
  startWatching(); // only if location was already allowed; never prompts on launch
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
// When a new version activates, reload (or offer to, if the user is mid-edit) so nobody runs a stale app.
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if ('serviceWorker' in navigator && !isLocal) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, nothing stale to replace
    const inspector = $('#inspector');
    const busy = $('#sheet').open || typing() || (inspector && inspector.contains(document.activeElement));
    if (busy) toast('Todo Tooling updated', { label: 'Reload', run: () => location.reload() });
    else location.reload();
  });
}
