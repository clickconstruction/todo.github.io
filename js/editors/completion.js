// Optional note about how/why something got done; completed_at already records when.
import { sb, app, esc, run, syncRow, openSheet, $ } from '../state.js';
import { fmtDateTime } from '../dates.js';

export function openCompletionNote(task) {
  const sheet = openSheet(`<form method="dialog" id="done-note">
    <h2>✓ ${esc(task.title)}</h2>
    <p class="view-sub" style="margin:0">Completed ${esc(fmtDateTime(task.completed_at))}</p>
    <label>Completion note<textarea name="note" placeholder="Outcome, who you spoke to, what's next…">${esc(task.completion_note || '')}</textarea></label>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Skip</button><button type="submit" class="btn primary">Save note</button></div></div>
  </form>`);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  $('#done-note', sheet).onsubmit = async (e) => {
    e.preventDefault();
    const completion_note = e.target.elements.note.value.trim();
    sheet.close();
    const [row] = await run(sb.from('tasks').update({ completion_note }).eq('id', task.id).select());
    syncRow('tasks', task, row);
    app.doneCache = null;
    app.render();
  };
  sheet.showModal();
  $('[name=note]', sheet).focus();
}
