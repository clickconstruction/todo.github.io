// Dailies: an action done every day (or on chosen weekdays) as a checkbox that starts fresh each
// day, instead of a repeating action that goes overdue. Two tiers, matching Due and Planned:
//   must   "Have to"  a missed day shows (red dot, "missed Thursday") and it's a Daily review must-do
//   should "Should"   a missed day is an empty dot; progress reads "4 of 7 this week"
// tasks.daily = { tier, weekdays?, since }; daily_ticks holds one row per action per ticked day
// (un-ticking keeps the row, state "cleared"). The database keeps the rules (migration 20261101000001).
// Checks (daily.every = 'week' | 'quarter' | 'year'): asked for once per review instead of on a day, never
// in Today. A tick holds for half the cycle, then lapses; finishing the review (the Weekly Review, "Quarterly
// check-in done", "Yearly review done") starts them fresh at once. The rules are in js/daily-rules.js.
import { db, app, sb, run, esc, isOpen, visible, onHoldTagFor, taskSort, toast } from './state.js';

import * as R from './daily-rules.js';

export const { TIERS, tierLabel, dayKey, describeDaily } = R;
const WD = R.WD;

export const isDaily = (t) => !!(t && t.daily && isOpen(t));
export const onDay = (t, key) => R.onDay(t.daily, key);
export const tickRow = (id, key) => (db.dailyTicks || []).find((x) => x.task_id === id && x.day === key) || null;
const dayTicked = (t, key) => { const r = tickRow(t.id, key); return !!r && r.state === 'done'; };
const tickedOf = (t) => (key) => dayTicked(t, key);
export const isWeekly = (t) => isDaily(t) && R.isWeekly(t.daily);
export const isQuarterly = (t) => isDaily(t) && R.isQuarterly(t.daily);
export const isYearly = (t) => isDaily(t) && R.isYearly(t.daily);
export const isCheck = (t) => isDaily(t) && R.isCheck(t.daily);
// A check's tick rows (any state; the rules pick the done ones).
const ticksOf = (t) => (db.dailyTicks || []).filter((x) => x.task_id === t.id);
// The moment a check's review last started it fresh (ms), or null: for a weekly check the open Weekly Review's
// start, else the end of the last one; for the others the last "… done" click (user_settings).
const ms = (iso) => (iso ? Date.parse(iso) || null : null);
export function sinceAtOf(t) {
  const s = app.settings || {};
  if (R.isQuarterly(t.daily)) return ms(s.horizons_quarter_at);
  if (R.isYearly(t.daily)) return ms(s.horizons_year_at);
  const rs = db.weeklyReviews || [];
  const open = rs.find((x) => !x.completed_at && !x.abandoned_at);
  if (open) return ms(open.started_at);
  return rs.reduce((best, x) => Math.max(best, ms(x.completed_at) || 0, ms(x.abandoned_at) || 0), 0) || null;
}
// Is its box ticked: that day for a daily one; for a check, its newest tick since the review started it fresh, still within half the cycle.
export const isTicked = (t, key = dayKey()) => (R.isCheck(t.daily) ? R.checkTicked(t.daily, R.latestTick(ticksOf(t), sinceAtOf(t))) : dayTicked(t, key));
export const week = (t, today = dayKey()) => R.week(t.daily, tickedOf(t), today);
export const running = (t, today = dayKey()) => R.running(t.daily, tickedOf(t), today);
export const summary = (t, today = dayKey()) => (R.isCheck(t.daily) ? R.checkLine(t.daily, ticksOf(t), sinceAtOf(t)) : R.summary(t.daily, tickedOf(t), today));

