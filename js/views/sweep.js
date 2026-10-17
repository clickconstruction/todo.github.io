// Mind sweep: one trigger at a time ("Home repairs", "Money owed"…); type what comes to mind and
// press Enter to capture it to the Inbox (or, with #project or @tag on the line, straight to where it belongs:
// the box reads the Inbox box's marks, js/capture-line.js, and the list under the prompt says where each went). Hidden and custom prompts are saved to the account. Whatever hides a
// prompt sits beside a way to see the hidden ones and bring any of them back (beside Hide, and under Edit the prompts).
// A draw never throws away what is in the box: sweepHtml reads the live box before the draw replaces it and
// focusInput puts its text, caret and focus back after (see remember below).
// The route: the group label in "6 of 56 · Work" is a button (its title says the same in short for a hover) that
// unfolds an outline under the progress bar: both groups with their counts, the one you are in with the prompt you
// are on marked and the passed ones muted, the other folded to a line that opens the same way. A prompt there is a
// tap that jumps to it (the box's text comes along through state().box); the outline closes on a jump and stays
// open across the redraw after a capture (app.sweep.route, routeOpen).
import { app, esc, toast } from '../state.js';
import { sweepPrompts, TRIGGERS } from '../weekly.js';
import { captureLine, readLine } from '../capture-line.js';
import { saveSettings } from '../prefs.js';

const state = () => (app.sweep ||= { i: 0, captured: {} });
const prompts = () => sweepPrompts(app.settings || {});
const total = () => Object.values(state().captured).reduce((n, l) => n + l.length, 0);
// What each prompt captured: {title, where (a project's name when #project filed it there, else ''), tags (labels)}.
function sweptLine() {
  const n = total();
  if (!n) return 'Nothing new. Your head is clear.';
  const filed = Object.values(state().captured).flat().filter((c) => c.where).length;
  return filed ? `${n} captured: ${n - filed} to your Inbox, ${filed} filed in ${filed === 1 ? 'a project' : 'projects'}.` : `${n} captured to your Inbox.`;
}
// The built-in prompts hidden, in their usual order.
const hiddenPrompts = () => { const h = new Set((app.settings || {}).trigger_hidden || []); return TRIGGERS.filter((t) => h.has(t.id)); };
// Each hidden prompt with Show again; Show all again when there are several.
function hiddenListHtml() {
  const list = hiddenPrompts();
  return `<ul class="list sweep-hidden-list">${list.map((t) => `<li class="row"><div class="row-main"><div class="row-title">${esc(t.text)}</div><div class="row-meta">${esc(t.group)} · hidden</div></div><button class="btn small" data-sweep="unhide" data-id="${esc(t.id)}">Show again</button></li>`).join('')}</ul>
    ${list.length > 1 ? '<p><button class="link-btn" data-sweep="restore">Show all again</button></p>' : ''}`;
}
// Bringing prompts back puts them in their places: stay on the prompt you were on.
async function keepPlace(fn) {
  const s = state();
  const was = (prompts()[s.i] || {}).id;
  await fn();
  const j = was ? prompts().findIndex((p) => p.id === was) : -1;
  if (j >= 0) s.i = j;
}

