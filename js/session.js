// Staying signed in. Supabase keeps the session in this device's storage and renews it in the
// background; this makes that dependable on phones:
//   * renew as soon as the app wakes (a phone can sleep for hours, past the hour an access token lasts),
//     so the first request after waking never fails; a dropped connection never signs you out
//   * ask the browser to keep this app's storage (less likely to be cleared when space runs low)
//   * if you are signed out (not by choice), the sign-in screen says so, with your email filled in and
//     any offline captures kept for when you're back
const EMAIL_KEY = 'todo.lastEmail';
const ON_PURPOSE_KEY = 'todo.signedOutOnPurpose';
const RENEW_WITHIN = 5 * 60; // seconds before expiry that count as "about to expire"
const get = (store, k) => { try { return store.getItem(k); } catch { return null; } };
const set = (store, k, v) => { try { if (v === null) store.removeItem(k); else store.setItem(k, v); } catch { /* private mode */ } };

let renewing = null;
// Make sure the session is fresh; safe to call often. Returns the session (or null when signed out).
export async function keepSession(sb, { now = Date.now() } = {}) {
  if (!sb || !sb.auth) return null;
  if (renewing) return renewing; // calls at the same moment share one renewal
  const p = (async () => {
    try {
      const { data } = await sb.auth.getSession();
      const session = data && data.session;
      if (!session) return null;
      const left = (session.expires_at || 0) - Math.floor(now / 1000);
      if (left > RENEW_WITHIN) return session;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return session; // offline: keep it, renew later
      const { data: fresh, error } = await sb.auth.refreshSession();
      return (!error && fresh && fresh.session) || session; // a network error is not a sign-out
    } catch { return null; }
  })();
  renewing = p;
  p.finally(() => { if (renewing === p) renewing = null; });
  return p;
}

// After signing in: remember the email for next time and ask to keep storage.
export function signedIn(user) {
  if (user && user.email) set(localStorage, EMAIL_KEY, user.email);
  set(sessionStorage, ON_PURPOSE_KEY, null);
  set(localStorage, ON_PURPOSE_KEY, null);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then((p) => (p ? null : navigator.storage.persist())).catch(() => {}); } catch { /* not supported */ }
}
export const markSignedOutOnPurpose = () => set(localStorage, ON_PURPOSE_KEY, '1');
export const lastEmail = () => get(localStorage, EMAIL_KEY) || '';

// What the sign-in screen should say: nothing on a first visit or after "Sign out"; otherwise that
// this device was signed out, and how many offline captures are waiting.
export function signInNotice() {
  const email = lastEmail();
  if (!email || get(localStorage, ON_PURPOSE_KEY)) return '';
  let waiting = 0;
  try { waiting = JSON.parse(get(localStorage, 'todo.outbox') || '[]').length; } catch { waiting = 0; }
  return `You were signed out on this device. Sign in to pick up where you left off${waiting ? `: ${waiting} capture${waiting === 1 ? '' : 's'} made offline will sync` : ''}.`;
}
