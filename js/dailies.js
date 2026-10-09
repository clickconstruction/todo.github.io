// Dailies: an action done every day (or on chosen weekdays) as a checkbox that starts fresh each
// day, instead of a repeating action that goes overdue. Two tiers, matching Due and Planned:
//   must   "Have to"  a missed day shows (red dot, "missed Thursday") and it's a Daily review must-do
//   should "Should"   a missed day is an empty dot; progress reads "4 of 7 this week"
// tasks.daily = { tier, weekdays?, since }; daily_ticks holds one row per action per ticked day
// (un-ticking keeps the row, state "cleared"). The database keeps the rules (migration 20261101000001).
// Weekly checks (daily.every = 'week'): asked for once per Weekly Review instead of on a day. They are a step
// of the review ("Weekly checks"), never in Today, and ticked means ticked since the open review started.
// Quarterly checks (daily.every = 'quarter'): asked for once per quarterly check-in (Horizons), where they
// are listed; ticked means ticked since the last "Quarterly check-in done" (that day counts after the click).
import { db, app, sb, run, esc, isOpen, visible, onHoldTagFor, taskSort, toast } from './state.js';

import * as R from './daily-rules.js';

export const { TIERS, tierLabel, dayKey, describeDaily } = R;
const WD = R.WD;

export const isDaily = (t) => !!(t && t.daily && isOpen(t));
export const onDay = (t, key) => R.onDay(t.daily, key);
export const tickRow = (id, key) => (db.dailyTicks || []).find((x) => x.task_id === id && x.day === key) || null;
const dayTicked = (t, key) => { const r = tickRow(t.id, key); return !!r && r.state === 'done'; };
export const isWeekly = (t) => isDaily(t) && R.isWeekly(t.daily);
export const isQuarterly = (t) => isDaily(t) && R.isQuarterly(t.daily);
// The day the open Weekly Review started (today when none is open): weekly checks count from there.
const reviewSince = (today = dayKey()) => { const r = (db.weeklyReviews || []).find((x) => !x.completed_at && !x.abandoned_at); const k = r ? dayKey(new Date(r.started_at)) : today; return k < today ? k : today; };
// When the last quarterly check-in was done: quarterly checks count from that day, and a tick made that
// day counts only when it came after the click.
const quarterDone = () => (app.settings || {}).horizons_quarter_at || null;
const quarterSince = (today = dayKey()) => { const at = quarterDone(); const k = at ? dayKey(new Date(at)) : null; return R.quarterSince(k && k > today ? today : k, today); };
const tickedOf = (t) => {
  if (!R.isQuarterly(t.daily)) return (key) => dayTicked(t, key);
  const at = quarterDone(); const doneDay = at ? dayKey(new Date(at)) : null;
  return (key) => { const r = tickRow(t.id, key); return !!r && r.state === 'done' && (key !== doneDay || Date.parse(r.updated_at) > Date.parse(at)); };
};
const sinceOf = (t, today) => (R.isQuarterly(t.daily) ? quarterSince(today) : reviewSince(today));
// Is its box ticked: that day for a daily one, since the period started for a check.
export const isTicked = (t, key = dayKey()) => (R.isCheck(t.daily) ? !!R.tickedSince(tickedOf(t), sinceOf(t, key), key) : dayTicked(t, key));
export const week = (t, today = dayKey()) => R.week(t.daily, tickedOf(t), today);
export const running = (t, today = dayKey()) => R.running(t.daily, tickedOf(t), today);
export const summary = (t, today = dayKey()) => R.summary(t.daily, tickedOf(t), today);

// Today's dailies by tier: open, asked for today, not parked by an on-hold tag.
export function todaysDailies(today = dayKey()) {
  const list = db.tasks.filter((t) => isDaily(t) && visible(t) && onDay(t, today) && !onHoldTagFor(t)).sort(taskSort);
  return { must: list.filter((t) => t.daily.tier === 'must'), should: list.filter((t) => t.daily.tier !== 'must') };
}
// Have-to dailies not ticked yet today: the Daily review's must-dos and the Forecast badge count them.
export const mustLeft = (today = dayKey()) => todaysDailies(today).must.filter((t) => !isTicked(t, today));

// The Weekly Review's "Weekly checks": open weekly ones, not parked by an on-hold tag.
export const weeklyChecks = () => db.tasks.filter((t) => isWeekly(t) && visible(t) && !onHoldTagFor(t)).sort(taskSort);
// The quarterly check-in's "Quarterly checks", the same way.
export const quarterlyChecks = () => db.tasks.filter((t) => isQuarterly(t) && visible(t) && !onHoldTagFor(t)).sort(taskSort);

