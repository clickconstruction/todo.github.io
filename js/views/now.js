// What now? The four criteria: where you are, time available, energy, then priority (js/whatnow.js).
// All three answers are filled in for you (location, the gap before your next calendar event, your
// last energy), so it usually takes no typing; tap any of them to change it.
import { db, app, sb, run, syncRow, esc, byId, isOpen, effectiveTagIds, tagLabel, tagStatus, toast } from '../state.js';
import { startOfToday, addDays, atDefaultTime, endOfToday } from '../dates.js';
import { isAvailable } from '../availability.js';
import { rankNow, gapUntilNext, TIME_OPTIONS } from '../whatnow.js';
import { placeFor, isInside } from '../places.js';
import { calendarEvents, liveCalendars } from '../calendars.js';
import { dayKey } from '../gtd.js';
import { ENERGY_ICON } from '../gtd.js';

const KEY = 'todo.now';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const remember = (x) => { try { localStorage.setItem(KEY, JSON.stringify(x)); } catch { /* private mode */ } };

// Actions you could do now (not Inbox items, which aren't decided yet).
const candidates = () => db.tasks.filter((t) => isOpen(t) && !t.in_inbox && isAvailable(t));
const hereTasks = (list) => (app.here ? list.filter((t) => isInside(placeFor(t))) : []);

// Contexts worth offering: tags on available actions (a tag includes its sub-tags), most used first.
function contexts(list) {
  const counts = new Map();
  list.forEach((t) => effectiveTagIds(t).forEach((id) => {
    const g = byId(db.tags, id);
    if (!g || tagStatus(g) !== 'active') return;
    const root = g.parent_id ? byId(db.tags, g.parent_id) : g;
    if (!root || /^(waiting|someday)/i.test(root.name)) return;
    counts.set(root.id, (counts.get(root.id) || 0) + 1);
  }));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([id, n]) => ({ id, n, tag: byId(db.tags, id) }));
}
const tagFilter = (tagId) => { const ids = new Set([tagId, ...db.tags.filter((g) => g.parent_id === tagId).map((g) => g.id)]); return (t) => [...effectiveTagIds(t)].some((x) => ids.has(x)); };

// The answers: what you picked this session, else a sensible guess.
function answers(list) {
  const last = load();
  const s = (app.now ||= {});
  const here = hereTasks(list);
  const ctxs = contexts(list);
  const guessWhere = here.length ? 'here' : ctxs.some((c) => c.id === last.where) ? last.where : 'anywhere';
  let gap = null;
  if (liveCalendars().some((c) => c.enabled)) gap = gapUntilNext(calendarEvents(dayKey(startOfToday()), dayKey(startOfToday())));
  const guessMinutes = gap ? gap.minutes : (last.minutes ?? 30);
  const guessEnergy = new Date().getHours() >= 20 ? 'low' : (last.energy ?? '');
  return {
    where: s.where ?? guessWhere, whereWhy: s.where != null ? '' : here.length ? `you’re near ${esc(placeFor(here[0]).place.name)}` : last.where && guessWhere === last.where ? 'last used' : '',
    minutes: s.minutes ?? guessMinutes, minutesWhy: s.minutes != null ? '' : gap ? `${gap.minutes} min until ${esc(gap.title)}` : last.minutes != null ? 'last used' : '',
    energy: s.energy ?? guessEnergy, energyWhy: s.energy != null ? '' : new Date().getHours() >= 20 ? 'it’s late' : last.energy ? 'last used' : '',
    here, ctxs,
  };
}

const fmtMin = (m) => (!m ? 'Any' : m >= 60 ? `${m / 60}h` : `${m}m`);

