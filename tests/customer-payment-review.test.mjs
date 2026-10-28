import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../Pages/user_dashboard.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const dashboard = readFileSync(new URL('../includes/Dashboard.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const dashboardCss = readFileSync(new URL('../Style/Dashboard.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const checkoutEdge = readFileSync(new URL('../supabase/functions/paymongo-checkout/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Step 5 presents readable terms, receipt details, and pay-online wording', () => {
    const stepStart = html.indexOf('data-dash-book-step="5"');
    const stepEnd = html.indexOf('data-dash-book-fee-confirmation', stepStart);
    const step = html.slice(stepStart, stepEnd);
    assert.match(step, /dash-payment-review-layout/);
    assert.match(step, /data-dash-payment-receipt-items/);
    assert.match(step, /<label class="dash-payment-terms-checkbox-label">[\s\S]*?data-dash-payment-terms-accepted[\s\S]*?I have read and agree to the booking and payment terms/);
    assert.match(step, /href="terms\.html"[^>]*>Read the full Terms &amp; Conditions/);
    assert.match(step, /<dialog[^>]*data-dash-payment-terms-dialog[^>]*aria-labelledby/);
    assert.match(step, /data-dash-payment-terms-accepted/);
    assert.match(dashboardCss, /\.dash-payment-terms-dialog \{[^}]*position: fixed; top: 50%; left: 50%; transform: translate\(-50%, -50%\)/);
    assert.match(dashboardCss, /\.dash-payment-terms-dialog \{[^}]*width: min\(calc\(100vw - 32px\), 560px\)/);
    assert.match(step, /Once made, a booking cannot be cancelled/i);
    assert.match(step, /non-refundable/i);
    assert.match(step, /fixed 30-minute grace period applies: arrive at Iñigos Sports Center within 30 minutes/i);
    assert.match(step, /more than 30 minutes after it/i);
    assert.match(step, /cannot be rescheduled/i);
    assert.match(step, /registered customer account/i);
    assert.match(step, /accurate name and mobile number/i);
    assert.match(step, /rate shown when you make the booking applies/i);
    assert.match(step, /deposit percentage/i);
    assert.match(step, /balance is due at check-in/i);
    assert.match(step, /PayMongo may add a processing fee/i);
    assert.match(step, /methods depend on what the sports center has enabled/i);
    assert.match(step, /confirmed only after IñigoSync validates PayMongo’s payment-success confirmation/i);
    assert.match(step, /follow the payment instructions shown in IñigoSync/i);
    assert.match(step, /Proceed to pay online/);

    const modal = step.slice(step.indexOf('<dialog'), step.indexOf('</dialog>') + '</dialog>'.length);
    assert.match(modal, /data-dash-payment-terms-decline[^>]*>Disagree/);
    assert.match(modal, /data-dash-payment-terms-agree[^>]*>Agree/);
    assert.match(modal, /class="dash-payment-terms-body"[^>]*id="dash-payment-terms-description"/);
    assert.match(modal, /<h5>Booking details<\/h5>[\s\S]*?<h5>Payment and confirmation<\/h5>[\s\S]*?<h5>Attendance, cancellation, and refunds<\/h5>/);
    assert.ok(modal.indexOf('>Disagree</button>') < modal.indexOf('>Agree</button>'), 'Disagree is immediately before Agree');
    assert.match(dashboardCss, /\.dash-payment-terms-dialog\[open\] \{ display: flex; flex-direction: column; \}/);
    assert.match(dashboardCss, /\.dash-payment-terms-body \{[^}]*overflow-y: auto/);
    assert.match(dashboardCss, /\.dash-payment-terms-actions \{[^}]*justify-content: flex-end;[^}]*flex-wrap: nowrap/);
    assert.match(dashboardCss, /\.dash-payment-terms-actions button \{ flex: 0 0 auto; min-width: 0;/);
    assert.doesNotMatch(dashboardCss, /\.dash-payment-terms-actions \{ display: grid; grid-template-columns: 1fr; \}/);
    assert.match(dashboard, /paymentTermsDialog\.showModal\(\)/);
    assert.match(dashboard, /paymentTermsAccepted\?\.addEventListener\('change',[\s\S]*?if \(paymentTermsAccepted\.checked\) openPaymentTermsDialog\(\)/);
    assert.match(dashboard, /paymentTermsDecline\?\.focus\(\{ preventScroll: true \}\)/);
    assert.match(dashboard, /paymentTermsAgree\?\.addEventListener\('click', \(\) => closePaymentTermsDialog\(true\)\)/);
    assert.match(dashboard, /paymentTermsDecline\?\.addEventListener\('click', \(\) => closePaymentTermsDialog\(false\)\)/);
    assert.match(dashboard, /paymentTermsAccepted\.checked = accepted/);
    assert.match(dashboard, /paymentTermsAccepted\.checked = false;[\s\S]*?paymentTermsDialog\.showModal\(\)/);
    assert.match(dashboard, /closePaymentTermsDialog\(false\)/);
    assert.match(dashboard, /handleBookingDialogKeydown\([\s\S]*?paymentTermsDialog/);
    assert.match(dashboard, /paymentTermsOpen\?\.focus\(\{ preventScroll: true \}\)/);
    assert.match(dashboard, /paymentAcceptanceSignature !== acceptanceSignature[\s\S]*?paymentTermsAccepted\.checked = false/);

    const feeStart = html.indexOf('data-dash-book-fee-confirmation');
    const feeEnd = html.indexOf('data-dash-book-remove-confirmation', feeStart);
    const feeCopy = html.slice(feeStart, feeEnd);
    assert.match(feeCopy, /transaction fee/i);
    assert.match(feeCopy, /final total/i);
    assert.match(feeCopy, /Proceed to pay online/);
    assert.doesNotMatch(feeCopy, /PayMongo/i);
});

test('receipt and due-now amounts track cart/payment changes and acceptance is required', () => {
    const start = dashboard.indexOf('    function updateSummary() {');
    const end = dashboard.indexOf('\n    if (bookSlotsGrid)', start);
    assert.ok(start >= 0 && end > start, 'Step 5 summary update function is present');

    const bookingCart = [{
        sport: 'Badminton', court: 'Court 1', unit: 'Court A', date: '2026-11-02',
        startHour: 10, endHour: 11, estimatedTotal: 800, listingId: 'listing-db-id', unitId: 'unit-db-id',
    }];
    const document = {
        querySelector(selector) {
            return ({
                '[data-dash-booking-gross]': bookingGross,
            })[selector] || null;
        },
    };
    const bookingGross = { textContent: '' };
    const receipt = { innerHTML: '' };
    const submit = { disabled: false, textContent: '' };
    const acceptance = { checked: false };
    const termsStatus = { textContent: '', classList: { toggle(_name, value) { this.accepted = value; } } };
    const summaryPayment = { textContent: '' };
    const summaryGross = { textContent: '' };
    const summaryTotal = { textContent: '' };
    const summaryBalance = { textContent: '' };
    const context = {
        bookingState: { downpaymentPct: 30, paymentType: 'downpayment' },
        bookingCart, paymentAcceptanceSignature: null, paymentTermsAccepted: acceptance,
        paymentTermsStatus: termsStatus,
        paymentReceiptItems: receipt, bookSubmit: submit,
        summaryPayment, summaryGross, summaryTotal, summaryBalance, downpaymentDesc: null,
        paymentModeHint: { textContent: '' }, bookAddButton: null,
        bookingCartSaving: false, plainSummaryBackMode: false, editingBookingCartKey: null,
        slotGridLoading: false, document,
        window: {
            InigoBusinessHours: { formatHourLabel: (hour) => `${hour}:00` },
            escapeHtml: (value) => String(value),
        },
        formatDate: (date) => date,
        renderBookWizard() {}, renderBookingCart() {},
    };
    runInNewContext(`${dashboard.slice(start, end)}\nglobalThis.updateSummaryForTest = updateSummary;`, context);

    context.updateSummaryForTest();
    assert.equal(submit.disabled, true, 'checkout stays disabled until terms are accepted');
    assert.equal(termsStatus.textContent, 'Not accepted');
    assert.equal(summaryTotal.textContent, '₱240.00');
    assert.equal(summaryBalance.textContent, '₱560.00');
    assert.match(receipt.innerHTML, /Badminton · Court 1 · Court A/);
    assert.match(receipt.innerHTML, /2026-11-02/);
    assert.doesNotMatch(receipt.innerHTML, /listing-db-id|unit-db-id|item-\d+/);

    acceptance.checked = true;
    context.updateSummaryForTest();
    assert.equal(submit.disabled, false);
    assert.equal(termsStatus.textContent, 'Accepted for this selection');
    assert.equal(termsStatus.classList.accepted, true);
    context.bookingState.paymentType = 'full';
    context.updateSummaryForTest();
    assert.equal(acceptance.checked, false, 'a payment option change requires fresh acceptance');
    assert.equal(submit.disabled, true);
    assert.equal(summaryTotal.textContent, '₱800.00');
    assert.equal(summaryBalance.textContent, '₱0.00');
});

test('checkbox opens terms dialog; agree accepts, while decline and Escape leave it unchecked', () => {
    const focusHelperStart = dashboard.indexOf('    function handleBookingDialogKeydown(event, dialog, close) {');
    const focusHelperEnd = dashboard.indexOf('\n    bookingCartDetailsButton?.addEventListener', focusHelperStart);
    const bindStart = dashboard.indexOf('    function closePaymentTermsDialog(accepted = false) {');
    const bindEnd = dashboard.indexOf('\n    // ------------------------------------------------------------------\n    // Step 3', bindStart);
    assert.ok(focusHelperStart >= 0 && focusHelperEnd > focusHelperStart);
    assert.ok(bindStart >= 0 && bindEnd > bindStart);
    const listeners = () => new Map();
    const makeButton = () => ({ listeners: listeners(), isConnected: true, disabled: false,
        addEventListener(type, callback) { this.listeners.set(type, callback); },
        focus() { this.focused = true; }, closest() { return null; }, getClientRects() { return [{}]; } });
    const paymentTermsOpen = makeButton();
    const paymentTermsAgree = makeButton();
    const paymentTermsDecline = makeButton();
    const heading = { focus() { this.focused = true; } };
    const paymentTermsDialog = {
        open: false, listeners: listeners(),
        addEventListener(type, callback) { this.listeners.set(type, callback); },
        querySelector() { return heading; },
        querySelectorAll() { return [paymentTermsDecline, paymentTermsAgree]; },
        showModal() { this.open = true; },
        focus() { this.focused = true; },
        close() { this.open = false; this.listeners.get('close')?.(); },
    };
    paymentTermsOpen.checked = false;
    const acceptance = paymentTermsOpen;
    const context = {
        paymentTermsDialog, paymentTermsOpen, paymentTermsAgree, paymentTermsDecline,
        paymentTermsAccepted: acceptance, paymentTermsDialogAgreed: false, paymentTermsReturnFocus: null,
        updateSummary() { context.checkoutDisabled = !acceptance.checked; },
        document: { activeElement: null },
    };
    runInNewContext(`${dashboard.slice(focusHelperStart, focusHelperEnd)}\n${dashboard.slice(bindStart, bindEnd)}\nglobalThis.paymentTermsState = { open: paymentTermsOpen, agree: paymentTermsAgree, decline: paymentTermsDecline, dialog: paymentTermsDialog };`, context);
    const controls = context.paymentTermsState;
    const toggleCheckbox = () => {
        acceptance.checked = !acceptance.checked;
        controls.open.listeners.get('change')();
    };

    toggleCheckbox();
    assert.equal(controls.dialog.open, true);
    assert.equal(acceptance.checked, false, 'requesting terms review does not itself accept');
    assert.equal(paymentTermsDecline.focused, true, 'focus enters on the first tabbable action');
    context.document.activeElement = paymentTermsDecline;
    const shiftTab = { key: 'Tab', shiftKey: true, preventDefault() { this.defaultPrevented = true; } };
    controls.dialog.listeners.get('keydown')(shiftTab);
    assert.equal(shiftTab.defaultPrevented, true);
    assert.equal(paymentTermsAgree.focused, true, 'Shift+Tab wraps to the final action');
    assert.equal(acceptance.checked, false);
    controls.agree.listeners.get('click')();
    assert.equal(acceptance.checked, true);
    assert.equal(controls.dialog.open, false);
    assert.equal(context.checkoutDisabled, false);

    toggleCheckbox();
    assert.equal(acceptance.checked, false, 'unchecking withdraws the current acceptance');
    toggleCheckbox();
    assert.equal(controls.dialog.open, true, 'checking again opens the dialog for a fresh decision');
    controls.decline.listeners.get('click')();
    assert.equal(acceptance.checked, false);
    assert.equal(context.checkoutDisabled, true);

    toggleCheckbox();
    controls.dialog.listeners.get('cancel')({ preventDefault() {} });
    assert.equal(acceptance.checked, false, 'Escape cancellation leaves checkout blocked');
    assert.equal(controls.dialog.open, false);
    assert.equal(paymentTermsOpen.focused, true, 'closing returns focus to the checkbox');
});

test('My Bookings policy notice refreshes from the forced authoritative owner rule', async () => {
    const todayLoaderStart = dashboard.indexOf('    async function loadTodayBookingGraceRule(');
    const bookingLoaderStart = dashboard.indexOf('    async function loadBookingGraceRules(', todayLoaderStart);
    const bookingLoaderEnd = dashboard.indexOf('\n    function renderBookingPolicyNotice(', bookingLoaderStart);
    const renderStart = bookingLoaderEnd + 1;
    const activeStart = dashboard.indexOf('    function isMyBookingsPanelActive()', renderStart);
    const activeEnd = dashboard.indexOf('\n    async function refreshBookingPolicyNotice()', activeStart);
    const refreshStart = dashboard.indexOf('    async function refreshBookingPolicyNotice() {');
    const refreshEnd = dashboard.indexOf('\n    document.addEventListener(\'inigosync:booking-rules-updated\'', refreshStart);
    const renderEnd = activeStart;
    assert.ok(todayLoaderStart >= 0 && bookingLoaderStart > todayLoaderStart && bookingLoaderEnd > bookingLoaderStart);
    assert.ok(activeStart > renderStart && activeEnd > activeStart);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart);

    const notice = { textContent: '' };
    const calls = [];
    const context = {
        bookingPolicyNotice: notice,
        bookingGraceMinutesByDate: new Map(),
        bookingTodayGraceRuleGeneration: 0,
        bookingTodayGraceRuleRequest: null,
        bookingDateForRules: () => '2026-10-27',
        document: { querySelector() { return { classList: { contains() { return true; } } }; } },
        isMyBookingsPanelActive: () => true,
        renderBookingPolicyNotice: null,
        window: { InigoBusinessHours: { async getForDate(date, options) {
            calls.push({ date, options });
            return { authoritative: true, graceMinutes: 45 };
        } } },
        console: { warn() {} },
    };
    const todayLoader = dashboard.slice(todayLoaderStart, bookingLoaderStart);
    const bookingLoader = dashboard.slice(bookingLoaderStart, bookingLoaderEnd);
    const renderFunction = dashboard.slice(renderStart, renderEnd);
    const refreshFunction = dashboard.slice(refreshStart, refreshEnd);
    runInNewContext(`${todayLoader}\n${bookingLoader}\n${renderFunction}\n${refreshFunction}\nglobalThis.refreshPolicyForTest = refreshBookingPolicyNotice; globalThis.loadBookingRulesForTest = loadBookingGraceRules;`, context);

    await context.refreshPolicyForTest();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].date, '2026-10-27');
    assert.equal(calls[0].options.force, true);
    assert.match(notice.textContent, /within 45 minutes after your start time/);
    assert.doesNotMatch(notice.textContent, /30 minutes/);

    context.window.InigoBusinessHours.getForDate = async () => ({ authoritative: false, graceMinutes: 30 });
    await context.refreshPolicyForTest();
    assert.match(notice.textContent, /within the grace period set by the venue/);
    assert.doesNotMatch(notice.textContent, /30 minutes/);

    context.window.InigoBusinessHours.getForDate = async () => { throw new Error('rules unavailable'); };
    await context.refreshPolicyForTest();
    assert.match(notice.textContent, /within the grace period set by the venue/);
    assert.doesNotMatch(notice.textContent, /30 minutes/);
});

test('forced owner rule refresh wins over an older in-flight booking-list rule read', async () => {
    const todayLoaderStart = dashboard.indexOf('    async function loadTodayBookingGraceRule(');
    const bookingLoaderStart = dashboard.indexOf('    async function loadBookingGraceRules(', todayLoaderStart);
    const bookingLoaderEnd = dashboard.indexOf('\n    function renderBookingPolicyNotice(', bookingLoaderStart);
    const renderStart = bookingLoaderEnd + 1;
    const activeStart = dashboard.indexOf('    function isMyBookingsPanelActive()', renderStart);
    const activeEnd = dashboard.indexOf('\n    async function refreshBookingPolicyNotice()', activeStart);
    const refreshStart = activeEnd + 1;
    const refreshEnd = dashboard.indexOf('\n    document.addEventListener(\'inigosync:booking-rules-updated\'', refreshStart);
    const pending = [];
    const notice = { textContent: '' };
    const context = {
        bookingPolicyNotice: notice,
        bookingGraceMinutesByDate: new Map(),
        bookingTodayGraceRuleGeneration: 0,
        bookingTodayGraceRuleRequest: null,
        bookingDateForRules: () => '2026-10-27',
        document: { querySelector() { return { classList: { contains() { return true; } } }; } },
        isMyBookingsPanelActive: () => true,
        window: { InigoBusinessHours: { getForDate(date, options) {
            return new Promise((resolve) => pending.push({ date, options, resolve }));
        } } },
        console: { warn() {} },
    };
    const todayLoader = dashboard.slice(todayLoaderStart, bookingLoaderStart);
    const bookingLoader = dashboard.slice(bookingLoaderStart, bookingLoaderEnd);
    const renderFunction = dashboard.slice(renderStart, activeStart);
    const activeFunction = dashboard.slice(activeStart, activeEnd);
    const refreshFunction = dashboard.slice(refreshStart, refreshEnd);
    runInNewContext(`${todayLoader}\n${bookingLoader}\n${renderFunction}\n${activeFunction}\n${refreshFunction}\nglobalThis.refreshPolicyForTest = refreshBookingPolicyNotice; globalThis.loadBookingRulesForTest = loadBookingGraceRules;`, context);

    const staleBookingLoad = context.loadBookingRulesForTest([], { forceToday: false });
    await Promise.resolve();
    const freshOwnerRefresh = context.refreshPolicyForTest();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].options.force, false);
    assert.equal(pending[1].options.force, true);

    pending[1].resolve({ authoritative: true, graceMinutes: 45 });
    await freshOwnerRefresh;
    pending[0].resolve({ authoritative: true, graceMinutes: 30 });
    await staleBookingLoad;

    assert.equal(context.bookingGraceMinutesByDate.get('2026-10-27'), 45);
    assert.match(notice.textContent, /within 45 minutes after your start time/);
    assert.doesNotMatch(notice.textContent, /30 minutes/);
});

