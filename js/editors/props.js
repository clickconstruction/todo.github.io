// Inspector layout: titled sections (with a one-line summary, collapsible and remembered) made
// of property rows ("Due · Fri, Oct 3"). Tapping a row opens its editor in place; the full
// controls stay in the form (just hidden), so saving reads every field as before.
import { esc } from '../state.js';
import { fmtMinutes } from '../components.js';

const KEY = 'todo.inspector.closed';
const DEFAULT_CLOSED = ['more'];
let closed;
try { closed = new Set(JSON.parse(localStorage.getItem(KEY) || 'null') || DEFAULT_CLOSED); } catch { closed = new Set(DEFAULT_CLOSED); }
const remember = () => { try { localStorage.setItem(KEY, JSON.stringify([...closed])); } catch { /* private mode */ } };

export const section = (key, title, body) => `<section class="insp-sec ${closed.has(key) ? 'closed' : ''}" data-sec="${key}">
  <button type="button" class="sec-head" data-sec-toggle="${key}" aria-expanded="${!closed.has(key)}"><span class="sec-title">${esc(title)}</span><span class="sec-sum" data-sec-sum="${key}"></span><span class="sec-caret" aria-hidden="true">▾</span></button>
  <div class="sec-body">${body}</div></section>`;

// A row that opens to edit. `edit` is the full control (date field, repeat fieldset…).
export const prop = (key, label, edit) => `<div class="prop" data-prop="${key}">
  <button type="button" class="prop-row" data-prop-toggle="${key}" aria-expanded="false"><span class="prop-label">${esc(label)}</span><span class="prop-val" data-prop-val="${key}"></span></button>
  <div class="prop-edit">${edit}</div></div>`;

// A row whose control is always visible on the right (a select).
export const propInline = (label, control) => `<label class="prop prop-inline"><span class="prop-label">${esc(label)}</span>${control}</label>`;

