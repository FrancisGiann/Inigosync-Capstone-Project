// Staff walk-in order and Manila-day UI fixture. Uses an in-memory Supabase
// mock only; no production/test payment account, inserts, or network writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const courts = [
    { id: 'listing-badminton', name: 'Badminton', sportName: 'Badminton', bookableUnits: [{ id: 'unit-b1', label: 'Court 1', rateDay: 100, rateUnit: '/hr' }] },
    { id: 'listing-basketball', name: 'Basketball', sportName: 'Basketball', bookableUnits: [{ id: 'unit-b2', label: 'Court 2', rateDay: 150, rateUnit: '/hr' }] },
    { id: 'listing-set', name: 'Table Tennis', sportName: 'Table Tennis', bookableUnits: [{ id: 'unit-set', label: 'Table 1', rateDay: 50, rateUnit: '/set' }, { id: 'unit-set-2', label: 'Table 2', rateDay: 50, rateUnit: '/set' }] },
    { id: 'listing-volleyball', name: 'Volleyball', sportName: 'Volleyball', bookableUnits: [{ id: 'unit-volleyball', label: 'Court 1', rateDay: 125, rateUnit: '/hr' }] },
];

function fixture(config) {
    window.__walkinQa = { calls: [], reads: [], config, createdItems: [], checkoutAttempts: 0, acknowledgmentAttempts: 0 };
    const qa = window.__walkinQa;
    let occupancyCallCount = 0;
    const profiles = [
        { id: 'qa-staff', role: 'staff', status: 'active', full_name: 'QA Staff', email: 'staff@example.test', contact_num: '', contact_num_validated: false, contact_num_validated_at: null },
        { id: 'qa-customer', role: 'customer', status: 'active', full_name: config.customerFullName || 'QA Customer', email: 'customer@example.test', contact_num: '+639171234567' },
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
            if (name === 'staff_guest_phone_is_registered') {
                const phoneE164 = String(args.p_phone || '').replace(/^0/, '+63');
                const delay = Number(config.phoneAvailabilityDelayMs?.[phoneE164] || 0);
                if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                if (config.phoneAvailabilityError) return { data: null, error: { message: 'Phone availability unavailable in fixture' } };
                return { data: Boolean(config.phoneRegisteredByNumber?.[phoneE164] ?? config.phoneRegistered ?? false), error: null };
            }
            if (name === 'booking_rules_for_date') return config.hoursUnavailable
                ? { data: null, error: { message: 'rules unavailable in fixture' } }
                : { data: { open_hour: 8, close_hour: 20, is_closed: false, grace_minutes: config.graceMinutes ?? 30, timezone: 'Asia/Manila' }, error: null };
            if (name === 'court_occupancy') {
                const snapshots = config.occupancySnapshots;
                const snapshot = Array.isArray(snapshots)
                    ? snapshots[Math.min(occupancyCallCount++, snapshots.length - 1)]
                    : (config.occupancyRows || []);
                if (snapshot?.error) return { data: null, error: { message: snapshot.error } };
                return { data: snapshot || [], error: null };
            }
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
            if (name === 'staff_get_involved_transactions') return { data: { transactions: config.transactions || [] }, error: null };
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
    const sports = [...new Map(courts.map(court => [court.sportName, { id: court.sportName.toLowerCase(), slug: court.sportName.toLowerCase(), name: court.sportName }])).values()];
    return `window.InigoCourtsData={getCourts:async()=>${JSON.stringify(courts)},getSports:async()=>${JSON.stringify(sports)},resolveCourtUnits:c=>({pickerLabel:'Choose a court',units:c.bookableUnits}),invalidateCourts(){},monogramFor:()=>'',slugify:s=>s};`;
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

async function openWalkinTimeStep(page, courtId = 'listing-badminton') {
    await page.locator('[data-staff-nav="walkin"]').click();
    await page.locator('[data-staff-walkin-name]').fill('Availability Guest');
    await page.locator('[data-staff-walkin-next]').click();
    await selectWalkinCourt(page, courtId);
    await page.locator('[data-staff-walkin-next]').click();
    await page.locator('[data-staff-walkin-hour="9"]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-staff-walkin-open-windows]').textContent.startsWith('Select an available hour.'));
}

async function selectWalkinCourt(page, courtId) {
    const court = courts.find(item => item.id === courtId);
    assert.ok(court, `fixture contains court ${courtId}`);
    const sportValue = court.sportName.toLowerCase();
    await page.locator('[data-staff-walkin-sport-select]').selectOption(sportValue);
    await page.locator(`[data-staff-walkin-sport="${courtId}"]`).click();
}

function assertCardHeightStable(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1, `${message} (expected ${expected}px ±1px, received ${actual}px)`);
}

