// Production Supabase config (todo-tooling project). This file IS committed on
// purpose: the site is a static deploy and the publishable key is a public,
// RLS-gated credential (never put a service-role/secret key here). Secrets and
// dev-only overrides belong in config.local.js (gitignored, loaded on
// localhost only) — see config.example.js.

window.SUPABASE_URL = 'https://cgssdelgtxlrfgozchps.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_5bN5RarF89iKs2BeAHJNXQ_I9GWvrrL';

// Google Maps (todo-tooling Cloud project). A browser key is public by design; it is
// locked to todotooling.com + localhost:8765 and to Maps JS, Places (New), Geocoding
// and Routes. The MCP server uses a separate key stored as a Worker secret.
window.GOOGLE_MAPS_KEY = 'AIzaSyCwl3XS50OjBYS0mbD_A_MF93BFUgUBGUo';
window.GOOGLE_MAP_ID = '194508c66d711de5dd00d220';

// Web Push (VAPID) public key, for background location alerts. The private key lives only on the server.
window.VAPID_PUBLIC_KEY = 'BFWjkoky_gLUckVvLVM9kosRLJ-WNE6aI4w4pRtya0FjZexa72ymNRyITiv3hYr3bMlcXrprfyzJud8JEZQNoGk';
