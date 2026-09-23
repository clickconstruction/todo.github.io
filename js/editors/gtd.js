// Sheets for the GTD practices: Delegate (waiting on someone, with a message you send yourself),
// Tickle ("remind me on…"), Person and Reference item. Handlers are set on each sheet's own form,
// so nothing leaks onto the shared #sheet.
import { db, app, $, esc, byId, openSheet, toast, tagLabel, sortedTags } from '../state.js';
import { startOfToday, addDays, addMonths } from '../dates.js';
import { livePeople, personNamed, savePerson, delegate, draftMessage, messageLink, tickle, tickleNew, dayKey, topics, saveReference, initials } from '../gtd.js';
import { attachFieldHtml, wireAttachField, uploadFiles } from './attachField.js';

// Opening mail/messages (tests capture the link instead).
export const openLink = (url) => (window.__openLink ? window.__openLink(url) : (location.href = url));
const fmtLong = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const peopleList = () => `<datalist id="people-list">${livePeople().map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>`;

// ---------- Delegate ----------
const FOLLOW = [['2', '2 days'], ['7', '1 week'], ['14', '2 weeks']];
export function openDelegate(t, { person = null, onDone = () => {} } = {}) {
  const recent = livePeople().slice(0, 6);
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet delegate-form">
    <h2>Delegate</h2>
    <p class="gtd-item">${esc(t.title)}</p>
    <label>To<input type="text" name="person" list="people-list" value="${esc(person ? person.name : '')}" placeholder="Name" autocomplete="off" required>${peopleList()}</label>
    ${recent.length ? `<div class="chip-row" role="group" aria-label="People">${recent.map((p) => `<button type="button" class="chip-btn" data-pick-person="${esc(p.name)}"><span class="av">${esc(initials(p.name))}</span>${esc(p.name)}</button>`).join('')}</div>` : ''}
    <div class="grid2 contact-fields" data-contact><label>Email<input type="email" name="email" autocomplete="off" placeholder="optional"></label><label>Phone<input type="tel" name="phone" autocomplete="off" placeholder="optional"></label></div>
    <div class="field"><span class="field-label">Follow up</span><div class="segmented" role="radiogroup" aria-label="Follow up">
      ${FOLLOW.map(([v, l]) => `<label><input type="radio" name="follow" value="${v}" ${v === '7' ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      <label><input type="radio" name="follow" value="date"><span>Pick date</span></label></div>
      <input type="date" name="follow_date" hidden aria-label="Follow-up date"></div>
    <label>Message <span class="hint">opens your mail or messages app; nothing is sent for you</span><textarea name="message" rows="4"></textarea></label>
    <div class="actions"><button type="submit" class="btn" value="track" data-via="track">I asked in person</button>
      <div class="right"><button type="submit" class="btn" data-via="text" hidden>Text</button><button type="submit" class="btn primary" data-via="email">Email · move to Waiting For</button></div></div>
  </form>`);
  const form = $('form', sheet);
  const byName = (n) => livePeople().find((p) => p.name.toLowerCase() === String(n || '').trim().toLowerCase());
  let edited = false;
  const refresh = () => {
    const p = byName(form.elements.person.value);
    const email = (p && p.email) || form.elements.email.value.trim();
    const phone = (p && p.phone) || form.elements.phone.value.trim();
    $('[data-contact]', form).hidden = !!(p && (p.email || p.phone));
    $('[data-via=email]', form).hidden = !email;
    $('[data-via=text]', form).hidden = !phone;
    $('[data-via=track]', form).classList.toggle('primary', !email && !phone);
    const name = (p ? p.name : form.elements.person.value.trim()).split(/\s+/)[0];
    $('[data-via=email]', form).textContent = `Email${name ? ` ${name}` : ''} · move to Waiting For`;
    if (!edited) form.elements.message.value = draftMessage(p || { name: form.elements.person.value }, t);
    form.querySelectorAll('[data-pick-person]').forEach((b) => b.classList.toggle('on', b.dataset.pickPerson === (p && p.name)));
  };
  form.elements.message.addEventListener('input', () => { edited = true; });
  form.addEventListener('input', (e) => { if (e.target.name !== 'message') refresh(); });
  form.addEventListener('change', () => { form.elements.follow_date.hidden = form.elements.follow.value !== 'date'; });
  form.addEventListener('click', (e) => { const b = e.target.closest('[data-pick-person]'); if (b) { form.elements.person.value = b.dataset.pickPerson; refresh(); } });
  let via = 'email';
  form.querySelectorAll('[data-via]').forEach((b) => { b.onclick = () => { via = b.dataset.via; }; });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = form.elements.person.value.trim();
    if (!name) return;
    if (form.elements.follow.value === 'date' && !form.elements.follow_date.value) { form.elements.follow_date.focus(); return; }
    sheet.close();
    const p = await personNamed(name, { email: form.elements.email.value.trim() || null, phone: form.elements.phone.value.trim() || null });
    const follow = form.elements.follow.value;
    await delegate(byId(db.tasks, t.id) || t, p, follow === 'date' ? { followUpKey: form.elements.follow_date.value } : { followUpDays: Number(follow) });
    const link = via === 'track' ? null : messageLink(p, t, { via, body: form.elements.message.value });
    if (link) openLink(link);
    toast(`Waiting on ${p.name}`);
    onDone(p);
  };
  refresh();
  sheet.showModal();
  if (!person) form.elements.person.focus();
}

