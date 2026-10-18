// Staff walk-in order and Manila-day UI fixture. Uses an in-memory Supabase
// mock only; no production/test payment account, inserts, or network writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Valid, generated QR-like PNG fixture: never encodes a payment or provider URL.
const qrImageFixture = 'data:image/png;base64,' + require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/qr-like.png')).toString('base64');

const courts = [
    { id: 'listing-badminton', name: 'Badminton', sportName: 'Badminton', sportSlug: 'badminton', bookableUnits: [{ id: 'unit-b1', label: 'Court 1', rateDay: 100, rateUnit: '/hr' }] },
    { id: 'listing-basketball', name: 'Basketball', sportName: 'Basketball', sportSlug: 'basketball', bookableUnits: [{ id: 'unit-b2', label: 'Court 2', rateDay: 150, rateUnit: '/hr' }] },
    { id: 'listing-set', name: 'Table Tennis', sportName: 'Table Tennis', sportSlug: 'table-tennis', bookableUnits: [{ id: 'unit-set', label: 'Table 1', rateDay: 50, rateUnit: '/set' }, { id: 'unit-set-2', label: 'Table 2', rateDay: 50, rateUnit: '/set' }] },
    { id: 'listing-volleyball', name: 'Volleyball', sportName: 'Volleyball', sportSlug: 'volleyball', bookableUnits: [{ id: 'unit-volleyball', label: 'Court 1', rateDay: 125, rateUnit: '/hr' }] },
    { id: 'listing-bowling-duckpin', name: 'Bowling — Duckpin', sportName: 'Bowling — Duckpin', sportSlug: 'bowling-duckpin', slug: 'bowling-duckpin', bookableUnits: Array.from({ length: 8 }, (_, index) => ({ id: `unit-duckpin-${index + 1}`, label: `Lane ${index + 1}`, rateDay: 30, rateUnit: '/game' })) },
    { id: 'listing-bowling-tenpin', name: 'Bowling — Ten-Pin', sportName: 'Bowling — Duckpin', sportSlug: 'bowling-duckpin', slug: 'bowling-tenpin', bookableUnits: Array.from({ length: 12 }, (_, index) => ({ id: `unit-tenpin-${index + 1}`, label: `Lane ${index + 1}`, rateDay: 40, rateUnit: '/game' })) },
];

