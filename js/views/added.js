// Last added: what came in lately, newest first, by day. Actions and projects made in the last 7, 30 or 90
// days (#added, #added/30, #added/90; a way in after the days, #added/7/email, keeps only that). A row says
// when it was added, how it came in (the app says nothing; email, the Shortcut, the share sheet, Claude, a
// template and an import say so) and where it is now: an Inbox chip while it waits to be clarified, else the
// project, tags, who it waits on, the tickler; done and dropped rows are struck through. What was made
// together rides on one line: steps on their card (whose row counts them), actions on the project they were
// made with ("with 6 actions"). The next occurrences a repeat makes on its own stay out unless asked for (the Repeats
// chip). Open cards are local; closed ones older than the session come from the server once per range
// (app.addedCache, which findTask in js/main.js reads so their rows open; their check is only a mark).
import { db, app, sb, run, esc, isOpen } from '../state.js';
import { startOfToday, addDays, fmtStamp } from '../dates.js';
import { taskRow } from '../rows.js';
import { nextAction } from '../availability.js';

export const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
// How a card came in (tasks.source; an import sets import_id): key, the tally's label, the row's words, the
// chip's title, and the words of the count line.
export const SOURCES = [
  ['app', 'App', '', 'Added in the app', 'in the app'],
  ['email', 'Email', '✉️ via email', 'Sent or BCC’d to inbox@todotooling.com', 'by email'],
  ['capture', 'Shortcut', '📱 via Shortcut', 'The iPhone Shortcut: Siri, the lock screen, the Action button', 'with the Shortcut'],
  ['share', 'Share sheet', '📱 via share sheet', 'Shared to the app from another app', 'from the share sheet'],
  ['mcp', 'Claude', '🤖 via Claude', 'Added by Claude', 'by Claude'],
  ['template', 'Template', '📋 via template', 'Made from a template', 'from a template'],
  ['import', 'Imported', '📦 imported', 'Brought in by an import', 'by an import'],
  ['repeat', 'Repeats', '🔁 repeat', 'Next occurrences the app made on its own when one was finished', 'as repeats'],
];
const MAX_ROWS = 400;
const WITH_PROJECT_MS = 5 * 60000; // an action made within five minutes of its project was made with it
const src = (k) => SOURCES.find(([x]) => x === k);
export const sourceOf = (t) => (t.import_id ? 'import' : src(t.source) ? t.source : 'app');
const ic = (e) => `<i class="mi" aria-hidden="true">${e}</i> `;
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const sinceFor = (days) => addDays(startOfToday(), -(days - 1)); // 7 days: today and the six before

// The sidebar's count: cards added today (not the ones a repeat made).
export function addedTodayCount() {
  const d0 = startOfToday();
  return db.tasks.filter((t) => sourceOf(t) !== 'repeat' && new Date(t.created_at) >= d0).length;
}

// Closed cards older than the session aren't local: one read per range, then a redraw with them in.
function loadClosed(key, since) {
  app.addedCache = { key, rows: null };
  run(sb.from('tasks').select('*').gte('created_at', since.toISOString()).or('completed_at.not.is.null,dropped_at.not.is.null').order('created_at', { ascending: false }).limit(1000))
    .then((rows) => { if (app.addedCache && app.addedCache.key === key) { app.addedCache.rows = rows; app.render(); } }, () => {});
}