// ---------- Tickle ("remind me on…") ----------
const TICKLE = () => { const d = startOfToday(); return [['Tomorrow', addDays(d, 1)], ['Next week', addDays(d, 7)], ['In a month', addMonths(d, 1)], ['In 3 months', addMonths(d, 3)]]; };
// t: an existing item (moved to the tickler), or { title } plus extra fields for a new tickler item.
export function openTickle(t, { onDone = () => {}, extra = {}, title = 'Tickle it' } = {}) {
  const opts = TICKLE();
  const initial = t && t.tickler && t.defer_at ? dayKey(new Date(t.defer_at)) : dayKey(opts[1][1]);
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet tickle-form">
    <h2>${esc(title)}</h2>
    ${t && t.id ? `<p class="gtd-item">${esc(t.title)}</p>` : `<label>What should come back?<input type="text" name="title" value="${esc((t && t.title) || '')}" required autocomplete="off"></label>`}
    <div class="field"><span class="field-label">Bring it back</span><div class="chip-row">${opts.map(([l, d]) => `<button type="button" class="chip-btn" data-day="${dayKey(d)}">${l}</button>`).join('')}</div>
      <input type="date" name="day" value="${initial}" min="${dayKey(addDays(startOfToday(), 1))}" required aria-label="Day"></div>
    <p class="hint" data-when></p>
    <p class="hint">It waits out of sight and lands in your Inbox that morning, with its notes and attachments, ready to clarify.</p>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Tickle</button></div></div>
  </form>`);
  const form = $('form', sheet);
  const when = () => {
    const v = form.elements.day.value;
    $('[data-when]', form).textContent = v ? `${fmtLong(new Date(`${v}T06:00:00`))} · 6am, into your Inbox` : '';
    form.querySelectorAll('[data-day]').forEach((b) => b.classList.toggle('on', b.dataset.day === v));
  };
  form.addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (b) { form.elements.day.value = b.dataset.day; when(); } });
  form.addEventListener('input', when);
  $('[data-cancel]', form).onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const day = form.elements.day.value;
    if (!day || day <= dayKey(startOfToday())) { form.elements.day.focus(); return; }
    sheet.close();
    const row = t && t.id ? (await tickle(byId(db.tasks, t.id) || t, day), t) : await tickleNew(form.elements.title.value, day, extra);
    toast(`In the tickler until ${fmtLong(new Date(`${day}T06:00:00`))}`);
    onDone(row, day);
  };
  when();
  sheet.showModal();
}

// ---------- Person ----------
export function openPersonEditor(p, { onDone = () => {} } = {}) {
  const tags = sortedTags();
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet person-form">
    <h2>${p ? 'Edit person' : 'New person'}</h2>
    <label>Name<input type="text" name="name" value="${esc(p ? p.name : '')}" required maxlength="100" autocomplete="off"></label>
    <div class="grid2"><label>Email<input type="email" name="email" value="${esc((p && p.email) || '')}" autocomplete="off"></label>
      <label>Phone<input type="tel" name="phone" value="${esc((p && p.phone) || '')}" autocomplete="off"></label></div>
    <label>Tag <span class="hint">items with this tag count as waiting on them (e.g. Waiting : ${esc(p ? p.name : 'Hiro')})</span>
      <select name="tag_id"><option value="">None</option>${tags.map((g) => `<option value="${g.id}" ${p && p.tag_id === g.id ? 'selected' : ''}>${esc(tagLabel(g))}</option>`).join('')}</select></label>
    <label>Notes<textarea name="notes" rows="3" placeholder="Prefers texts after 5pm…">${esc((p && p.notes) || '')}</textarea></label>
    <div class="actions">${p ? `<button type="button" class="btn danger" data-archive>${p.archived_at ? 'Restore' : 'Archive'}</button>` : ''}
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div>
  </form>`);
  const form = $('form', sheet);
  $('[data-cancel]', form).onclick = () => sheet.close();
  const archive = $('[data-archive]', form);
  if (archive) archive.onclick = async () => {
    sheet.close();
    const was = p.archived_at;
    await savePerson(p, { archived_at: was ? null : new Date().toISOString() });
    app.render();
    toast(was ? `Restored ${p.name}` : `Archived ${p.name}`, was ? null : [{ label: 'Undo', run: async () => { await savePerson(p, { archived_at: null }); app.render(); } }]);
    onDone(p);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const fields = { name: f.get('name').trim(), email: f.get('email').trim() || null, phone: f.get('phone').trim() || null, tag_id: f.get('tag_id') || null, notes: f.get('notes') };
    if (!fields.name) return;
    sheet.close();
    const row = await savePerson(p, fields);
    app.render();
    onDone(row);
  };
  sheet.showModal();
  if (!p) form.elements.name.focus();
}

