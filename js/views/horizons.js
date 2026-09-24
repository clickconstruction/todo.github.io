// Horizons of Focus: purpose and principles (50,000 ft), vision (40k), goals (30k), areas of focus
// (20k), projects (10k) and actions (runway). Areas carry standards and a balance check; goals show
// progress over the projects that serve them. Nothing is deleted: areas archive, goals end.
import { db, app, sb, run, syncRow, esc, byId, isOpen, openSheet, $, toast } from '../state.js';
import { fmtDate } from '../dates.js';
import { projectRow } from '../rows.js';
import { saveSettings } from '../prefs.js';
import { isAvailable } from '../availability.js';
import { areaBalance, isDueForReview, bigReviewsDue } from '../whatnow.js';

export const liveAreas = () => (db.areas || []).filter((a) => !a.archived_at).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
export const activeGoals = () => (db.goals || []).filter((g) => g.status === 'active').sort((a, b) => String(a.target_date || '9').localeCompare(String(b.target_date || '9')) || a.title.localeCompare(b.title));
const liveProject = (p) => ['active', 'on_hold'].includes(p.status);
export function goalProgress(g) {
  const ps = db.projects.filter((p) => p.goal_id === g.id && p.status !== 'dropped');
  return { done: ps.filter((p) => p.status === 'completed').length, total: ps.length, projects: ps };
}
// Quarterly check-in and yearly read (Weekly Review step, ladder chips).
export const bigDue = () => bigReviewsDue({ settings: app.settings || {}, goals: db.goals || [], areas: db.areas || [], projects: db.projects });
// Areas and goals due for their review (monthly by default); for the Weekly Review.
export const horizonsDue = () => [...liveAreas().filter((a) => isDueForReview(a)), ...activeGoals().filter((g) => isDueForReview(g))];

// Completed actions in an area's projects in the last 60 days (fetched once, lazily).
function completedRecently(area) {
  app.hzStats = app.hzStats || {};
  if (area.id in app.hzStats) return app.hzStats[area.id];
  app.hzStats[area.id] = null;
  const ids = db.projects.filter((p) => p.area_id === area.id).map((p) => p.id);
  if (!ids.length) { app.hzStats[area.id] = 0; return 0; }
  run(sb.from('tasks').select('id').in('project_id', ids).gte('completed_at', new Date(Date.now() - 60 * 86400000).toISOString()).limit(500))
    .then((rows) => { app.hzStats[area.id] = rows.length; app.render(); }).catch(() => { delete app.hzStats[area.id]; });
  return null;
}
const balanceOf = (a) => areaBalance(a, { projects: db.projects, tasks: db.tasks, completedSince: completedRecently(a) });

const readAgo = (iso) => (iso ? `read ${fmtDate(iso)}` : 'not read yet');
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

