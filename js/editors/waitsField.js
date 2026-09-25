// "Waits for": a card isn't available until the cards it waits for are done, in any project. Links
// save as soon as you add or remove one (the database refuses loops and a card's own steps). The
// card on the other side shows what it unblocks.
import { db, $, esc, byId, isOpen, taskSort } from '../state.js';
import { ancestors, descendants } from '../tree.js';
import { addWait, removeWait } from '../data.js';
import { unblocksOf } from '../availability.js';
import { refreshProps } from './props.js';

const projName = (t) => (t.project_id ? (byId(db.projects, t.project_id) || {}).name || '' : t.in_inbox ? 'Inbox' : '');

export function waitsFieldHtml(t, task) {
  if (!task) return '<div class="waits-field"><span class="hint">Save it first, then pick the cards it waits for.</span></div>';
  const links = (db.taskWaits || []).filter((w) => w.task_id === task.id).map((w) => byId(db.tasks, w.waits_for) || { id: w.waits_for, title: 'A card finished earlier', completed_at: true });
  const unblocks = unblocksOf(task);
  return `<div class="waits-field" data-waits-field>
    ${links.length ? `<div class="waits-chips">${links.map((b) => `<span class="wait-chip ${isOpen(b) ? '' : 'done'}" title="${isOpen(b) ? 'Still open' : 'Done'}">${isOpen(b) ? '⏳' : '✓'} ${esc(b.title)}${projName(b) ? ` <small>· ${esc(projName(b))}</small>` : ''}<button type="button" class="x" data-wait-remove="${b.id}" aria-label="Stop waiting for ${esc(b.title)}">×</button></span>`).join('')}</div>` : ''}
    ${isOpen(task) ? `<button type="button" class="link-btn" data-wait-add>＋ ${links.length ? 'Add another' : 'Add a card it waits for'}</button>` : ''}
    ${links.length ? `<label class="waits-then">When they're done <select name="on_unblock" data-no-search><option value="forecast" ${t.on_unblock !== 'none' ? 'selected' : ''}>show it in Forecast today</option><option value="none" ${t.on_unblock === 'none' ? 'selected' : ''}>just make it available</option></select></label>` : ''}
    ${unblocks.length ? `<p class="hint waits-unblocks">Unblocks ${unblocks.length}: ${unblocks.slice(0, 3).map((u) => `“${esc(u.title)}”`).join(', ')}${unblocks.length > 3 ? '…' : ''}</p>` : ''}
  </div>`;
}

export function wireWaitsField(form, task, onChange = () => {}) {
  if (!task) return () => ({});
  const redraw = () => {
    const box = $('[data-waits-field]', form);
    const cur = byId(db.tasks, task.id) || task;
    if (box) box.outerHTML = waitsFieldHtml({ ...cur, on_unblock: form.elements.on_unblock ? form.elements.on_unblock.value : cur.on_unblock }, cur);
    refreshProps(form);
  };
  form.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-wait-remove]');
    if (rm) { await removeWait(task, rm.dataset.waitRemove); redraw(); return; }
    if (e.target.closest('[data-wait-add]')) {
      openWaitPicker(byId(db.tasks, task.id) || task, async (other) => {
        try { await addWait(task, other); } catch { return; } // the database explains in a toast
        redraw();
      });
    }
  });
  form.addEventListener('change', (e) => { if (e.target.name === 'on_unblock') onChange(); });
  return () => (form.elements.on_unblock ? { on_unblock: form.elements.on_unblock.value } : {});
}

// Searchable list of open cards this one could wait for, grouped by project.
function openWaitPicker(task, onPick) {
  const dlg = $('#sheet2');
  const skip = new Set([task.id, ...ancestors(task).map((a) => a.id), ...descendants(task).map((d) => d.id),
    ...(db.taskWaits || []).filter((w) => w.task_id === task.id).map((w) => w.waits_for)]);
  const candidates = db.tasks.filter((x) => isOpen(x) && !skip.has(x.id));
  const draw = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = candidates.filter((x) => words.every((w) => `${x.title} ${projName(x)}`.toLowerCase().includes(w)));
    const groups = new Map();
    hits.sort(taskSort).slice(0, 80).forEach((x) => { const k = projName(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
    $('[data-wp-list]', dlg).innerHTML = [...groups.entries()].map(([name, list]) => `<li class="po-group">${name ? `🗂️ ${esc(name)}` : '📥 Loose tasks'}</li>`
      + list.map((x) => `<li><button type="button" class="po-item" data-wp="${x.id}">${esc(x.title)}${x.parent_id ? `<span class="hint"> in ${esc((byId(db.tasks, x.parent_id) || {}).title || '')}</span>` : ''}</button></li>`).join('')).join('')
      + (hits.length ? (hits.length > 80 ? '<li class="hint">Keep typing to narrow it down…</li>' : '') : '<li class="hint">No matching cards.</li>');
  };
  dlg.innerHTML = `<form method="dialog" class="part-of-picker">
    <h2>Waits for…</h2>
    <p class="hint" style="margin:0">“${esc(task.title)}” stays out of your lists until the card you pick is done.</p>
    <input type="search" data-wp-search placeholder="Search any card" aria-label="Search cards" autocomplete="off">
    <ul class="po-list" data-wp-list></ul>
    <div class="actions"><div class="right"><button type="button" class="btn" data-wp-cancel>Cancel</button></div></div></form>`;
  draw('');
  const search = $('[data-wp-search]', dlg);
  search.oninput = () => draw(search.value);
  dlg.querySelector('form').onclick = (e) => {
    if (e.target.closest('[data-wp-cancel]')) { dlg.close(); return; }
    const b = e.target.closest('[data-wp]');
    if (!b) return;
    dlg.close();
    onPick(byId(db.tasks, b.dataset.wp));
  };
  dlg.showModal();
  search.focus();
}
