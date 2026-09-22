// Creates the shared Supabase client from config.js as window.sb.
(function () {
  if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    console.warn('Supabase not configured; see config.example.js');
    return;
  }
  window.sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
})();
