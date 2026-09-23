// Errand run: pick the places with available actions, get the fastest order (Google Routes
// waypoint optimization, falling back to nearest-next), and open the trip in Google Maps.
import { db, app, $, esc, openSheet, isOpen } from '../state.js';
import { activePlaces, placeFor, placeDistance } from '../places.js';
import { isAvailable } from '../availability.js';
import { distanceM, fmtDistance } from '../geo.js';

const MAX_STOPS = 9; // Google Maps links take at most 9 waypoints on phones

// Places with at least one available action, nearest first.
export function errandCandidates() {
  const counts = new Map();
  db.tasks.forEach((t) => {
    if (!isOpen(t) || !isAvailable(t)) return;
    const loc = placeFor(t);
    if (loc) counts.set(loc.place.id, (counts.get(loc.place.id) || 0) + 1);
  });
  return activePlaces().filter((p) => counts.has(p.id)).map((p) => ({ place: p, count: counts.get(p.id), d: placeDistance(p) }))
    .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));
}

// Greedy nearest-next order (used when the Routes API isn't available).
export function nearestOrder(start, stops) {
  const left = [...stops];
  const out = [];
  let at = start;
  while (left.length) {
    left.sort((a, b) => distanceM(at, a) - distanceM(at, b));
    at = left.shift();
    out.push(at);
  }
  return out;
}

const ll = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

// Fastest order via Routes API (the browser key allows it for this site). Returns
// { order: [place], minutes, meters } or null.
export async function optimize(start, stops, roundTrip) {
  if (!window.GOOGLE_MAPS_KEY || window.__noMaps || stops.length < 2) return null;
  const destination = roundTrip ? start : null;
  const intermediates = roundTrip ? stops : stops.slice(0, -1);
  const last = roundTrip ? null : stops[stops.length - 1];
  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': window.GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex' },
      body: JSON.stringify({ origin: ll(start), destination: ll(destination || last), intermediates: intermediates.map(ll), travelMode: 'DRIVE', optimizeWaypointOrder: true }),
    });
    if (!res.ok) return null;
    const { routes } = await res.json();
    const r = routes && routes[0];
    if (!r) return null;
    const idx = r.optimizedIntermediateWaypointIndex || intermediates.map((_, i) => i);
    const order = idx.map((i) => intermediates[i]);
    if (last) order.push(last);
    return { order, minutes: Math.round(parseInt(r.duration, 10) / 60), meters: r.distanceMeters };
  } catch { return null; }
}

export function mapsUrl(start, order, roundTrip) {
  const s = (p) => `${p.lat},${p.lng}`;
  const dest = roundTrip ? start : order[order.length - 1];
  const via = roundTrip ? order : order.slice(0, -1);
  const q = new URLSearchParams({ api: '1', origin: s(start), destination: s(dest), travelmode: 'driving' });
  if (via.length) q.set('waypoints', via.map(s).join('|'));
  return `https://www.google.com/maps/dir/?${q}`;
}

export function openErrandPlanner() {
  const start = app.here;
  const cands = errandCandidates();
  const sheet = openSheet(`<form method="dialog" class="errand-form">
    <h2>🚗 Errand run</h2>
    ${start ? '' : '<p class="form-error">Turn on location to plan a route from where you are.</p>'}
    <p class="view-sub" style="margin:0">Places with something you can do now. Pick up to ${MAX_STOPS}.</p>
    <ul class="errand-list">${cands.map((c, i) => `<li><label class="flag-toggle"><input type="checkbox" name="stop" value="${c.place.id}" ${i < MAX_STOPS && (c.d == null || c.d < 40234) ? 'checked' : ''}>
      <span>${esc(c.place.name)} <span class="hint">${c.count} action${c.count === 1 ? '' : 's'}${c.d != null ? ` · ${fmtDistance(c.d)}` : ''}</span></span></label></li>`).join('') || '<li class="hint">No places have available actions.</li>'}</ul>
    <label class="flag-toggle"><input type="checkbox" name="round" checked> Come back to where I am</label>
    <div class="errand-result" data-result></div>
    <div class="actions"><div class="right"><button type="button" class="btn" data-cancel>Close</button>
      <button type="submit" class="btn primary" ${start && cands.length ? '' : 'disabled'}>Plan route</button></div></div>
  </form>`);
  const form = $('form', sheet);
  $('[data-cancel]', form).onclick = () => sheet.close();
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'stop') return;
    const on = form.querySelectorAll('input[name=stop]:checked');
    if (on.length > MAX_STOPS) { e.target.checked = false; }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const ids = [...form.querySelectorAll('input[name=stop]:checked')].map((x) => x.value);
    const stops = ids.map((id) => db.places.find((p) => p.id === id));
    if (!stops.length) return;
    const round = form.elements.round.checked;
    const out = $('[data-result]', form);
    out.innerHTML = '<p class="hint">Finding the fastest order…</p>';
    const best = await optimize(start, stops, round);
    const order = best ? best.order : nearestOrder(start, stops);
    const url = mapsUrl(start, order, round);
    out.innerHTML = `<ol class="errand-order">${order.map((p) => {
      const n = db.tasks.filter((t) => isOpen(t) && isAvailable(t) && (placeFor(t) || {}).place === p).length;
      return `<li><b>${esc(p.name)}</b> <span class="hint">${n} action${n === 1 ? '' : 's'}</span></li>`;
    }).join('')}</ol>
      <p class="view-sub" style="margin:0">${best ? `About ${best.minutes} min driving · ${fmtDistance(best.meters)}` : 'Ordered nearest-next (couldn’t reach Google Routes).'}</p>
      <a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener" data-maps-link>Open in Google Maps</a>`;
  };
  sheet.showModal();
}