test('checkout submission and its direct click handler guard terms acceptance', () => {
    const submitStart = dashboard.indexOf('    async function submitBookingCart() {');
    const submitGuardEnd = dashboard.indexOf('        if (bookingCartSaving || !window.sb', submitStart);
    assert.ok(submitStart >= 0 && submitGuardEnd > submitStart);
    assert.match(dashboard.slice(submitStart, submitGuardEnd), /if \(!paymentTermsAccepted\?\.checked\)/);
    assert.match(dashboard, /if \(bookSubmit\.disabled \|\| !paymentTermsAccepted\?\.checked\)/);
    assert.match(dashboard, /terms_acceptance:\s*\{ accepted: true, version: 'customer-booking-v1' \}/);
    assert.doesNotMatch(dashboard, /Payment is processed securely through PayMongo after review/);
    assert.doesNotMatch(dashboard, /Your time remains held until PayMongo closes it/);
    assert.doesNotMatch(dashboard, /update your booking when PayMongo confirms it/);
    assert.doesNotMatch(checkoutEdge, /return json\(\{ message: "PayMongo/);
    assert.match(checkoutEdge, /console\.error\("PayMongo rejected checkout"/);
});

test('verified paid returns open the saved receipt once; failed or pending returns do not celebrate', () => {
    const handlerStart = dashboard.indexOf('    function handlePaymentReturnStatus(');
    const handlerEnd = dashboard.indexOf('\n    // The payment provider redirects back', handlerStart);
    const claimStart = dashboard.indexOf('    function claimPaymentCelebration(');
    const claimEnd = dashboard.indexOf('\n    function playPaymentSuccessSound()', claimStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    assert.ok(claimStart >= 0 && claimEnd > claimStart);

    const celebrations = [];
    const pendingStates = [];
    const notices = [];
    let refreshes = 0;
    const storage = new Map();
    const context = {
        celebratedPaymentAttempts: new Set(),
        window: {
            sessionStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); } },
            InigoToast: { show(message) { notices.push(message); } },
        },
        refreshMyBookings() { refreshes += 1; },
        showVerifiedPaymentReceipt(attemptId, bookingIds) { celebrations.push({ attemptId, bookingIds }); },
        persistPendingPaymentReceipt(attemptId, bookingReceipts) { pendingStates.push({ attemptId, bookingReceipts }); return true; },
        persistPendingPaymentStatusCheck() {},
        clearPendingPaymentStatusCheck() {},
        schedulePaymentStatusRetry() {},
    };
    runInNewContext(`${dashboard.slice(claimStart, claimEnd)}\n${dashboard.slice(handlerStart, handlerEnd)}\nglobalThis.handleStatus = handlePaymentReturnStatus; globalThis.claimOnce = claimPaymentCelebration;`, context);

    context.handleStatus(new Error('network'), null, 'attempt-failed', 'success');
    assert.equal(celebrations.length, 0, 'failed verification does not open a receipt');
    context.handleStatus(null, { status: 'pending' }, 'attempt-pending', 'success');
    assert.equal(celebrations.length, 0, 'pending status does not celebrate');
    context.handleStatus(null, { status: 'paid', booking_receipts: [{ booking_id: 101, payment_id: 9001 }] }, 'attempt-paid', 'success');
    assert.deepEqual(celebrations.map(({ attemptId }) => attemptId), ['attempt-paid']);
    assert.deepEqual(pendingStates.map(({ attemptId }) => attemptId), ['attempt-paid'], 'only paid status creates persistent receipt work');
    assert.equal(refreshes, 1, 'verified payment refreshes bookings');
    assert.match(notices[0], /could not confirm checkout/, 'failed verification asks the customer to check again');
    assert.match(notices[1], /Payment is still processing/, 'pending status remains clearly pending');
    assert.match(notices[2], /Payment received/, 'only the verified paid response confirms payment');

    assert.equal(context.claimOnce('attempt-paid'), true);
    assert.equal(context.claimOnce('attempt-paid'), false, 'same tab cannot replay a claimed celebration');
    const secondTabContext = {
        celebratedPaymentAttempts: new Set(),
        window: { sessionStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, value); } } },
    };
    runInNewContext(`${dashboard.slice(claimStart, claimEnd)}\nglobalThis.claimOnce = claimPaymentCelebration;`, secondTabContext);
    assert.equal(secondTabContext.claimOnce('attempt-paid'), false, 'session storage prevents reload replay');

    const migration = readFileSync(new URL('../supabase/migrations/20261028101500_verified_checkout_booking_receipt_ids.sql', import.meta.url), 'utf8');
    const checkoutEdge = readFileSync(new URL('../supabase/functions/paymongo-checkout/index.ts', import.meta.url), 'utf8');
    assert.match(migration, /a\.customer_id = p_customer_id[\s\S]*?a\.status = 'paid'/);
    assert.match(migration, /i\.customer_id = p_customer_id[\s\S]*?i\.status = 'paid'/);
    assert.match(migration, /b\.payment_id is not null/);
    assert.match(checkoutEdge, /if \(current\.status === "paid"\)[\s\S]*?get_paid_checkout_booking_receipts[\s\S]*?booking_receipts/);
    assert.match(dashboard, /prefers-reduced-motion: reduce/);
    assert.match(dashboard, /audio\.resume\(\)\.catch/);
});

