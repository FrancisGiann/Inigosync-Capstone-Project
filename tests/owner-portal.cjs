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
    const state = window.__ownerQa = { calls: [], failReorder: false };
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
            { id: 'qa-staff', role: 'staff', full_name: 'QA Staff', email: 'staff@example.test', position: 'Court Attendant', status: 'active', birthdate: '2000-09-26', created_at: '2026-01-01T00:00:00Z' },
            { id: 'qa-customer', role: 'customer', full_name: 'QA Customer', email: 'customer@example.test', status: 'active', created_at: '2026-02-01T00:00:00Z' },
        ],
        app_settings: [{ id: true, downpayment_pct: 50, cash_enabled: true, card_enabled: false, gcash_enabled: true }],
        court: Array.from({ length: 24 }, (_, index) => ({ id: `court-${index + 1}`, sport_id: `sport-${index + 1}`, slug: `sport-${index + 1}`, name: index === 0 ? 'A long court listing title that must wrap without shifting other actions' : `Sport ${index + 1}`, quantity: index + 1, unit: 'courts', description: 'Responsive fixture', image_url: null, is_active: index !== 23, display_order: index + 1, sport: { id: `sport-${index + 1}`, name: `Sport ${index + 1}`, slug: `sport-${index + 1}` } })),
    };
    const result = (table, q) => {
        let rows = (data[table] || []).slice();
        if (q.filters) rows = rows.filter(row => Object.entries(q.filters).every(([key, value]) => row[key] == value));
        if (q.sort?.length) rows.sort((a, b) => { for (const { key, ascending } of q.sort) { const n = String(a[key] ?? '').localeCompare(String(b[key] ?? '')); if (n) return ascending ? n : -n; } return 0; });
        const count = rows.length;
        if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
        if (q.limit) rows = rows.slice(0, q.limit);
        if (q.write) {
            state.calls.push({ table, write: q.write, payload: q.payload, filters: q.filters });
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
                select(_columns, options) { q.head = !!options?.head; return chain; },
                eq(key, value) { q.filters[key] = value; return chain; },
                is(key, value) { q.filters[key] = value; return chain; },
                in() { return chain; }, gte() { return chain; }, gt() { return chain; }, lte() { return chain; }, lt() { return chain; }, or() { return chain; },
                order(key, options = {}) { q.sort.push({ key, ascending: options.ascending !== false }); return chain; },
                range(from, to) { q.range = [from, to]; return chain; }, limit(n) { q.limit = n; return chain; },
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
            if (name === 'admin_get_sport_editor') return { data: { version: 0, listing: null, units: [], resources: Array.from({ length: 8 }, (_, index) => ({ id: `resource-${index + 1}`, name: `Shared Space ${index + 1}`, sport_names: ['Basketball'] })), cutoff: '18:00:00' }, error: null };
            if (name === 'admin_save_sport') return { data: null, error: { message: 'Simulated stale-save failure' } };
            if (name === 'admin_reorder_slides') return state.failReorder ? { data: null, error: { message: 'Simulated reorder failure' } } : { data: args.p_ids, error: null };
            if (name === 'owner_review_summary') return { data: { average_rating: 4, total_count: 2, star_counts: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 } }, error: null };
            if (name === 'owner_staff_activity') {
                let rows = staffAudit.filter(row => row.actor_id === args.p_staff_id || args.p_staff_id === 'qa-staff');
                const query = String(args.p_search || '').toLocaleLowerCase();
                if (query) rows = rows.filter(row => JSON.stringify(row).toLocaleLowerCase().includes(query));
                const total_count = rows.length;
                return { data: { rows: rows.slice(args.p_offset, args.p_offset + args.p_limit), total_count }, error: null };
            }
            if (name === 'admin_booking_overview') return { data: [
                { status: 'pending', amount_paid: 0 }, { status: 'confirmed', amount_paid: 0 },
                { status: 'confirmed', amount_paid: 250 }, { status: 'completed', amount_paid: 500 },
                { status: 'no_show', amount_paid: 0 },
            ], error: null };
            if (name === 'court_occupancy') return { data: [], error: null };
            if (name === 'admin_get_sport_editor') return { data: { version: 0, listing: null, units: [], resources: [], cutoff: '18:00:00' }, error: null };
            return { data: [], error: null };
        },
        storage: { from: () => ({ list: async () => ({ data: [], error: null }), upload: async () => ({ error: null }), remove: async () => ({ error: null }), getPublicUrl: path => ({ data: { publicUrl: `https://example.test/storage/v1/object/public/media/${path}` } }) }) },
        functions: { invoke: async name => name === 'payment-health' ? { data: { api_connected: true, webhook_configured: true, last_confirmed_payment_at: '2026-09-26T10:00:00Z' }, error: null } : { data: null, error: { message: 'Unknown function' } } },
        auth: {
            getSession: async () => ({ data: { session: { access_token: 'qa-token', user: { id: 'qa-owner', email: 'owner@example.test' } } } }),
            getUser: async () => ({ data: { user: { id: 'qa-owner', email: 'owner@example.test', identities: [] } } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({}),
        },
    };
    window.SUPABASE_URL = 'https://qa.invalid';
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const failures = [];
    try {
        for (const width of process.env.OWNER_QA_QUICK === '1' ? [360] : [360, 390, 768, 1024, 1440]) {
            for (const theme of process.env.OWNER_QA_QUICK === '1' ? ['light'] : ['light', 'dark']) {
                const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Manila', reducedMotion: 'reduce' });
                const page = await context.newPage();
                page.setDefaultTimeout(5000);
                page.setDefaultNavigationTimeout(10000);
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.addInitScript(theme => localStorage.setItem('inigosync-theme', theme), theme);
                await page.route(/^https:\/\//, route => route.abort());
                await page.route('**/Config/supabaseClient.js', route => route.fulfill({ contentType: 'application/javascript', body: `(${fixture})();` }));
                await page.route('**/includes/authGuard.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.inigosyncProfile={id:'qa-owner',role:'admin',status:'active',full_name:'QA Owner',email:'owner@example.test'};document.addEventListener('DOMContentLoaded',()=>{window.InigoLoading?.hide();document.documentElement.classList.remove('inigo-auth-pending');document.dispatchEvent(new CustomEvent('inigosync:profile-ready',{detail:window.inigosyncProfile}));});` }));
                await page.route('**/includes/loadingOverlay.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.InigoLoading={show(){},hide(){}};window.InigoToast={show(){}};` }));
                await page.route('**/includes/courtsData.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.InigoCourtsData={getCourts:async()=>[],getSports:async()=>[],invalidateCourts(){},monogramFor:()=>'',slugify:s=>s,rateHint:()=>null};` }));
                await page.route('**/includes/courts-data.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
                await page.goto('http://127.0.0.1:4178/Pages/owner_dashboard.html', { waitUntil: 'domcontentloaded' });
                try {
                    assert.equal(await page.locator('[data-admin-slides] [data-media-card]').count(), 2);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme} horizontal overflow on overview`);
                    await page.locator('[data-admin-stat="customer-accounts"]').getByText('1').waitFor();
                    await page.locator('[data-admin-status-breakdown] .admin-progress-item').nth(2).waitFor();
                    assert.equal(await page.locator('[data-admin-status-breakdown] .admin-progress-item').count(), 3);
                    assert.doesNotMatch(await page.locator('[data-admin-status-breakdown]').innerText(), /Awaiting payment/i);
                    await page.locator('[data-admin-perf-list]').getByText('Server response').waitFor();
                    assert.doesNotMatch(await page.locator('[data-admin-perf-list]').innerText(), /Saved bookings and customers/i);
                    assert.match(await page.locator('[data-admin-perf-list]').innerText(), /Photo storage used/i);

                    // Profile modal must be visible, focusable, close, and restore focus.
                    await page.locator('[data-admin-nav="settings"]').first().evaluate(el => el.click());
                    await page.locator('[data-admin-profile-edit]').click();
                    assert.equal(await page.locator('[data-admin-settings-profile-modal]').getAttribute('data-open'), '');
                    assert.equal(await page.locator('[data-admin-settings-profile-modal]').isVisible(), true);
                    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-admin-settings-profile-modal]') !== null), true);
                    await page.keyboard.press('Escape');
                    await page.locator('[data-admin-settings-profile-modal]').waitFor({ state: 'hidden' });
                    assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-admin-profile-edit')), true);

                    // Owner avatar crop is square, cancellation keeps the current photo, and applying a crop only stages it until Save.
                    await page.locator('[data-admin-avatar-edit]').click();
                    await page.evaluate(() => {
                        window.__avatarCropOptions = [];
                        window.InigoImageTools.openCropEditor = async (_file, options) => { window.__avatarCropOptions.push(options); return null; };
                    });
                    const avatarFile = { name: 'avatar.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('qa image') };
                    await page.locator('[data-admin-avatar-file]').setInputFiles(avatarFile);
                    await page.waitForFunction(() => window.__avatarCropOptions.length === 1);
                    assert.equal(await page.locator('[data-admin-avatar-modal] .admin-avatar-upload-preview img').count(), 0, 'cancelled crop must leave the avatar unchanged');
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'profiles' && call.write === 'update').length), 0);
                    await page.evaluate(() => { window.InigoImageTools.openCropEditor = async (_file, options) => { window.__avatarCropOptions.push(options); return new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }); }; });
                    await page.locator('[data-admin-avatar-file]').setInputFiles(avatarFile);
                    await page.locator('[data-admin-avatar-modal] .admin-avatar-upload-preview img').waitFor();
                    assert.equal(await page.evaluate(() => window.__avatarCropOptions.at(-1).aspect), 1);
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.table === 'profiles' && call.write === 'update').length), 0, 'cropped avatar must remain a draft until Save');
                    await page.locator('[data-admin-avatar-save]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.table === 'profiles' && call.write === 'update'));
                    await page.locator('[data-admin-avatar-modal]').waitFor({ state: 'hidden' });

                    // Staff age and supported position choices.
                    await page.locator('[data-admin-nav="staff"]').first().evaluate(el => el.click());
                    await page.locator('[data-admin-staff-table] tbody tr').filter({ hasText: 'QA Staff' }).waitFor();
                    await page.locator('[data-admin-staff-table] tbody tr').filter({ hasText: 'QA Staff' }).locator('[data-admin-staff-actions-trigger]').click();
                    await page.locator('[data-admin-staff-command="activity"]').click();
                    await page.locator('[data-admin-staff-activity-list]').getByText('Walk-in booking recorded').waitFor();
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_staff_activity').at(-1).args.p_staff_id), 'qa-staff');
                    await page.locator('[data-admin-staff-activity-next]').click();
                    await page.locator('[data-admin-staff-activity-list]').getByText('audit-12').waitFor().catch(() => {});
                    await page.locator('[data-admin-staff-activity-search]').fill('Walk-in');
                    await page.waitForFunction(() => window.__ownerQa.calls.filter(call => call.rpc === 'owner_staff_activity').at(-1)?.args.p_search === 'Walk-in');
                    assert.equal(await page.locator('[data-admin-staff-activity-list] .owner-staff-activity-item').count(), 1);
                    await page.keyboard.press('Escape');
                    await page.locator('[data-admin-staff-activity-modal]').waitFor({ state: 'hidden' });
                    await page.locator('[data-admin-staff-add]').first().click();
                    const positions = await page.locator('[data-admin-staff-role] option').allTextContents();
                    assert.deepEqual(positions.map(s => s.trim()), ['Secretary', 'Court Attendant']);
                    await page.locator('[data-admin-staff-birthdate]').fill('2000-09-26');
                    assert.equal(await page.locator('[data-admin-staff-age]').inputValue(), '26');
                    assert.equal(await page.locator('[data-admin-staff-age]').getAttribute('readonly'), '');
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

                    // Notification details link to their section and never interpret HTML.
                    await page.locator('[data-admin-notif-trigger]').click();
                    await page.locator('[data-admin-notif-list] [data-owner-activity-id]').first().click();
                    await page.locator('[data-owner-notification-detail]').getByText('Basketball Court 1 rates changed').waitFor();
                    assert.equal(await page.locator('[data-owner-notification-modal]').getAttribute('data-open'), '');
                    assert.equal(await page.locator('[data-admin-panel="notifications"].is-active').count(), 1);
                    await page.locator('[data-notification-go]').click();
                    await page.locator('[data-owner-notification-modal]').waitFor({ state: 'hidden' });
                    assert.equal(await page.locator('[data-admin-panel="courts"].is-active').count(), 1);

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
                    assert.equal(await page.locator('[data-ioc-rate-unit="0"]').inputValue(), '/set', 'new Bowling units default to per-set pricing');
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
                    assert.equal(await page.evaluate(() => window.__ownerQa.calls.filter(call => call.rpc === 'admin_save_sport').length), 0);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme} sport-editor overflow`);
                    await page.locator('[data-ioc-reveal]').click();
                    await page.locator('[data-ioc-save]').click();
                    await page.locator('[data-confirm-yes]').click();
                    await page.waitForFunction(() => window.__ownerQa.calls.some(call => call.rpc === 'admin_save_sport'));
                    assert.equal(await page.locator('[data-ioc-editor-overlay][data-open]').count(), 1, 'failed save must retain the draft');
                    assert.equal(await page.locator('[data-ioc-name]').inputValue(), 'Bowling');
                    await page.locator('[data-ioc-close]').evaluate(el => el.click());
                    await page.locator('[data-confirm-yes]').click();
                    await page.locator('[data-ioc-editor-overlay]').waitFor({ state: 'hidden' });

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