export function viewNow() {
  const list = candidates();
  const a = answers(list);
  const inContext = a.where === 'anywhere' ? () => true : a.where === 'here' ? (t) => isInside(placeFor(t)) : tagFilter(a.where);
  const res = rankNow(list, { minutes: a.minutes, energy: a.energy, inContext, projects: db.projects, goals: db.goals || [], endOfToday: endOfToday() });
  const whereOpts = [...(a.here.length ? [['here', `📍 Here`]] : []), ...a.ctxs.map((c) => [c.id, esc(tagLabel(c.tag))]), ['anywhere', 'Anywhere']];
  const timeOpts = [...new Set([...TIME_OPTIONS.filter(Boolean), a.minutes || 0].filter(Boolean))].sort((x, y) => x - y);
  const chip = (group, v, label, on) => `<button type="button" class="now-opt ${on ? 'on' : ''}" data-now-set="${group}" data-v="${esc(String(v))}" aria-pressed="${on}">${label}</button>`;
  const reason = (r) => `<span class="chip now-${r.kind}">${esc(r.text)}</span>`;
  return `<div class="view-head"><h1 class="now">What now?</h1></div>
    <p class="view-sub">Where you are, the time you have, your energy, then priority.</p>
    <div class="now-q"><b>Where</b>${a.whereWhy ? ` <span class="hint">· ${a.whereWhy}</span>` : ''}<div class="now-opts">${whereOpts.map(([v, l]) => chip('where', v, l, a.where === v)).join('')}</div></div>
    <div class="now-q"><b>Time</b>${a.minutesWhy ? ` <span class="hint">· ${a.minutesWhy}</span>` : ''}<div class="now-opts">${timeOpts.map((m) => chip('minutes', m, fmtMin(m), Number(a.minutes) === m)).join('')}${chip('minutes', 0, '2h+', !a.minutes)}</div></div>
    <div class="now-q"><b>Energy</b>${a.energyWhy ? ` <span class="hint">· ${a.energyWhy}</span>` : ''}<div class="now-opts">${[['low', `${ENERGY_ICON.low} Low`], ['medium', `${ENERGY_ICON.medium} Medium`], ['high', `${ENERGY_ICON.high} High`], ['', 'Any']].map(([v, l]) => chip('energy', v, l, a.energy === v)).join('')}</div></div>
    <p class="view-sub">${res.total ? `${res.total} action${res.total === 1 ? '' : 's'} fit${res.total === 1 ? 's' : ''}${res.total > res.items.length ? ` · the best ${res.items.length}` : ''}` : 'Nothing fits.'}</p>
    ${res.items.map(({ t, reasons }) => { const p = t.project_id && byId(db.projects, t.project_id); return `<div class="now-item" data-task="${t.id}"><b>${esc(t.title)}</b>
      ${p ? `<span class="hint">${esc(p.name)}</span>` : ''}<div class="now-why">${reasons.map(reason).join('')}</div>
      <div class="row-actions now-acts"><button class="btn small primary" data-now="done" data-id="${t.id}">Done</button><button class="btn small" data-now="later" data-id="${t.id}">Not now</button><button class="btn small" data-now="open" data-id="${t.id}">Open</button></div></div>`; }).join('')}
    ${a.where !== 'anywhere' && res.total < 5 ? `<p class="view-sub">${res.total ? 'Nothing else fits here.' : ''} <button class="link-btn" data-now-set="where" data-v="anywhere">Try Anywhere</button></p>` : ''}
    ${a.minutes && res.total < 3 ? `<p class="view-sub"><button class="link-btn" data-now-set="minutes" data-v="0">Any length</button></p>` : ''}`;
}

export async function nowAction(el) {
  if (el.dataset.nowSet) {
    const s = (app.now ||= {});
    const k = el.dataset.nowSet;
    s[k] = k === 'minutes' ? Number(el.dataset.v) : el.dataset.v;
    remember({ ...load(), [k]: s[k] });
    app.render();
    return;
  }
  const t = byId(db.tasks, el.dataset.id);
  if (!t) return;
  const patch = async (fields) => { const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select()); syncRow('tasks', t, row); app.render(); };
  if (el.dataset.now === 'done') { await patch({ completed_at: new Date().toISOString() }); toast(`Done: ${t.title}`, [{ label: 'Undo', run: () => patch({ completed_at: null }) }]); }
  else if (el.dataset.now === 'later') { const was = t.defer_at; await patch({ defer_at: atDefaultTime(addDays(startOfToday(), 1), 'defer_at').toISOString() }); toast('Back tomorrow', [{ label: 'Undo', run: () => patch({ defer_at: was }) }]); }
  else if (el.dataset.now === 'open' && app.openTask) app.openTask(t.id);
}