// Today's dailies by tier: open, asked for today, not parked by an on-hold tag. Could = a menu of options.
export function todaysDailies(today = dayKey()) {
  const list = db.tasks.filter((t) => isDaily(t) && visible(t) && onDay(t, today) && !onHoldTagFor(t)).sort(taskSort);
  return { must: list.filter((t) => t.daily.tier === 'must'), should: list.filter((t) => t.daily.tier !== 'must' && t.daily.tier !== 'could'), could: list.filter((t) => t.daily.tier === 'could') };
}
// Have-to dailies not ticked yet today: the Daily review's must-dos and the Forecast badge count them.
export const mustLeft = (today = dayKey()) => todaysDailies(today).must.filter((t) => !isTicked(t, today));

// The Weekly Review's "Weekly checks": open weekly ones, not parked by an on-hold tag.
export const weeklyChecks = () => db.tasks.filter((t) => isWeekly(t) && visible(t) && !onHoldTagFor(t)).sort(taskSort);
// The quarterly check-in's "Quarterly checks" and the yearly review's "Yearly checks", the same way.
export const quarterlyChecks = () => db.tasks.filter((t) => isQuarterly(t) && visible(t) && !onHoldTagFor(t)).sort(taskSort);
export const yearlyChecks = () => db.tasks.filter((t) => isYearly(t) && visible(t) && !onHoldTagFor(t)).sort(taskSort);

export async function tickDaily(t, on = !isTicked(t), key = dayKey()) {
  const check = R.isCheck(t.daily);
  if (check && !on) { // un-tick every tick the box stands for (usually one, maybe from an earlier day)
    const rows = R.countingTicks(t.daily, ticksOf(t), sinceAtOf(t));
    for (const r of rows) { const [row] = await run(sb.from('daily_ticks').update({ state: 'cleared' }).eq('id', r.id).select()); Object.assign(r, row); }
    app.render();
    return;
  }
  const cur = tickRow(t.id, key);
  if (cur) {
    const [row] = await run(sb.from('daily_ticks').update({ state: on ? 'done' : 'cleared' }).eq('id', cur.id).select());
    Object.assign(cur, row);
  } else if (on) {
    const [row] = await run(sb.from('daily_ticks').insert({ task_id: t.id, day: key }).select());
    (db.dailyTicks = db.dailyTicks || []).push(row);
  }
  app.render();
  if (on) toast(R.isYearly(t.daily) ? 'Ticked for this year' : R.isQuarterly(t.daily) ? 'Ticked for this quarter' : check ? 'Ticked for this week’s review' : 'Done for today', [{ label: 'Undo', run: () => tickDaily(t, false, key) }]);
}

// A check as its review shows it: the box, the title, and when it was last ticked.
export function checkRow(t, today = dayKey()) {
  const on = isTicked(t, today);
  const line = summary(t, today);
  return `<li class="row dly-row ${on ? 'dly-on' : ''}" data-task="${t.id}">
    <button class="dly-box ${on ? 'on' : ''}" data-dly-tick="${t.id}" aria-pressed="${on}" aria-label="${on ? 'Un-tick' : 'Tick'} “${esc(t.title)}” for this ${R.isYearly(t.daily) ? 'year' : R.isQuarterly(t.daily) ? 'quarter' : 'review'}">✓</button>
    <div class="row-main"><div class="row-title">${esc(t.title)}</div>${line ? `<div class="row-meta dly-meta"><span>${esc(line)}</span></div>` : ''}</div>
  </li>`;
}

