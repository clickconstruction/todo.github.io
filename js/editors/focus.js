// Focus picker: narrow the app to some folders and projects (this device only).
import { db, app, esc, openSheet, bySort, byId, toast } from '../state.js';
import { getFocus, setFocus, focusLabel } from '../prefs.js';

export function openFocusPicker() {
  const cur = getFocus() || { folders: [], projects: [] };
  const live = (p) => ['active', 'on_hold'].includes(p.status);
  const folders = db.folders.filter((f) => !f.archived_at).sort(bySort);
  const box = (kind, id, label, checked, indent = false) => `<label class="focus-item ${indent ? 'indent' : ''}"><input type="checkbox" data-focus-${kind}="${id}" ${checked ? 'checked' : ''}> ${label}</label>`;
  const sheet = openSheet(`<form method="dialog" class="focus-picker"><h2>🎯 Focus</h2>
    <p class="hint" style="margin:0">Show only these. The Inbox and Search still show everything. Focus is saved on this device.</p>
    <div class="focus-list">
      ${folders.map((f) => box('folder', f.id, `📁 ${esc(f.name)}`, cur.folders.includes(f.id))
        + db.projects.filter((p) => p.folder_id === f.id && live(p)).sort(bySort).map((p) => box('project', p.id, esc(p.name), cur.projects.includes(p.id) || cur.folders.includes(f.id), true)).join('')).join('')}
      ${db.projects.filter((p) => live(p) && (!p.folder_id || !byId(db.folders, p.folder_id))).sort(bySort).map((p) => box('project', p.id, esc(p.name), cur.projects.includes(p.id))).join('')}
    </div>
    <div class="actions">${getFocus() ? '<button type="button" class="btn" data-unfocus>Unfocus</button>' : ''}<button type="button" class="btn" data-cancel>Cancel</button>
      <div class="right"><button type="submit" class="btn primary">Focus</button></div></div></form>`);
  const form = sheet.querySelector('form');
  // Ticking a folder ticks (and locks) its projects.
  const sync = () => form.querySelectorAll('[data-focus-folder]').forEach((fb) => {
    db.projects.filter((p) => p.folder_id === fb.dataset.focusFolder).forEach((p) => {
      const pb = form.querySelector(`[data-focus-project="${p.id}"]`);
      if (pb) { if (fb.checked) pb.checked = true; pb.disabled = fb.checked; }
    });
  });
  sync();
  form.onchange = sync;
  form.onclick = (e) => {
    if (e.target.closest('[data-cancel]')) sheet.close();
    if (e.target.closest('[data-unfocus]')) { sheet.close(); unfocus(); }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const folderIds = [...form.querySelectorAll('[data-focus-folder]:checked')].map((b) => b.dataset.focusFolder);
    const projectIds = [...form.querySelectorAll('[data-focus-project]:checked:not(:disabled)')].map((b) => b.dataset.focusProject);
    sheet.close();
    setFocus({ folders: folderIds, projects: projectIds });
    app.render();
    if (getFocus()) toast(`🎯 Focused on ${focusLabel()}`, [{ label: 'Unfocus', run: unfocus }]);
  };
  sheet.showModal();
}

export function unfocus() { setFocus(null); app.render(); toast('Showing everything'); }

// Focus on one project (or the project of an action), e.g. from the keyboard.
export function focusOn(projectId) {
  if (!projectId) { toast('That item isn’t in a project'); return; }
  setFocus({ folders: [], projects: [projectId] });
  app.render();
  toast(`🎯 Focused on ${focusLabel()}`, [{ label: 'Unfocus', run: unfocus }]);
}
