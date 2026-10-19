// Independent owner portal browser checks. The Supabase client is fully mocked.
// Run with `node scripts/preview.cjs` on port 4178 and PLAYWRIGHT_MODULE set.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const slides = [
    { id: '00000000-0000-4000-8000-000000000001', title: 'A very long featured tournament title that would otherwise push the card actions down and make its neighbors uneven', meta: 'First', tag: 'Event', image_url: null, display_order: 1, is_published: true, created_at: '2026-09-01T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000002', title: 'Second slide', meta: 'Second', tag: null, image_url: null, display_order: 2, is_published: true, created_at: '2026-09-02T00:00:00Z' },
];
const reviews = [
    { id: 'r1', display_name: 'Alex', rating: 5, comment: 'Great', created_at: '2026-09-01T00:00:00Z' },
    { id: 'r2', display_name: 'Bo', rating: 3, comment: 'Okay', created_at: '2026-09-02T00:00:00Z' },
];
const activities = [{ id: 'activity-1', owner_id: 'qa-owner', title: 'Sport updated', detail: 'Basketball Court 1 rates changed', target_section: 'courts', created_at: '2026-09-01T00:00:00Z', seen_at: null }];
function fixture() {
    const staffAudit = Array.from({ length: 12 }, (_, index) => ({
        id: `audit-${index + 1}`, created_at: `2026-09-${String(26 - index).padStart(2, '0')}T10:00:00Z`,
        action: index === 0 ? 'walkin_recorded' : index % 2 ? 'booking_timed_in' : 'payment_collected',
        entity_type: index === 0 ? 'walk_in_booking' : 'booking', entity_id: `record-${index + 1}`,
        details: { customerName: index === 0 ? 'Walk-in Customer' : `Customer ${index + 1}`, courtName: `Court ${index + 1}`, amount: 500, paymentMethod: index % 2 ? 'Card' : 'Cash' },
    }));
    const auditEvents = Array.from({ length: 32 }, (_, index) => ({
        event_id: index === 0 ? `audit-01-${'x'.repeat(42)}` : `audit-${String(index + 1).padStart(2, '0')}`, source: 'audit_log',
        created_at: `2026-09-${String(26 - Math.floor(index / 2)).padStart(2, '0')}T10:00:00Z`,
        action: index === 0 ? 'recorded_walk_in' : index % 2 ? 'checked_in' : 'collected_payment',
        category: index % 2 ? 'booking' : 'payment', actor_id: 'qa-staff', actor_name: 'QA Staff', actor_role: 'staff',
        target_type: index % 2 ? 'walkin' : 'booking', target_id: `record-${String(index + 1).padStart(2, '0')}`,
        amount: index % 2 ? null : 500, summary: index === 0 ? 'Walk-in customer · Court 1 — extended audit context for checking that long event summaries remain on one line and expose their complete value in the title tooltip.' : `Court ${index + 1} · customer booking`,
    }));
    auditEvents.push({ event_id: 'owner-event-1', source: 'owner_activity', created_at: '2026-09-01T10:00:00Z', action: 'Owner profile updated', category: 'owner', actor_id: 'qa-owner', actor_name: 'QA Owner', actor_role: 'admin', target_type: 'settings', target_id: null, amount: null, summary: 'The owner updated their account settings.' });
    auditEvents.push({ event_id: 'session-event-1', source: 'customer_operational_events', created_at: '2026-09-02T10:00:00Z', action: 'sign_out', category: 'account', actor_id: 'qa-staff', actor_name: 'QA Staff', actor_role: 'staff', target_type: 'account_session', target_id: null, amount: null, summary: 'App sign-out observed' });
    const ownerRules = { timezone: 'Asia/Manila', rules: [{ effective_from: '2026-01-01', grace_minutes: 30, weekly_hours: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, opens_at: '08:00:00', closes_at: '22:00:00', is_closed: false })) }] };
    const state = window.__ownerQa = { calls: [], ownerActivityOrQueries: [], failReorder: false, failSeen: false, phoneInUse: false };
    const data = {
        event: [
            { id: '00000000-0000-4000-8000-000000000001', title: 'A very long featured tournament title that would otherwise push the card actions down and make its neighbors uneven', meta: 'First', tag: 'Event', image_url: null, display_order: 1, is_published: true, created_at: '2026-09-01T00:00:00Z' },
            { id: '00000000-0000-4000-8000-000000000002', title: 'Second slide', meta: 'Second', tag: null, image_url: null, display_order: 2, is_published: true, created_at: '2026-09-02T00:00:00Z' },
        ],
        public_booking_reviews: [
            { id: 'r1', display_name: 'Alex', rating: 5, comment: 'Great', created_at: '2026-09-01T00:00:00Z' },
            { id: 'r2', display_name: 'Bo', rating: 3, comment: 'Okay', created_at: '2026-09-02T00:00:00Z' },
        ],
        owner_activity: [{ id: 'activity-1', owner_id: 'qa-owner', title: 'Sport updated', detail: 'Basketball Court 1 rates changed', target_section: 'courts', created_at: '2026-09-01T00:00:00Z', seen_at: null }],
        profiles: [
            { id: 'qa-owner', role: 'admin', full_name: 'QA Owner', email: 'owner@example.test', position: 'Owner', status: 'active', created_at: '2025-01-01T00:00:00Z' },
            { id: 'qa-staff', role: 'staff', full_name: 'QA Staff', email: 'staff@example.test', position: 'Court Attendant', status: 'active', birthdate: '2000-09-26', contact_num: '+639171234567', address: '12 Example Street, Cebu City', gender: 'Prefer not to say', emergency_contact_name: 'QA Contact', emergency_contact_number: '09171234568', created_at: '2026-01-01T00:00:00Z' },
            { id: 'qa-customer', role: 'customer', full_name: 'QA Customer', email: 'customer@example.test', status: 'active', created_at: '2026-02-01T00:00:00Z' },
        ],
        app_settings: [{ id: true, downpayment_pct: 50, cash_enabled: true, card_enabled: false, gcash_enabled: true }],
        court: Array.from({ length: 24 }, (_, index) => ({ id: `court-${index + 1}`, sport_id: `sport-${index + 1}`, slug: `sport-${index + 1}`, name: index === 0 ? 'A long court listing title that must wrap without shifting other actions' : `Sport ${index + 1}`, quantity: index + 1, unit: 'courts', description: 'Responsive fixture', image_url: null, is_active: index !== 23, display_order: index + 1, sport: { id: `sport-${index + 1}`, name: `Sport ${index + 1}`, slug: `sport-${index + 1}` } })),
    };
    if (window.__qaSavedCover) {
        data.court.push({ id: '00000000-0000-4000-8000-000000000099', sport_id: '00000000-0000-4000-8000-000000000098', slug: 'qa-covered-sport', name: 'QA Covered Sport', quantity: 1, unit: 'courts', description: null, image_url: window.__qaSavedCover, is_active: true, display_order: 99, sport: { id: '00000000-0000-4000-8000-000000000098', name: 'QA Covered Sport', slug: 'qa-covered-sport' } });
        data.court_unit_inventory = [{ id: '00000000-0000-4000-8000-000000000097', court_id: '00000000-0000-4000-8000-000000000099', label: 'Court 1', photo_url: window.__qaSavedUnitPhoto, rate_day: null, rate_night: null, rate_unit: '/hr', is_active: true, inventory_verified: true }];
    }
    state.tables = data;
    const result = (table, q) => {
        let rows = (data[table] || []).slice();
        if (q.filters) rows = rows.filter(row => Object.entries(q.filters).every(([key, value]) => row[key] == value));
        if (q.inFilters) rows = rows.filter(row => Object.entries(q.inFilters).every(([key, values]) => values.includes(row[key])));
        if (q.ilike) rows = rows.filter(row => String(row[q.ilike.key] || '').toLowerCase().includes(q.ilike.value.replace(/^%|%$/g, '').toLowerCase()));
        if (q.or) {
            if (table === 'owner_activity') state.ownerActivityOrQueries.push(q.or);
            const terms = [...q.or.matchAll(/(title|detail)\.ilike\."%((?:\\.|[^"\\])*)%"/g)]
                .map(([, key, value]) => ({ key, value: value.replace(/\\(.)/g, '$1').toLowerCase() }));
            if (terms.length) rows = rows.filter(row => terms.some(({ key, value }) => String(row[key] || '').toLowerCase().includes(value)));
        }
        if (q.sort?.length) rows.sort((a, b) => { for (const { key, ascending } of q.sort) { const n = String(a[key] ?? '').localeCompare(String(b[key] ?? '')); if (n) return ascending ? n : -n; } return 0; });
        const count = rows.length;
        if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
        if (q.limit) rows = rows.slice(0, q.limit);
        if (q.write) {
            state.calls.push({ table, write: q.write, payload: q.payload, filters: q.filters, inFilters: q.inFilters });
            if (table === 'owner_activity' && q.write === 'update' && state.failSeen) return { data: null, error: { message: 'Simulated seen update failure' }, count: 0 };
            if (q.write === 'insert') {
                const row = { ...(Array.isArray(q.payload) ? q.payload[0] : q.payload), id: `00000000-0000-4000-8000-${String((data[table] || []).length + 3).padStart(12, '0')}` };
                (data[table] ||= []).push(row); rows = [row];
            } else if (q.write === 'update') {
                rows.forEach(row => Object.assign(row, q.payload));
            } else if (q.write === 'delete') {
                data[table] = (data[table] || []).filter(row => !rows.includes(row));
            }
            return { data: q.one ? rows[0] || null : rows, error: null, count: rows.length };
        }
        return { data: q.head ? null : q.one ? rows[0] || null : rows, count, error: null };
    };
    window.sb = {
        from(table) {
            const q = { filters: {}, sort: [] };
            const chain = {
                select(_columns, options) { q.head = !!options?.head; q.countRequested = options?.count; return chain; },
                eq(key, value) { q.filters[key] = value; return chain; },
                is(key, value) { q.filters[key] = value; return chain; },
                in(key, values) { q.inFilters ||= {}; q.inFilters[key] = values; return chain; }, ilike(key, value) { q.ilike = { key, value }; return chain; }, gte() { return chain; }, gt() { return chain; }, lte() { return chain; }, lt() { return chain; }, or(value) { q.or = value; return chain; },
                order(key, options = {}) { q.sort.push({ key, ascending: options.ascending !== false }); return chain; },
                range(from, to) { q.range = [from, to]; return chain; }, limit(n) { q.limit = n; return chain; },
                abortSignal() { return chain; },
                insert(payload) { q.write = 'insert'; q.payload = payload; return chain; },
                update(payload) { q.write = 'update'; q.payload = payload; return chain; },
                delete() { q.write = 'delete'; return chain; },
                upsert(payload) { q.write = 'upsert'; q.payload = payload; return chain; },
                single() { q.one = true; return Promise.resolve(result(table, q)); },
                maybeSingle() { q.one = true; return Promise.resolve(result(table, q)); },
                then(resolve, reject) { return Promise.resolve(result(table, q)).then(resolve, reject); },
            };
            return chain;
        },
        rpc: async (name, args) => {
            state.calls.push({ rpc: name, args });
            if (name === 'admin_get_sport_editor') return { data: { version: state.savedSport && args?.p_court_id === state.savedCourtId ? 1 : 0, listing: state.savedSport && args?.p_court_id === state.savedCourtId ? { ...state.savedSport, id: state.savedCourtId } : null, units: state.savedSport && args?.p_court_id === state.savedCourtId ? state.savedSport.units : [], resources: Array.from({ length: 8 }, (_, index) => ({ id: `resource-${index + 1}`, name: `Shared Space ${index + 1}`, sport_names: ['Basketball'] })), cutoff: '18:00:00' }, error: null };
            if (name === 'admin_is_media_url_referenced') return { data: false, error: null };
            if (name === 'admin_save_sport') {
                if (!state.succeedSportSave) return { data: null, error: { message: 'Simulated stale-save failure' } };
                const saved = args.p_payload;
                const courtId = saved.court_id || '00000000-0000-4000-8000-000000000099';
                state.savedCourtId = courtId;
                state.savedSport = { ...saved, units: saved.units.map((unit, index) => ({ ...unit, id: unit.id || `00000000-0000-4000-8000-${String(97 + index).padStart(12, '0')}` })) };
                const row = { id: courtId, sport_id: '00000000-0000-4000-8000-000000000098', slug: saved.slug, name: saved.name, quantity: saved.units.length, unit: saved.unit, description: saved.description, image_url: saved.image_url, is_active: true, display_order: 99, sport: { id: '00000000-0000-4000-8000-000000000098', name: saved.name, slug: saved.slug } };
                data.court = [...data.court.filter(court => court.id !== courtId), row];
                return { data: { court_id: courtId, version: 1 }, error: null };
            }
            if (name === 'admin_reorder_slides') return state.failReorder ? { data: null, error: { message: 'Simulated reorder failure' } } : { data: args.p_ids, error: null };
            if (name === 'owner_review_summary') return { data: { average_rating: 4, total_count: 2, star_counts: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 } }, error: null };
            if (name === 'owner_staff_activity') {
                let rows = staffAudit.filter(row => row.actor_id === args.p_staff_id || args.p_staff_id === 'qa-staff');
                const query = String(args.p_search || '').toLocaleLowerCase();
                if (query) rows = rows.filter(row => JSON.stringify(row).toLocaleLowerCase().includes(query));
                const total_count = rows.length;
                return { data: { rows: rows.slice(args.p_offset, args.p_offset + args.p_limit), total_count }, error: null };
            }
            if (name === 'owner_audit_trail') {
                let rows = auditEvents.slice();
                if (args.p_search) rows = rows.filter(row => JSON.stringify(row).toLocaleLowerCase().includes(String(args.p_search).toLocaleLowerCase()));
                if (args.p_category && args.p_category !== 'all') rows = rows.filter(row => row.category === args.p_category);
                if (args.p_actor_id) rows = rows.filter(row => row.actor_id === args.p_actor_id);
                if (args.p_actor_role && args.p_actor_role !== 'all') rows = rows.filter(row => row.actor_role === args.p_actor_role);
                if (args.p_from) rows = rows.filter(row => new Date(row.created_at) >= new Date(args.p_from));
                if (args.p_to) rows = rows.filter(row => new Date(row.created_at) < new Date(args.p_to));
                return { data: {
                    rows: rows.slice(args.p_offset, args.p_offset + args.p_limit), total_count: rows.length,
                    actors: [{ id: 'qa-owner', name: 'QA Owner', role: 'admin' }, { id: 'qa-staff', name: 'QA Staff', role: 'staff' }],
                }, error: null };
            }
            if (name === 'owner_get_booking_rules') return { data: ownerRules, error: null };
            if (name === 'owner_save_booking_rules') {
                state.savedBookingRules = args;
                ownerRules.rules = [...ownerRules.rules, { effective_from: args.p_effective_from, grace_minutes: args.p_grace_minutes, weekly_hours: args.p_weekly_hours }];
                return { data: null, error: null };
            }
            if (name === 'owner_income_period') return { data: [{ income: { day: 100, month: 200, year: 300 }[args.p_period] }], error: null };
            if (name === 'admin_booking_overview') return { data: [
                { status: 'pending', amount_paid: 0 }, { status: 'confirmed', amount_paid: 0 },
                { status: 'confirmed', amount_paid: 250, time_date: new Date().toISOString() },
                { status: 'completed', amount_paid: 500, time_date: new Date().toISOString() },
                { status: 'no_show', amount_paid: 0, time_date: new Date().toISOString() },
            ], error: null };
            if (name === 'court_occupancy') return { data: [], error: null };
            if (name === 'admin_get_sport_editor') return { data: { version: 0, listing: null, units: [], resources: [], cutoff: '18:00:00' }, error: null };
            return { data: [], error: null };
        },
        storage: { from: () => ({ list: async () => ({ data: [], error: null }), upload: async (path, file) => { state.calls.push({ upload: path, type: file.type, size: file.size }); return { data: { path }, error: null }; }, remove: async paths => { state.calls.push({ remove: paths }); return { error: null }; }, getPublicUrl: path => ({ data: { publicUrl: `https://example.test/storage/v1/object/public/media/${path}` } }) }) },
        functions: { invoke: async (name, options) => {
            if (name === 'payment-health') return { data: { api_connected: true, webhook_configured: true, last_confirmed_payment_at: '2026-09-26T10:00:00Z' }, error: null };
            if (name === 'validate-contact-phone') {
                state.calls.push({ function: name, options });
                if (state.phoneInUse) return { data: { valid: false, reason: 'in_use' }, error: null };
                return { data: { valid: true, normalized: '+639171234567', available: true }, error: null };
            }
            return { data: null, error: { message: 'Unknown function' } };
        } },
        auth: {
            getSession: async () => ({ data: { session: { access_token: 'qa-token', user: { id: 'qa-owner', email: 'owner@example.test' } } } }),
            getUser: async () => ({ data: { user: { id: 'qa-owner', email: 'owner@example.test', identities: [] } } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({}),
        },
    };
    window.SUPABASE_URL = 'https://example.test';
}