const dots = (t, today) => `<span class="dly-dots" aria-hidden="true">${week(t, today).map((d) => `<i class="dly-dot ${d.state}${d.state === 'miss' && t.daily.tier === 'must' ? ' red' : ''}"></i>`).join('')}</span>`;
export function dailyRow(t, today = dayKey()) {
  const on = isTicked(t, today);
  const line = summary(t, today);
  return `<li class="row dly-row ${on ? 'dly-on' : ''}" data-task="${t.id}">
    <button class="dly-box ${on ? 'on' : ''}" data-dly-tick="${t.id}" aria-pressed="${on}" aria-label="${on ? 'Un-tick' : 'Tick'} “${esc(t.title)}” for today">✓</button>
    <div class="row-main"><div class="row-title">${esc(t.title)}</div>
      <div class="row-meta dly-meta">${t.daily.tier === 'could' ? '' : dots(t, today)}${line ? `<span class="${/^missed/.test(line) ? 'dly-missed' : ''}">${esc(line)}</span>` : ''}</div></div>
  </li>`;
}
// How an action would look as a daily one, before it is one (a Full Review suggestion): the row as Today
// will show it, not clickable, starting today, and where it goes. Days before today are off: nothing to miss yet.
export function dailyPreview(title, daily, today = dayKey()) {
  if (R.isCheck(daily)) {
    const kind = { week: 'weekly', quarter: 'quarterly', year: 'yearly' }[daily.every];
    const where = { week: '→ Weekly Review → Get current → Weekly checks', quarter: '→ Horizons → Quarterly check-in → Quarterly checks', year: '→ Horizons → Yearly review → Yearly checks' }[daily.every];
    return `<div class="sg-dly" data-dly-preview="${kind}" role="img" aria-label="How it will look in ${esc(R.CHECKS[daily.every].where)}: a checkbox, ${esc(title)}">
    <span class="dly-box" aria-hidden="true">✓</span>
    <span class="sg-dly-main"><span class="row-title">${esc(title)}</span><span class="row-meta dly-meta"><span>starts fresh each ${daily.every === 'week' ? 'review' : daily.every === 'quarter' ? 'check-in' : 'year'}</span></span></span>
  </div>
  <span class="hint sg-dly-where">${where}</span>`;
  }
  const d = { ...daily, since: today };
  const asked = R.onDay(d, today);
  const next = asked ? null : Array.from({ length: 7 }, (_, i) => { const x = new Date(`${today}T12:00`); x.setDate(x.getDate() + i + 1); return x; }).find((x) => R.onDay(d, dayKey(x)));
  const line = d.tier === 'could' ? 'any day you like; never a miss' : asked ? 'starts today' : `first on ${next ? WD[next.getDay()] : 'its next day'}`;
  return `<div class="sg-dly" data-dly-preview="${esc(d.tier)}" role="img" aria-label="How it will look in Today: a checkbox, ${esc(title)}, ${esc(line)}">
    <span class="dly-box" aria-hidden="true">✓</span>
    <span class="sg-dly-main"><span class="row-title">${esc(title)}</span>
      <span class="row-meta dly-meta">${d.tier === 'could' ? '' : `<span class="dly-dots" aria-hidden="true">${R.week(d, () => false, today).map((x) => `<i class="dly-dot ${x.state}"></i>`).join('')}</span>`}<span>${esc(line)}</span></span></span>
  </div>
  <span class="hint sg-dly-where">→ Forecast → Today, under “${esc(tierLabel(d.tier))}”${d.tier === 'must' ? ', and the Daily review’s must-dos' : d.tier === 'could' ? ' (folded away until you open it)' : ''}</span>`;
}

// Forecast → Today: the two tiers, above Due.
export function dailyBlock(today = dayKey()) {
  const { must, should, could } = todaysDailies(today);
  const sec = (tier, list) => (list.length ? `<h2 class="section-title dly-title" data-dly-tier="${tier}">${esc(tierLabel(tier))} <span class="hint">${list.filter((t) => isTicked(t, today)).length} of ${list.length}</span></h2>
    <ul class="list dly-list">${list.map((t) => dailyRow(t, today)).join('')}</ul>` : '');
  // Could: a menu of options, folded away; what you ticked today shows in its count.
  const menu = could.length ? `<details class="dly-could" ${app.couldOpen ? 'open' : ''} data-dly-could><summary class="section-title dly-title" data-dly-tier="could">${esc(tierLabel('could'))} <span class="hint">${could.filter((t) => isTicked(t, today)).length ? `${could.filter((t) => isTicked(t, today)).length} of ` : ''}${could.length}</span></summary>
    <ul class="list dly-list">${could.map((t) => dailyRow(t, today)).join('')}</ul></details>` : '';
  return sec('must', must) + sec('should', should) + menu;
}

