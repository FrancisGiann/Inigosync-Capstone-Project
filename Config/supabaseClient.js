// Shared Supabase client for all pages. Requires the supabase-js CDN script
// to be loaded first:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
//   <script src="../Config/supabaseClient.js"></script>
//
// The publishable/anon key below is safe to expose in client-side code — it
// only grants what the database's row level security policies allow. Never
// put the service_role key here or anywhere in frontend code.
(function () {
    const SUPABASE_URL = 'https://xrlwtnwamboucihsamrr.supabase.co';
    const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Q4GdiCyw7ne6mn8ZY4K8hA_whVQXkqq';

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        console.error('[supabaseClient] supabase-js failed to load before Config/supabaseClient.js');
        return;
    }

    const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
    const sessionOnlyKey = 'inigosync-session-only';
    const sessionOnly = () => sessionStorage.getItem(sessionOnlyKey) === '1';
    const selectedStorage = () => sessionOnly() ? sessionStorage : localStorage;

    // Supabase always persists through this adapter so temporary sessions
    // survive navigation to a dashboard, but disappear when the tab closes.
    const storage = {
        getItem(key) {
            return selectedStorage().getItem(key);
        },
        setItem(key, value) {
            selectedStorage().setItem(key, value);
            (sessionOnly() ? localStorage : sessionStorage).removeItem(key);
        },
        removeItem(key) {
            localStorage.removeItem(key);
            sessionStorage.removeItem(key);
        }
    };

    window.InigoAuthStorage = {
        setRememberSession(remember) {
            // Move any existing session before the next auth write. Never
            // leave a persistent copy behind when Remember me is unchecked.
            const current = storage.getItem(storageKey);
            if (remember) sessionStorage.removeItem(sessionOnlyKey);
            else sessionStorage.setItem(sessionOnlyKey, '1');
            if (current !== null) storage.setItem(storageKey, current);
            else storage.removeItem(storageKey);
        }
    };

    window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { storageKey, storage }
    });
    window.SUPABASE_URL = SUPABASE_URL;
})();