function fixture(config) {
    window.__walkinQa = { calls: [], reads: [], config, createdItems: [], checkoutAttempts: 0, acknowledgmentAttempts: 0 };
    const qa = window.__walkinQa;
    let occupancyCallCount = 0;
    const profiles = [
        { id: 'qa-staff', role: 'staff', status: 'active', full_name: 'QA Staff', email: 'staff@example.test', contact_num: '', contact_num_validated: false, contact_num_validated_at: null,
            address: config.staffAddress || 'Saved staff address', birthdate: '1990-01-02', gender: 'Female',
            emergency_contact_name: config.staffEmergencyName || 'Saved emergency name', emergency_contact_number: config.staffEmergencyNumber || '+639171234568',
            avatar_url: config.staffAvatarUrl || null },
        { id: 'qa-customer', role: 'customer', status: 'active', full_name: config.customerFullName || 'QA Customer', email: 'customer@example.test', contact_num: '+639171234567' },
    ];
    const resultFor = (table, query) => {
        if (query.write) {
            qa.calls.push({ kind: query.write, table, payload: query.payload, filters: query.filters });
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
                    : table === 'app_settings' ? [{ cash_enabled: true, card_enabled: true, gcash_enabled: true, qrph_enabled: true, downpayment_pct: 50, night_rate_starts_at: '18:00:00' }]
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
                select(columns) { query.columns = columns; return chain; },
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
                then(resolve, reject) {
                    const delay = table === 'profiles' && String(query.columns || '').includes('emergency_contact_name')
                        ? Number(config.profileDetailsDelayMs || 0) : 0;
                    const result = delay
                        ? new Promise(done => setTimeout(() => done(resultFor(table, query)), delay))
                        : Promise.resolve(resultFor(table, query));
                    return result.then(resolve, reject);
                },
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
                if (config.ackError) return { data: null, error: { code: '42501', message: 'Acknowledgment access denied in fixture' } };
                const paymentStatus = config.ackPaidAfter
                    ? (qa.acknowledgmentAttempts >= config.ackPaidAfter ? 'paid' : 'pending')
                    : (config.paymentStatus || 'paid');
                if (paymentStatus === 'pending') {
                    if (config.pendingAsStatusAfter && qa.acknowledgmentAttempts >= config.pendingAsStatusAfter) {
                        return { data: { payment_status: 'awaiting_payment' }, error: null };
                    }
                    return { data: null, error: { code: 'P0002', message: 'Receipt not found' } };
                }
                return { data: {
                    receipt_id: 'qa-receipt', receipt_number: 'QA-001', issued_at: new Date().toISOString(), customer_name: 'Guest Customer',
                    items: qa.createdItems.length ? qa.createdItems.map(item => ({
                        sport: item.listing_id === 'listing-set' ? 'Table Tennis' : item.listing_id === 'listing-basketball' ? 'Basketball' : 'Badminton',
                        court: item.listing_id === 'listing-set' ? 'Table Tennis' : item.listing_id === 'listing-basketball' ? 'Basketball' : 'Badminton',
                        unit: item.listing_id === 'listing-set' ? 'Table 1' : item.listing_id === 'listing-basketball' ? 'Court 2' : 'Court 1',
                        starts_at: item.starts_at, ends_at: item.ends_at, subtotal_minor: item.quoted_minor,
                        rate_unit: item.listing_id === 'listing-set' ? '/set' : '/hr', rate_quantity: item.rate_quantity,
                        duration_minutes: (new Date(item.ends_at) - new Date(item.starts_at)) / 60000,
                    })) : (config.ackItems || []),
                    court_subtotal_minor: 35000, amount_paid_minor: 35000, remaining_balance_minor: 0,
                    fee_minor: 0, gross_minor: 35000, subtotal: 350, fee: 0, total: 350,
                    payment_method: config.paymentMethod || 'Cash', payment_status: paymentStatus,
                    ...(config.paymentMethod === 'PayMongo' ? {} : {
                        cash_tendered_minor: qa.createdItems[0]?.cash_tendered_minor ?? 40000,
                        cash_change_minor: (qa.createdItems[0]?.cash_tendered_minor ?? 40000) - 35000,
                    }),
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
                const normalized = String(options.body.phone || '').replace(/^0/, '+63');
                const delay = Number(config.phoneValidationDelayMsByNumber?.[normalized] || 0);
                if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                if (config.phoneValidationErrorByNumber?.[normalized]) return { data: null, error: config.phoneValidationErrorByNumber[normalized] };
                if (config.phoneValidationError) return { data: null, error: config.phoneValidationError };
                const local = String(options.body.phone || '').replace(/[^0-9]/g, '');
                const response = config.phoneValidationByNumber?.[normalized] || config.phoneValidation || { valid: true, normalized: local.startsWith('09') ? `+63${local.slice(1)}` : options.body.phone, available: true };
                return { data: response, error: null };
            }
            if (options.body.channel === 'qrph' && Array.isArray(options.body.items)) qa.createdItems = options.body.items;
            qa.checkoutAttempts += 1;
            const checkoutFailureCount = Number(config.failCheckoutCount || (config.failCheckoutOnce ? 1 : 0));
            if (qa.checkoutAttempts <= checkoutFailureCount) return { data: null, error: {
                message: 'Temporary checkout error',
                ...(config.checkoutFailureResponse ? { context: new Response(JSON.stringify(config.checkoutFailureResponse), { status: 409 }) } : {}),
            } };
            return { data: {
                order_id: options.body.order_id || 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526', attempt_id: 'qa-attempt',
                qr_image_url: config.qrImageUrl,
                ...(config.testMode ? { test_mode: true, qr_test_url: config.qrTestUrl } : {}),
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
    const sports = [...new Map(courts.map(court => [court.sportSlug, { id: court.sportSlug, slug: court.sportSlug, name: court.sportName }])).values()];
    return `window.InigoCourtsData={getCourts:async()=>${JSON.stringify(courts)},getSports:async()=>${JSON.stringify(sports)},resolveCourtUnits:c=>({pickerLabel:'Choose a court',units:c.bookableUnits}),invalidateCourts(){},monogramFor:()=>'',slugify:s=>s};`;
}

async function openStaffPage(browser, { timezoneId, now, config = {}, query = '', pauseClock = false }) {
    const context = await browser.newContext({ timezoneId, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.clock.install({ time: new Date(now) });
    if (pauseClock) await page.clock.pauseAt(new Date(now));
    const pageConfig = { ...config, qrImageUrl: config.qrImageUrl || qrImageFixture };
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/includes/loadingOverlay.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.__toastMessages=[];window.InigoLoading={show(){},hide(){}};window.InigoToast={show(message,isError){window.__toastMessages.push({message,isError:Boolean(isError)});}};` }));
    await page.route('**/Config/supabaseClient.js', route => route.fulfill({ contentType: 'application/javascript', body: `(${fixture})(${JSON.stringify(pageConfig)});` }));
    await page.route('**/includes/authGuard.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.inigosyncProfile={id:'qa-staff',role:'staff',status:'active',full_name:'QA Staff',email:'staff@example.test'};document.addEventListener('DOMContentLoaded',()=>{window.InigoLoading?.hide();document.documentElement.classList.remove('inigo-auth-pending');document.dispatchEvent(new CustomEvent('inigosync:profile-ready',{detail:window.inigosyncProfile}));});` }));
    await page.route('**/includes/appSettings.js', route => route.fulfill({ contentType: 'application/javascript', body: `window.InigoAppSettings={DEFAULT_SETTINGS:{downpaymentPct:50,cashEnabled:true,cardEnabled:true,gcashEnabled:true,qrphEnabled:true},getSettings:async()=>({downpaymentPct:50,cashEnabled:true,cardEnabled:true,gcashEnabled:true,qrphEnabled:true,nightRateStartsAt:'18:00'})};` }));
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
    const sportValue = court.sportSlug;
    await page.locator(`[data-staff-walkin-sport-card="${sportValue}"]`).click();
    const choiceIndex = courts.filter(item => item.sportSlug === sportValue)
        .slice(0, courts.filter(item => item.sportSlug === sportValue).findIndex(item => item.id === courtId))
        .reduce((count, item) => count + item.bookableUnits.length, 0);
    await page.locator('[data-staff-walkin-unit-select]').selectOption(String(choiceIndex));
}

async function resolveStaffConfirm(page, { accept = false, title, message } = {}) {
    const modal = page.locator('[data-staff-confirm-modal]');
    await modal.waitFor({ state: 'visible' });
    if (title) assert.equal(await modal.locator('[data-staff-confirm-title]').innerText(), title);
    if (message) assert.equal(await modal.locator('[data-staff-confirm-text]').innerText(), message);
    await modal.locator(accept ? '[data-staff-confirm-accept]' : '[data-staff-confirm-cancel]').click();
}

function assertCardHeightStable(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1, `${message} (expected ${expected}px ±1px, received ${actual}px)`);
}

async function verifyThermalReceiptPrint(page, cardSelector, label) {
    await page.evaluate(selector => {
        const card = document.querySelector(selector);
        const idRow = [...(card?.querySelectorAll('.payment-ack-meta-row') || [])]
            .find(row => /ID$/i.test(row.querySelector('span')?.textContent || ''));
        if (idRow?.querySelector('strong')) idRow.querySelector('strong').textContent = '#123456789012345678901234567890123456';
        const longAmount = '₱123456789012345.67';
        const totalAmount = card?.querySelector('.payment-ack-total strong');
        if (totalAmount) totalAmount.textContent = longAmount;
        const itemAmount = card?.querySelector('.payment-ack-item-amount strong');
        if (itemAmount) itemAmount.textContent = longAmount;
        window.print = () => {};
        window.InigoPaymentAcknowledgment.print(card);
    }, cardSelector);
    await page.emulateMedia({ media: 'print' });
    const result = await page.evaluate(() => {
        const style = document.querySelector('style[data-payment-ack-page-size]');
        const rule = style?.sheet?.cssRules?.[0];
        const root = document.querySelector('.payment-ack-print-root');
        const card = root?.querySelector('.payment-ack-card');
        const rect = card?.getBoundingClientRect();
        const rootRect = root?.getBoundingClientRect();
        const overflows = [...(card?.querySelectorAll('*') || [])]
            .filter(element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
            .map(element => ({ className: element.className || element.tagName, text: element.textContent, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
        const outsideCard = [...(card?.querySelectorAll('*') || [])]
            .filter(element => {
                const childRect = element.getBoundingClientRect();
                return childRect.width > 0 && (childRect.left < rect.left - 1 || childRect.right > rect.right + 1);
            })
            .map(element => element.className || element.tagName);
        return {
            applied: style?.dataset.paymentAckPageSizeApplied,
            pageRuleType: rule?.type,
            expectedPageRuleType: CSSRule.PAGE_RULE,
            pageSize: rule?.style?.getPropertyValue('size')?.trim() || '',
            pageMargin: rule?.style?.getPropertyValue('margin') || '',
            rootLeft: root?.getBoundingClientRect().left,
            rootTop: root?.getBoundingClientRect().top,
            rootWidth: rootRect?.width,
            rootPadding: root && (() => {
                const value = getComputedStyle(root).paddingLeft;
                return parseFloat(value) * (value.endsWith('mm') ? 96 / 25.4 : 1);
            })(),
            cardTop: rect?.top,
            cardLeft: rect?.left,
            cardRight: rect?.right,
            cardWidth: rect?.width,
            cardHeight: rect?.height,
            overflows,
            outsideCard,
            printedRow: !!card?.querySelector('.payment-ack-print-meta'),
            paymentDate: [...(card?.querySelectorAll('.payment-ack-meta-row') || [])].some(row => /Payment date/i.test(row.innerText)),
            longId: [...(card?.querySelectorAll('.payment-ack-meta-row strong') || [])].some(value => value.innerText.includes('12345678901234567890')),
            longAmount: card?.querySelector('.payment-ack-total strong')?.innerText || '',
            receiptAddress: card?.querySelector('.payment-ack-address')?.innerText || '',
            visible: card && getComputedStyle(card).visibility === 'visible',
            bodyMinHeight: getComputedStyle(document.body).minHeight,
        };
    });
    assert.equal(result.applied, 'true', `${label}: print inserts the measured page size`);
    assert.equal(result.pageRuleType, result.expectedPageRuleType, `${label}: measured size is a CSS page rule`);
    assert.match(result.pageSize, /^58mm (\d+)mm$/, `${label}: page uses 58mm paper and measured height`);
    assert.equal(result.pageMargin, '0px', `${label}: zero page margins suppress Chrome's automatic headers and footers`);
    assert.ok(Number(result.pageSize.match(/^58mm (\d+)mm$/)[1]) < 300, `${label}: page avoids the driver's long fixed length`);
    assert.equal(result.rootTop, 0, `${label}: print root starts at page top`);
    assert.ok(Math.abs(result.rootWidth - 47.5 * 96 / 25.4) < 1, `${label}: root fits within the driver's 47.92mm imageable width`);
    assert.ok(Math.abs(result.rootPadding - 0.75 * 96 / 25.4) < 1, `${label}: root keeps .75mm internal padding`);
    assert.ok(Math.abs(result.cardLeft - (result.rootLeft + 0.75 * 96 / 25.4)) < 1, `${label}: receipt starts after its inner margin`);
    assert.ok(Math.abs(result.cardWidth - 46 * 96 / 25.4) < 1, `${label}: receipt uses the 46mm printable card width`);
    assert.ok(result.cardRight <= 47.92 * 96 / 25.4 + 1, `${label}: receipt stays inside the measured printable boundary`);
    assert.equal(result.printedRow, false, `${label}: no generated Printed row is added`);
    assert.equal(result.paymentDate, true, `${label}: saved payment date remains present`);
    assert.equal(result.longId, true, `${label}: representative long ID reaches print layout`);
    assert.match(result.longAmount, /123456789012345\.67/, `${label}: representative long amount reaches print layout`);
    assert.deepEqual(result.overflows, [], `${label}: no card child has horizontal content overflow`);
    assert.deepEqual(result.outsideCard, [], `${label}: no child crosses the receipt card's horizontal bounds`);
    assert.match(result.receiptAddress, /Brgy\. Bocohan, Diversion Road, Lucena City, Quezon, Philippines/i,
        `${label}: rendered receipt contains the provisional venue address`);
    assert.equal(result.visible, true, `${label}: receipt is visible in print media`);
    assert.equal(result.bodyMinHeight, '0px', `${label}: dashboard viewport height is removed for print`);

    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const pdfText = pdf.toString('latin1');
    assert.equal((pdfText.match(/\/Type\s*\/Page\b/g) || []).length, 1, `${label}: generated PDF has one page`);
    const mediaBox = pdfText.match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.ok(mediaBox, `${label}: generated PDF contains a page media box`);
    assert.ok(Math.abs(Number(mediaBox[1]) - 58 * 72 / 25.4) < 2, `${label}: generated PDF is 58mm wide`);
    assert.ok(Math.abs(Number(mediaBox[2]) - Number(result.pageSize.match(/^58mm (\d+)mm$/)[1]) * 72 / 25.4) < 2,
        `${label}: generated PDF uses the measured receipt height`);

    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
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
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport-card].is-selected').count(), 0, 'sport is not preselected');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-wrap]').isHidden(), true, 'unit choices stay hidden until a sport is selected');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'sport and court are required before leaving step 2');
        const cardGeometryBeforeSelect = await customerStepPage.locator('[data-staff-walkin-sport-cards]').evaluate(grid => ({
            columns: getComputedStyle(grid).gridTemplateColumns,
            bounds: (() => { const rect = grid.querySelector('[data-staff-walkin-sport-card]').getBoundingClientRect(); return [rect.width, rect.height]; })(),
        }));
        await customerStepPage.locator('[data-staff-walkin-sport-card="table-tennis"]').click();
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport-card] img[src*="sports-covers"]').count(), 6, 'sport cards use the shared landing-page sport covers');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport-card="bowling-duckpin"]').innerText(), 'Bowling Duckpin', 'Duckpin is its own sport card');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-sport-card="bowling-tenpin"]').innerText(), 'Bowling Ten-Pin', 'Ten-Pin is its own sport card');
        const cardGeometryAfterSelect = await customerStepPage.locator('[data-staff-walkin-sport-cards]').evaluate(grid => ({
            columns: getComputedStyle(grid).gridTemplateColumns,
            bounds: (() => { const rect = grid.querySelector('[data-staff-walkin-sport-card]').getBoundingClientRect(); return [rect.width, rect.height]; })(),
        }));
        assert.deepEqual(cardGeometryAfterSelect, cardGeometryBeforeSelect, 'showing the unit dropdown leaves sport card columns and dimensions stable');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-step="2"] select').count(), 1, 'Step 2 has one combo box after sport selection');
        assert.deepEqual(await customerStepPage.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Choose an available unit', 'Table 1', 'Table 2'], 'sport selection immediately shows its available units');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-select] option[value=""]').isHidden(), true, 'the prompt is hidden from the native choice list');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-select] option[value=""]').evaluate(option => option.disabled), true, 'the prompt cannot be selected as a unit');
        await customerStepPage.locator('[data-staff-walkin-unit-select]').selectOption('0');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-current-court]').innerText(), 'Table Tennis · Table 1', 'unit selection resolves its parent court listing');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-next]').isDisabled(), false, 'selecting an actual unit satisfies Step 2 validation');
        await customerStepPage.locator('[data-staff-walkin-sport-card="badminton"]').click();
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-wrap]').isVisible(), true, 'changing sport keeps the single unit picker available');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-select]').inputValue(), '', 'changing sport clears the prior unit selection');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-current-court]').innerText(), 'Select a court first.', 'changing sport clears the prior court selection');
        await customerStepPage.locator('[data-staff-walkin-sport-card="volleyball"]').click();
        assert.deepEqual(await customerStepPage.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Choose an available unit', 'Court 1'], 'Volleyball shows its actual verified unit');
        await customerStepPage.locator('[data-staff-walkin-unit-select]').selectOption('0');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-current-court]').innerText(), 'Volleyball · Court 1', 'Volleyball uses its verified Court 1 label, not the previous sport’s tables');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-unit-wrap]').isVisible(), true, 'the selected sport uses the same single unit picker');
        await customerStepPage.locator('[data-staff-walkin-sport-card="bowling-duckpin"]').click();
        assert.deepEqual(await customerStepPage.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Choose an available unit', ...Array.from({ length: 8 }, (_, index) => `Lane ${index + 1}`)], 'Duckpin lists only its 8 verified lanes');
        await customerStepPage.locator('[data-staff-walkin-unit-select]').selectOption('0');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-current-court]').innerText(), 'Bowling — Duckpin · Lane 1', 'Duckpin lane selection resolves to the Duckpin listing');
        await customerStepPage.locator('[data-staff-walkin-sport-card="bowling-tenpin"]').click();
        assert.deepEqual(await customerStepPage.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Choose an available unit', ...Array.from({ length: 12 }, (_, index) => `Lane ${index + 1}`)], 'Ten-Pin lists only its 12 verified lanes');
        await customerStepPage.locator('[data-staff-walkin-unit-select]').selectOption('11');
        assert.equal(await customerStepPage.locator('[data-staff-walkin-current-court]').innerText(), 'Bowling — Ten-Pin · Lane 12', 'Ten-Pin lane selection resolves to the Ten-Pin listing');
        await customerStepContext.context.close();

        // Crossing Manila midnight clears only the in-progress time range. A
        // previously added walk-in order line keeps its original date/time.
        const midnightContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T01:00:00Z', pauseClock: true,
        });
        const midnightPage = midnightContext.page;
        await openWalkinTimeStep(midnightPage);
        await midnightPage.locator('[data-staff-walkin-hour="9"]').click();
        await midnightPage.locator('[data-staff-walkin-add-line]').click();
        await midnightPage.locator('.staff-walkin-line').waitFor();
        const savedLineBeforeMidnight = await midnightPage.locator('.staff-walkin-line').innerText();
        await selectWalkinCourt(midnightPage, 'listing-basketball');
        await midnightPage.locator('[data-staff-walkin-next]').click();
        await midnightPage.locator('[data-staff-walkin-hour="10"]').waitFor();
        await midnightPage.locator('[data-staff-walkin-hour="10"]').click();
        assert.equal(await midnightPage.locator('[data-staff-walkin-hour="10"]').getAttribute('aria-pressed'), 'true');
        await midnightPage.clock.setFixedTime(new Date('2026-09-27T16:00:00Z'));
        await midnightPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await midnightPage.waitForFunction(() => document.querySelector('[data-staff-walkin-open-windows]').textContent.includes('date changed to 2026-09-28'));
        const dateChangeNotice = midnightPage.locator('[data-staff-walkin-open-windows]');
        assert.equal(await dateChangeNotice.isVisible(), true, 'the date-change notice remains visible after availability rendering');
        assert.match(await dateChangeNotice.innerText(), /date changed to 2026-09-28; select a time for the new date/i);
        assert.equal(await midnightPage.locator('[data-staff-walkin-hour][aria-pressed="true"]').count(), 0, 'old-day time selection is cleared');
        assert.equal(await midnightPage.locator('[data-staff-walkin-next]').isDisabled(), true, 'checkout cannot use the cleared old-day selection');
        assert.equal(await midnightPage.locator('.staff-walkin-line').count(), 1, 'the previously added booking line is preserved');
        assert.equal(await midnightPage.locator('.staff-walkin-line').innerText(), savedLineBeforeMidnight, 'the saved line is not restamped with the new date');
        await midnightContext.context.close();

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
        assert.equal(await setPage.locator('[data-staff-rate-quantity]').count(), 0, 'staff walk-in has no separate set quantity control');
        assert.equal(await setPage.locator('[data-staff-walkin-hour="9"]').locator('strong').innerText(), '9:00 AM–10:00 AM', 'hourly tiles show their full time range');
        await setPage.locator('[data-staff-walkin-hour="9"]').click();
        await setPage.locator('[data-staff-walkin-hour="10"]').click();
        await setPage.locator('[data-staff-walkin-hour="11"]').click();
        assert.match(await setPage.locator('[data-staff-walkin-current-range]').innerText(), /3 hrs/);
        await setPage.locator('[data-staff-walkin-add-line]').click();
        assert.match(await setPage.locator('[data-staff-walkin-lines] .staff-walkin-line').innerText(), /₱150\.00/, 'the selected three-hour duration determines the line total');
        await selectWalkinCourt(setPage, 'listing-set');
        await setPage.locator('[data-staff-walkin-next]').click();
        await setPage.locator('[data-staff-walkin-hour="13"]').waitFor();
        await setPage.locator('[data-staff-walkin-hour="13"]').click();
        await setPage.locator('[data-staff-walkin-next]').click();
        await setPage.locator('[data-staff-walkin-next]').click();
        const setReviewLines = setPage.locator('[data-staff-walkin-review-lines] .staff-walkin-review-line');
        await setReviewLines.nth(1).waitFor();
        const setReviewText = await setPage.locator('[data-staff-walkin-review-lines]').innerText();
        assert.match(await setPage.locator('[data-staff-walkin-summary-total]').innerText(), /₱200\.00/, 'review total includes three selected hours plus the second one-hour line');
        assert.match(setReviewText, /3 hrs/);
        assert.match(setReviewText, /1 hr/);
        assert.doesNotMatch(setReviewText, /\bsets?\b/i, 'staff review describes reservations in hours');
        await setPage.locator('[data-staff-walkin-cash-tendered]').fill('200');
        assert.equal(await setPage.locator('[data-staff-walkin-save]').isDisabled(), false, 'the full ₱200 order tender enables cash completion');
        await setPage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(setPage, { accept: true });
        const setReceipt = setPage.locator('[data-staff-walkin-receipt] .payment-ack-card');
        await setReceipt.waitFor();
        assert.match(await setReceipt.innerText(), /PAYMENT ACKNOWLEDGEMENT/);
        assert.match(await setReceipt.innerText(), /TOTAL PAID/);
        assert.match(await setReceipt.innerText(), /Duration: 3 hrs/);
        assert.match(await setReceipt.innerText(), /3 hrs × ₱50\.00 per hour/);
        assert.doesNotMatch(await setReceipt.innerText(), /\bsets?\b/i, 'staff receipt describes the reservation in hours');
        assert.deepEqual(await setPage.evaluate(() => window.__walkinQa.createdItems.map(item => item.rate_quantity)), [3, 1], 'backend quantity is derived from selected hours');
        await setPage.locator('[data-staff-walkin-reset]').click();
        assert.equal(await setPage.locator('[data-staff-walkin-sport-card].is-selected').count(), 0, 'new walk-in resets the selected sport');
        assert.equal(await setPage.locator('[data-staff-walkin-unit-select]').inputValue(), '', 'new walk-in clears the previous unit selection');
        await setPage.locator('[data-staff-walkin-name]').fill('Second Walk-in Guest');
        await setPage.locator('[data-staff-walkin-next]').click();
        await setPage.locator('[data-staff-walkin-sport-card="table-tennis"]').click();
        assert.equal(await setPage.locator('[data-staff-walkin-unit-select] option').count(), 3, 'sport choices remain available after starting a new walk-in');
        assert.deepEqual(await setPage.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Choose an available unit', 'Table 1', 'Table 2'], 'reopened wizard repopulates direct unit choices');
        assert.deepEqual(resetPageErrors, [], 'reset and reopened sport selection do not raise browser errors');
        await setContext.context.close();

        const { context, page } = await openStaffPage(browser, { timezoneId: 'Pacific/Honolulu', now: '2026-09-27T01:30:00Z', pauseClock: true });
        page.on('pageerror', error => errors.push(error.message));
        await page.locator('[data-staff-nav="walkin"]').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-staff-walkin-sport-card]').length > 0);
        await page.locator('[data-staff-walkin-name]').fill('Guest Customer');
        await page.locator('[data-staff-walkin-next]').click();
        assert.equal(await page.locator('[data-staff-walkin-sport-card]').count(), 6, 'all sports and Bowling variants with available inventory appear as cover cards');
        assert.equal(await page.locator('[data-staff-walkin-unit-wrap]').isHidden(), true, 'unit choices stay hidden until a sport is selected');
        await page.locator('[data-staff-walkin-sport-card="badminton"]').click();
        assert.deepEqual(await page.locator('[data-staff-walkin-unit-select] option').allTextContents(), ['Choose an available unit', 'Court 1'], 'the one dropdown contains the selected sport’s actual unit');
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
        assert.equal(await page.locator('[data-staff-walkin-online-option]').count(), 0, 'the redundant online option is removed');
        const cashTender = page.locator('[data-staff-walkin-cash-tendered]');
        assert.equal(await page.locator('[data-staff-walkin-save]').isDisabled(), true, 'cash cannot be saved before tender is entered');
        await cashTender.fill('349.99');
        assert.equal(await page.locator('[data-staff-walkin-save]').isDisabled(), true, 'cash below the amount due is rejected');
        assert.match(await page.locator('[data-staff-walkin-cash-validation]').innerText(), /Enter at least ₱350\.00/);
        await cashTender.fill('400');
        assert.match(await page.locator('[data-staff-walkin-cash-change]').innerText(), /₱50\.00/);
        assert.equal(await page.locator('[data-staff-walkin-save]').isDisabled(), false, 'sufficient tender enables cash save');
        await page.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(page, { accept: true });
        const walkinReceipt = page.locator('[data-staff-walkin-receipt] .payment-ack-card');
        await walkinReceipt.waitFor();
        assert.match(await walkinReceipt.innerText(), /PAYMENT ACKNOWLEDGEMENT/);
        assert.match(await walkinReceipt.innerText(), /TOTAL PAID/);
        assert.match(await walkinReceipt.innerText(), /Cash tendered\s+₱400\.00/);
        assert.match(await walkinReceipt.innerText(), /Change due\s+₱50\.00/);
        await verifyThermalReceiptPrint(page, '[data-staff-walkin-receipt] .payment-ack-card', 'walk-in receipt');
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
        assert.deepEqual(saved.items.map(item => item.cash_tendered_minor), [40000, 40000], 'cash tender is sent in minor units for server validation and persistence');
        assert.deepEqual(saved.items.map(item => item.starts_at), ['2026-09-27T01:00:00.000Z', '2026-09-27T04:00:00.000Z'], 'slot timestamps should use Manila wall time even when device timezone is Honolulu');
        assert.equal(saved.ackCalls.length, 1, 'cash receipt is fetched from the canonical acknowledgment RPC');
        assert.deepEqual(saved.writes, [], 'the browser must not write walk_in_booking rows directly');
        await context.close();

        const qrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { paymentStatus: 'pending', ackPaidAfter: 3, pendingAsStatusAfter: 2, paymentMethod: 'PayMongo', orderBaseMinor: 37000, checkoutBaseMinor: 37500 },
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
        assert.equal(await qrPage.locator('[data-staff-walkin-summary-payment]').innerText(), 'QR Ph');
        await qrPage.locator('[data-staff-walkin-next]').click();
        await qrPage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(qrPage, { accept: true });
        await qrPage.locator('[data-staff-walkin-qr-image] img[src^="data:image/"]').waitFor();
        await qrPage.waitForFunction(() => {
            const image = document.querySelector('[data-staff-walkin-qr-image] img');
            return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        });
        assert.match(await qrPage.locator('.staff-walkin-qr-card').innerText(), /Amount to pay\s+₱375\.00/, 'QR amount follows the server checkout charge, not the stale client estimate');
        assert.match(await qrPage.locator('[data-staff-walkin-qr-status]').innerText(), /Waiting for PayMongo payment confirmation/);
        assert.match(await qrPage.locator('.staff-walkin-qr-card').innerText(), /scan this amount-specific QR code/i);
        const desktopQrLayout = await qrPage.locator('.staff-walkin-qr-card').evaluate(card => {
            const bounds = card.getBoundingClientRect();
            return { width: bounds.width, viewportWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth };
        });
        assert.ok(desktopQrLayout.width > 900, 'desktop QR card uses the full available staff content width');
        assert.ok(desktopQrLayout.scrollWidth <= desktopQrLayout.viewportWidth, 'desktop QR layout does not overflow horizontally');
        await qrPage.setViewportSize({ width: 390, height: 844 });
        const mobileQrLayout = await qrPage.locator('.staff-walkin-qr-card').evaluate(card => {
            const bounds = card.getBoundingClientRect();
            const code = card.querySelector('.staff-walkin-qr-code').getBoundingClientRect();
            return { width: bounds.width, codeWidth: code.width, viewportWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth };
        });
        assert.ok(mobileQrLayout.width > 300, 'mobile QR card fills the available content width');
        assert.ok(mobileQrLayout.codeWidth <= mobileQrLayout.width, 'mobile QR image fits inside its card');
        assert.ok(mobileQrLayout.scrollWidth <= mobileQrLayout.viewportWidth, 'mobile QR layout does not overflow horizontally');
        await qrPage.setViewportSize({ width: 1280, height: 720 });
        const qrSetup = await qrPage.evaluate(() => ({
            orderCreates: window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_create_walkin_order_quoted'),
            checkout: window.__walkinQa.calls.find(call => call.kind === 'function' && call.name === 'staff-walkin-checkout'),
            acknowledgments: window.__walkinQa.acknowledgmentAttempts,
            providerQrImage: Boolean(document.querySelector('[data-staff-walkin-qr-image] img[src^="data:image/png;base64,"]')),
            providerQrDimensions: (() => { const image = document.querySelector('[data-staff-walkin-qr-image] img'); return { width: image?.naturalWidth || 0, height: image?.naturalHeight || 0 }; })(),
        }));
        assert.equal(qrSetup.orderCreates.length, 0, 'QR UI never creates an online order through the browser RPC');
        assert.equal(qrSetup.checkout.options.body.channel, 'qrph', 'QR checkout explicitly requests the backend QR Ph channel');
        assert.equal(qrSetup.checkout.options.body.guest_name, 'QR Guest');
        assert.equal(qrSetup.checkout.options.body.customer_id, null);
        assert.equal(qrSetup.checkout.options.body.items.length, 1);
        assert.ok(qrSetup.checkout.options.body.items[0].quoted_minor > 0, 'the reviewed browser quote travels to the verified checkout service');
        assert.equal(qrSetup.acknowledgments, 0, 'the pending QR is displayed without requesting or fabricating an acknowledgment');
        assert.equal(qrSetup.providerQrImage, true, 'the staff screen renders PayMongo’s actual dynamic QR Ph payload');
        assert.ok(qrSetup.providerQrDimensions.width > 0 && qrSetup.providerQrDimensions.height > 0, 'live QR fixture decodes to a visible image');
        await qrPage.locator('[data-staff-walkin-qr-check]').click();
        assert.equal(await qrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 1);
        assert.match(await qrPage.locator('[data-staff-walkin-qr-status]').innerText(), /Waiting for PayMongo payment confirmation/,
            'the acknowledgment RPCs P0002 for a known unpaid QR order, so the UI keeps showing a normal pending state');
        assert.equal(await qrPage.locator('.payment-ack-card').count(), 0, 'a pending status check does not show a paid acknowledgment');
        await qrPage.clock.fastForward(5000);
        assert.equal(await qrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 2, 'the staff screen polls again while the checkout remains in expiry window');
        assert.match(await qrPage.locator('[data-staff-walkin-qr-status]').innerText(), /Waiting for PayMongo payment confirmation/,
            'the new acknowledgment RPC status-only response remains pending');
        assert.equal(await qrPage.locator('.payment-ack-card').count(), 0, 'a status-only response never renders a receipt');
        await qrPage.clock.fastForward(5000);
        await qrPage.locator('.payment-ack-card').waitFor();
        assert.equal(await qrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 3, 'a later paid response renders the acknowledgment');
        await qrContext.context.close();

        const sandboxQrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { paymentStatus: 'pending', testMode: true, qrTestUrl: 'https://test.paymongo.com/qrph/fixture', ackError: true },
        });
        const sandboxQrPage = sandboxQrContext.page;
        await sandboxQrPage.locator('[data-staff-nav="walkin"]').click();
        await sandboxQrPage.locator('[data-staff-walkin-name]').fill('Sandbox QR Guest');
        await sandboxQrPage.locator('[data-staff-walkin-next]').click();
        await selectWalkinCourt(sandboxQrPage, 'listing-badminton');
        await sandboxQrPage.locator('[data-staff-walkin-next]').click();
        await sandboxQrPage.locator('[data-staff-walkin-hour="11"]').click();
        await sandboxQrPage.locator('[data-staff-walkin-next]').click();
        await sandboxQrPage.locator('[data-staff-walkin-qr-option]').click();
        await sandboxQrPage.locator('[data-staff-walkin-next]').click();
        await sandboxQrPage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(sandboxQrPage, { accept: true });
        const sandboxPanel = sandboxQrPage.locator('.staff-walkin-qr-card');
        await sandboxPanel.getByRole('link', { name: 'Open PayMongo sandbox simulator' }).waitFor();
        const sandboxImage = sandboxQrPage.locator('[data-staff-walkin-qr-image] img');
        await sandboxImage.waitFor();
        await sandboxQrPage.waitForFunction(() => {
            const image = document.querySelector('[data-staff-walkin-qr-image] img');
            return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        });
        assert.equal(await sandboxQrPage.locator('[data-staff-walkin-qr-image] img[src^="data:image/png;base64,"]').count(), 1, 'sandbox screen renders PayMongo’s actual test QR image');
        const sandboxImageDimensions = await sandboxImage.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
        assert.ok(sandboxImageDimensions.width > 0 && sandboxImageDimensions.height > 0, 'sandbox QR fixture decodes to a visible image');
        assert.equal(await sandboxPanel.locator('.staff-walkin-qr-warning[role="alert"]').count(), 1, 'sandbox displays one concise safety warning');
        assert.match(await sandboxPanel.locator('.staff-walkin-qr-warning').innerText(), /Test QR: Do not scan or pay\./i, 'sandbox screen prominently warns against scanning or paying');
        assert.doesNotMatch(await sandboxPanel.innerText(), /actual test QR image|Scanning it can process a real transaction|shown for inspection only/i, 'sandbox screen omits duplicated verbose warning copy');
        assert.equal(await sandboxPanel.locator('[data-staff-walkin-qr-simulate]').getAttribute('href'), 'https://test.paymongo.com/qrph/fixture');
        await sandboxQrPage.clock.fastForward(5000);
        assert.equal(await sandboxQrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 0, 'sandbox does not start payment polling before simulation');
        await sandboxQrPage.locator('[data-staff-walkin-qr-check]').click();
        assert.match(await sandboxQrPage.locator('[data-staff-walkin-qr-status]').innerText(), /Could not verify payment yet/,
            'authorization or other RPC errors remain verification errors instead of being treated as unpaid');
        await sandboxQrPage.clock.fastForward(5000);
        assert.equal(await sandboxQrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 1,
            'a manual sandbox status check does not start repeated polling');
        await sandboxQrContext.context.close();

        const untrustedSimulatorContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { testMode: true, qrTestUrl: 'https://attacker.example/simulator' },
        });
        const untrustedSimulatorPage = untrustedSimulatorContext.page;
        await untrustedSimulatorPage.locator('[data-staff-nav="walkin"]').click();
        await untrustedSimulatorPage.locator('[data-staff-walkin-name]').fill('Sandbox QR Guest');
        await untrustedSimulatorPage.locator('[data-staff-walkin-next]').click();
        await selectWalkinCourt(untrustedSimulatorPage, 'listing-badminton');
        await untrustedSimulatorPage.locator('[data-staff-walkin-next]').click();
        await untrustedSimulatorPage.locator('[data-staff-walkin-hour="11"]').click();
        await untrustedSimulatorPage.locator('[data-staff-walkin-next]').click();
        await untrustedSimulatorPage.locator('[data-staff-walkin-qr-option]').click();
        await untrustedSimulatorPage.locator('[data-staff-walkin-next]').click();
        await untrustedSimulatorPage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(untrustedSimulatorPage, { accept: true });
        const untrustedPanel = untrustedSimulatorPage.locator('.staff-walkin-qr-card');
        assert.equal(await untrustedSimulatorPage.locator('[data-staff-walkin-qr-image] img[src^="data:image/png;base64,"]').count(), 1, 'an untrusted simulator URL does not hide the provider QR image');
        assert.equal(await untrustedPanel.locator('[data-staff-walkin-qr-simulate]').count(), 0, 'untrusted simulator URLs are never linked');
        assert.equal(await untrustedPanel.locator('.staff-walkin-qr-warning[role="alert"]').count(), 1, 'untrusted simulator case keeps one safety warning');
        assert.match(await untrustedPanel.locator('.staff-walkin-qr-warning').innerText(), /Test QR: Do not scan or pay\. Simulator unavailable\./i);
        await untrustedSimulatorContext.context.close();

        const qrPreorderRetryContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { failCheckoutOnce: true, checkoutFailureResponse: { message: 'No order was saved.' } },
        });
        const qrPreorderRetryPage = qrPreorderRetryContext.page;
        await qrPreorderRetryPage.locator('[data-staff-nav="walkin"]').click();
        await qrPreorderRetryPage.locator('[data-staff-walkin-name]').fill('Retry QR Guest');
        await qrPreorderRetryPage.locator('[data-staff-walkin-next]').click();
        await selectWalkinCourt(qrPreorderRetryPage, 'listing-badminton');
        await qrPreorderRetryPage.locator('[data-staff-walkin-next]').click();
        await qrPreorderRetryPage.locator('[data-staff-walkin-hour="11"]').click();
        await qrPreorderRetryPage.locator('[data-staff-walkin-next]').click();
        await qrPreorderRetryPage.locator('[data-staff-walkin-qr-option]').click();
        await qrPreorderRetryPage.locator('[data-staff-walkin-next]').click();
        await qrPreorderRetryPage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(qrPreorderRetryPage, { accept: true });
        const reviewRetry = qrPreorderRetryPage.getByRole('button', { name: 'Review and try again' });
        await reviewRetry.waitFor();
        assert.match(await qrPreorderRetryPage.locator('[data-staff-walkin-receipt]').innerText(), /No walk-in order was created/);
        await reviewRetry.click();
        assert.equal(await qrPreorderRetryPage.locator('[data-staff-walkin-save]').innerText(), 'Show QR Ph');
        assert.equal(await qrPreorderRetryPage.locator('[data-staff-walkin-save]').isDisabled(), false);
        assert.equal(await qrPreorderRetryPage.evaluate(() => window.__walkinQa.checkoutAttempts), 1, 'reviewing the order does not retry automatically');
        await qrPreorderRetryPage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(qrPreorderRetryPage, { accept: true });
        await qrPreorderRetryPage.locator('[data-staff-walkin-qr-image] img[src^="data:image/"]').waitFor();
        assert.equal(await qrPreorderRetryPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'rpc' && call.name === 'staff_create_walkin_order_quoted').length), 0);
        await qrPreorderRetryContext.context.close();

        const qrExistingOrderRetryContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { failCheckoutCount: 2, checkoutFailureResponse: { message: 'QR Ph confirmation is unavailable. Enable the signed payment.paid webhook before accepting QR payments.', order_id: 'existing-order' } },
        });
        const qrExistingOrderRetryPage = qrExistingOrderRetryContext.page;
        await qrExistingOrderRetryPage.locator('[data-staff-nav="walkin"]').click();
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-name]').fill('Existing Order Guest');
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-next]').click();
        await selectWalkinCourt(qrExistingOrderRetryPage, 'listing-badminton');
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-next]').click();
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-hour="11"]').click();
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-next]').click();
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-qr-option]').click();
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-next]').click();
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(qrExistingOrderRetryPage, { accept: true });
        const setupRetry = qrExistingOrderRetryPage.locator('[data-staff-walkin-qr-checkout-retry="existing-order"]');
        await setupRetry.waitFor();
        await setupRetry.click();
        await qrExistingOrderRetryPage.getByText(/QR Ph confirmation is unavailable\. Enable the signed payment\.paid webhook/i).waitFor();
        assert.equal(await qrExistingOrderRetryPage.locator('[data-staff-walkin-qr-checkout-retry="existing-order"]').count(), 1, 'a failed setup retry keeps the pending order retryable');
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-qr-checkout-retry="existing-order"]').click();
        await qrExistingOrderRetryPage.locator('[data-staff-walkin-qr-image] img[src^="data:image/"]').waitFor();
        const retryBodies = await qrExistingOrderRetryPage.evaluate(() => window.__walkinQa.calls
            .filter(call => call.kind === 'function' && call.name === 'staff-walkin-checkout')
            .map(call => call.options.body));
        assert.equal(retryBodies.length, 3);
        assert.deepEqual(retryBodies[1], { order_id: 'existing-order', channel: 'qrph' }, 'a known pending order retries setup by ID without creating a duplicate');
        assert.deepEqual(retryBodies[2], { order_id: 'existing-order', channel: 'qrph' }, 'subsequent retries continue using the same pending order');
        await qrExistingOrderRetryContext.context.close();

        const qrAmbiguousFailureContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', pauseClock: true,
            config: { failCheckoutOnce: true },
        });
        const qrAmbiguousFailurePage = qrAmbiguousFailureContext.page;
        await qrAmbiguousFailurePage.locator('[data-staff-nav="walkin"]').click();
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-name]').fill('Ambiguous QR Guest');
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-next]').click();
        await selectWalkinCourt(qrAmbiguousFailurePage, 'listing-badminton');
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-next]').click();
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-hour="11"]').click();
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-next]').click();
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-qr-option]').click();
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-next]').click();
        await qrAmbiguousFailurePage.locator('[data-staff-walkin-save]').click();
        await resolveStaffConfirm(qrAmbiguousFailurePage, { accept: true });
        await qrAmbiguousFailurePage.getByText(/verify whether an order was created before retrying/i).waitFor();
        assert.equal(await qrAmbiguousFailurePage.getByRole('button', { name: 'Review and try again' }).count(), 0);
        assert.equal(await qrAmbiguousFailurePage.locator('[data-staff-walkin-qr-checkout-retry]').count(), 0);
        await qrAmbiguousFailureContext.context.close();

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
        await resolveStaffConfirm(expiredQrPage, { accept: true });
        await expiredQrPage.locator('[data-staff-walkin-qr-image] img[src^="data:image/png;base64,"]').waitFor();
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
        assert.equal(await expiredQrPage.locator('.payment-ack-card').count(), 0,
            'an expired but unconfirmed checkout still has no acknowledgment');
        await expiredQrContext.context.close();

        const invalidQrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { qrImageUrl: 'https://checkout.paymongo.com.attacker.test/session' },
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
        await resolveStaffConfirm(invalidQrPage, { accept: true });
        await invalidQrPage.getByText('QR Ph unavailable').waitFor();
        assert.equal(await invalidQrPage.locator('[data-staff-walkin-qr-image]').count(), 0, 'a lookalike hostname is never encoded into a QR');
        assert.equal(await invalidQrPage.evaluate(() => window.__walkinQa.acknowledgmentAttempts), 0, 'invalid checkout data never triggers an acknowledgment lookup');
        await invalidQrContext.context.close();

        const ackItem = [{ sport: 'Badminton', court: 'Badminton', unit: 'Court 1', starts_at: '2026-09-27T01:00:00Z', ends_at: '2026-09-27T02:00:00Z', subtotal_minor: 10000 }];
        const pendingReturn = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:30:00Z', query: '?walkin_checkout=return&order=a25dc45b-40ba-4b5b-96d6-4487dbe7a526',
            config: { paymentStatus: 'pending', paymentMethod: 'PayMongo', ackItems: ackItem },
        });
        await pendingReturn.page.locator('.staff-receipt-pending').waitFor();
        assert.equal(await pendingReturn.page.locator('.payment-ack-card').count(), 0, 'return query alone must never produce a paid receipt');
        assert.equal(new URL(pendingReturn.page.url()).searchParams.has('walkin_checkout'), false, 'return markers should be removed from the address bar');
        await pendingReturn.context.close();

        const paidReturn = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:30:00Z', query: '?walkin_checkout=return&order=a25dc45b-40ba-4b5b-96d6-4487dbe7a526',
            config: { paymentStatus: 'paid', paymentMethod: 'PayMongo', ackItems: ackItem },
        });
        await paidReturn.page.locator('[data-staff-panel="walkin"].is-active .payment-ack-card').waitFor();
        assert.equal(new URL(paidReturn.page.url()).searchParams.has('order'), false);
        assert.match(await paidReturn.page.locator('.payment-ack-card').innerText(), /Subtotal \(this payment\)\s+₱350\.00/);
        assert.match(await paidReturn.page.locator('.payment-ack-card').innerText(), /TOTAL PAID\s+₱350\.00/);
        assert.match(await paidReturn.page.locator('.payment-ack-card').innerText(), /Payment status\s+Paid/);
        assert.match(await paidReturn.page.locator('.payment-ack-card').innerText(), /NOT AN OFFICIAL RECEIPT/);
        await paidReturn.context.close();

        const timeInQrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:45:00Z',
            config: {
                testMode: true, qrTestUrl: 'https://test.paymongo.com/qrph/timein-fixture',
                bookings: [{ booking_id: 77, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', court_unit: 'Court 1',
                    time_date: '2026-09-27T01:00:00Z', end_at: '2026-09-27T02:00:00Z', duration_minutes: 60,
                    status: 'confirmed', checked_in_at: null, checked_out_at: null, amount_total: 100, amount_paid: 50,
                    rate_unit_snapshot: '/hr', rate_quantity: 1, payment_id: 12, payment_method: 'PayMongo' }],
            },
        });
        const timeInQrPage = timeInQrContext.page;
        await timeInQrPage.locator('[data-staff-table="overview"] tbody tr[data-row-index] [data-staff-action="timein"]').waitFor();
        await timeInQrPage.locator('[data-staff-table="overview"] tbody tr[data-row-index] [data-staff-action="timein"]').click();
        await timeInQrPage.locator('[data-staff-timein-method="QR Payment"]').click();
        await timeInQrPage.locator('[data-staff-timein-confirm]').click();
        await resolveStaffConfirm(timeInQrPage, { accept: true, title: 'Confirm QR Payment' });
        const timeInQrPanel = timeInQrPage.locator('[data-staff-timein-qr-panel]');
        await timeInQrPanel.locator('.staff-timein-qr-image').waitFor();
        assert.equal(await timeInQrPanel.locator('.staff-walkin-qr-warning[role="alert"]').count(), 1, 'Time-In sandbox displays one concise safety warning');
        assert.match(await timeInQrPanel.locator('.staff-walkin-qr-warning').innerText(), /Test QR: Do not scan or pay\. Use the simulator\./i);
        assert.equal(await timeInQrPanel.getByRole('link', { name: 'Open PayMongo sandbox simulator' }).getAttribute('href'),
            'https://test.paymongo.com/qrph/timein-fixture', 'Time-In keeps its existing sandbox simulator link');
        const timeInDesktopLayout = await timeInQrPanel.evaluate(panel => ({
            panelWidth: panel.getBoundingClientRect().width,
            modalWidth: panel.closest('.staff-modal').getBoundingClientRect().width,
            viewportWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
        }));
        assert.ok(timeInDesktopLayout.modalWidth > 900, 'Time-In QR view expands to a full-width desktop card');
        assert.ok(timeInDesktopLayout.panelWidth < timeInDesktopLayout.modalWidth, 'Time-In QR card remains inset within the expanded modal');
        assert.ok(timeInDesktopLayout.scrollWidth <= timeInDesktopLayout.viewportWidth, 'Time-In desktop QR view does not overflow horizontally');
        await timeInQrPage.setViewportSize({ width: 390, height: 844 });
        const timeInMobileLayout = await timeInQrPanel.evaluate(panel => ({
            panelWidth: panel.getBoundingClientRect().width,
            imageWidth: panel.querySelector('.staff-timein-qr-code').getBoundingClientRect().width,
            viewportWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
        }));
        assert.ok(timeInMobileLayout.panelWidth > 300, `Time-In QR card fills the mobile modal width: ${JSON.stringify(timeInMobileLayout)}`);
        assert.ok(timeInMobileLayout.imageWidth <= timeInMobileLayout.panelWidth, 'Time-In QR image fits within its mobile card');
        assert.ok(timeInMobileLayout.scrollWidth <= timeInMobileLayout.viewportWidth, 'Time-In mobile QR view does not overflow horizontally');
        await timeInQrContext.context.close();

        const untrustedTimeInQrContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:45:00Z',
            config: {
                testMode: true, qrTestUrl: 'https://attacker.example/simulator',
                bookings: [{ booking_id: 78, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', court_unit: 'Court 1',
                    time_date: '2026-09-27T01:00:00Z', end_at: '2026-09-27T02:00:00Z', duration_minutes: 60,
                    status: 'confirmed', checked_in_at: null, checked_out_at: null, amount_total: 100, amount_paid: 50,
                    rate_unit_snapshot: '/hr', rate_quantity: 1, payment_id: 12, payment_method: 'PayMongo' }],
            },
        });
        const untrustedTimeInPage = untrustedTimeInQrContext.page;
        await untrustedTimeInPage.locator('[data-staff-table="overview"] tbody tr[data-row-index] [data-staff-action="timein"]').waitFor();
        await untrustedTimeInPage.locator('[data-staff-table="overview"] tbody tr[data-row-index] [data-staff-action="timein"]').click();
        await untrustedTimeInPage.locator('[data-staff-timein-method="QR Payment"]').click();
        await untrustedTimeInPage.locator('[data-staff-timein-confirm]').click();
        await resolveStaffConfirm(untrustedTimeInPage, { accept: true, title: 'Confirm QR Payment' });
        const untrustedTimeInPanel = untrustedTimeInPage.locator('[data-staff-timein-qr-panel]');
        await untrustedTimeInPanel.locator('.staff-timein-qr-image').waitFor();
        assert.equal(await untrustedTimeInPanel.getByRole('link', { name: 'Open PayMongo sandbox simulator' }).count(), 0,
            'Time-In does not link an untrusted simulator URL');
        assert.match(await untrustedTimeInPanel.locator('.staff-walkin-qr-warning').innerText(), /Test QR: Do not scan or pay\. Simulator unavailable\./i,
            'Time-In clearly warns when its simulator URL is unavailable');
        await untrustedTimeInQrContext.context.close();

        const timeInPaidContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:45:00Z',
            config: {
                testMode: true, qrTestUrl: 'https://test.paymongo.com/qrph/paid-fixture',
                bookings: [{ booking_id: 79, customer_id: 'qa-customer', sports: 'Badminton', courts: 'Badminton', court_unit: 'Court 1',
                    time_date: '2026-09-27T01:00:00Z', end_at: '2026-09-27T02:00:00Z', duration_minutes: 60,
                    status: 'confirmed', checked_in_at: null, checked_out_at: null, amount_total: 100, amount_paid: 50,
                    balance_payment_id: 513, rate_unit_snapshot: '/hr', rate_quantity: 1, payment_id: 12 }],
                paymentHistory: [{ payment_id: 513, acknowledgment: {
                    receipt_id: 'qa-balance-receipt', receipt_number: 'QA-BAL-513', transaction_id: 513,
                    source_id: 79, payment_status: 'paid', payment_method: 'PayMongo', issued_at: '2026-09-27T01:01:00+08:00',
                    subtotal: 50, fee: 0, total: 50, court_subtotal_minor: 5000, amount_paid_minor: 5000,
                    remaining_balance_minor: 0, fee_minor: 0, gross_minor: 5000,
                    items: [{ reservation_id: 79, sport: 'Badminton', court: 'Badminton', unit: 'Court 1',
                        starts_at: '2026-09-27T01:00:00+08:00', ends_at: '2026-09-27T02:00:00+08:00',
                        duration_minutes: 60, rate_unit: '/hr', rate_quantity: 1, subtotal_minor: 5000 }],
                    disclaimer: 'Payment acknowledgment and entry pass — not a BIR invoice or official receipt.',
                } }],
            },
        });
        const timeInPaidPage = timeInPaidContext.page;
        await timeInPaidPage.locator('[data-staff-table="overview"] tbody tr[data-row-index] [data-staff-action="timein"]').waitFor();
        await timeInPaidPage.locator('[data-staff-table="overview"] tbody tr[data-row-index] [data-staff-action="timein"]').click();
        await timeInPaidPage.locator('[data-staff-timein-method="QR Payment"]').click();
        await timeInPaidPage.locator('[data-staff-timein-confirm]').click();
        await resolveStaffConfirm(timeInPaidPage, { accept: true, title: 'Confirm QR Payment' });
        await timeInPaidPage.locator('[data-staff-timein-qr-panel]').waitFor({ state: 'visible' });
        await timeInPaidPage.locator('[data-staff-timein-qr-check]').click();
        await timeInPaidPage.waitForTimeout(50);
        assert.equal(await timeInPaidPage.locator('[data-staff-receipt-modal]').isVisible(), false,
            'an unconfirmed balance never presents a receipt');
        assert.equal(await timeInPaidPage.evaluate(() => window.__walkinQa.calls.filter(call => call.name === 'staff_get_transaction_payment_history').length), 0,
            'acknowledgment history is not queried while the provider payment is pending');
        await timeInPaidPage.evaluate(() => {
            window.__walkinQa.config.bookings[0].amount_paid = 100;
        });
        await timeInPaidPage.locator('[data-staff-timein-qr-check]').click();
        const timeInReceipt = timeInPaidPage.locator('[data-staff-receipt-modal]');
        await timeInReceipt.waitFor({ state: 'visible' });
        assert.match(await timeInReceipt.innerText(), /QA-BAL-513/);
        assert.match(await timeInReceipt.innerText(), /Payment status\s+Paid/);
        assert.equal(await timeInReceipt.locator('[data-staff-receipt-download]').count(), 1,
            'confirmed saved acknowledgment includes its download action');
        assert.equal(await timeInReceipt.locator('[data-staff-receipt-print]').count(), 1,
            'confirmed saved acknowledgment includes its print action');
        assert.equal(await timeInPaidPage.evaluate(() => window.__walkinQa.calls.filter(call => call.name === 'staff_get_transaction_payment_history').length), 1,
            'one confirmed payment loads one saved acknowledgment');
        await timeInPaidPage.locator('[data-staff-receipt-close]').click();
        await timeInPaidPage.waitForTimeout(50);
        assert.equal(await timeInPaidPage.evaluate(() => window.__walkinQa.calls.filter(call => call.name === 'staff_get_transaction_payment_history').length), 1,
            'closing the receipt does not retrieve or create a duplicate acknowledgment');
        await timeInPaidContext.context.close();

        if (process.env.WALKIN_QR_ONLY === '1') {
            assert.deepEqual(errors, [], 'QR walk-in browser scenarios have no uncaught page errors');
            console.log('PASS staff walk-in QR UI: test QR display and warning, simulator filtering, pending confirmation, setup recovery, expiry, and return');
            return;
        }

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
        assert.match(await receiptDialog.innerText(), /Sport:\s+Badminton/);
        assert.match(await receiptDialog.innerText(), /Court:\s+Badminton/);
        assert.match(await receiptDialog.innerText(), /Unit:\s+Court 1/);
        assert.equal(await transactionPage.locator('[data-staff-receipt-print]').count(), 1, 'receipt modal has a print action');
        assert.equal(await transactionPage.locator('[data-staff-receipt-download]').count(), 1, 'receipt modal has a download action');
        await verifyThermalReceiptPrint(transactionPage, '.payment-ack-card', 'booking acknowledgment');
        const printedReceiptText = await transactionPage.locator('.payment-ack-card').innerText();
        assert.match(printedReceiptText, /Subtotal \(this payment\)/i);
        assert.match(printedReceiptText, /Booking total/i);
        assert.match(printedReceiptText, /Remaining balance/i);
        assert.match(printedReceiptText, /TOTAL PAID/i);
        assert.match(printedReceiptText, /Payment method/);
        assert.match(printedReceiptText, /PA-BALANCE/);
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
            config: { phoneValidation: { valid: true, normalized: '+639171234567', available: true } },
        });
        const phonePage = phoneContext.page;
        await phonePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await phonePage.setViewportSize({ width: 360, height: 780 });
        const phoneLayout = await phonePage.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
        assert.ok(phoneLayout.document <= phoneLayout.viewport, `contact settings fit 360px viewport (${JSON.stringify(phoneLayout)})`);
        assert.equal(await phonePage.locator('[data-staff-phone-validate]').count(), 0, 'phone validation is part of the single Save Changes flow');
        await phonePage.locator('[data-staff-settings-edit="profile"]').click();
        const phoneInput = phonePage.locator('[data-staff-settings-mobile]');
        await phoneInput.fill('0917 123 4567');
        await phonePage.locator('[data-staff-settings-save="profile"]').click();
        await resolveStaffConfirm(phonePage, { accept: true, title: 'Save profile changes?' });
        await phonePage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'update' && call.table === 'profiles'));
        const phoneSave = await phonePage.evaluate(() => ({
            validation: window.__walkinQa.calls.filter(call => call.kind === 'function' && call.name === 'validate-contact-phone'),
            update: window.__walkinQa.calls.find(call => call.kind === 'update' && call.table === 'profiles'),
            otpCalls: window.__walkinQa.calls.filter(call => call.kind === 'auth' && ['updateUser', 'verifyOtp'].includes(call.name)),
        }));
        assert.equal(phoneSave.validation.length, 1);
        assert.deepEqual(phoneSave.validation[0].options.body, { phone: '09171234567', purpose: 'contact' });
        assert.equal(phoneSave.update.payload.contact_num, '+639171234567', 'persist the validator returned E.164 value exactly');
        assert.deepEqual(Object.keys(phoneSave.update.payload).sort(), ['address', 'contact_num', 'emergency_contact_name', 'emergency_contact_number'], 'profile save includes only mutable profile fields');
        assert.deepEqual(phoneSave.update.filters, [['id', 'eq', 'qa-staff']], 'profile save is scoped to the signed-in staff account');
        assert.deepEqual(phoneSave.otpCalls, [], 'staff contact validation no longer uses SMS OTP');
        assert.match(await phonePage.locator('[data-staff-phone-status]').innerText(), /Saved number format\/type check passed/i, 'settings display the server validation fields after save');
        assert.match(await phonePage.locator('[data-staff-phone-status]').innerText(), /ownership and reachability are not verified/i);
        await phoneContext.context.close();

        const canceledProfileContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z', config: { profileDetailsDelayMs: 350 },
        });
        const canceledProfilePage = canceledProfileContext.page;
        await canceledProfilePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-name]').getAttribute('readonly'), '', 'full name is read-only initially');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-birthdate]').getAttribute('readonly'), '', 'birthdate stays read-only');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-gender]').isDisabled(), true, 'gender stays disabled');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-edit="profile"]').isVisible(), true, 'Edit is visible initially');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-cancel="profile"]').isVisible(), false, 'Cancel is hidden initially');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-save="profile"]').isVisible(), false, 'Save is hidden until Edit');
        assert.equal(await canceledProfilePage.locator('[data-staff-avatar-remove]').isVisible(), false, 'Remove Photo is hidden when no avatar is saved');
        await canceledProfilePage.locator('[data-staff-settings-edit="profile"]').click();
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-edit="profile"]').isVisible(), false, 'Edit hides while editing');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-cancel="profile"]').isVisible(), true, 'Cancel appears while editing');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-save="profile"]').isVisible(), true, 'Save appears while editing');
        await canceledProfilePage.evaluate(() => {
            document.dispatchEvent(new CustomEvent('inigosync:profile-ready', { detail: window.inigosyncProfile }));
            document.querySelector('[data-staff-settings-mobile]').value = 'draft mobile';
            document.querySelector('[data-staff-settings-address]').value = 'Draft address';
            document.querySelector('[data-staff-settings-emergency-name]').value = 'Draft emergency name';
            document.querySelector('[data-staff-settings-emergency-number]').value = '09171234569';
        });
        await canceledProfilePage.waitForTimeout(500);
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-mobile]').inputValue(), 'draft mobile', 'a delayed profile load preserves the mobile draft');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-address]').inputValue(), 'Draft address', 'a delayed profile load preserves the address draft');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-emergency-name]').inputValue(), 'Draft emergency name', 'a delayed profile load preserves the emergency name draft');
        assert.equal(await canceledProfilePage.locator('[data-staff-settings-emergency-number]').inputValue(), '09171234569', 'a delayed profile load preserves the emergency number draft');
        await canceledProfilePage.locator('[data-staff-settings-mobile]').fill('09171234567');
        await canceledProfilePage.locator('[data-staff-settings-save="profile"]').click();
        await resolveStaffConfirm(canceledProfilePage, { title: 'Save profile changes?', message: 'Save these personal information changes?' });
        await canceledProfilePage.waitForTimeout(50);
        assert.equal(await canceledProfilePage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'canceling profile confirmation prevents writes');
        await canceledProfileContext.context.close();

        const canceledAvatarContext = await openStaffPage(browser, { timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z' });
        const canceledAvatarPage = canceledAvatarContext.page;
        await canceledAvatarPage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        assert.equal(await canceledAvatarPage.locator('[data-staff-avatar-upload-trigger]').isVisible(), true, 'Upload Photo is available directly on the card');
        assert.equal(await canceledAvatarPage.locator('[data-staff-avatar-remove]').isVisible(), false, 'Remove photo stays hidden before an avatar is saved');
        await canceledAvatarPage.locator('[data-staff-avatar-file]').setInputFiles({
            name: 'avatar.png', mimeType: 'image/png',
            buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=', 'base64'),
        });
        await canceledAvatarPage.locator('.itools-crop-modal').waitFor({ state: 'visible' });
        await canceledAvatarPage.locator('.itools-crop-apply').click();
        await resolveStaffConfirm(canceledAvatarPage, { title: 'Save profile photo?', message: 'Save this photo as your profile photo?' });
        assert.equal(await canceledAvatarPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'canceling photo confirmation preserves the original avatar');

        await canceledAvatarPage.locator('[data-staff-avatar-file]').setInputFiles({
            name: 'avatar.png', mimeType: 'image/png',
            buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=', 'base64'),
        });
        await canceledAvatarPage.locator('.itools-crop-modal').waitFor({ state: 'visible' });
        await canceledAvatarPage.locator('.itools-crop-apply').click();
        await resolveStaffConfirm(canceledAvatarPage, { accept: true, title: 'Save profile photo?', message: 'Save this photo as your profile photo?' });
        await canceledAvatarPage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'update' && call.table === 'profiles'));
        const uploadedAvatar = await canceledAvatarPage.evaluate(() => window.__walkinQa.calls.find(call => call.kind === 'update' && call.table === 'profiles'));
        assert.match(uploadedAvatar.payload.avatar_url, /^data:image\/jpeg;base64,/i, 'confirmed crop persists as a JPEG data URL');
        assert.deepEqual(uploadedAvatar.filters, [['id', 'eq', 'qa-staff']], 'avatar upload is scoped to the signed-in staff account');
        assert.equal(await canceledAvatarPage.locator('[data-staff-avatar-remove]').isVisible(), true, 'Remove photo appears for a saved avatar');
        await canceledAvatarPage.locator('[data-staff-avatar-remove]').click();
        await resolveStaffConfirm(canceledAvatarPage, { title: 'Remove profile photo?', message: 'Are you sure you want to remove your profile photo?' });
        await canceledAvatarPage.waitForTimeout(50);
        assert.equal(await canceledAvatarPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 1, 'canceling removal leaves the uploaded photo saved');

        await canceledAvatarPage.locator('[data-staff-avatar-remove]').click();
        await resolveStaffConfirm(canceledAvatarPage, { accept: true, title: 'Remove profile photo?', message: 'Are you sure you want to remove your profile photo?' });
        await canceledAvatarPage.waitForFunction(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length === 2);
        const removedAvatar = await canceledAvatarPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles')[1]);
        assert.equal(removedAvatar.payload.avatar_url, null, 'confirmed removal clears the saved avatar');
        assert.deepEqual(removedAvatar.filters, [['id', 'eq', 'qa-staff']], 'avatar removal is scoped to the signed-in staff account');
        assert.equal(await canceledAvatarPage.locator('[data-staff-avatar-remove]').isVisible(), false, 'Remove photo is hidden after the avatar is removed');
        await canceledAvatarContext.context.close();

        const phoneUnavailableContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { phoneValidationError: { message: 'Service Unavailable', status: 503 } },
        });
        const phoneUnavailablePage = phoneUnavailableContext.page;
        await phoneUnavailablePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await phoneUnavailablePage.locator('[data-staff-settings-edit="profile"]').click();
        await phoneUnavailablePage.locator('[data-staff-settings-mobile]').fill('09171234567');
        await phoneUnavailablePage.locator('[data-staff-settings-save="profile"]').click();
        await resolveStaffConfirm(phoneUnavailablePage, { accept: true, title: 'Save profile changes?' });
        await phoneUnavailablePage.waitForFunction(() => window.__toastMessages.some(message => /Phone validation is unavailable/.test(message.message)));
        assert.equal(await phoneUnavailablePage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'an unavailable validation API prevents profile writes');
        await phoneUnavailableContext.context.close();

        const duplicatePhoneContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { phoneValidation: { valid: false, reason: 'in_use' } },
        });
        const duplicatePhonePage = duplicatePhoneContext.page;
        await duplicatePhonePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await duplicatePhonePage.locator('[data-staff-settings-edit="profile"]').click();
        await duplicatePhonePage.locator('[data-staff-settings-mobile]').fill('09171234567');
        await duplicatePhonePage.locator('[data-staff-settings-save="profile"]').click();
        await resolveStaffConfirm(duplicatePhonePage, { accept: true, title: 'Save profile changes?' });
        await duplicatePhonePage.waitForFunction(() => window.__toastMessages.some(message => /already linked to another account/.test(message.message)));
        assert.equal(await duplicatePhonePage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'a duplicate account number prevents profile writes');
        await duplicatePhoneContext.context.close();

        const emergencyValidationContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: {
                phoneValidationByNumber: {
                    '+639171234567': { valid: true, normalized: '+639171234567', available: false },
                    '+639161234567': { valid: false, reason: 'invalid' },
                },
                phoneValidationErrorByNumber: {
                    '+639151234567': { message: 'Phone availability is temporarily unavailable.' },
                },
                phoneValidationDelayMsByNumber: {
                    '+639111234567': 1700,
                    '+639131234567': 2200,
                },
            },
        });
        const emergencyPage = emergencyValidationContext.page;
        await emergencyPage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await emergencyPage.locator('[data-staff-settings-edit="profile"]').click();
        const emergencyInput = emergencyPage.locator('[data-staff-settings-emergency-number]');
        const emergencyStatus = emergencyPage.locator('[data-staff-emergency-phone-status]');
        await emergencyPage.waitForFunction(() => document.querySelector('[data-staff-settings-emergency-number]')?.value === '+639171234568');
        await emergencyInput.fill('0917 123 4568');
        assert.equal(await emergencyStatus.getAttribute('data-state'), 'neutral', 'the unchanged saved emergency number does not need another lookup');
        await emergencyInput.fill('');
        assert.equal(await emergencyStatus.getAttribute('data-state'), 'neutral', 'an optional blank emergency number remains neutral');
        await emergencyInput.fill('09171234567');
        await emergencyStatus.waitFor({ state: 'visible' });
        await emergencyPage.waitForFunction(() => document.querySelector('[data-staff-emergency-phone-status]')?.dataset.state === 'warning');
        assert.match(await emergencyStatus.innerText(), /already saved somewhere/i);
        assert.equal(await emergencyInput.getAttribute('aria-invalid'), 'false');

        await emergencyInput.fill('not a phone');
        assert.equal(await emergencyInput.getAttribute('aria-invalid'), 'true', 'invalid local format is marked accessibly');
        assert.match(await emergencyStatus.innerText(), /valid Philippine mobile/i);
        assert.equal(await emergencyPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'function' && call.name === 'validate-contact-phone').length), 1, 'invalid format does not call the validation service');

        await emergencyInput.fill('09161234567');
        await emergencyPage.waitForFunction(() => document.querySelector('[data-staff-emergency-phone-status]')?.dataset.state === 'invalid' && /valid Philippine mobile/.test(document.querySelector('[data-staff-emergency-phone-status]').textContent));
        assert.equal(await emergencyInput.getAttribute('aria-invalid'), 'true');

        await emergencyInput.fill('09151234567');
        await emergencyPage.waitForFunction(() => document.querySelector('[data-staff-emergency-phone-status]')?.dataset.state === 'invalid' && /availability could not be checked/i.test(document.querySelector('[data-staff-emergency-phone-status]').textContent));

        await emergencyInput.fill('09111234567');
        await emergencyPage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'function' && call.name === 'validate-contact-phone' && call.options.body.phone === '+639111234567'));
        await emergencyInput.fill('09121234567');
        await emergencyPage.waitForFunction(() => document.querySelector('[data-staff-emergency-phone-status]')?.dataset.state === 'valid');
        assert.match(await emergencyStatus.innerText(), /Valid Philippine mobile number and not found/i);
        await emergencyPage.waitForTimeout(1200);
        assert.equal(await emergencyStatus.getAttribute('data-state'), 'valid', 'a delayed response for the previous number cannot replace the current result');
        assert.equal(await emergencyInput.getAttribute('aria-invalid'), 'false');

        await emergencyInput.fill('09131234567');
        await emergencyPage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'function' && call.name === 'validate-contact-phone' && call.options.body.phone === '+639131234567'));
        await emergencyPage.locator('[data-staff-settings-save="profile"]').click();
        assert.equal(await emergencyPage.locator('[data-staff-confirm-modal]').isVisible(), false, 'save stays blocked while number availability is pending');
        assert.equal(await emergencyPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'pending validation prevents the whole profile write');
        await emergencyPage.waitForFunction(() => document.querySelector('[data-staff-emergency-phone-status]')?.dataset.state === 'valid');
        await emergencyPage.locator('[data-staff-settings-save="profile"]').click();
        await resolveStaffConfirm(emergencyPage, { accept: true, title: 'Save profile changes?' });
        await emergencyPage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'update' && call.table === 'profiles'));
        const emergencyValidationCalls = await emergencyPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'function' && call.name === 'validate-contact-phone'));
        assert.ok(emergencyValidationCalls.length >= 5 && emergencyValidationCalls.every(call => call.options.body.purpose === 'emergency'), 'all emergency-number checks request emergency-scoped proofs');
        const emergencySave = await emergencyPage.evaluate(() => window.__walkinQa.calls.find(call => call.kind === 'update' && call.table === 'profiles'));
        assert.equal(emergencySave.payload.emergency_contact_number, '+639131234567', 'save persists the exact validated normalized number');
        assert.deepEqual(emergencySave.filters, [['id', 'eq', 'qa-staff']], 'profile save remains scoped to the signed-in staff account');
        await emergencyValidationContext.context.close();

        const mobileRaceContext = await openStaffPage(browser, {
            timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z',
            config: { phoneValidationDelayMsByNumber: { '+639171234567': 900 } },
        });
        const mobileRacePage = mobileRaceContext.page;
        await mobileRacePage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await mobileRacePage.locator('[data-staff-settings-edit="profile"]').click();
        const raceMobile = mobileRacePage.locator('[data-staff-settings-mobile]');
        await raceMobile.fill('09171234567');
        await mobileRacePage.locator('[data-staff-settings-save="profile"]').click();
        await resolveStaffConfirm(mobileRacePage, { accept: true, title: 'Save profile changes?' });
        await mobileRacePage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'function' && call.name === 'validate-contact-phone'));
        await raceMobile.fill('09181234568');
        await mobileRacePage.waitForFunction(() => window.__toastMessages.some(message => /profile changed while the number was being checked/i.test(message.message)));
        assert.equal(await mobileRacePage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'update' && call.table === 'profiles').length), 0, 'a mobile draft changed during the database check, so no stale profile patch is written');
        await mobileRaceContext.context.close();

        const passwordContext = await openStaffPage(browser, { timezoneId: 'Asia/Manila', now: '2026-09-27T00:00:00Z' });
        const passwordPage = passwordContext.page;
        await passwordPage.locator('.staff-sidebar .staff-nav [data-staff-nav="settings"]').click();
        await passwordPage.locator('[data-staff-pw-current]').fill('CurrentPass1!');
        await passwordPage.locator('[data-staff-pw-next]').click();
        await passwordPage.locator('[data-staff-pw-new]').fill('NewPass123!');
        await passwordPage.locator('[data-staff-pw-confirm]').fill('NewPass123!');
        const passwordSave = passwordPage.locator('[data-staff-settings-save="password"]');
        await passwordSave.click();
        const passwordConfirm = passwordPage.locator('[data-staff-confirm-modal]');
        await passwordConfirm.waitFor({ state: 'visible' });
        assert.equal(await passwordConfirm.locator('[data-staff-confirm-title]').innerText(), 'Save new password?');
        assert.equal(await passwordPage.evaluate(() => document.activeElement?.matches('[data-staff-confirm-cancel]')), true, 'confirmation takes keyboard focus');
        await passwordPage.keyboard.press('Escape');
        await passwordConfirm.waitFor({ state: 'hidden' });
        assert.equal(await passwordPage.evaluate(() => document.activeElement?.matches('[data-staff-settings-save="password"]')), true, 'Escape restores focus to the initiating Save button');
        assert.equal(await passwordPage.evaluate(() => window.__walkinQa.calls.filter(call => call.kind === 'auth' && call.name === 'updateUser').length), 0, 'Escape cancels password mutation');
        await passwordSave.click();
        await resolveStaffConfirm(passwordPage, { accept: true, title: 'Save new password?', message: 'Are you sure you want to save this new password?' });
        await passwordPage.waitForFunction(() => window.__walkinQa.calls.some(call => call.kind === 'auth' && call.name === 'updateUser'));
        await passwordContext.context.close();

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
        assert.equal(thermalPageSize, 'auto', 'the fallback @page size is valid CSSOM syntax');
        assert.deepEqual(errors, [], 'walk-in browser console must have no uncaught page errors');
        await responsive.context.close();
        console.log('PASS staff walk-in UI: atomic orders, GCash QR lifecycle and retry, Manila date boundary, and responsive widths');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
