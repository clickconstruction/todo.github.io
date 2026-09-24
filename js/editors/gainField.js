// What do I gain? The field under an action's title (and a project's, where it is the Purpose), with the
// optional "…and if I don't?" line, Keep for Claude's suggestions, and the offer to move a fresh capture
// to the project its gain points at. Shared logic lives in ../gain.js.
import { db, app, sb, run, syncRow, esc, byId, toast, $ } from '../state.js';
import { gainOf, placeFor } from '../gain.js';

const PLACEHOLDER = { task: 'Power at the lot by the 15th, so framing isn’t late', project: 'Steady Friday work for both crews' };

// kind: 'task' (gain, gain_cost, gain_by) or 'project' (purpose, purpose_by).
export function gainFieldHtml(t, kind = 'task') {
  const text = kind === 'task' ? t.gain || '' : t.purpose || '';
  const suggested = (kind === 'task' ? t.gain_by : t.purpose_by) === 'agent' && text;
  const inherited = kind === 'task' && !text ? gainOf(t, db.projects) : null;
  return `<div class="gain-field">
    <label><span class="gain-label"><span aria-hidden="true">✦</span> ${kind === 'task' ? 'If I do this, I gain…' : 'What do I gain?'}</span>
      <textarea name="${kind === 'task' ? 'gain' : 'purpose'}" rows="1" maxlength="500" placeholder="${PLACEHOLDER[kind]}">${esc(text)}</textarea></label>
    ${suggested ? '<p class="gain-sug" data-gain-sug><span class="chip sug">Claude suggested</span> <button type="button" class="link-btn" data-gain-keep>Keep</button> <span class="hint">or edit it</span></p>' : ''}
    ${inherited ? `<p class="hint gain-inherit">Project’s gain: <span class="gain-text">${esc(inherited.text)}</span></p>` : ''}
    ${kind === 'task' ? `<details class="gain-cost" ${t.gain_cost ? 'open' : ''}><summary>…and if I don’t?</summary>
      <textarea name="gain_cost" rows="1" maxlength="500" placeholder="The crew sits idle a week">${esc(t.gain_cost || '')}</textarea></details>` : ''}
  </div>`;
}

// Returns collect() → the columns to save. An edited or kept suggestion becomes yours.
export function wireGainField(form, t, kind = 'task', onChange = () => {}) {
  const name = kind === 'task' ? 'gain' : 'purpose';
  const by = kind === 'task' ? 'gain_by' : 'purpose_by';
  const box = form.elements[name];
  let kept = false;
  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  form.querySelectorAll('.gain-field textarea').forEach((el) => { el.addEventListener('input', () => grow(el)); requestAnimationFrame(() => grow(el)); });
  const keep = $('[data-gain-keep]', form);
  if (keep) keep.onclick = () => { kept = true; const s = $('[data-gain-sug]', form); if (s) s.remove(); onChange(); };
  return () => {
    const text = String(box.value || '').trim().slice(0, 500);
    const out = { [name]: text, [by]: !kept && t[by] === 'agent' && text === (t[name] || '') ? 'agent' : null };
    if (kind === 'task') out.gain_cost = String(form.elements.gain_cost.value || '').trim().slice(0, 500);
    return out;
  };
}

// After a capture: if its gain (or title) points at a project, offer to move it there.
export function offerPlacement(row, lead = 'Captured to Inbox') {
  const sug = placeFor(row, { projects: db.projects, goals: db.goals || [], areas: db.areas || [] });
  if (!sug.length) { if (lead) toast(lead); return []; }
  toast(`${lead || 'Captured'} · it fits`, sug.map((s) => ({ label: `→ ${s.project.name}`, run: () => moveTo(row.id, s.project.id) })));
  return sug;
}
export async function moveTo(taskId, projectId) {
  const t = byId(db.tasks, taskId);
  if (!t) return;
  const sort = Math.max(-1, ...db.tasks.filter((x) => x.project_id === projectId && !x.parent_id).map((x) => x.sort || 0)) + 1;
  const [row] = await run(sb.from('tasks').update({ project_id: projectId, in_inbox: false, sort }).eq('id', taskId).select());
  syncRow('tasks', t, row);
  app.render();
  toast(`Moved to ${(byId(db.projects, projectId) || {}).name || 'the project'}`);
}
