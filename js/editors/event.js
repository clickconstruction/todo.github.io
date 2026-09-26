// Event editor: title, when (all day or timed), where, project, link, notes. Opens from Forecast
// (+ Event, or tap one of your events). Remove archives it, with Undo in the toast.
import { db, $, esc, openSheet, bySort } from '../state.js';
import { toDateInput } from '../dates.js';
import { insertEvent, updateEvent, archiveEvent, cardOf, geocodeText } from '../events.js';

const pad = (n) => String(n).padStart(2, '0');
const timeOf = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const localIso = (day, time = '00:00') => new Date(`${day}T${time}`).toISOString();
const dayAfter = (day) => { const d = new Date(`${day}T12:00`); d.setDate(d.getDate() + 1); return toDateInput(d.toISOString()); };

export function openEventEditor(event = null, { day = null } = {}) {
  const e = event;
  const allDay = e ? e.all_day : true;
  const startDay = e ? toDateInput(e.starts_at) : (day || toDateInput(new Date().toISOString()));
  // An all-day event's ends_at is the midnight after its last day: show the last day.
  const endDay = e ? toDateInput(new Date(Math.max(Date.parse(e.starts_at), Date.parse(e.ends_at) - (e.all_day ? 1 : 0))).toISOString()) : startDay;
  const startTime = e && !e.all_day ? timeOf(e.starts_at) : '09:00';
  const endTime = e && !e.all_day ? timeOf(e.ends_at) : '10:00';
  const projects = db.projects.filter((p) => p.status === 'active' || (e && p.id === e.project_id)).sort(bySort);
  const sheet = openSheet(`<form method="dialog" id="event-form" class="event-form" novalidate>
    <h2>${e ? 'Edit event' : 'New event'}</h2>
    <input type="text" name="title" value="${esc(e ? e.title : '')}" placeholder="What is it?" required autocomplete="off" aria-label="Title">
    <label class="ev-allday"><input type="checkbox" name="all_day" ${allDay ? 'checked' : ''}> All day</label>
    <div class="ev-when">
      <label>Starts<span class="ev-dt"><input type="date" name="start_day" value="${startDay}" required><input type="time" name="start_time" value="${startTime}" ${allDay ? 'hidden' : ''}></span></label>
      <label>Ends<span class="ev-dt"><input type="date" name="end_day" value="${endDay}" required><input type="time" name="end_time" value="${endTime}" ${allDay ? 'hidden' : ''}></span></label>
    </div>
    <input type="text" name="location" value="${esc(e ? e.location : '')}" placeholder="Where (optional)" autocomplete="off" aria-label="Location">
    <label>Project<select name="project_id"><option value="">None</option>${projects.map((p) => `<option value="${p.id}" ${e && e.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <input type="url" name="url" value="${esc(e ? e.url : '')}" placeholder="Link (optional)" autocomplete="off" spellcheck="false" aria-label="Link">
    <label>Notes<textarea name="notes" placeholder="Tickets, gate times, who’s going…">${esc(e ? e.notes : '')}</textarea></label>
    ${e && cardOf(e.task_id) ? `<p class="ev-card">↩ From the card <b>${esc(cardOf(e.task_id).title)}</b> <label class="hint"><input type="checkbox" name="unlink"> Unlink</label></p>` : ''}
    <p class="hint">Shows in Forecast on each day it covers, and in your calendar feed. Not an action: nothing to tick off.</p>
    <p class="form-error" data-error hidden></p>
    <div class="actions">
      ${e ? '<button type="button" class="btn danger" data-remove>Remove</button>' : ''}
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>
  </form>`);
  const form = $('#event-form', sheet);
  const f = form.elements;
  const err = (m) => { const x = $('[data-error]', form); x.textContent = m || ''; x.hidden = !m; };
  f.all_day.addEventListener('change', () => { f.start_time.hidden = f.all_day.checked; f.end_time.hidden = f.all_day.checked; });
  // Ends follows Starts until it's set on its own (and never lands before it).
  let endTouched = !!e;
  f.end_day.addEventListener('input', () => { endTouched = true; });
  f.start_day.addEventListener('input', () => { if (!endTouched || f.end_day.value < f.start_day.value) f.end_day.value = f.start_day.value; });
  $('[data-cancel]', form).onclick = () => sheet.close();
  const rm = $('[data-remove]', form);
  if (rm) rm.onclick = async () => { sheet.close(); await archiveEvent(e); };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const title = f.title.value.trim();
    if (!title) { f.title.focus(); return; }
    if (!f.start_day.value || !f.end_day.value) { err('Pick the days.'); return; }
    const all_day = f.all_day.checked;
    if (all_day && f.end_day.value < f.start_day.value) { err('It ends before it starts.'); return; }
    const starts_at = all_day ? localIso(f.start_day.value) : localIso(f.start_day.value, f.start_time.value || '00:00');
    const ends_at = all_day ? localIso(dayAfter(f.end_day.value)) : localIso(f.end_day.value, f.end_time.value || f.start_time.value || '00:00');
    if (Date.parse(ends_at) < Date.parse(starts_at)) { err('It ends before it starts.'); return; }
    const url = f.url.value.trim();
    if (url && !/^https?:\/\//i.test(url)) { err('Links start with https://'); return; }
    const fields = { title, all_day, starts_at, ends_at, location: f.location.value.trim(), project_id: f.project_id.value || null, url, notes: f.notes.value };
    if (e && f.unlink && f.unlink.checked) fields.task_id = null;
    // Where it is, as coordinates: looked up when the location is new or changed; a change resets the drive time.
    if (!fields.location) { if (!e || e.lat != null) Object.assign(fields, { lat: null, lng: null, drive_minutes: null, drive_from: null }); }
    else if (!e || fields.location !== e.location || e.lat == null) {
      const g = await geocodeText(fields.location);
      Object.assign(fields, { lat: g ? g.lat : null, lng: g ? g.lng : null, drive_minutes: null, drive_from: null });
    }
    sheet.close();
    if (e) await updateEvent(e, fields); else await insertEvent(fields);
  };
  sheet.showModal();
  if (!e) f.title.focus();
}
