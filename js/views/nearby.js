// Nearby: a map of your places and the actions at each, nearest first. Places: manage them.
// The map is created once and moved between renders, so re-rendering the list (which
// happens on every data change and as you move) never reloads it.
import { db, app, esc, isOpen, taskSort } from '../state.js';
import { taskList } from '../rows.js';
import { filterBar, applyFilter, filterNote } from '../filter.js';
import { fmtDistance, fmtRadius, deniedHelp } from '../geo.js';
import { activePlaces, activePlace, placeFor, placeDistance, isInside, actionsAt } from '../places.js';
import { loadMaps, makeMap, pinEl, youEl, circle, fitTo } from '../maps.js';

const WITHIN_KEY = 'todo.nearby.within';
const WITHIN = [[0, 'Any distance'], [1609, 'Within 1 mi'], [8047, 'Within 5 mi'], [40234, 'Within 25 mi']];
let within = 0;
try { within = Number(localStorage.getItem(WITHIN_KEY)) || 0; } catch { /* private mode */ }
export function setWithin(m) {
  within = m;
  try { localStorage.setItem(WITHIN_KEY, String(m)); } catch { /* private mode */ }
}

// Location status: what to show when we can't (yet) measure distance.
function locationCard() {
  if (app.here) return '';
  if (app.locationState === 'denied') {
    return `<div class="loc-card"><b>Location is off for Todo Tooling</b><p>${esc(deniedHelp())}</p><p class="hint">Places still work; distances and alerts need location.</p><button class="btn small" data-act="request-location">Try again</button></div>`;
  }
  if (app.locationState === 'unsupported') return '<div class="loc-card"><b>This browser can’t share location.</b></div>';
  return `<div class="loc-card"><b>See what’s near you</b><p>Turn on location to sort actions by distance and get alerts at your places. Your location stays on this device.</p>
    <button class="btn primary" data-act="request-location">📍 Turn on location</button></div>`;
}

export function viewNearby(focusId) {
  const focus = focusId && activePlace(focusId);
  const places = activePlaces();
  // Group open actions (and just-completed ones, for Undo) by their effective place.
  const byPlace = new Map();
  db.tasks.forEach((t) => {
    const loc = placeFor(t);
    if (!loc) return;
    if (!byPlace.has(loc.place.id)) byPlace.set(loc.place.id, []);
    byPlace.get(loc.place.id).push(t);
  });
  const all = [...byPlace.values()].flat();
  let shown = places.filter((p) => byPlace.has(p.id));
  if (focus) shown = [focus];
  else if (within && app.here) shown = shown.filter((p) => placeDistance(p) <= within);
  shown.sort((a, b) => (placeDistance(a) ?? Infinity) - (placeDistance(b) ?? Infinity) || a.name.localeCompare(b.name));

  const sections = shown.map((p) => {
    const tasks = applyFilter(byPlace.get(p.id) || []).sort(taskSort);
    const d = placeDistance(p);
    const here = app.here && d <= p.radius_m;
    const open = (byPlace.get(p.id) || []).filter(isOpen).length;
    return `<section class="place-section ${here ? 'here' : ''}">
      <h2 class="section-title place-title"><a href="#nearby/${p.id}">📍 ${esc(p.name)}</a>
        <span class="place-meta">${d != null ? fmtDistance(d) : ''}${here ? ' · <b class="here-now">You’re here</b>' : ''} · ${open} open</span>
        <button class="icon-btn" data-edit-place="${p.id}" aria-label="Edit ${esc(p.name)}" title="Edit place">✎</button></h2>
      ${taskList(tasks, { showPlace: false }) || '<p class="empty small">Nothing matches this filter.</p>'}</section>`;
  }).join('');

  const noPlace = db.tasks.filter((t) => isOpen(t) && !placeFor(t)).length;
  const hasMap = !!window.GOOGLE_MAPS_KEY && !window.__noMaps && places.length > 0;
  return `${focus ? '<a class="back" href="#nearby">‹ All nearby</a>' : ''}
    <div class="view-head"><h1 class="nearby">${focus ? esc(focus.name) : 'Nearby'}</h1>
      <span class="head-actions"><a class="btn small" href="#alerts">🔔 Alerts</a><a class="btn small" href="#places">Places</a><button class="btn small primary" data-act="new-place">+ Place</button></span></div>
    ${focus && focus.address ? `<p class="view-sub">${esc(focus.address)} · radius ${fmtRadius(focus.radius_m)}</p>` : ''}
    ${locationCard()}
    ${hasMap ? '<div class="nearby-map" id="nearby-map-slot"></div>' : ''}
    ${filterBar(focus || !app.here ? '' : `<label><span aria-hidden="true">📏</span><select data-within aria-label="Distance">${WITHIN.map(([m, l]) => `<option value="${m}" ${within === m ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`)}
    ${filterNote(all)}
    ${sections || (places.length
      ? `<p class="empty">No actions at ${within && app.here ? 'places this close' : 'your places'} yet. Give an action a place in its Location field, or give a tag a place so everything tagged inherits it.</p>`
      : `<div class="empty-state"><p class="empty">No places yet.</p><p class="hint">Save the places you go (Home Depot, the office, a jobsite) and attach actions to them. You’ll see them here by distance, with alerts when you arrive, leave or are nearby.</p>
         <button class="btn primary" data-act="new-place">+ Add your first place</button></div>`)}
    ${!focus && noPlace ? `<p class="view-sub">${noPlace} open action${noPlace === 1 ? ' has' : 's have'} no place and ${noPlace === 1 ? 'isn’t' : 'aren’t'} shown.</p>` : ''}`;
}

// ---------- the map (mounted after each render) ----------
const mapUi = { el: null, map: null, maps: null, overlays: [], you: null, fitKey: '' };

export async function mountNearbyMap(focusId) {
  const slot = document.getElementById('nearby-map-slot');
  if (!slot) return;
  const maps = await loadMaps();
  if (!maps || !document.body.contains(slot)) { slot.remove(); return; }
  if (!mapUi.el) {
    mapUi.el = document.createElement('div');
    mapUi.el.className = 'nearby-map-canvas';
    mapUi.maps = maps;
    mapUi.map = makeMap(maps, mapUi.el);
  }
  slot.append(mapUi.el);
  drawMap(focusId);
}

function drawMap(focusId) {
  const { maps, map } = mapUi;
  mapUi.overlays.forEach((o) => { if (o.setMap) o.setMap(null); else o.map = null; });
  mapUi.overlays = [];
  const places = activePlaces().filter((p) => actionsAt(p).length || p.id === focusId);
  places.forEach((p) => {
    const active = p.id === focusId || isInside({ place: p, radius: p.radius_m });
    const m = new maps.marker.AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, title: p.name, content: pinEl({ label: p.name, count: actionsAt(p).length, active }) });
    m.addListener('click', () => { location.hash = `#nearby/${p.id}`; });
    mapUi.overlays.push(m, circle(maps, map, { lat: p.lat, lng: p.lng }, p.radius_m, { active }));
  });
  if (app.here) mapUi.overlays.push(new maps.marker.AdvancedMarkerElement({ map, position: { lat: app.here.lat, lng: app.here.lng }, title: 'You', content: youEl(), zIndex: 999 }));
  // Refit only when what's shown changes, not on every move (panning away should stick).
  const focus = focusId && activePlace(focusId);
  const points = focus ? [{ lat: focus.lat, lng: focus.lng }] : places.map((p) => ({ lat: p.lat, lng: p.lng }));
  if (!focus && app.here) points.push({ lat: app.here.lat, lng: app.here.lng });
  const key = `${focusId || ''}|${places.map((p) => p.id).join(',')}|${app.here ? 'y' : 'n'}`;
  if (key !== mapUi.fitKey) { mapUi.fitKey = key; fitTo(maps, map, points); }
}

