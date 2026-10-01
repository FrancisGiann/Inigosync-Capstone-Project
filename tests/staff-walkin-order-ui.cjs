// Staff walk-in order and Manila-day UI fixture. Uses an in-memory Supabase
// mock only; no production/test payment account, inserts, or network writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const courts = [
    { id: 'listing-badminton', name: 'Badminton', sportName: 'Badminton', bookableUnits: [{ id: 'unit-b1', label: 'Court 1', rateDay: 100, rateUnit: '/hr' }] },
    { id: 'listing-basketball', name: 'Basketball', sportName: 'Basketball', bookableUnits: [{ id: 'unit-b2', label: 'Court 2', rateDay: 150, rateUnit: '/hr' }] },
];

function fixture(config) {
    window.__walkinQa = { calls: [], reads: [], config, createdItems: [], checkoutAttempts: 0, acknowledgmentAttempts: 0, markAllReadCount: 0 };
    const qa = window.__walkinQa;
    const profiles = [
        { id: 'qa-staff', role: 'staff', status: 'active', full_name: 'QA Staff', email: 'staff@example.test', contact_num: '', contact_num_validated: false, contact_num_validated_at: null },
        { id: 'qa-customer', role: 'customer', status: 'active', full_name: 'QA Customer', email: 'customer@example.test', contact_num: '+639171234567' },
    ];
    const resultFor = (table, query) => {
        if (query.write) {
            qa.calls.push({ kind: query.write, table, payload: query.payload });
            if (table === 'profiles' && query.write === 'update') {
                const idFilter = query.filters.find(([key, op]) => key === 'id' && op === 'eq');
                const profile = profiles.find(row => idFilter && String(row.id) === String(idFilter[2]));
                if (profile) {
                    const previousNumber = profile.contact_num;
                    Object.assign(profile, query.payload);
                    if (Object.prototype.hasOwnProperty.call(query.payload, 'contact_num') && query.payload.contact_num !== previousNumber) {
                        profile.contact_num_validated = Boolean(query.payload.contact_num);
                        profile.contact_num_validated_at = query.payload.contact_num ? new Date().toISOString() : null;
                    }
                }
            }
            return { data: [], error: null };
        }
        qa.reads.push(table);
        let rows = table === 'booking' ? [...(config.bookings || [])]
            : table === 'walk_in_booking' ? [...(config.walkins || [])]
                : table === 'profiles' ? profiles.filter(profile => query.filters.every(([key, op, value]) => op !== 'eq' || String(profile[key]) === String(value)))
                    : table === 'app_settings' ? [{ cash_enabled: true, card_enabled: true, gcash_enabled: true, downpayment_pct: 50, night_rate_starts_at: '18:00:00' }]
                        : [];
        for (const [key, op, value] of query.filters) {
            if (key !== 'time_date') continue;
            if (op === 'gte') rows = rows.filter(row => String(row.time_date) >= String(value));
            if (op === 'lt') rows = rows.filter(row => String(row.time_date) < String(value));
        }
        return { data: query.one ? (rows[0] || null) : rows, error: null };
    };
    window.sb = {
        from(table) {
            const query = { write: null, payload: null, one: false, filters: [] };
            const chain = {
                select() { return chain; },
                eq(key, value) { query.filters.push([key, 'eq', value]); return chain; },
                in(key, value) { query.filters.push([key, 'in', value]); return chain; },
                gte(key, value) { query.filters.push([key, 'gte', value]); return chain; },
                gt(key, value) { query.filters.push([key, 'gt', value]); return chain; },
                lt(key, value) { query.filters.push([key, 'lt', value]); return chain; },
                lte(key, value) { query.filters.push([key, 'lte', value]); return chain; },
                is() { return chain; }, or() { return chain; }, order() { return chain; }, limit() { return chain; }, range() { return chain; },
                single() { query.one = true; return Promise.resolve(resultFor(table, query)); },
                maybeSingle() { query.one = true; return Promise.resolve(resultFor(table, query)); },
                update(payload) { query.write = 'update'; query.payload = payload; return chain; },
                insert(payload) { query.write = 'insert'; query.payload = payload; return chain; },
                then(resolve, reject) { return Promise.resolve(resultFor(table, query)).then(resolve, reject); },
            };
            return chain;
        },
        async rpc(name, args) {
            qa.calls.push({ kind: 'rpc', name, args });
            if (window.__qaRecord) await window.__qaRecord({ kind: 'rpc', name, args });
            if (name === 'booking_rules_for_date') return config.hoursUnavailable
                ? { data: null, error: { message: 'rules unavailable in fixture' } }
                : { data: { open_hour: 8, close_hour: 20, is_closed: false, grace_minutes: config.graceMinutes ?? 30, timezone: 'Asia/Manila' }, error: null };
            if (name === 'court_occupancy') return { data: [], error: null };
            if (name === 'staff_create_walkin_order_quoted') {
                qa.createdItems = args.p_items;
                return { data: { order_id: 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526', status: args.p_payment_method === 'cash' ? 'paid' : 'pending', base_minor: config.orderBaseMinor ?? 35000, amount_total: 350 }, error: null };
            }
            if (name === 'get_walkin_order_acknowledgment') {
                qa.acknowledgmentAttempts += 1;
                if (config.ackError) return { data: null, error: { message: 'Acknowledgment access denied in fixture' } };
                const paymentStatus = config.ackPaidAfter
                    ? (qa.acknowledgmentAttempts >= config.ackPaidAfter ? 'paid' : 'pending')
                    : (config.paymentStatus || 'paid');
                return { data: {
                    receipt_id: 'qa-receipt', receipt_number: 'QA-001', issued_at: new Date().toISOString(), customer_name: 'Guest Customer',
                    items: qa.createdItems.length ? qa.createdItems.map((item, index) => ({ sport: index ? 'Basketball' : 'Badminton', court: index ? 'Basketball' : 'Badminton', unit: index ? 'Court 2' : 'Court 1', starts_at: item.starts_at, ends_at: item.ends_at, subtotal_minor: (index ? 150 : 200) * 100 })) : (config.ackItems || []),
                    court_subtotal_minor: 35000, amount_paid_minor: 35000, remaining_balance_minor: 0,
                    fee_minor: 0, gross_minor: 35000, subtotal: 350, fee: 0, total: 350,
                    payment_method: config.paymentMethod || 'Cash', payment_status: paymentStatus,
                    disclaimer: 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.',
                }, error: null };
            }
            if (name === 'staff_get_transaction_payment_history') return { data: { source: args.p_source, id: args.p_id, payment_history: config.paymentHistory || [] }, error: null };
            if (name === 'staff_list_notifications') {
                const rows = config.notifications || [];
                const search = String(args.p_search || '').toLowerCase();
                const matches = rows.filter(row => !search || `${row.title || ''} ${row.body || ''}`.toLowerCase().includes(search));
                return { data: {
                    total_count: matches.length,
                    unread_count: rows.filter(row => !row.read_at).length,
                    rows: matches.slice(args.p_offset || 0, (args.p_offset || 0) + (args.p_limit || 20)),
                }, error: null };
            }
            if (name === 'staff_mark_all_notifications_read') {
                if (config.markAllNotificationsError) return { data: null, error: { message: 'Notification access denied in fixture' } };
                const rows = config.notifications || [];
                qa.markAllReadCount = rows.filter(row => !row.read_at).length;
                const readAt = new Date().toISOString();
                config.notifications = rows.map(row => row.read_at ? row : { ...row, read_at: readAt });
                return { data: qa.markAllReadCount, error: null };
            }
            if (name === 'mark_notification_read') {
                if (config.markNotificationReadError) return { data: null, error: { message: 'Notification read denied in fixture' } };
                config.notifications = (config.notifications || []).map(row => row.key === args.p_key ? { ...row, read_at: new Date().toISOString() } : row);
                return { data: true, error: null };
            }
            if (name === 'staff_customer_activity') return { data: { total_count: 0, rows: [] }, error: null };
            return { data: [], error: null };
        },
        functions: { invoke: async (name, options) => {
            qa.calls.push({ kind: 'function', name, options });
            if (window.__qaRecord) await window.__qaRecord({ kind: 'function', name, options });
            if (name === 'validate-contact-phone') {
                if (config.phoneValidationError) return { data: null, error: config.phoneValidationError };
                const local = String(options.body.phone || '').replace(/[^0-9]/g, '');
                const normalized = config.phoneValidation?.normalized || (local.startsWith('09') ? `+63${local.slice(1)}` : options.body.phone);
                return { data: config.phoneValidation || { valid: true, normalized, phone_type: 'mobile', line_status: 'active' }, error: null };
            }
            qa.checkoutAttempts += 1;
            if (config.failCheckoutOnce && qa.checkoutAttempts === 1) return { data: null, error: { message: 'Temporary checkout error' } };
            return { data: {
                order_id: options.body.order_id, attempt_id: 'qa-attempt',
                checkout_url: config.checkoutUrl || 'https://checkout.paymongo.com/qa-walkin',
                base_minor: config.checkoutBaseMinor ?? 35000,
                expires_at: config.checkoutExpiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                channel: options.body.channel || config.retryChannel || null, session_id: 'qa-session',
            }, error: null };
        } },
        auth: {
            getSession: async () => ({ data: { session: { user: { id: 'qa-staff', email: 'staff@example.test' } } } }),
            getUser: async () => ({ data: { user: { id: 'qa-staff' } } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({}),
            signInWithPassword: async () => ({ error: null }),
            updateUser: async payload => { qa.calls.push({ kind: 'auth', name: 'updateUser', payload }); return { error: null }; },
            verifyOtp: async payload => { qa.calls.push({ kind: 'auth', name: 'verifyOtp', payload }); return { error: null }; },
        },
    };
}

function courtsFixture() {
    return `window.InigoCourtsData={getCourts:async()=>${JSON.stringify(courts)},getSports:async()=>[],resolveCourtUnits:c=>({pickerLabel:'Choose a court',units:c.bookableUnits}),invalidateCourts(){},monogramFor:()=>'',slugify:s=>s};`;
}

async function openStaffPage(browser, { timezoneId, now, config = {}, query = '', pauseClock = false }) {
    const context = await browser.newContext({ timezoneId, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.clock.install({ time: new Date(now) });
    if (pauseClock) await page.clock.pauseAt(new Date(now));
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/includes/loadingOverlay.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.__toastMessages=[];window.InigoLoading={show(){},hide(){}};window.InigoToast={show(message,isError){window.__toastMessages.push({message,isError:Boolean(isError)});}};` }));
    await page.route('**/Config/supabaseClient.js', route => route.fulfill({ contentType: 'application/javascript', body: `(${fixture})(${JSON.stringify(config)});` }));
    await page.route('**/includes/authGuard.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.inigosyncProfile={id:'qa-staff',role:'staff',status:'active',full_name:'QA Staff',email:'staff@example.test'};document.addEventListener('DOMContentLoaded',()=>{window.InigoLoading?.hide();document.documentElement.classList.remove('inigo-auth-pending');document.dispatchEvent(new CustomEvent('inigosync:profile-ready',{detail:window.inigosyncProfile}));});` }));
    await page.route('**/includes/appSettings.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.InigoAppSettings={DEFAULT_SETTINGS:{downpaymentPct:50,cashEnabled:true,cardEnabled:true,gcashEnabled:true},getSettings:async()=>({downpaymentPct:50,cashEnabled:true,cardEnabled:true,gcashEnabled:true,nightRateStartsAt:'18:00'})};` }));
    await page.route('**/includes/courtsData.js', route => route.fulfill({ contentType: 'application/javascript', body: courtsFixture() }));
    const baseUrl = (process.env.STAFF_WALKIN_UI_BASE_URL || 'http://127.0.0.1:4178').replace(/\/+$/, '');
    await page.goto(`${baseUrl}/Pages/staff_dashboard.html${query}`, { waitUntil: 'domcontentloaded' });
    return { context, page };
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const errors = [];
        const { context, page } = await openStaffPage(browser, { timezoneId: 'Pacific/Honolulu', now: '2026-09-27T01:30:00Z', pauseClock: true });
        page.on('pageerror', error => errors.push(error.message));
        await page.locator('[data-staff-nav="walkin"]').click();
        await page.locator('[data-staff-walkin-name]').fill('Guest Customer');
        await page.locator('[data-staff-walkin-next]').click();
        await page.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await page.locator('[data-staff-walkin-next]').click();
        await page.locator('[data-staff-walkin-hour="9"]').waitFor();
        await page.locator('[data-staff-walkin-duration]').selectOption('2');
        await page.locator('[data-staff-walkin-hour="9"]').click();
        await page.locator('[data-staff-walkin-add-line]').click();
        await page.locator('[data-staff-walkin-sport="listing-basketball"]').click();
        await page.locator('[data-staff-walkin-next]').click();
        await page.locator('[data-staff-walkin-hour="12"]').waitFor();
        await page.locator('[data-staff-walkin-hour="12"]').click();
        await page.locator('[data-staff-walkin-next]').click();
        await page.locator('[data-staff-walkin-next]').click();
        const reviewRows = page.locator('[data-staff-walkin-review-lines] .staff-walkin-review-line');
        await reviewRows.nth(1).waitFor();
        const lineCount = await reviewRows.count();
        assert.equal(lineCount, 2, 'review should show both reservation lines');
        assert.match(await page.locator('[data-staff-walkin-summary-total]').innerText(), /₱350\.00/);
        await page.locator('[data-staff-walkin-save]').click();
        await page.locator('[data-staff-walkin-receipt]').getByText('Payment acknowledgment and entry pass').waitFor();
        const saved = await page.evaluate(() => ({
            createCalls: window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_create_walkin_order_quoted'),
            legacyCalls: window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_create_walkin_order'),
            ackCalls: window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'get_walkin_order_acknowledgment'),
            writes: window.__walkinQa.calls.filter(call => call.table === 'walk_in_booking' && ['insert', 'update'].includes(call.kind)),
            items: window.__walkinQa.createdItems,
        }));
        assert.equal(saved.createCalls.length, 1, 'one atomic RPC must create the whole multi-line order');
        assert.equal(saved.legacyCalls.length, 0, 'the browser must not call the legacy RPC without the reviewed price check');
        assert.equal(saved.items.length, 2);
        assert.deepEqual(saved.items.map(item => item.quoted_minor), [20000, 15000], 'each line sends the price shown at review in minor units');
        assert.deepEqual(saved.items.map(item => item.starts_at), ['2026-09-27T01:00:00.000Z', '2026-09-27T04:00:00.000Z'], 'slot timestamps should use Manila wall time even when device timezone is Honolulu');
        assert.equal(saved.ackCalls.length, 1, 'cash receipt is fetched from the canonical acknowledgment RPC');
        assert.deepEqual(saved.writes, [], 'the browser must not write walk_in_booking rows directly');
        await context.close();

        const online = await openStaffPage(browser, { timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z' });
        const onlineCalls = [];
        await online.page.exposeFunction('__qaRecord', call => onlineCalls.push(call));
        online.page.on('dialog', dialog => dialog.accept());
        await online.page.route('https://checkout.paymongo.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>PayMongo test checkout fixture</title>' }));
        await online.page.locator('[data-staff-nav="walkin"]').click();
        await online.page.locator('[data-staff-walkin-name]').fill('Online Guest');
        await online.page.locator('[data-staff-walkin-next]').click();
        await online.page.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await online.page.locator('[data-staff-walkin-next]').click();
        await online.page.locator('[data-staff-walkin-hour="10"]').click();
        await online.page.locator('[data-staff-walkin-next]').click();
        await online.page.locator('[data-staff-walkin-online-option]').click();
        await online.page.locator('[data-staff-walkin-next]').click();
        await online.page.locator('[data-staff-walkin-save]').click();
        await online.page.waitForURL('https://checkout.paymongo.com/qa-walkin');
        assert.ok(onlineCalls.some(call => call.kind === 'rpc' && call.name === 'staff_create_walkin_order_quoted' && call.args.p_payment_method === 'paymongo'));
        assert.ok(onlineCalls.some(call => call.kind === 'function' && call.name === 'staff-walkin-checkout' && call.options.body.order_id === 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526'));
        assert.equal(onlineCalls.some(call => call.kind === 'rpc' && call.name === 'get_walkin_order_acknowledgment'), false, 'online redirect must not fabricate a paid acknowledgment');
        await online.context.close();

        const qrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { paymentStatus: 'pending', ackPaidAfter: 2, paymentMethod: 'PayMongo', orderBaseMinor: 37000, checkoutBaseMinor: 37500 },
        });
        const qrPage = qrContext.page;
        await qrPage.locator('[data-staff-nav="walkin"]').click();
        await qrPage.locator('[data-staff-walkin-name]').fill('QR Guest');
        await qrPage.locator('[data-staff-walkin-next]').click();
        await qrPage.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await qrPage.locator('[data-staff-walkin-next]').click();
        await qrPage.locator('[data-staff-walkin-hour="11"]').click();
        await qrPage.locator('[data-staff-walkin-next]').click();
        await qrPage.locator('[data-staff-walkin-qr-option]').click();
        assert.equal(await qrPage.locator('[data-staff-walkin-summary-payment]').innerText(), 'E-wallet QR · GCash');
        await qrPage.locator('[data-staff-walkin-next]').click();
        await qrPage.locator('[data-staff-walkin-save]').click();
        await qrPage.locator('[data-staff-walkin-qr-image] svg').waitFor();
        assert.match(await qrPage.locator('.staff-walkin-qr-card').innerText(), /Amount before processing fee\s+₱375\.00/, 'QR amount follows the server checkout charge, not the stale client estimate');
        assert.match(await qrPage.locator('[data-staff-walkin-qr-status]').innerText(), /Waiting for PayMongo payment confirmation/);
        assert.match(await qrPage.locator('[data-staff-walkin-qr-card], .staff-walkin-qr-card').innerText(), /PayMongo shows any processing fee/);
        assert.match(await qrPage.locator('.staff-walkin-qr-card').innerText(), /not a direct wallet transfer/);
        const qrSetup = await qrPage.evaluate(() => ({
            create: window.__walkinQa.calls.find(call => call.kind === 'rpc' && call.name === 'staff_create_walkin_order_quoted'),
            checkout: window.__walkinQa.calls.find(call => call.kind === 'function' && call.name === 'staff-walkin-checkout'),
            acknowledgments: window.__walkinQa.acknowledgmentAttempts,
            svgHasPath: Boolean(document.querySelector('[data-staff-walkin-qr-image] svg path')),
            remoteQrImage: Boolean(document.querySelector('[data-staff-walkin-qr-image] img[src^="https://"]')),
        }));
        assert.equal(qrSetup.create.args.p_payment_method, 'paymongo', 'QR UI maps to the PayMongo payment method for the atomic order RPC');
        assert.deepEqual(qrSetup.checkout.options.body, {
            order_id: 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526', channel: 'gcash',
        }, 'QR checkout explicitly requests the backend GCash channel');
        assert.equal(qrSetup.acknowledgments, 0, 'the pending QR is displayed without requesting or fabricating an acknowledgment');
        assert.equal(qrSetup.svgHasPath, true, 'the local QR generator renders the checkout into SVG modules');
        assert.equal(qrSetup.remoteQrImage, false, 'the QR is rendered locally without a third-party QR image service');
        await qrPage.locator('[data-staff-walkin-qr-check]').click();
        assert.equal(await qrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 1);
        assert.equal(await qrPage.locator('.staff-receipt-card').count(), 0, 'a pending status check does not show a paid acknowledgment');
        await qrPage.clock.fastForward(5000);
        await qrPage.locator('.staff-receipt-card').waitFor();
        assert.equal(await qrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 2, 'the staff screen polls again while the checkout remains in expiry window');
        await qrContext.context.close();

        const expiredQrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { paymentStatus: 'pending', checkoutExpiresAt: '2026-09-27T00:00:02Z' },
        });
        const expiredQrPage = expiredQrContext.page;
        await expiredQrPage.locator('[data-staff-nav="walkin"]').click();
        await expiredQrPage.locator('[data-staff-walkin-name]').fill('Expired QR Guest');
        await expiredQrPage.locator('[data-staff-walkin-next]').click();
        await expiredQrPage.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await expiredQrPage.locator('[data-staff-walkin-next]').click();
        await expiredQrPage.locator('[data-staff-walkin-hour="11"]').click();
        await expiredQrPage.locator('[data-staff-walkin-next]').click();
        await expiredQrPage.locator('[data-staff-walkin-qr-option]').click();
        await expiredQrPage.locator('[data-staff-walkin-next]').click();
        await expiredQrPage.locator('[data-staff-walkin-save]').click();
        await expiredQrPage.locator('[data-staff-walkin-qr-image] svg').waitFor();
        await expiredQrPage.setViewportSize({ width: 320, height: 900 });
        const qrDimensions = await expiredQrPage.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
        assert.ok(qrDimensions.document <= qrDimensions.viewport, 'the staff QR panel stays within a 320px screen');
        await expiredQrPage.clock.fastForward(2000);
        await expiredQrPage.waitForFunction(() => /Checkout expired/.test(document.querySelector('[data-staff-walkin-qr-status]')?.textContent || ''));
        assert.equal(await expiredQrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 0,
            'automatic status checks stop when PayMongo reports that checkout expired');
        await expiredQrPage.locator('[data-staff-walkin-qr-check]').click();
        assert.equal(await expiredQrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 1,
            'staff can manually verify a late payment after the checkout expiry');
        assert.equal(await expiredQrPage.locator('.staff-receipt-card').count(), 0,
            'an expired but unconfirmed checkout still has no acknowledgment');
        await expiredQrContext.context.close();

        const invalidQrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { checkoutUrl: 'https://checkout.paymongo.com.attacker.test/session' },
        });
        const invalidQrPage = invalidQrContext.page;
        await invalidQrPage.locator('[data-staff-nav="walkin"]').click();
        await invalidQrPage.locator('[data-staff-walkin-name]').fill('Invalid URL Guest');
        await invalidQrPage.locator('[data-staff-walkin-next]').click();
        await invalidQrPage.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await invalidQrPage.locator('[data-staff-walkin-next]').click();
        await invalidQrPage.locator('[data-staff-walkin-hour="11"]').click();
        await invalidQrPage.locator('[data-staff-walkin-next]').click();
        await invalidQrPage.locator('[data-staff-walkin-qr-option]').click();
        await invalidQrPage.locator('[data-staff-walkin-next]').click();
        await invalidQrPage.locator('[data-staff-walkin-save]').click();
        await invalidQrPage.getByText('GCash QR unavailable').waitFor();
        assert.equal(await invalidQrPage.locator('[data-staff-walkin-qr-image]').count(), 0, 'a lookalike hostname is never encoded into a QR');
        assert.equal(await invalidQrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 0, 'invalid checkout data never triggers an acknowledgment lookup');
        await invalidQrContext.context.close();

        const ackItem = [{ sport: 'Badminton', court: 'Badminton', unit: 'Court 1', starts_at: '2026-09-27T01:00:00Z', ends_at: '2026-09-27T02:00:00Z', subtotal_minor: 10000 }];
        const pendingReturn = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:30:00Z', query: '?walkin_checkout=return&order=a25dc45b-40ba-4b5b-96d6-4487dbe7a526',
            config: { paymentStatus: 'pending', paymentMethod: 'PayMongo', ackItems: ackItem },
        });
        await pendingReturn.page.locator('.staff-receipt-pending').waitFor();
        assert.equal(await pendingReturn.page.locator('.staff-receipt-card').count(), 0, 'return query alone must never produce a paid receipt');
        assert.equal(new URL(pendingReturn.page.url()).searchParams.has('walkin_checkout'), false, 'return markers should be removed from the address bar');
        await pendingReturn.context.close();

        const paidReturn = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:30:00Z', query: '?walkin_checkout=return&order=a25dc45b-40ba-4b5b-96d6-4487dbe7a526',
            config: { paymentStatus: 'paid', paymentMethod: 'PayMongo', ackItems: ackItem },
        });
        await paidReturn.page.locator('[data-staff-panel="walkin"].is-active .staff-receipt-card').waitFor();
        assert.equal(new URL(paidReturn.page.url()).searchParams.has('order'), false);
        assert.match(await paidReturn.page.locator('.staff-receipt-card').innerText(), /Court subtotal\s+₱350\.00/);
        assert.match(await paidReturn.page.locator('.staff-receipt-card').innerText(), /Payment received\s+₱350\.00/);
        assert.match(await paidReturn.page.locator('.staff-receipt-card').innerText(), /Remaining balance\s+₱0\.00/);
        assert.match(await paidReturn.page.locator('.staff-receipt-card').innerText(), /CUSTOMER CHARGED\s+₱350\.00/);
        await paidReturn.context.close();

        const transactionBooking = {
            booking_id: 42, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', court_unit: 'Court 1',
            time_date: '2026-09-27T01:00:00Z', end_at: '2026-09-27T02:00:00Z', duration_minutes: 60,
            status: 'confirmed', checked_in_at: null, checked_out_at: null, amount_total: 100, amount_paid: 50,
            rate_unit_snapshot: '/hr', rate_quantity: 1, payment_id: 12, payment_method: 'PayMongo',
        };
        const paymentHistory = [
            {
                payment_id: 101, created_at: '2026-09-27T00:30:00Z', method: 'PayMongo', base_minor: 5000,
                fee_minor: 250, gross_minor: 5250, net_minor: 5000, receipt_id: 'qa-deposit', receipt_number: 'PA-DEPOSIT',
                acknowledgment: {
                    receipt_id: 'qa-deposit', receipt_number: 'PA-DEPOSIT', issued_at: '2026-09-27T00:30:00Z', customer_name: 'QA Customer',
                    items: [{ sport: 'Badminton', court: 'Badminton', unit: 'Court 1', starts_at: transactionBooking.time_date, ends_at: transactionBooking.end_at, subtotal_minor: 10000 }],
                    court_subtotal_minor: 10000, amount_paid_minor: 5000, remaining_balance_minor: 5000, subtotal_minor: 5000,
                    fee_minor: 250, gross_minor: 5250, subtotal: 50, fee: 2.5, total: 52.5, payment_method: 'PayMongo', payment_status: 'paid',
                    disclaimer: 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.',
                },
            },
            {
                payment_id: 102, created_at: '2026-09-27T00:55:00Z', method: 'Cash', base_minor: 5000,
                fee_minor: 0, gross_minor: 5000, net_minor: 5000, receipt_id: 'qa-balance', receipt_number: 'PA-BALANCE',
                acknowledgment: {
                    receipt_id: 'qa-balance', receipt_number: 'PA-BALANCE', issued_at: '2026-09-27T00:55:00Z', customer_name: 'QA Customer',
                    items: [{ sport: 'Badminton', court: 'Badminton', unit: 'Court 1', starts_at: transactionBooking.time_date, ends_at: transactionBooking.end_at, subtotal_minor: 10000 }],
                    court_subtotal_minor: 10000, amount_paid_minor: 5000, remaining_balance_minor: 0, subtotal_minor: 5000,
                    fee_minor: 0, gross_minor: 5000, subtotal: 50, fee: 0, total: 50, payment_method: 'Cash', payment_status: 'paid',
                    disclaimer: 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.',
                },
            },
        ];
        const transactionContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T01:00:00Z',
            config: { bookings: [transactionBooking], paymentHistory },
        });
        const transactionPage = transactionContext.page;
        await transactionPage.locator('[data-staff-nav="transactions"]').click();
        const transactionRow = transactionPage.locator('[data-staff-table="transactions"] tbody tr[data-row-index="0"]');
        await transactionRow.waitFor();
        await transactionRow.locator('[data-staff-action="timein"]').click();
        await transactionPage.locator('[data-staff-timein-dialog]').waitFor();
        assert.equal(await transactionPage.locator('.staff-shell').evaluate(el => el.inert), true, 'time-in modal makes the dashboard background inert');
        await transactionPage.keyboard.press('Tab');
        assert.equal(await transactionPage.locator('[data-staff-timein-close]').evaluate(el => el === document.activeElement), true, 'Tab from modal dialog enters at its first control');
        await transactionPage.keyboard.press('Shift+Tab');
        assert.equal(await transactionPage.locator('[data-staff-timein-cancel]').evaluate(el => el === document.activeElement), true, 'Shift+Tab wraps to the last enabled control');
        await transactionPage.keyboard.press('Escape');
        await transactionPage.locator('[data-staff-timein-modal]').waitFor({ state: 'hidden' });
        assert.equal(await transactionPage.locator('.staff-shell').evaluate(el => el.inert), false, 'closing the modal restores background interaction');

        await transactionRow.locator('[data-staff-payment-history-load]').click();
        const paymentEntries = transactionRow.locator('.staff-payment-history-list > li');
        await paymentEntries.nth(1).waitFor();
        assert.equal(await paymentEntries.count(), 2, 'deposit and balance remain separate history entries');
        assert.match(await transactionRow.innerText(), /Base ₱50\.00/);
        assert.match(await transactionRow.innerText(), /Fee ₱2\.50/);
        await paymentEntries.nth(0).locator('[data-staff-payment-ack]').click();
        const receiptDialog = transactionPage.locator('[data-staff-receipt-dialog]');
        await receiptDialog.waitFor();
        assert.match(await transactionPage.locator('.staff-receipt-item').innerText(), /₱100\.00/, 'receipt line subtotal uses canonical subtotal_minor');
        assert.match(await receiptDialog.innerText(), /Court subtotal\s+₱100\.00/);
        assert.match(await receiptDialog.innerText(), /Payment received\s+₱50\.00/);
        assert.match(await receiptDialog.innerText(), /Remaining balance\s+₱50\.00/);
        assert.match(await receiptDialog.innerText(), /CUSTOMER CHARGED\s+₱52\.50/);
        assert.equal(await transactionPage.locator('.staff-shell').evaluate(el => el.inert), true);
        await transactionPage.keyboard.press('Shift+Tab');
        assert.equal(await transactionPage.locator('.staff-receipt-card [data-staff-receipt-close]').evaluate(el => el === document.activeElement), true, 'receipt modal Shift+Tab wraps to its last action');
        await transactionPage.keyboard.press('Tab');
        assert.equal(await receiptDialog.locator(':scope > .staff-modal-close').evaluate(el => el === document.activeElement), true, 'receipt modal Tab wraps to its first action');
        await transactionPage.keyboard.press('Escape');
        await transactionPage.locator('[data-staff-receipt-modal]').waitFor({ state: 'hidden' });
        const historyCall = await transactionPage.evaluate(() => window.__walkinQa.calls.find(call => call.name === 'staff_get_transaction_payment_history'));
        assert.deepEqual(historyCall.args, { p_source: 'booking', p_id: 42 });
        await transactionContext.context.close();

        const filterContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: {
                bookings: [{ booking_id: 51, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', court_unit: 'Court 1', time_date: '2026-09-27T01:00:00Z', end_at: '2026-09-27T02:00:00Z', status: 'confirmed', duration_minutes: 60, amount_total: 100, amount_paid: 0 }],
                walkins: [
                    { walkin_id: 81, customer_name: 'Filter Guest', sports: 'Basketball', courts: 'Basketball', court_unit: 'Court 2', time_date: '2026-09-27T03:00:00Z', end_at: '2026-09-27T04:00:00Z', status: 'completed', duration_minutes: 60 },
                    { walkin_id: 82, customer_name: 'Other Guest', sports: 'Basketball', courts: 'Basketball', court_unit: 'Court 2', time_date: '2026-09-27T05:00:00Z', end_at: '2026-09-27T06:00:00Z', status: 'completed', duration_minutes: 60 },
                ],
            },
        });
        const filterPage = filterContext.page;
        await filterPage.locator('[data-staff-nav="transactions"]').click();
        await filterPage.locator('[data-staff-table="transactions"] tbody tr[data-row-index="2"]').waitFor();
        await filterPage.locator('[data-staff-filter-group="transactions"] [data-staff-filter="walkin"]').click();
        const filterSearch = filterPage.locator('[data-staff-search="transactions"]');
        await filterSearch.fill('Filter Guest');
        const visibleTransactions = () => filterPage.locator('[data-staff-table="transactions"] tbody tr[data-row-index]').evaluateAll(rows => rows.filter(row => row.style.display !== 'none').length);
        await filterPage.waitForFunction(() => Array.from(document.querySelectorAll('[data-staff-table="transactions"] tbody tr[data-row-index]')).filter(row => row.style.display !== 'none').length === 1);
        assert.equal(await visibleTransactions(), 1);
        const bookingReadsBeforeRefresh = await filterPage.evaluate(() => window.__walkinQa.reads.filter(table => table === 'booking').length);
        await filterPage.locator('[data-staff-tx-from]').dispatchEvent('change');
        await filterPage.waitForFunction((before) => window.__walkinQa.reads.filter(table => table === 'booking').length > before, bookingReadsBeforeRefresh);
        await filterPage.waitForFunction(() => Array.from(document.querySelectorAll('[data-staff-table="transactions"] tbody tr[data-row-index]')).filter(row => row.style.display !== 'none').length === 1);
        assert.equal(await filterSearch.inputValue(), 'Filter Guest', 'search text survives transaction refresh');
        assert.equal(await filterPage.locator('[data-staff-filter-group="transactions"] [data-staff-filter="walkin"]').getAttribute('class').then(value => value.includes('is-active')), true, 'source chip remains selected after refresh');
        assert.equal(await visibleTransactions(), 1, 'refreshed rows still honor the current search and source filter');
        await filterContext.context.close();

        const pendingOrderLine = (walkin_id, time_date) => ({
            walkin_id, walkin_order_id: 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526', customer_name: 'Pending Guest',
            sports: 'Badminton', courts: 'Badminton', court_unit: 'Court 1', time_date, end_at: '2026-09-27T02:00:00Z',
            duration_minutes: 60, status: 'pending', payment_method: null, payment_id: null, amount_total: 100, amount_paid: 0,
        });
        const paidCashOrder = {
            walkin_id: 73, walkin_order_id: 'bd1686cf-59db-4a21-9ad4-674e901bd391', customer_name: 'Paid Cash Guest',
            sports: 'Badminton', courts: 'Badminton', court_unit: 'Court 1', time_date: '2026-09-27T06:00:00Z', end_at: '2026-09-27T07:00:00Z',
            duration_minutes: 60, status: 'confirmed', payment_method: 'Cash', payment_id: 801, amount_total: 100, amount_paid: 100,
        };
        const retryContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { walkins: [pendingOrderLine(71, '2026-09-27T01:00:00Z'), pendingOrderLine(72, '2026-09-27T03:00:00Z'), paidCashOrder] },
        });
        const retryPage = retryContext.page;
        const retryCalls = [];
        await retryPage.exposeFunction('__qaRecord', call => retryCalls.push(call));
        await retryPage.route('https://checkout.paymongo.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>PayMongo retry fixture</title>' }));
        retryPage.on('dialog', dialog => dialog.accept());
        await retryPage.locator('[data-staff-nav="transactions"]').click();
        assert.equal(await retryPage.locator('[data-staff-walkin-retry]').count(), 1, 'one retry action is shown per pending order');
        assert.equal(await retryPage.locator('[data-staff-table="transactions"] tbody tr').filter({ hasText: 'Paid Cash Guest' }).locator('[data-staff-walkin-retry]').count(), 0, 'paid cash walk-ins never expose an online retry');
        await retryPage.evaluate(() => { window.__walkinQa.config.failCheckoutOnce = true; });
        await retryPage.locator('[data-staff-walkin-retry]').click();
        await retryPage.locator('[data-staff-walkin-retry]').waitFor({ state: 'visible' });
        assert.equal(await retryPage.locator('[data-staff-walkin-retry]').isDisabled(), false, 'failed checkout leaves a retryable pending action');
        assert.equal(retryCalls.filter(call => call.kind === 'function' && call.name === 'staff-walkin-checkout').length, 1);
        await retryPage.locator('[data-staff-walkin-retry]').click();
        await retryPage.waitForURL('https://checkout.paymongo.com/qa-walkin');
        assert.equal(retryCalls.filter(call => call.kind === 'function' && call.name === 'staff-walkin-checkout').length, 2, 'staff can resume after a failed checkout attempt');
        await retryContext.context.close();

        const retryQrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { walkins: [pendingOrderLine(74, '2026-09-27T07:00:00Z')], retryChannel: 'gcash', checkoutBaseMinor: 10000 },
        });
        const retryQrPage = retryQrContext.page;
        retryQrPage.on('dialog', dialog => dialog.accept());
        await retryQrPage.locator('[data-staff-nav="transactions"]').click();
        await retryQrPage.locator('[data-staff-walkin-retry]').click();
        await retryQrPage.locator('.staff-walkin-qr-card [data-staff-walkin-qr-image] svg').waitFor();
        assert.equal(await retryQrPage.locator('[data-staff-panel="walkin"]').evaluate(panel => panel.classList.contains('is-active')), true,
            'a saved GCash checkout retry returns staff to the walk-in QR screen');
        assert.equal(new URL(retryQrPage.url()).pathname, '/Pages/staff_dashboard.html', 'a GCash QR retry does not redirect the staff browser');
        assert.match(await retryQrPage.locator('.staff-walkin-qr-card').innerText(), /₱100\.00/, 'retry QR uses the pending order amount when available');
        assert.equal(await retryQrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 0,
            'retrying a pending QR does not show an acknowledgment before payment confirmation');
        await retryQrContext.context.close();

        const unreadNotifications = Array.from({ length: 18 }, (_, index) => ({
            key: `notice-${index + 1}`, title: `Notice ${index + 1}`, body: 'Unread staff update', category: 'booking',
            created_at: '2026-09-27T00:00:00Z', read_at: null,
        }));
        const notificationsContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', config: { notifications: unreadNotifications },
        });
        const notificationsPage = notificationsContext.page;
        await notificationsPage.waitForFunction(() => document.querySelector('[data-staff-notif-dot]')?.hidden === false);
        assert.equal(await notificationsPage.locator('[data-staff-notif-list] [data-staff-notif-item]').count(), 15, 'bell initially displays one page of notifications');
        await notificationsPage.locator('[data-staff-notif-trigger]').click();
        await notificationsPage.locator('[data-staff-notif-mark-all]').click();
        await notificationsPage.waitForFunction(() => document.querySelector('[data-staff-notif-dot]')?.hidden === true);
        const markAllResult = await notificationsPage.evaluate(() => ({
            calls: window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_mark_all_notifications_read').length,
            count: window.__walkinQa.markAllReadCount,
            everyNoticeRead: window.__walkinQa.config.notifications.every(row => Boolean(row.read_at)),
        }));
        assert.equal(markAllResult.calls, 1, 'mark all uses the server-side whole-feed RPC');
        assert.equal(markAllResult.count, 18, 'server action marks notices beyond the first 15');
        assert.equal(markAllResult.everyNoticeRead, true);
        assert.equal(await notificationsPage.locator('[data-staff-notif-mark-all]').isDisabled(), false, 'mark all action is re-enabled after completion');
        await notificationsContext.context.close();

        const notificationErrorContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { notifications: [{ key: 'blocked-notice', title: 'Blocked', body: '', category: 'booking', created_at: '2026-09-27T00:00:00Z', read_at: null }], markAllNotificationsError: true },
        });
        const notificationErrorPage = notificationErrorContext.page;
        await notificationErrorPage.waitForFunction(() => document.querySelector('[data-staff-notif-dot]')?.hidden === false);
        await notificationErrorPage.locator('[data-staff-notif-trigger]').click();
        await notificationErrorPage.locator('[data-staff-notif-mark-all]').click();
        await notificationErrorPage.waitForFunction(() => window.__toastMessages.some(message => message.isError));
        assert.equal(await notificationErrorPage.locator('[data-staff-notif-mark-all]').isDisabled(), false);
        assert.equal(await notificationErrorPage.locator('[data-staff-notif-dot]').evaluate(el => el.hidden), false, 'failed mark-all keeps unread state visible');
        assert.equal(await notificationErrorPage.evaluate(() => window.__walkinQa.config.notifications[0].read_at), null, 'failed mark-all does not change local notification state');
        await notificationErrorContext.context.close();

        const singleNotificationErrorContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { notifications: [{ key: 'failed-read', title: 'Needs attention', body: 'A booking update', category: 'booking', href: '#walkin', created_at: '2026-09-27T00:00:00Z', read_at: null }], markNotificationReadError: true },
        });
        const singleNotificationErrorPage = singleNotificationErrorContext.page;
        await singleNotificationErrorPage.waitForFunction(() => document.querySelector('[data-staff-notif-dot]')?.hidden === false);
        const notificationListCallsBefore = await singleNotificationErrorPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_list_notifications').length);
        await singleNotificationErrorPage.locator('[data-staff-notif-trigger]').click();
        await singleNotificationErrorPage.locator('[data-staff-notif-item]').click();
        await singleNotificationErrorPage.waitForFunction(() => window.__toastMessages.some(message => message.message === 'Notification read denied in fixture'));
        assert.equal(await singleNotificationErrorPage.locator('[data-staff-panel="overview"]').evaluate(el => el.classList.contains('is-active')), true, 'failed read does not navigate away from the current panel');
        assert.equal(await singleNotificationErrorPage.locator('[data-staff-panel="walkin"]').evaluate(el => el.classList.contains('is-active')), false);
        assert.equal(await singleNotificationErrorPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_list_notifications').length), notificationListCallsBefore, 'failed read does not reload notification lists');
        assert.equal(await singleNotificationErrorPage.locator('[data-staff-notif-dot]').evaluate(el => el.hidden), false, 'failed read keeps unread indicator visible');
        await singleNotificationErrorContext.context.close();

        const closedRules = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', config: { hoursUnavailable: true },
        });
        await closedRules.page.locator('[data-staff-nav="walkin"]').click();
        await closedRules.page.locator('[data-staff-walkin-name]').fill('No Rules Guest');
        await closedRules.page.locator('[data-staff-walkin-next]').click();
        await closedRules.page.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await closedRules.page.locator('[data-staff-walkin-next]').click();
        await closedRules.page.getByText('Operating hours could not be verified. Try again before creating this order.').waitFor();
        assert.equal(await closedRules.page.locator('[data-staff-walkin-hour]').count(), 0, 'fallback hours are never advertised as bookable');
        assert.equal(await closedRules.page.locator('[data-staff-walkin-next]').isDisabled(), true, 'walk-in cannot proceed without authoritative operating hours');
        await closedRules.context.close();

        const graceExpired = await openStaffPage(browser, {
            timezoneId: 'Pacific/Honolulu', now: '2026-09-27T01:16:00Z', config: { graceMinutes: 15 }, pauseClock: true,
        });
        await graceExpired.page.locator('[data-staff-nav="walkin"]').click();
        await graceExpired.page.locator('[data-staff-walkin-name]').fill('Grace Deadline Guest');
        await graceExpired.page.locator('[data-staff-walkin-next]').click();
        await graceExpired.page.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await graceExpired.page.locator('[data-staff-walkin-next]').click();
        const expiredCurrentHour = graceExpired.page.locator('[data-staff-walkin-hour="9"]');
        await expiredCurrentHour.waitFor();
        assert.equal(await expiredCurrentHour.isDisabled(), true, 'current-hour walk-in start expires after the server-configured grace period');
        assert.match(await expiredCurrentHour.innerText(), /Unavailable/);
        assert.equal(await graceExpired.page.locator('[data-staff-walkin-hour="10"]').isDisabled(), false, 'future hours remain available after the current slot grace deadline');
        await graceExpired.context.close();

        const eveningGrace = await openStaffPage(browser, {
            timezoneId: 'Pacific/Honolulu', now: '2026-09-27T11:59:00Z', config: { graceMinutes: 30 }, pauseClock: true,
        });
        await eveningGrace.page.locator('[data-staff-nav="walkin"]').click();
        await eveningGrace.page.locator('[data-staff-walkin-name]').fill('Evening Grace Guest');
        await eveningGrace.page.locator('[data-staff-walkin-next]').click();
        await eveningGrace.page.locator('[data-staff-walkin-sport="listing-badminton"]').click();
        await eveningGrace.page.locator('[data-staff-walkin-next]').click();
        const lastHourSlot = eveningGrace.page.locator('[data-staff-walkin-hour="19"]');
        await lastHourSlot.waitFor();
        assert.equal(await lastHourSlot.isDisabled(), true, 'the 7–8 PM slot is unavailable at 7:59 PM after its 30-minute grace period');
        assert.match(await lastHourSlot.innerText(), /Unavailable/);
        assert.equal(await eveningGrace.page.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'booking_rules_for_date').every(call => call.args.p_date === '2026-09-27')), true, 'the rule lookup uses the Manila booking date while the device timezone is Honolulu');
        await eveningGrace.context.close();

        const phoneContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { phoneValidation: { valid: true, normalized: '+639171234567', phone_type: 'mobile', line_status: 'active' } },
        });
        const phonePage = phoneContext.page;
        await phonePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await phonePage.setViewportSize({ width: 360, height: 780 });
        const phoneLayout = await phonePage.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
        assert.ok(phoneLayout.document <= phoneLayout.viewport, `contact settings fit 360px viewport (${JSON.stringify(phoneLayout)})`);
        assert.equal(await phonePage.locator('[data-staff-phone-validate]').count(), 0, 'phone validation is part of the single Save Changes flow');
        const phoneInput = phonePage.locator('[data-staff-settings-mobile]');
        await phoneInput.fill('0917 123 4567');
        await phonePage.locator('[data-staff-settings-save="profile"]').click();
        await phonePage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'update' && call.table === 'profiles'));
        const phoneSave = await phonePage.evaluate(() => ({
            validation: window.__walkinQa.calls.filter(call => call.kind === 'function' && call.name === 'validate-contact-phone'),
            update: window.__walkinQa.calls.find(call => call.kind === 'update' && call.table === 'profiles'),
            otpCalls: window.__walkinQa.calls.filter(call => call.kind === 'auth' && ['updateUser', 'verifyOtp'].includes(call.name)),
        }));
        assert.equal(phoneSave.validation.length, 1);
        assert.deepEqual(phoneSave.validation[0].options.body, { phone: '09171234567' });
        assert.equal(phoneSave.update.payload.contact_num, '+639171234567', 'persist the validator returned E.164 value exactly');
        assert.deepEqual(phoneSave.otpCalls, [], 'staff contact validation no longer uses SMS OTP');
        assert.match(await phonePage.locator('[data-staff-phone-status]').innerText(), /Saved number format\/type check passed/i, 'settings display the server validation fields after save');
        assert.match(await phonePage.locator('[data-staff-phone-status]').innerText(), /ownership and reachability are not verified/i);
        await phoneContext.context.close();

        const phoneUnavailableContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { phoneValidationError: { message: 'Service Unavailable', status: 503 } },
        });
        const phoneUnavailablePage = phoneUnavailableContext.page;
        await phoneUnavailablePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await phoneUnavailablePage.locator('[data-staff-settings-mobile]').fill('09171234567');
        await phoneUnavailablePage.locator('[data-staff-settings-save="profile"]').click();
        await phoneUnavailablePage.waitForFunction(() => window.__toastMessages.some(message => /Phone validation is unavailable/.test(message.message)));
        assert.equal(await phoneUnavailablePage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'an unavailable validation API prevents profile writes');
        await phoneUnavailableContext.context.close();

        const inactivePhoneContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { phoneValidation: { valid: false, reason: 'inactive', normalized: '+639171234567', phone_type: 'mobile', line_status: 'inactive' } },
        });
        const inactivePhonePage = inactivePhoneContext.page;
        await inactivePhonePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await inactivePhonePage.locator('[data-staff-settings-mobile]').fill('09171234567');
        await inactivePhonePage.locator('[data-staff-settings-save="profile"]').click();
        await inactivePhonePage.waitForFunction(() => window.__toastMessages.some(message => /classified this number as inactive/.test(message.message)));
        assert.equal(await inactivePhonePage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'provider inactive status prevents all profile writes');
        await inactivePhoneContext.context.close();

        const boundaryBookings = [
            { booking_id: 1, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', time_date: '2026-09-27T14:30:00Z', status: 'confirmed', duration_minutes: 60 },
            { booking_id: 2, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', time_date: '2026-09-27T15:30:00Z', status: 'confirmed', duration_minutes: 60 },
            { booking_id: 3, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', time_date: '2026-09-27T16:30:00Z', status: 'confirmed', duration_minutes: 60 },
        ];
        const boundaryWalkins = [
            { id: 1, customer_name: 'Prior day 1', courts: 'Basketball', time_date: '2026-09-27T14:30:00Z', status: 'completed', duration_minutes: 60 },
            { id: 2, customer_name: 'Prior day 2', courts: 'Basketball', time_date: '2026-09-27T15:30:00Z', status: 'completed', duration_minutes: 60 },
            { id: 3, customer_name: 'Today', courts: 'Basketball', time_date: '2026-09-27T16:30:00Z', status: 'confirmed', duration_minutes: 60 },
        ];
        const dayContext = await openStaffPage(browser, {
            timezoneId: 'Pacific/Honolulu', now: '2026-09-27T15:59:30Z',
            config: { bookings: boundaryBookings, walkins: boundaryWalkins },
        });
        await dayContext.page.waitForFunction(() => document.querySelector('[data-staff-stat="bookings-today"]')?.textContent.trim() === '2');
        await dayContext.page.waitForFunction(() => document.querySelector('[data-staff-stat="walkins-today"]')?.textContent.trim() === '2');
        await dayContext.page.clock.fastForward(60000);
        await dayContext.page.waitForFunction(() => document.querySelector('[data-staff-stat="bookings-today"]')?.textContent.trim() === '1');
        await dayContext.page.waitForFunction(() => document.querySelector('[data-staff-stat="walkins-today"]')?.textContent.trim() === '1');
        await dayContext.context.close();

        const boundaryDay = await openStaffPage(browser, {
            timezoneId: 'Pacific/Honolulu', now: '2026-09-27T16:30:00Z',
            config: { bookings: boundaryBookings, walkins: boundaryWalkins },
        });
        await boundaryDay.page.waitForFunction(() => document.querySelector('[data-staff-stat="bookings-today"]')?.textContent.trim() === '1');
        await boundaryDay.page.waitForFunction(() => document.querySelector('[data-staff-stat="walkins-today"]')?.textContent.trim() === '1');
        const counters = await boundaryDay.page.locator('[data-staff-stat]').evaluateAll(elements => Object.fromEntries(elements.map(el => [el.dataset.staffStat, el.textContent.trim()])));
        assert.equal(counters['bookings-today'], '1');
        assert.equal(counters['walkins-today'], '1');
        assert.equal(await boundaryDay.page.locator('[data-staff-tx-from]').inputValue(), '2026-09-28', 'date controls should initialize to the Manila calendar day');
        await boundaryDay.context.close();

        const responsive = await openStaffPage(browser, { timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z' });
        for (const width of [360, 768, 1280]) {
            await responsive.page.setViewportSize({ width, height: 900 });
            const dimensions = await responsive.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
            assert.ok(dimensions.document <= dimensions.viewport, `page should not overflow horizontally at ${width}px (${dimensions.document}px)`);
            const titleSize = await responsive.page.evaluate(() => {
                const title = document.querySelector('.staff-topbar-title h1');
                const probe = document.createElement('span');
                probe.style.fontSize = 'var(--fs-xl)';
                document.body.append(probe);
                const expected = getComputedStyle(probe).fontSize;
                probe.remove();
                return { actual: title ? getComputedStyle(title).fontSize : '', expected };
            });
            assert.equal(titleSize.actual, titleSize.expected, `staff title matches owner --fs-xl token at ${width}px`);
            await responsive.page.locator('[data-staff-notif-trigger]').click();
            await responsive.page.waitForFunction(() => {
                const menu = document.querySelector('[data-staff-notif-menu]');
                return menu && getComputedStyle(menu).opacity === '1' && getComputedStyle(menu).pointerEvents === 'auto';
            });
            const menuBounds = await responsive.page.locator('[data-staff-notif-menu]').evaluate(menu => {
                const rect = menu.getBoundingClientRect();
                return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
            });
            assert.ok(menuBounds.left >= 0 && menuBounds.right <= menuBounds.viewport,
                `notification menu stays inside ${width}px viewport (${JSON.stringify(menuBounds)})`);
            if (width === 360 && process.env.STAFF_HEADER_SCREENSHOT) {
                await responsive.page.screenshot({ path: process.env.STAFF_HEADER_SCREENSHOT, clip: { x: 0, y: 0, width, height: 600 } });
            }
            await responsive.page.locator('[data-staff-notif-trigger]').click();
        }
        const thermalPageSize = await responsive.page.evaluate(() => {
            for (const sheet of Array.from(document.styleSheets)) {
                let rules;
                try { rules = Array.from(sheet.cssRules); } catch { continue; }
                for (const rule of rules) {
                    if (rule.type === CSSRule.PAGE_RULE) return rule.style.getPropertyValue('size').trim();
                    if (rule.cssRules) {
                        const pageRule = Array.from(rule.cssRules).find(nested => nested.type === CSSRule.PAGE_RULE);
                        if (pageRule) return pageRule.style.getPropertyValue('size').trim();
                    }
                }
            }
            return '';
        });
        assert.equal(thermalPageSize, '80mm 300mm', 'receipt print page must parse as a valid 80mm thermal format');
        assert.deepEqual(errors, [], 'walk-in browser console must have no uncaught page errors');
        await responsive.context.close();
        console.log('PASS staff walk-in UI: atomic orders, GCash QR lifecycle and retry, Manila date boundary, and responsive widths');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