test('pending checkout status is persisted and bounded polling discovers paid or clears expired', async () => {
    const pendingStart = dashboard.indexOf('    function persistPendingPaymentStatusCheck(');
    const pendingEnd = dashboard.indexOf('\n    function schedulePaymentStatusRetry(', pendingStart);
    const scheduleStart = dashboard.indexOf('    function schedulePaymentStatusRetry(', pendingStart);
    const scheduleEnd = dashboard.indexOf('\n    function claimPaymentCelebration(', scheduleStart);
    const handlerStart = dashboard.indexOf('    function handlePaymentReturnStatus(');
    const handlerEnd = dashboard.indexOf('\n    function resumePendingPaymentStatusChecks()', handlerStart);
    assert.ok(pendingStart >= 0 && pendingEnd > pendingStart);
    assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);

    const makeSessionStorage = () => {
        const values = new Map();
        return {
            values,
            get length() { return values.size; },
            key(index) { return [...values.keys()][index] || null; },
            getItem(key) { return values.get(key) || null; },
            setItem(key, value) { values.set(key, String(value)); },
            removeItem(key) { values.delete(key); },
        };
    };
    const makeContext = statuses => {
        const scheduled = [];
        const actions = [];
        const receipts = [];
        const storage = makeSessionStorage();
        const context = {
            pendingPaymentStatusChecks: new Map(),
            activePaymentStatusChecks: new Set(),
            PAYMENT_STATUS_RETRY_DELAYS_MS: [1000, 2000, 4000, 8000, 15000],
            PENDING_PAYMENT_STATUS_PREFIX: 'inigosync:pending-payment-status:',
            window: {
                sessionStorage: storage,
                setTimeout(callback, delay) { scheduled.push({ callback, delay }); },
                InigoToast: { show() {} },
                sb: { functions: { invoke(_name, { body }) { actions.push(body.action); return Promise.resolve(statuses.shift()); } } },
            },
            refreshMyBookings() {},
            persistPendingPaymentReceipt() { return true; },
            showVerifiedPaymentReceipt(attemptId, bookingReceipts) { receipts.push({ attemptId, bookingReceipts }); },
        };
        const code = `
            const pendingPaymentStatusChecks = new Map();
            const activePaymentStatusChecks = new Set();
            const PAYMENT_STATUS_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
            const PENDING_PAYMENT_STATUS_PREFIX = 'inigosync:pending-payment-status:';
            ${dashboard.slice(pendingStart, pendingEnd)}
            ${dashboard.slice(scheduleStart, scheduleEnd)}
            ${dashboard.slice(handlerStart, handlerEnd)}
            globalThis.checkStatus = checkPaymentReturnStatus;
            globalThis.readPendingStatus = readPendingPaymentStatusChecks;
        `;
        runInNewContext(code, context);
        context.scheduled = scheduled;
        context.actions = actions;
        context.receipts = receipts;
        context.storage = storage;
        return context;
    };

    const paidFlow = makeContext([
        { data: { status: 'pending' }, error: null },
        { data: { status: 'paid', booking_receipts: [{ booking_id: 44, payment_id: 900 }] }, error: null },
    ]);
    await paidFlow.checkStatus('attempt-pending-paid', 'success');
    assert.equal(Array.from(paidFlow.readPendingStatus(), item => item.attemptId)[0], 'attempt-pending-paid');
    assert.equal(paidFlow.scheduled[0].delay, 1000);
    assert.equal(paidFlow.receipts.length, 0, 'pending status never opens a receipt');
    await paidFlow.scheduled[0].callback();
    assert.deepEqual(paidFlow.actions, ['status', 'status']);
    assert.equal(paidFlow.receipts.length, 1, 'the later verified paid response opens the receipt');
    assert.equal(paidFlow.readPendingStatus().length, 0, 'paid status clears pending verification state');

    const expiredFlow = makeContext([
        { data: { status: 'pending' }, error: null },
        { data: { status: 'expired' }, error: null },
    ]);
    await expiredFlow.checkStatus('attempt-pending-expired', 'success');
    assert.equal(expiredFlow.readPendingStatus().length, 1);
    await expiredFlow.scheduled[0].callback();
    assert.equal(expiredFlow.receipts.length, 0, 'expired checkout never opens a receipt');
    assert.equal(expiredFlow.readPendingStatus().length, 0, 'expired checkout clears pending verification state');
    assert.deepEqual(expiredFlow.scheduled.map(item => item.delay), [1000], 'polling is bounded and uses a backoff');

    const stillPending = makeContext(Array.from({ length: 6 }, () => ({ data: { status: 'pending' }, error: null })));
    await stillPending.checkStatus('attempt-still-pending', 'success');
    for (let index = 0; index < 5; index += 1) await stillPending.scheduled[index].callback();
    assert.deepEqual(stillPending.scheduled.map(item => item.delay), [1000, 2000, 4000, 8000, 15000]);
    assert.equal(stillPending.readPendingStatus().length, 1, 'after bounded polling, reload state remains resumable');
});

