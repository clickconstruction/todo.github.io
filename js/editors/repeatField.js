// Repeat field shared by the action and project editors: a preset menu, a custom panel
// (every N unit, weekdays, from assigned dates or completion, how it ends), a summary and
// a "Next: …" preview. Returns collect() → repeat_rule (object) or null.
import { $, esc } from '../state.js';
import { fromDateInput, HOURS } from '../dates.js';
import { REPEAT_PRESETS, REPEAT_UNITS, WEEKDAYS, presetRule, presetOf, describe, nextOccurrence, localTz } from '../repeat.js';

export function repeatFieldHtml(row, { skippable = false } = {}) {
  const rule = row.repeat_rule || null;
  const preset = presetOf(rule);
  const r = rule || { every: 1, unit: 'week', from: 'assigned' };
  const endMode = r.end_count ? 'count' : r.end_until ? 'until' : 'never';
  return `<fieldset class="repeat-field">
    <legend>Repeat</legend>
    <select name="repeat_preset" aria-label="Repeat">${REPEAT_PRESETS.map(([v, l]) => `<option value="${v}" ${preset === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="repeat-custom" ${preset === 'custom' ? '' : 'hidden'}>
      <label class="review-every">Every <input type="number" name="repeat_every" min="1" max="999" inputmode="numeric" value="${r.every || 1}" aria-label="Every">
        <select name="repeat_unit" aria-label="Unit">${REPEAT_UNITS.map(([v, l]) => `<option value="${v}" ${r.unit === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="weekday-picker" ${r.unit === 'week' ? '' : 'hidden'} role="group" aria-label="On these days">
        ${WEEKDAYS.map((d, i) => `<label><input type="checkbox" name="repeat_wd" value="${i}" ${(r.weekdays || []).includes(i) ? 'checked' : ''}><span>${d.slice(0, 2)}</span></label>`).join('')}
      </div>
      <div class="segmented" role="radiogroup" aria-label="Repeat from">
        <label><input type="radio" name="repeat_from" value="assigned" ${r.from !== 'completion' ? 'checked' : ''}><span>On schedule</span></label>
        <label><input type="radio" name="repeat_from" value="completion" ${r.from === 'completion' ? 'checked' : ''}><span>After completing</span></label>
      </div>
      <label class="review-every">Ends <select name="repeat_end" aria-label="Ends">
          <option value="never" ${endMode === 'never' ? 'selected' : ''}>Never</option>
          <option value="count" ${endMode === 'count' ? 'selected' : ''}>After…</option>
          <option value="until" ${endMode === 'until' ? 'selected' : ''}>On date…</option></select>
        <input type="number" name="repeat_end_count" min="1" max="9999" value="${r.end_count || 10}" aria-label="Number of times" ${endMode === 'count' ? '' : 'hidden'}>
        <input type="date" name="repeat_end_until" value="${esc(r.end_until || '')}" aria-label="Last date" ${endMode === 'until' ? '' : 'hidden'}></label>
    </div>
    <p class="hint repeat-summary" data-repeat-summary></p>
    ${skippable && rule ? '<button type="button" class="btn small" data-skip-occurrence>Skip this occurrence</button>' : ''}
  </fieldset>`;
}

// Wire inside `form`. `datesOf()` returns the form's current {defer_at, planned_at, due_at} for the preview.
export function wireRepeatField(form, row, onChange = () => {}) {
  const el = (n) => form.elements[n];
  if (!el('repeat_preset')) return () => undefined;
  const custom = $('.repeat-custom', form);
  const n = (row.repeat_rule && row.repeat_rule.n) || 1;

  const read = () => {
    const preset = el('repeat_preset').value;
    if (!preset) return null;
    if (preset !== 'custom') return { ...presetRule(preset), n };
    const unit = el('repeat_unit').value;
    const rule = { every: Math.max(1, Math.round(Number(el('repeat_every').value) || 1)), unit, from: form.querySelector('input[name=repeat_from]:checked').value, tz: localTz(), n };
    const wd = [...form.querySelectorAll('input[name=repeat_wd]:checked')].map((x) => Number(x.value));
    if (unit === 'week' && wd.length) rule.weekdays = wd;
    const end = el('repeat_end').value;
    if (end === 'count') rule.end_count = Math.max(1, Math.round(Number(el('repeat_end_count').value) || 1));
    if (end === 'until' && el('repeat_end_until').value) rule.end_until = el('repeat_end_until').value;
    return rule;
  };
  const fillCustom = (rule) => {
    if (!rule) return;
    el('repeat_every').value = rule.every;
    el('repeat_unit').value = rule.unit;
    form.querySelectorAll('input[name=repeat_wd]').forEach((x) => { x.checked = (rule.weekdays || []).includes(Number(x.value)); });
  };
  const dates = () => ({
    defer_at: el('defer_at') ? fromDateInput(el('defer_at').value, HOURS.defer_at) : row.defer_at,
    planned_at: el('planned_at') ? fromDateInput(el('planned_at').value, HOURS.planned_at) : row.planned_at,
    due_at: el('due_at') ? fromDateInput(el('due_at').value, HOURS.due_at) : row.due_at,
  });
  const sync = () => {
    custom.hidden = el('repeat_preset').value !== 'custom';
    $('.weekday-picker', form).hidden = el('repeat_unit').value !== 'week';
    el('repeat_end_count').hidden = el('repeat_end').value !== 'count';
    el('repeat_end_until').hidden = el('repeat_end').value !== 'until';
    const rule = read();
    const out = $('[data-repeat-summary]', form);
    if (!rule) { out.textContent = ''; return; }
    const next = nextOccurrence({ ...dates(), repeat_rule: rule });
    const hasDate = Object.values(dates()).some(Boolean);
    out.textContent = `${describe(rule)}.${next ? ` When completed, the next one ${hasDate ? `is ${next.next.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` : `comes back ${next.next.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`}.` : ' This is the last one.'}`;
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'repeat_preset' && e.target.value && e.target.value !== 'custom') fillCustom(presetRule(e.target.value));
    if (/^(repeat_|defer_at|planned_at|due_at)/.test(e.target.name || '')) sync();
  });
  form.addEventListener('click', (e) => { if (e.target.closest('[data-qd]')) setTimeout(sync, 0); });
  sync();
  return read;
}
