// Google Maps, loaded on demand (Nearby and the place editor) so the rest of the app
// never waits on it. Everything degrades: with no key, offline, or in tests
// (window.__noMaps), callers get null and show a plain fallback instead of a map.
import { esc } from './state.js';

let loading = null;

export function loadMaps() {
  if (window.__noMaps || !window.GOOGLE_MAPS_KEY || !navigator.onLine) return Promise.resolve(null);
  if (window.google && window.google.maps && window.google.maps.marker) return Promise.resolve(window.google.maps);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    window.__gmapsReady = () => resolve(window.google.maps);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(window.GOOGLE_MAPS_KEY)}&v=weekly&loading=async&libraries=marker,places,geocoding&callback=__gmapsReady`;
    s.async = true;
    s.onerror = () => { loading = null; resolve(null); };
    document.head.append(s);
  });
  return loading;
}

// A map in `el`, following the device's light/dark setting.
export function makeMap(maps, el, { center, zoom = 15 } = {}) {
  return new maps.Map(el, {
    mapId: window.GOOGLE_MAP_ID,
    center: center || { lat: 39.5, lng: -98.35 },
    zoom: center ? zoom : 4,
    colorScheme: maps.ColorScheme ? maps.ColorScheme.FOLLOW_SYSTEM : undefined,
    disableDefaultUI: true,
    zoomControl: true,
    clickableIcons: false,
    gestureHandling: 'greedy',
  });
}

// Pin with an optional count badge (Nearby) or a label.
export function pinEl({ label = '', count = 0, active = false } = {}) {
  const el = document.createElement('div');
  el.className = `map-pin ${active ? 'active' : ''}`;
  el.innerHTML = `<span class="map-pin-head">${count ? `<b>${count}</b>` : '📍'}</span>${label ? `<span class="map-pin-label">${esc(label)}</span>` : ''}`;
  return el;
}

export function youEl() {
  const el = document.createElement('div');
  el.className = 'map-you';
  el.title = 'You';
  return el;
}

export function circle(maps, map, center, radius, { active = false } = {}) {
  return new maps.Circle({
    map, center, radius,
    strokeColor: '#3fbf7f', strokeOpacity: active ? 1 : 0.8, strokeWeight: active ? 3 : 2,
    fillColor: '#3fbf7f', fillOpacity: active ? 0.22 : 0.1, clickable: false,
  });
}

// Fit the map to a set of points (plus you), with a sensible zoom for a single point.
export function fitTo(maps, map, points) {
  if (!points.length) return;
  if (points.length === 1) { map.setCenter(points[0]); map.setZoom(15); return; }
  const b = new maps.LatLngBounds();
  points.forEach((p) => b.extend(p));
  map.fitBounds(b, 48);
}

// Address for a coordinate ("Use my location").
export async function reverseGeocode(maps, latLng) {
  try {
    const { results } = await new maps.Geocoder().geocode({ location: latLng });
    return results && results[0] ? results[0].formatted_address : '';
  } catch { return ''; }
}