export async function tickDaily(t, on = !isTicked(t), key = dayKey()) {
  const check = R.isCheck(t.daily);
  if (check && !on) { // un-tick every tick since the period started (usually one, maybe from an earlier day)
    const since = sinceOf(t, key); const counts = tickedOf(t);
    const rows = (db.dailyTicks || []).filter((x) => x.task_id === t.id && x.state === 'done' && x.day >= since && x.day <= key && counts(x.day));
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
  if (on) toast(R.isQuarterly(t.daily) ? 'Ticked for this quarter' : check ? 'Ticked for this week’s review' : 'Done for today', [{ label: 'Undo', run: () => tickDaily(t, false, key) }]);
}

// A check as its review shows it: the box, the title, and when it was last ticked.
export function checkRow(t, today = dayKey()) {
  const on = isTicked(t, today);
  const line = summary(t, today);
  return `<li class="row dly-row ${on ? 'dly-on' : ''}" data-task="${t.id}">
    <button class="dly-box ${on ? 'on' : ''}" data-dly-tick="${t.id}" aria-pressed="${on}" aria-label="${on ? 'Un-tick' : 'Tick'} “${esc(t.title)}” for this ${R.isQuarterly(t.daily) ? 'quarter' : 'review'}">✓</button>
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
      <div class="row-meta dly-meta">${dots(t, today)}${line ? `<span class="${/^missed/.test(line) ? 'dly-missed' : ''}">${esc(line)}</span>` : ''}</div></div>
  </li>`;
}
// How an action would look as a daily one, before it is one (a Full Review suggestion): the row as Today
// will show it, not clickable, starting today, and where it goes. Days before today are off: nothing to miss yet.
export function dailyPreview(title, daily, today = dayKey()) {
  if (R.isCheck(daily)) {
    const q = R.isQuarterly(daily);
    return `<div class="sg-dly" data-dly-preview="${q ? 'quarterly' : 'weekly'}" role="img" aria-label="How it will look in the ${q ? 'quarterly check-in' : 'Weekly Review'}: a checkbox, ${esc(title)}">
    <span class="dly-box" aria-hidden="true">✓</span>
    <span class="sg-dly-main"><span class="row-title">${esc(title)}</span><span class="row-meta dly-meta"><span>starts fresh each ${q ? 'check-in' : 'review'}</span></span></span>
  </div>
  <span class="hint sg-dly-where">${q ? '→ Horizons → Quarterly check-in → Quarterly checks' : '→ Weekly Review → Get current → Weekly checks'}</span>`;
  }
  const d = { ...daily, since: today };
  const asked = R.onDay(d, today);
  const next = asked ? null : Array.from({ length: 7 }, (_, i) => { const x = new Date(`${today}T12:00`); x.setDate(x.getDate() + i + 1); return x; }).find((x) => R.onDay(d, dayKey(x)));
  const line = asked ? 'starts today' : `first on ${next ? WD[next.getDay()] : 'its next day'}`;
  return `<div class="sg-dly" data-dly-preview="${esc(d.tier)}" role="img" aria-label="How it will look in Today: a checkbox, ${esc(title)}, ${esc(line)}">
    <span class="dly-box" aria-hidden="true">✓</span>
    <span class="sg-dly-main"><span class="row-title">${esc(title)}</span>
      <span class="row-meta dly-meta"><span class="dly-dots" aria-hidden="true">${R.week(d, () => false, today).map((x) => `<i class="dly-dot ${x.state}"></i>`).join('')}</span><span>${esc(line)}</span></span></span>
  </div>
  <span class="hint sg-dly-where">→ Forecast → Today, under “${esc(tierLabel(d.tier))}”${d.tier === 'must' ? ', and the Daily review’s must-dos' : ''}</span>`;
}

// Forecast → Today: the two tiers, above Due.
export function dailyBlock(today = dayKey()) {
  const { must, should } = todaysDailies(today);
  const sec = (tier, list) => (list.length ? `<h2 class="section-title dly-title" data-dly-tier="${tier}">${esc(tierLabel(tier))} <span class="hint">${list.filter((t) => isTicked(t, today)).length} of ${list.length}</span></h2>
    <ul class="list dly-list">${list.map((t) => dailyRow(t, today)).join('')}</ul>` : '');
  return sec('must', must) + sec('should', should);
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
      <option value="quarter" ${R.isQuarterly(d) ? 'selected' : ''}>${R.QUARTERLY_LABEL}</option></select>
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
    if (sel.value === 'week' || sel.value === 'quarter') return { tier: 'should', every: sel.value, ...(row.daily && row.daily.since ? { since: row.daily.since } : {}) };
    const wd = [...form.querySelectorAll('input[name=daily_wd]:checked')].map((x) => Number(x.value));
    return { tier: sel.value, ...(wd.length && wd.length < 7 ? { weekdays: wd } : {}), ...(row.daily && row.daily.since ? { since: row.daily.since } : {}) };
  };
  const sync = () => {
    form.querySelector('.dly-days').hidden = !sel.value || sel.value === 'week' || sel.value === 'quarter';
    hint.textContent = !sel.value ? 'A checkbox that starts fresh each day, instead of a repeating action.'
      : sel.value === 'week' ? 'A checkbox in the Weekly Review, under Weekly checks. Each review starts it fresh; it never shows in Today. Its dates and repeat are cleared.'
      : sel.value === 'quarter' ? 'A checkbox in the quarterly check-in (Horizons), under Quarterly checks. “Quarterly check-in done” starts it fresh; it never shows in Today. Its dates and repeat are cleared.'
      : sel.value === 'must' ? 'A checkbox in Today and the Daily review’s must-dos. A missed day shows; nothing piles up. Its dates and repeat are cleared.'
        : 'A checkbox in Today. A missed day is just an empty dot. Its dates and repeat are cleared.';
  };
  form.addEventListener('change', (e) => { if (/^daily_/.test(e.target.name || '')) sync(); });
  sync();
  return read;
}
