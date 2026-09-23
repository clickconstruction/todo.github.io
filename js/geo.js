// Location services. Your position stays on this device: it is kept in memory (and the
// last fix in localStorage so distances show instantly on launch), never sent to the server.
// Browsers only share location while the app is open, so we watch while it's visible.
import { app } from './state.js';

const LAST_KEY = 'todo.here';
const MOVE_M = 30; // re-render lists after moving this far
let watchId = null;
let lastNotified = null;
const listeners = [];

try {
  const saved = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
  if (saved && Date.now() - saved.at < 12 * 3600e3) app.here = saved; // a stale fix is worse than none
} catch { /* private mode */ }

export const onLocation = (fn) => listeners.push(fn);

// Tests replace the browser API: window.__geo = { state, position: {lat, lng, accuracy} }.
const fake = () => window.__geo;

// 'granted' | 'prompt' | 'denied' | 'unsupported'
export async function locationPermission() {
  if (fake()) return fake().state;
  if (!('geolocation' in navigator)) return 'unsupported';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  } catch {
    return app.here ? 'granted' : 'prompt'; // older Safari has no permissions API
  }
}

function accept(coords) {
  const here = { lat: coords.latitude ?? coords.lat, lng: coords.longitude ?? coords.lng, accuracy: Math.round(coords.accuracy || 0), at: Date.now() };
  app.here = here;
  app.locationState = 'granted';
  try { localStorage.setItem(LAST_KEY, JSON.stringify(here)); } catch { /* private mode */ }
  const moved = !lastNotified || distanceM(lastNotified, here) >= MOVE_M;
  if (moved) lastNotified = here;
  listeners.forEach((fn) => fn(here, moved));
}

// Ask for location. Call from a tap: iOS only shows the prompt for a user gesture.
export function requestLocation() {
  if (fake()) {
    const f = fake();
    if (f.state === 'denied') { app.locationState = 'denied'; return Promise.reject(new Error('denied')); }
    f.state = 'granted';
    accept(f.position);
    return Promise.resolve(app.here);
  }
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { accept(pos.coords); startWatching(); resolve(app.here); },
      (err) => { if (err.code === err.PERMISSION_DENIED) app.locationState = 'denied'; reject(err); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

// Keep the position current while the app is on screen (battery-friendly accuracy).
export async function startWatching() {
  if (watchId !== null || document.visibilityState !== 'visible') return;
  const state = await locationPermission();
  app.locationState = state;
  if (state !== 'granted') return;
  if (fake()) { accept(fake().position); watchId = 'fake'; return; }
  watchId = navigator.geolocation.watchPosition((pos) => accept(pos.coords), () => {}, { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 });
}

export function stopWatching() {
  if (watchId !== null && watchId !== 'fake') navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? startWatching() : stopWatching()));

// ---------- distance ----------
export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const FT_PER_M = 3.28084;
const M_PER_MI = 1609.344;
// US units: feet up to 0.1 mi, then miles.
export function fmtDistance(m) {
  if (m == null) return '';
  if (m < 161) return `${Math.max(10, Math.round((m * FT_PER_M) / 10) * 10)} ft`;
  const mi = m / M_PER_MI;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

// Radius presets shared by the place and item editors (meters).
export const RADIUS_PRESETS = [[152, '500 ft'], [402, '¼ mi'], [805, '½ mi'], [1609, '1 mi'], [8047, '5 mi']];
export const fmtRadius = (m) => (RADIUS_PRESETS.find(([v]) => v === m) || [0, fmtDistance(m)])[1];

// How to turn location back on after "Don't allow".
export function deniedHelp() {
  const ua = navigator.userAgent;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (/iPhone|iPad/.test(ua)) {
    return standalone
      ? 'On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using the App. Then reopen Todo Tooling.'
      : 'On iPhone: tap “aA” in Safari’s address bar → Website Settings → Location → Allow.';
  }
  if (/Android/.test(ua)) return 'On Android: tap the lock icon by the address (or the app’s ⋮ → App info) → Permissions → Location → Allow.';
  return 'In your browser: click the icon at the left of the address bar → Site settings → Location → Allow, then reload.';
}
