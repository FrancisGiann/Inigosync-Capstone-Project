import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = (await readFile(new URL('../Pages/staff_dashboard.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const css = (await readFile(new URL('../Style/staff_dashboard.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const source = (await readFile(new URL('../includes/staff_dashboard.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const migration = (await readFile(new URL('../supabase/migrations/20261101210000_staff_booking_extension_payments.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const durationFixMigration = (await readFile(new URL('../supabase/migrations/20261104143000_fix_staff_booking_extension_price_duration_type.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const paymongoAliasMigration = (await readFile(new URL('../supabase/migrations/20261104144500_fix_staff_extension_paymongo_alias.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const edge = (await readFile(new URL('../supabase/functions/staff-booking-extension-checkout/index.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('Overview extension control is labeled and adjacent to Time-Out only for eligible in-play hourly rows', () => {
    assert.match(source, /data-staff-action="timeout"[^<]*<\/button>\$\{canOfferExtension \? '<button type="button" class="staff-extension-plus" data-staff-action="extend" aria-label="Extend booking" title="Extend booking">\+<\/button>'/);
    assert.match(source, /staffExtensionAvailabilityCache\.get\(`\$\{row\.sourceType\}:\$\{target\.idValue\}`\) === true/);
    assert.match(source, /staffDerivedStatus\(row\) === 'inplay'[\s\S]*row\.raw\?\.checked_in_at/);
    assert.match(css, /\.staff-extension-plus\s*\{[\s\S]*width:\s*28px;\s*height:\s*28px/);
    assert.match(html, /data-staff-extension-hour-grid[^>]*role="group"[\s\S]*data-staff-extension-next/);
    assert.match(html, /data-staff-extension-step="payment"[\s\S]*data-staff-extension-method/);
    assert.match(html, /data-staff-extension-cash-modal[\s\S]*data-staff-extension-cash-keypad/);
    assert.match(html, /value="online" data-staff-extension-method> Online Payment/);
    assert.doesNotMatch(html, /data-staff-extension-cash-open|Open cash calculator/);
    assert.match(css, /\.staff-extension-hour-grid\s*\{[\s\S]*repeat\(auto-fit/);
    assert.match(css, /@media \(max-width: 440px\)[\s\S]*\.staff-extension-hour-grid/);
    const radioHandlerStart = source.indexOf("document.querySelectorAll('[data-staff-extension-method]').forEach((radio) => radio.addEventListener('change'");
    const radioHandlerEnd = source.indexOf("    staffExtensionCashInput?.addEventListener", radioHandlerStart);
    assert.ok(radioHandlerStart >= 0 && radioHandlerEnd > radioHandlerStart);
    assert.doesNotMatch(source.slice(radioHandlerStart, radioHandlerEnd), /openStaffExtensionCashCalculator\(\)/);
    assert.match(source, /if \(method === 'cash' && \(staffExtensionCashTenderMinor === null[\s\S]*openStaffExtensionCashCalculator\(\);\s*return;/);
    const confirmStart = source.indexOf("staffExtensionCashConfirm?.addEventListener('click', async () => {");
    const confirmEnd = source.indexOf('    staffExtensionCashDialog?.addEventListener', confirmStart);
    assert.ok(confirmStart >= 0 && confirmEnd > confirmStart);
    assert.match(source.slice(confirmStart, confirmEnd), /closeStaffExtensionCashCalculator\(\);\s*await submitStaffExtensionPayment\(\);/);
    assert.match(source, /async function submitStaffExtensionPayment\(\) \{\s*if \(staffExtensionPaymentInFlight\) return;/);
    assert.match(source, /function staffExtensionSlotRange\(option\) \{[\s\S]*Date\.parse\(option\?\.new_end_at\)[\s\S]*endAtMs - durationMinutes \* 60 \* 1000/);
});

test('Extension cards only expose the authoritative contiguous hourly prefix and support shortening', () => {
    const start = source.indexOf('    function staffExtensionConsecutiveOptions(options) {');
    const end = source.indexOf('\n\n    function renderStaffExtensionHourGrid()', start);
    assert.ok(start >= 0 && end > start);
    const rangeStart = source.indexOf('    function staffExtensionSlotRange(option) {');
    const rangeEnd = source.indexOf('\n\n    function updateStaffExtensionCashCalculator()', rangeStart);
    assert.ok(rangeStart >= 0 && rangeEnd > rangeStart);
    const context = { formatIsoTime12h: value => new Date(value).toISOString() };
    runInNewContext(`${source.slice(rangeStart, rangeEnd)}\n${source.slice(start, end)}; globalThis.options = staffExtensionConsecutiveOptions;`, context);
    const valid = [60, 120, 180].map((duration, index) => ({
        duration_minutes: duration, amount_minor: (index + 1) * 1000,
        new_end_at: new Date(Date.UTC(2026, 10, 4, 11 + index)).toISOString(),
    }));
    assert.deepEqual(JSON.parse(JSON.stringify(context.options(valid).map(option => option.duration_minutes))), [60, 120, 180]);
    assert.deepEqual(JSON.parse(JSON.stringify(context.options([valid[0], valid[2]]).map(option => option.duration_minutes))), [60]);
    assert.match(source, /staffExtensionSelected = staffExtensionOptionForDuration\(staffExtensionOptions, button\.dataset\.staffExtensionDuration\)/);
    assert.match(source, /aria-pressed="\$\{selected\}"/);
    const selectStart = source.indexOf('    function staffExtensionOptionForDuration(options, duration) {');
    const selectEnd = source.indexOf('\n\n    function staffExtensionSlotRange(option)', selectStart);
    assert.ok(selectStart >= 0 && selectEnd > selectStart);
    const selectContext = {};
    runInNewContext(`${source.slice(selectStart, selectEnd)}; globalThis.select = staffExtensionOptionForDuration;`, selectContext);
    assert.equal(selectContext.select(valid, 120), valid[1]);
    assert.equal(selectContext.select(valid, 60), valid[0], 'choosing an earlier card shortens the selected extension');
});

test('Extension options use the integer duration contract of authoritative pricing', () => {
    assert.match(durationFixMigration, /create or replace function public\.staff_booking_extension_options/);
    assert.match(durationFixMigration, /extract\(epoch from \(r\.ends_at - r\.starts_at\)\)::integer\s*\/\s*60\)\s*\+\s*v_minutes,\s*1\)/);
    assert.match(durationFixMigration, /grant execute on function public\.staff_booking_extension_options\(text, bigint, uuid\) to authenticated, service_role/);
    assert.match(migration, /v_amount:=internal\.authoritative_reservation_amount\(r\.listing_id,r\.unit_id,r\.starts_at,v_new_end,[\s\S]*?extract\(epoch from \(v_new_end-r\.starts_at\)\)::integer\/60,1\)/);
    assert.match(migration, /internal\.authoritative_reservation_amount\(court_listing_id,court_unit_inventory_id,time_date,x\.starts_at,[\s\S]*?extract\(epoch from \(x\.starts_at-time_date\)\)::integer\/60,1\)/);
});

test('PayMongo extension settlement avoids the ambiguous row-variable alias', () => {
    assert.match(paymongoAliasMigration, /public\.record_paymongo_paid\(text,text,text,bigint,bigint,bigint\)/);
    assert.match(paymongoAliasMigration, /internal\.staff_booking_extension_checkouts x where x\.intent_id=a\.intent_id/);
    assert.match(paymongoAliasMigration, /internal\.staff_booking_extension_checkouts ext where ext\.intent_id=a\.intent_id/);
    assert.match(paymongoAliasMigration, /<> 1 then[\s\S]*PayMongo extension branch changed/);
    assert.match(migration, /v_amount:=internal\.authoritative_reservation_amount\(r\.listing_id,r\.unit_id,r\.starts_at,v_new_end,[\s\S]*?extract\(epoch from \(v_new_end-r\.starts_at\)\)::integer\/60,1\)/);
    assert.match(migration, /internal\.authoritative_reservation_amount\(court_listing_id,court_unit_inventory_id,time_date,x\.starts_at,[\s\S]*?extract\(epoch from \(x\.starts_at-time_date\)\)::integer\/60,1\)/);
});

test('Extension range starts from the fresh option end minus whole-hour duration', () => {
    const start = source.indexOf('    function staffExtensionSlotRange(option) {');
    const end = source.indexOf('\n\n    function updateStaffExtensionCashCalculator()', start);
    assert.ok(start >= 0 && end > start);
    const context = { formatIsoTime12h: value => new Date(value).toISOString() };
    runInNewContext(`${source.slice(start, end)}; globalThis.range = staffExtensionSlotRange;`, context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.range({
        duration_minutes: 120, new_end_at: '2026-11-04T12:00:00.000Z',
    }))), {
        start: '2026-11-04T10:00:00.000Z', end: '2026-11-04T12:00:00.000Z',
    });
    assert.equal(context.range({ duration_minutes: 90, new_end_at: '2026-11-04T12:00:00.000Z' }), null);
});

test('Shared toast styles are compact, upper-centered, and distinguish success from errors', async () => {
    const loadingCss = (await readFile(new URL('../Style/Loading.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const authCss = (await readFile(new URL('../Style/Auth.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const toastJs = (await readFile(new URL('../includes/loadingOverlay.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    assert.match(loadingCss, /\.inigo-toast\s*\{[\s\S]*top:\s*16px;[\s\S]*left:\s*50%;[\s\S]*max-width:\s*min\(360px/);
    assert.match(loadingCss, /\.inigo-toast\.is-error\s*\{[\s\S]*border-color:\s*var\(--color-alert\)/);
    assert.match(loadingCss, /\.inigo-toast\.is-success\s*\{[\s\S]*border-color:\s*var\(--color-court-green\)/);
    assert.match(authCss, /\.auth-status\.is-success\s*\{[\s\S]*border-color:\s*var\(--color-court-green\)/);
    assert.match(toastJs, /function show\(message, isError = false, duration = 3000\)/);
});

test('Cash extension rechecks and updates atomically through staff RPC; no browser booking update', () => {
    assert.match(source, /staff_booking_extension_options/);
    assert.match(source, /staff_collect_cash_for_booking_extension/);
    assert.match(source, /parseCashTenderMinor\(staffExtensionCashInput\?\.value\)/);
    assert.doesNotMatch(source, /from\(['"]booking['"]\)\.update\([^)]*end_at/);
    assert.match(migration, /grant execute on function public\.staff_collect_cash_for_booking_extension\(text,bigint,integer,bigint\) to authenticated/);
    assert.match(migration, /v_tender<p_amount_minor/);
    assert.match(migration, /The next time is no longer available/);
    assert.match(migration, /v_max_minutes:=greatest\(0,floor\(extract\(epoch from \(v_max_end-r\.ends_at\)\)\/3600\)::integer\*60\)/);
    assert.match(migration, /for v_minutes in 60\.\.v_max_minutes by 60 loop/);
    assert.match(migration, /set end_at=v_new_end,amount_total=coalesce\(amount_total,v_base\)\+v_amount/);
});

test('Extension cash calculator uses integer cents and rejects underpayment', () => {
    const helperStart = source.indexOf('    function parseCashTenderMinor(value) {');
    const helperEnd = source.indexOf('\n\n', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const input = { value: '35.25', hidden: false };
    const change = { textContent: '' };
    const validation = { hidden: false, textContent: '' };
    const confirm = { disabled: false };
    const context = {
        STAFF_CASH_TENDER_MAX_MINOR: 99999999,
        staffExtensionCashInputError: '',
        staffExtensionCashInput: input,
        staffExtensionSelected: { amount_minor: 3500 },
        staffExtensionCashDue: { textContent: '' }, staffExtensionCashChange: change,
        staffExtensionCashValidation: validation, staffExtensionCashConfirm: confirm,
        formatStaffPeso: value => `₱${value.toFixed(2)}`,
    };
    const sourceFns = source.slice(helperStart, helperEnd);
    const updateStart = source.indexOf('    function updateStaffExtensionCashCalculator() {');
    const updateEnd = source.indexOf('\n\n    function parseCashTenderMinor', updateStart);
    assert.ok(updateStart >= 0 && updateEnd > updateStart);
    runInNewContext(`${sourceFns}\n${source.slice(updateStart, updateEnd)}; globalThis.parse = parseCashTenderMinor; globalThis.update = updateStaffExtensionCashCalculator;`, context);
    context.update();
    assert.equal(change.textContent, '₱0.25');
    assert.equal(confirm.disabled, false);
    input.value = '34.99';
    context.update();
    assert.equal(change.textContent, '—');
    assert.equal(confirm.disabled, true);
    input.value = '35.251';
    assert.equal(context.parse(input.value), null);
});

test('Extension cash entry rejects invalid typing and paste, enforces safe maximum, and shares rules with keypad', () => {
    const helperStart = source.indexOf('    function parseCashTenderMinor(value) {');
    const helperEnd = source.indexOf('\n\n    const TIMEIN_MODAL_CLOSE_DELAY_MS', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const input = { value: '1', selectionStart: 1, selectionEnd: 1 };
    const validation = { textContent: '' };
    const context = {
        STAFF_CASH_TENDER_MAX_MINOR: 99999999,
        staffExtensionCashInput: input,
        staffExtensionCashInputError: '',
        staffExtensionCashValidation: validation,
        updateStaffExtensionCashCalculator() { validation.textContent = context.staffExtensionCashInputError; },
    };
    runInNewContext(`${source.slice(helperStart, helperEnd)}; globalThis.parse = parseCashTenderMinor;` +
        'globalThis.valid = isValidStaffExtensionCashInput; globalThis.candidate = staffExtensionCashCandidate;' +
        'globalThis.beforeInput = validateStaffExtensionCashBeforeInput; globalThis.keyValue = nextStaffExtensionCashKeyValue;', context);

    const blocked = { inputType: 'insertText', data: 'ijk', prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(context.beforeInput(blocked), false, 'letters in a typed insertion are rejected');
    assert.equal(blocked.prevented, true);
    assert.match(validation.textContent, /digits/);

    input.value = '1'; input.selectionStart = 1; input.selectionEnd = 1;
    const blockedPaste = { inputType: 'insertFromPaste', dataTransfer: { getData: () => 'ijk' }, prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(context.beforeInput(blockedPaste), false, 'non-numeric paste is rejected as a whole');
    assert.equal(blockedPaste.prevented, true);
    const acceptedPaste = { inputType: 'insertFromPaste', dataTransfer: { getData: () => '25.50' }, prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(context.candidate(input, acceptedPaste.dataTransfer.getData()), '125.50');
    assert.equal(context.beforeInput(acceptedPaste), true, 'valid decimal paste is accepted');

    assert.equal(context.valid('1.25'), true);
    assert.equal(context.valid('1.256'), false, 'third decimal is rejected');
    assert.equal(context.valid('1.2.3'), false, 'second decimal point is rejected');
    assert.equal(context.valid('999999.99'), true, 'maximum operational amount is accepted');
    assert.equal(context.valid('1000000.00'), false, 'amount above the operational cap is rejected');
    assert.equal(context.keyValue('1.2', '5'), '1.25');
    assert.equal(context.keyValue('1.25', '6'), null, 'keypad cannot add a third decimal');
    assert.equal(context.keyValue('1.25', '.'), null, 'keypad cannot add a second decimal point');
    assert.match(html, /Maximum: ₱999,999\.99/);
});

test('Cash confirmation submits once and keeps its modal session intact through an RPC failure', async () => {
    const take = (startMarker, endMarker) => {
        const start = source.indexOf(startMarker);
        const end = source.indexOf(endMarker, start);
        assert.ok(start >= 0 && end > start, `source section exists: ${startMarker}`);
        return source.slice(start, end);
    };
    const closeModal = take('    function closeStaffExtensionModal() {', '    async function openStaffExtensionModal(');
    const openModal = take('    async function openStaffExtensionModal(', '    function setStaffExtensionPaymentBusy(');
    const busyState = take('    function setStaffExtensionPaymentBusy(busy) {', '    function staffExtensionConsecutiveOptions(');
    const confirmCash = take("    staffExtensionCashConfirm?.addEventListener('click', async () => {", '    staffExtensionCashDialog?.addEventListener');
    const submitPayment = take('    async function submitStaffExtensionPayment() {', '    staffExtensionPay?.addEventListener');
    let confirmHandler = null;
    const confirmButton = { addEventListener(type, handler) { if (type === 'click') confirmHandler = handler; } };
    let rpcCalls = 0;
    let resolveRpc;
    const rpcPromise = new Promise((resolve) => { resolveRpc = resolve; });
    const originalRow = { id: 41, sourceType: 'booking' };
    const paymentOption = { duration_minutes: 60, amount_minor: 5000 };
    const paymentError = { hidden: true, textContent: '' };
    const modal = { hidden: false, removeAttribute() {} };
    const methodInput = { value: 'cash', checked: true };
    const mainControl = { disabled: false };
    const context = {
        staffExtensionPaymentInFlight: false,
        staffExtensionPaymentControlStates: null,
        staffExtensionRow: originalRow,
        staffExtensionSelected: paymentOption,
        staffExtensionCashTenderMinor: null,
        staffExtensionCashInput: { value: '50.00' },
        staffExtensionCashReceived: { hidden: true, textContent: '' },
        staffExtensionCashConfirm: confirmButton,
        staffExtensionPay: { disabled: false, textContent: 'Pay and extend' },
        staffExtensionPaymentError: paymentError,
        staffExtensionModal: modal,
        staffExtensionDialog: { querySelectorAll: () => [mainControl] },
        staffExtensionCashModal: { hidden: true },
        document: { querySelector: () => methodInput },
        window: { sb: { rpc: () => { rpcCalls += 1; return rpcPromise; } } },
        rowTableTarget: (row) => ({ idValue: row.id }),
        selectedStaffExtension: () => context.staffExtensionSelected,
        updateStaffExtensionCashCalculator: () => true,
        parseCashTenderMinor: () => 5000,
        formatStaffPeso: () => '₱50.00',
        closeStaffExtensionCashCalculator() {},
        updateStaffModalBackground() {},
        closeStaffExtensionModal() {},
        openStaffExtensionCashCalculator() {},
        showImmediatePaymentAcknowledgment() {},
        claimStaffPaymentCelebration() {},
        playStaffPaymentSuccessSound() {},
        showStaffPaymentConfetti() {},
        refreshBookingOverview() {}, refreshCourtSchedule() {}, refreshTransactions() {},
        InigoToast: { show() {} },
    };
    runInNewContext(`${closeModal}\n${openModal}\n${busyState}\n${submitPayment}\n${confirmCash}\n` +
        'globalThis.closeExtensionModal = closeStaffExtensionModal; globalThis.openExtensionModal = openStaffExtensionModal;', context);

    const firstConfirmation = confirmHandler();
    assert.equal(rpcCalls, 1, 'cash confirmation dispatches the payment RPC');
    assert.equal(context.staffExtensionPaymentInFlight, true);
    assert.equal(mainControl.disabled, true, 'modal controls are locked during submission');

    await confirmHandler();
    assert.equal(rpcCalls, 1, 'a duplicate confirmation cannot submit another RPC');
    await context.openExtensionModal({ id: 99, sourceType: 'booking' }, null);
    context.closeExtensionModal();
    assert.equal(context.staffExtensionRow, originalRow, 'the active reservation cannot be switched in flight');
    assert.equal(modal.hidden, false, 'the active modal cannot be dismissed in flight');

    resolveRpc({ error: { message: 'The next time is no longer available.' } });
    await firstConfirmation;
    assert.equal(context.staffExtensionPaymentInFlight, false);
    assert.equal(mainControl.disabled, false, 'controls are restored after the failure');
    assert.equal(paymentError.hidden, false);
    assert.match(paymentError.textContent, /no longer available/);
    assert.equal(modal.hidden, false, 'a failed payment leaves the same booking open for correction or retry');
    assert.equal(context.staffExtensionRow, originalRow);
});

test('Online extension holds the physical slot and only extends from verified PayMongo settlement', () => {
    assert.match(edge, /hasVerifiedEmailSession/);
    assert.match(edge, /p_staff_id:\s*authData\.user\.id/);
    assert.match(edge, /register_paymongo_checkout_request/);
    assert.match(edge, /mark_staff_booking_extension_ready/);
    assert.match(edge, /send_email_receipt:\s*false/);
    assert.match(migration, /insert into internal\.reservation_resource_slots\(hold_item_id,resource_id,during\)/);
    assert.match(migration, /public\.record_paymongo_paid/);
    assert.match(migration, /v_marker:=E'\\n  if a\.intent_id is not null then'/);
    assert.match(migration, /if x\.starts_at<=now\(\) then[\s\S]*refund_review_required',true/);
    assert.match(migration, /p\.role='staff' and p\.status='active'/);
    assert.match(migration, /a\.intent_id is not null and exists\(select 1 from internal\.staff_booking_extension_checkouts/);
    assert.match(migration, /perform internal\.persist_payment_acknowledgment\(v_payment_id,'booking',x\.extension_reservation_id,null\)/);
    assert.match(migration, /where a\.id=p_attempt_id and x\.staff_id=v_actor/);
    assert.match(migration, /checked_out_at timestamptz,status text,customer_id uuid,listing_id uuid/);
    assert.match(migration, /values\(coalesce\(r\.customer_id,p_staff_id\),'creating','full'/);
    assert.match(migration, /payment_option,pass_on_fees,staff_id\)[\s\S]*values\(null,v_intent,coalesce\(r\.customer_id,p_staff_id\)[\s\S]*,p_staff_id\)/);
    assert.match(migration, /create trigger paymongo_release_reviewed_staff_extension_hold[\s\S]*execute function internal\.release_reviewed_staff_extension_hold\(\)/);
    assert.match(migration, /delete from internal\.reservation_resource_slots s where s\.hold_item_id in[\s\S]*where i\.intent_id=new\.intent_id/);
    assert.match(source, /PayMongo confirmed payment and the booking was extended/);
    const paidReturnStart = source.indexOf("if (result?.status === 'paid' && result.receipt) {");
    const paidReturnEnd = source.indexOf("} else if (result?.status === 'review')", paidReturnStart);
    assert.ok(paidReturnStart >= 0 && paidReturnEnd > paidReturnStart);
    const paidReturn = source.slice(paidReturnStart, paidReturnEnd);
    assert.match(paidReturn, /showImmediatePaymentAcknowledgment\(result\.receipt, result\.source\)[\s\S]*claimStaffPaymentCelebration\(result\.receipt\)\) \{[\s\S]*playStaffPaymentSuccessSound\(\);[\s\S]*showStaffPaymentConfetti\(\);/);
    assert.match(source, /PayMongo checkout was cancelled\. The booking was not extended\.', true\)/);
    assert.match(source, /PayMongo did not return a valid checkout link/);
    assert.match(source, /method === 'cash' && result\?\.data\?\.ok !== true/);
});
