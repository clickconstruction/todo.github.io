// Folders on your Mac: an action or project can name the folder that holds its files (support material,
// e.g. ~/_SYNC/MAGA/_Todo/Bookmarks cleanup). Browsers can't open local folders, so the 📂 button runs an
// Apple Shortcut through a shortcuts:// link, passing the path; the Shortcut makes the folder if it's
// missing and opens it in Finder. Settings → Folders sets it up (your _Todo folder, the Shortcut's name).
import { app, esc } from './state.js';

export const shortcutName = () => ((app.settings || {}).folder_shortcut || 'Open in Finder').trim();
export const todoFolder = () => String((app.settings || {}).todo_folder || '').trim().replace(/\/+$/, '');
export const isMac = () => /Macintosh|Mac OS X/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1);
export const openFolderUrl = (path) => `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName())}&input=text&text=${encodeURIComponent(path)}`;
// A folder name from an action's title: no slashes or colons, short.
export const folderName = (title) => String(title || 'Untitled').replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
export const suggestFolder = (title) => (todoFolder() ? `${todoFolder()}/${folderName(title)}` : '');
export const shortPath = (p) => String(p || '').replace(/^\/Users\/[^/]+\//, '~/');

export function folderButton(path, { label = '📂 Open folder', cls = 'btn small' } = {}) {
  if (!path) return '';
  return `<a class="${cls} open-folder" href="${esc(openFolderUrl(path))}" data-open-folder
    title="${isMac() ? `Opens ${esc(path)} in Finder (through your “${esc(shortcutName())}” Shortcut)` : 'Opens on your Mac (through a Shortcut)'}">${label}</a>`;
}

// The Folder field for the task and project editors: path, 📂 Open, and "Use _Todo/<title>".
export function folderFieldHtml(value, title) {
  const sug = suggestFolder(title);
  return `<div class="folder-field"><input type="text" name="folder_path" value="${esc(value || '')}" maxlength="500" placeholder="${esc(sug || '~/Documents/…')}" autocomplete="off" spellcheck="false" aria-label="Folder on your Mac">
    <span class="folder-open">${folderButton(value)}</span>
    ${sug && !value ? `<button type="button" class="link-btn" data-folder-suggest="${esc(sug)}">Use ${esc(shortPath(sug))}</button>` : ''}
    ${!todoFolder() && !value ? '<a class="hint" href="#settings" data-goto-folders>Set up folders</a>' : ''}</div>`;
}

// Editors live in dialogs outside the view: fill the path from the suggestion, keep 📂 in step with typing.
document.addEventListener('click', (e) => {
  const g = e.target.closest && e.target.closest('[data-goto-folders]');
  if (g) { const d = g.closest('dialog'); if (d && d.open) d.close(); setTimeout(() => { const h = [...document.querySelectorAll('#view h2.section-title')].find((x) => x.textContent.startsWith('Folders')); if (h) h.scrollIntoView({ block: 'start' }); }, 250); return; }
  const b = e.target.closest && e.target.closest('[data-folder-suggest]');
  if (!b) return;
  const box = b.closest('.folder-field'); const input = box && box.querySelector('[name=folder_path]');
  if (!input) return;
  input.value = b.dataset.folderSuggest;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  b.remove();
});
document.addEventListener('input', (e) => {
  if (!(e.target && e.target.name === 'folder_path')) return;
  const slot = e.target.closest('.folder-field') && e.target.closest('.folder-field').querySelector('.folder-open');
  if (slot) slot.innerHTML = folderButton(e.target.value.trim());
});
