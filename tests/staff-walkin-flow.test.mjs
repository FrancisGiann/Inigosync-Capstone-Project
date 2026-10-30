import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8');

test('staff walk-in wizard follows customer booking stages after customer entry', () => {
    const panels = [...html.matchAll(/<div class="staff-wizard-panel[^>]*data-staff-walkin-step="(\d)"[^>]*>/g)]
        .map((match) => Number(match[1]));
    assert.deepEqual(panels, [1, 2, 3, 4, 5, 6]);
    assert.match(html, /data-staff-walkin-step-indicator="2"[\s\S]*?staff-wizard-step-label">Sport/);
    assert.match(html, /data-staff-walkin-step-indicator="3"[\s\S]*?staff-wizard-step-label">Court/);
    assert.match(html, /data-staff-walkin-step-indicator="4"[\s\S]*?staff-wizard-step-label">Schedule/);
    assert.match(html, /data-staff-walkin-step-indicator="5"[\s\S]*?staff-wizard-step-label">Summary/);
    assert.match(html, /data-staff-walkin-step-indicator="6"[\s\S]*?staff-wizard-step-label">Payment/);
    assert.match(html, /data-staff-walkin-court-cards[\s\S]*?role="group"/);
    assert.match(html, /data-staff-walkin-step="4"[\s\S]*?data-staff-walkin-date-label[\s\S]*?Today only/);
    assert.match(html, /data-staff-walkin-step="5"[\s\S]*?data-staff-walkin-add-line/);
    assert.match(source, /data-staff-walkin-edit-line/);
    assert.match(html, /data-staff-walkin-step="6"[\s\S]*?name="staff-walkin-payment"/);
    assert.match(html, /data-staff-walkin-step="6"[\s\S]*?data-staff-walkin-save/);
    assert.match(html, /data-staff-walkin-payment-lines/);
    assert.match(html, /data-staff-walkin-payment-total/);
    assert.match(html, /data-staff-walkin-step="1"[\s\S]*?data-staff-walkin-name[\s\S]*?data-staff-walkin-mobile/);
});

test('walk-in readiness separates schedule, summary, and payment requirements', () => {
    const start = source.indexOf('    function walkinStepIsReady(step) {');
    const end = source.indexOf('\n\n    function renderWalkinWizard()', start);
    assert.ok(start >= 0 && end > start, 'walk-in readiness function is present');
    const context = {
        walkinState: { customerMode: 'guest', name: 'Guest', mobile: '', mobileError: false, mobileAvailability: '',
            customerId: null, sport: null, court: null, unit: null, selectedHours: [], items: [], payment: null },
        walkinSelectionDate: '2026-10-28', todayDateInputValue: () => '2026-10-28',
        walkinBusinessRules: { authoritative: true }, walkinBookings: { ok: true }, walkinWalkins: { ok: true },
        window: { InigoCourtsData: {} }, staffCashEnabled: true, staffOnlineEnabled: false,
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.ready = walkinStepIsReady;`, context);
    assert.equal(context.ready(2), false);
    context.walkinState.sport = { name: 'Tennis' };
    assert.equal(context.ready(2), true);
    context.walkinState.court = { id: 'court-1' };
    context.walkinState.unit = 'Court 1';
    assert.equal(context.ready(3), true);
    context.walkinState.selectedHours = [10];
    assert.equal(context.ready(4), true);
    context.walkinState.items = [{ subtotal: 100 }];
    assert.equal(context.ready(5), true);
    assert.equal(context.ready(6), false);
    context.walkinState.payment = 'cash';
    assert.equal(context.ready(6), true);
    context.staffCashEnabled = false;
    assert.equal(context.ready(6), false);
});

test('payment review lists every booking line across sports and courts', () => {
    const start = source.indexOf('    function renderWalkinPaymentReviewLines() {');
    const end = source.indexOf('\n\n    if (walkinAddLineBtn)', start);
    assert.ok(start >= 0 && end > start, 'payment review renderer is present');
    const lines = {
        innerHTML: '',
    };
    const state = { items: [
        { sport: 'Tennis', court: 'Tennis Court', unit: 'Court 1', startsAt: '2026-10-28T02:00:00Z', endsAt: '2026-10-28T03:00:00Z', startHour: 10, endHour: 10, subtotal: 100 },
        { sport: 'Basketball', court: 'Basketball Court', unit: 'Court 2', startsAt: '2026-10-28T04:00:00Z', endsAt: '2026-10-28T05:00:00Z', startHour: 12, endHour: 12, subtotal: 150 },
    ] };
    const context = {
        walkinPaymentLinesEl: lines, walkinState: state,
        formatWalkinDateLabel: value => value.slice(0, 10), formatIsoTime12h: value => value.slice(11, 16),
        formatStaffPeso: value => `₱${value.toFixed(2)}`,
        window: { escapeHtml: value => String(value) },
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.renderPaymentLines = renderWalkinPaymentReviewLines;`, context);
    context.renderPaymentLines();
    assert.match(lines.innerHTML, /Tennis · Tennis Court · Court 1/);
    assert.match(lines.innerHTML, /Basketball · Basketball Court · Court 2/);
    assert.equal((lines.innerHTML.match(/class="staff-walkin-review-line"/g) || []).length, 2);
});

test('Pay Online redirects only to the verified hosted PayMongo checkout URL without a channel override', async () => {
    const start = source.indexOf('    function renderWalkinOnlineCheckoutError(orderId, message) {');
    const end = source.indexOf('\n\n    async function showWalkinAcknowledgment', start);
    assert.ok(start >= 0 && end > start, 'Pay Online checkout handler is present');
    let invoked = null;
    let destination = null;
    const context = {
        window: {
            sb: { functions: { async invoke(name, options) {
                invoked = { name, options };
                return { data: { order_id: 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526', checkout_url: 'https://checkout.paymongo.com/session' } };
            } } },
            location: { assign(url) { destination = url; } },
            escapeHtml: value => String(value),
        },
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.startCheckout = createWalkinPayOnlineCheckout;`, context);
    const result = await context.startCheckout({ guest_name: 'Walk-in Guest', items: [{ quoted_minor: 12000 }] });
    assert.equal(result, true);
    assert.equal(invoked.name, 'staff-walkin-checkout');
    assert.equal(Object.hasOwn(invoked.options.body, 'channel'), false, 'PayMongo chooses from the server-enabled method list');
    assert.equal(destination, 'https://checkout.paymongo.com/session');
});

test('Pay Online rejects lookalike checkout hosts and offers a safe order retry', async () => {
    const start = source.indexOf('    function renderWalkinOnlineCheckoutError(orderId, message) {');
    const end = source.indexOf('\n\n    async function showWalkinAcknowledgment', start);
    let receiptHtml = '';
    const context = {
        window: {
            sb: { functions: { async invoke() {
                return { data: { order_id: 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526', checkout_url: 'https://checkout.paymongo.com.attacker.test/session' } };
            } } },
            location: { assign() { assert.fail('an untrusted hosted checkout URL must never redirect'); } },
            escapeHtml: value => String(value),
        },
        walkinWizardWrap: { hidden: false }, walkinReceiptWrap: { hidden: true }, walkinReceiptEl: { set innerHTML(value) { receiptHtml = value; } },
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.startCheckout = createWalkinPayOnlineCheckout;`, context);
    const result = await context.startCheckout({ order_id: 'a25dc45b-40ba-4b5b-96d6-4487dbe7a526' });
    assert.equal(result, false);
    assert.match(receiptHtml, /data-staff-walkin-online-checkout-retry="a25dc45b-40ba-4b5b-96d6-4487dbe7a526"/);
    assert.equal(context.walkinWizardWrap.hidden, true);
    assert.equal(context.walkinReceiptWrap.hidden, false);
});

test('walk-in navigation adds a scheduled line, reaches payment, and returns to summary', async () => {
    const start = source.indexOf('    function walkinStepIsReady(step) {');
    const end = source.indexOf('\n\n    // ---- Step 1 — Customer ----', start);
    assert.ok(start >= 0 && end > start, 'walk-in navigation implementation is present');
    const panels = Array.from({ length: 6 }, (_, index) => ({
        dataset: { staffWalkinStep: String(index + 1) }, classList: { toggle() {} },
    }));
    const indicators = Array.from({ length: 6 }, (_, index) => ({
        dataset: { staffWalkinStepIndicator: String(index + 1) }, classList: { toggle() {} }, setAttribute() {},
    }));
    const captureButton = () => ({
        hidden: false, disabled: false, textContent: '',
        addEventListener(_event, handler) { this.handler = handler; },
        async click() { await this.handler?.(); },
    });
    const state = {
        customerMode: 'guest', name: 'Guest', mobile: '', mobileError: false, mobileAvailability: '', customerId: null,
        sport: null, court: null, unit: null, selectedHours: [], items: [], payment: 'cash',
    };
    const context = {
        walkinStepPanels: panels,
        walkinStepIndicators: indicators,
        walkinBackBtn: captureButton(),
        walkinNextBtn: captureButton(),
        walkinSaveBtn: { disabled: false },
        walkinState: state,
        WALKIN_STEP_COUNT: 6,
        walkinWizardStep: 1,
        walkinSelectionDate: '2026-10-28',
        todayDateInputValue: () => '2026-10-28',
        walkinDateLabelEl: { textContent: '' },
        formatWalkinDateLabel: () => 'Oct 28, 2026',
        manilaDateTime: () => new Date('2026-10-28T00:00:00Z'),
        walkinBusinessRules: { authoritative: true }, walkinBookings: { ok: true }, walkinWalkins: { ok: true },
        window: { InigoCourtsData: {} }, staffCashEnabled: true, staffOnlineEnabled: true,
        walkinScheduleRechecking: false, editingWalkinItemIndex: null, addingWalkinItem: false,
        walkinCashTenderIsValid: () => true,
        async refreshWalkinTimeSlots() {},
        buildWalkinLine: () => ({ listingId: state.court?.id || 'court-1', sport: state.sport?.name || 'Sport', court: state.court?.name || 'Court', unit: state.unit, startHour: state.selectedHours[0], endHour: state.selectedHours[0], subtotal: state.selectedHours[0] === 10 ? 100 : 150 }),
        clearWalkinCurrentLine() { state.court = null; state.unit = null; state.selectedHours = []; },
        renderWalkinLines() {}, updateWalkinSummary() {},
    };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.navigate = goToWalkinStep; globalThis.ready = walkinStepIsReady;`, context);
    assert.equal(context.walkinWizardStep, 1);
    await context.walkinNextBtn.click();
    assert.equal(context.walkinWizardStep, 2);
    state.sport = { name: 'Tennis' };
    context.navigate(2);
    await context.walkinNextBtn.click();
    assert.equal(context.walkinWizardStep, 3);
    state.court = { id: 'court-1' };
    state.unit = 'Court 1';
    context.navigate(3);
    await context.walkinNextBtn.click();
    assert.equal(context.walkinWizardStep, 4);
    state.selectedHours = [10];
    context.navigate(4);
    await context.walkinNextBtn.click();
    assert.equal(context.walkinWizardStep, 5);
    assert.equal(state.items.length, 1);
    await context.walkinNextBtn.click();
    assert.equal(context.walkinWizardStep, 6);
    context.walkinBackBtn.handler();
    assert.equal(context.walkinWizardStep, 5);

    // Add More can be abandoned from Sport, Court, or Schedule without
    // changing the booking already in the summary.
    context.walkinAddLineBtn = captureButton();
    context.walkinDeleteAllBtn = null;
    context.renderWalkinSportCards = () => {};
    context.renderWalkinUnitOptions = () => {};
    const addStart = source.indexOf('    if (walkinAddLineBtn) walkinAddLineBtn.addEventListener');
    const addEnd = source.indexOf('\n\n    function resetWalkinTimeSelectionAndRefresh()', addStart);
    runInNewContext(source.slice(addStart, addEnd), context);
    for (const step of [2, 3, 4]) {
        await context.walkinAddLineBtn.click();
        state.sport = { name: 'Basketball' };
        state.court = { id: 'court-2', name: 'Basketball Court' };
        state.unit = 'Court 2';
        state.selectedHours = [12];
        context.navigate(step);
        assert.equal(context.walkinBackBtn.textContent, 'Back to Summary');
        context.walkinBackBtn.handler();
        assert.equal(context.walkinWizardStep, 5);
        assert.equal(context.walkinBackBtn.textContent, 'Back');
        assert.equal(state.items.length, 1);
        assert.equal(state.court, null);
        assert.deepEqual(Array.from(state.selectedHours), []);
    }

    // Editing an existing row through Schedule replaces its summary row.
    context.editingWalkinItemIndex = 0;
    state.sport = { name: 'Tennis' };
    state.court = { id: 'court-1' };
    state.unit = 'Court 1';
    state.selectedHours = [11];
    context.navigate(4);
    await context.walkinNextBtn.click();
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].startHour, 11);
    assert.equal(state.items[0].subtotal, 150);
    assert.equal(context.editingWalkinItemIndex, null);

    // Adding another line can select a different sport and court without
    // replacing the first booking in the same staff payment order.
    state.sport = { name: 'Basketball' };
    state.court = { id: 'court-2', name: 'Basketball Court' };
    state.unit = 'Court 2';
    state.selectedHours = [12];
    context.navigate(4);
    await context.walkinNextBtn.click();
    assert.equal(state.items.length, 2);
    assert.deepEqual(state.items.map(item => item.sport), ['Tennis', 'Basketball']);
    assert.deepEqual(state.items.map(item => item.listingId), ['court-1', 'court-2']);
    await context.walkinNextBtn.click();
    assert.equal(context.walkinWizardStep, 6);

    const options = ['cash', 'paymongo'].map((payment) => {
        const radio = {
            dataset: { staffPayment: payment }, checked: false,
            addEventListener(_event, handler) { this.changeHandler = handler; },
        };
        return {
            classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => radio,
            addEventListener(_event, handler) { this.handler = handler; }, radio,
        };
    });
    const paymentSection = source.indexOf('    // ---- Step 6 — Payment and confirmation ----');
    const paymentStart = source.indexOf('    function selectWalkinPayment(radio) {', paymentSection);
    const paymentEnd = source.indexOf('\n\n    function walkinCashDueMinor()', paymentStart);
    context.walkinPaymentOptionEls = options;
    assert.ok(paymentStart >= 0 && paymentEnd > paymentStart, 'payment selection handler is present');
    runInNewContext(source.slice(paymentStart, paymentEnd), context);
    context.navigate(6);
    options[1].radio.checked = true;
    options[1].radio.changeHandler();
    assert.equal(state.payment, 'paymongo');
    assert.equal(context.ready(6), true, 'Pay Online is available when at least one online method is enabled');
    context.staffOnlineEnabled = false;
    assert.equal(context.ready(6), false, 'Pay Online is blocked when all online methods are disabled');
    context.staffOnlineEnabled = true;
    context.navigate(6);
    assert.equal(context.ready(6), true);
    options[0].radio.checked = true;
    options[0].radio.changeHandler();
    assert.equal(state.payment, 'cash', 'keyboard selection updates payment back to cash');
});

test('summary line actions preload edits, cancel without losing the original, and confirm removal', async () => {
    const renderStart = source.indexOf('    function returnToWalkinSportAfterEmptySummary() {');
    const renderEnd = source.indexOf('\n\n    if (walkinAddLineBtn)', renderStart);
    const addStart = renderEnd + 2;
    const addEnd = source.indexOf('\n\n    function resetWalkinTimeSelectionAndRefresh()', addStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart && addEnd > addStart, 'summary line handlers are present');

    const line = {
        listingId: 'court-1', unitId: 'unit-1', sport: 'Tennis', court: 'Tennis Court', unit: 'Court 1',
        startsAt: '2026-10-28T02:00:00.000Z', endsAt: '2026-10-28T04:00:00.000Z',
        startHour: 10, endHour: 11, subtotal: 200,
    };
    const editButton = { dataset: { staffWalkinEditLine: '0' }, addEventListener(_event, handler) { this.handler = handler; } };
    const removeButton = { dataset: { staffWalkinRemoveLine: '0' }, addEventListener(_event, handler) { this.handler = handler; } };
    const linesElement = {
        innerHTML: '',
        querySelectorAll(selector) {
            return selector.includes('edit-line') ? (this.innerHTML ? [editButton] : [])
                : (this.innerHTML ? [removeButton] : []);
        },
    };
    const sport = { name: 'Tennis', slug: 'tennis' };
    const court = { id: 'court-1', slug: 'tennis-court', name: 'Tennis Court', sportSlug: 'tennis' };
    const unit = { id: 'unit-1', label: 'Court 1', rateDay: 100 };
    const state = { items: [line], courts: [court], sports: [sport], sport: null, court: null, unit: null, unitId: null, selectedHours: [] };
    const bookingCount = { textContent: '' };
    const deleteAllButton = { disabled: true, addEventListener(_event, handler) { this.handler = handler; } };
    let navigatedTo = null;
    let confirmRemoval = false;
    let confirmation = null;
    const context = {
        walkinLinesEl: linesElement, walkinBookingCountEl: bookingCount, walkinDeleteAllBtn: deleteAllButton,
        walkinState: state, editingWalkinItemIndex: null, addingWalkinItem: false,
        walkinSelectionDate: '2026-10-28', todayDateInputValue: () => '2026-10-28',
        manilaDate: () => '2026-10-28', walkinSportKey: value => String(value?.slug || value?.name || '').toLowerCase(),
        formatIsoTime12h: value => value, formatStaffPeso: value => `$${value}`,
        formatWalkinDateLabel: value => value.slice(0, 10),
        window: { escapeHtml: value => String(value), InigoCourtsData: { resolveCourtUnits: () => ({ units: [unit] }) } },
        walkinCurrentCourtEl: { textContent: '' },
        selectWalkinUnit(selectedCourt, selectedUnit) {
            state.court = selectedCourt; state.unit = selectedUnit.label; state.unitId = selectedUnit.id;
        },
        renderWalkinSportCards() {}, renderWalkinUnitOptions() {}, renderWalkinTimeSlots() {}, refreshWalkinTimeSlots() {},
        goToWalkinStep(step) { navigatedTo = step; }, updateWalkinSummary() {}, renderWalkinWizard() {},
        async confirmStaffAction(message, title, acceptLabel) {
            confirmation = { message, title, acceptLabel };
            return confirmRemoval;
        },
    };
    runInNewContext(`${source.slice(renderStart, renderEnd)}\nglobalThis.renderLines = renderWalkinLines;`, context);
    context.renderLines();
    assert.match(linesElement.innerHTML, /data-staff-walkin-edit-line="0"/);
    assert.equal(bookingCount.textContent, 'Your bookings · 1 item');
    assert.equal(deleteAllButton.disabled, false);
    editButton.handler();
    assert.equal(context.editingWalkinItemIndex, 0);
    assert.deepEqual(Array.from(state.selectedHours), [10, 11]);
    assert.equal(navigatedTo, 2);

    // The edit-cancel route returns to Summary and keeps the original line.
    const navStart = source.indexOf('    if (walkinBackBtn) walkinBackBtn.addEventListener');
    const navEnd = source.indexOf('\n\n    // ---- Step 1 — Customer ----', navStart);
    const backListener = source.slice(navStart, navEnd).slice(0, source.slice(navStart, navEnd).indexOf('\n\n    if (walkinNameInput)'));
    context.walkinWizardStep = 2;
    context.goToWalkinStep = (step) => { navigatedTo = step; };
    const backButton = { addEventListener(_event, handler) { this.handler = handler; } };
    context.walkinBackBtn = backButton;
    context.clearWalkinCurrentLine = () => { state.court = null; state.unit = null; state.selectedHours = []; };
    context.renderWalkinWizard = () => {};
    runInNewContext(backListener, context);
    backButton.handler();
    assert.equal(navigatedTo, 5);
    assert.equal(context.editingWalkinItemIndex, null);
    assert.equal(state.items[0], line);

    // Add another leaves current summary rows intact and starts a fresh line.
    context.walkinWizardStep = 5;
    context.editingWalkinItemIndex = 0;
    const addButton = { addEventListener(_event, handler) { this.handler = handler; } };
    context.walkinAddLineBtn = addButton;
    context.renderWalkinSportCards = () => {};
    context.renderWalkinUnitOptions = () => {};
    context.refreshWalkinTimeSlots = () => {};
    runInNewContext(source.slice(addStart, addEnd), context);
    addButton.handler();
    assert.equal(context.editingWalkinItemIndex, null);
    assert.equal(context.addingWalkinItem, true);
    assert.equal(state.items[0], line);
    assert.equal(navigatedTo, 2);

    // Cancel keeps the booking. Confirming removes it and leaves Summary unready.
    context.renderLines();
    await removeButton.handler();
    assert.equal(state.items.length, 1);
    assert.deepEqual(confirmation, {
        message: 'Remove this booking from the summary?', title: 'Remove booking?', acceptLabel: 'Remove',
    });
    confirmRemoval = true;
    await removeButton.handler();
    assert.equal(state.items.length, 0);
    assert.equal(bookingCount.textContent, 'Your bookings · 0 items');
    assert.equal(deleteAllButton.disabled, true);
    assert.equal(navigatedTo, 2, 'removing the last line returns to Sport');
    assert.equal(state.sport, null);
    const readyStart = source.indexOf('    function walkinStepIsReady(step) {');
    const readyEnd = source.indexOf('\n\n    function renderWalkinWizard()', readyStart);
    runInNewContext(`${source.slice(readyStart, readyEnd)}\nglobalThis.ready = walkinStepIsReady;`, context);
    assert.equal(context.ready(5), false);

    // Delete All also waits for confirmation and returns to Sport only after acceptance.
    state.items.push(line, { ...line, unitId: 'unit-2' });
    state.sport = sport;
    context.renderLines();
    confirmRemoval = false;
    await deleteAllButton.handler();
    assert.equal(state.items.length, 2);
    assert.deepEqual(confirmation, {
        message: 'Delete all bookings from this summary?', title: 'Delete all bookings?', acceptLabel: 'Delete All',
    });
    confirmRemoval = true;
    await deleteAllButton.handler();
    assert.equal(state.items.length, 0);
    assert.equal(bookingCount.textContent, 'Your bookings · 0 items');
    assert.equal(deleteAllButton.disabled, true);
    assert.equal(state.sport, null);
    assert.equal(navigatedTo, 2);

});