function occupancyRow(hour, source = 'online') {
    return {
        source, courts: 'Badminton', court_unit: 'Court 1',
        time_date: `2026-09-27T${String(hour - 8).padStart(2, '0')}:00:00.000Z`,
        duration_minutes: 60,
    };
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const errors = [];
        const customerStepContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: {
                customerFullName: 'QA Customer With A Very Long Account Name That Wraps Beyond The Reserved Status Area On Narrow Screens',
                phoneRegisteredByNumber: {
                    '+639171234567': false,
                    '+639999999999': true,
                },
                phoneAvailabilityDelayMs: { '+639171234567': 1200, '+639191234567': 1200 },
            },
        });
        const customerStepPage = customerStepContext.page;
        await customerStepPage.locator('[data-staff-nav="walkin"]').click();
        await customerStepPage.setViewportSize({ width: 360, height: 780 });
        assert.equal(await customerStepPage.locator('[data-staff-account-search-wrap]').isVisible(), false, 'Guest mode has no account search or recommendations');
        const customerCard = customerStepPage.locator('[data-staff-panel="walkin"] .staff-wizard-card');
        const blankMobileCardHeight = await customerCard.evaluate(el => el.getBoundingClientRect().height);
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'an empty customer name blocks Next');
        await customerStepPage.locator('[data-staff-walkin-name]').fill('Guest Customer');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), false, 'blank optional mobile permits Next with a name');
        await customerStepPage.locator('[data-staff-walkin-mobile]').fill('0917 123 4567');
        await customerStepPage.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'checking');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'Next stays blocked while availability is pending');
        assertCardHeightStable(await customerCard.evaluate(el => el.getBoundingClientRect().height), blankMobileCardHeight, 'pending status does not change customer card height');
        await customerStepPage.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'available');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-mobile-status]').innerText(), 'Number is available.');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-mobile-status]').getAttribute('aria-label'),
            await customerStepPage.locator('[data-staff-walkin-mobile-status]').innerText(), 'the complete validation result stays accessible when visually clamped');
        assertCardHeightStable(await customerCard.evaluate(el => el.getBoundingClientRect().height), blankMobileCardHeight, 'available status does not change customer card height');
        const guestPhoneCheck = await customerStepPage.evaluate(() => ({
            calls: window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_guest_phone_is_registered'),
            accountSearchVisible: !document.querySelector('[data-staff-account-search-wrap]').hidden,
            suggestionsVisible: !document.querySelector('[data-staff-customer-results]').hidden,
        }));
        assert.deepEqual(guestPhoneCheck.calls.map(call => call.args.p_phone), ['09171234567']);
        assert.equal(guestPhoneCheck.accountSearchVisible, false, 'phone lookup does not reveal account recommendations in Guest mode');
        assert.equal(guestPhoneCheck.suggestionsVisible, false);
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), false, 'an available mobile number permits the next step');
        const mobileCases = [
            { value: '09999999999', state: 'in_use', text: /already registered/i },
            { value: '09191234567', state: 'checking', pending: true },
        ];
        for (const mobileCase of mobileCases) {
            await customerStepPage.locator('[data-staff-walkin-mobile]').fill(mobileCase.value);
            await customerStepPage.waitForFunction(state => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === state, mobileCase.state);
            assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, `${mobileCase.state} availability blocks Next`);
            assertCardHeightStable(await customerCard.evaluate(el => el.getBoundingClientRect().height), blankMobileCardHeight, `${mobileCase.state} status does not change customer card height`);
            if (mobileCase.text) assert.match(await customerStepPage.locator('[data-staff-walkin-mobile-status]').innerText(), mobileCase.text);
            if (mobileCase.pending) {
                await customerStepPage.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'available');
                assertCardHeightStable(await customerCard.evaluate(el => el.getBoundingClientRect().height), blankMobileCardHeight, 'resolved pending check keeps customer card height stable');
            }
        }
        await customerStepPage.locator('[data-staff-walkin-mobile]').fill('12345');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-mobile-status]').getAttribute('data-state'), 'invalid', 'an invalid mobile format is reported immediately');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'an invalid mobile format blocks Next');
        assertCardHeightStable(await customerCard.evaluate(el => el.getBoundingClientRect().height), blankMobileCardHeight, 'invalid status does not change customer card height');
        await customerStepPage.evaluate(() => { window.__walkinQa.config.phoneAvailabilityError = true; });
        await customerStepPage.locator('[data-staff-walkin-mobile]').fill('09171234567');
        await customerStepPage.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'error');
        assert.match(await customerStepPage.locator('[data-staff-walkin-mobile-status]').innerText(), /Could not check this number/i);
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'availability errors block Next');
        assertCardHeightStable(await customerCard.evaluate(el => el.getBoundingClientRect().height), blankMobileCardHeight, 'error status does not change customer card height');
        await customerStepPage.setViewportSize({ width: 360, height: 800 });
        await customerStepPage.locator('[data-staff-customer-mode][value="account"]').check();
        const accountCardHeightBeforeSearch = await customerCard.evaluate(el => el.getBoundingClientRect().height);
        const emptyAccountSearchLayout = await customerStepPage.evaluate(() => {
            const status = document.querySelector('[data-staff-customer-selected]');
            const heading = document.querySelector('.staff-customer-search-heading');
            return { statusHidden: status.hidden, headingBottom: heading.getBoundingClientRect().bottom, inputTop: document.querySelector('[data-staff-customer-search]').getBoundingClientRect().top };
        });
        assert.equal(emptyAccountSearchLayout.statusHidden, true, 'the empty selected-account status does not reserve space');
        assert.ok(emptyAccountSearchLayout.inputTop - emptyAccountSearchLayout.headingBottom <= 9, 'the search field sits directly below its heading');
        await customerStepPage.locator('[data-staff-customer-search]').fill('QA');
        await customerStepPage.locator('[data-staff-customer-results] [data-staff-customer-id]').waitFor();
        const accountSuggestionLayout = await customerStepPage.evaluate(() => {
            const card = document.querySelector('[data-staff-panel="walkin"] .staff-wizard-card');
            const input = document.querySelector('[data-staff-customer-search]').getBoundingClientRect();
            const results = document.querySelector('[data-staff-customer-results]').getBoundingClientRect();
            return { height: card.getBoundingClientRect().height, suggestions: document.querySelectorAll('[data-staff-customer-id]').length, visible: !document.querySelector('[data-staff-customer-results]').hidden, resultsGap: results.top - input.bottom };
        });
        assert.equal(accountSuggestionLayout.suggestions, 1);
        assert.equal(accountSuggestionLayout.visible, true);
        assert.ok(accountSuggestionLayout.resultsGap >= 0 && accountSuggestionLayout.resultsGap <= 4, 'account suggestions sit immediately below the search field');
        assertCardHeightStable(accountSuggestionLayout.height, accountCardHeightBeforeSearch, 'account suggestions overlay the card without changing its height');
        await customerStepPage.locator('[data-staff-customer-results] [data-staff-customer-id]').click();
        assert.match(await customerStepPage.locator('[data-staff-customer-selected]').innerText(), /Linked to QA Customer/);
        assert.equal(await customerStepPage.locator('[data-staff-customer-search]').inputValue(), 'customer@example.test', 'selection puts the email in the editable search field');
        assert.equal(await customerStepPage.locator('[data-staff-customer-search]').isEditable(), true);
        const linkedStatusLayout = await customerStepPage.locator('[data-staff-customer-selected]').evaluate(el => ({
            text: el.textContent,
            accessible: el.getAttribute('aria-label'),
            title: el.title,
            height: el.getBoundingClientRect().height,
            maxHeight: getComputedStyle(el).maxHeight,
            rightOfLabel: el.getBoundingClientRect().left >= document.querySelector('.staff-customer-search-heading label').getBoundingClientRect().right,
        }));
        assert.ok(linkedStatusLayout.text.length > 100, 'the linked status retains the complete long account name in the DOM');
        assert.equal(linkedStatusLayout.accessible, linkedStatusLayout.text, 'the complete linked status is available to assistive technology');
        assert.equal(linkedStatusLayout.title, linkedStatusLayout.text, 'the complete linked status is available on hover');
        assert.notEqual(linkedStatusLayout.maxHeight, 'none', 'long linked status text is visually bounded');
        assert.ok(linkedStatusLayout.height > 0, 'the selected-account status remains visible after selection');
        assert.equal(linkedStatusLayout.rightOfLabel, true, 'the linked status appears to the right of the field label');
        await customerStepPage.locator('[data-staff-customer-search]').fill('another account');
        assert.equal(await customerStepPage.locator('[data-staff-customer-selected]').isHidden(), true, 'editing the search clears the linked status');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-name]').inputValue(), '', 'editing the search clears the previous customer details');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'an edited account query cannot submit the prior selection');
        await customerStepPage.locator('[data-staff-customer-results] [data-staff-customer-id]').waitFor();
        await customerStepPage.locator('[data-staff-customer-results] [data-staff-customer-id]').click();
        assert.equal(await customerStepPage.locator('[data-staff-customer-search]').inputValue(), 'customer@example.test', 'a new search can select an account again');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), false, 'the newly selected account restores a valid customer step');
        await customerStepPage.locator('[data-staff-customer-mode][value="guest"]').check();
        assert.equal(await customerStepPage.locator('[data-staff-account-search-wrap]').isVisible(), false, 'switching to Guest closes account suggestions');
        await customerStepPage.locator('[data-staff-walkin-name]').fill('Sport Selector Guest');
        await customerStepPage.locator('[data-staff-walkin-next]').click();
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport-select]').inputValue(), '', 'sport is not preselected');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport="listing-badminton"]').count(), 0, 'court choices stay unavailable until a sport is selected');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'sport and court are required before leaving step 2');
        await customerStepPage.locator('[data-staff-walkin-sport-select]').selectOption('table tennis');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport]').count(), 1, 'sport selection shows only courts belonging to that sport');
        await customerStepPage.locator('[data-staff-walkin-sport="listing-set"]').click();
        assert.deepEqual(await customerStepPage.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Table 1', 'Table 2'], 'unit labels come from the selected court inventory');
        await customerStepPage.locator('[data-staff-walkin-sport-select]').selectOption('badminton');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-wrap]').isVisible(), false, 'changing sport clears the prior court unit picker');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-current-court]').innerText(), 'Select a court first.', 'changing sport clears the prior court selection');
        await customerStepPage.locator('[data-staff-walkin-sport-select]').selectOption('volleyball');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport]').count(), 1, 'Volleyball shows only its linked court');
        await customerStepPage.locator('[data-staff-walkin-sport="listing-volleyball"]').click();
        assert.equal(await customerStepPage.locator('[data-staff-walkin-current-court]').innerText(), 'Volleyball · Court 1', 'Volleyball uses its verified Court 1 label, not the previous sport’s tables');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-wrap]').isVisible(), false, 'a single verified court unit has no redundant picker');
        await customerStepContext.context.close();

        const inUsePhoneContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', config: { phoneRegistered: true },
        });
        await inUsePhoneContext.page.locator('[data-staff-nav="walkin"]').click();
        await inUsePhoneContext.page.locator('[data-staff-walkin-name]').fill('Guest Customer');
        await inUsePhoneContext.page.locator('[data-staff-walkin-mobile]').fill('09171234567');
        await inUsePhoneContext.page.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'in_use');
        assert.equal(await inUsePhoneContext.page.locator('[data-staff-walkin-mobile-status]').innerText(), 'This number is already registered. Enter another mobile number.');
        assert.equal(await inUsePhoneContext.page.locator('[data-staff-walkin-next]').isDisabled(), true, 'an already linked guest number must be cleared or linked to its account');
        assert.equal(await inUsePhoneContext.page.locator('[data-staff-customer-results]').isVisible(), false, 'an in-use number does not show customer recommendations');
        await inUsePhoneContext.context.close();

        const stalePhoneContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: {
                phoneRegisteredByNumber: { '+639171234567': true, '+639181234567': false },
                phoneAvailabilityDelayMs: { '+639171234567': 1200 },
            },
        });
        await stalePhoneContext.page.locator('[data-staff-nav="walkin"]').click();
        const staleMobile = stalePhoneContext.page.locator('[data-staff-walkin-mobile]');
        await staleMobile.fill('09171234567');
        await stalePhoneContext.page.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'checking');
        await staleMobile.fill('09181234567');
        await stalePhoneContext.page.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'available');
        await stalePhoneContext.page.waitForTimeout(700);
        assert.equal(await stalePhoneContext.page.locator('[data-staff-walkin-mobile-status]').getAttribute('data-state'), 'available', 'a stale response cannot overwrite the current number result');
        assert.match(await stalePhoneContext.page.locator('[data-staff-walkin-mobile-status]').innerText(), /available/i);
        await stalePhoneContext.context.close();

        const failedPhoneContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', config: { phoneAvailabilityError: true },
        });
        await failedPhoneContext.page.locator('[data-staff-nav="walkin"]').click();
        await failedPhoneContext.page.locator('[data-staff-walkin-name]').fill('Guest Customer');
        await failedPhoneContext.page.locator('[data-staff-walkin-mobile]').fill('09171234567');
        await failedPhoneContext.page.waitForFunction(() => document.querySelector('[data-staff-walkin-mobile-status]').dataset.state === 'error');
        assert.equal(await failedPhoneContext.page.locator('[data-staff-walkin-next]').isDisabled(), true, 'the flow blocks when mobile availability could not be checked');
        await failedPhoneContext.context.close();

        const occupiedContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { occupancyRows: [occupancyRow(10), occupancyRow(11, 'hold'), occupancyRow(12, 'maintenance')] },
        });
        await openWalkinTimeStep(occupiedContext.page);
        assert.equal(await occupiedContext.page.locator('[data-staff-walkin-hour="10"]').isDisabled(), true, 'an occupied hour cannot be selected');
        assert.equal(await occupiedContext.page.locator('[data-staff-walkin-hour="11"]').isDisabled(), true, 'a held hour cannot be selected');
        assert.equal(await occupiedContext.page.locator('[data-staff-walkin-hour="12"]').isDisabled(), true, 'a maintenance hour cannot be selected');
        await occupiedContext.page.locator('[data-staff-walkin-hour="9"]').click();
        await occupiedContext.page.locator('[data-staff-walkin-hour="13"]').click();
        assert.match(await occupiedContext.page.locator('[data-staff-walkin-open-windows]').innerText(), /consecutive/i, 'a disabled occupied hour prevents a gap from being selected around it');
        assert.equal(await occupiedContext.page.locator('[data-staff-walkin-lines] .staff-walkin-line').count(), 0, 'unavailable-slot probing creates no booking line');
        await occupiedContext.context.close();

        for (const attempt of ['next', 'add-line']) {
            const changingAvailability = await openStaffPage(browser, {
                timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
                config: { occupancySnapshots: [[], [], [occupancyRow(9)]] },
            });
            const recheckPage = changingAvailability.page;
            await openWalkinTimeStep(recheckPage);
            await recheckPage.locator('[data-staff-walkin-hour="9"]').click();
            await recheckPage.locator(attempt === 'next' ? '[data-staff-walkin-next]' : '[data-staff-walkin-add-line]').click();
            await recheckPage.waitForFunction(() => /Availability changed/.test(document.querySelector('[data-staff-walkin-open-windows]').textContent));
            assert.equal(await recheckPage.locator('[data-staff-walkin-step="3"]').evaluate(el => el.classList.contains('is-active')), true, `${attempt} keeps the user on time selection after occupancy changes`);
            assert.equal(await recheckPage.locator('[data-staff-walkin-lines] .staff-walkin-line').count(), 0, `${attempt} does not create a line for a newly occupied slot`);
            await changingAvailability.context.close();
        }

        const failedRecheck = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { occupancySnapshots: [[], [], { error: 'occupancy unavailable' }] },
        });
        await openWalkinTimeStep(failedRecheck.page);
        await failedRecheck.page.locator('[data-staff-walkin-hour="9"]').click();
        await failedRecheck.page.locator('[data-staff-walkin-next]').click();
        await failedRecheck.page.waitForFunction(() => /could not be verified/i.test(document.querySelector('[data-staff-walkin-open-windows]').textContent));
        assert.equal(await failedRecheck.page.locator('[data-staff-walkin-lines] .staff-walkin-line').count(), 0, 'a failed live recheck creates no booking line');
        await failedRecheck.context.close();

        const setContext = await openStaffPage(browser, { timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z' });
        const setPage = setContext.page;
        const resetPageErrors = [];
        setPage.on('pageerror', error => resetPageErrors.push(error.message));
        await openWalkinTimeStep(setPage, 'listing-set');
        await setPage.locator('[data-staff-rate-quantity]').fill('3');
        await setPage.locator('[data-staff-walkin-hour="9"]').click();
        await setPage.locator('[data-staff-walkin-hour="10"]').click();
        await setPage.locator('[data-staff-walkin-hour="11"]').click();
        await setPage.locator('[data-staff-walkin-add-line]').click();
        await selectWalkinCourt(setPage, 'listing-set');
        await setPage.locator('[data-staff-walkin-next]').click();
        await setPage.locator('[data-staff-walkin-hour="13"]').waitFor();
        assert.equal(await setPage.locator('[data-staff-rate-quantity]').inputValue(), '1', 'the next set-rate line starts with one set after clearing the prior three-set line');
        await setPage.locator('[data-staff-walkin-hour="13"]').click();
        await setPage.locator('[data-staff-walkin-next]').click();
        await setPage.locator('[data-staff-walkin-next]').click();
        await setPage.locator('[data-staff-walkin-review-lines] .staff-walkin-review-line').nth(1).waitFor();
        await setPage.locator('[data-staff-walkin-save]').click();
        await setPage.locator('[data-staff-walkin-receipt]').getByText('Payment acknowledgment and entry pass').waitFor();
        assert.deepEqual(await setPage.evaluate(() => window.__walkinQa.createdItems.map(item => item.rate_quantity)), [3, 1], 'the multi-line set order preserves quantities of three sets and one set');
        await setPage.locator('[data-staff-walkin-reset]').click();
        console.log('RESET DEBUG', await setPage.evaluate(() => ({
            panel: document.querySelector('[data-staff-panel="walkin"]')?.className,
            wizardHidden: document.querySelector('[data-staff-walkin-wizard-wrap]')?.hidden,
            receiptHidden: document.querySelector('[data-staff-walkin-receipt-wrap]')?.hidden,
            sportHidden: document.querySelector('[data-staff-walkin-sport-select]')?.getBoundingClientRect().height,
            selected: document.querySelector('[data-staff-walkin-sport-select]')?.value,
        })));
        assert.equal(await setPage.locator('[data-staff-walkin-sport-select]').inputValue(), '', 'new walk-in resets the selected sport');
        assert.equal(await setPage.locator('[data-staff-walkin-unit-select] option').count(), 0, 'new walk-in clears the previous unit options');
        await setPage.locator('[data-staff-walkin-sport-select]').selectOption('table tennis');
        assert.equal(await setPage.locator('[data-staff-walkin-sport]').count(), 1, 'sport choices remain available after starting a new walk-in');
        await setPage.locator('[data-staff-walkin-sport="listing-set"]').click();
        assert.deepEqual(await setPage.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Table 1', 'Table 2'], 'reopened wizard repopulates units from the selected court');
        assert.deepEqual(resetPageErrors, [], 'reset and reopened sport selection do not raise browser errors');
        await setContext.context.close();

        const { context, page } = await openStaffPage(browser, { timezoneId: 'Pacific/Honolulu', now: '2026-09-27T01:30:00Z', pauseClock: true });
        page.on('pageerror', error => errors.push(error.message));
        await page.locator('[data-staff-nav="walkin"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-staff-walkin-sport-select]').disabled);
        await page.locator('[data-staff-walkin-name]').fill('Guest Customer');
        await page.locator('[data-staff-walkin-next]').click();
        assert.equal(await page.locator('[data-staff-walkin-sport].staff-walkin-sport-card').count(), 0, 'court choices stay hidden until a sport is selected');
        assert.equal(await page.locator('[data-staff-walkin-sport].staff-chip').count(), 0, 'court choices use the booking flow’s photo-card pattern instead of chips');
        await selectWalkinCourt(page, 'listing-badminton');
        await page.locator('[data-staff-walkin-next]').click();
        assert.equal(await page.locator('[data-staff-walkin-current-court]').innerText(), 'Badminton · Court 1', 'time selection identifies the selected court and unit');
        await page.locator('[data-staff-walkin-hour="9"]').waitFor();
        assert.equal(await page.locator('[data-staff-walkin-duration]').count(), 0, 'the walk-in time step has no duration dropdown');
        assert.equal(await page.locator('[data-staff-walkin-hour="8"]').isDisabled(), true, 'past slots are unavailable for selection');
        await page.locator('[data-staff-walkin-hour="9"]').click();
        await page.locator('[data-staff-walkin-hour="11"]').click();
        assert.match(await page.locator('[data-staff-walkin-open-windows]').innerText(), /consecutive/i, 'a non-adjacent slot cannot create a booking gap');
        assert.equal(await page.locator('[data-staff-walkin-hour="9"]').getAttribute('aria-pressed'), 'true', 'the original selection remains intact after a gap is rejected');
        await page.locator('[data-staff-walkin-hour="10"]').click();
        assert.match(await page.locator('[data-staff-walkin-current-range]').innerText(), /2 hrs/);
        await page.locator('[data-staff-walkin-hour="10"]').click();
        assert.match(await page.locator('[data-staff-walkin-current-range]').innerText(), /1 hr/);
        await page.locator('[data-staff-walkin-hour="10"]').click();
        assert.match(await page.locator('[data-staff-walkin-current-range]').innerText(), /2 hrs/);
        await page.locator('[data-staff-walkin-add-line]').click();
        await selectWalkinCourt(page, 'listing-basketball');
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
        await selectWalkinCourt(online.page, 'listing-badminton');
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
        await selectWalkinCourt(qrPage, 'listing-badminton');
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
        await selectWalkinCourt(expiredQrPage, 'listing-badminton');
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
        await selectWalkinCourt(invalidQrPage, 'listing-badminton');
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
            config: { transactions: [
                {
                    payment_id: 102, created_at: '2026-09-27T00:55:00Z', method: 'Cash', base_minor: 5000, gross_minor: 5000,
                    source: 'booking', customer_name: 'QA Customer', sports: 'Badminton', courts: 'Badminton', unit: 'Court 1',
                    acknowledgment: {
                        receipt_id: 'qa-balance', receipt_number: 'PA-BALANCE', issued_at: '2026-09-27T00:55:00Z', customer_name: 'QA Customer',
                        items: [{ sport: 'Badminton', court: 'Badminton', unit: 'Court 1', starts_at: '2026-09-27T01:00:00Z', ends_at: '2026-09-27T02:00:00Z', subtotal_minor: 10000 }],
                        court_subtotal_minor: 10000, amount_paid_minor: 5000, remaining_balance_minor: 0,
                        fee_minor: 0, gross_minor: 5000, subtotal: 50, fee: 0, total: 50,
                        payment_method: 'Cash', payment_status: 'paid',
                        disclaimer: 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.',
                    },
                },
                {
                    payment_id: 101, created_at: '2026-09-26T23:55:00Z', method: 'PayMongo', base_minor: 5000, gross_minor: 5250,
                    source: 'booking', customer_name: 'QA Customer', sports: 'Badminton', courts: 'Badminton', unit: 'Court 1',
                    acknowledgment: { receipt_id: 'qa-deposit', receipt_number: 'PA-DEPOSIT', customer_name: 'QA Customer', items: [],
                        court_subtotal_minor: 10000, amount_paid_minor: 5000, remaining_balance_minor: 5000,
                        fee_minor: 250, gross_minor: 5250, payment_method: 'PayMongo', payment_status: 'paid' },
                },
                {
                    payment_id: 103, created_at: '2026-09-27T00:25:00Z', method: 'Cash', base_minor: 8000, gross_minor: 8000,
                    source: 'walkin', customer_name: 'Walk-in Guest', sports: 'Basketball', courts: 'Basketball', unit: 'Court 2',
                    acknowledgment: { receipt_id: 'qa-walkin', receipt_number: 'PA-WALKIN', customer_name: 'Walk-in Guest', items: [],
                        court_subtotal_minor: 8000, amount_paid_minor: 8000, remaining_balance_minor: 0,
                        fee_minor: 0, gross_minor: 8000, payment_method: 'Cash', payment_status: 'paid' },
                },
            ] },
        });
        const transactionPage = transactionContext.page;
        await transactionPage.locator('[data-staff-nav="transactions"]').click();
        const transactionRows = transactionPage.locator('[data-staff-table="transactions"] tbody tr[data-row-index]');
        await transactionRows.nth(2).waitFor();
        assert.equal(await transactionRows.count(), 3, 'one row appears per payment, including the separate balance payment and walk-in');
        assert.deepEqual(await transactionPage.locator('[data-staff-table="transactions"] thead th').allTextContents(),
            ['Date', 'Customer Name', 'Sports', 'Court/Unit', 'Time', 'Source', 'Amount', 'Receipt']);
        assert.equal(await transactionPage.locator('[data-staff-tx-from], [data-staff-tx-to]').count(), 0, 'date range controls are removed');
        assert.equal(await transactionRows.nth(0).locator('[data-staff-payment-ack]').innerText(), 'View receipt');
        assert.match(await transactionRows.nth(0).innerText(), /₱50\.00/, 'amount shows the payment total');
        await transactionRows.nth(0).locator('[data-staff-payment-ack]').click();
        const receiptDialog = transactionPage.locator('[data-staff-receipt-dialog]');
        await receiptDialog.waitFor();
        assert.match(await receiptDialog.innerText(), /PA-BALANCE/);
        assert.equal(await transactionPage.locator('[data-staff-receipt-print]').count(), 1, 'receipt modal has a print action');
        assert.equal(await transactionPage.locator('[data-staff-receipt-download]').count(), 1, 'receipt modal has a download action');
        await transactionPage.evaluate(() => document.body.classList.add('staff-printing-transaction-receipt'));
        await transactionPage.emulateMedia({ media: 'print' });
        const printedReceipt = await transactionPage.locator('.staff-receipt-modal .staff-receipt-card').evaluate(card => {
            const rect = card.getBoundingClientRect();
            const overlay = getComputedStyle(card.closest('.staff-receipt-modal'));
            const dialog = getComputedStyle(card.closest('.staff-modal'));
            return {
                visible: getComputedStyle(card).visibility === 'visible',
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                overlayPosition: overlay.position,
                overlayOverflow: overlay.overflow,
                dialogPosition: dialog.position,
                dialogMaxHeight: dialog.maxHeight,
                dialogOverflow: dialog.overflow,
                text: card.innerText,
            };
        });
        assert.equal(printedReceipt.visible, true, 'receipt stays visible in print media');
        assert.ok(printedReceipt.x < 20, 'receipt begins at the page edge instead of the centered dialog position');
        assert.ok(printedReceipt.y < 20, 'receipt starts near the top of the page without preceding dashboard content');
        assert.ok(printedReceipt.width <= 74 * 96 / 25.4 + 1, 'receipt fits the 80 mm thermal page content width');
        assert.ok(printedReceipt.height > 250, 'all receipt detail remains in the printed card');
        assert.equal(printedReceipt.overlayPosition, 'static', 'print resets the fixed dialog overlay');
        assert.equal(printedReceipt.overlayOverflow, 'visible', 'print does not clip through the overlay');
        assert.equal(printedReceipt.dialogPosition, 'static', 'print resets the centered dialog positioning');
        assert.equal(printedReceipt.dialogMaxHeight, 'none', 'print removes the dialog viewport-height cap');
        assert.equal(printedReceipt.dialogOverflow, 'visible', 'print does not clip through the dialog');
        assert.match(printedReceipt.text, /Customer charged/i);
        assert.match(printedReceipt.text, /Payment method/);
        assert.match(printedReceipt.text, /PA-BALANCE/);
        await transactionPage.emulateMedia({ media: 'screen' });
        await transactionPage.evaluate(() => document.body.classList.remove('staff-printing-transaction-receipt'));
        await transactionPage.keyboard.press('Escape');
        await transactionPage.locator('[data-staff-receipt-modal]').waitFor({ state: 'hidden' });
        await transactionPage.locator('[data-staff-tx-sort]').selectOption('date-asc');
        assert.match(await transactionRows.nth(0).innerText(), /₱52\.50/, 'sort changes payment row order');
        await transactionPage.locator('[data-staff-filter-group="transactions"] [data-staff-filter="walkin"]').click();
        await transactionPage.waitForFunction(() => Array.from(document.querySelectorAll('[data-staff-table="transactions"] tbody tr[data-row-index]')).filter(row => row.style.display !== 'none').length === 1);
        assert.match(await transactionRows.filter({ hasText: 'Walk-in Guest' }).innerText(), /Walk-in/);
        const txCall = await transactionPage.evaluate(() => window.__walkinQa.calls.find(call => call.name === 'staff_get_involved_transactions'));
        assert.deepEqual(txCall.args, undefined, 'staff identity is derived by the server from auth.uid');
        await transactionContext.context.close();

        const filterContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { transactions: [
                { payment_id: 201, created_at: '2026-09-27T01:00:00Z', source: 'walkin', customer_name: 'Filter Guest', sports: 'Basketball', courts: 'Basketball', unit: 'Court 2', base_minor: 10000, gross_minor: 10000 },
                { payment_id: 202, created_at: '2026-09-27T16:30:00Z', source: 'booking', customer_name: 'Other Guest', sports: 'Tennis', courts: 'Tennis', unit: 'Court 1', base_minor: 12000, gross_minor: 12000 },
            ] },
        });
        const filterPage = filterContext.page;
        await filterPage.locator('[data-staff-nav="transactions"]').click();
        const filterRows = filterPage.locator('[data-staff-table="transactions"] tbody tr[data-row-index]');
        await filterRows.first().waitFor();
        assert.equal(await filterRows.count(), 2, 'transactions from all dates appear before a date is selected');
        assert.equal(await filterPage.locator('[data-staff-tx-date]').inputValue(), '');
        await filterPage.locator('[data-staff-filter-group="transactions"] [data-staff-filter="walkin"]').click();
        const filterSearch = filterPage.locator('[data-staff-search="transactions"]');
        await filterSearch.fill('Filter Guest');
        const visibleTransactions = () => filterPage.locator('[data-staff-table="transactions"] tbody tr[data-row-index]').evaluateAll(rows => rows.filter(row => row.style.display !== 'none').length);
        assert.equal(await visibleTransactions(), 1, 'source and search filters apply to payment rows');
        const unavailableReceipt = filterPage.locator('[data-staff-table="transactions"] tbody tr[data-row-index="0"] [data-staff-payment-ack]');
        assert.equal(await unavailableReceipt.innerText(), 'View receipt');
        assert.equal(await unavailableReceipt.isDisabled(), true, 'View receipt is disabled when a legacy acknowledgment cannot be recovered');
        await filterPage.locator('[data-staff-tx-date]').fill('2026-09-28');
        await filterPage.locator('[data-staff-tx-date]').dispatchEvent('change');
        assert.equal(await visibleTransactions(), 0, 'date, source, and search filters compose locally');
        await filterPage.locator('[data-staff-filter-group="transactions"] [data-staff-filter="online"]').click();
        await filterSearch.fill('Other Guest');
        assert.equal(await visibleTransactions(), 1, 'changing source and search retains the selected transaction date');
        await filterPage.locator('[data-staff-tx-date]').fill('2026-09-27');
        await filterPage.locator('[data-staff-tx-date]').dispatchEvent('change');
        assert.equal(await visibleTransactions(), 0, 'changing date retains current source and search filters');
        await filterPage.locator('[data-staff-tx-date]').fill('');
        await filterPage.locator('[data-staff-tx-date]').dispatchEvent('change');
        assert.equal(await visibleTransactions(), 1, 'clearing the date shows all dates while retaining other filters');
        await filterContext.context.close();

        // RPC response for staff A's own walk-in when staff B later collects
        // its balance contains the creator-owned original payment only.
        const ownershipContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { transactions: [
                { payment_id: 301, created_at: '2026-09-27T01:00:00Z', source: 'walkin', customer_name: 'A-owned Guest', sports: 'Badminton', courts: 'Badminton', unit: 'Court 1', base_minor: 10000, gross_minor: 10000,
                    acknowledgment: { receipt_id: 'qa-owner-payment', receipt_number: 'PA-OWNER', customer_name: 'A-owned Guest', items: [], payment_status: 'paid' } },
            ] },
        });
        await ownershipContext.page.locator('[data-staff-nav="transactions"]').click();
        const ownedRows = ownershipContext.page.locator('[data-staff-table="transactions"] tbody tr[data-row-index]');
        await ownedRows.first().waitFor();
        assert.equal(await ownedRows.count(), 1, 'staff A sees the owned original payment but not staff B’s later balance payment');
        assert.match(await ownedRows.first().innerText(), /PA-OWNER|₱100\.00/);
        await ownershipContext.context.close();

        const unreadNotifications = Array.from({ length: 18 }, (_, index) => ({
            key: `notice-${index + 1}`, title: `Notice ${index + 1}`, body: 'Unread staff update', category: 'booking',
            created_at: '2026-09-27T00:00:00Z', read_at: null,
        }));
        const notificationsContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', config: { notifications: unreadNotifications },
        });
        const notificationsPage = notificationsContext.page;
        await notificationsPage.locator('[data-staff-notif-trigger]').click();
        await notificationsPage.waitForFunction(() => document.querySelectorAll('[data-staff-notif-list] [data-staff-notif-select-row]').length === 10);
        assert.equal(await notificationsPage.locator('[data-staff-notif-list] [data-staff-notif-open]').count(), 10, 'first page displays ten openable notifications');
        assert.equal(await notificationsPage.locator('[data-staff-notif-menu]').getByText('Notifications', { exact: true }).count(), 1, 'header contains only the Notifications title');
        assert.equal(await notificationsPage.getByText('Mark all read', { exact: true }).count(), 0, 'there is no top mark-all action');
        assert.equal(await notificationsPage.getByText('Mark as read', { exact: true }).count(), 1, 'the selection row has one read action');
        assert.equal(await notificationsPage.locator('[data-staff-notif-next]').isDisabled(), false, 'older notifications are reachable on another page');
        await notificationsPage.locator('[data-staff-notif-select]').selectOption('unread');
        assert.equal(await notificationsPage.locator('[data-staff-notif-selected]').innerText(), '10 selected');
        assert.equal(await notificationsPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'mark_notification_read').length), 0,
            'selecting notifications does not mark them read');
        await notificationsPage.locator('[data-staff-notif-select]').selectOption('none');
        await notificationsPage.locator('[data-staff-notif-select-row="notice-1"]').check();
        await notificationsPage.locator('[data-staff-notif-select-row="notice-2"]').check();
        assert.equal(await notificationsPage.locator('[data-staff-notif-selected]').innerText(), '2 selected');
        await notificationsPage.locator('[data-staff-notif-mark-selected]').click();
        await notificationsPage.waitForFunction(() => window.__walkinQa.config.notifications.slice(0, 2).every(row => Boolean(row.read_at)));
        assert.equal(await notificationsPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'mark_notification_read').length), 2,
            'mark as read calls the per-notification read RPC only for selected rows');
        assert.equal(await notificationsPage.locator('[data-staff-notif-selected]').innerText(), '0 selected', 'a successful action clears page selection');
        assert.equal(await notificationsPage.locator('[data-staff-notif-mark-selected]').isDisabled(), true, 'mark as read is disabled without a selection');
        await notificationsPage.locator('[data-staff-notif-key="notice-3"] [data-staff-notif-open]').click();
        await notificationsPage.waitForFunction(() => Boolean(window.__walkinQa.config.notifications[2].read_at));
        assert.equal(await notificationsPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'mark_notification_read').length), 3,
            'opening a notification marks that notification read');
        assert.equal(await notificationsPage.evaluate(() => window.__walkinQa.config.notifications.filter(row => row.read_at).length), 3);
        await notificationsPage.locator('[data-staff-notif-trigger]').click();
        await notificationsPage.locator('[data-staff-notif-next]').click();
        await notificationsPage.locator('[data-staff-notif-list]').getByText('Notice 11').waitFor();
        assert.equal(await notificationsPage.locator('[data-staff-notif-list] [data-staff-notif-select-row]').count(), 8, 'next page contains the remaining older notifications');
        assert.equal(await notificationsPage.locator('[data-staff-notif-page]').innerText(), 'Page 2 of 2');
        await notificationsPage.locator('[data-staff-notif-prev]').click();
        await notificationsPage.locator('[data-staff-notif-select-row="notice-1"]').waitFor();
        await notificationsContext.context.close();

        const singleNotificationErrorContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { notifications: [{ key: 'failed-read', title: 'Needs attention', body: 'A booking update', category: 'booking', href: '#walkin', created_at: '2026-09-27T00:00:00Z', read_at: null }], markNotificationReadError: true },
        });
        const singleNotificationErrorPage = singleNotificationErrorContext.page;
        await singleNotificationErrorPage.locator('[data-staff-notif-trigger]').click();
        await singleNotificationErrorPage.locator('[data-staff-notif-open]').waitFor();
        await singleNotificationErrorPage.locator('[data-staff-notif-open]').click();
        await singleNotificationErrorPage.waitForFunction(() => window.__toastMessages.some(message => message.message === 'Could not mark notification as read.' && message.isError));
        assert.equal(await singleNotificationErrorPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'mark_notification_read').length), 1,
            'opening a notification uses the per-notification read RPC');
        assert.equal(await singleNotificationErrorPage.evaluate(() => window.__walkinQa.config.notifications[0].read_at), null, 'failed click-to-read leaves unread state unchanged');
        const notificationListCallsBefore = await singleNotificationErrorPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_list_notifications').length);
        const toastCountBeforeSingleRead = await singleNotificationErrorPage.evaluate(() => window.__toastMessages.length);
        await singleNotificationErrorPage.locator('.staff-notif-row .staff-notif-item').click();
        await singleNotificationErrorPage.waitForFunction(count => window.__toastMessages.length > count, toastCountBeforeSingleRead);
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
        await selectWalkinCourt(closedRules.page, 'listing-badminton');
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
        await selectWalkinCourt(graceExpired.page, 'listing-badminton');
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
        await selectWalkinCourt(eveningGrace.page, 'listing-badminton');
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
        assert.equal(await boundaryDay.page.locator('[data-staff-tx-from], [data-staff-tx-to]').count(), 0, 'transaction records no longer expose date range controls');
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
