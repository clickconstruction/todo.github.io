// "Break it down": turn a big task into small steps. Type a step and press Enter for the next
// (the keyboard stays up), or paste a whole list (one step per line; bullets and numbers are
// stripped). Steps can be reordered or removed before saving, and "Do in order" makes only the
// first open step available. Opens on top of an editor, so it has its own dialog.
import { db, $, esc, byId, run, sb, syncRow, app, toast, isOpen } from '../state.js';
import { breakDown, afterTaskWrite } from '../data.js';
import { stepsOf, depthOf, MAX_DEPTH } from '../tree.js';

// "- [ ] Buy screws", "2) Measure", "• Clear shelves" → clean titles.
export const splitSteps = (text) => String(text).split(/\r?\n/)
  .map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)]|\[[ xX]?\])\s*(?:\[[ xX]?\]\s*)?/, '').trim())
  .filter(Boolean);

export function openBreakdown(task, { onDone } = {}) {
  const dlg = $('#sheet2');
  if (depthOf(task) >= MAX_DEPTH) { toast('This step is as deep as steps go. Turn the big task into a project to break it down further.'); return; }
  const existing = stepsOf(task).filter((s) => isOpen(s) || s.completed_at).map((s) => ({ id: s.id, title: s.title, done: !!s.completed_at, drop: false }));
  const items = [...existing];
  let inOrder = !!task.steps_in_order;

  const render = () => {
    const live = items.filter((i) => !i.drop);
    const fresh = live.filter((i) => !i.id).length;
    dlg.innerHTML = `<form method="dialog" class="breakdown">
      <h2>Break it down</h2>
      <p class="breakdown-title">${esc(task.title)}</p>
      <ol class="breakdown-list">${live.map((i) => { const idx = items.indexOf(i); return `<li class="${i.done ? 'done' : ''} ${i.id ? '' : 'new'}">
          <span class="bd-title">${esc(i.title)}</span>
          <span class="bd-actions">
            <button type="button" class="icon-btn" data-bd-move="${idx}" data-dir="-1" aria-label="Move up">▲</button>
            <button type="button" class="icon-btn" data-bd-move="${idx}" data-dir="1" aria-label="Move down">▼</button>
            ${i.done ? '<span class="icon-btn bd-spacer" aria-hidden="true"></span>' : `<button type="button" class="icon-btn" data-bd-remove="${idx}" aria-label="Remove ${esc(i.title)}">✕</button>`}
          </span></li>`; }).join('')}</ol>
      ${live.length ? '' : '<p class="hint">What’s the very first small thing to do? Then the next…</p>'}
      <div class="bd-add"><input type="text" name="step" placeholder="Next small step" autocomplete="off" enterkeyhint="next" aria-label="Next small step">
        <button type="button" class="btn" data-bd-add>Add</button></div>
      <p class="hint" style="margin:0">Press Enter to add and keep going. Pasting a list adds one step per line.</p>
      <label class="flag-toggle"><input type="checkbox" name="in_order" ${inOrder ? 'checked' : ''}> Do in order <span class="hint">only the next step shows as available</span></label>
      <div class="actions"><button type="button" class="btn" data-bd-cancel>Cancel</button>
        <div class="right"><button type="submit" class="btn primary">${fresh ? `Add ${fresh} step${fresh === 1 ? '' : 's'}` : 'Done'}</button></div></div>
    </form>`;
    const input = $('[name=step]', dlg);
    input.focus();
    return input;
  };

  const add = (titles) => { titles.forEach((title) => items.push({ id: null, title, done: false, drop: false })); render(); };
  let input = render();

  // #sheet2 is shared: a handler left over from an earlier sheet must not act on another form.
  const mine = (e) => !!(e.target && e.target.closest && e.target.closest('form.breakdown'));
  dlg.onkeydown = (e) => {
    if (!mine(e)) return;
    if (e.target.name !== 'step' || e.key !== 'Enter') return;
    e.preventDefault();
    const v = e.target.value.trim();
    if (v) add([v]);
  };
  dlg.onpaste = (e) => {
    if (!mine(e)) return;
    if (e.target.name !== 'step') return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const lines = splitSteps(text);
    if (lines.length > 1) { e.preventDefault(); add(lines); }
  };
  dlg.onchange = (e) => { if (!mine(e)) return; if (e.target.name === 'in_order') inOrder = e.target.checked; };
  dlg.onclick = (e) => {
    if (!mine(e)) return;
    if (e.target.closest('[data-bd-add]')) { const v = $('[name=step]', dlg).value.trim(); if (v) add([v]); return; }
    const mv = e.target.closest('[data-bd-move]');
    if (mv) {
      const live = items.filter((i) => !i.drop);
      const i = live.indexOf(items[Number(mv.dataset.bdMove)]);
      const j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= live.length) return;
      const a = items.indexOf(live[i]); const b = items.indexOf(live[j]);
      [items[a], items[b]] = [items[b], items[a]];
      input = render();
      return;
    }
    const rm = e.target.closest('[data-bd-remove]');
    if (rm) {
      const item = items[Number(rm.dataset.bdRemove)];
      if (item.id) item.drop = true; else items.splice(items.indexOf(item), 1);
      input = render();
      return;
    }
    if (e.target.closest('[data-bd-cancel]')) dlg.close();
  };
  dlg.onsubmit = async (e) => {
    if (!mine(e)) return;
    e.preventDefault();
    const pending = $('[name=step]', dlg).value.trim();
    if (pending) items.push({ id: null, title: pending, done: false, drop: false }); // don't lose what's typed
    dlg.close();
    const fresh = items.filter((i) => !i.id && !i.drop);
    const rows = await breakDown(task, fresh.map((i) => i.title), { inOrder });
    // Apply order (existing + new) and drops (never deleted).
    let k = 0;
    const ordered = items.filter((i) => !i.drop).map((i) => (i.id ? byId(db.tasks, i.id) : rows[k++])).filter(Boolean);
    const updates = ordered.map((t, sort) => (t.sort === sort ? null : { t, fields: { sort } }))
      .concat(items.filter((i) => i.drop && i.id).map((i) => ({ t: byId(db.tasks, i.id), fields: { dropped_at: new Date().toISOString() } })))
      .filter(Boolean);
    await Promise.all(updates.map(async ({ t, fields }) => {
      const [r] = await run(sb.from('tasks').update(fields).eq('id', t.id).select());
      syncRow('tasks', t, r);
    }));
    if (updates.length) await afterTaskWrite(task);
    app.render();
    if (fresh.length) toast(`Added ${fresh.length} step${fresh.length === 1 ? '' : 's'} to “${task.title}”`);
    if (onDone) onDone();
  };
  // #sheet2 is shared (the place editor uses it too): drop these handlers when it closes.
  dlg.addEventListener('close', () => { dlg.onkeydown = null; dlg.onpaste = null; dlg.onchange = null; dlg.onclick = null; dlg.onsubmit = null; }, { once: true });
  dlg.showModal();
  input.focus();
}