// ---------- the ladder ----------
export function viewHorizons(sub) {
  if (sub === 'purpose' || sub === 'vision') return textPage(sub);
  if (sub === 'areas') return areasList();
  if (sub === 'goals') return goalsList();
  if (sub === 'quarterly') return quarterlyHtml();
  const s = app.settings || {};
  const areas = liveAreas();
  const goals = activeGoals();
  const quiet = areas.filter((a) => balanceOf(a).warnings.length);
  const live = db.projects.filter((p) => p.status === 'active');
  const noOutcome = live.filter((p) => !String(p.outcome || '').trim()).length;
  const available = db.tasks.filter((t) => isOpen(t) && isAvailable(t)).length;
  const open = db.tasks.filter(isOpen).length;
  const due = horizonsDue().length;
  const big = bigDue();
  const g0 = goals[0];
  const row = (href, alt, title, sub2) => `<a class="hz-level" href="${href}"><span class="hz-alt">${alt}</span><span class="hz-main"><b>${title}</b>${sub2 ? `<span class="hint">${sub2}</span>` : ''}</span><span class="hz-go">›</span></a>`;
  return `<div class="view-head"><h1 class="horizons">Horizons</h1></div>
    <p class="view-sub">From why you do it down to what’s next. The higher levels change slowly; look at them monthly and yearly.</p>
    <div class="hz-ladder">
      ${row('#horizons/purpose', '50k', 'Purpose and principles', s.purpose ? `${esc(firstLine(s.purpose).slice(0, 80))} · ${readAgo(s.purpose_read_at)}${big.yearly.includes('purpose') ? ' <span class="chip warn">yearly read due</span>' : ''}` : 'Why you do what you do. Write it once.')}
      ${row('#horizons/vision', '40k', `Vision${s.vision_year ? ` · ${s.vision_year}` : ''}`, s.vision ? `“${esc(firstLine(s.vision).slice(0, 80))}” · ${readAgo(s.vision_read_at)}${big.yearly.includes('vision') ? ' <span class="chip warn">yearly read due</span>' : ''}` : 'What success looks like in 3 to 5 years.')}
      ${row(big.quarterly ? '#horizons/quarterly' : '#horizons/goals', '30k', `Goals · ${goals.length} active${big.quarterly ? ' <span class="chip warn">quarterly check-in due</span>' : ''}`, g0 ? `${esc(g0.title)} <span class="chip">${goalProgress(g0).done} of ${goalProgress(g0).total}</span>` : '1–2 year objectives your projects serve.')}
      ${row('#horizons/areas', '20k', `Areas of focus · ${areas.length}`, quiet.length ? quiet.slice(0, 2).map((a) => `<span class="chip warn">${esc(a.name)}: ${esc(balanceOf(a).warnings[0])}</span>`).join(' ') : areas.length ? 'All in balance.' : 'Responsibilities you keep up: work, health, family, home.')}
      ${row('#projects', '10k', `Projects · ${live.length} active`, noOutcome ? `${noOutcome} without a “done looks like”` : 'Every project says what done looks like.')}
      ${row('#now', 'Runway', `Actions · ${open}`, `${available} available now · What now? →`)}
    </div>
    ${due ? `<p class="view-sub">${due} area${due === 1 ? '' : 's'} or goal${due === 1 ? '' : 's'} due for review. They’re a step in the <a href="#weekly/horizons">Weekly Review</a>.</p>` : ''}
    <p class="view-sub">Every quarter: <a href="#horizons/quarterly">the quarterly check-in</a>${s.horizons_quarter_at ? ` (last ${esc(fmtDate(s.horizons_quarter_at))})` : ''}. Every year: read your purpose and vision.</p>`;
}

function textPage(kind) {
  const s = app.settings || {};
  const isP = kind === 'purpose';
  return `<a class="back" href="#horizons">‹ Horizons</a>
    <div class="view-head"><h1 class="horizons">${isP ? 'Purpose and principles' : 'Vision'}</h1></div>
    <p class="view-sub">${isP ? 'Why you do what you do, and the standards you hold yourself to. Read it once a year, or whenever a decision is hard.' : 'Where you want to be in 3 to 5 years: your work, family, health, money. Read it once a year.'}</p>
    ${isP ? '' : `<label class="set-row hz-year"><span class="set-text"><b>By</b></span><input type="number" min="2000" max="2200" data-hz-field="vision_year" value="${esc(s.vision_year || new Date().getFullYear() + 3)}" inputmode="numeric"></label>`}
    <textarea class="hz-text" data-hz-field="${kind}" rows="14" placeholder="${isP ? 'I build things that last and treat people fairly…' : 'Two crews running without me on the phone at night…'}">${esc(s[kind] || '')}</textarea>
    <p class="hint">${readAgo(s[`${kind}_read_at`])} · saves as you type</p>
    <p><button class="btn" data-hz="read" data-kind="${kind}">Mark as read today</button></p>`;
}