async function verifyOwnerScheduleFlow(page, width) {
    await page.locator('[data-admin-nav="booking-rules"]').evaluate(el => el.click());
    await page.locator('[data-owner-rules-edit]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-owner-rules-saved-effective]').innerText(), '2026-01-01', 'current effective date is shown');
    assert.equal(await page.locator('[data-owner-rules-saved-grace]').innerText(), '30 minutes', 'current grace period is shown');
    assert.match(await page.locator('[data-owner-rules-saved-week]').innerText(), /Monday\s+08:00–22:00/, 'current weekly hours are shown');
    const buttonPlacement = await page.locator('[data-owner-rules-edit]').evaluate(button => {
        const buttonBox = button.getBoundingClientRect();
        const cardBox = button.closest('.owner-booking-rules-card').getBoundingClientRect();
        return { right: cardBox.right - buttonBox.right, bottom: cardBox.bottom - buttonBox.bottom };
    });
    assert.ok(buttonPlacement.right >= 0 && buttonPlacement.right < 32, `${width}px Edit button is at the card's lower-right`);
    assert.ok(buttonPlacement.bottom >= 0 && buttonPlacement.bottom < 32, `${width}px Edit button is near the card bottom`);

    const date = await page.evaluate(() => {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
        const day = new Date(`${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() + 7);
        return day.toISOString().slice(0, 10);
    });
    await page.locator('[data-owner-rules-edit]').click();
    assert.equal(await page.locator('[data-owner-rules-modal]').isVisible(), true, 'Edit opens the schedule dialog');
    assert.equal(await page.locator('[data-owner-rules-dialog]').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('[data-owner-rules-effective]').isDisabled(), false, 'date is editable in dialog');
    assert.equal(await page.locator('[data-owner-rules-open]').first().isDisabled(), false, 'weekly hours are editable in dialog');
    await page.locator('[data-owner-rules-effective]').fill(date);
    await page.locator('[data-owner-rules-grace]').fill('40');
    await page.locator('[data-owner-rules-cancel]').click();
    assert.equal(await page.locator('[data-owner-rules-modal]').isVisible(), false, 'Cancel closes the dialog');
    assert.equal(await page.locator('[data-owner-rules-effective]').inputValue(), await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())), 'Cancel reloads the saved editor fields');
    assert.equal(await page.locator('[data-owner-rules-upcoming]').isVisible(), false, 'Cancel does not expose its draft as scheduled');

    await page.locator('[data-owner-rules-edit]').click();
    await page.locator('[data-owner-rules-effective]').fill(date);
    await page.locator('[data-owner-rules-grace]').fill('45');
    for (let weekday = 1; weekday <= 7; weekday += 1) {
        const row = page.locator(`[data-owner-rules-day="${weekday}"]`);
        await row.locator('[data-owner-rules-open]').fill(`${String(weekday + 8).padStart(2, '0')}:00`);
        await row.locator('[data-owner-rules-close]').fill('22:00');
    }
    await page.locator('[data-owner-rules-save]').click();
    await page.locator('.owner-confirm-overlay [data-confirm-yes]').click();
    await page.waitForFunction(() => Boolean(window.__ownerQa.savedBookingRules));
    assert.equal(await page.locator('[data-owner-rules-modal]').isVisible(), false, 'successful save closes the dialog');
    assert.equal(await page.locator('[data-owner-rules-saved-effective]').innerText(), '2026-01-01', 'current effective schedule remains visible');
    assert.equal(await page.locator('[data-owner-rules-upcoming]').isVisible(), true, 'saved future schedule appears in the summary');
    assert.equal(await page.locator('[data-owner-rules-upcoming-effective]').innerText(), date);
    assert.equal(await page.locator('[data-owner-rules-upcoming-grace]').innerText(), '45');
    assert.match(await page.locator('[data-owner-rules-upcoming-week]').innerText(), /Monday\s+09:00–22:00/);
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const failures = [];
    try {
        for (const width of process.env.OWNER_QA_STAFF_ONLY === '1' ? [360, 1440] : process.env.OWNER_QA_QUICK === '1' ? [360] : [360, 390, 768, 1024, 1440]) {
            for (const theme of process.env.OWNER_QA_QUICK === '1' ? ['light'] : ['light', 'dark']) {
                const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Manila', reducedMotion: 'reduce' });
                const page = await context.newPage();
                page.setDefaultTimeout(5000);
                page.setDefaultNavigationTimeout(10000);
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.addInitScript(theme => localStorage.setItem('inigosync-theme', theme), theme);
                await page.route(/^https:\/\//, route => route.abort());
                await page.route('**/chart.umd.min.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.Chart=class{static defaults={font:{},color:''};constructor(_canvas,config){this.data=config.data;this.options=config.options;}update(){}};` }));
                await page.route('**/Config/supabaseClient.js', route => route.fulfill({ contentType: 'application/javascript', body: `(${fixture})();` }));
                await page.route('**/functions/v1/invite-staff', async route => {
                    const request = route.request();
                    await page.evaluate(({ url, body }) => window.__ownerQa.calls.push({ request: 'invite-staff', url, body: JSON.parse(body) }), {
                        url: request.url(), body: request.postData(),
                    });
                    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
                });
                await page.route('**/includes/authGuard.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.inigosyncProfile={id:'qa-owner',role:'admin',status:'active',full_name:'QA Owner',email:'owner@example.test'};document.addEventListener('DOMContentLoaded',()=>{window.InigoLoading?.hide();document.documentElement.classList.remove('inigo-auth-pending');document.dispatchEvent(new CustomEvent('inigosync:profile-ready',{detail:window.inigosyncProfile}));});` }));
                await page.route('**/includes/loadingOverlay.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.InigoLoading={show(){},hide(){}};window.InigoToast={show(){}};` }));
                await page.route('**/includes/courtsData.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.InigoCourtsData={getCourts:async()=>[],getSports:async()=>[],invalidateCourts(){},monogramFor:()=>'',slugify:s=>s,rateHint:()=>null};` }));
                await page.route('**/includes/courts-data.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
                await page.goto('http://127.0.0.1:4178/Pages/owner_dashboard.html', { waitUntil: 'domcontentloaded' });
                try {
                    if (process.env.OWNER_QA_STAFF_ONLY === '1') {
                        await page.locator('[data-admin-nav="staff"]').first().evaluate(el => el.click());
                        assert.equal(await page.locator('[data-admin-panel="staff"]').getByRole('heading', { name: 'All Staff Accounts' }).count(), 0);
                        const staffRow = page.locator('[data-admin-staff-table] tbody tr').filter({ hasText: 'QA Staff' });
                        await staffRow.waitFor();
                        const trigger = staffRow.locator('[data-admin-staff-actions-trigger]');
                        const alignment = await trigger.evaluate(button => {
                            const buttonBox = button.getBoundingClientRect();
                            const wrapBox = button.parentElement.getBoundingClientRect();
                            return Math.abs((buttonBox.left + buttonBox.right) / 2 - (wrapBox.left + wrapBox.right) / 2);
                        });
                        assert.ok(alignment <= 1, `${width}px staff Actions button is centered in its column`);
                        await trigger.click();
                        const commands = await page.locator('[data-admin-staff-action-card] [data-admin-staff-command]').evaluateAll(items => items.map(item => item.dataset.adminStaffCommand));
                        assert.deepEqual(commands, ['view', 'edit', 'toggle'], 'staff menu contains only the remaining actions');
                        assert.equal(await page.locator('[data-admin-panel="staff"]').getByText('Reset Password emails').count(), 0);

                        // Position changes stay in the editable modal after Cancel and write only after confirmation.
                        await page.locator('[data-admin-staff-command="edit"]').click();
                        await page.locator('[data-admin-staff-edit-position]').selectOption({ label: 'Secretary' });
                        await page.locator('[data-admin-staff-edit-submit]').click();
                        await page.locator('.owner-confirm-overlay').waitFor({ state: 'visible' });
                        assert.match(await page.locator('.owner-confirm-overlay').innerText(), /Change QA Staff's position to Secretary/);
                        const positionWritesBeforeCancel = await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'profiles' && call.write === 'update' && call.payload.position).length);
                        await page.locator('.owner-confirm-overlay [data-confirm-no]').click();
                        assert.equal(await page.locator('[data-admin-staff-edit-modal]').isVisible(), true, 'cancelling position confirmation keeps the edit context open');
                        assert.equal(await page.locator('[data-admin-staff-edit-position]').inputValue(), 'Secretary', 'cancel preserves the selected position');
                        assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'profiles' && call.write === 'update' && call.payload.position).length), positionWritesBeforeCancel, 'cancel does not update the profile');
                        await page.locator('[data-admin-staff-edit-submit]').click();
                        await page.locator('.owner-confirm-overlay [data-confirm-yes]').click();
                        await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'profiles' && call.write === 'update' && call.payload.position === 'Secretary'));
                        await page.locator('[data-admin-staff-edit-modal]').waitFor({ state: 'hidden' });

                        // Staff creation likewise keeps the filled form open on Cancel and sends no invite.
                        await page.locator('[data-admin-staff-add]').first().click();
                        await page.locator('[data-admin-staff-email]').fill('new-staff@example.test');
                        await page.locator('[data-admin-staff-role]').selectOption({ label: 'Secretary' });
                        await page.locator('[data-admin-staff-submit]').click();
                        await page.locator('.owner-confirm-overlay').waitFor({ state: 'visible' });
                        assert.match(await page.locator('.owner-confirm-overlay').innerText(), /Invite new-staff@example\.test as Secretary/);
                        assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.request === 'invite-staff').length), 0, 'invite request waits for confirmation');
                        await page.locator('.owner-confirm-overlay [data-confirm-no]').click();
                        assert.equal(await page.locator('[data-admin-staff-modal]').isVisible(), true, 'cancelling invite confirmation keeps the form open');
                        assert.equal(await page.locator('[data-admin-staff-email]').inputValue(), 'new-staff@example.test', 'cancel preserves the email');
                        assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.request === 'invite-staff').length), 0, 'cancel sends no invite');
                        await page.locator('[data-admin-staff-submit]').click();
                        await page.locator('.owner-confirm-overlay [data-confirm-yes]').click();
                        await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.request === 'invite-staff'));
                        const invite = await page.evaluate(() => window.__ownerQa.calls.find(call => call.request === 'invite-staff'));
                        assert.deepEqual(invite.body, { email: 'new-staff@example.test', position: 'Secretary' }, 'accepted confirmation sends the intended invite');
                        console.log(`PASS staff Actions ${width}px ${theme}`);
                        continue;
                    }
                    if (process.env.OWNER_QA_SCHEDULE_ONLY === '1') {
                        await verifyOwnerScheduleFlow(page, width);
                        assert.deepEqual(errors, [], `${width}px schedule flow has no uncaught page errors`);
                        console.log(`PASS owner schedule ${width}px ${theme}`);
                        continue;
                    }
                    if (process.env.OWNER_QA_COURTS_ONLY !== '1') {
                    assert.equal(await page.locator('[data-admin-slides] [data-media-card]').count(), 2);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme} horizontal overflow on overview`);
                    await page.locator('[data-admin-stat="customer-accounts"]').getByText('1').waitFor();
                    await page.locator('[data-owner-income-total]').getByText(/200\.00/).waitFor();
                    await page.locator('[data-owner-income-range="day"]').click();
                    await page.locator('[data-owner-income-total]').getByText(/100\.00/).waitFor();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.rpc === 'owner_income_period' && call.args.p_period === 'day'));
                    assert.equal(await page.locator('[data-owner-income-range="day"]').getAttribute('class'), 'admin-pill-btn is-active');
                    await page.locator('[data-owner-income-range="year"]').click();
                    await page.locator('[data-owner-income-total]').getByText(/300\.00/).waitFor();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.rpc === 'owner_income_period' && call.args.p_period === 'year'));
                    assert.equal(await page.locator('[data-owner-income-range="year"]').getAttribute('class'), 'admin-pill-btn is-active');
                    await page.locator('[data-owner-income-range="month"]').click();
                    await page.locator('[data-owner-income-total]').getByText(/200\.00/).waitFor();
                    const statusReport = page.locator('[data-admin-status-breakdown]');
                    await statusReport.locator('.admin-status-total strong').getByText('3', { exact: true }).waitFor();
                    assert.equal(await statusReport.locator('.admin-status-count').count(), 3);
                    for (const [key, label] of [['booked', 'Booked'], ['completed', 'Completed'], ['no-show', 'No-show']]) {
                        const count = statusReport.locator(`.admin-status-count-${key}`);
                        assert.equal(await count.locator('.admin-status-count-label').innerText(), label);
                        assert.equal(await count.locator('strong').innerText(), '1');
                    }
                    assert.match(await statusReport.locator('.admin-status-takeaway').innerText(), /Even split across the top statuses/);
                    assert.match(await statusReport.locator('.admin-status-pie').getAttribute('aria-label'), /Booked 1, Completed 1, No-show 1/);
                    assert.doesNotMatch(await statusReport.innerText(), /Awaiting payment/i);
                    assert.equal(await page.locator('[data-admin-chart-range]').count(), 3);
                    assert.equal(await page.locator('[data-admin-status-range]').count(), 0);
                    assert.equal(await page.locator('[data-admin-panel="overview"] .admin-booking-toolbar').count(), 1);
                    assert.equal(await page.locator('[data-admin-panel="overview"] .admin-booking-report-grid > .admin-card').count(), 2);
                    assert.equal(await page.locator('[data-admin-chart-export-wrap]').count(), 1);
                    assert.equal(await page.locator('[data-admin-chart-export-toggle]').isDisabled(), false);
                    const exportToggle = page.locator('[data-admin-chart-export-toggle]');
                    const exportMenu = page.locator('[data-admin-chart-export-menu]');
                    assert.equal(await page.locator('[data-admin-chart-export-wrap] [data-admin-chart-export-status]').count(), 1);
                    await exportToggle.click();
                    assert.equal(await exportToggle.getAttribute('aria-expanded'), 'true');
                    assert.equal(await exportMenu.isVisible(), true);
                    await page.keyboard.press('Escape');
                    assert.equal(await exportMenu.isVisible(), false);
                    assert.equal(await exportToggle.getAttribute('aria-expanded'), 'false');
                    await exportToggle.click();
                    await page.locator('[data-admin-panel="overview"] .admin-booking-report-card').first().click();
                    assert.equal(await exportMenu.isVisible(), false);
                    for (const range of ['month', 'year', 'week']) {
                        await page.locator(`[data-admin-chart-range="${range}"]`).click();
                        assert.equal(await page.locator(`[data-admin-chart-range="${range}"]`).getAttribute('class'), 'admin-pill-btn is-active');
                        assert.equal(await page.locator(`[data-admin-chart-range="${range}"]`).getAttribute('aria-pressed'), 'true');
                        assert.equal(await statusReport.locator('.admin-status-total strong').innerText(), '3');
                        assert.equal(await page.locator('[data-admin-chart-total]').innerText(), '3');
                    }
                    const pageSpeedRow = page.locator('[data-admin-perf-list] .admin-perf-item').filter({ hasText: 'Page speed' });
                    await pageSpeedRow.waitFor();
                    assert.match(await pageSpeedRow.innerText(), /Service response/);
                    assert.equal(await page.locator('[data-admin-perf-list] .admin-perf-item').count(), 3);
                    assert.doesNotMatch(await page.locator('[data-admin-perf-list]').innerText(), /Saved bookings and customers/i);
                    assert.match(await page.locator('[data-admin-perf-list]').innerText(), /Storage/i);
                    assert.doesNotMatch(await page.locator('[data-admin-perf-list]').innerText(), /015_media_bucket\.sql/i);

                    assert.equal(await page.locator('[data-admin-notif-trigger]').count(), 0, 'admin dashboard has no notification bell');
                    assert.equal(await page.locator('[data-admin-notif-menu]').count(), 0, 'admin dashboard has no notification menu');
                    assert.equal(await page.locator('[data-owner-notification-modal]').count(), 0, 'admin dashboard has no notification detail modal');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'owner_activity' && call.read).length), 0,
                        'admin dashboard does not load owner activity as notifications');
                    await page.locator('[data-admin-nav="announcement"]').evaluate(el => el.click());
                    assert.equal(await page.locator('[data-admin-panel="announcement"]').isVisible(), true);
                    assert.equal(await page.locator('[data-admin-title]').innerText(), 'Announcement');
                    await page.locator('[data-admin-nav="booking-rules"]').evaluate(el => el.click());
                    assert.equal(await page.locator('[data-admin-title]').innerText(), 'Working Time Schedule');
                    await page.locator('[data-owner-rules-edit]').waitFor({ state: 'visible' });
                    assert.equal(await page.locator('[data-owner-rules-saved-effective]').innerText(), '2026-01-01', 'main card shows the current effective date');
                    assert.equal(await page.locator('[data-owner-rules-saved-grace]').innerText(), '30 minutes', 'main card shows the current grace period');
                    assert.match(await page.locator('[data-owner-rules-saved-week]').innerText(), /Monday\s+08:00–22:00/, 'main card shows the saved weekly hours');
                    assert.equal(await page.locator('[data-owner-rules-upcoming]').isVisible(), false, 'upcoming summary is hidden when no future schedule exists');
                    assert.equal(await page.locator('[data-owner-rules-effective]').isDisabled(), true, 'effective date starts read-only');
                    assert.equal(await page.locator('[data-owner-rules-grace]').isDisabled(), true, 'grace period starts read-only');
                    assert.equal(await page.locator('[data-owner-rules-open]').first().isDisabled(), true, 'weekly hours start read-only');
                    const scheduleEditButton = page.locator('[data-owner-rules-edit]');
                    const scheduleButtonPlacement = await scheduleEditButton.evaluate(button => {
                        const buttonBox = button.getBoundingClientRect();
                        const cardBox = button.closest('.owner-booking-rules-card').getBoundingClientRect();
                        return { buttonRight: buttonBox.right, cardRight: cardBox.right, buttonBottom: buttonBox.bottom, cardBottom: cardBox.bottom };
                    });
                    assert.ok(scheduleButtonPlacement.cardRight - scheduleButtonPlacement.buttonRight < 32, `${width}px schedule edit button sits at card's lower right edge`);
                    assert.ok(scheduleButtonPlacement.cardBottom - scheduleButtonPlacement.buttonBottom < 32, `${width}px schedule edit button sits near card bottom`);
                    const futureScheduleDate = await page.evaluate(() => {
                        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
                        const date = new Date(`${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}T00:00:00Z`);
                        date.setUTCDate(date.getUTCDate() + 7);
                        return date.toISOString().slice(0, 10);
                    });
                    await scheduleEditButton.click();
                    assert.equal(await page.locator('[data-owner-rules-modal]').isVisible(), true, 'Edit opens schedule editor modal');
                    assert.equal(await page.locator('[data-owner-rules-dialog]').getAttribute('aria-modal'), 'true');
                    const scheduleFields = await page.locator('.owner-booking-rules-meta > .admin-form-group').evaluateAll(groups => groups.slice(0, 2).map(group => {
                        const input = group.querySelector('input');
                        const groupBox = group.getBoundingClientRect();
                        const inputBox = input.getBoundingClientRect();
                        return { top: groupBox.top, bottom: groupBox.bottom, inputTop: inputBox.top };
                    }));
                    if (width > 640) {
                        assert.ok(Math.abs(scheduleFields[0].inputTop - scheduleFields[1].inputTop) <= 2, `${width}px schedule field controls align horizontally`);
                    } else {
                        assert.ok(scheduleFields[0].bottom <= scheduleFields[1].top + 1, `${width}px schedule fields stack without overlap`);
                    }
                    assert.equal(await page.locator('[data-owner-rules-effective]').isDisabled(), false, 'Edit enables effective date');
                    assert.equal(await page.locator('[data-owner-rules-grace]').isDisabled(), false, 'Edit enables grace period');
                    assert.equal(await page.locator('[data-owner-rules-open]').first().isDisabled(), false, 'Edit enables weekly hours');
                    await page.locator('[data-owner-rules-effective]').fill(futureScheduleDate);
                    await page.locator('[data-owner-rules-grace]').fill('40');
                    assert.deepEqual(await page.locator('[data-owner-rules-open], [data-owner-rules-close]').evaluateAll(inputs => inputs.map(input => input.step)),
                        Array(14).fill('3600'), 'every weekday time input accepts whole-hour values only');
                    await page.locator('[data-owner-rules-day="1"] [data-owner-rules-open]').fill('09:30');
                    await page.locator('[data-owner-rules-save]').click();
                    assert.match(await page.locator('[data-owner-rules-message]').innerText(), /whole-hour.*:00/i, 'minute values are rejected before save');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.some(call => call.rpc === 'owner_save_booking_rules')), false, 'minute values never reach the save RPC');
                    await page.locator('[data-owner-rules-day="1"] [data-owner-rules-open]').fill('09:00');
                    await page.locator('[data-owner-rules-cancel]').click();
                    assert.equal(await page.locator('[data-owner-rules-modal]').isVisible(), false, 'Cancel closes schedule editor modal');
                    await page.waitForFunction(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_get_booking_rules').length >= 2);
                    assert.equal(await page.locator('[data-owner-rules-effective]').inputValue(), await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())), 'Cancel reloads and discards draft values');
                    assert.equal(await page.locator('[data-owner-rules-grace]').inputValue(), '30');
                    assert.equal(await page.locator('[data-owner-rules-saved-effective]').innerText(), '2026-01-01', 'Cancel leaves the main saved summary unchanged');
                    assert.equal(await page.locator('[data-owner-rules-upcoming]').isVisible(), false, 'Cancel does not expose draft values as a scheduled summary');
                    await page.locator('[data-owner-rules-edit]').click();
                    await page.locator('[data-owner-rules-effective]').fill(futureScheduleDate);
                    await page.locator('[data-owner-rules-grace]').fill('45');
                    for (let weekday = 1; weekday <= 7; weekday += 1) {
                        const dayRow = page.locator(`[data-owner-rules-day="${weekday}"]`);
                        await dayRow.locator('[data-owner-rules-open]').fill(`${String(weekday + 8).padStart(2, '0')}:00`);
                        await dayRow.locator('[data-owner-rules-close]').fill('22:00');
                    }
                    await page.evaluate(date => window.InigoBusinessHours.getForDate(date), futureScheduleDate);
                    const ruleReadCountBeforeSave = await page.evaluate(() => window.__ownerQa.calls.filter(call => call.rpc === 'booking_rules_for_date').length);
                    await page.locator('[data-owner-rules-save]').click();
                    const scheduleConfirm = page.locator('.owner-confirm-overlay');
                    await scheduleConfirm.waitFor({ state: 'visible' });
                    assert.ok((await scheduleConfirm.innerText()).includes(`45-minute no-show grace period from ${futureScheduleDate}`));
                    await page.keyboard.press('Escape');
                    await scheduleConfirm.waitFor({ state: 'detached' });
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.some(call => call.rpc === 'owner_save_booking_rules')), false, 'cancelled confirmation does not save');
                    await page.locator('[data-owner-rules-save]').click();
                    await page.locator('.owner-confirm-overlay [data-confirm-yes]').click();
                    await page.waitForFunction(() => Boolean(window.__ownerQa.savedBookingRules));
                    const savedSchedule = await page.evaluate(() => window.__ownerQa.savedBookingRules);
                    assert.equal(savedSchedule.p_effective_from, futureScheduleDate);
                    assert.equal(savedSchedule.p_grace_minutes, 45);
                    assert.equal(savedSchedule.p_weekly_hours.length, 7);
                    assert.deepEqual(savedSchedule.p_weekly_hours.map(day => [day.weekday, day.opens_at, day.closes_at]),
                        Array.from({ length: 7 }, (_, index) => [index + 1, `${String(index + 9).padStart(2, '0')}:00`, '22:00']),
                        'each weekday submits its own opening and closing hours');
                    await page.evaluate(date => window.InigoBusinessHours.getForDate(date), futureScheduleDate);
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.rpc === 'booking_rules_for_date').length),
                        ruleReadCountBeforeSave + 1, 'saving the schedule invalidates same-tab cached hours');
                    assert.equal(await page.locator('[data-owner-rules-save]').isVisible(), false, 'save returns to read-only mode');
                    assert.equal(await page.locator('[data-owner-rules-modal]').isVisible(), false, 'save closes schedule editor modal');
                    assert.equal(await page.locator('[data-owner-rules-saved-effective]').innerText(), '2026-01-01', 'main card continues to show the current effective schedule');
                    assert.equal(await page.locator('[data-owner-rules-upcoming]').isVisible(), true, 'main card shows a future-dated saved schedule');
                    assert.equal(await page.locator('[data-owner-rules-upcoming-effective]').innerText(), futureScheduleDate, 'scheduled summary refreshes its effective date');
                    assert.equal(await page.locator('[data-owner-rules-upcoming-grace]').innerText(), '45', 'scheduled summary refreshes its grace period');
                    assert.match(await page.locator('[data-owner-rules-upcoming-week]').innerText(), /Monday\s+09:00–22:00/, 'scheduled summary refreshes its weekly hours');

                    // Profile modal must be visible, focusable, close, and restore focus.
                    await page.locator('[data-admin-nav="settings"]').first().evaluate(el => el.click());
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
                        `${width}px Account Settings has no horizontal overflow`);
                    assert.equal(await page.locator('[data-admin-panel="settings"] .admin-panel-head').count(), 0,
                        'settings content has no duplicate panel heading or subtitle');
                    assert.equal(await page.locator('[data-admin-panel="settings"] > .admin-card').count(), 2,
                        'profile details and password each have their own settings card');
                    assert.equal(await page.locator('.owner-account-card .owner-photo-section [data-admin-avatar-upload-trigger]').count(), 1);
                    assert.equal(await page.locator('.owner-account-card .owner-profile-summary [data-admin-profile-full-name], .owner-account-card .owner-profile-summary [data-admin-profile-email], .owner-account-card .owner-profile-summary [data-admin-profile-mobile], .owner-account-card .owner-profile-summary [data-admin-profile-address], .owner-account-card .owner-profile-summary [data-admin-profile-birthdate], .owner-account-card .owner-profile-summary [data-admin-profile-gender]').count(), 6,
                        'the combined owner account card keeps all owner profile fields');
                    assert.equal(await page.locator('[data-admin-profile-edit]').evaluate(el => el.parentElement.lastElementChild === el), true,
                        'Edit stays at the lower edge of the personal information section');
                    assert.equal(await page.locator('[data-admin-profile-edit]').getAttribute('aria-controls'), 'adminProfileEditDialog');
                    await page.locator('[data-admin-profile-edit]').click();
                    assert.equal(await page.locator('[data-admin-settings-profile-modal]').getAttribute('data-open'), '');
                    assert.equal(await page.locator('[data-admin-settings-profile-modal]').isVisible(), true);
                    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-admin-settings-profile-modal]') !== null), true);
                    await page.keyboard.press('Escape');
                    await page.locator('[data-admin-settings-profile-modal]').waitFor({ state: 'hidden' });
                    assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-admin-profile-edit')), true);

                    // Owner avatar controls are inline; crop cancellation leaves the saved photo unchanged and a completed crop saves immediately.
                    assert.equal(await page.locator('[data-admin-avatar-edit]').count(), 0, 'profile photo has no Edit action');
                    assert.equal(await page.locator('[data-admin-avatar-modal]').count(), 0, 'profile photo editor modal is removed');
                    const chooseAvatarButton = page.locator('[data-admin-avatar-upload-trigger]');
                    assert.equal(await chooseAvatarButton.isVisible(), true, 'Choose Photo is visible');
                    assert.equal((await chooseAvatarButton.innerText()).trim(), 'Choose Photo');
                    assert.equal(await page.locator('[data-admin-avatar-remove]').isVisible(), false, 'Remove Photo is hidden without a saved avatar');
                    await page.evaluate(() => {
                        window.__avatarCropOptions = [];
                        window.InigoImageTools.openCropEditor = async (_file, options) => { window.__avatarCropOptions.push(options); return null; };
                    });
                    const avatarFile = { name: 'avatar.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('qa image') };
                    const canceledAvatarChooser = page.waitForEvent('filechooser');
                    await chooseAvatarButton.click();
                    await (await canceledAvatarChooser).setFiles(avatarFile);
                    await page.waitForFunction(() => window.__avatarCropOptions.length === 1);
                    assert.equal(await page.locator('.admin-avatar-upload-preview img').count(), 0, 'cancelled crop must leave the avatar unchanged');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'profiles' && call.write === 'update').length), 0);
                    await page.evaluate(() => { window.InigoImageTools.openCropEditor = async (_file, options) => { window.__avatarCropOptions.push(options); return new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }); }; });
                    const savedAvatarChooser = page.waitForEvent('filechooser');
                    await chooseAvatarButton.click();
                    await (await savedAvatarChooser).setFiles(avatarFile);
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'profiles' && call.write === 'update'));
                    assert.equal(await page.evaluate(() => window.__avatarCropOptions.at(-1).aspect), 1);
                    assert.equal(await page.locator('[data-admin-avatar-remove]').isVisible(), true, 'Remove Photo appears after an avatar is saved');
                    await page.locator('[data-admin-avatar-remove]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'profiles' && call.write === 'update' && call.payload.avatar_url === null));
                    assert.equal(await page.locator('[data-admin-avatar-remove]').isVisible(), false, 'Remove Photo hides after the avatar is removed');

                    // Owner mobile status is checked automatically after a complete PH number is entered, then saved explicitly.
                    await page.locator('[data-admin-profile-edit]').click();
                    const ownerMobile = page.locator('[data-admin-settings-mobile]');
                    await ownerMobile.fill('+63 917 123 4567');
                    await page.waitForFunction(() => document.querySelector('[data-admin-mobile-message]').textContent.includes('Save number to add'));
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.function === 'validate-contact-phone').length), 1, 'one complete number triggers one debounced database check');
                    assert.deepEqual(await page.evaluate(() => window.__ownerQa.calls.find(call => call.function === 'validate-contact-phone').options.body), { phone: '09171234567' }, 'international input is normalized before the database check');
                    assert.match(await page.locator('[data-admin-mobile-message]').innerText(), /format and available/);
                    assert.equal(await page.locator('[data-admin-mobile-validate]').isEnabled(), true);
                    await ownerMobile.fill('09171234567');
                    await page.waitForFunction(() => document.querySelector('[data-admin-mobile-message]').textContent.includes('Save number to add'));
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.function === 'validate-contact-phone').length), 1, 'same normalized value in another format reuses its recent check');
                    await page.locator('[data-admin-mobile-validate]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'profiles' && call.write === 'update' && call.payload.contact_num === '+639171234567'));
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.function === 'validate-contact-phone').length), 1, 'saving uses the completed check without a second lookup');
                    assert.match(await page.locator('[data-admin-mobile-message]').innerText(), /format and availability checks/);
                    await page.evaluate(() => window.__ownerQa.phoneInUse = true);
                    await ownerMobile.fill('09991234567');
                    await page.waitForFunction(() => document.querySelector('[data-admin-mobile-message]').textContent.includes('already in use by another account'));
                    assert.equal(await page.locator('[data-admin-mobile-validate]').isEnabled(), false, 'a number in use by another account cannot be saved');
                    await page.locator('[data-admin-settings-cancel="profile"]').last().click();
                    await page.locator('[data-admin-settings-profile-modal]').waitFor({ state: 'hidden' });

                    // Staff age and supported position choices.
                    await page.locator('[data-admin-nav="staff"]').first().evaluate(el => el.click());
                    await page.locator('[data-admin-staff-table] tbody tr').filter({ hasText: 'QA Staff' }).waitFor();
                    const staffTrigger = page.locator('[data-admin-staff-table] tbody tr').filter({ hasText: 'QA Staff' }).locator('[data-admin-staff-actions-trigger]');
                    await staffTrigger.focus();
                    await page.keyboard.press('Enter');
                    const staffCard = page.locator('[data-admin-staff-action-card]');
                    assert.equal(await staffCard.isVisible(), true, 'Enter opens the floating staff action card');
                    assert.equal(await staffCard.evaluate(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }), true, 'staff actions remain in the viewport');
                    assert.equal(await page.evaluate(() => document.activeElement?.dataset.adminStaffCommand), 'view');
                    await page.keyboard.press('Tab');
                    assert.equal(await page.evaluate(() => document.activeElement?.dataset.adminStaffCommand), 'edit');
                    await page.keyboard.press('Escape');
                    assert.equal(await staffCard.isVisible(), false);
                    assert.equal(await staffTrigger.evaluate(el => document.activeElement === el), true, 'Escape returns focus to Actions');
                    await staffTrigger.click();
                    await page.locator('[data-admin-panel="staff"] .admin-card-head').click();
                    assert.equal(await staffCard.isVisible(), false, 'outside click closes staff actions');
                    assert.equal(await staffCard.locator('[data-admin-staff-command="activity"]').count(), 0, 'staff Actions menu has no View activity command');
                    assert.equal(await staffCard.locator('[data-admin-staff-command="reset"]').count(), 0, 'staff Actions menu has no password reset command');

                    // Audit Trail aggregates activity with bounded search, filter and pagination.
                    await page.locator('[data-admin-nav="audit"]').evaluate(el => el.click());
                    await page.locator('[data-owner-audit-rows] tr').first().waitFor();
                    const auditLayout = await page.locator('.owner-audit-filters').evaluate(el => {
                        const groups = [...el.querySelectorAll('.admin-form-group')].map(group => {
                            const label = group.querySelector('.admin-form-label').getBoundingClientRect();
                            const control = group.querySelector('input, select').getBoundingClientRect();
                            const box = group.getBoundingClientRect();
                            return { row: Math.round(box.top), labelHeight: label.height, controlTop: control.top, controlWidth: control.width, groupWidth: box.width };
                        });
                        const rows = new Map();
                        for (const group of groups) (rows.get(group.row) || rows.set(group.row, []).get(group.row)).push(group);
                        return { groups, rows: [...rows.values()] };
                    });
                    assert.ok(auditLayout.groups.every(group => group.controlWidth <= group.groupWidth + 1), `${width}px audit controls fit their filter columns`);
                    assert.ok(auditLayout.groups.every(group => Math.abs(group.labelHeight - auditLayout.groups[0].labelHeight) <= 1), `${width}px audit filter labels reserve matching height`);
                    for (const row of auditLayout.rows) {
                        assert.ok(row.every(group => Math.abs(group.controlTop - row[0].controlTop) <= 1), `${width}px audit controls align within each filter row`);
                    }
                    const auditLongCells = await page.locator('[data-owner-audit-rows] tr').first().locator('td:nth-child(2), td:nth-child(9)').evaluateAll(cells => cells.map(cell => {
                        const value = cell.querySelector('.owner-audit-cell-value');
                        const style = getComputedStyle(value);
                        return { text: value.textContent, title: value.title, clipped: value.scrollWidth > value.clientWidth, whiteSpace: style.whiteSpace, overflow: style.overflow, textOverflow: style.textOverflow };
                    }));
                    assert.ok(auditLongCells.every(cell => cell.clipped && cell.whiteSpace === 'nowrap' && cell.overflow === 'hidden' && cell.textOverflow === 'ellipsis'), 'long audit identifiers and summaries stay one line and truncate cleanly');
                    assert.ok(auditLongCells.every(cell => cell.title === cell.text), 'truncated audit values expose their full text in the title tooltip');
                    assert.equal(await page.locator('[data-owner-audit-rows] tr').count(), 25);
                    assert.match(await page.locator('[data-owner-audit-page-info]').innerText(), /Page 1 of 2/);
                    await page.locator('[data-owner-audit-next]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_audit_trail').at(-1)?.args.p_offset === 25);
                    assert.match(await page.locator('[data-owner-audit-page-info]').innerText(), /Page 2 of 2/);
                    await page.locator('[data-owner-audit-actor]').selectOption('qa-staff');
                    await page.waitForFunction(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_audit_trail').at(-1)?.args.p_actor_id === 'qa-staff');
                    await page.locator('[data-owner-audit-role]').selectOption('staff');
                    await page.waitForFunction(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_audit_trail').at(-1)?.args.p_actor_role === 'staff');
                    await page.locator('[data-owner-audit-category]').selectOption('payment');
                    await page.waitForFunction(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_audit_trail').at(-1)?.args.p_category === 'payment');
                    await page.locator('[data-owner-audit-from]').fill('2026-09-10');
                    await page.locator('[data-owner-audit-to]').fill('2026-09-26');
                    await page.waitForFunction(() => {
                        const args = window.__ownerQa.calls.filter(call => call.rpc === 'owner_audit_trail').at(-1)?.args;
                        return args?.p_from && args?.p_to;
                    });
                    await page.locator('[data-owner-audit-search]').fill('audit-31');
                    await page.waitForFunction(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_audit_trail').at(-1)?.args.p_search === 'audit-31');
                    assert.equal(await page.locator('[data-owner-audit-rows]').getByText('audit-31').count(), 1);
                    await page.locator('[data-admin-nav="staff"]').evaluate(el => el.click());

                    // Staff details stay read-only; the owner action changes position only.
                    await staffTrigger.click();
                    await page.locator('[data-admin-staff-command="view"]').click();
                    const staffDetails = page.locator('[data-admin-staff-details-view]');
                    assert.equal(await staffDetails.isVisible(), true);
                    assert.deepEqual(await staffDetails.locator('input, select, textarea').count(), 0, 'view mode must not render disabled form controls');
                    assert.equal(await staffDetails.locator('[data-admin-staff-detail-name]').innerText(), 'QA Staff');
                    assert.equal(await staffDetails.locator('[data-admin-staff-detail-position]').innerText(), 'Court Attendant');
                    assert.equal(await staffDetails.locator('[data-admin-staff-detail-mobile]').innerText(), '+639171234567');
                    assert.equal(await staffDetails.locator('[data-admin-staff-detail-age]').innerText(), '26 years old');
                    assert.equal(await staffDetails.locator('[data-admin-staff-detail-emergency-name]').innerText(), 'QA Contact');
                    assert.equal(await page.locator('[data-admin-staff-edit-meta]').isVisible(), true, 'view mode keeps member-since and status context visible');
                    assert.match(await page.locator('[data-admin-staff-edit-meta]').innerText(), /Member since .* · Active/);
                    assert.equal(await page.locator('[data-admin-staff-edit-submit]').isVisible(), false);
                    await page.locator('[data-admin-staff-edit-modal-close]').last().click();
                    await page.locator('[data-admin-staff-edit-modal]').waitFor({ state: 'hidden' });
                    await staffTrigger.click();
                    await page.locator('[data-admin-staff-command="edit"]').click();
                    assert.equal(await staffDetails.isVisible(), true, 'position change keeps staff details read-only');
                    assert.equal(await page.locator('[data-admin-staff-details-edit]').isVisible(), true);
                    assert.equal(await page.locator('[data-admin-staff-details-edit] input, [data-admin-staff-details-edit] textarea').count(), 0, 'owner cannot edit personal information');
                    assert.deepEqual(await page.locator('[data-admin-staff-edit-position] option').allTextContents(), ['Secretary', 'Court Attendant']);
                    await page.locator('[data-admin-staff-edit-position]').selectOption({ label: 'Secretary' });
                    await page.locator('[data-admin-staff-edit-submit]').click();
                    await page.locator('.owner-confirm-overlay [data-confirm-yes]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'profiles' && call.write === 'update' && call.payload.position === 'Secretary'));
                    const positionWrite = await page.evaluate(() => window.__ownerQa.calls.findLast(call => call.table === 'profiles' && call.write === 'update' && call.payload.position === 'Secretary'));
                    assert.deepEqual(positionWrite.payload, { position: 'Secretary' }, 'position change sends no personal fields to the profile update path');
                    await page.locator('[data-admin-staff-edit-modal]').waitFor({ state: 'hidden' });

                    // Staff deactivation uses the accessible shared confirmation dialog.
                    await staffTrigger.click();
                    await page.locator('[data-admin-staff-command="toggle"]').click();
                    await page.locator('.owner-confirm-overlay').waitFor({ state: 'visible' });
                    assert.match(await page.locator('.owner-confirm-overlay').innerText(), /QA Staff will no longer be able to log in/);
                    await page.locator('.owner-confirm-overlay [data-confirm-no]').click();
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'profiles' && call.write === 'update' && call.payload.status === 'disabled').length), 0);
                    await staffTrigger.click();
                    await page.locator('[data-admin-staff-command="toggle"]').click();
                    await page.locator('.owner-confirm-overlay [data-confirm-yes]').click();
                    await page.waitForFunction(() => window.__ownerQa.tables.profiles.find(profile => profile.id === 'qa-staff').status === 'disabled');
                    await page.locator('[data-admin-staff-table] tbody tr').filter({ hasText: 'QA Staff' }).getByText('Deactivated').waitFor();
                    await staffTrigger.click();
                    await page.locator('[data-admin-staff-command="toggle"]').click();
                    assert.match(await page.locator('.owner-confirm-overlay').innerText(), /QA Staff will be able to log in again/);
                    await page.locator('.owner-confirm-overlay [data-confirm-yes]').click();
                    await page.waitForFunction(() => window.__ownerQa.tables.profiles.find(profile => profile.id === 'qa-staff').status === 'active');
                    await page.locator('[data-admin-staff-table] tbody tr').filter({ hasText: 'QA Staff' }).getByText('Active').waitFor();

                    await page.locator('[data-admin-staff-add]').first().click();
                    const positions = await page.locator('[data-admin-staff-role] option').allTextContents();
                    assert.deepEqual(positions.map(s => s.trim()), ['Secretary', 'Court Attendant']);
                    assert.equal(await page.locator('[data-admin-staff-email]').count(), 1);
                    for (const selector of ['[data-admin-staff-name]', '[data-admin-staff-birthdate]', '[data-admin-staff-address]', '[data-admin-staff-gender]', '[data-admin-staff-emergency-name]']) {
                        assert.equal(await page.locator(selector).count(), 0, `${selector} is collected during staff setup, not by the owner`);
                    }
                    await page.locator('[data-admin-staff-modal-close]').first().click();

                    // Aggregate must stay fixed when the list is filtered.
                    await page.locator('[data-admin-nav="feedback"]').first().evaluate(el => el.click());
                    await page.locator('[data-admin-review-summary]').getByText('4.0 / 5.0').waitFor();
                    await page.locator('[data-admin-review-rating="5"]').click();
                    await page.locator('[data-admin-review-list]').getByText('Great').waitFor();
                    assert.equal(await page.locator('[data-admin-review-list]').getByText('Okay').count(), 0);
                    assert.match(await page.locator('[data-admin-review-summary]').innerText(), /4\.0 \/ 5\.0/);
                    assert.doesNotMatch(await page.locator('[data-admin-review-summary]').innerText(), /customer reviews|No reviews yet/i);

                    // Payment settings are owner-only, validate online availability, and report safe PayMongo health.
                    await page.locator('[data-admin-nav="payments"]').evaluate(el => el.click());
                    await page.locator('[data-owner-paymongo-api]').getByText('Connected').waitFor();
                    await page.locator('[data-owner-paymongo-webhook]').getByText('Ready').waitFor();
                    assert.equal(await page.locator('[data-owner-payment-method="gcash"]').isChecked(), true);
                    await page.locator('[data-owner-payment-method="gcash"]').uncheck();
                    await page.locator('[data-owner-payment-save]').click();
                    assert.match(await page.locator('[data-owner-payment-message]').innerText(), /at least one online payment method/i);
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'app_settings' && call.write === 'update').length), 0);
                    await page.locator('[data-owner-payment-method="card"]').check();
                    await page.locator('[data-owner-payment-percent]').fill('35.5');
                    await page.locator('[data-owner-payment-save]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'app_settings' && call.write === 'update'));
                    const paymentSave = await page.evaluate(() => window.__ownerQa.calls.find(call => call.table === 'app_settings' && call.write === 'update'));
                    assert.equal(paymentSave.payload.downpayment_pct, 35.5);
                    assert.equal(paymentSave.payload.card_enabled, true);
                    assert.equal(paymentSave.payload.gcash_enabled, false);
                    assert.doesNotMatch(await page.locator('[data-admin-panel="payments"]').innerText(), /secret|sk_test/i);

                    }
                    // Long listing cards and Add Sport editor remain usable at narrow widths.
                    await page.locator('[data-admin-nav="courts"]').first().evaluate(el => el.click());
                    await page.locator('[data-admin-panel="courts"] .ioc-listing-card').first().waitFor();
                    assert.equal(await page.locator('[data-admin-panel="courts"] .ioc-listing-card').count(), 24);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme} court-list overflow`);
                    await page.locator('[data-admin-panel="courts"] [data-ioc-add]').click();
                    await page.locator('[data-ioc-editor-overlay][data-open]').waitFor();
                    await page.keyboard.press('Shift+Tab');
                    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-ioc-save]')), true, 'editor Shift+Tab stays inside dialog');
                    await page.keyboard.press('Tab');
                    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-ioc-close]')), true, 'editor Tab wraps inside dialog');
                    await page.locator('[data-ioc-name]').fill('Bowling');
                    await page.locator('[data-ioc-new-unit-label]').fill('Lane 1');
                    await page.locator('[data-ioc-add-unit]').click();
                    assert.equal(await page.locator('[data-ioc-units] .ioc-unit-card').count(), 1);
                    assert.equal(await page.locator('[data-ioc-rate-unit]').count(), 0, 'rate basis is automatic and has no selector');
                    assert.equal(await page.locator('[data-ioc-day-label="0"]').innerText(), 'Price per set');
                    assert.match(await page.locator('[data-ioc-set-hint="0"]').innerText(), /60-minute slot/);
                    assert.equal(await page.locator('[data-ioc-night-field="0"]').isHidden(), true);
                    const spaceSearch = page.locator('[data-ioc-resource-search="0"]');
                    assert.equal(await spaceSearch.isVisible(), true, 'availability search sits at the top of its unit card');
                    assert.equal(await page.locator('[data-ioc-resource-details="0"]').getAttribute('open'), null, 'connections start compact');
                    await page.locator('[data-ioc-resource-details="0"] summary').click();
                    assert.equal(await page.locator('[data-ioc-load-resources="0"]').innerText(), 'Show 2 more spaces');
                    await page.locator('[data-ioc-load-resources="0"]').click();
                    assert.equal(await page.locator('[data-ioc-unit-resources="0"] [data-ioc-resource="0"]').count(), 8);
                    await page.locator('[data-ioc-unit-resources="0"] [data-ioc-resource="0"]').first().check();
                    await spaceSearch.fill('No matching space name');
                    assert.equal(await page.locator('[data-ioc-unit-resources="0"] .ioc-resource-group-selected [data-ioc-resource="0"]').count(), 1, 'selected connections stay visible when search excludes them');
                    assert.equal(await page.locator('[data-ioc-unit-resources="0"] .ioc-resource-group-selected [data-ioc-resource="0"]').isChecked(), true);
                    const courtPng = await page.evaluate(() => {
                        const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 9;
                        const context = canvas.getContext('2d'); context.fillStyle = '#fc6'; context.fillRect(0, 0, 16, 9);
                        return canvas.toDataURL('image/png').split(',')[1];
                    });
                    const courtFile = { name: 'court.png', mimeType: 'image/png', buffer: Buffer.from(courtPng, 'base64') };
                    const photoLayoutBefore = await page.locator('[data-ioc-editor]').evaluate(el => {
                        const dialog = el.getBoundingClientRect();
                        const dock = el.querySelector('[data-ioc-action-dock]').getBoundingClientRect();
                        return { dialogTop: dialog.top, dialogHeight: dialog.height, dialogScrollTop: el.scrollTop, dockTop: dock.top, dockHeight: dock.height, scrollTop: el.querySelector('.ioc-editor-scroll').scrollTop };
                    });
                    const coverBefore = await page.locator('[data-ioc-cover-preview]').innerHTML();
                    const unitBefore = await page.locator('[data-ioc-unit-preview="0"]').innerHTML();
                    await page.evaluate(() => {
                        window.__courtCropOptions = [];
                        window.InigoImageTools.openCropEditor = async (_file, options) => { window.__courtCropOptions.push(options); return null; };
                    });
                    await page.locator('[data-ioc-cover-file]').setInputFiles(courtFile);
                    const cancelledUnitPicker = page.waitForEvent('filechooser');
                    await page.locator('[data-ioc-choose-unit-photo="0"]').evaluate(button => button.click());
                    await (await cancelledUnitPicker).setFiles(courtFile);
                    await page.waitForFunction(() => window.__courtCropOptions.length === 2);
                    assert.equal(await page.locator('[data-ioc-cover-preview]').innerHTML(), coverBefore, 'cancelled cover crop keeps the prior preview');
                    assert.equal(await page.locator('[data-ioc-unit-preview="0"]').innerHTML(), unitBefore, 'cancelled unit crop keeps the prior preview');
                    await page.evaluate(() => {
                        window.InigoImageTools.openCropEditor = async (_file, options) => { window.__courtCropOptions.push(options); return new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }); };
                    });
                    await page.locator('[data-ioc-cover-file]').setInputFiles(courtFile);
                    const unitPicker = page.waitForEvent('filechooser');
                    await page.locator('[data-ioc-choose-unit-photo="0"]').evaluate(button => button.click());
                    await (await unitPicker).setFiles(courtFile);
                    await page.locator('[data-ioc-cover-preview] img').waitFor();
                    await page.locator('[data-ioc-unit-preview="0"] img').waitFor();
                    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-ioc-choose-unit-photo="0"]')), true, 'photo selection restores focus to its visible control');
                    assert.equal(await page.evaluate(() => window.__courtCropOptions.every(options => options.aspect === 16 / 9)), true);
                    await page.locator('[data-ioc-unit-file="0"]').evaluate(input => { input.focus(); input.dispatchEvent(new Event('cancel')); });
                    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-ioc-choose-unit-photo="0"]')), true, 'native picker cancellation restores focus to its visible control');
                    const photoLayout = await page.locator('[data-ioc-editor]').evaluate(el => {
                        const dialog = el.getBoundingClientRect();
                        const dock = el.querySelector('[data-ioc-action-dock]').getBoundingClientRect();
                        const scroll = el.querySelector('.ioc-editor-scroll');
                        return { dialogTop: dialog.top, dialogHeight: dialog.height, dialogScrollTop: el.scrollTop, dockTop: dock.top, dockHeight: dock.height, dockBottomOffset: dialog.bottom - dock.bottom, scrollTop: scroll.scrollTop };
                    });
                    assert.ok(photoLayout.dialogHeight > 0 && photoLayout.dockHeight > 0 && photoLayout.dockHeight <= 121 && Math.abs(photoLayout.dockBottomOffset) <= 1, 'staging a unit photo keeps the modal and action dock within their layout bounds');
                    assert.ok(Math.abs(photoLayout.dialogTop - photoLayoutBefore.dialogTop) <= 1 && Math.abs(photoLayout.dialogHeight - photoLayoutBefore.dialogHeight) <= 1 && Math.abs(photoLayout.dockTop - photoLayoutBefore.dockTop) <= 1, 'unit photo selection does not shift the modal or action dock');
                    await page.locator('[data-ioc-add-maintenance="0"]').click();
                    assert.equal(await page.locator('[data-ioc-unit-preview="0"] img').count(), 1, 'rerender keeps the staged unit crop preview');
                    await page.locator('[data-ioc-remove-maintenance="0:0"]').click();
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.upload).length), 0, 'crop apply only stages photos');
                    await page.evaluate(() => { const scroll = document.querySelector('.ioc-editor-scroll'); scroll.scrollTop = 60; scroll.dispatchEvent(new Event('scroll')); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll')); });
                    assert.equal(await page.locator('[data-ioc-savebar]').getAttribute('aria-hidden'), 'true', 'whole action footer hides on upward scroll');
                    assert.equal(await page.locator('[data-ioc-savebar]').evaluate(el => el.getBoundingClientRect().height), 0, 'hidden footer leaves no occupied height');
                    assert.equal(await page.locator('[data-ioc-reveal]').isVisible(), true);
                    await page.locator('[data-ioc-reveal]').click();
                    assert.equal(await page.locator('[data-ioc-savebar]').getAttribute('aria-hidden'), 'false');
                    await page.locator('[data-ioc-hide]').click();
                    assert.equal(await page.locator('[data-ioc-reveal]').isVisible(), true, 'Hide actions leaves a compact reveal control');
                    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-ioc-reveal]')), true, 'hiding actions moves focus to Show actions');
                    await page.keyboard.press('Enter');
                    assert.equal(await page.locator('[data-ioc-savebar]').getAttribute('aria-hidden'), 'false', 'keyboard reopens actions');
                    const dockSize = await page.locator('[data-ioc-action-dock]').evaluate(el => ({ height: el.getBoundingClientRect().height, bottom: el.getBoundingClientRect().bottom, dialogBottom: el.closest('.ioc-dialog').getBoundingClientRect().bottom }));
                    assert.ok(dockSize.height <= 121 && Math.abs(dockSize.bottom - dockSize.dialogBottom) <= 1, 'action dock stays compact at the dialog bottom');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.rpc === 'admin_save_sport').length), 0);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme} sport-editor overflow`);
                    await page.locator('[data-ioc-save]').click();
                    await page.locator('[data-confirm-yes]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.rpc === 'admin_save_sport'));
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.upload).length), 2, 'cover and unit crop files upload only on Save');
                    const sportPayload = await page.evaluate(() => window.__ownerQa.calls.find(call => call.rpc === 'admin_save_sport').args.p_payload);
                    assert.equal(sportPayload.units[0].rate_unit, '/set', 'legacy per-set sport pricing remains automatic for Bowling');
                    assert.match(sportPayload.image_url, /\/cover-.*\.jpg$/);
                    assert.match(sportPayload.units[0].photo_url, /\/unit-.*\.jpg$/);
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.remove).length), 2, 'failed save cleans up both newly uploaded photos');
                    assert.equal(await page.locator('[data-ioc-editor-overlay][data-open]').count(), 1, 'failed save must retain the draft');
                    assert.equal(await page.locator('[data-ioc-name]').inputValue(), 'Bowling');
                    await page.locator('[data-ioc-close]').evaluate(el => el.click());
                    await page.locator('[data-confirm-yes]').click();
                    await page.locator('[data-ioc-editor-overlay]').waitFor({ state: 'hidden' });

                    // A successful cover save returns to the listing and reloads the persisted URL.
                    await page.evaluate(() => { window.__ownerQa.succeedSportSave = true; });
                    await page.locator('[data-ioc-add]').click();
                    await page.locator('[data-ioc-name]').fill('QA Covered Sport');
                    await page.locator('[data-ioc-new-unit-label]').fill('Court 1');
                    await page.locator('[data-ioc-add-unit]').click();
                    await page.locator('[data-ioc-new-unit-label]').fill('Court 2');
                    await page.locator('[data-ioc-add-unit]').click();
                    await page.locator('[data-ioc-cover-file]').setInputFiles(courtFile);
                    await page.locator('[data-ioc-unit-file="0"]').setInputFiles(courtFile);
                    await page.locator('[data-ioc-unit-file="1"]').setInputFiles(courtFile);
                    await page.locator('[data-ioc-cover-preview] img').waitFor();
                    await page.locator('[data-ioc-unit-preview="0"] img').waitFor();
                    await page.locator('[data-ioc-unit-preview="1"] img').waitFor();
                    await page.locator('[data-ioc-save]').click();
                    await page.locator('[data-confirm-yes]').click();
                    await page.locator('[data-ioc-editor-overlay]').waitFor({ state: 'hidden' });
                    const coveredCard = page.locator('[data-admin-panel="courts"] .ioc-listing-card').filter({ hasText: 'QA Covered Sport' });
                    await coveredCard.locator('.ioc-listing-photo img').waitFor();
                    const savedCover = await coveredCard.locator('.ioc-listing-photo img').getAttribute('src');
                    assert.match(savedCover, /\/cover-.*\.jpg$/);
                    const savedUnitPhoto = await page.evaluate(() => window.__ownerQa.savedSport.units[0].photo_url);
                    assert.match(savedUnitPhoto, /\/unit-.*\.jpg$/);
                    const savedSecondUnitPhoto = await page.evaluate(() => window.__ownerQa.savedSport.units[1].photo_url);
                    assert.match(savedSecondUnitPhoto, /\/unit-.*\.jpg$/);
                    assert.equal(await page.evaluate(() => window.__ownerQa.savedSport.units.length), 2, 'both unit photos save with the sport');
                    assert.equal(await page.evaluate(() => window.__ownerQa.savedSport.units[0].rate_unit), '/hr', 'ordinary sport units save with the fixed hourly basis');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.rpc === 'admin_save_sport').length), 2);
                    if (process.env.OWNER_QA_COURTS_ONLY !== '1') {
                    await context.addInitScript(({ cover, unit }) => { window.__qaSavedCover = cover; window.__qaSavedUnitPhoto = unit; }, { cover: savedCover, unit: savedUnitPhoto });
                    const landing = await context.newPage();
                    await landing.route(/^https:\/\//, route => route.abort());
                    await landing.route('https://example.test/storage/v1/object/public/media/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+n8AAAAASUVORK5CYII=', 'base64') }));
                    await landing.route('**/Config/supabaseClient.js', route => route.fulfill({ contentType: 'application/javascript', body: `(${fixture})();` }));
                    await landing.goto('http://127.0.0.1:4178/index.html', { waitUntil: 'domcontentloaded' });
                    const landingCover = landing.locator('[data-court-id="qa-covered-sport"] img');
                    await landingCover.waitFor();
                    assert.equal(await landingCover.getAttribute('src'), savedCover, 'landing page uses the saved cover URL');
                    await landing.reload({ waitUntil: 'domcontentloaded' });
                    await landingCover.waitFor();
                    assert.equal(await landingCover.getAttribute('src'), savedCover, 'landing page still shows the cover after reload');
                    await landing.locator('[data-court-id="qa-covered-sport"]').click();
                    assert.equal(await landing.locator('[data-court-viewer-media] img').getAttribute('src'), savedUnitPhoto, 'court viewer uses the saved unit photo after reload');
                    await landing.close();
                    }
                    await coveredCard.locator('[data-ioc-edit]').click();
                    assert.equal(await page.locator('[data-ioc-editor]').getAttribute('data-mode'), 'edit');
                    assert.equal(await page.locator('[data-ioc-cover-preview] img').getAttribute('src'), savedCover, 'editor reloads the saved cover');
                    assert.equal(await page.locator('[data-ioc-unit-preview="0"] img').getAttribute('src'), savedUnitPhoto, 'editor reloads the saved unit photo');
                    await page.evaluate(() => { const scroll = document.querySelector('.ioc-editor-scroll'); scroll.scrollTop = 60; scroll.dispatchEvent(new Event('scroll')); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll')); });
                    assert.equal(await page.locator('[data-ioc-savebar]').getAttribute('aria-hidden'), 'true', 'edit footer hides as one piece');
                    await page.locator('[data-ioc-reveal]').click();
                    assert.equal(await page.locator('[data-ioc-savebar]').getAttribute('aria-hidden'), 'false');
                    await page.locator('[data-ioc-close]').click();

                    // Add slide crop cancellation preserves the preview; applying the crop stages until the Save action uploads it.
                    await page.locator('[data-admin-nav="media"]').first().evaluate(el => el.click());
                    await page.locator('[data-admin-slides] [data-media-card]').first().waitFor();
                    const before = await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'event' && call.write).length);
                    await page.locator('[data-admin-slide-add]').click();
                    await page.locator('[data-media-title]').fill('Unpublished draft');
                    const initialSlidePreview = await page.locator('[data-media-preview]').innerHTML();
                    await page.evaluate(() => {
                        window.__mediaCropOptions = [];
                        window.InigoImageTools.openCropEditor = async (_file, options) => { window.__mediaCropOptions.push(options); return null; };
                    });
                    const slideFile = { name: 'slide.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('qa image') };
                    await page.locator('[data-media-file]').setInputFiles(slideFile);
                    await page.waitForFunction(() => window.__mediaCropOptions.length === 1);
                    assert.equal(await page.locator('[data-media-preview]').innerHTML(), initialSlidePreview, 'cancelled slide crop must leave the preview unchanged');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'event' && call.write).length), before);
                    await page.evaluate(() => {
                        window.InigoImageTools.openCropEditor = async (_file, options) => { window.__mediaCropOptions.push(options); return new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }); };
                        window.InigoImageTools.downscaleImageToBlob = async file => file;
                    });
                    await page.locator('[data-media-file]').setInputFiles(slideFile);
                    await page.locator('[data-media-preview] img').waitFor();
                    assert.equal(await page.evaluate(() => window.__mediaCropOptions.at(-1).aspect), 16 / 9);
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'event' && call.write).length), before, 'cropped slide must remain staged until Save');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'event' && call.write).length), before);
                    await page.locator('[data-media-save]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'event' && call.write === 'insert'));
                    await page.locator('[data-admin-slide-modal]').waitFor({ state: 'hidden' });
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'event' && call.write).length), before + 1);

                    await page.locator('[data-admin-slide-add]').click();
                    await page.locator('[data-media-title]').fill('Cancelled draft');
                    await page.locator('[data-admin-slide-modal-close]').first().click();
                    await page.locator('[data-confirm-yes]').click();
                    assert.equal(await page.locator('[data-media-card]').count(), 3);
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'event' && call.write).length), before + 1);

                    // Keyboard reorder succeeds and a failed RPC restores the prior order.
                    await page.locator('[data-media-card]').nth(1).focus();
                    await page.keyboard.press('Alt+ArrowUp');
                    await page.waitForFunction(() => document.querySelector('[data-media-card]')?.dataset.slideId?.endsWith('0002'));
                    await page.evaluate(() => window.__ownerQa.failReorder = true);
                    await page.locator('[data-media-card]').nth(1).focus();
                    await page.keyboard.press('Alt+ArrowUp');
                    await page.waitForFunction(() => document.querySelector('[data-media-card]')?.dataset.slideId?.endsWith('0002'));
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme} horizontal overflow after panels`);
                    assert.deepEqual(errors, [], `${width}/${theme} uncaught page errors`);
                    console.log(`PASS owner portal ${width}px ${theme}`);
                } catch (error) {
                    const detail = await page.evaluate(() => ({ notifications: document.querySelector('[data-admin-notif-list]')?.innerHTML, activityCalls: window.__ownerQa?.calls.filter(call => call.table === 'owner_activity') })).catch(() => null);
                    failures.push(`${width}px ${theme}: ${error.stack || error}\n${JSON.stringify(detail)}`);
                } finally { await context.close(); }
            }
        }
    } finally { await browser.close(); }
    if (failures.length) { console.error(failures.join('\n\n')); process.exitCode = 1; }
})();
