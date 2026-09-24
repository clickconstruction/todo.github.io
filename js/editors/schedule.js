// Schedule it: pick a day and a time (free slots come from your calendars and other scheduled
// actions), and it's a time block: in Forecast's day view, your calendar feed, and one tap to add to
// Google or Apple Calendar (your calendar opens pre-filled; nothing is sent for you).
import { db, app, sb, run, syncRow, esc, byId, openSheet, $, toast } from '../state.js';
import { startOfToday, addDays } from '../dates.js';
import { calendarEvents, liveCalendars } from '../calendars.js';
import { freeSlots, busyBlocks, eventOf, icsCalendar, googleCalendarUrl } from '../schedule.js';
import { dayKey } from '../gtd.js';

const DAY_FROM = 7; const DAY_TO = 19; // slots are offered between 7am and 7pm
const fmtT = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`);

export function slotsFor(key, t, need) {
  const day = new Date(`${key}T00:00:00`);
  const events = liveCalendars().some((c) => c.enabled) ? calendarEvents(key, key) : [];
  const onDay = db.tasks.filter((x) => x.scheduled_at && dayKey(new Date(x.scheduled_at)) === key);
  const from = new Date(day); from.setHours(DAY_FROM, 0, 0, 0);
  const to = new Date(day); to.setHours(DAY_TO, 0, 0, 0);
  return freeSlots(busyBlocks(events, onDay, t.id), from.getTime(), to.getTime(), need).slice(0, 6);
}

export function openSchedule(t, { onDone = () => {} } = {}) {
  const need = t.scheduled_minutes || t.estimate_minutes || 30;
  const today = startOfToday();
  const cur = t.scheduled_at ? new Date(t.scheduled_at) : null;
  let key = cur ? dayKey(cur) : dayKey(today);
  let at = cur ? `${String(cur.getHours()).padStart(2, '0')}:${String(cur.getMinutes()).padStart(2, '0')}` : '';
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet sched-form"><h2>Schedule it</h2><p class="gtd-item">${esc(t.title)}</p>
    <div class="chip-row" data-days></div>
    <div class="grid2"><label>Day<input type="date" name="day" value="${key}" min="${dayKey(today)}"></label>
      <label>How long<select name="minutes">${[15, 30, 45, 60, 90, 120, 180, 240].concat(need).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((m) => `<option value="${m}" ${m === need ? 'selected' : ''}>${fmtMin(m)}</option>`).join('')}</select></label></div>
    <div class="field"><span class="field-label" data-slots-title></span><div class="sched-slots" data-slots></div></div>
    <label>Or a time<input type="time" name="time" value="${at}" step="300"></label>
    <div class="actions">${t.scheduled_at ? '<button type="button" class="btn danger" data-unschedule>Unschedule</button>' : ''}<div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" data-go>Schedule</button></div></div></form>`);
  const form = $('form', sheet);
  const draw = () => {
    key = form.elements.day.value || key;
    const mins = Number(form.elements.minutes.value);
    const days = [0, 1, 2, 3, 4].map((i) => addDays(today, i));
    $('[data-days]', form).innerHTML = days.map((d, i) => `<button type="button" class="chip-btn ${dayKey(d) === key ? 'on' : ''}" data-day="${dayKey(d)}">${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short' })}</button>`).join('');
    const slots = slotsFor(key, t, mins);
    const hasCal = liveCalendars().some((c) => c.enabled);
    $('[data-slots-title]', form).textContent = slots.length ? `Free ${key === dayKey(today) ? 'today' : 'that day'}${hasCal ? ' (from your calendars)' : ''}` : 'No free slot that long between 7am and 7pm';
    $('[data-slots]', form).innerHTML = slots.map((s) => { const v = `${String(new Date(s.start).getHours()).padStart(2, '0')}:${String(new Date(s.start).getMinutes()).padStart(2, '0')}`; return `<button type="button" class="sched-slot ${form.elements.time.value === v ? 'on' : ''}" data-slot="${v}"><span>${fmtT(s.start)} – ${fmtT(s.end)}</span><span class="hint">${fmtMin(s.minutes)}</span></button>`; }).join('');
    const v = form.elements.time.value;
    $('[data-go]', form).textContent = v ? `Schedule ${fmtT(new Date(`${key}T${v}:00`).toISOString())}` : 'Schedule';
  };
  form.addEventListener('click', (e) => {
    const d = e.target.closest('[data-day]'); if (d) { form.elements.day.value = d.dataset.day; draw(); return; }
    const s = e.target.closest('[data-slot]'); if (s) { form.elements.time.value = s.dataset.slot; draw(); }
  });
  form.addEventListener('input', draw);
  form.addEventListener('change', draw);
  $('[data-cancel]', form).onclick = () => sheet.close();
  const un = $('[data-unschedule]', form);
  if (un) un.onclick = async () => { sheet.close(); await patch(t, { scheduled_at: null, scheduled_minutes: null }); toast('Unscheduled'); onDone(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = form.elements.time.value;
    if (!v) { form.elements.time.focus(); $('[data-slots-title]', form).textContent = 'Pick a free slot or a time'; return; }
    const start = new Date(`${form.elements.day.value}T${v}:00`);
    sheet.close();
    const row = await patch(t, { scheduled_at: start.toISOString(), scheduled_minutes: Number(form.elements.minutes.value), planned_at: start.toISOString() });
    toast(`Scheduled ${start.toLocaleDateString(undefined, { weekday: 'short' })} ${fmtT(start.toISOString())}`, [{ label: 'Add to Google', run: () => addToGoogle(row) }, { label: 'Apple', run: () => addToApple(row) }]);
    onDone(row);
  };
  draw();
  sheet.showModal();
}

async function patch(t, fields) {
  const [row] = await run(sb.from('tasks').update(fields).eq('id', t.id).select());
  const live = syncRow('tasks', t, row);
  app.render();
  return live;
}

const eventFor = (t) => eventOf(t, { project: (byId(db.projects, t.project_id) || {}).name || null, appUrl: `${location.origin}${location.pathname}` });
// Google: its "new event" page, pre-filled. Apple: an .ics file your phone offers to add.
export const addToGoogle = (t) => { const url = googleCalendarUrl(eventFor(t)); if (window.__openLink) window.__openLink(url); else window.open(url, '_blank', 'noopener'); };
export function addToApple(t) {
  const ics = icsCalendar([eventFor(t)]);
  if (window.__openLink) { window.__openLink(`ics:${ics}`); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${t.title.replace(/[^\w\- ]+/g, '').slice(0, 40) || 'event'}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export const scheduledLabel = (t) => { const d = new Date(t.scheduled_at); const k = dayKey(d); const today = dayKey(startOfToday()); return `${k === today ? '' : `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} `}${fmtT(t.scheduled_at)}`; };
