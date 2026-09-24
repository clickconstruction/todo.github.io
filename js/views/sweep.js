// Mind sweep: one trigger at a time ("Home repairs", "Money owed"…); type what comes to mind and
// press Enter to capture it to the Inbox. Hidden and custom prompts are saved to the account.
import { app, esc, toast } from '../state.js';
import { sweepPrompts, TRIGGERS } from '../weekly.js';
import { capture } from '../data.js';
import { splitGain } from '../gain.js';
import { saveSettings } from '../prefs.js';

const state = () => (app.sweep ||= { i: 0, captured: {} });
const prompts = () => sweepPrompts(app.settings || {});
const total = () => Object.values(state().captured).reduce((n, l) => n + l.length, 0);

export function sweepHtml({ embedded = false } = {}) {
  const s = state();
  const list = prompts();
  if (s.i >= list.length) return endHtml(embedded);
  const p = list[s.i];
  const inGroup = list.filter((x) => x.group === p.group);
  const mine = s.captured[p.id] || [];
  return `<div class="sweep" data-sweep-box>
    <div class="sweep-top"><span class="hint">${s.i + 1} of ${list.length} · ${esc(p.group)}${inGroup[0] === p && p.group === 'Personal' ? ' (work is done)' : ''}</span>${total() ? `<span class="hint">${total()} captured</span>` : ''}</div>
    <div class="cl-progress"><i style="width:${Math.round((s.i / list.length) * 100)}%"></i></div>
    <div class="cl-item sweep-card"><b>${esc(p.text)}</b>${p.hint ? `<span class="cl-meta">${esc(p.hint)}…</span>` : ''}</div>
    ${mine.length ? `<ul class="sweep-caps">${mine.map((t) => `<li>📥 ${esc(t)}</li>`).join('')}</ul>` : ''}
    <form class="capture" data-sweep-capture><input type="text" name="title" id="sweep-input" placeholder="${mine.length ? 'Anything else?' : 'What comes to mind?'} ⏎ to capture" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    <p class="hint">Add why it’s worth doing after an arrow: <span class="gain-text">Get a trailer quote → two crews on Fridays</span></p>
    <div class="sweep-foot"><button class="btn small" data-sweep="prev" ${s.i ? '' : 'disabled'}>‹</button>
      <button class="btn small" data-sweep="hide" data-id="${p.id}">Hide this prompt</button>
      <button class="btn primary" data-sweep="next">${s.i === list.length - 1 ? 'Finish' : 'Next prompt'} →</button></div>
    <p class="hint sweep-keys">⏎ captures · → next prompt (when the box is empty) · ← back</p>
  </div>`;
}

function endHtml(embedded) {
  const s = app.settings || {};
  const hidden = (s.trigger_hidden || []).length;
  const custom = s.trigger_custom || [];
  return `<div class="cl-done sweep-done"><div class="cl-big">🧹</div><h2>Swept</h2>
    <p>${total() ? `${total()} captured to your Inbox.` : 'Nothing new. Your head is clear.'}</p>
    <p><button class="btn" data-sweep="again">Go through again</button> ${!embedded && total() ? '<a class="btn primary" href="#clarify">Clarify them now</a>' : ''}</p></div>
    <details class="sweep-edit"><summary>Edit the prompts</summary>
      <form class="capture" data-sweep-add><select name="group" aria-label="Group"><option>Work</option><option>Personal</option></select><input type="text" name="text" placeholder="Your own prompt, e.g. Rental properties" maxlength="120" autocomplete="off"><button class="btn">Add</button></form>
      ${custom.length ? `<ul class="list">${custom.map((c) => `<li class="row"><div class="row-main"><div class="row-title">${esc(c.text)}</div><div class="row-meta">${esc(c.group)} · yours</div></div><button class="btn small" data-sweep="remove" data-id="${esc(c.id)}">Remove</button></li>`).join('')}</ul>` : ''}
      ${hidden ? `<p class="hint">${hidden} built-in prompt${hidden === 1 ? '' : 's'} hidden. <button class="link-btn" data-sweep="restore">Show them again</button></p>` : `<p class="hint">${TRIGGERS.length} built-in prompts. Hide any that don’t apply as you go.</p>`}
    </details>`;
}

const focusInput = () => setTimeout(() => { const i = document.getElementById('sweep-input'); if (i && !matchMedia('(pointer: coarse)').matches) i.focus(); }, 0);
export const mountSweep = () => focusInput();

export async function sweepAction(el) {
  const s = state();
  const a = el.dataset.sweep;
  const set = app.settings || {};
  if (a === 'next') s.i += 1;
  else if (a === 'prev') s.i = Math.max(0, s.i - 1);
  else if (a === 'again') { s.i = 0; s.captured = {}; }
  else if (a === 'hide') {
    const id = el.dataset.id;
    await saveSettings({ trigger_hidden: [...new Set([...(set.trigger_hidden || []), id])] }, { quiet: true });
    toast('Prompt hidden', [{ label: 'Undo', run: async () => { await saveSettings({ trigger_hidden: (app.settings.trigger_hidden || []).filter((x) => x !== id) }, { quiet: true }); app.render(); } }]);
  } else if (a === 'restore') await saveSettings({ trigger_hidden: [] });
  else if (a === 'remove') await saveSettings({ trigger_custom: (set.trigger_custom || []).filter((c) => c.id !== el.dataset.id) });
  app.render();
  focusInput();
}

export function sweepSubmit(e) {
  const cap = e.target.closest('[data-sweep-capture]');
  const add = e.target.closest('[data-sweep-add]');
  if (!cap && !add) return false;
  e.preventDefault();
  if (add) {
    const text = add.elements.text.value.trim();
    if (!text) return true;
    const set = app.settings || {};
    saveSettings({ trigger_custom: [...(set.trigger_custom || []), { id: `c${Date.now().toString(36)}`, group: add.elements.group.value, text }] }).then(() => app.render());
    return true;
  }
  const title = cap.elements.title.value.trim();
  if (!title) return true;
  cap.elements.title.value = '';
  const s = state();
  const p = prompts()[s.i];
  const { title: t, gain } = splitGain(title); // "Idea → gain" keeps both
  (s.captured[p.id] ||= []).push(t);
  capture(t, gain ? { gain } : {}).then(focusInput);
  return true;
}

// ← / → move between prompts when the capture box is empty.
export function sweepKey(e) {
  if (e.target.id !== 'sweep-input' || e.target.value || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return false;
  e.preventDefault();
  sweepAction({ dataset: { sweep: e.key === 'ArrowRight' ? 'next' : 'prev' } });
  return true;
}

export function viewSweep() {
  return `<a class="back" href="#inbox">‹ Inbox</a><div class="view-head"><h1 class="inbox">Mind sweep</h1></div>
    <p class="view-sub">Empty your head: for each prompt, capture every open loop it brings up. You’ll clarify them later.</p>
    ${sweepHtml()}`;
}
