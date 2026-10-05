// Independent reservation UI checks. Run with scripts/preview.cjs on port 4178.
// All Supabase calls are fixtures; this never creates live rows.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = 'http://127.0.0.1:4178/Pages/';
const fixedNow = '2026-09-24T09:00:00+08:00';
const day = '2026-09-24';
const tomorrow = '2026-09-25';

function occupied(source, court, unit, date, hour, status = 'pending') {
    const start = `${date}T${String(hour).padStart(2, '0')}:00:00+08:00`;
    const end = `${date}T${String(hour + 1).padStart(2, '0')}:00:00+08:00`;
    return { source, courts: court, court_unit: unit, time_date: start, end_at: end, duration_minutes: 60, status };
}

function clientFixture(options) {
    const data = options.rows.slice();
    const calls = [];
    window.__reservationQa = { data, calls, insertError: options.insertError || null, insertErrorAfter: options.insertErrorAfter,
        insertErrorOnce: options.insertErrorOnce || false, insertDelayMs: options.insertDelayMs || 0,
        authoritativeAmountTotal: options.authoritativeAmountTotal, rpcError: null, rpcDelayForDay: {},
        rules: { open_hour: 8, close_hour: 20, is_closed: false, grace_minutes: 30, timezone: 'Asia/Manila' },
        owner: options.owner || null };
    const result = (table, query) => {
        const ownerData = window.__reservationQa.owner;
        if (query.write === 'insert' || query.write === 'upsert' || query.write === 'delete') {
            calls.push({ kind: query.write, table, payload: query.payload });
            if (window.__reservationQa.insertError && (window.__reservationQa.insertErrorAfter === undefined
                || calls.filter(c => c.kind === 'insert').length > window.__reservationQa.insertErrorAfter)) {
                const error = window.__reservationQa.insertError;
                if (window.__reservationQa.insertErrorOnce) window.__reservationQa.insertError = null;
                return { data: null, error };
            }
            if (ownerData && table === 'court_unit_inventory' && query.write === 'insert') {
                const saved = { ...query.payload, id: `qa-unit-${ownerData.units.length + 1}`, court_unit_resource_map: [] };
                ownerData.units.push(saved);
                return { data: query.one ? { id: saved.id } : [saved], error: null };
            }
            if (ownerData && table === 'physical_court_resource' && query.write === 'insert') {
                const saved = { ...query.payload, id: `qa-resource-${ownerData.resources.length + 1}`, is_active: true };
                ownerData.resources.push(saved);
                return { data: query.one ? { id: saved.id } : [saved], error: null };
            }
            if (ownerData && table === 'court_unit_resource_map' && ['insert', 'upsert'].includes(query.write)) {
                const unit = ownerData.units.find(row => row.id === query.payload.court_unit_id);
                if (unit) unit.court_unit_resource_map.push({ resource_id: query.payload.resource_id });
                return { data: query.payload, error: null };
            }
            if (table === 'booking' || table === 'walk_in_booking') {
                const onlineCount = data.filter(row => row.source === 'online').length;
                const walkinCount = data.filter(row => row.source === 'walkin').length;
                const saved = { ...query.payload, source: table === 'booking' ? 'online' : 'walkin',
                    amount_total: window.__reservationQa.authoritativeAmountTotal ?? query.payload.amount_total,
                    booking_id: 100 + onlineCount + 1, walkin_id: 100 + walkinCount + 1,
                    rate_unit_snapshot: query.payload.rate_quantity > 1 ? '/set' : '/hr' };
                data.push(saved);
                return { data: query.one ? saved : [saved], error: null };
            }
            return { data: [], error: null };
        }
        if (query.write === 'update') {
            calls.push({ kind: 'update', table, payload: query.payload });
            return { data: query.one ? { id: 'qa-updated-row', ...(query.payload || {}) } : [], error: null };
        }
        if (table === 'profiles' && query.one) return { data: window.inigosyncProfile, error: null };
        if (table === 'booking' && query.filters?.customer_id) {
            return { data: data.filter(row => row.source === 'online'
                && String(row.customer_id) === String(query.filters.customer_id)), error: null };
        }
        if (ownerData && table === 'court_unit_inventory' && query.selectOptions?.count === 'exact') {
            const matching = ownerData.units.filter(row => !query.filters?.court_id || String(row.court_id) === String(query.filters.court_id));
            return { data: query.selectOptions.head ? null : matching, count: matching.length, error: null };
        }
        if (ownerData && table === 'court_unit_inventory') return { data: ownerData.units, error: null };
        if (ownerData && table === 'physical_court_resource') return { data: ownerData.resources, error: null };
        if (ownerData && table === 'court') {
            const courts = ownerData.courts.filter(row => !query.filters?.id || String(row.id) === String(query.filters.id));
            return { data: query.one ? courts[0] || null : courts, error: null };
        }
        if (ownerData && table === 'app_settings' && query.one) return { data: { night_rate_starts_at: '18:30:00' }, error: null };
        return { data: [], error: null };
    };
    const from = table => {
        const query = { write: null, payload: null, one: false };
        const chain = {
            select(_columns, options) { query.selectOptions = options || null; return chain; }, eq(column, value) { query.filters = { ...(query.filters || {}), [column]: value }; return chain; }, in() { return chain; },
            gte() { return chain; }, gt() { return chain; }, lte() { return chain; },
            lt() { return chain; }, is() { return chain; }, or() { return chain; },
            order() { return chain; }, limit() { return chain; }, range() { return chain; },
            single() {
                query.one = true;
                const delay = query.write === 'insert' ? window.__reservationQa.insertDelayMs : 0;
                return delay ? new Promise(resolve => setTimeout(() => resolve(result(table, query)), delay))
                    : Promise.resolve(result(table, query));
            },
            maybeSingle() { query.one = true; return Promise.resolve(result(table, query)); },
            insert(payload) { query.write = 'insert'; query.payload = payload; return chain; },
            upsert(payload) { query.write = 'upsert'; query.payload = payload; return chain; },
            delete() { query.write = 'delete'; return chain; },
            update(payload) { query.write = 'update'; query.payload = payload; return chain; },
            then(resolve, reject) { return Promise.resolve(result(table, query)).then(resolve, reject); }
        };
        return chain;
    };
    window.sb = {
        from,
        rpc: async (name, args) => {
            calls.push({ kind: 'rpc', name, args });
            if (name === 'booking_rules_for_date') return window.__reservationQa.rulesRpcError
                ? { data: null, error: window.__reservationQa.rulesRpcError }
                : { data: window.__reservationQa.rules, error: null };
            if (name !== 'court_occupancy') return { data: [], error: null };
            const start = Date.parse(args.from_at), end = Date.parse(args.to_at);
            const snapshot = data.filter(row => ['pending', 'confirmed'].includes(row.status)
                && Date.parse(row.time_date) < end && Date.parse(row.end_at) > start);
            const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
            const delay = window.__reservationQa.rpcDelayForDay[date] || 0;
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            return window.__reservationQa.rpcError ? { data: null, error: window.__reservationQa.rpcError }
                : { data: snapshot, error: null };
        },
        functions: { invoke: async (name, options) => {
            calls.push({ kind: 'function', name, options });
            if (window.__qaRecordCheckout) await window.__qaRecordCheckout(name, options);
            return { data: { checkout_url: 'https://checkout.paymongo.com/qa' }, error: null };
        } },
        auth: {
            getSession: async () => ({ data: { session: { user: { id: 'qa-user' } } } }),
            getUser: async () => ({ data: { user: { id: 'qa-user' } } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({}),
        },
    };
}

function courtDataFixture(options = {}) {
    const basketballUnits = [
        { id: 'basketball-unit-1', label: 'Court 1', resourceIds: ['physical-court-1'] },
        { id: 'basketball-unit-2', label: 'Court 2', resourceIds: ['basketball2-pickleball-1', 'basketball2-pickleball-2', 'basketball2-pickleball-3'] },
    ];
    if (options.rates) {
        basketballUnits[0].rateDay = 100;
        basketballUnits[0].rateNight = 200;
        basketballUnits[1].rateDay = 300;
        basketballUnits[1].rateNight = 400;
    }
    const duckpinUnits = [{ id: 'duckpin-unit-1', label: 'Lane 1' }];
    if (options.sets) Object.assign(duckpinUnits[0], { rateDay: 100, rateUnit: '/set' });
    const pickleballUnits = Array.from({ length: 10 }, (_, index) => {
        const n = index + 1;
        const resourceId = n <= 3 ? `basketball2-pickleball-${n}`
            : n <= 6 ? `volleyball1-pickleball-${n - 3}`
                : n <= 8 ? `tennis1-pickleball-${n - 6}` : `tennis2-pickleball-${n - 8}`;
        return { id: `pickleball-unit-${n}`, label: `Court ${n}`, resourceIds: [resourceId] };
    });
    const courts = [
        { id: 1, name: 'Basketball', sportName: 'Basketball', sportSlug: 'basketball',
            quantity: 2, unit: 'courts', rate: 200, rateUnit: '/hr', status: 'available', imageUrl: null,
            bookableUnits: basketballUnits },
        { id: 2, name: 'Badminton', sportName: 'Badminton', sportSlug: 'badminton',
            quantity: 1, unit: 'courts', rate: 100, rateUnit: '/hr', status: 'available', imageUrl: null,
            bookableUnits: [{ id: 'badminton-unit-1', label: 'Court 1', resourceIds: ['physical-badminton-1'] }] },
        { id: 3, name: 'Pickleball', sportName: 'Pickleball', sportSlug: 'pickleball',
            quantity: 10, unit: 'courts', rate: null, rateUnit: '/hr', status: 'available', imageUrl: null,
            bookableUnits: pickleballUnits },
        { id: 4, slug: 'bowling-duckpin', name: 'Bowling — Duckpin', sportName: 'Bowling — Duckpin', sportSlug: 'bowling-duckpin',
            quantity: 8, unit: 'lanes', rate: null, rateUnit: '/game', status: 'available', imageUrl: null,
            bookableUnits: duckpinUnits },
        { id: 7, slug: 'bowling-tenpin', name: 'Bowling — Ten-Pin', sportName: 'Bowling — Duckpin', sportSlug: 'bowling-duckpin',
            quantity: 12, unit: 'lanes', rate: null, rateUnit: '/game', status: 'available', imageUrl: null,
            bookableUnits: [{ id: 'tenpin-unit-1', label: 'Lane 1' }] },
        { id: 5, name: 'Volleyball', sportName: 'Volleyball', sportSlug: 'volleyball',
            quantity: 1, unit: 'court', rate: 500, rateUnit: '/hr', status: 'available', imageUrl: null,
            bookableUnits: [{ id: 'volleyball-unit-1', label: 'Court 1', resourceIds: ['volleyball1-pickleball-1', 'volleyball1-pickleball-2', 'volleyball1-pickleball-3'] }] },
        { id: 6, name: 'Lawn Tennis', sportName: 'Lawn Tennis', sportSlug: 'lawn-tennis',
            quantity: 3, unit: 'courts', rate: 200, rateUnit: '/hr', status: 'available', imageUrl: null,
            bookableUnits: [
                { id: 'tennis-unit-1', label: 'Court 1', resourceIds: ['tennis1-pickleball-1', 'tennis1-pickleball-2'] },
                { id: 'tennis-unit-2', label: 'Court 2', resourceIds: ['tennis2-pickleball-1', 'tennis2-pickleball-2'] },
                { id: 'tennis-unit-3', label: 'Court 3', resourceIds: ['tennis3-resource'] },
            ] },
    ];
    if (options.inventoryUnavailable) courts.forEach(court => { court.inventoryLoadFailed = true; });
    if (options.emptyPickleballInventory) {
        courts.find(court => court.sportSlug === 'pickleball').bookableUnits = [];
    }
    window.InigoCourtsData = {
        getCourts: async () => courts,
        getSports: async () => [{ id: 1, name: 'Basketball', slug: 'basketball' }, { id: 2, name: 'Badminton', slug: 'badminton' }],
        resolveCourtUnits: court => ({ pickerLabel: 'Choose a court', units: court.bookableUnits
            || (court.quantity > 1 ? [{ label: 'Court 1', imageUrl: null }, { label: 'Court 2', imageUrl: null }]
                : [{ label: 'Court 1', imageUrl: null }]) }),
        invalidateCourts: () => {},
        monogramFor: () => 'BB',
        slugify: text => String(text).toLowerCase().replace(/\s+/g, '-'),
        rateHint: court => {
            const rates = (court.bookableUnits || []).flatMap(unit => [unit.rateDay, unit.rateNight].filter(value => typeof value === 'number'));
            return rates.length ? `From ₱${Math.min(...rates)}${court.rateUnit || '/hr'}` : null;
        },
    };
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        async function setup(role, rows, insertError = null, inventoryUnavailable = false, rates = false, sets = false, authoritativeAmountTotal = undefined, insertErrorAfter = undefined, insertDelayMs = 0, insertErrorOnce = false, ownerData = null, emptyPickleballInventory = false) {
            const context = await browser.newContext({ timezoneId: 'Asia/Manila', viewport: { width: 1280, height: 900 } });
            const page = await context.newPage();
            page.setDefaultTimeout(12000);
            const checkoutCalls = [];
            await page.exposeFunction('__qaRecordCheckout', (name, options) => checkoutCalls.push({ name, options }));
            await page.clock.install({ time: new Date(fixedNow) });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route(/^https:\/\//, route => route.abort());
            await page.route('**/includes/loadingOverlay.js', route => route.fulfill({ contentType: 'application/javascript',
                body: `window.__qaToasts=[];window.InigoLoading={show(){},hide(){}};window.InigoToast={show:(message,isError)=>window.__qaToasts.push({message,isError:!!isError})};` }));
            await page.route('**/Config/supabaseClient.js', route => route.fulfill({ contentType: 'application/javascript',
                body: `(${clientFixture})(${JSON.stringify({ rows, insertError, insertErrorAfter, insertDelayMs, insertErrorOnce, authoritativeAmountTotal, owner: ownerData })});` }));
            await page.route('**/includes/authGuard.js', route => route.fulfill({ contentType: 'application/javascript',
                body: `window.inigosyncProfile={id:'qa-user',role:${JSON.stringify(role)},status:'active',full_name:'QA User',email:'qa@example.test'};document.addEventListener('DOMContentLoaded',()=>{window.InigoLoading?.hide();document.documentElement.classList.remove('inigo-auth-pending');document.dispatchEvent(new CustomEvent('inigosync:profile-ready',{detail:window.inigosyncProfile}));});` }));
            await page.route('**/includes/courtsData.js', route => route.fulfill({ contentType: 'application/javascript', body: `(${courtDataFixture})(${JSON.stringify({ inventoryUnavailable, rates, sets, emptyPickleballInventory })});` }));
            await page.route('**/includes/appSettings.js', route => route.fulfill({ contentType: 'application/javascript',
                body: `window.InigoAppSettings={DEFAULT_SETTINGS:{downpaymentPct:50},getSettings:async()=>({downpaymentPct:50,nightRateStartsAt:'18:30'})};` }));
            const dashboard = role === 'customer' ? 'user_dashboard.html' : role === 'admin' ? 'owner_dashboard.html' : 'staff_dashboard.html';
            await page.goto(base + dashboard, { waitUntil: 'domcontentloaded' });
            return { page, context, errors, checkoutCalls };
        }
        const values = locator => locator.evaluate(select => Array.from(select.options).map(option => option.value).filter(Boolean));
        async function customerChooseCourt(page, sport, court = sport, unit = null) {
            await page.locator(`[data-dash-book-sport="${sport.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}"]`).click();
            await page.locator('[data-dash-book-select]').selectOption(court);
            if (unit) await page.locator('[data-dash-book-unit-select]').selectOption({ label: unit });
        }
        async function customerChooseHours(page, hours) {
            for (const hour of hours) await page.locator(`[data-dash-book-slot="${hour}"]`).click();
            await page.locator('[data-dash-book-add]').click();
            await page.locator('[data-dash-book-cart-bar]').waitFor({ state: 'visible' });
        }
        async function customerReadyToSubmit(page) {
            await page.locator('[data-dash-nav="booking"]').first().click();
            await page.locator('[data-dash-book-sport="basketball"]').waitFor({ state: 'visible' });
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 2');
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('[data-dash-payment-option]').first().isVisible(), false,
                'payment choices stay hidden while selecting a court and time');
            await customerChooseHours(page, [10]);
            assert.equal(await page.locator('[data-dash-payment-option]').first().isVisible(), false,
                'payment choices stay in the review opened from the cart bar');
        }
        async function customerProceedToPayment(page) {
            await page.locator('[data-dash-book-cart-proceed]').click();
            await page.locator('[data-dash-book-submit]').waitFor({ state: 'visible' });
        }
        async function customerSubmit(page) {
            await customerProceedToPayment(page);
            await page.locator('[data-dash-book-submit]').click();
            await page.locator('[data-dash-book-fee-confirmation]').waitFor({ state: 'visible' });
            await page.locator('[data-dash-book-fee-continue]').click();
        }
        async function staffReadyToSubmit(page) {
            await page.locator('[data-staff-nav="walkin"]').first().click();
            await page.locator('[data-staff-walkin-name]').fill('QA Walk-In');
            await page.locator('[data-staff-walkin-next]').click();
            await page.locator('[data-staff-walkin-sport="1"]').click();
            await page.locator('[data-staff-walkin-unit-select]').selectOption('Court 2');
            await page.locator('[data-staff-walkin-next]').click();
            await page.waitForFunction(() => Array.from(document.querySelector('[data-staff-walkin-from]').options).some(o => o.value === '10'));
            await page.locator('[data-staff-walkin-from]').selectOption('10');
            await page.locator('[data-staff-walkin-to]').selectOption('10');
            await page.locator('[data-staff-walkin-next]').click();
            await page.locator('[data-staff-walkin-next]').click();
        }

        // Customer: a named unit occupies only itself, and a legacy missing unit occupies the whole court.
        for (const [label, rows, court1Free, court2Free] of [
            ['named online', [occupied('online', 'Basketball', 'Court 1', tomorrow, 10)], false, true],
            ['named walk-in', [occupied('walkin', 'Basketball', 'Court 1', tomorrow, 10)], false, true],
            ['legacy no unit', [occupied('online', 'Basketball', null, tomorrow, 10)], false, false],
            ['blank unit', [occupied('walkin', 'Basketball', '   ', tomorrow, 10)], false, false],
            ['cross-midnight', [{ ...occupied('online', 'Basketball', 'Court 1', tomorrow, 10),
                time_date: `${day}T23:00:00+08:00`, end_at: `${tomorrow}T11:00:00+08:00` }], false, true],
            ['cancelled', [occupied('online', 'Basketball', 'Court 1', tomorrow, 10, 'cancelled')], true, true],
        ]) {
            const { page, context, errors } = await setup('customer', rows);
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 1');
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            const unitSelect = page.locator('[data-dash-book-unit-select]');
            assert.equal(await page.locator('[data-dash-book-slot="10"]').isDisabled(), !court1Free, `${label}: Court 1`);
            await unitSelect.selectOption({ label: 'Court 2' });
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('[data-dash-book-slot="10"]').isDisabled(), !court2Free, `${label}: Court 2`);
            assert.deepEqual(errors, [], `${label}: browser errors`);
            await context.close();
        }

        // Physical-resource projection: a Basketball Court 2 hold returned
        // under all three linked Pickleball zones closes each zone for both
        // customer reservations and staff walk-ins.
        {
            const sharedHolds = ['Court 1', 'Court 2', 'Court 3'].map(unit => occupied('online', 'Pickleball', unit, tomorrow, 10));
            const { page, context, errors } = await setup('customer', sharedHolds);
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Pickleball', 'Pickleball', 'Court 1');
            for (const unit of ['Court 1', 'Court 2', 'Court 3']) {
                if (unit !== 'Court 1') await page.locator('[data-dash-book-unit-select]').selectOption({ label: unit });
                await page.locator('[data-dash-book-date]').fill(tomorrow);
                await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
                assert.equal(await page.locator('[data-dash-book-slot="10"]').isDisabled(), true, `customer sees Basketball Court 2 block ${unit}`);
            }
            assert.deepEqual(errors, [], 'customer shared resource: browser errors');
            await context.close();
        }
        {
            const sharedHolds = ['Court 1', 'Court 2', 'Court 3'].map(unit => occupied('online', 'Pickleball', unit, day, 10));
            const { page, context, errors } = await setup('staff', sharedHolds);
            await page.locator('[data-staff-nav="walkin"]').first().click();
            await page.locator('[data-staff-walkin-name]').fill('QA Walk-In');
            await page.locator('[data-staff-walkin-next]').click();
            await page.locator('[data-staff-walkin-sport="3"]').click();
            await page.locator('[data-staff-walkin-unit-select]').selectOption('Court 2');
            await page.locator('[data-staff-walkin-next]').click();
            await page.locator('[data-staff-walkin-hour="10"]').waitFor({ state: 'attached' });
            assert.equal(await page.locator('[data-staff-walkin-hour="10"]').isDisabled(), true, 'staff sees Basketball Court 2 block its linked Pickleball zones');
            assert.deepEqual(errors, [], 'staff shared resource: browser errors');
            await context.close();
        }

        // Customer checkout submits one held cart and never writes an unpaid booking row.
        {
            const { page, context, errors, checkoutCalls } = await setup('customer', []);
            page.on('dialog', dialog => dialog.accept());
            await customerReadyToSubmit(page);
            await customerProceedToPayment(page);
            await page.locator('[data-dash-book-submit]').click();
            await page.locator('[data-dash-book-fee-confirmation]').waitFor({ state: 'visible' });
            assert.equal(checkoutCalls.length, 0, 'checkout waits for fee confirmation');
            await page.locator('[data-dash-book-fee-confirmation] [data-dash-book-fee-close]').last().click();
            assert.equal(checkoutCalls.length, 0, 'cancelling fee confirmation creates no checkout');
            await page.locator('[data-dash-book-submit]').click();
            await page.locator('[data-dash-book-fee-continue]').click();
            await page.waitForTimeout(300);
            assert.equal(checkoutCalls.length, 1, 'one checkout starts for a single reservation');
            assert.equal(checkoutCalls[0].name, 'paymongo-checkout');
            assert.equal(checkoutCalls[0].options.body.payment_option, 'downpayment');
            assert.equal(checkoutCalls[0].options.body.items.length, 1);
            assert.equal(checkoutCalls[0].options.body.items[0].unit_id, 'basketball-unit-2');
            assert.equal(await page.evaluate(() => window.__reservationQa?.calls.filter(c => c.kind === 'insert' && c.table === 'booking').length ?? 0), 0);
            assert.deepEqual(errors, [], 'customer checkout browser errors');
            await context.close();
        }
        // Booking details remove controls keep totals and focus current; the final removal returns focus to Book a Court.
        {
            const { page, context, errors } = await setup('customer', [], null, false, true);
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 1');
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            await customerChooseHours(page, [10]);
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 2');
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            await customerChooseHours(page, [10]);
            await page.locator('[data-dash-book-cart-details]').click();
            const details = page.locator('[data-dash-book-cart-details-modal]');
            await details.waitFor({ state: 'visible' });
            assert.equal(await details.locator('[data-dash-book-cart-details-count]').innerText(), '2 selected bookings');
            assert.equal(await details.locator('[data-dash-book-cart-details-total]').innerText(), '₱400.00');
            assert.equal(await details.locator('[data-dash-book-cart-details-proceed]').isEnabled(), true);
            await details.locator('[data-dash-book-cart-remove]').first().click();
            assert.equal(await details.locator('[data-dash-book-cart-details-count]').innerText(), '1 selected booking');
            assert.equal(await details.locator('[data-dash-book-cart-details-total]').innerText(), '₱300.00');
            assert.equal(await details.locator('[data-dash-book-cart-remove]').count(), 1);
            await details.locator('[data-dash-book-cart-remove]').click();
            await details.waitFor({ state: 'hidden' });
            assert.equal(await page.locator('[data-dash-book-cart-bar]').isVisible(), false);
            assert.equal(await page.evaluate(() => document.activeElement.matches('[data-dash-nav="booking"]')), true,
                'emptying details returns focus to the visible Book a Court navigation control');
            assert.deepEqual(errors, [], 'booking details removal browser errors');
            await context.close();
        }
        // Legacy My Bookings retry also waits for the fee confirmation and identifies the retry action.
        {
            const retryBooking = { source: 'online', booking_id: 77, customer_id: 'qa-user', courts: 'Basketball',
                court_unit: 'Court 1', time_date: `${tomorrow}T10:00:00+08:00`, end_at: `${tomorrow}T11:00:00+08:00`,
                duration_minutes: 60, status: 'pending', amount_total: 300, amount_paid: 0, payment_id: null };
            const { page, context, errors, checkoutCalls } = await setup('customer', [retryBooking]);
            await page.locator('[data-dash-nav="bookings"]').first().click();
            const retryButton = page.locator('[data-dash-retry-checkout="77"]');
            await retryButton.waitFor({ state: 'visible' });
            await retryButton.click();
            await page.locator('[data-dash-book-fee-confirmation]').waitFor({ state: 'visible' });
            assert.match(await page.locator('[data-dash-book-fee-question]').innerText(), /retry payment for booking #77/i);
            assert.equal(checkoutCalls.length, 0, 'retry waits for explicit fee confirmation');
            await page.locator('[data-dash-book-fee-confirmation] [data-dash-book-fee-close]').last().click();
            assert.equal(checkoutCalls.length, 0, 'cancelling retry fee confirmation makes no checkout request');
            assert.equal(await retryButton.isEnabled(), true, 'cancel leaves the retry control available');
            await retryButton.click();
            await page.locator('[data-dash-book-fee-continue]').click();
            await page.waitForTimeout(100);
            assert.equal(checkoutCalls.length, 1, 'confirmed retry makes one checkout request');
            assert.equal(checkoutCalls[0].options.body.booking_id, 77);
            assert.deepEqual(errors, [], 'retry fee confirmation browser errors');
            await context.close();
        }
        // Admin hours changed after a slot was selected: forced refresh clears it before it can enter cart.
        {
            const { page, context, errors } = await setup('customer', []);
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 1');
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            await page.locator('[data-dash-book-slot="10"]').click();
            await page.evaluate(() => { window.__reservationQa.rules.close_hour = 10; });
            await page.locator('[data-dash-book-add]').click();
            await page.waitForTimeout(100);
            assert.equal(await page.locator('[data-dash-book-cart-count]').innerText(), '0 items', 'stale slot was not added');
            assert.deepEqual(errors, [], 'changed opening hours browser errors');
            await context.close();
        }
        // Fallback operating hours are display-only and cannot produce a bookable slot.
        {
            const { page, context, errors } = await setup('customer', []);
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 1');
            await page.evaluate(() => { window.__reservationQa.rulesRpcError = { message: 'offline' }; });
            await page.locator('[data-dash-book-date]').fill('2026-09-26');
            await page.waitForTimeout(100);
            assert.equal(await page.locator('[data-dash-book-slot]').count(), 0, 'non-authoritative hours expose no slots');
            assert.equal(await page.locator('[data-dash-book-add]').isEnabled(), false, 'fallback hours cannot be added');
            assert.deepEqual(errors, [], 'fallback hours browser errors');
            await context.close();
        }
        // Missing authoritative court inventory stays unavailable even when fallback court records exist.
        {
            const { page, context, errors } = await setup('customer', [], null, true);
            await page.locator('[data-dash-nav="booking"]').first().click();
            assert.equal(await page.locator('[data-dash-book-sport]').count(), 0, 'fallback inventory does not create sport choices');
            assert.equal(await page.locator('[data-dash-book-slots] [data-dash-book-slot]').count(), 0, 'no fallback inventory slots');
            assert.deepEqual(errors, [], 'non-authoritative inventory browser errors');
            await context.close();
        }
        // Owner-configured opening hours define the visible chips; a closed date exposes none.
        {
            const { page, context, errors, checkoutCalls } = await setup('customer', [], null, false, true);
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 1');
            await page.evaluate(() => { window.__reservationQa.rules = { open_hour: 9, close_hour: 12, is_closed: false, grace_minutes: 30, timezone: 'Asia/Manila' }; });
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="9"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('[data-dash-book-slot]').count(), 3, 'only configured 9–12 hours are offered');
            assert.equal(await page.locator('[data-dash-book-slot="8"]').count(), 0, 'hours before opening are omitted');
            assert.equal(await page.locator('[data-dash-book-slot="12"]').count(), 0, 'closing boundary is omitted');
            await customerChooseHours(page, [11]);
            await customerSubmit(page);
            await page.waitForTimeout(100);
            assert.equal(checkoutCalls.length, 1);
            assert.equal((Date.parse(checkoutCalls[0].options.body.items[0].starts_at) - Date.parse(`${tomorrow}T00:00:00+08:00`)) / 3600000, 11);
            await context.close();

            const closed = await setup('customer', []);
            await closed.page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(closed.page, 'Basketball', 'Basketball', 'Court 1');
            await closed.page.evaluate(() => { window.__reservationQa.rules = { open_hour: 9, close_hour: 12, is_closed: true, grace_minutes: 30, timezone: 'Asia/Manila' }; });
            await closed.page.locator('[data-dash-book-date]').fill('2026-09-26');
            await closed.page.waitForTimeout(100);
            assert.equal(await closed.page.locator('[data-dash-book-slot]').count(), 0, 'closed date has no slots');
            assert.equal(await closed.page.locator('[data-dash-book-add]').isEnabled(), false, 'closed date cannot enter the cart');
            assert.deepEqual(closed.errors, [], 'configured/closed hours browser errors');
            await closed.context.close();
        }
        {
            const { page, context, errors, checkoutCalls } = await setup('customer', []);
            page.on('dialog', dialog => dialog.accept());
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Basketball', 'Basketball', 'Court 1');
            for (const unit of ['Court 1', 'Court 2']) {
                if (unit === 'Court 2') {
                    await customerChooseCourt(page, 'Basketball', 'Basketball', unit);
                }
                await page.locator('[data-dash-book-date]').fill(tomorrow);
                await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
                await customerChooseHours(page, [10]);
            }
            assert.equal(await page.locator('[data-dash-book-cart-count]').innerText(), '2 items');
            await customerSubmit(page);
            await page.waitForTimeout(300);
            assert.equal(checkoutCalls.length, 1, 'two items share one checkout');
            assert.equal(checkoutCalls[0].options.body.items.length, 2);
            assert.deepEqual(errors, [], 'cart checkout browser errors');
            await context.close();
        }
        {
            const { page, context, errors, checkoutCalls } = await setup('customer', [], null, false, false, true);
            page.on('dialog', dialog => dialog.accept());
            await page.locator('[data-dash-nav="booking"]').first().click();
            await customerChooseCourt(page, 'Bowling — Duckpin', 'Bowling — Duckpin', 'Lane 1');
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            await customerChooseHours(page, [10, 11]);
            await customerSubmit(page);
            await page.waitForTimeout(300);
            assert.equal(checkoutCalls.length, 1);
            assert.equal(checkoutCalls[0].options.body.items[0].rate_quantity, 2);
            const interval = checkoutCalls[0].options.body.items[0];
            assert.equal((Date.parse(interval.ends_at) - Date.parse(interval.starts_at)) / 60000, 120);
            assert.deepEqual(errors, [], 'bowling set browser errors');
            await context.close();
        }
        // Duckpin and Ten-Pin render as separate customer choices, each selecting only its own court and availability.
        {
            const heldDuckpinLane = occupied('online', 'Bowling — Duckpin', 'Lane 1', tomorrow, 10);
            const { page, context, errors } = await setup('customer', [heldDuckpinLane]);
            await page.locator('[data-dash-nav="booking"]').first().click();
            const duckpin = page.locator('[data-dash-book-sport="bowling-duckpin"]');
            const tenpin = page.locator('[data-dash-book-sport="bowling-tenpin"]');
            assert.equal(await duckpin.locator('.dash-book-sport-name').innerText(), 'Bowling — Duckpin');
            assert.equal(await tenpin.locator('.dash-book-sport-name').innerText(), 'Bowling — Ten-Pin');
            await duckpin.click();
            assert.deepEqual(await values(page.locator('[data-dash-book-select]')), ['Bowling — Duckpin']);
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('[data-dash-book-slot="10"]').isDisabled(), true, 'Duckpin lane hold blocks Duckpin availability');
            await page.locator('[data-dash-booking-modal-close]').last().click();
            await tenpin.click();
            assert.deepEqual(await values(page.locator('[data-dash-book-select]')), ['Bowling — Ten-Pin']);
            await page.locator('[data-dash-book-date]').fill(tomorrow);
            await page.locator('[data-dash-book-slot="10"]').waitFor({ state: 'visible' });
            assert.equal(await page.locator('[data-dash-book-slot="10"]').isDisabled(), false, 'Duckpin hold does not block Ten-Pin availability');
            assert.deepEqual(errors, [], 'separate bowling choices browser errors');
            await context.close();
        }
        console.log('PASS reservation QA UI: physical availability, one PayMongo cart checkout, no unpaid customer booking, bowling set duration');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
