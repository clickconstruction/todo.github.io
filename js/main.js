// Todo Tooling entry point: event wiring, auth, service worker.
import { sb, db, app, $, byId, isOpen, toggleCollapsed } from './state.js';
import { render } from './router.js';
import { loadAll, flushOutbox, capture, setCompleted, createTag, updateProject, updateTask, moveTask, addSubAction } from './data.js';
import { openEditor, openQuickEntry } from './editors/task.js';
import { openProjectEditor, openFolderEditor } from './editors/project.js';
import { onSearchInput } from './views/search.js';
import { onDoneFilterChange } from './views/done.js';
import { setFilter } from './filter.js';
import { openSheet } from './state.js';
import { createToken, revokeToken, removeSender, addSender, resetSettings } from './views/settings.js';

const view = $('#view');
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
const findTask = (id) => byId(db.tasks, id) || byId(app.searchExtra, id) || (app.doneCache && byId(app.doneCache.rows, id));

const ACTIONS = {
  'new-project': () => openProjectEditor(null),
  'new-folder': () => openFolderEditor(null),
  'toggle-inactive': () => { app.showInactive = !app.showInactive; render(); },
  'toggle-reorder': () => { const id = location.hash.split('/')[1]; app.reorder = app.reorder === id ? null : id; render(); },
  'new-tag': createTag,
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
  ['[data-toggle-group]', (el, e) => { e.stopPropagation(); toggleCollapsed(el.dataset.toggleGroup); render(); }],
  ['[data-add-sub]', (el, e) => {
    e.stopPropagation();
    const parent = byId(db.tasks, el.dataset.addSub);
    const title = parent && prompt(`New sub-action under “${parent.title}”`);
    if (title) addSubAction(parent, title);
  }],
  ['[data-move]', (el, e) => { e.stopPropagation(); const t = byId(db.tasks, el.dataset.move); if (t) moveTask(t, Number(el.dataset.dir)); }],
  ['[data-act]', (el) => ACTIONS[el.dataset.act]()],
  ['[data-edit-folder]', (el) => openFolderEditor(byId(db.folders, el.dataset.editFolder))],
  ['[data-add-project]', (el) => openProjectEditor(null, { folder_id: el.dataset.addProject })],
  ['[data-edit-project]', (el) => openProjectEditor(byId(db.projects, el.dataset.editProject))],
  ['[data-remove-sender]', (el) => removeSender(el.dataset.removeSender)],
  ['[data-revoke]', (el) => revokeToken(el.dataset.revoke)],
  ['[data-done-task]', (el) => { const t = findTask(el.dataset.doneTask); if (t) openEditor(t); }],
  ['[data-task]', (el) => { const t = findTask(el.dataset.task); if (t) openEditor(t); }],
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
  const filterCtl = e.target.closest('[data-filter]');
  if (filterCtl) { setFilter({ [filterCtl.dataset.filter]: filterCtl.dataset.filter === 'fits' ? Number(filterCtl.value) : filterCtl.value }); render(); return; }
  const sel = e.target.closest('[data-project-status]');
  if (sel) updateProject(byId(db.projects, sel.dataset.projectStatus), { status: sel.value });
});

view.addEventListener('input', (e) => {
  if (e.target.id === 'search-input') onSearchInput(e.target);
});

$('#fab').onclick = openQuickEntry;
// Phones: views that don't fit the tab bar live in a "More" sheet.
$('#more-tab').onclick = () => {
  const links = [['#review', '🔁', 'Review'], ['#tags', '🏷️', 'Tags'], ['#done', '✅', 'Done'], ['#search', '🔍', 'Search'], ['#settings', '⚙️', 'Settings']];
  const sheet = openSheet(`<form method="dialog" class="more-sheet"><h2>More</h2>
    <nav class="more-links">${links.map(([href, icon, label]) => `<a href="${href}" data-more-link><span>${icon}</span>${label}</a>`).join('')}</nav>
    <div class="actions"><div class="right"><button class="btn">Close</button></div></div></form>`);
  sheet.querySelectorAll('[data-more-link]').forEach((a) => { a.onclick = () => sheet.close(); });
  sheet.showModal();
};
window.addEventListener('hashchange', render);
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || $('#sheet').open || typing()) return;
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
  $('#auth').hidden = !!app.user;
  $('#app').hidden = !app.user;
  if (!app.user) return;
  await loadAll();
  await flushOutbox();
  render();
}

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
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if ('serviceWorker' in navigator && !isLocal) navigator.serviceWorker.register('sw.js').catch(() => {});
