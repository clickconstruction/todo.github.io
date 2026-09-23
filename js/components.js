// Small reusable form controls shared by the editors, Review and the inspector.
import { esc } from './state.js';
import { toDateInput, toDateTimeInput, quickDate, fmtStamp } from './dates.js';

const DATE_STEPS = [['today', 'Today'], ['+1d', '+1d'], ['+1w', '+1w'], ['+1m', '+1m']];
export const DATE_HINTS = {
  defer_at: 'Hidden until this day',
  planned_at: 'When you intend to work on it',
  due_at: 'Hard deadline only',
  next_review_at: 'When it comes up in Review',
};

let seq = 0; // unique ids: a sheet and the inspector can be on screen together

// Date input with one-tap buttons. Wire once per container with wireQuickButtons().
export function dateField(name, label, iso) {
  const id = `f-${name}-${++seq}`;
  return `<div class="date-field">
    <label for="${id}">${esc(label)} <span class="hint">${esc(DATE_HINTS[name] || '')}</span></label>
    <div class="date-row">
      <input type="date" id="${id}" name="${name}" value="${toDateInput(iso)}">
      <span class="quick">${DATE_STEPS.map(([step, text]) => `<button type="button" class="qbtn" data-qd="${name}" data-step="${step}">${text}</button>`).join('')}
        <button type="button" class="qbtn" data-qd="${name}" data-step="clear" aria-label="Clear ${esc(label)}">✕</button></span>
    </div>
  </div>`;
}

const ESTIMATE_STEPS = [1, 5, 15, 60]; // same as OmniFocus
// Estimate in minutes: number input plus quick add buttons.
export function estimateField(minutes) {
  const id = `f-estimate-${++seq}`;
  return `<div class="date-field">
    <label for="${id}">Duration <span class="hint">How long it takes</span></label>
    <div class="date-row">
      <input type="number" id="${id}" name="estimate_minutes" min="0" step="1" inputmode="numeric" placeholder="min" value="${minutes ?? ''}">
      <span class="quick">${ESTIMATE_STEPS.map((m) => `<button type="button" class="qbtn" data-qe="${m}">+${m < 60 ? `${m}m` : `${m / 60}h`}</button>`).join('')}
        <button type="button" class="qbtn" data-qe="clear" aria-label="Clear estimate">✕</button></span>
    </div>
  </div>`;
}

export function wireQuickButtons(root) {
  root.addEventListener('click', (e) => {
    const qd = e.target.closest('[data-qd]');
    if (qd) {
      const input = root.querySelector(`[name="${qd.dataset.qd}"]`);
      input.value = quickDate(input.value, qd.dataset.step);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const qe = e.target.closest('[data-qe]');
    if (qe) {
      const input = root.querySelector('[name="estimate_minutes"]');
      input.value = qe.dataset.qe === 'clear' ? '' : (Number(input.value) || 0) + Number(qe.dataset.qe);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

// Editable moment (completed / dropped): date and time.
export function dateTimeField(name, label, iso) {
  const id = `f-${name}-${++seq}`;
  return `<div class="date-field"><label for="${id}">${esc(label)}</label>
    <div class="date-row"><input type="datetime-local" id="${id}" name="${name}" value="${toDateTimeInput(iso)}"></div></div>`;
}

// "Added … · Changed …" footer for editors and the inspector.
export const stampsHtml = (row) => (row && row.created_at ? `<p class="stamps"><span>Added ${esc(fmtStamp(row.created_at))}</span>${row.updated_at ? `<span>Changed ${esc(fmtStamp(row.updated_at))}</span>` : ''}</p>` : '');

export const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
