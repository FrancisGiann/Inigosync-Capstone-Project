// IñigoSync — Courts & Facilities fallback inventory
// This is now a FALLBACK ONLY: the landing page's Courts & Facilities grid
// (includes/landingPage.js) reads from Supabase's `court` table first, and
// only falls back to this static array if that fetch fails or comes back
// empty — so the section never renders blank when the database is
// unreachable. Keep this array's shape in sync with the `court` table
// (database/schema/002_content_tables.sql) if either one changes.
//
// image_url is intentionally null for every entry: there are no court
// photos yet (see database/schema/002_content_tables.sql's note on
// image_url). The old `../assets/courts/<name>.jpg` paths this file used to
// have were dead — that directory never existed, so every one of those was
// a 404 — and have been removed rather than replaced.

const COURTS_INVENTORY = [
    {
        id: 'basketball',
        name: 'Basketball',
        quantity: 2,
        unit: 'courts',
        description: 'Full court · Indoor · Scoreboard',
        rate: '—',
        rateUnit: '/hr',
        status: 'Available',
        image_url: null
    },
    {
        id: 'badminton',
        name: 'Badminton',
        quantity: 9,
        unit: 'courts',
        description: 'Indoor · Rackets for rent',
        rate: '—',
        rateUnit: '/hr',
        status: 'Available',
        image_url: null
    },
    {
        id: 'lawn-tennis',
        name: 'Lawn Tennis',
        quantity: 3,
        unit: 'courts',
        description: 'Outdoor · Professional grade',
        rate: '—',
        rateUnit: '/hr',
        status: 'Available',
        image_url: null
    },
    {
        id: 'pickleball',
        name: 'Pickleball',
        quantity: 10,
        unit: 'courts',
        description: 'Shared across Basketball, Volleyball & Lawn Tennis',
        rate: '—',
        rateUnit: '/hr',
        status: 'Available',
        image_url: null
    },
    {
        id: 'bowling-duckpin',
        name: 'Bowling — Duckpin',
        quantity: 8,
        unit: 'lanes',
        description: 'Duckpin bowling · Shoes included',
        rate: '—',
        rateUnit: '/set',
        status: 'Available',
        image_url: null,
        note: '// Bowling is scheduled in one-hour slots; live inventory uses /set pricing.'
    },
    {
        id: 'bowling-tenpin',
        name: 'Bowling — Ten-Pin',
        quantity: 12,
        unit: 'lanes',
        description: 'Ten-pin bowling · Shoes included',
        rate: '—',
        rateUnit: '/set',
        status: 'Available',
        image_url: null,
        note: '// Bowling is scheduled in one-hour slots; live inventory uses /set pricing.'
    },
    {
        id: 'billiards',
        name: 'Billiards',
        quantity: 2,
        unit: 'tables',
        description: 'Professional pool tables · Cue service available',
        rate: '—',
        rateUnit: '/hr',
        status: 'Available',
        image_url: null
    },
    {
        id: 'table-tennis',
        name: 'Table Tennis',
        quantity: 2,
        unit: 'tables',
        description: 'Tournament-grade tables · Paddles for rent',
        rate: '—',
        rateUnit: '/hr',
        status: 'Available',
        image_url: null
    },
    {
        id: 'volleyball',
        name: 'Volleyball',
        quantity: 1,
        unit: 'court',
        description: 'Full court · Indoor · Net included',
        rate: '—',
        rateUnit: '/hr',
        status: 'Available',
        image_url: null
    }
];

// Published prices come from verified unit inventory, never from this fallback
// array. Pickleball's verified capacity is 10; its old/new unit prices remain
// intentionally blank until the owner assigns those tiers.

console.log('[IñigoSync] courts-data.js loaded — static fallback, used only if the Supabase `court` fetch fails or is empty.');