// The groups in the order the list has them (Work, then Personal), hidden prompts out and the user's own in:
// { name, from (index of its first prompt in the list), prompts }.
function groupsOf(list) {
  const out = [];
  list.forEach((p, i) => {
    let g = out[out.length - 1];
    if (!g || g.name !== p.group) { g = { name: p.group, from: i, prompts: [] }; out.push(g); }
    g.prompts.push(p);
  });
  return out;
}
const countOf = (g) => `${g.prompts.length} prompt${g.prompts.length === 1 ? '' : 's'}`;
// What a hover on the group label says, in short: where you are in the group, what is left and what comes after.
function routeLine(list, i) {
  const gs = groupsOf(list);
  const k = gs.findIndex((g) => g.name === list[i].group);
  const g = gs[k];
  const at = i - g.from + 1;
  const left = g.prompts.length - at;
  const name = (x) => `${x.name} (${x.prompts.length})`;
  const after = gs.slice(k + 1).map(name).join(', ');
  const before = gs.slice(0, k).map(name).join(', ');
  return [`${g.name}: prompt ${at} of ${g.prompts.length}`, left ? `${left} to go` : 'the last one', after ? `then ${after}` : '', before ? `${before} done` : '', 'Tap for the whole route'].filter(Boolean).join(' · ');
}
// The whole route under the progress bar. Every prompt is a tap that jumps there; captured counts show as a small number.
function routeHtml(list, i) {
  const s = state();
  const gs = groupsOf(list);
  const here = list[i].group;
  const hereAt = gs.findIndex((g) => g.name === here);
  const row = (p, j) => { const n = (s.captured[p.id] || []).length; return `<li class="${j === i ? 'here' : j < i ? 'passed' : ''}"><button type="button" data-sweep="jump" data-i="${j}"${j === i ? ' aria-current="step"' : ''}><span class="sweep-route-i">${j + 1}</span><span class="sweep-route-t">${esc(p.text)}</span>${n ? `<span class="sweep-route-n" title="${n} captured here">${n}</span>` : ''}</button></li>`; };
  return `<div class="sweep-route" id="sweep-route"><ol class="sweep-route-groups">${gs.map((g, k) => {
    const open = g.name === here || !!(s.routeOpen || {})[g.name];
    const head = g.name === here
      ? `<div class="sweep-route-head"><b>${esc(g.name)}</b> <span class="hint">· ${countOf(g)}, you are on ${i - g.from + 1}</span></div>`
      : `<button type="button" class="sweep-route-head" data-sweep="route-group" data-group="${esc(g.name)}" aria-expanded="${open ? 'true' : 'false'}"><b>${esc(g.name)}</b> <span class="hint">· ${countOf(g)}, ${k > hereAt ? 'after' : 'before'} ${esc(here)}</span></button>`;
    return `<li class="sweep-route-group${g.name === here ? ' here' : ''}">${head}${open ? `<ol class="sweep-route-list">${g.prompts.map((p, j) => row(p, g.from + j)).join('')}</ol>` : ''}</li>`;
  }).join('')}</ol></div>`;
}

export function sweepHtml({ embedded = false } = {}) {
  const s = state();
  const list = prompts();
  const box = remember(); // what is in the box this draw replaces
  if (s.i >= list.length) { s.box = null; return endHtml(embedded); }
  const p = list[s.i];
  const inGroup = list.filter((x) => x.group === p.group);
  const mine = s.captured[p.id] || [];
  const nHidden = hiddenPrompts().length;
  return `<div class="sweep" data-sweep-box>
    <div class="sweep-top"><span class="hint">${s.i + 1} of ${list.length} · <button type="button" class="sweep-group" data-sweep="route" aria-expanded="${s.route ? 'true' : 'false'}"${s.route ? ' aria-controls="sweep-route"' : ''} title="${esc(routeLine(list, s.i))}">${esc(p.group)} ${s.route ? '▴' : '▾'}</button>${inGroup[0] === p && p.group === 'Personal' ? ' (work is done)' : ''}</span>${total() ? `<span class="hint">${total()} captured</span>` : ''}</div>
    <div class="cl-progress"><i style="width:${Math.round((s.i / list.length) * 100)}%"></i></div>
    ${s.route ? routeHtml(list, s.i) : ''}
    <div class="cl-item sweep-card"><b>${esc(p.text)}</b>${p.hint ? `<span class="cl-meta">${esc(p.hint)}…</span>` : ''}</div>
    ${mine.length ? `<ul class="sweep-caps">${mine.map((c) => `<li>${c.where ? '📁' : '📥'} ${esc(c.title)}${c.where ? ` <span class="hint">· ${esc(c.where)}</span>` : ''}${c.tags && c.tags.length ? ` <span class="hint">${c.tags.map((x) => `@${esc(x)}`).join(' ')}</span>` : ''}</li>`).join('')}</ul>` : ''}
    <form class="capture" data-sweep-capture><input type="text" name="title" id="sweep-input" value="${esc(box ? box.value : '')}" placeholder="${mine.length ? 'Anything else?' : 'What comes to mind?'} ⏎ to capture" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
    <p class="hint sweep-hint">#project · @tag · “due fri” · → why it matters</p>
    <div class="sweep-foot"><button class="btn small" data-sweep="prev" ${s.i ? '' : 'disabled'}>‹</button>
      <button class="btn small" data-sweep="hide" data-id="${p.id}">Hide this prompt</button>
      ${nHidden ? `<button class="btn small" data-sweep="hidden-toggle" aria-expanded="${s.showHidden ? 'true' : 'false'}">${s.showHidden ? 'Close hidden prompts' : `View hidden prompts (${nHidden})`}</button>` : ''}
      <button class="btn primary" data-sweep="next">${s.i === list.length - 1 ? 'Finish' : 'Next prompt'} →</button></div>
    ${nHidden && s.showHidden ? `<div class="sweep-hidden"><p class="hint">${nHidden} built-in prompt${nHidden === 1 ? '' : 's'} hidden. Show one again and it’s back in its place in the sweep.</p>${hiddenListHtml()}</div>` : ''}
    <p class="hint sweep-keys"><kbd>⏎</kbd> captures · <kbd>→</kbd> next prompt (when the box is empty) · <kbd>←</kbd> back</p>
  </div>`;
}