// ---------- Reference item ----------
export function openReferenceEditor(r, { defaults = {}, onDone = () => {} } = {}) {
  const v = r || { title: '', body: '', topic: '', secret_value: '', project_id: null, ...defaults };
  const projects = db.projects.filter((p) => ['active', 'on_hold'].includes(p.status) || p.id === v.project_id).sort((a, b) => a.name.localeCompare(b.name));
  const sheet = openSheet(`<form method="dialog" class="gtd-sheet ref-form">
    <h2>${r ? 'Edit reference' : 'New reference'}</h2>
    <label>Title<input type="text" name="title" value="${esc(v.title)}" required maxlength="300" autocomplete="off" placeholder="Gate code, warranty, permit #…"></label>
    <div class="grid2"><label>Topic<input type="text" name="topic" value="${esc(v.topic || '')}" list="topic-list" maxlength="200" autocomplete="off" placeholder="Home, Smith job…">
      <datalist id="topic-list">${topics().map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
      <label>Support material for<select name="project_id"><option value="">No project</option>${projects.map((p) => `<option value="${p.id}" ${p.id === v.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label></div>
    <label>Hidden value <span class="hint">a code or number, shown only when you tap Show</span>
      <span class="secret-edit"><input type="password" name="secret_value" value="${esc(v.secret_value || '')}" maxlength="2000" autocomplete="off"><button type="button" class="btn small" data-peek>Show</button></span></label>
    <label>Notes<textarea name="body" rows="6" placeholder="Anything worth keeping">${esc(v.body || '')}</textarea></label>
    ${attachFieldHtml()}
    <div class="actions">${r ? `<button type="button" class="btn danger" data-archive>${r.archived_at ? 'Restore' : 'Archive'}</button>` : ''}
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div>
  </form>`);
  const form = $('form', sheet);
  const collectFiles = wireAttachField(form, 'reference_id', r && r.id);
  $('[data-cancel]', form).onclick = () => sheet.close();
  $('[data-peek]', form).onclick = (e) => { const i = form.elements.secret_value; i.type = i.type === 'password' ? 'text' : 'password'; e.target.textContent = i.type === 'password' ? 'Show' : 'Hide'; };
  const archive = $('[data-archive]', form);
  if (archive) archive.onclick = async () => { sheet.close(); await archiveReference(r, !r.archived_at); onDone(r); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const fields = { title: f.get('title').trim(), topic: f.get('topic').trim(), project_id: f.get('project_id') || null, secret_value: f.get('secret_value') || null, body: f.get('body') };
    if (!fields.title) return;
    const files = collectFiles();
    sheet.close();
    const row = await saveReference(r, fields);
    if (files.length) await uploadFiles('reference_id', row.id, files);
    app.render();
    onDone(row);
  };
  sheet.showModal();
  if (!r) form.elements.title.focus();
}

export async function archiveReference(r, archived = true) {
  await saveReference(r, { archived_at: archived ? new Date().toISOString() : null });
  if (archived && location.hash === `#reference/${r.id}`) location.hash = '#reference';
  app.render();
  if (archived) toast(`Archived “${r.title}”`, [{ label: 'Undo', run: async () => { await saveReference(r, { archived_at: null }); app.render(); } }]);
}
