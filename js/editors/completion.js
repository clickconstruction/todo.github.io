// Optional note about how/why something got done; completed_at already records when. With a gain,
// it also asks whether you got it (yes / partly / no): over time, which kinds of work pay off.
import { sb, app, esc, run, syncRow, openSheet, $ } from '../state.js';
import { fmtDateTime } from '../dates.js';

export function openCompletionNote(task) {
  const sheet = openSheet(`<form method="dialog" id="done-note">
    <h2>✓ ${esc(task.title)}</h2>
    <p class="view-sub" style="margin:0">Completed ${esc(fmtDateTime(task.completed_at))}</p>
    ${task.gain ? `<p class="gain-text" style="margin:10px 0 2px">✦ ${esc(task.gain)}</p>
      <div class="gain-met" role="radiogroup" aria-label="Did you gain it?"><span class="hint">Did you gain it?</span>
        ${[['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']].map(([v, l]) => `<label class="chip-radio"><input type="radio" name="gain_met" value="${v}" ${task.gain_met === v ? 'checked' : ''}> ${l}</label>`).join('')}</div>` : ''}
    <label>Completion note<textarea name="note" placeholder="Outcome, who you spoke to, what's next…">${esc(task.completion_note || '')}</textarea></label>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Skip</button><button type="submit" class="btn primary">Save note</button></div></div>
  </form>`);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  $('#done-note', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const completion_note = e.target.elements.note.value.trim();
    const met = e.target.querySelector('[name=gain_met]:checked');
    sheet.close();
    const [row] = await run(sb.from('tasks').update({ completion_note, ...(met ? { gain_met: met.value } : {}) }).eq('id', task.id).select());
    syncRow('tasks', task, row);
    app.doneCache = null;
    app.render();
  };
  sheet.showModal();
  $('[name=note]', sheet).focus();
}
