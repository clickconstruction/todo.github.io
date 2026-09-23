// Place editor (search an address, use your location, or drop a pin; set the radius) and
// the Location field shared by the action, project and tag editors. The place editor
// opens in its own dialog so it can sit on top of another editor ("+ New place…").
import { db, app, $, esc, byId, openSheet, tagLabel } from '../state.js';
import { requestLocation, fmtDistance, RADIUS_PRESETS, fmtRadius } from '../geo.js';
import { activePlaces, activePlace, placeFor, placeDistance, insertPlace, updatePlace, TRIGGERS, triggerLabel, actionsAt } from '../places.js';
import { loadMaps, makeMap, pinEl, circle, reverseGeocode } from '../maps.js';
import { updateTag } from '../data.js';

const MIN_R = 25;
const MAX_R = 8047;
// The radius slider is logarithmic: fine control near 100 ft, still reaches 5 mi.
const toSlider = (m) => Math.round((Math.log(m / MIN_R) / Math.log(MAX_R / MIN_R)) * 1000);
const fromSlider = (v) => Math.round(MIN_R * (MAX_R / MIN_R) ** (v / 1000));

export function openPlaceEditor(place, { onSave, onCancel, defaults = {} } = {}) {
  const p = place || { name: '', address: '', lat: null, lng: null, radius_m: 402, notes: '', google_place_id: null, ...defaults };
  const dlg = $('#sheet2');
  const inUse = place ? actionsAt(place).length : 0;
  dlg.innerHTML = `<form method="dialog" class="place-form" novalidate>
    <h2>${place ? 'Edit place' : 'New place'}</h2>
    <div class="place-search" data-pac><input type="text" name="address" value="${esc(p.address)}" placeholder="Address or business" autocomplete="off" aria-label="Address"></div>
    <div class="place-tools">
      <button type="button" class="btn small" data-here>📍 Use my location</button>
      <span class="hint" data-coords>${p.lat != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'Search, use your location, or tap the map to drop a pin'}</span>
    </div>
    <div class="place-map" data-map hidden></div>
    <input type="text" name="name" value="${esc(p.name)}" placeholder="Name, e.g. Home Depot, Office, Mom’s" required autocomplete="off" aria-label="Place name">
    <div class="field"><span class="field-label">Radius <b data-radius-label>${fmtRadius(p.radius_m)}</b> <span class="hint">how close counts as “here”</span></span>
      <input type="range" name="radius_slider" min="0" max="1000" value="${toSlider(p.radius_m)}" aria-label="Radius">
      <span class="quick">${RADIUS_PRESETS.map(([m, l]) => `<button type="button" class="qbtn" data-radius="${m}">${l}</button>`).join('')}</span>
    </div>
    <label>Notes<textarea name="notes" placeholder="Hours, gate code, parking…">${esc(p.notes || '')}</textarea></label>
    ${place ? `<p class="view-sub" style="margin:0">${inUse} open action${inUse === 1 ? '' : 's'} here. Places are archived, never deleted.</p>` : ''}
    <p class="form-error" data-error hidden></p>
    <div class="actions">
      ${place ? `<button type="button" class="btn ${place.archived_at ? '' : 'danger'}" data-archive>${place.archived_at ? 'Unarchive' : 'Archive'}</button>` : ''}
      <div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>
  </form>`;
  const form = $('form', dlg);
  const state = { lat: p.lat, lng: p.lng, radius: p.radius_m, address: p.address, google_place_id: p.google_place_id };
  const ui = { map: null, marker: null, circle: null, maps: null };
  const err = (m) => { const e = $('[data-error]', form); e.textContent = m || ''; e.hidden = !m; };

  const setRadius = (m) => {
    state.radius = Math.min(MAX_R, Math.max(MIN_R, m));
    $('[data-radius-label]', form).textContent = fmtRadius(state.radius);
    form.elements.radius_slider.value = toSlider(state.radius);
    if (ui.circle) ui.circle.setRadius(state.radius);
  };
  const setPoint = (lat, lng, { pan = true } = {}) => {
    state.lat = lat; state.lng = lng;
    $('[data-coords]', form).textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    err('');
    if (!ui.map) return;
    const pos = { lat, lng };
    if (!ui.marker) {
      ui.marker = new ui.maps.marker.AdvancedMarkerElement({ map: ui.map, position: pos, gmpDraggable: true, content: pinEl() });
      ui.marker.addListener('dragend', async () => {
        const at = ui.marker.position;
        setPoint(at.lat, at.lng, { pan: false });
        await fillAddress();
      });
      ui.circle = circle(ui.maps, ui.map, pos, state.radius);
    } else {
      ui.marker.position = pos;
      ui.circle.setCenter(pos);
    }
    if (pan) { ui.map.panTo(pos); if (ui.map.getZoom() < 14) ui.map.setZoom(16); }
  };
  const fillAddress = async () => {
    if (!ui.maps) return;
    const address = await reverseGeocode(ui.maps, { lat: state.lat, lng: state.lng });
    if (address) { state.address = address; state.google_place_id = null; const input = form.elements.address; if (input) input.value = address; }
  };

  form.elements.radius_slider.addEventListener('input', (e) => setRadius(fromSlider(Number(e.target.value))));
  form.addEventListener('click', (e) => { const b = e.target.closest('[data-radius]'); if (b) setRadius(Number(b.dataset.radius)); });
  $('[data-here]', form).onclick = async () => {
    try {
      const here = await requestLocation();
      setPoint(here.lat, here.lng);
      await fillAddress();
      if (!form.elements.name.value.trim()) form.elements.name.focus();
    } catch { err('Location is off. Search for the address instead, or turn location on for Todo Tooling.'); }
  };
  $('[data-cancel]', form).onclick = () => { dlg.close(); if (onCancel) onCancel(); };
  const archive = $('[data-archive]', form);
  if (archive) archive.onclick = async () => {
    if (!place.archived_at && inUse && !confirm(`Archive “${place.name}”? ${inUse} open action${inUse === 1 ? '' : 's'} will lose this location (they keep everything else).`)) return;
    dlg.close();
    await updatePlace(place, { archived_at: place.archived_at ? null : new Date().toISOString() });
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (state.lat == null) { err('Choose where it is: search an address, use your location, or tap the map.'); return; }
    if (!name) { form.elements.name.focus(); return; }
    const fields = { name, address: (form.elements.address ? form.elements.address.value : state.address) || state.address || '', lat: state.lat, lng: state.lng,
      radius_m: state.radius, notes: form.elements.notes.value, google_place_id: state.google_place_id || null };
    dlg.close();
    const saved = place ? await updatePlace(place, fields) : await insertPlace(fields);
    if (onSave) onSave(saved);
  };
  dlg.showModal();
  if (!place) (form.elements.address || form.elements.name).focus();

  // Upgrade to Google search + map when available.
  loadMaps().then((maps) => {
    if (!maps || !dlg.open) return;
    ui.maps = maps;
    const mapEl = $('[data-map]', form);
    mapEl.hidden = false;
    const center = p.lat != null ? { lat: p.lat, lng: p.lng } : app.here ? { lat: app.here.lat, lng: app.here.lng } : null;
    ui.map = makeMap(maps, mapEl, { center, zoom: p.lat != null ? 16 : 14 });
    ui.map.addListener('click', async (ev) => { setPoint(ev.latLng.lat(), ev.latLng.lng(), { pan: false }); await fillAddress(); });
    if (p.lat != null) setPoint(p.lat, p.lng);
    if (maps.places && maps.places.PlaceAutocompleteElement) {
      const opts = app.here ? { locationBias: { center: { lat: app.here.lat, lng: app.here.lng }, radius: 50000 } } : {};
      const pac = new maps.places.PlaceAutocompleteElement(opts);
      pac.setAttribute('aria-label', 'Search for an address or business');
      pac.setAttribute('placeholder', 'Search an address or business');
      pac.addEventListener('gmp-select', async ({ placePrediction }) => {
        const gp = placePrediction.toPlace();
        await gp.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
        state.address = gp.formattedAddress || '';
        state.google_place_id = gp.id || null;
        setPoint(gp.location.lat(), gp.location.lng());
        if (!form.elements.name.value.trim()) form.elements.name.value = gp.displayName || '';
      });
      const slot = $('[data-pac]', form);
      const typed = form.elements.address.value;
      slot.innerHTML = '';
      slot.append(pac);
      if (typed) slot.insertAdjacentHTML('beforeend', `<p class="hint">Current: ${esc(typed)}</p>`);
    }
  });
}