function endHtml(embedded) {
  const s = app.settings || {};
  const hidden = (s.trigger_hidden || []).length;
  const custom = s.trigger_custom || [];
  return `<div class="cl-done sweep-done"><div class="cl-big">🧹</div><h2>Swept</h2>
    <p>${sweptLine()}</p>
    <p><button class="btn" data-sweep="again">Go through again</button> ${!embedded && total() ? '<a class="btn primary" href="#clarify">Clarify them now</a>' : ''}</p></div>
    <details class="sweep-edit"><summary>Edit the prompts</summary>
      <form class="capture" data-sweep-add><select name="group" aria-label="Group"><option>Work</option><option>Personal</option></select><input type="text" name="text" placeholder="Your own prompt, e.g. Rental properties" maxlength="120" autocomplete="off"><button class="btn">Add</button></form>
      ${custom.length ? `<ul class="list">${custom.map((c) => `<li class="row"><div class="row-main"><div class="row-title">${esc(c.text)}</div><div class="row-meta">${esc(c.group)} · yours</div></div><button class="btn small" data-sweep="remove" data-id="${esc(c.id)}">Remove</button></li>`).join('')}</ul>` : ''}
      ${hidden ? `<p class="hint">${hidden} built-in prompt${hidden === 1 ? '' : 's'} hidden:</p>${hiddenListHtml()}` : `<p class="hint">${TRIGGERS.length} built-in prompts. Hide any that don’t apply as you go.</p>`}
    </details>`;
}

// Every draw replaces the box, and a draw can come while you are typing or pasting into it: a capture redraws the
// view when its save returns (seconds, on a poor connection), and the app reloads and redraws when it comes back to
// the front. The text, caret and focus are read from the live box before the draw and put back after, so what was
// typed in between is still there, where it was (v162). Before, the new box took focus and sat empty: a paste made
// while the last item saved was gone, and it looked as if the box had to be clicked before it took one.
const liveBox = () => document.getElementById('sweep-input');
function remember() {
  const i = liveBox();
  const s = state();
  s.box = i ? { value: i.value, start: i.selectionStart, end: i.selectionEnd, focused: document.activeElement === i } : null;
  return s.box;
}
const focusInput = () => setTimeout(() => {
  const i = liveBox();
  if (!i) return;
  const b = state().box; state().box = null;
  if ((b && b.focused) || !matchMedia('(pointer: coarse)').matches) i.focus(); // phones: only when it had focus (no keyboard popping up on its own)
  if (b && b.value && document.activeElement === i) { try { i.setSelectionRange(b.start ?? b.value.length, b.end ?? b.value.length); } catch { /* not a text field */ } }
}, 0);
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
  } else if (a === 'hidden-toggle') s.showHidden = !s.showHidden;
  else if (a === 'route') s.route = !s.route;
  else if (a === 'route-group') { const g = el.dataset.group; (s.routeOpen ||= {})[g] = !s.routeOpen[g]; }
  else if (a === 'jump') { s.i = Math.max(0, Math.min(prompts().length - 1, Number(el.dataset.i) || 0)); s.route = false; }
  else if (a === 'unhide') {
    const id = el.dataset.id;
    const t = TRIGGERS.find((x) => x.id === id);
    await keepPlace(() => saveSettings({ trigger_hidden: (set.trigger_hidden || []).filter((x) => x !== id) }, { quiet: true }));
    if (!hiddenPrompts().length) s.showHidden = false;
    toast(`Back in the sweep: ${t ? t.text : 'the prompt'}`);
  } else if (a === 'restore') { await keepPlace(() => saveSettings({ trigger_hidden: [] })); s.showHidden = false; }
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
  const a = readLine(title); // the Inbox box's marks: #project files it there, @tag tags it, due/plan date it, → carries why
  if (!a.title) return true;
  (s.captured[p.id] ||= []).push({ title: a.title, where: a.project ? a.project.name : '', tags: a.tags.map((x) => x.label) });
  captureLine(title).then(focusInput);
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
    <p class="view-sub">Half-thoughts are fine. Anything you type lands in the Inbox, where you’ll make sense of it later.</p>
    ${sweepHtml()}`;
}
