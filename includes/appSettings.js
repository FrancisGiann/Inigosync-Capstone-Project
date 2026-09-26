// IñigoSync — Shared payment/app settings data layer for the customer and
// staff dashboards (Dashboard.js's booking downpayment split,
// staff_dashboard.js's walk-in payment options) and the write side on the
// owner dashboard (owner_dashboard.js's Payment Configuration panel).
//
// Same fetch-with-static-fallback shape as includes/courtsData.js: reads the
// `app_settings` table (database/schema/007_app_settings.sql) — a single-row
// table an admin writes from Payment Configuration — and falls back to
// today's hardcoded values (GCash + Cash both on, 50% downpayment) whenever
// that table doesn't exist yet, is empty, or the fetch fails/times out. The
// app must behave identically before and after the owner runs that
// migration (docs/OWNER_ACTION_LIST.md item A5), same guarantee
// courtsData.js already makes for court/sport data.
//
// This project ships plain <script src> tags (no build step, no ES
// modules), so this attaches to window, same as includes/courtsData.js.
// Load this after Config/supabaseClient.js and before includes/Dashboard.js,
// includes/staff_dashboard.js, and includes/owner_dashboard.js.
(function () {
    const FETCH_TIMEOUT_MS = 6000;

    // Mirrors app_settings' own column defaults 1:1 (see
    // database/schema/007_app_settings.sql) — kept in sync on purpose so a
    // pre-migration session and a freshly-migrated, never-saved session look
    // identical to every dashboard reading this.
    const DEFAULT_SETTINGS = Object.freeze({
        cardEnabled: true,
        gcashEnabled: true,
        cashEnabled: true,
        downpaymentPct: 50,
        nightRateStartsAt: null,
    });

    function withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((resolve) => {
                setTimeout(() => resolve({ data: null, error: new Error(`Supabase request timed out after ${ms}ms`) }), ms);
            }),
        ]);
    }

    // row is null/undefined pre-migration (table missing) or pre-first-save
    // (table empty) — both resolve to the same DEFAULT_SETTINGS rather than
    // throwing or rendering blank fields.
    function normalize(row) {
        if (!row) return { ...DEFAULT_SETTINGS };
        const pct = Number(row.downpayment_pct);
        return {
            cardEnabled: row.card_enabled !== false,
            gcashEnabled: row.gcash_enabled !== false,
            cashEnabled: row.cash_enabled !== false,
            downpaymentPct: Number.isFinite(pct) ? pct : DEFAULT_SETTINGS.downpaymentPct,
            nightRateStartsAt: row.night_rate_starts_at || null,
        };
    }

    async function fetchSettings() {
        if (!window.sb) return { ...DEFAULT_SETTINGS };
        try {
            const { data, error } = await withTimeout(
                window.sb.from('app_settings').select('*').eq('id', true).limit(1).maybeSingle(),
                FETCH_TIMEOUT_MS
            );
            if (error) {
                console.warn('[IñigoSync] app_settings fetch failed — using default payment settings.', error.message || error);
                return { ...DEFAULT_SETTINGS };
            }
            return normalize(data);
        } catch (err) {
            console.warn('[IñigoSync] app_settings fetch threw — using default payment settings.', err);
            return { ...DEFAULT_SETTINGS };
        }
    }

    // Memoized, same as courtsData.js's getCourts()/getSports() — every
    // caller on a page shares one network request. `force` re-fetches (used
    // after the owner dashboard's own successful save, so re-opening the
    // panel doesn't show stale pre-save values).
    let settingsPromise = null;

    function getSettings({ force = false } = {}) {
        if (force) settingsPromise = null;
        if (!settingsPromise) settingsPromise = fetchSettings();
        return settingsPromise;
    }

    function invalidateSettings() {
        settingsPromise = null;
    }

    window.InigoAppSettings = {
        getSettings,
        invalidateSettings,
        DEFAULT_SETTINGS,
    };
})();