// ---------- Places list ----------
export function viewPlaces() {
  const list = db.places.filter((p) => app.showArchivedPlaces || !p.archived_at)
    .sort((a, b) => (!!a.archived_at - !!b.archived_at) || (placeDistance(a) ?? Infinity) - (placeDistance(b) ?? Infinity) || a.name.localeCompare(b.name));
  const rows = list.map((p) => {
    const n = actionsAt(p).length;
    const d = placeDistance(p);
    const tags = db.tags.filter((t) => t.place_id === p.id).length;
    const projects = db.projects.filter((x) => x.place_id === p.id && ['active', 'on_hold'].includes(x.status)).length;
    const via = [tags && `${tags} tag${tags === 1 ? '' : 's'}`, projects && `${projects} project${projects === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    return `<button type="button" class="group-row place-row ${p.archived_at ? 'muted' : ''}" data-edit-place="${p.id}">
      <span class="group-main"><span>📍 ${esc(p.name)}${p.archived_at ? ' (archived)' : ''}</span>
      <span class="group-sub">${esc(p.address || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`)}</span>
      <span class="group-sub">${fmtRadius(p.radius_m)} radius${d != null ? ` · ${fmtDistance(d)} away` : ''}${via ? ` · via ${via}` : ''}</span></span>
      <span class="count">${n || ''}</span></button>`;
  }).join('');
  const archived = db.places.filter((p) => p.archived_at).length;
  return `<a class="back" href="#nearby">‹ Nearby</a>
    <div class="view-head"><h1 class="nearby">Places</h1><button class="btn small primary" data-act="new-place">+ Place</button></div>
    <p class="view-sub">Saved locations. Attach them to actions, tags or projects.</p>
    ${rows || '<p class="empty">No places yet.</p>'}
    ${archived ? `<button class="btn link" data-act="toggle-archived-places">${app.showArchivedPlaces ? 'Hide' : 'Show'} ${archived} archived</button>` : ''}`;
}