test('paid receipt lookup persists through empty reads, retries after reload, and selects the attempt payment only', async () => {
    const normalizeStart = dashboard.indexOf('    function normalizePaymentReceiptReferences(');
    const normalizeEnd = dashboard.indexOf('\n    function persistPendingPaymentReceipt(', normalizeStart);
    const persistStart = normalizeEnd + 1;
    const persistEnd = dashboard.indexOf('\n    function claimPaymentCelebration(', persistStart);
    const claimStart = persistEnd + 1;
    const claimEnd = dashboard.indexOf('\n    function playPaymentSuccessSound()', claimStart);
    const showStart = dashboard.indexOf('    async function showVerifiedPaymentReceipt(', claimEnd);
    const showEnd = dashboard.indexOf('\n    function resumePendingPaymentReceiptRenders(', showStart);
    assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
    assert.ok(showStart > claimEnd && showEnd > showStart);

    const values = new Map();
    const sessionStorage = {
        get length() { return values.size; },
        key(index) { return [...values.keys()][index] || null; },
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
    };
    const createContext = fetchReceipt => ({
        pendingPaymentReceipts: new Map(),
        celebratedPaymentAttempts: new Set(),
        PENDING_PAYMENT_RECEIPT_PREFIX: 'inigosync:pending-payment-receipt:',
        window: { sessionStorage, sb: {}, setTimeout(callback) { callback(); } },
        receiptDialog: { open: false, showModal() { this.open = true; } },
        receiptDialogContent: { innerHTML: '' },
        receiptDownloadButton: { setAttribute() {} },
        receiptDialogClose: { focus() {} },
        activeReceiptOpener: null,
        fetchBookingAcknowledgments: fetchReceipt,
        renderPaymentAcknowledgment(entry) { return `<article>${entry.acknowledgment.receipt_number}</article>`; },
        wireReceiptDownloads() {},
        console: { error() {} },
    });
    const implementation = `
        let soundPlayed = 0;
        let confettiShown = 0;
        const pendingPaymentReceipts = new Map();
        const celebratedPaymentAttempts = new Set();
        const activePaymentReceiptLoads = new Set();
        const PENDING_PAYMENT_RECEIPT_PREFIX = 'inigosync:pending-payment-receipt:';
        globalThis.playPaymentSuccessSound = () => { soundPlayed += 1; };
        globalThis.showPaymentConfetti = () => { confettiShown += 1; };
        ${dashboard.slice(normalizeStart, normalizeEnd)}
        ${dashboard.slice(persistStart, persistEnd)}
        ${dashboard.slice(claimStart, claimEnd)}
        ${dashboard.slice(showStart, showEnd)}
        globalThis.persistPending = persistPendingPaymentReceipt;
        globalThis.readPending = readPendingPaymentReceipts;
        globalThis.claimOnce = claimPaymentCelebration;
        globalThis.showReceipt = showVerifiedPaymentReceipt;
        globalThis.readSound = () => soundPlayed;
        globalThis.readConfetti = () => confettiShown;
    `;

    let initialReads = 0;
    const firstPage = createContext(async () => { initialReads += 1; return []; });
    runInNewContext(implementation, firstPage);
    firstPage.persistPending('paid-attempt-1', [{ booking_id: 12, payment_id: 500 }]);
    assert.equal(await firstPage.showReceipt('paid-attempt-1', [{ booking_id: 12, payment_id: 500 }]), false);
    assert.equal(initialReads, 4, 'initial page makes its bounded acknowledgment retries');
    assert.equal(values.has('inigosync:pending-payment-receipt:paid-attempt-1'), true, 'empty reads retain paid receipt work');
    assert.equal(firstPage.receiptDialog.open, false, 'no receipt opens without a saved acknowledgment');
    assert.equal(firstPage.readSound(), 0, 'no sound is played while no receipt was rendered');

    let reloadReads = 0;
    const secondPage = createContext(async () => {
        reloadReads += 1;
        if (reloadReads === 1) return [];
        return [
            { payment_id: 499, receipt_id: 'old-deposit', receipt_number: 'PA-OLD' },
            { payment_id: 500, receipt_id: 'this-attempt', receipt_number: 'PA-CURRENT' },
            { payment_id: 501, receipt_id: 'later-balance', receipt_number: 'PA-LATER' },
        ];
    });
    runInNewContext(implementation, secondPage);
    const [pending] = secondPage.readPending();
    assert.equal(pending.attemptId, 'paid-attempt-1', 'a reload resumes a previously verified paid attempt');
    assert.equal(await secondPage.showReceipt(pending.attemptId, pending.bookingReceipts), true);
    assert.equal(secondPage.receiptDialog.open, true);
    assert.match(secondPage.receiptDialogContent.innerHTML, /PA-CURRENT/);
    assert.doesNotMatch(secondPage.receiptDialogContent.innerHTML, /PA-OLD|PA-LATER/, 'receipt matches this attempt payment ID, not latest history');
    assert.equal(values.has('inigosync:pending-payment-receipt:paid-attempt-1'), false, 'pending state clears only after the dialog opens with the receipt');
    assert.equal(secondPage.claimOnce('paid-attempt-1'), false, 'celebration is already claimed after render');
    assert.equal(secondPage.readSound(), 1);
    assert.equal(secondPage.readConfetti(), 1);
    assert.equal(reloadReads, 2, 'reload retries the delayed acknowledgment until it is available');
});