export function viewAdded(daysArg = '7', way = '') {
  const days = RANGES.some(([d]) => String(d) === String(daysArg)) ? Number(daysArg) : 7;
  const only = src(way) ? way : '';
  const since = sinceFor(days);
  if (!app.addedCache || app.addedCache.key !== String(days)) loadClosed(String(days), since);
  // Everything made in the range: open cards (and today's done ones) from the library, the rest from the server.
  const localIds = new Set(db.tasks.map((t) => t.id));
  const seen = new Set();
  const tasks = [];
  const take = (t) => { if (!seen.has(t.id) && new Date(t.created_at) >= since) { seen.add(t.id); tasks.push(t); } };
  db.tasks.forEach(take);
  (app.addedCache.rows || []).forEach(take);
  const projects = db.projects.filter((p) => new Date(p.created_at) >= since);
  const bySource = new Map();
  tasks.forEach((t) => { const h = sourceOf(t); bySource.set(h, (bySource.get(h) || 0) + 1); });
  const kept = tasks.filter((t) => { const h = sourceOf(t); return only ? h === only : h !== 'repeat'; });
  // What was made together rides on one line: actions on the project made with them, steps on their card.
  const inRange = new Set(kept.map((t) => t.id));
  const projAt = new Map(projects.map((p) => [p.id, new Date(p.created_at).getTime()]));
  const withProject = (t) => { const at = projAt.get(t.project_id); const d = at === undefined ? NaN : new Date(t.created_at) - at; return d >= -60000 && d <= WITH_PROJECT_MS; };
  const actions = new Map(); const foldedTo = new Map();
  const count = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const rows = [];
  kept.forEach((t) => {
    if (withProject(t)) { count(actions, t.project_id); foldedTo.set(t.id, t.project_id); return; }
    if (t.parent_id && inRange.has(t.parent_id)) { if (foldedTo.has(t.parent_id)) count(actions, foldedTo.get(t.parent_id)); return; } // a step rides on its card, whose row counts its steps
    rows.push({ at: new Date(t.created_at), t });
  });
  const shownProjects = projects.filter((p) => !only || actions.get(p.id));
  // A day's count is what was added that day, folded cards included, so the days add up to the count line.
  const dayKey = (d) => new Date(d).toDateString();
  const perDay = new Map();
  kept.forEach((t) => count(perDay, dayKey(t.created_at)));
  shownProjects.forEach((p) => count(perDay, dayKey(p.created_at)));
  const items = [...rows, ...shownProjects.map((p) => ({ at: new Date(p.created_at), p }))].sort((a, b) => b.at - a.at);
  const shown = items.slice(0, MAX_ROWS);

  const d0 = startOfToday();
  const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayLabel = (d) => { const diff = Math.round((d0 - dayOf(d)) / 86400000); return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() !== d0.getFullYear() ? { year: 'numeric' } : {}) }); };
  const leadFor = (t) => {
    const how = src(sourceOf(t))[2];
    return `${t.in_inbox && isOpen(t) ? '<span class="chip inbox" title="Not clarified yet">Inbox</span>' : ''}<span class="meta-added" title="Added ${esc(fmtStamp(t.created_at))}">${ic('🕓')}${esc(time(t.created_at))}</span>${how ? `<span class="meta-how">${how}</span>` : ''}`;
  };
  const projectLine = (p) => {
    const n = actions.get(p.id) || 0;
    const openN = db.tasks.filter((t) => t.project_id === p.id && isOpen(t)).length;
    const next = p.status === 'active' ? nextAction(p) : null;
    return `<a class="group-row added-project ${p.status === 'active' ? '' : 'muted'}" href="#project/${p.id}"><span class="dot"></span><span class="group-main"><span>${ic('🗂️')}${esc(p.name)}${p.status === 'active' ? '' : ` (${esc(p.status.replace('_', ' '))})`}</span>
      <span class="group-sub row-meta"><span class="meta-added">${ic('🕓')}${esc(time(p.created_at))}</span><span>New project${n ? `, with ${plural(n, 'action')}` : ''}</span>${next ? `<span>Next: ${esc(next.title)}</span>` : ''}</span></span><span class="count">${openN || ''}</span></a>`;
  };
  // Rows by day; a run of cards is a list, a run of projects a group list.
  let body = ''; let lastDay = ''; let cur = null;
  const close = () => { const s = cur === 'task' ? '</ul>' : cur === 'project' ? '</div>' : ''; cur = null; return s; };
  const begin = (kind) => { if (cur === kind) return ''; const s = close(); cur = kind; return s + (kind === 'task' ? '<ul class="list">' : '<div class="group-list">'); };
  shown.forEach((it) => {
    const dk = it.at.toDateString();
    if (dk !== lastDay) { lastDay = dk; body += close() + `<h2 class="section-title">${esc(dayLabel(it.at))} · ${perDay.get(dk) || 0}</h2>`; }
    body += it.t ? begin('task') + taskRow(it.t, { lead: leadFor(it.t), readOnly: !localIds.has(it.t.id) }) : begin('project') + projectLine(it.p);
  });
  body += close();

  const seg = `<span class="seg" role="tablist" aria-label="How far back">${RANGES.map(([d, l]) => `<a href="#added/${d}${only ? `/${only}` : ''}" role="tab" class="${d === days ? 'on' : ''}" aria-selected="${d === days}">${l}</a>`).join('')}</span>`;
  const inboxN = kept.filter((t) => t.in_inbox && isOpen(t)).length;
  const doneN = kept.filter((t) => t.completed_at).length;
  const way4 = only ? `${src(only)[4]} ` : '';
  const sub = `${plural(kept.length, 'action')}${shownProjects.length ? ` and ${plural(shownProjects.length, 'project')}` : ''} added ${way4}in the last ${days} days${inboxN ? ` · <a href="#clarify">${inboxN} still in the Inbox</a>` : ''}${doneN ? ` · ${doneN} done` : ''}`;
  const kinds = SOURCES.filter(([k]) => bySource.get(k));
  const tally = kinds.length > 1 ? `<div class="tally added-tally"><a class="chip ${only ? '' : 'on'}" href="#added/${days}" title="Everything added, except what repeats made on their own">All · ${tasks.length - (bySource.get('repeat') || 0)}</a>${kinds.map(([k, label, , title]) => `<a class="chip ${only === k ? 'on' : ''}" href="#added/${days}/${k}" title="${esc(title)}">${label} · ${bySource.get(k)}</a>`).join('')}</div>` : '';
  const next = RANGES.find(([d]) => d > days);
  const empty = `<p class="empty">Nothing added ${way4}in the last ${days} days.${next ? ` <a href="#added/${next[0]}${only ? `/${only}` : ''}">Look back ${next[1]}</a>` : ''}</p>`;
  return `<div class="view-head"><h1 class="added">Last added</h1>${seg}</div>
    <p class="view-sub">${sub}</p>${tally}
    ${shown.length ? body : empty}
    ${items.length > MAX_ROWS ? `<p class="hint added-cap">The newest ${MAX_ROWS} of ${items.length}.</p>` : ''}`;
}