// Editor field (Repeat and alerts → Every day). collect() → daily (object) or null.
export function dailyFieldHtml(row) {
  const d = row.daily || null;
  const wk = R.isCheck(d);
  const wd = d && Array.isArray(d.weekdays) ? d.weekdays : [];
  return `<fieldset class="dly-field">
    <legend>Every day</legend>
    <select name="daily_tier" aria-label="Every day">
      <option value="">Not a daily one</option>
      ${TIERS.map(([k, l, s]) => `<option value="${k}" ${d && !wk && d.tier === k ? 'selected' : ''}>${l}, ${s}</option>`).join('')}
      <option value="week" ${R.isWeekly(d) ? 'selected' : ''}>${R.WEEKLY_LABEL}</option>
      <option value="quarter" ${R.isQuarterly(d) ? 'selected' : ''}>${R.QUARTERLY_LABEL}</option>
      <option value="year" ${R.isYearly(d) ? 'selected' : ''}>${R.YEARLY_LABEL}</option></select>
    <div class="weekday-picker dly-days" ${d && !wk ? '' : 'hidden'} role="group" aria-label="On these days (none ticked = every day)">
      ${WD.map((n, i) => `<label><input type="checkbox" name="daily_wd" value="${i}" ${wd.includes(i) ? 'checked' : ''}><span>${n.slice(0, 2)}</span></label>`).join('')}
    </div>
    <p class="hint" data-dly-hint></p>
  </fieldset>`;
}
export function wireDailyField(form, row) {
  const sel = form.elements.daily_tier;
  if (!sel) return () => undefined;
  const hint = form.querySelector('[data-dly-hint]');
  const read = () => {
    if (!sel.value) return null;
    if (R.CHECKS[sel.value]) return { tier: 'should', every: sel.value, ...(row.daily && row.daily.since ? { since: row.daily.since } : {}) };
    const wd = [...form.querySelectorAll('input[name=daily_wd]:checked')].map((x) => Number(x.value));
    return { tier: sel.value, ...(wd.length && wd.length < 7 ? { weekdays: wd } : {}), ...(row.daily && row.daily.since ? { since: row.daily.since } : {}) };
  };
  const sync = () => {
    form.querySelector('.dly-days').hidden = !sel.value || !!R.CHECKS[sel.value];
    hint.textContent = !sel.value ? 'A checkbox that starts fresh each day, instead of a repeating action.'
      : sel.value === 'week' ? 'A checkbox in the Weekly Review, under Weekly checks. Each review starts it fresh, and a tick lapses after 3½ days anyway; it never shows in Today. Its dates and repeat are cleared.'
      : sel.value === 'quarter' ? 'A checkbox in the quarterly check-in (Horizons), under Quarterly checks. “Quarterly check-in done” starts it fresh, and a tick lapses after 45 days anyway; it never shows in Today. Its dates and repeat are cleared.'
      : sel.value === 'year' ? 'A checkbox in the yearly review (Horizons), under Yearly checks. “Yearly review done” starts it fresh, and a tick lapses after six months anyway; it never shows in Today. Its dates and repeat are cleared.'
      : sel.value === 'must' ? 'A checkbox in Today and the Daily review’s must-dos. A missed day shows; nothing piles up. Its dates and repeat are cleared.'
      : sel.value === 'could' ? 'One of a menu of options, folded away at the bottom of Today. Tick it on the days you pick it; there is no such thing as missing it. Its dates and repeat are cleared.'
        : 'A checkbox in Today. A missed day is just an empty dot. Its dates and repeat are cleared.';
  };
  form.addEventListener('change', (e) => { if (/^daily_/.test(e.target.name || '')) sync(); });
  sync();
  return read;
}