// The quarterly check-in: goals and areas as a whole.
export function quarterlyBody() {
  const b = bigDue();
  const goals = activeGoals();
  const s = app.settings || {};
  return `${goals.length ? `<h2 class="section-title">Goals · ${goals.length}</h2><div class="group-list">${goals.map((g) => { const pr = goalProgress(g); const late = b.lateGoals.includes(g); return `<a class="group-row" href="#goal/${g.id}"><span class="group-main"><span>${esc(g.title)}${late ? ' <span class="chip warn">past its date</span>' : ''}</span>
      <span class="group-sub">${pr.done} of ${pr.total} projects${g.target_date ? ` · by ${esc(fmtDate(`${g.target_date}T12:00:00`))}` : ''}</span></span></a>`; }).join('')}</div>` : '<p class="hint">No active goals. Is there something worth aiming at this year? <button class="link-btn" data-hz="new-goal">+ Goal</button></p>'}
    ${b.lateGoals.length ? `<p class="hint">Past its date: achieve it, give it a new date, or drop it.</p>` : ''}
    ${b.areasNoGoal.length ? `<h2 class="section-title">Areas with no goal · ${b.areasNoGoal.length}</h2><p class="hint">Fine if they’re steady; worth a goal if you want them to change.</p><div class="group-list">${b.areasNoGoal.map((a) => `<a class="group-row" href="#area/${a.id}"><span>${esc(a.name)}</span></a>`).join('')}</div>` : ''}
    ${b.looseProjects.length ? `<h2 class="section-title">Projects serving no area or goal · ${b.looseProjects.length}</h2><p class="hint">Still worth doing? Give each a home, or put it on hold.</p>${b.looseProjects.slice(0, 12).map(projectRow).join('')}${b.looseProjects.length > 12 ? `<p class="hint">${b.looseProjects.length - 12} more in Projects.</p>` : ''}` : ''}
    <p class="hint">${s.horizons_quarter_at ? `Last check-in ${esc(fmtDate(s.horizons_quarter_at))}.` : 'Your first quarterly check-in.'}</p>
    <div class="wk-finish"><button class="btn ${b.quarterly ? 'primary' : ''}" data-hz="quarter-done">Quarterly check-in done</button></div>`;
}
function quarterlyHtml() {
  return `<a class="back" href="#horizons">‹ Horizons</a>
    <div class="view-head"><h1 class="horizons">Quarterly check-in</h1></div>
    <p class="view-sub">Every three months: are these still the right goals, and is every area getting what it needs?</p>
    ${quarterlyBody()}`;
}

function areasList() {
  const areas = liveAreas();
  const folders = db.folders.filter((f) => !f.archived_at && !areas.some((a) => a.name.toLowerCase() === f.name.toLowerCase()));
  return `<a class="back" href="#horizons">‹ Horizons</a>
    <div class="view-head"><h1 class="horizons">Areas of focus</h1><button class="btn small primary" data-hz="new-area">+ Area</button></div>
    <p class="view-sub">Ongoing responsibilities with no end date. Each should have something active; the ones that don’t are flagged.</p>
    ${areas.length ? `<div class="group-list">${areas.map((a) => { const b = balanceOf(a); return `<a class="group-row" href="#area/${a.id}"><span class="group-main"><span>${esc(a.name)}</span>
      <span class="group-sub">${b.active} active project${b.active === 1 ? '' : 's'}${b.warnings.map((w) => ` <span class="chip warn">${esc(w)}</span>`).join('')}${isDueForReview(a) ? ' <span class="chip">review due</span>' : ''}</span></span></a>`; }).join('')}</div>` : '<p class="empty">No areas yet.</p>'}
    ${folders.length ? `<p class="view-sub"><button class="btn small" data-hz="areas-from-folders">Make areas from ${folders.length} folder${folders.length === 1 ? '' : 's'}</button> <span class="hint">${folders.slice(0, 4).map((f) => esc(f.name)).join(', ')}: their projects join the area; folders stay as they are.</span></p>` : ''}`;
}

function goalsList() {
  const goals = activeGoals();
  const ended = (db.goals || []).filter((g) => g.status !== 'active');
  const row = (g) => { const pr = goalProgress(g); const area = g.area_id && byId(db.areas || [], g.area_id); return `<a class="group-row" href="#goal/${g.id}"><span class="group-main"><span>${g.status === 'achieved' ? '✓ ' : ''}${esc(g.title)}</span>
    <span class="group-sub">${[area && esc(area.name), g.target_date && `by ${esc(fmtDate(`${g.target_date}T12:00:00`))}`, `${pr.done} of ${pr.total} projects`].filter(Boolean).join(' · ')}</span>
    ${pr.total ? `<span class="hz-bar"><i style="width:${Math.round((pr.done / pr.total) * 100)}%"></i></span>` : ''}</span></a>`; };
  return `<a class="back" href="#horizons">‹ Horizons</a>
    <div class="view-head"><h1 class="horizons">Goals</h1><button class="btn small primary" data-hz="new-goal">+ Goal</button></div>
    <p class="view-sub">What you want to achieve in the next 1 to 2 years. Link projects to the goal they serve; their actions rank higher in What now?</p>
    ${goals.length ? `<div class="group-list">${goals.map(row).join('')}</div>` : '<p class="empty">No goals yet.</p>'}
    ${ended.length ? `<details class="dropped-tags"><summary class="section-title">Achieved and dropped · ${ended.length}</summary><div class="group-list">${ended.map(row).join('')}</div></details>` : ''}`;
}