// ---------- Location field (actions, projects, tags) ----------
export function locationFieldHtml(row, { inherited = null } = {}) {
  const places = activePlaces();
  const current = activePlace(row.place_id);
  const opt = (pl) => { const d = placeDistance(pl); return `<option value="${pl.id}" ${current && current.id === pl.id ? 'selected' : ''}>${esc(pl.name)}${d != null ? ` · ${fmtDistance(d)}` : ''}</option>`; };
  const radius = row.location_radius_m;
  const custom = radius && !RADIUS_PRESETS.some(([m]) => m === radius);
  const inheritedNote = !current && inherited
    ? `<p class="hint loc-inherited">📍 ${esc(inherited.place.name)} via ${esc(inherited.via.kind)} “${esc(inherited.via.label)}”${inherited.trigger ? ` · alert when ${esc(triggerLabel(inherited.trigger).toLowerCase())}` : ''}</p>` : '';
  return `<fieldset class="loc-field">
    <legend>Location</legend>
    <select name="place_id" aria-label="Place"><option value="">${inherited && !current ? `Inherit (${esc(inherited.place.name)})` : 'None'}</option>${places.map(opt).join('')}<option value="__new">+ New place…</option></select>
    ${inheritedNote}
    <div class="loc-detail" ${current ? '' : 'hidden'}>
      <div class="segmented" role="radiogroup" aria-label="Alert">
        ${TRIGGERS.map(([v, l]) => `<label><input type="radio" name="location_trigger" value="${v}" ${(row.location_trigger || '') === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <label class="loc-radius">Radius <select name="location_radius_m">
        <option value="">Place default (${current ? fmtRadius(current.radius_m) : '¼ mi'})</option>
        ${RADIUS_PRESETS.map(([m, l]) => `<option value="${m}" ${radius === m ? 'selected' : ''}>${l}</option>`).join('')}
        ${custom ? `<option value="${radius}" selected>${fmtRadius(radius)}</option>` : ''}
      </select></label>
    </div>
  </fieldset>`;
}

// Wire a Location field inside `form`; returns collect() → { place_id, location_trigger, location_radius_m }.
export function wireLocationField(form, onChange = () => {}) {
  const sel = form.elements.place_id;
  if (!sel) return () => ({});
  const detail = $('.loc-detail', form);
  let previous = sel.value;
  const sync = () => {
    detail.hidden = !sel.value || sel.value === '__new';
    const pl = activePlace(sel.value);
    const def = form.elements.location_radius_m.options[0];
    def.textContent = `Place default (${pl ? fmtRadius(pl.radius_m) : '¼ mi'})`;
    const note = $('.loc-inherited', form);
    if (note) note.hidden = !!sel.value;
  };
  sel.addEventListener('change', (e) => {
    if (sel.value !== '__new') { previous = sel.value; sync(); return; }
    e.stopPropagation(); // don't autosave the placeholder choice
    openPlaceEditor(null, {
      onSave: (pl) => {
        const o = new Option(pl.name, pl.id, true, true);
        sel.insertBefore(o, sel.querySelector('option[value="__new"]'));
        previous = pl.id;
        // New places default to alerting when you arrive: the usual reason to add one.
        const arrive = form.querySelector('input[name="location_trigger"][value="arrive"]');
        if (arrive && !form.querySelector('input[name="location_trigger"]:checked:not([value=""])')) arrive.checked = true;
        sync();
        onChange();
      },
      onCancel: () => { sel.value = previous; sync(); },
    });
  });
  sync();
  return () => {
    const place_id = sel.value && sel.value !== '__new' ? sel.value : null;
    const trig = form.querySelector('input[name="location_trigger"]:checked');
    const r = form.elements.location_radius_m.value;
    return { place_id, location_trigger: place_id && trig && trig.value ? trig.value : null, location_radius_m: place_id && r ? Number(r) : null };
  };
}

// Tag editor: rename and give the tag a place (every action with this tag inherits it).
export function openTagEditor(tag) {
  const sheet = openSheet(`<form method="dialog" id="tag-form">
    <h2>Edit tag</h2>
    <input type="text" name="name" value="${esc(tag.name)}" required autocomplete="off" aria-label="Tag name">
    ${tag.parent_id ? `<p class="hint">Inside “${esc(tagLabel(byId(db.tags, tag.parent_id)))}”</p>` : ''}
    ${locationFieldHtml(tag)}
    <p class="hint">Actions with this tag use its place unless they have their own.</p>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div></div>
  </form>`);
  const form = $('#tag-form', sheet);
  const collect = wireLocationField(form);
  $('[data-cancel]', sheet).onclick = () => sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    sheet.close();
    await updateTag(tag, { name, ...collect() });
  };
  sheet.showModal();
}

export { placeFor };
