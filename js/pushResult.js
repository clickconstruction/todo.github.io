// Plain-language results for push deliveries (used by Settings → Notifications and History).
// The push service's raw reply stays available under "Why?" for troubleshooting.
import { esc } from './state.js';
import { fmtDate } from './dates.js';

const SERVICE = (s = '') => (s.includes('apple') ? 'Apple' : s.includes('google') ? 'Google' : s.includes('mozilla') ? 'Mozilla' : s.includes('windows') ? 'Microsoft' : 'the push service');

export function explain(r) {
  const s = r.status;
  if (s >= 200 && s < 300) return { ok: true, text: `delivered to ${SERVICE(r.service)}` };
  if (s === 404 || s === 410) return { ok: false, text: 'this device stopped accepting notifications and was removed. Turn alerts on again on it' };
  if (s === 401 || s === 403) return { ok: false, text: 'refused: its security keys don’t match. Turn alerts off and on again on that device' };
  if (s === 413) return { ok: false, text: 'refused: message too large' };
  if (s === 429) return { ok: false, text: 'too many notifications at once; the next one should go through' };
  return { ok: false, text: `${SERVICE(r.service)} didn’t respond${s ? ` (${s})` : ''}; it will be tried again next time` };
}

// One line per device: "✓ iPhone: delivered to Apple" / "✕ Mac: refused … [Why?]".
export function resultLines(results) {
  return (results || []).map((r) => {
    const e = explain(r);
    const why = !e.ok && r.reason ? ` <details class="why"><summary>Why?</summary><code>${esc(`${r.status} ${r.reason}`)}</code></details>` : '';
    return `<div class="${e.ok ? 'ok' : 'warn'}">${e.ok ? '✓' : '✕'} ${esc(r.device)}: ${esc(e.text)}${why}</div>`;
  }).join('');
}

// Titles already start with their own icon (🔔 ⏰ 📍); don't add a second.
export const stripIcon = (title = '') => title.replace(/^\p{Extended_Pictographic}️?\s*/u, '');

// "Today 10:22 AM" / "Yesterday 9:05 PM" / "Mon 3:14 PM" / "Sep 12 3:14 PM"
export const when = (iso) => `${fmtDate(iso)} ${new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
export const timeOnly = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