const fmtDay = (v) => (v ? new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const optText = (sel) => (sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.replace(/ · .*$/, '').trim() : '');

// Current value text for each row, read from the form's own controls.
const VALUES = {
  tags: (f) => [...f.querySelectorAll('.tag-picker .tag-toggle.on')].map((b) => b.textContent).join(', '),
  defer_at: (f) => fmtDay(f.elements.defer_at && f.elements.defer_at.value),
  planned_at: (f) => fmtDay(f.elements.planned_at && f.elements.planned_at.value),
  due_at: (f) => fmtDay(f.elements.due_at && f.elements.due_at.value),
  next_review_at: (f) => fmtDay(f.elements.next_review_at && f.elements.next_review_at.value),
  waiting: (f) => {
    const w = f.elements.waiting_on; const a = f.elements.agenda_for;
    const fu = f.elements.follow_up_at && f.elements.follow_up_at.value;
    return [w && w.value ? `⏳ ${optText(w)}${fu ? ` · ${fmtDay(fu).replace(/,.*$/, '')}` : ''}` : '', a && a.value ? `🗣 ${optText(a)}` : ''].filter(Boolean).join(' · ');
  },
  waits_for: (f) => {
    const open = [...f.querySelectorAll('.wait-chip:not(.done)')];
    const unblocks = f.querySelector('.waits-unblocks');
    const own = open.length ? `⏳ ${open[0].firstChild.textContent.replace(/^⏳\s*/, '').trim()}${open.length > 1 ? ` +${open.length - 1}` : ''}` : '';
    return [own, unblocks ? unblocks.textContent.replace(/:.*$/, '') : ''].filter(Boolean).join(' · ');
  },
  estimate: (f) => { const m = Number(f.elements.estimate_minutes && f.elements.estimate_minutes.value); return m ? fmtMinutes(m) : ''; },
  repeat: (f) => { const s = f.elements.repeat_preset; return s && s.value && s.value !== 'none' ? optText(s) : ''; },
  notify: (f) => { const n = f.querySelectorAll('[data-notify-list] li').length; return n ? `${n} reminder${n === 1 ? '' : 's'}` : ''; },
  location: (f) => { const s = f.elements.place_id; if (!s) return ''; if (s.value && s.value !== '__new') return `📍 ${optText(s)}`; return /^Inherit/.test(optText(s)) ? optText(s).replace(/^Inherit \((.*)\)$/, '📍 $1 (inherited)') : ''; },
};

const SUMMARIES = {
  organize: (f) => {
    const part = f.querySelector('[data-part-of-label]:not(.hint)');
    const proj = f.elements.project_id && f.elements.project_id.value ? optText(f.elements.project_id)
      : f.elements.folder_id && f.elements.folder_id.value && f.elements.folder_id.value !== '__new' ? `📁 ${optText(f.elements.folder_id)}` : '';
    const tags = f.querySelectorAll('.tag-picker .tag-toggle.on').length;
    const w = f.elements.waiting_on && f.elements.waiting_on.value ? `⏳ ${optText(f.elements.waiting_on)}` : '';
    const folder = f.elements.folder_path && f.elements.folder_path.value.trim() ? '📂' : '';
    const waits = f.querySelectorAll('.wait-chip:not(.done)').length ? '⏳ waits' : '';
    return [part ? `in ${part.textContent.split(' › ').pop()}` : proj, tags ? `${tags} tag${tags === 1 ? '' : 's'}` : '', w, waits, folder].filter(Boolean).join(' · ');
  },
  dates: (f) => [['due_at', 'Due'], ['planned_at', 'Planned'], ['defer_at', 'Defer']]
    .map(([k, l]) => (VALUES[k](f) ? `${l} ${VALUES[k](f).replace(/,.*$/, '')}` : '')).filter(Boolean).slice(0, 2).join(' · '),
  alerts: (f) => [VALUES.repeat(f) && '🔁', VALUES.notify(f) && '🔔', VALUES.location(f) && '📍'].filter(Boolean).join(' ') || 'Off',
  more: (f) => { const s = f.elements.status; const files = f.querySelectorAll('[data-attach-list] li, .attach-list li').length; return [s ? optText(s) : '', files ? `${files} file${files === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '); },
  review: (f) => { const n = f.elements.review_every && f.elements.review_every.value; const u = f.elements.review_unit ? optText(f.elements.review_unit).toLowerCase() : ''; const next = VALUES.next_review_at(f); return [n ? `Every ${n === '1' ? u.replace(/s$/, '') : `${n} ${u}`}` : '', next ? `next ${next.replace(/,.*$/, '')}` : ''].filter(Boolean).join(' · '); },
  files: (f) => { const files = f.querySelectorAll('[data-attach-list] li, .attach-list li').length; return files ? `${files} file${files === 1 ? '' : 's'}` : ''; },
};

export function refreshProps(form) {
  form.querySelectorAll('[data-prop-val]').forEach((el) => {
    const fn = VALUES[el.dataset.propVal];
    const v = fn ? fn(form) : '';
    el.textContent = v || 'None';
    el.classList.toggle('is-empty', !v);
  });
  form.querySelectorAll('[data-sec-sum]').forEach((el) => { const fn = SUMMARIES[el.dataset.secSum]; el.textContent = fn ? fn(form) : ''; });
}

export function wireProps(form) {
  form.addEventListener('click', (e) => {
    const head = e.target.closest('[data-sec-toggle]');
    if (head) {
      const sec = head.closest('.insp-sec');
      const nowClosed = sec.classList.toggle('closed');
      head.setAttribute('aria-expanded', String(!nowClosed));
      if (nowClosed) closed.add(sec.dataset.sec); else closed.delete(sec.dataset.sec);
      remember();
      return;
    }
    const row = e.target.closest('[data-prop-toggle]');
    if (row) {
      const p = row.closest('.prop');
      const open = !p.classList.contains('open');
      form.querySelectorAll('.prop.open').forEach((x) => { x.classList.remove('open'); x.querySelector('.prop-row').setAttribute('aria-expanded', 'false'); });
      if (open) {
        p.classList.add('open');
        row.setAttribute('aria-expanded', 'true');
        const first = p.querySelector('.prop-edit input:not([type=hidden]), .prop-edit select');
        if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
      }
    }
  });
  // Esc closes an open row (before the sheet sees it).
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = form.querySelector('.prop.open');
    if (open) { e.preventDefault(); e.stopPropagation(); open.classList.remove('open'); open.querySelector('.prop-row').focus(); }
  });
  const refresh = () => refreshProps(form);
  form.addEventListener('change', refresh);
  form.addEventListener('input', refresh);
  form.addEventListener('click', () => setTimeout(refresh, 0)); // tag chips, quick buttons, notification list
  refresh();
  setTimeout(refresh, 50); // notification list fills in after wiring
}
