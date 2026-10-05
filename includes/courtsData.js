// IñigoSync — Shared court/sport data layer for the customer + admin
// dashboards (Court Information, Booking Management, admin Court Listings).
//
// This is Phase 2's fix for docs/QA_AUDIT_REPORT.md P0#8: three contradictory
// hardcoded court lists (landing, customer dashboard, admin dashboard) that
// disagreed with each other. All three now read the same `court`/`sport`
// tables — the landing page already did this correctly (see
// includes/landingPage.js's getCourts()); this file gives the two dashboard
// controllers (includes/Dashboard.js, includes/owner_dashboard.js) the exact
// same fetch-with-static-fallback pattern landingPage.js proved, instead of
// each hand-rolling its own copy that could drift the same way the old
// hardcoded arrays did.
//
// Deliberately NOT reusing includes/landingPage.js's internal getCourts()
// directly: that file is only <script>-included on Pages/Index.html, and
// pulling the whole file into the dashboards would double-wire the theme
// toggle, nav scroll-spy, and hero-carousel code it also contains — querying
// elements that don't exist there is harmless, but re-registering the
// `[data-theme-toggle]` click listener a second time is not (the toggle
// would fire twice per click and appear to do nothing). This file owns only
// the data layer, never any page-specific rendering/wiring.
//
// One deliberate difference from landingPage.js's getCourts(): rows are
// returned UNMERGED. The landing page merges Bowling's Duckpin/Ten-Pin rows
// into one marketing-overview card (mergeCourtsBySport); the dashboards need
// every row addressable on its own — the customer picks a specific bookable
// unit (Duckpin vs Ten-Pin have different rates and rate units), and the
// admin edits one specific row's id. Merging here would make "Edit" ambiguous
// about which underlying row it's touching.
//
// This project ships plain <script src> tags (no build step, no ES
// modules), so this attaches to window, same as includes/escape.js. Load
// this after Config/supabaseClient.js and includes/courts-data.js, and
// before includes/Dashboard.js / includes/owner_dashboard.js.
//
// See database/schema/002_content_tables.sql for the `court`/`sport` shape,
// database/schema/003_court_rating.sql for the optional `rating` column this
// also reads (renders only once the owner has run that migration AND a
// court actually has a rating — both are true today), and
// database/seed/002_seed_content.sql for the real 9-row data the fallback
// below mirrors.
(function () {
    const FETCH_TIMEOUT_MS = 6000;

    // Same 2-letter marks includes/landingPage.js uses, so a court renders
    // identically whether the customer sees it there or in their dashboard.
    const SPORT_MONOGRAM = {
        'basketball': 'BB',
        'badminton': 'BD',
        'lawn-tennis': 'LT',
        'pickleball': 'PB',
        'bowling': 'BW',
        'bowling-duckpin': 'BW',
        'bowling-tenpin': 'BW',
        'billiards': 'BL',
        'table-tennis': 'TT',
        'volleyball': 'VB',
    };

    // Sport display names, keyed by slug. Used for (a) the FALLBACK court
    // rows below (COURTS_INVENTORY doesn't carry a separate sport name —
    // "Bowling — Duckpin" is the *court* name, not the sport's), and (b) the
    // admin "Sport type" dropdown's own fallback if the live `sport` table
    // can't be reached. Whenever the DB is reachable, the real sportName
    // always comes from the join/select instead of this map.
    const SPORT_NAMES = {
        'basketball': 'Basketball',
        'badminton': 'Badminton',
        'lawn-tennis': 'Lawn Tennis',
        'pickleball': 'Pickleball',
        'bowling': 'Bowling',
        'billiards': 'Billiards',
        'table-tennis': 'Table Tennis',
        'volleyball': 'Volleyball',
    };

    function monogramFor(sportSlug, name) {
        if (sportSlug && SPORT_MONOGRAM[sportSlug]) return SPORT_MONOGRAM[sportSlug];
        const words = String(name || '?').split('—')[0].trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
        return (words[0] || '?').slice(0, 2).toUpperCase();
    }

    // ------------------------------------------------------------------
    // Per-unit resolution — ported from includes/landingPage.js's own
    // resolveCourtUnits()/normalizeUnitImages() (implementation_plan.md D2)
    // so the customer dashboard's Overview Courts widget (§4 of
    // InigoSync_Dashboard_Feedback_v6.md — combo box + per-unit imagery,
    // includes/Dashboard.js's renderOverviewCourtCard) can build the exact
    // same "which of the 9 badminton courts is this?" picker the landing
    // page's court viewer already offers, without a third hand-rolled copy.
    // landingPage.js itself is intentionally left untouched (D2) — this is
    // the ONE port, and every other consumer should call this, not
    // reimplement it again.
    //
    // One deliberate difference from the landingPage.js original: that
    // version has a "case 2" for a sport whose DB rows were merged
    // (Bowling's Duckpin + Ten-Pin under one card, via its own
    // mergeCourtsBySport). getCourts() in THIS file deliberately returns
    // rows UNMERGED (see this file's header comment) — every court a
    // customer can pick to book is its own row/card here, Duckpin and
    // Ten-Pin included — so there is no "variants" concept to resolve a
    // case 2 from. Cases 1 and 3 (the ones that don't depend on merging)
    // are ported as-is; case 2 is not applicable to this data shape.
    //
    // See database/schema/006_court_unit_images.sql for the `unit_images`
    // column shape ([{label, image_url}]) and its three fallback cases.
    // ------------------------------------------------------------------

    // `court.unit_images` — see database/schema/006_court_unit_images.sql.
    // NULL/undefined (every row today, until the owner applies that
    // migration and fills it in) normalizes to [], which resolveCourtUnits
    // below treats as "no per-unit photos yet" and falls through to
    // deriving Court/Lane/Table N from quantity + unit instead. Never
    // invents a URL.
    function normalizeUnitImages(value, contextLabel) {
        if (value === null || value === undefined || value === '') return [];

        let parsed = value;
        // PostgREST returns jsonb already parsed. A string only turns up if
        // the JSON was stored by hand in a text column — parse it rather
        // than silently dropping the owner's data, but never assume it's
        // valid.
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch (err) {
                console.warn('[IñigoSync] court "%s" has an unparseable unit_images value — ignoring it and deriving unit names instead.', contextLabel, err);
                return [];
            }
        }

        if (!Array.isArray(parsed)) {
            console.warn('[IñigoSync] court "%s" has a unit_images value that is not an array — ignoring it. Expected [{"label": "…", "image_url": "…"}].', contextLabel);
            return [];
        }

        return parsed
            .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
            .map((entry) => ({
                // Both fields are optional per entry: a blank label gets a
                // derived "Court N" in resolveCourtUnits, and a blank
                // image_url renders the same honest placeholder the rest of
                // the dashboard uses.
                label: (typeof entry.label === 'string' && entry.label.trim()) ? entry.label.trim() : null,
                imageUrl: (typeof entry.image_url === 'string' && entry.image_url.trim()) ? entry.image_url.trim() : null,
            }));
    }

    // The singular noun for one bookable unit. `court.unit` is plural in the
    // schema ('courts' | 'lanes' | 'tables' — database/schema/002_content_
    // tables.sql) except Volleyball's seeded row, which is the singular
    // 'court', so both spellings have to map.
    const UNIT_NOUN = {
        court: 'Court',
        courts: 'Court',
        lane: 'Lane',
        lanes: 'Lane',
        table: 'Table',
        tables: 'Table',
    };

    function unitNoun(unit) {
        const key = String(unit || '').trim().toLowerCase();
        if (UNIT_NOUN[key]) return UNIT_NOUN[key];
        // `unit` is free text as far as the DB is concerned and admin Court
        // Listings can write it, so an unknown noun ("bays") is possible.
        // Drop a trailing 's' and title-case it rather than falling back to
        // a generic "Unit 1" that tells the customer nothing.
        const word = key.replace(/s$/, '');
        if (!word) return 'Unit';
        return word.charAt(0).toUpperCase() + word.slice(1);
    }

    // Returns { pickerLabel, units } where units is [{ label, imageUrl }, …].
    // A sport that resolves to fewer than two units gets no combobox at all
    // — a one-item <select> is a dead control, not a choice (same rule
    // includes/landingPage.js's court viewer uses).
    function resolveCourtUnits(court) {
        const noun = unitNoun(court.unit);

        // When the shared physical-resource schema is present, its UUID is
        // the stable identity used by reservation triggers. Never regenerate
        // a bookable identity from quantity or a mutable photo label.
        if (Array.isArray(court.bookableUnits)) {
            return {
                pickerLabel: `Choose a ${noun.toLowerCase()}`,
                units: court.bookableUnits.map((entry) => ({
                    id: entry.id,
                    label: entry.label,
                    resourceIds: Array.isArray(entry.resourceIds) ? entry.resourceIds.slice() : [],
                    imageUrl: entry.imageUrl || court.imageUrl,
                    pricingTier: entry.pricingTier || null,
                    rateDay: entry.rateDay === null || entry.rateDay === undefined ? null : Number(entry.rateDay),
                    rateNight: entry.rateNight === null || entry.rateNight === undefined ? null : Number(entry.rateNight),
                    rateUnit: entry.rateUnit || '/hr',
                })),
            };
        }

        const fromImages = Array.isArray(court.unitImages) ? court.unitImages : [];
        if (fromImages.length > 0) {
            return {
                pickerLabel: `Choose a ${noun.toLowerCase()}`,
                units: fromImages.map((entry, i) => ({
                    id: null,
                    label: entry.label || `${noun} ${i + 1}`,
                    imageUrl: entry.imageUrl,
                })),
            };
        }

        // No "case 2" (merged-row variants) here — see this block's header
        // comment on why that doesn't apply to this file's unmerged rows.

        const count = Math.max(0, Math.floor(Number(court.quantity) || 0));
        const units = [];
        for (let i = 1; i <= count; i++) {
            units.push({ id: null, label: `${noun} ${i}`, imageUrl: court.imageUrl });
        }
        // quantity 0 or missing: still show the court's own photo, but with
        // nothing to pick between and no invented "Court 1" that doesn't
        // exist.
        if (units.length === 0) {
            units.push({ id: null, label: null, imageUrl: court.imageUrl });
        }

        return { pickerLabel: `Choose a ${noun.toLowerCase()}`, units };
    }

    // URL-safe slug for a NEW court's `slug` column (text, not null,
    // unique). Only used on insert — editing an existing court never
    // touches its slug (see includes/owner_dashboard.js), so a rename can't
    // collide with another row's slug or orphan anything that keyed off it.
    function slugify(name) {
        const base = String(name || '')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return base || `court-${Date.now()}`;
    }

    function withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((resolve) => {
                setTimeout(() => resolve({ data: null, error: new Error(`Supabase request timed out after ${ms}ms`) }), ms);
            }),
        ]);
    }

    // Resolves to the raw row array on success, or null if Supabase is
    // unreachable, errors, times out, or the table is empty — null is the
    // signal callers use to fall back to static content instead of
    // rendering a blank grid/dropdown.
    async function safeSelect(runQuery) {
        if (!window.sb) return null;
        try {
            const { data, error } = await withTimeout(runQuery(), FETCH_TIMEOUT_MS);
            if (error) {
                console.warn('[IñigoSync] court/sport query failed — using fallback content instead.', error.message || error);
                return null;
            }
            return (Array.isArray(data) && data.length > 0) ? data : null;
        } catch (err) {
            console.warn('[IñigoSync] court/sport query threw — using fallback content instead.', err);
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Fallback courts — reuses includes/courts-data.js's COURTS_INVENTORY
    // (the SAME 9 rows database/seed/002_seed_content.sql inserts) when
    // that file is loaded on the page, so there is exactly ONE
    // hand-maintained fallback array in the whole project, not a second copy
    // that could silently drift back to the old contradictory 5-item lists
    // this phase removed (docs/QA_AUDIT_REPORT.md P0#8). INLINE_FALLBACK is
    // only a safety net for a page that forgets to include courts-data.js —
    // kept in sync with the same 9 rows by hand, same as COURTS_INVENTORY
    // itself already is.
    // ------------------------------------------------------------------
    const INLINE_FALLBACK = [
        { id: 'basketball', name: 'Basketball', quantity: 2, unit: 'courts', description: 'Full court · Indoor · Scoreboard', rate: null, rateUnit: '/hr', status: 'Available', image_url: null },
        { id: 'badminton', name: 'Badminton', quantity: 9, unit: 'courts', description: 'Indoor · Rackets for rent', rate: null, rateUnit: '/hr', status: 'Available', image_url: null },
        { id: 'lawn-tennis', name: 'Lawn Tennis', quantity: 3, unit: 'courts', description: 'Outdoor · Professional grade', rate: null, rateUnit: '/hr', status: 'Available', image_url: null },
        { id: 'pickleball', name: 'Pickleball', quantity: 10, unit: 'courts', description: 'Shared across Basketball, Volleyball & Lawn Tennis', rate: null, rateUnit: '/hr', status: 'Available', image_url: null },
        { id: 'bowling-duckpin', name: 'Bowling — Duckpin', quantity: 8, unit: 'lanes', description: 'Duckpin bowling · Shoes included', rate: null, rateUnit: '/game', status: 'Available', image_url: null },
        { id: 'bowling-tenpin', name: 'Bowling — Ten-Pin', quantity: 12, unit: 'lanes', description: 'Ten-pin bowling · Shoes included', rate: null, rateUnit: '/game', status: 'Available', image_url: null },
        { id: 'billiards', name: 'Billiards', quantity: 2, unit: 'tables', description: 'Professional pool tables · Cue service available', rate: null, rateUnit: '/hr', status: 'Available', image_url: null },
        { id: 'table-tennis', name: 'Table Tennis', quantity: 2, unit: 'tables', description: 'Tournament-grade tables · Paddles for rent', rate: null, rateUnit: '/hr', status: 'Available', image_url: null },
        { id: 'volleyball', name: 'Volleyball', quantity: 1, unit: 'court', description: 'Full court · Indoor · Net included', rate: null, rateUnit: '/hr', status: 'Available', image_url: null },
    ];

    function fallbackCourts() {
        const source = (typeof COURTS_INVENTORY !== 'undefined') ? COURTS_INVENTORY : INLINE_FALLBACK;
        return source.map((item, index) => {
            // Duckpin/ten-pin ids carry a suffix so they land under the one
            // 'bowling' sport group — same trick includes/landingPage.js's
            // normalizeCourtFromFallback uses.
            const sportSlug = String(item.id).replace(/-duckpin$|-tenpin$/, '');
            return {
                id: `fallback-${item.id}`,
                sportId: null,
                sportSlug,
                sportName: SPORT_NAMES[sportSlug] || sportSlug,
                slug: item.id,
                name: item.name || '',
                quantity: Number(item.quantity) || 0,
                unit: item.unit || 'courts',
                description: item.description || '',
                rate: (item.rate === '—' || item.rate === null || item.rate === undefined) ? null : Number(item.rate),
                rateUnit: item.rateUnit || '/hr',
                status: item.status || 'Available',
                imageUrl: item.image_url || null,
                displayOrder: index + 1,
                isActive: true,
                // No fallback ever invents a rating — see
                // database/schema/003_court_rating.sql's note on this.
                rating: null,
                // Nor per-unit photos: COURTS_INVENTORY/INLINE_FALLBACK never
                // carry unit_images, so resolveCourtUnits() always falls
                // through to deriving Court/Lane/Table N from quantity+unit
                // for a fallback row — same as a live DB row before
                // database/schema/006_court_unit_images.sql is filled in.
                unitImages: normalizeUnitImages(item.unit_images, item.id),
                // Static quantities are useful for read-only public pages,
                // but cannot authorize a booking when live inventory failed.
                inventoryLoadFailed: true,
            };
        });
    }

    const SPORTS_FALLBACK = Object.keys(SPORT_NAMES).map((slug, index) => ({
        id: `fallback-${slug}`,
        slug,
        name: SPORT_NAMES[slug],
        display_order: index + 1,
    }));

    // ------------------------------------------------------------------
    // Normalize — same idea as landingPage.js's normalizeCourtFromDb, but
    // keeps `id`/`sportId` (the admin needs a real row id to target an
    // update) and reads `rating`, which doesn't exist on `court` until the
    // owner runs database/schema/003_court_rating.sql. Selecting `*` (see
    // runCourtsQuery below) rather than naming columns means that migration
    // needs zero changes here — an unknown `rating` column is simply
    // `undefined` on every row until it exists, same as `null`.
    // ------------------------------------------------------------------
    function normalizeCourt(row, bookableUnits) {
        return {
            id: row.id,
            sportId: row.sport_id || (row.sport && row.sport.id) || null,
            sportSlug: (row.sport && row.sport.slug) || null,
            sportName: (row.sport && row.sport.name) || '',
            slug: row.slug || '',
            name: row.name || '',
            quantity: Number(row.quantity) || 0,
            unit: row.unit || 'courts',
            description: row.description || '',
            rate: (row.rate === null || row.rate === undefined) ? null : Number(row.rate),
            rateUnit: row.rate_unit || '/hr',
            status: row.status || 'Available',
            imageUrl: row.image_url || null,
            displayOrder: Number(row.display_order) || 0,
            isActive: row.is_active !== false,
            rating: (row.rating === null || row.rating === undefined) ? null : Number(row.rating),
            // Same "column may not exist yet" story as `rating` — see
            // normalizeUnitImages above and
            // database/schema/006_court_unit_images.sql. select('*') means
            // this migration needs zero changes here either: row.unit_images
            // is simply `undefined` on every row until it's applied.
            unitImages: normalizeUnitImages(row.unit_images, row.slug || row.name),
            bookableUnits: Array.isArray(bookableUnits) ? bookableUnits : undefined,
            inventoryLoadFailed: bookableUnits === null,
        };
    }

    function runCourtsQuery(includeInactive) {
        let query = window.sb.from('court').select('*, sport(id, slug, name)').order('display_order');
        if (!includeInactive) query = query.eq('is_active', true);
        return query;
    }

    // Memoized per includeInactive so Court Information + Booking
    // Management (both active-only) share one network request, same as
    // landingPage.js memoizing courtsPromise — but re-fetchable (`force`)
    // so an admin's Add/Edit/Activate immediately reflects instead of
    // showing stale data until the next full page load.
    const courtsCache = { active: null, all: null };

    function getCourts({ includeInactive = false, force = false } = {}) {
        const key = includeInactive ? 'all' : 'active';
        if (force) courtsCache[key] = null;
        if (!courtsCache[key]) {
            courtsCache[key] = Promise.all([
                safeSelect(() => runCourtsQuery(includeInactive)),
                safeSelect(() => window.sb.from('court_unit_inventory')
                    .select('id,court_id,label,photo_url,pricing_tier,rate_day,rate_night,rate_unit,court_unit_resource_map(resource_id)')
                    .eq('is_active', true).eq('inventory_verified', true)),
            ]).then(([rows, unitRows]) => {
                if (!rows) return fallbackCourts();
                const configuredUnits = new Map();
                (unitRows || []).forEach((unit) => {
                    if (!Array.isArray(unit.court_unit_resource_map) || unit.court_unit_resource_map.length === 0) return;
                    const list = configuredUnits.get(unit.court_id) || [];
                    list.push({
                        id: unit.id,
                        label: unit.label,
                        imageUrl: unit.photo_url || null,
                        pricingTier: unit.pricing_tier || null,
                        rateDay: unit.rate_day === null || unit.rate_day === undefined ? null : Number(unit.rate_day),
                        rateNight: unit.rate_night === null || unit.rate_night === undefined ? null : Number(unit.rate_night),
                        rateUnit: unit.rate_unit || '/hr',
                        resourceIds: unit.court_unit_resource_map.map((mapping) => mapping.resource_id).filter(Boolean),
                    });
                    configuredUnits.set(unit.court_id, list);
                });
                return rows.map((row) => {
                    const court = normalizeCourt(row, unitRows ? (configuredUnits.get(row.id) || []) : undefined);
                    court.inventoryLoadFailed = unitRows === null;
                    return court;
                });
            });
        }
        return courtsCache[key];
    }

    function invalidateCourts() {
        courtsCache.active = null;
        courtsCache.all = null;
    }

    let sportsPromise = null;
    // Set inside getSports()'s own .then(), before the value it resolves to
    // reaches any caller's .then()/await — see isSportsFallback() below.
    let sportsWasFallback = false;
    function getSports({ force = false } = {}) {
        if (force) sportsPromise = null;
        if (!sportsPromise) {
            sportsPromise = safeSelect(() => window.sb.from('sport').select('*').eq('is_active', true).order('display_order'))
                .then((rows) => {
                    sportsWasFallback = !rows;
                    return rows || SPORTS_FALLBACK;
                });
        }
        return sportsPromise;
    }

    // Lets a caller tell "getSports() resolved with the real `sport` table"
    // apart from "getSports() fell back to the static SPORTS_FALLBACK"
    // without changing getSports()'s own return shape (still a plain
    // array) — every existing caller (the admin Court Listings sport
    // dropdown, staff_dashboard.js's schedule sport tabs) reads it that way
    // and neither needs to know which case it got. Only meaningful after
    // the getSports() promise the caller cares about has resolved; reflects
    // whichever fetch actually ran, since getSports() memoizes.
    function isSportsFallback() {
        return sportsWasFallback;
    }

    function rateHint(court) {
        const units = Array.isArray(court?.bookableUnits) ? court.bookableUnits : [];
        const scheduled = units.flatMap((unit) => [unit.rateDay, unit.rateNight]
            .filter((value) => typeof value === 'number' && Number.isFinite(value))
            .map((value) => ({ value, unit: unit.rateUnit || court.rateUnit || '/hr' })));
        if (!scheduled.length) {
            return typeof court?.rate === 'number' && Number.isFinite(court.rate)
                ? `₱${court.rate.toLocaleString('en-PH', { maximumFractionDigits: 2 })}${court.rateUnit || '/hr'}`
                : null;
        }
        const rateUnit = scheduled[0].unit;
        if (scheduled.some((rate) => rate.unit !== rateUnit)) return 'See rates by type';
        const lowest = Math.min(...scheduled.map((rate) => rate.value));
        const uniqueValues = new Set(scheduled.map((rate) => rate.value));
        const amount = lowest.toLocaleString('en-PH', { maximumFractionDigits: 2 });
        return uniqueValues.size > 1 ? `From ₱${amount}${rateUnit}` : `₱${amount}${rateUnit}`;
    }

    window.InigoCourtsData = {
        getCourts,
        invalidateCourts,
        getSports,
        isSportsFallback,
        monogramFor,
        slugify,
        resolveCourtUnits,
        rateHint,
    };
})();