// ---------- an area ----------
export function viewArea(id) {
  const a = byId(db.areas || [], id);
  if (!a) return '<a class="back" href="#horizons/areas">‹ Areas</a><p class="empty">Area not found.</p>';
  const b = balanceOf(a);
  const goals = (db.goals || []).filter((g) => g.area_id === a.id && g.status === 'active');
  const projects = db.projects.filter((p) => p.area_id === a.id && liveProject(p));
  const done = completedRecently(a);
  const unassigned = db.projects.filter((p) => liveProject(p) && !p.area_id).sort((x, y) => x.name.localeCompare(y.name));
  return `<a class="back" href="#horizons/areas">‹ Areas</a>
    <div class="view-head"><h1 class="horizons">${esc(a.name)}${a.archived_at ? ' <span class="chip">archived</span>' : ''}</h1><button class="btn small" data-hz="edit-area" data-id="${a.id}">Edit</button></div>
    <p class="view-sub">Area of focus · reviewed every ${a.review_every_days} days · ${a.last_reviewed_at ? `last ${esc(fmtDate(a.last_reviewed_at))}` : 'never reviewed'}</p>
    <div class="hz-standards"><span class="hint">What good looks like</span>${a.standards ? `<p>${esc(a.standards)}</p>` : '<p class="hint">Not written yet. <button class="link-btn" data-hz="edit-area" data-id="' + a.id + '">Add standards</button></p>'}</div>
    ${b.warnings.length ? `<p class="persp-warning">⚖️ ${esc(a.name)}: ${esc(b.warnings.join(', '))}.</p>` : ''}
    ${goals.length ? `<h2 class="section-title">Goals · ${goals.length}</h2><div class="group-list">${goals.map((g) => { const pr = goalProgress(g); return `<a class="group-row" href="#goal/${g.id}"><span class="group-main"><span>${esc(g.title)}</span><span class="group-sub">${pr.done} of ${pr.total} projects${g.target_date ? ` · by ${esc(fmtDate(`${g.target_date}T12:00:00`))}` : ''}</span>${pr.total ? `<span class="hz-bar"><i style="width:${Math.round((pr.done / pr.total) * 100)}%"></i></span>` : ''}</span></a>`; }).join('')}</div>` : ''}
    <h2 class="section-title">Projects · ${projects.length}</h2>
    ${projects.length ? projects.map(projectRow).join('') : '<p class="empty small">No projects in this area.</p>'}
    ${unassigned.length ? `<label class="hz-link">Add a project to this area <select data-hz-link-area="${a.id}"><option value="">Choose…</option>${unassigned.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
    <h2 class="section-title">Balance</h2>
    <p class="view-sub">${done == null ? 'Counting…' : `${done} action${done === 1 ? '' : 's'} done in the last 60 days`} · ${b.open} open action${b.open === 1 ? '' : 's'}</p>
    <p><button class="btn ${isDueForReview(a) ? 'primary' : ''}" data-hz="review-area" data-id="${a.id}">Mark reviewed</button> <button class="btn small" data-hz="new-goal" data-area="${a.id}">+ Goal in this area</button></p>`;
}

// ---------- a goal ----------
export function viewGoal(id) {
  const g = byId(db.goals || [], id);
  if (!g) return '<a class="back" href="#horizons/goals">‹ Goals</a><p class="empty">Goal not found.</p>';
  const pr = goalProgress(g);
  const area = g.area_id && byId(db.areas || [], g.area_id);
  const unlinked = db.projects.filter((p) => liveProject(p) && p.goal_id !== g.id).sort((x, y) => x.name.localeCompare(y.name));
  return `<a class="back" href="#horizons/goals">‹ Goals</a>
    <div class="view-head"><h1 class="horizons">${g.status === 'achieved' ? '✓ ' : ''}${esc(g.title)}</h1><button class="btn small" data-hz="edit-goal" data-id="${g.id}">Edit</button></div>
    <p class="view-sub">${[area && `<a href="#area/${area.id}">${esc(area.name)}</a>`, g.target_date && `by ${esc(fmtDate(`${g.target_date}T12:00:00`))}`, g.status !== 'active' && esc(g.status)].filter(Boolean).join(' · ') || 'Goal'}</p>
    ${g.why ? `<div class="hz-standards"><span class="hint">Why it matters</span><p>${esc(g.why)}</p></div>` : ''}
    <div class="hz-progress"><span class="hz-bar big"><i style="width:${pr.total ? Math.round((pr.done / pr.total) * 100) : 0}%"></i></span><span class="hint">${pr.done} of ${pr.total} projects done</span></div>
    <h2 class="section-title">Projects serving it · ${pr.total}</h2>
    ${pr.projects.length ? pr.projects.map(projectRow).join('') : '<p class="empty small">No projects yet. What’s the first project toward this?</p>'}
    ${unlinked.length ? `<label class="hz-link">Link a project <select data-hz-link-goal="${g.id}"><option value="">Choose…</option>${unlinked.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
    <p class="head-actions"><button class="btn ${isDueForReview(g) && g.status === 'active' ? 'primary' : ''}" data-hz="review-goal" data-id="${g.id}">Mark reviewed</button>
      ${g.status === 'active' ? `<button class="btn" data-hz="achieve" data-id="${g.id}">🎉 Achieved</button><button class="btn small" data-hz="drop-goal" data-id="${g.id}">Drop</button>` : `<button class="btn small" data-hz="reopen-goal" data-id="${g.id}">Make active again</button>`}</p>`;
}

// ---------- saving ----------
async function save(table, key, row, fields) {
  if (row && row.id) { const [r] = await run(sb.from(table).update(fields).eq('id', row.id).select()); return syncRow(key, row, r); }
  const sort = Math.max(-1, ...(db[key] || []).map((x) => x.sort || 0)) + 1;
  const [r] = await run(sb.from(table).insert({ sort, ...fields }).select());
  (db[key] = db[key] || []).push(r);
  return r;
}
export const saveArea = (a, fields) => save('areas', 'areas', a, fields);
export const saveGoal = (g, fields) => save('goals', 'goals', g, fields);
async function linkProject(p, fields) { const [r] = await run(sb.from('projects').update(fields).eq('id', p.id).select()); syncRow('projects', p, r); }

export async function areasFromFolders() {
  const taken = new Set(liveAreas().map((a) => a.name.toLowerCase()));
  let n = 0;
  for (const f of db.folders.filter((x) => !x.archived_at && !taken.has(x.name.toLowerCase()))) {
    const a = await saveArea(null, { name: f.name });
    for (const p of db.projects.filter((x) => x.folder_id === f.id && !x.area_id)) await linkProject(p, { area_id: a.id });
    n += 1;
  }
  return n;
}

function openAreaEditor(a) {
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet"><h2>${a ? 'Edit area' : 'New area of focus'}</h2>
    <label>Name<input type="text" name="name" value="${esc(a ? a.name : '')}" required maxlength="100" placeholder="Health, Click Plumbing, Family…" autocomplete="off"></label>
    <label>What good looks like <span class="hint">the standard you keep</span><textarea name="standards" rows="4" placeholder="Every job invoiced within 2 days…">${esc(a ? a.standards : '')}</textarea></label>
    <label>Review every<select name="review_every_days">${[[7, 'Week'], [14, '2 weeks'], [30, 'Month'], [90, 'Quarter'], [182, '6 months'], [365, 'Year']].map(([v, l]) => `<option value="${v}" ${(a ? a.review_every_days : 30) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="actions">${a ? `<button type="button" class="btn danger" data-archive>${a.archived_at ? 'Restore' : 'Archive'}</button>` : ''}<div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div></form>`);
  const form = $('form', sheet);
  $('[data-cancel]', form).onclick = () => sheet.close();
  const arch = $('[data-archive]', form);
  if (arch) arch.onclick = async () => { sheet.close(); await saveArea(a, { archived_at: a.archived_at ? null : new Date().toISOString() }); if (!a.archived_at) location.hash = '#horizons/areas'; app.render(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const fields = { name: f.get('name').trim(), standards: f.get('standards'), review_every_days: Number(f.get('review_every_days')) };
    if (!fields.name) return;
    sheet.close();
    const row = await saveArea(a, fields);
    if (!a) location.hash = `#area/${row.id}`;
    app.render();
  };
  sheet.showModal();
}

function openGoalEditor(g, defaults = {}) {
  const v = g || { title: '', why: '', area_id: null, target_date: null, review_every_days: 30, ...defaults };
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet"><h2>${g ? 'Edit goal' : 'New goal'}</h2>
    <label>Goal<input type="text" name="title" value="${esc(v.title)}" required maxlength="300" placeholder="Grow maintenance revenue to $15k a month" autocomplete="off"></label>
    <div class="grid2"><label>By<input type="date" name="target_date" value="${esc(v.target_date || '')}"></label>
      <label>Area<select name="area_id"><option value="">No area</option>${liveAreas().map((a) => `<option value="${a.id}" ${a.id === v.area_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label></div>
    <label>Why it matters<textarea name="why" rows="3">${esc(v.why)}</textarea></label>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div></form>`);
  const form = $('form', sheet);
  $('[data-cancel]', form).onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const fields = { title: f.get('title').trim(), target_date: f.get('target_date') || null, area_id: f.get('area_id') || null, why: f.get('why') };
    if (!fields.title) return;
    sheet.close();
    const row = await saveGoal(g, fields);
    if (!g) location.hash = `#goal/${row.id}`;
    app.render();
  };
  sheet.showModal();
}

export async function horizonsAction(el) {
  const a = el.dataset.hz;
  const area = el.dataset.id && byId(db.areas || [], el.dataset.id);
  const goal = el.dataset.id && byId(db.goals || [], el.dataset.id);
  const now = new Date().toISOString();
  if (a === 'new-area') openAreaEditor(null);
  else if (a === 'edit-area' && area) openAreaEditor(area);
  else if (a === 'new-goal') openGoalEditor(null, el.dataset.area ? { area_id: el.dataset.area } : {});
  else if (a === 'edit-goal' && goal) openGoalEditor(goal);
  else if (a === 'review-area' && area) { await saveArea(area, { last_reviewed_at: now }); toast(`Reviewed ${area.name}`); }
  else if (a === 'review-goal' && goal) { await saveGoal(goal, { last_reviewed_at: now }); toast('Reviewed'); }
  else if (a === 'achieve' && goal) { await saveGoal(goal, { status: 'achieved' }); toast(`🎉 Achieved: ${goal.title}`, [{ label: 'Undo', run: async () => { await saveGoal(goal, { status: 'active' }); app.render(); } }]); }
  else if (a === 'drop-goal' && goal) { await saveGoal(goal, { status: 'dropped' }); toast(`Dropped: ${goal.title}`, [{ label: 'Undo', run: async () => { await saveGoal(goal, { status: 'active' }); app.render(); } }]); }
  else if (a === 'reopen-goal' && goal) await saveGoal(goal, { status: 'active' });
  else if (a === 'areas-from-folders') { const n = await areasFromFolders(); toast(`Made ${n} area${n === 1 ? '' : 's'}`); }
  else if (a === 'read') { await saveSettings({ [`${el.dataset.kind}_read_at`]: now }); }
  else if (a === 'quarter-done') { await saveSettings({ horizons_quarter_at: now }); toast('Quarterly check-in done · next in three months'); }
  app.render();
}

// Text pages save as you type (debounced); selects link projects.
let textTimer;
export function horizonsInput(e) {
  const el = e.target.closest && e.target.closest('[data-hz-field]');
  if (!el) return false;
  clearTimeout(textTimer);
  const key = el.dataset.hzField;
  const value = key === 'vision_year' ? (Number(el.value) || null) : el.value;
  textTimer = setTimeout(() => saveSettings({ [key]: value }, { quiet: true }).catch(() => {}), 600);
  return true;
}
export async function horizonsChange(e) {
  const la = e.target.closest && e.target.closest('[data-hz-link-area]');
  const lg = e.target.closest && e.target.closest('[data-hz-link-goal]');
  if (!la && !lg) return false;
  const p = byId(db.projects, (la || lg).value);
  if (!p) return true;
  await linkProject(p, la ? { area_id: la.dataset.hzLinkArea } : { goal_id: lg.dataset.hzLinkGoal });
  if (app.hzStats) delete app.hzStats[la ? la.dataset.hzLinkArea : ''];
  app.render();
  return true;
}
