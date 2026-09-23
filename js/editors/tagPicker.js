// Tag picker used by the task and project editors: toggle existing tags, or type
// "Laptop" / "Waiting : Hiro" + Enter to create one. Returns a getter for the selection.
import { $, esc, sortedTags, tagLabel, tagStatus } from '../state.js';
import { ensureTag } from '../data.js';

export const tagPickerHtml = (hint = '') => `<label>Tags${hint ? ` <span class="hint">${esc(hint)}</span>` : ''} <div class="tag-picker" data-tag-picker></div>
  <input type="text" data-new-tag placeholder="New tag (Enter). e.g. Laptop, Waiting : Hiro" autocomplete="off"></label>`;

export function wireTagPicker(root, initialIds, onChange = () => {}) {
  const selected = new Set(initialIds);
  const box = $('[data-tag-picker]', root);
  const draw = () => {
    // Dropped tags only show when this item already has them (so they can be removed).
    box.innerHTML = sortedTags({ dropped: true }).filter((tag) => tagStatus(tag) !== 'dropped' || selected.has(tag.id)).map((tag) => {
      const st = tagStatus(tag);
      return `<button type="button" class="tag-toggle ${selected.has(tag.id) ? 'on' : ''} ${st !== 'active' ? `is-${st}` : ''}" data-tag="${tag.id}" aria-pressed="${selected.has(tag.id)}" ${st === 'on_hold' ? 'title="On hold: actions with it are parked"' : ''}>${st === 'on_hold' ? '⏸ ' : ''}${esc(tagLabel(tag))}</button>`;
    }).join('');
  };
  draw();
  box.onclick = (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    selected.has(b.dataset.tag) ? selected.delete(b.dataset.tag) : selected.add(b.dataset.tag);
    draw();
    onChange();
  };
  $('[data-new-tag]', root).onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = await ensureTag(e.target.value);
    if (tag) { selected.add(tag.id); e.target.value = ''; draw(); onChange(); }
  };
  return () => [...selected];
}
